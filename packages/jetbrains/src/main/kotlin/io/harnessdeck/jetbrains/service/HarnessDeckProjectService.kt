package io.harnessdeck.jetbrains.service

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import io.harnessdeck.jetbrains.ide.EditorStateSync
import io.harnessdeck.jetbrains.ide.IdeaWorkbenchAdapter
import io.harnessdeck.jetbrains.protocol.EditorStateChangedParams
import io.harnessdeck.jetbrains.protocol.InputPromptOptions
import io.harnessdeck.jetbrains.protocol.LineRange
import io.harnessdeck.jetbrains.protocol.OpenDialogOptions
import io.harnessdeck.jetbrains.protocol.QuickPickOption
import io.harnessdeck.jetbrains.protocol.ResolvedDiffSpec
import io.harnessdeck.jetbrains.protocol.SidecarGson
import io.harnessdeck.jetbrains.protocol.SidecarInitParams
import io.harnessdeck.jetbrains.protocol.StatusBarSnapshot
import io.harnessdeck.jetbrains.protocol.asStringOrNull
import io.harnessdeck.jetbrains.secrets.PasswordSafeStore
import io.harnessdeck.jetbrains.settings.HarnessDeckAppSettings
import io.harnessdeck.jetbrains.settings.HarnessDeckConfigurable
import io.harnessdeck.jetbrains.sidecar.NodeLocator
import io.harnessdeck.jetbrains.sidecar.SidecarProcessManager
import io.harnessdeck.jetbrains.ui.HarnessDeckLogService
import io.harnessdeck.jetbrains.ui.HarnessDeckWebviewPanel
import io.harnessdeck.jetbrains.ui.HarnessDeckWorkbenchVirtualFile
import io.harnessdeck.jetbrains.ui.WebviewResourceServer
import java.nio.file.Paths
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@Service(Service.Level.PROJECT)
class HarnessDeckProjectService(private val project: Project) : Disposable {

    val workbench = IdeaWorkbenchAdapter(project)
    val logService = HarnessDeckLogService(project)

    private val panels = CopyOnWriteArrayList<HarnessDeckWebviewPanel>()
    private val statusListeners = CopyOnWriteArrayList<(StatusBarSnapshot) -> Unit>()
    private val activeProgress = ConcurrentHashMap<String, CountDownLatch>()
    private val lock = Any()

    @Volatile
    private var statusSnapshot = StatusBarSnapshot("Harness Deck", "idle", null)
    private var resourceServer: WebviewResourceServer? = null
    private var sidecar: SidecarProcessManager? = null
    private var editorSync: EditorStateSync? = null
    private var workbenchFile: HarnessDeckWorkbenchVirtualFile? = null
    @Volatile
    private var chatVisible = false

    fun createWebviewPanel(parentDisposable: Disposable): HarnessDeckWebviewPanel {
        val server = ensureResourceServer()
        ensureSidecarStarted()
        val panel = HarnessDeckWebviewPanel(
            parentDisposable = parentDisposable,
            resourceServer = server,
            onWebviewMessage = { msg -> sidecar?.sendWebviewMessage(msg) },
            onError = { err -> logService.append("webview", err) },
        )
        panels += panel
        com.intellij.openapi.util.Disposer.register(panel) { panels.remove(panel) }
        return panel
    }

    fun setChatVisible(visible: Boolean) {
        chatVisible = visible
        if (visible) {
            ensureSidecarStarted()
        }
        sidecar?.notifyWebviewVisibility(visible)
    }

    fun executeCommand(command: String) {
        ensureSidecarStarted()
        val patch = EditorStateChangedParams(
            activeEditor = workbench.captureActiveEditor(),
            includeActiveEditor = true,
            dirtyFiles = workbench.captureDirtyFiles(),
        )
        sidecar?.executeCommand(command, patch)
    }

    fun focusChatView(): CompletableFuture<Void> {
        val future = CompletableFuture<Void>()
        ApplicationManager.getApplication().invokeLater {
            val tw = ToolWindowManager.getInstance(project).getToolWindow("Harness Deck")
            if (tw != null) {
                tw.activate({ future.complete(null) }, true, true)
            } else {
                future.complete(null)
            }
        }
        return future
    }

    fun currentStatusBarSnapshot(): StatusBarSnapshot = statusSnapshot

    fun addStatusListener(listener: (StatusBarSnapshot) -> Unit) {
        statusListeners += listener
    }

