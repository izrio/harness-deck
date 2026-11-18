package io.harnessdeck.jetbrains.ide

import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.ide.BrowserUtil
import com.intellij.ide.impl.ProjectUtil
import com.intellij.ide.trustedProjects.TrustedProjects
import com.intellij.ide.trustedProjects.TrustedProjectsLocator
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.JBPopupListener
import com.intellij.openapi.ui.popup.LightweightWindowEvent
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.WindowManager
import com.intellij.testFramework.LightVirtualFile
import com.intellij.ui.ColoredListCellRenderer
import com.intellij.ui.SimpleTextAttributes
import com.intellij.util.net.HttpConfigurable
import com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerEx
import io.harnessdeck.jetbrains.protocol.DiffSideSpec
import io.harnessdeck.jetbrains.protocol.EditorSelection
import io.harnessdeck.jetbrains.protocol.EditorSnapshot
import io.harnessdeck.jetbrains.protocol.FileCandidate
import io.harnessdeck.jetbrains.protocol.InputPromptOptions
import io.harnessdeck.jetbrains.protocol.LineRange
import io.harnessdeck.jetbrains.protocol.OpenDialogOptions
import io.harnessdeck.jetbrains.protocol.QuickPickOption
import io.harnessdeck.jetbrains.protocol.ResolvedDiffSpec
import io.harnessdeck.jetbrains.protocol.WorkspaceFolderItem
import java.awt.datatransfer.StringSelection
import java.io.File
import java.nio.file.Paths
import java.util.Locale
import java.util.concurrent.CompletableFuture
import javax.swing.JList

class IdeaWorkbenchAdapter(private val project: Project) {

    fun projectBasePath(): String =
        project.basePath ?: System.getProperty("user.home")

    fun workspaceFolders(): List<WorkspaceFolderItem> {
        val base = projectBasePath()
        return listOf(WorkspaceFolderItem(name = project.name.ifBlank { File(base).name }, path = base))
    }

    fun isWorkspaceTrusted(): Boolean =
        runCatching { TrustedProjects.isProjectTrusted(TrustedProjectsLocator.locateProject(project)) }
            .getOrElse { true }

    fun isWindowFocused(): Boolean {
        val frame = WindowManager.getInstance().getFrame(project) ?: return true
        return frame.isActive
    }

    fun ideLanguage(): String {
        val locale = Locale.getDefault()
        val lang = locale.language.lowercase()
        val country = locale.country
        return if (country.isNotBlank()) "$lang-$country" else lang
    }

    fun httpProxyUrl(): String? {
        val cfg = HttpConfigurable.getInstance()
        if (!cfg.USE_HTTP_PROXY || cfg.PROXY_HOST.isNullOrBlank()) return null
        val host = cfg.PROXY_HOST.trim()
        val port = cfg.PROXY_PORT
        val scheme = if (cfg.PROXY_TYPE_IS_SOCKS) "socks" else "http"
        return "$scheme://$host:$port"
    }

    fun captureActiveEditor(): EditorSnapshot? =
        ReadAction.compute<EditorSnapshot?, Throwable> {
            val editor: Editor = FileEditorManager.getInstance(project).selectedTextEditor ?: return@compute null
            val vf = FileDocumentManager.getInstance().getFile(editor.document) ?: return@compute null
            if (!vf.isInLocalFileSystem) return@compute null

            val languageId = vf.fileType.name.lowercase()
            val selModel = editor.selectionModel
            val selection = if (selModel.hasSelection()) {
                val startOffset = selModel.selectionStart
                val endOffset = selModel.selectionEnd
                val doc = editor.document
                val startLine = doc.getLineNumber(startOffset) + 1
                val adjustedEndOffset = if (endOffset > startOffset && doc.charsSequence[endOffset - 1] == '\n') {
                    endOffset - 1
                } else {
                    endOffset
                }
                val endLine = doc.getLineNumber(adjustedEndOffset.coerceAtLeast(startOffset)) + 1
                val text = selModel.selectedText ?: ""

                val diagnostics = mutableListOf<String>()
                runCatching {
                    DaemonCodeAnalyzerEx.processHighlights(
                        doc,
                        project,
                        HighlightSeverity.WARNING,
                        startOffset,
                        endOffset,
                    ) { info ->
                        val desc = info.description
                        if (!desc.isNullOrBlank()) {
                            val line = doc.getLineNumber(info.startOffset) + 1
                            val sev = info.severity.name.lowercase()
                            diagnostics += "$line: $sev: $desc"
                        }
                        diagnostics.size < 20
                    }
                }

                EditorSelection(
                    startLine = startLine,
                    endLine = endLine,
                    text = text,
                    diagnostics = diagnostics,
                )
            } else {
                null
            }

            EditorSnapshot(
                path = vf.path,
                languageId = languageId,
                selection = selection,
            )
        }

