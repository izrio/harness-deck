package io.harnessdeck.jetbrains.sidecar

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.Disposable
import io.harnessdeck.jetbrains.protocol.EditorStateChangedParams
import io.harnessdeck.jetbrains.protocol.JsonRpcTransport
import io.harnessdeck.jetbrains.protocol.SidecarGson
import io.harnessdeck.jetbrains.protocol.SidecarInitParams
import java.io.BufferedReader
import java.io.InputStreamReader
import java.nio.charset.StandardCharsets
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class SidecarProcessManager(
    private val nodeExecutable: String,
    private val sidecarEntry: Path,
    private val workingDirectory: Path?,
    private val onIdeRequest: (method: String, params: JsonObject) -> CompletableFuture<JsonElement>,
    private val onIdeNotification: (method: String, params: JsonObject) -> Unit,
    private val onLog: (channel: String, line: String) -> Unit,
    private val onUnexpectedExit: (code: Int) -> Unit = {},
) : Disposable {

    private var process: Process? = null
    private var transport: JsonRpcTransport? = null
    private val disposed = AtomicBoolean(false)

    @Synchronized
    fun start(initParams: SidecarInitParams): CompletableFuture<JsonElement> {
        check(!disposed.get()) { "SidecarProcessManager already disposed" }
        if (transport != null) {
            return CompletableFuture.completedFuture(JsonObject().apply { addProperty("ok", true) })
        }

        val pb = ProcessBuilder(nodeExecutable, sidecarEntry.toAbsolutePath().toString())
        if (workingDirectory != null) {
            pb.directory(workingDirectory.toFile())
        }
        val proc = pb.start()
        process = proc

        Thread({
            runCatching {
                BufferedReader(InputStreamReader(proc.errorStream, StandardCharsets.UTF_8)).use { reader ->
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isNotBlank()) onLog("sidecar-stderr", line)
                    }
                }
            }
        }, "harness-deck-sidecar-stderr").apply {
            isDaemon = true
            start()
        }

        val rpc = JsonRpcTransport(
            input = proc.inputStream,
            output = proc.outputStream,
            onRequest = onIdeRequest,
            onNotification = onIdeNotification,
            onClose = {
                if (!disposed.get()) {
                    val code = runCatching { proc.waitFor() }.getOrDefault(-1)
                    onUnexpectedExit(code)
                }
            },
        )
        transport = rpc

        return rpc.request("sidecar/init", SidecarGson.instance.toJsonTree(initParams), timeoutMs = 20_000)
    }

    fun executeCommand(command: String, statePatch: EditorStateChangedParams? = null): CompletableFuture<JsonElement> {
        val rpc = transport ?: return CompletableFuture.failedFuture(IllegalStateException("Sidecar not started"))
        val payload = JsonObject().apply {
            addProperty("command", command)
            if (statePatch != null) {
                if (statePatch.includeActiveEditor) {
                    add(
                        "activeEditor",
                        if (statePatch.activeEditor != null) {
                            SidecarGson.instance.toJsonTree(statePatch.activeEditor)
                        } else {
                            com.google.gson.JsonNull.INSTANCE
                        },
                    )
                }
                if (statePatch.dirtyFiles != null) {
                    add("dirtyFiles", SidecarGson.instance.toJsonTree(statePatch.dirtyFiles))
                }
            }
        }
        return rpc.request("sidecar/executeCommand", payload)
    }

    fun sendWebviewMessage(rawMessage: JsonElement) {
        val payload = JsonObject().apply { add("message", rawMessage) }
        transport?.notify("sidecar/webviewMessage", payload)
    }

    fun notifyWebviewVisibility(visible: Boolean) {
        val payload = JsonObject().apply { addProperty("visible", visible) }
        transport?.notify("sidecar/webviewVisibility", payload)
    }

    fun notifyEditorStateChanged(params: EditorStateChangedParams) {
        val payload = params.toJsonObject()
        if (payload.size() > 0) {
            transport?.notify("sidecar/editorStateChanged", payload)
        }
    }

    fun notifySecretChanged(key: String) {
        val payload = JsonObject().apply { addProperty("key", key) }
        transport?.notify("sidecar/secretChanged", payload)
    }

    fun notifyCancelProgress(progressId: String) {
        val payload = JsonObject().apply { addProperty("progressId", progressId) }
        transport?.notify("sidecar/cancelProgress", payload)
    }

    override fun dispose() {
        if (!disposed.compareAndSet(false, true)) return
        val rpc = transport
        transport = null
        val proc = process
        process = null

        if (rpc != null) {
            runCatching { rpc.request("sidecar/shutdown", JsonObject(), timeoutMs = 1_500).get(1_500, TimeUnit.MILLISECONDS) }
            runCatching { rpc.close() }
        }
        if (proc != null && proc.isAlive) {
            proc.destroy()
            if (!proc.waitFor(1_500, TimeUnit.MILLISECONDS)) {
                proc.destroyForcibly()
            }
        }
    }
}