    private fun ensureResourceServer(): WebviewResourceServer =
        synchronized(lock) {
            resourceServer ?: run {
                val assets = NodeLocator.ensureBundledAssets()
                val srv = WebviewResourceServer(
                    webviewRoot = assets.webviewRoot,
                    storageNamespace = workbench.projectBasePath(),
                    languageTag = workbench.ideLanguage(),
                )
                resourceServer = srv
                srv
            }
        }

    private fun ensureSidecarStarted() {
        synchronized(lock) {
            if (sidecar != null) return

            val assets = NodeLocator.ensureBundledAssets()
            val configuredNode = HarnessDeckAppSettings.getInstance().nodeExecutablePath
            val nodeExe = NodeLocator.findNodeExecutable(configuredNode)
            if (nodeExe == null) {
                val msg = "Node.js (>= 20) executable was not found. Configure it in Settings | Tools | Harness Deck."
                logService.append("host", msg)
                workbench.showMessage("error", msg, listOf("Open Settings")).thenAccept { action ->
                    if (action == "Open Settings") openHostSettings()
                }
                return
            }

            fun buildInitParams(): SidecarInitParams = SidecarInitParams(
                projectPath = workbench.projectBasePath(),
                workspaceFolders = workbench.workspaceFolders(),
                ideLanguage = workbench.ideLanguage(),
                workspaceTrusted = workbench.isWorkspaceTrusted(),
                windowFocused = workbench.isWindowFocused(),
                httpProxy = workbench.httpProxyUrl(),
                extensionVersion = NodeLocator.pluginVersion(),
                activeEditor = workbench.captureActiveEditor(),
                dirtyFiles = workbench.captureDirtyFiles(),
            )

            val mgr = SidecarProcessManager(
                nodeExecutable = nodeExe,
                sidecarEntry = assets.sidecarEntry,
                workingDirectory = Paths.get(workbench.projectBasePath()),
                onIdeRequest = { method, params -> handleIdeRequest(method, params) },
                onIdeNotification = { method, params -> handleIdeNotification(method, params) },
                onLog = { channel, line -> logService.append(channel, line) },
                onUnexpectedExit = { code ->
                    logService.append("host", "Sidecar process exited unexpectedly with code $code")
                    val currentMgr = sidecar ?: return@SidecarProcessManager
                    val delayMs = currentMgr.nextRestartDelayMs()
                    Thread({
                        Thread.sleep(delayMs)
                        val activeMgr = sidecar ?: return@Thread
                        val future = runCatching { activeMgr.restart(buildInitParams()) }
                            .onFailure { logService.append("host", "Sidecar restart failed: ${it.message}") }
                            .getOrNull()
                        future?.whenComplete { _, err ->
                            if (err != null) {
                                logService.append("host", "Sidecar re-init failed: ${err.message}")
                            } else {
                                if (chatVisible) {
                                    activeMgr.notifyWebviewVisibility(true)
                                }
                                // 通知新 sidecar 重新向所有已打开的 JCEF Webview 推送完整快照
                                if (panels.isNotEmpty()) {
                                    val ready = JsonObject().apply {
                                        addProperty("type", "ready")
                                        add("payload", JsonObject())
                                    }
                                    activeMgr.sendWebviewMessage(ready)
                                }
                            }
                        }
                    }, "harness-deck-sidecar-restart").apply {
                        isDaemon = true
                        start()
                    }
                },
            )
            sidecar = mgr

            val sync = EditorStateSync(project, workbench) { patch ->
                sidecar?.notifyEditorStateChanged(patch)
            }
            sync.install()
            editorSync = sync

            val initParams = buildInitParams()
            mgr.start(initParams).whenComplete { _, err ->
                if (err != null) {
                    logService.append("host", "Sidecar init failed: ${err.message}")
                } else if (chatVisible) {
                    mgr.notifyWebviewVisibility(true)
                }
            }
        }
    }

    private fun openHostSettings() {
        ApplicationManager.getApplication().invokeLater {
            ShowSettingsUtil.getInstance().showSettingsDialog(project, HarnessDeckConfigurable::class.java)
        }
    }

    private fun openWorkbenchPanel(title: String) {
        ApplicationManager.getApplication().invokeLater {
            val fem = FileEditorManager.getInstance(project)
            val existing = workbenchFile
            if (existing != null && fem.isFileOpen(existing)) {
                fem.openFile(existing, true)
                return@invokeLater
            }
            val vf = HarnessDeckWorkbenchVirtualFile(title.ifBlank { "Harness Deck Workbench" })
            workbenchFile = vf
            fem.openFile(vf, true)
        }
    }