    fun captureDirtyFiles(): List<String> =
        ReadAction.compute<List<String>, Throwable> {
            val fdm = FileDocumentManager.getInstance()
            fdm.unsavedDocuments
                .mapNotNull { doc -> fdm.getFile(doc) }
                .filter { it.isInLocalFileSystem }
                .map { it.path }
                .sorted()
        }

    fun openDiff(spec: ResolvedDiffSpec): CompletableFuture<Void> {
        val future = CompletableFuture<Void>()
        ApplicationManager.getApplication().invokeLater({
            try {
                when (spec) {
                    is ResolvedDiffSpec.Pair -> {
                        val contentFactory = DiffContentFactory.getInstance()
                        val left = toDiffContent(contentFactory, spec.left)
                        val right = toDiffContent(contentFactory, spec.right)
                        val leftTitle = sideLabel(spec.left)
                        val rightTitle = sideLabel(spec.right)
                        val req = SimpleDiffRequest(spec.title, left, right, leftTitle, rightTitle)
                        DiffManager.getInstance().showDiff(project, req)
                    }
                    is ResolvedDiffSpec.Unified -> {
                        val name = "${File(spec.path).name}.diff"
                        val vf = LightVirtualFile(name, spec.patchText)
                        vf.isWritable = false
                        FileEditorManager.getInstance(project).openFile(vf, true)
                    }
                    is ResolvedDiffSpec.CannotPreview -> {
                        showMessage("info", spec.message, emptyList())
                    }
                }
                future.complete(null)
            } catch (t: Throwable) {
                future.completeExceptionally(t)
            }
        }, ModalityState.defaultModalityState())
        return future
    }

    private fun toDiffContent(factory: DiffContentFactory, side: DiffSideSpec) =
        when (side) {
            is DiffSideSpec.Disk -> {
                val vf = LocalFileSystem.getInstance().refreshAndFindFileByPath(side.path)
                if (vf != null) {
                    factory.create(project, vf)
                } else {
                    val fileType = FileTypeManager.getInstance().getFileTypeByFileName(File(side.path).name)
                    factory.create(project, "", fileType)
                }
            }
            is DiffSideSpec.Virtual -> {
                val fileType = FileTypeManager.getInstance().getFileTypeByFileName(File(side.path).name)
                factory.create(project, side.content, fileType)
            }
        }

    private fun sideLabel(side: DiffSideSpec): String =
        when (side) {
            is DiffSideSpec.Disk -> File(side.path).name
            is DiffSideSpec.Virtual -> "${File(side.path).name} (${side.label})"
        }

    fun openFile(path: String, range: LineRange?): CompletableFuture<Void> {
        val future = CompletableFuture<Void>()
        ApplicationManager.getApplication().invokeLater({
            try {
                val vf = LocalFileSystem.getInstance().refreshAndFindFileByPath(path)
                if (vf != null) {
                    if (vf.isDirectory) {
                        FileEditorManager.getInstance(project).openFile(vf, true)
                    } else {
                        val line = ((range?.startLine ?: 1) - 1).coerceAtLeast(0)
                        OpenFileDescriptor(project, vf, line, 0).navigate(true)
                    }
                }
                future.complete(null)
            } catch (t: Throwable) {
                future.completeExceptionally(t)
            }
        }, ModalityState.defaultModalityState())
        return future
    }

