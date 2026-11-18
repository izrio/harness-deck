package io.harnessdeck.jetbrains.protocol

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.Closeable
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * 双向 NDJSON JSON-RPC 2.0 传输层（与 `packages/extension/src/sidecar/protocol.ts` 的 `JsonRpcPeer` 对齐）。
 */
class JsonRpcTransport(
    input: InputStream,
    output: OutputStream,
    private val onRequest: (method: String, params: JsonObject) -> CompletableFuture<JsonElement>,
    private val onNotification: (method: String, params: JsonObject) -> Unit,
    private val onClose: (Throwable?) -> Unit = {},
) : Closeable {

    private val reader = BufferedReader(InputStreamReader(input, StandardCharsets.UTF_8))
    private val writer = BufferedWriter(OutputStreamWriter(output, StandardCharsets.UTF_8))
    private val writeLock = Any()
    private val nextId = AtomicLong(1)
    private val pending = ConcurrentHashMap<Long, CompletableFuture<JsonElement>>()
    private val closed = AtomicBoolean(false)
    private val requestExecutor: ExecutorService = Executors.newCachedThreadPool { r ->
        Thread(r, "harness-deck-rpc-worker").apply { isDaemon = true }
    }
    private val readerThread: Thread = Thread({ readLoop() }, "harness-deck-rpc-reader").apply {
        isDaemon = true
        start()
    }

    fun notify(method: String, params: JsonElement = JsonObject()) {
        if (closed.get()) return
        val msg = JsonObject().apply {
            addProperty("jsonrpc", "2.0")
            addProperty("method", method)
            add("params", params)
        }
        writeJson(msg)
    }

    fun request(method: String, params: JsonElement = JsonObject(), timeoutMs: Long = 30_000): CompletableFuture<JsonElement> {
        if (closed.get()) {
            return CompletableFuture<JsonElement>().apply {
                completeExceptionally(IllegalStateException("RPC channel closed before calling $method"))
            }
        }
        val id = nextId.getAndIncrement()
        val future = CompletableFuture<JsonElement>()
        if (timeoutMs > 0) {
            future.orTimeout(timeoutMs, TimeUnit.MILLISECONDS)
        }
        pending[id] = future
        future.whenComplete { _, _ -> pending.remove(id) }

        val msg = JsonObject().apply {
            addProperty("jsonrpc", "2.0")
            addProperty("id", id)
            addProperty("method", method)
            add("params", params)
        }
        writeJson(msg)
        return future
    }

    private fun writeJson(obj: JsonObject) {
        if (closed.get()) return
        val line = SidecarGson.instance.toJson(obj)
        synchronized(writeLock) {
            if (closed.get()) return
            try {
                writer.write(line)
                writer.newLine()
                writer.flush()
            } catch (t: Throwable) {
                closeInternal(t)
            }
        }
    }

    private fun readLoop() {
        var closeReason: Throwable? = null
        try {
            while (!closed.get()) {
                val raw = reader.readLine() ?: break
                val trimmed = raw.trim()
                if (trimmed.isEmpty()) continue
                handleLine(trimmed)
            }
        } catch (t: Throwable) {
            if (!closed.get()) closeReason = t
        } finally {
            closeInternal(closeReason)
        }
    }

    private fun handleLine(trimmed: String) {
        val obj = try {
            val parsed = JsonParser.parseString(trimmed)
            if (!parsed.isJsonObject) return
            parsed.asJsonObject
        } catch (_: Throwable) {
            return
        }

        val method = obj.get("method")?.takeIf { it.isJsonPrimitive }?.asString
        val idEl = obj.get("id")?.takeIf { !it.isJsonNull }

        if (method != null) {
            val params = obj.get("params")?.takeIf { it.isJsonObject }?.asJsonObject ?: JsonObject()
            if (idEl != null) {
                requestExecutor.execute {
                    try {
                        onRequest(method, params).whenComplete { result, error ->
                            if (error != null) {
                                val errPayload = JsonObject().apply {
                                    addProperty("jsonrpc", "2.0")
                                    add("id", idEl)
                                    add(
                                        "error",
                                        JsonObject().apply {
                                            addProperty("code", -32000)
                                            addProperty("message", (error.cause ?: error).message ?: error.toString())
                                        },
                                    )
                                }
                                writeJson(errPayload)
                            } else {
                                val okPayload = JsonObject().apply {
                                    addProperty("jsonrpc", "2.0")
                                    add("id", idEl)
                                    add("result", result ?: JsonObject())
                                }
                                writeJson(okPayload)
                            }
                        }
                    } catch (t: Throwable) {
                        val errPayload = JsonObject().apply {
                            addProperty("jsonrpc", "2.0")
                            add("id", idEl)
                            add(
                                "error",
                                JsonObject().apply {
                                    addProperty("code", -32000)
                                    addProperty("message", t.message ?: t.toString())
                                },
                            )
                        }
                        writeJson(errPayload)
                    }
                }
            } else {
                try {
                    onNotification(method, params)
                } catch (_: Throwable) {
                    // ignore uncaught notification listener error
                }
            }
            return
        }

        if (idEl != null && idEl.isJsonPrimitive && idEl.asJsonPrimitive.isNumber) {
            val id = idEl.asLong
            val future = pending.remove(id) ?: return
            val errObj = obj.get("error")?.takeIf { it.isJsonObject }?.asJsonObject
            if (errObj != null) {
                val message = errObj.get("message")?.asStringOrNull() ?: "RPC error"
                future.completeExceptionally(RuntimeException(message))
            } else {
                future.complete(obj.get("result") ?: JsonObject())
            }
        }
    }

    override fun close() {
        closeInternal(null)
    }

    private fun closeInternal(reason: Throwable?) {
        if (!closed.compareAndSet(false, true)) return
        val ex = reason ?: IllegalStateException("RPC channel closed")
        pending.values.forEach { it.completeExceptionally(ex) }
        pending.clear()
        runCatching { synchronized(writeLock) { writer.close() } }
        runCatching { reader.close() }
        requestExecutor.shutdownNow()
        if (Thread.currentThread() !== readerThread) {
            readerThread.interrupt()
        }
        onClose(reason)
    }
}