    private fun handleIdeNotification(method: String, params: JsonObject) {
        when (method) {
            "ide/postToWebview" -> {
                val msg = params.get("message") ?: return
                panels.forEach { it.postMessage(msg) }
            }
            "ide/statusUpdate" -> {
                val next = StatusBarSnapshot.fromJson(params)
                statusSnapshot = next
                statusListeners.forEach { it(next) }
            }
            "ide/log" -> {
                val channel = params.get("channel")?.asStringOrNull() ?: "host"
                val line = params.get("line")?.asStringOrNull() ?: ""
                val stream = params.get("stream")?.asStringOrNull()
                logService.append(channel, line, stream)
            }
            "ide/openWorkbenchPanel" -> {
                val title = params.get("title")?.asStringOrNull() ?: "Harness Deck Workbench"
                openWorkbenchPanel(title)
            }
            "ide/openHostSettings" -> openHostSettings()
            "ide/showLogs" -> logService.showDialog()
            "ide/progressStart" -> {
                val progressId = params.get("progressId")?.asStringOrNull() ?: return
                val title = params.get("title")?.asStringOrNull() ?: "Harness Deck"
                val latch = CountDownLatch(1)
                activeProgress[progressId] = latch
                ProgressManager.getInstance().run(
                    object : Task.Backgroundable(project, title, true) {
                        override fun run(indicator: ProgressIndicator) {
                            indicator.isIndeterminate = true
                            while (latch.count > 0) {
                                if (indicator.isCanceled) {
                                    sidecar?.notifyCancelProgress(progressId)
                                    break
                                }
                                latch.await(150, TimeUnit.MILLISECONDS)
                            }
                        }
                    },
                )
            }
            "ide/progressEnd" -> {
                val progressId = params.get("progressId")?.asStringOrNull() ?: return
                activeProgress.remove(progressId)?.countDown()
            }
        }
    }