    fun findFiles(query: String): CompletableFuture<List<FileCandidate>> =
        CompletableFuture.supplyAsync {
            ReadAction.compute<List<FileCandidate>, Throwable> {
                val basePath = project.basePath?.let { Paths.get(it) }
                val normalizedQuery = query.trim().lowercase()
                val results = mutableListOf<FileCandidate>()
                ProjectFileIndex.getInstance(project).iterateContent { vf ->
                    val rel = if (basePath != null) {
                        runCatching { basePath.relativize(Paths.get(vf.path)).toString().replace('\\', '/') }
                            .getOrElse { vf.path }
                    } else {
                        vf.path
                    }
                    if (normalizedQuery.isEmpty() || rel.lowercase().contains(normalizedQuery)) {
                        results += FileCandidate(
                            path = rel,
                            kind = if (vf.isDirectory) "directory" else "file",
                        )
                    }
                    results.size < 60
                }
                results
            }
        }

    fun saveAll(): CompletableFuture<Void> {
        val future = CompletableFuture<Void>()
        ApplicationManager.getApplication().invokeLater({
            try {
                FileDocumentManager.getInstance().saveAllDocuments()
                future.complete(null)
            } catch (t: Throwable) {
                future.completeExceptionally(t)
            }
        }, ModalityState.defaultModalityState())
        return future
    }

    fun confirm(message: String, detail: String, action: String): CompletableFuture<Boolean> {
        val future = CompletableFuture<Boolean>()
        ApplicationManager.getApplication().invokeLater({
            try {
                val fullMessage = if (detail.isNotBlank()) "$message\n\n$detail" else message
                val res = Messages.showYesNoDialog(
                    project,
                    fullMessage,
                    "Harness Deck",
                    action,
                    Messages.getCancelButton(),
                    Messages.getQuestionIcon(),
                )
                future.complete(res == Messages.YES)
            } catch (t: Throwable) {
                future.completeExceptionally(t)
            }
        }, ModalityState.defaultModalityState())
        return future
    }

    fun input(options: InputPromptOptions): CompletableFuture<String?> {
        val future = CompletableFuture<String?>()
        ApplicationManager.getApplication().invokeLater({
            try {
                val promptText = options.prompt ?: options.placeHolder ?: ""
                val result = if (options.password) {
                    Messages.showPasswordDialog(project, promptText, options.title, null)
                } else {
                    Messages.showInputDialog(
                        project,
                        promptText,
                        options.title,
                        Messages.getQuestionIcon(),
                        options.value,
                        null,
                    )
                }
                val finalResult = if (result != null && !options.allowEmpty && result.isBlank()) null else result
                future.complete(finalResult)
            } catch (t: Throwable) {
                future.completeExceptionally(t)
            }
        }, ModalityState.defaultModalityState())
        return future
    }

    fun pickOpenDialog(options: OpenDialogOptions): CompletableFuture<List<String>> {
        val future = CompletableFuture<List<String>>()
        ApplicationManager.getApplication().invokeLater({
            try {
                val descriptor = FileChooserDescriptor(
                    options.canSelectFiles,
                    options.canSelectFolders,
                    false,
                    false,
                    false,
                    options.canSelectMany,
                ).apply {
                    title = options.title
                    val allowedExts = options.filters?.values?.flatten()?.map { it.lowercase() }?.toSet()
                    if (!allowedExts.isNullOrEmpty()) {
                        withFileFilter { vf ->
                            vf.isDirectory || allowedExts.contains(vf.extension?.lowercase())
                        }
                    }
                }
                val initial: VirtualFile? = options.defaultPath?.let {
                    LocalFileSystem.getInstance().findFileByPath(it)
                }
                val chosen = FileChooser.chooseFiles(descriptor, project, initial)
                future.complete(chosen.map { it.path })
            } catch (t: Throwable) {
                future.completeExceptionally(t)
            }
        }, ModalityState.defaultModalityState())
        return future
    }