    private fun handleIdeRequest(method: String, params: JsonObject): CompletableFuture<JsonElement> =
        when (method) {
            "ide/focusChatView" -> focusChatView().thenApply { JsonObject() }
            "ide/openDiff" -> {
                val spec = ResolvedDiffSpec.fromJson(params.getAsJsonObject("spec"))
                workbench.openDiff(spec).thenApply { JsonObject() }
            }
            "ide/openFile" -> {
                val path = params.get("path")?.asStringOrNull().orEmpty()
                val rangeObj = params.getAsJsonObject("range")
                val range = rangeObj?.let {
                    LineRange(
                        startLine = it.get("startLine")?.asInt ?: 1,
                        endLine = it.get("endLine")?.takeIf { e -> !e.isJsonNull }?.asInt,
                    )
                }
                workbench.openFile(path, range).thenApply { JsonObject() }
            }
            "ide/findFiles" -> {
                val query = params.get("query")?.asStringOrNull().orEmpty()
                workbench.findFiles(query).thenApply { items ->
                    JsonObject().apply { add("items", SidecarGson.instance.toJsonTree(items)) }
                }
            }
            "ide/saveAll" -> workbench.saveAll().thenApply { JsonObject() }
            "ide/confirm" -> {
                val msg = params.get("message")?.asStringOrNull().orEmpty()
                val detail = params.get("detail")?.asStringOrNull().orEmpty()
                val action = params.get("action")?.asStringOrNull() ?: "OK"
                workbench.confirm(msg, detail, action).thenApply { confirmed ->
                    JsonObject().apply { addProperty("confirmed", confirmed) }
                }
            }
            "ide/input" -> {
                val opts = InputPromptOptions(
                    title = params.get("title")?.asStringOrNull().orEmpty(),
                    prompt = params.get("prompt")?.asStringOrNull(),
                    value = params.get("value")?.asStringOrNull(),
                    placeHolder = params.get("placeHolder")?.asStringOrNull(),
                    password = params.get("password")?.takeIf { !it.isJsonNull }?.asBoolean == true,
                    allowEmpty = params.get("allowEmpty")?.takeIf { !it.isJsonNull }?.asBoolean == true,
                )
                workbench.input(opts).thenApply { value ->
                    JsonObject().apply {
                        if (value != null) addProperty("value", value) else add("value", JsonNull.INSTANCE)
                    }
                }
            }
            "ide/pickOpenDialog" -> {
                val filtersObj = params.getAsJsonObject("filters")
                val filters = filtersObj?.entrySet()?.associate { (k, v) ->
                    k to v.asJsonArray.map { it.asString }
                }
                val opts = OpenDialogOptions(
                    canSelectFiles = params.get("canSelectFiles")?.asBoolean != false,
                    canSelectFolders = params.get("canSelectFolders")?.asBoolean == true,
                    canSelectMany = params.get("canSelectMany")?.asBoolean == true,
                    defaultPath = params.get("defaultPath")?.asStringOrNull(),
                    title = params.get("title")?.asStringOrNull() ?: "Select",
                    filters = filters,
                )
                workbench.pickOpenDialog(opts).thenApply { paths ->
                    val arr = JsonArray()
                    paths.forEach { arr.add(it) }
                    JsonObject().apply { add("paths", arr) }
                }
            }
            "ide/pickQuickItem" -> {
                val rawItems = params.getAsJsonArray("items") ?: JsonArray()
                val items = rawItems.map { el ->
                    val o = el.asJsonObject
                    QuickPickOption(
                        id = o.get("id")?.asStringOrNull().orEmpty(),
                        label = o.get("label")?.asStringOrNull().orEmpty(),
                        description = o.get("description")?.asStringOrNull(),
                        detail = o.get("detail")?.asStringOrNull(),
                        picked = o.get("picked")?.takeIf { !it.isJsonNull }?.asBoolean,
                    )
                }
                val placeHolder = params.get("placeHolder")?.asStringOrNull() ?: "Select"
                workbench.pickQuickItem(items, placeHolder).thenApply { id ->
                    JsonObject().apply {
                        if (id != null) addProperty("id", id) else add("id", JsonNull.INSTANCE)
                    }
                }
            }
            "ide/showMessage" -> {
                val level = params.get("level")?.asStringOrNull() ?: "info"
                val message = params.get("message")?.asStringOrNull().orEmpty()
                val actions = params.getAsJsonArray("actions")?.map { it.asString } ?: emptyList()
                workbench.showMessage(level, message, actions).thenApply { chosen ->
                    JsonObject().apply {
                        if (chosen != null) addProperty("action", chosen) else add("action", JsonNull.INSTANCE)
                    }
                }
            }
            "ide/openExternal" -> {
                val url = params.get("url")?.asStringOrNull().orEmpty()
                workbench.openExternal(url).thenApply { opened ->
                    JsonObject().apply { addProperty("opened", opened) }
                }
            }
            "ide/writeClipboard" -> {
                val text = params.get("text")?.asStringOrNull().orEmpty()
                workbench.writeClipboard(text).thenApply { JsonObject() }
            }
            "ide/openProjectWindow" -> {
                val path = params.get("path")?.asStringOrNull().orEmpty()
                workbench.openProjectWindow(path).thenApply { JsonObject() }
            }
            "ide/runInTerminal" -> {
                val name = params.get("name")?.asStringOrNull() ?: "Harness Deck"
                val cwd = params.get("cwd")?.asStringOrNull() ?: workbench.projectBasePath()
                val cmds = params.getAsJsonArray("commands")?.map { it.asString } ?: emptyList()
                workbench.runInTerminal(name, cwd, cmds).thenApply { JsonObject() }
            }
            "ide/secretGet" -> {
                val key = params.get("key")?.asStringOrNull().orEmpty()
                CompletableFuture.supplyAsync {
                    val value = PasswordSafeStore.get(key)
                    JsonObject().apply {
                        if (value != null) addProperty("value", value) else add("value", JsonNull.INSTANCE)
                    }
                }
            }
            "ide/secretStore" -> {
                val key = params.get("key")?.asStringOrNull().orEmpty()
                val value = params.get("value")?.asStringOrNull().orEmpty()
                CompletableFuture.supplyAsync {
                    PasswordSafeStore.store(key, value)
                    sidecar?.notifySecretChanged(key)
                    JsonObject()
                }
            }
            "ide/secretDelete" -> {
                val key = params.get("key")?.asStringOrNull().orEmpty()
                CompletableFuture.supplyAsync {
                    PasswordSafeStore.delete(key)
                    sidecar?.notifySecretChanged(key)
                    JsonObject()
                }
            }
            else -> CompletableFuture.failedFuture(IllegalArgumentException("Unknown ide RPC method: $method"))
        }

    override fun dispose() {
        activeProgress.values.forEach { it.countDown() }
        activeProgress.clear()
        editorSync?.dispose()
        editorSync = null
        sidecar?.dispose()
        sidecar = null
        resourceServer?.dispose()
        resourceServer = null
    }
}