    fun pickQuickItem(items: List<QuickPickOption>, placeHolder: String): CompletableFuture<String?> {
        val future = CompletableFuture<String?>()
        if (items.isEmpty()) {
            future.complete(null)
            return future
        }
        ApplicationManager.getApplication().invokeLater({
            try {
                var resolved = false
                val selectedDefault = items.firstOrNull { it.picked == true }
                val builder = JBPopupFactory.getInstance()
                    .createPopupChooserBuilder(items)
                    .setTitle(placeHolder)
                    .setRenderer(object : ColoredListCellRenderer<QuickPickOption>() {
                        override fun customizeCellRenderer(
                            list: JList<out QuickPickOption>,
                            value: QuickPickOption,
                            index: Int,
                            selected: Boolean,
                            hasFocus: Boolean,
                        ) {
                            append(value.label, SimpleTextAttributes.REGULAR_ATTRIBUTES)
                            if (!value.description.isNullOrBlank()) {
                                append("  ${value.description}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                            }
                        }
                    })
                    .setItemChosenCallback { chosen ->
                        resolved = true
                        future.complete(chosen.id)
                    }
                    .addListener(object : JBPopupListener {
                        override fun onClosed(event: LightweightWindowEvent) {
                            if (!resolved) {
                                future.complete(null)
                            }
                        }
                    })

                if (selectedDefault != null) {
                    builder.setSelectedValue(selectedDefault, true)
                }
                builder.createPopup().showCenteredInCurrentWindow(project)
            } catch (t: Throwable) {
                future.completeExceptionally(t)
            }
        }, ModalityState.defaultModalityState())
        return future
    }

    fun showMessage(level: String, message: String, actions: List<String>): CompletableFuture<String?> {
        val future = CompletableFuture<String?>()
        ApplicationManager.getApplication().invokeLater({
            try {
                val type = when (level) {
                    "error" -> NotificationType.ERROR
                    "warning" -> NotificationType.WARNING
                    else -> NotificationType.INFORMATION
                }
                val notification = NotificationGroupManager.getInstance()
                    .getNotificationGroup("Harness Deck")
                    .createNotification("Harness Deck", message, type)

                if (actions.isEmpty()) {
                    notification.notify(project)
                    future.complete(null)
                } else {
                    for (actionLabel in actions) {
                        notification.addAction(
                            NotificationAction.createSimpleExpiring(actionLabel) {
                                future.complete(actionLabel)
                            },
                        )
                    }
                    notification.whenExpired {
                        if (!future.isDone) future.complete(null)
                    }
                    notification.notify(project)
                }
            } catch (t: Throwable) {
                future.completeExceptionally(t)
            }
        }, ModalityState.defaultModalityState())
        return future
    }

    fun openExternal(url: String): CompletableFuture<Boolean> {
        val future = CompletableFuture<Boolean>()
        ApplicationManager.getApplication().invokeLater({
            try {
                BrowserUtil.browse(url)
                future.complete(true)
            } catch (_: Throwable) {
                future.complete(false)
            }
        }, ModalityState.defaultModalityState())
        return future
    }

    fun writeClipboard(text: String): CompletableFuture<Void> {
        val future = CompletableFuture<Void>()
        ApplicationManager.getApplication().invokeLater({
            try {
                CopyPasteManager.getInstance().setContents(StringSelection(text))
                future.complete(null)
            } catch (t: Throwable) {
                future.completeExceptionally(t)
            }
        }, ModalityState.defaultModalityState())
        return future
    }

    fun openProjectWindow(path: String): CompletableFuture<Void> {
        val future = CompletableFuture<Void>()
        ApplicationManager.getApplication().invokeLater({
            try {
                ProjectUtil.openOrImport(Paths.get(path), project, true)
                future.complete(null)
            } catch (t: Throwable) {
                future.completeExceptionally(t)
            }
        }, ModalityState.defaultModalityState())
        return future
    }

    fun runInTerminal(name: String, cwd: String, commands: List<String>): CompletableFuture<Void> =
        TerminalRunnerHelper.runCommands(project, name, cwd, commands)
}
