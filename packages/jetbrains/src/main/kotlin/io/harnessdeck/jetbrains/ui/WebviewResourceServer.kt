package io.harnessdeck.jetbrains.ui

import com.intellij.openapi.Disposable
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.ui.JBColor
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetAddress
import java.net.InetSocketAddress
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.Executors
import javax.swing.UIManager

/**
 * 面向 JCEF 的本机回环静态资源服务：
 * - 绑定 `127.0.0.1:0`（临时端口）并使用每次进程随机生成的路径令牌，避免 Vite ES Module 动态 chunk 遇到自定义 scheme CORS 限制。
 * - 动态生成 `index.html`，在 `index.js` 执行前注入 `__HARNESS_DECK_HOST__ = 'jetbrains'`、`acquireVsCodeApi` 桥接及 IDEA 主题/字体令牌。
 */
class WebviewResourceServer(
    private val webviewRoot: Path,
    private val storageNamespace: String,
    private val languageTag: String,
) : Disposable {

    private val token: String = run {
        val bytes = ByteArray(16)
        SecureRandom().nextBytes(bytes)
        Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
    private val executor = Executors.newCachedThreadPool { r ->
        Thread(r, "harness-deck-webview-http").apply { isDaemon = true }
    }
    private val server: HttpServer = HttpServer.create(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 0).apply {
        createContext("/$token") { exchange -> handleExchange(exchange) }
        executor = this@WebviewResourceServer.executor
        start()
    }

    val port: Int get() = server.address.port

    fun indexUrl(postCallJs: String): String =
        "http://127.0.0.1:$port/$token/index.html?ns=${urlEncode(storageNamespace)}&cb=${urlEncode(postCallJs)}"

    fun entryUrl(): String =
        "http://127.0.0.1:$port/$token/index.html"

    private fun handleExchange(exchange: HttpExchange) {
        if (exchange.requestMethod != "GET" && exchange.requestMethod != "HEAD") {
            exchange.sendResponseHeaders(405, -1)
            exchange.close()
            return
        }

        val rawPath = exchange.requestURI.path.removePrefix("/$token").removePrefix("/")
        val relPath = if (rawPath.isEmpty() || rawPath == "index.html") "index.html" else rawPath

        if (relPath == "index.html") {
            val htmlBytes = renderHtml().toByteArray(StandardCharsets.UTF_8)
            exchange.responseHeaders.set("Content-Type", "text/html; charset=utf-8")
            exchange.responseHeaders.set("Cache-Control", "no-store")
            exchange.sendResponseHeaders(200, if (exchange.requestMethod == "HEAD") -1 else htmlBytes.size.toLong())
            if (exchange.requestMethod != "HEAD") {
                exchange.responseBody.use { it.write(htmlBytes) }
            }
            exchange.close()
            return
        }

        val resolved = webviewRoot.resolve(relPath).normalize()
        if (!resolved.startsWith(webviewRoot) || !Files.isRegularFile(resolved)) {
            exchange.sendResponseHeaders(404, -1)
            exchange.close()
            return
        }

        val bytes = Files.readAllBytes(resolved)
        exchange.responseHeaders.set("Content-Type", contentTypeFor(resolved.fileName.toString()))
        exchange.responseHeaders.set("Cache-Control", "no-cache")
        exchange.sendResponseHeaders(200, if (exchange.requestMethod == "HEAD") -1 else bytes.size.toLong())
        if (exchange.requestMethod != "HEAD") {
            exchange.responseBody.use { it.write(bytes) }
        }
        exchange.close()
    }

    private fun renderHtml(): String {
        val isDark = !JBColor.isBright()
        val bodyClass = if (isDark) "ide-dark" else "ide-light"
        val uiFont = UIManager.getFont("Label.font")
        val uiFontFamily = escapeCssString(uiFont?.family ?: "Inter")
        val uiFontSize = uiFont?.size ?: 13
        val editorFont = runCatching {
            EditorColorsManager.getInstance().globalScheme.editorFontName
        }.getOrNull() ?: "JetBrains Mono"
        val safeEditorFont = escapeCssString(editorFont)
        val safeLang = if (languageTag.lowercase().startsWith("zh")) "zh" else "en"
        val escapedNamespace = escapeJsString("harnessDeck:state:$storageNamespace")

        return """
            <!doctype html>
            <html lang="$safeLang">
            <head>
              <meta charset="UTF-8" />
              <meta name="viewport" content="width=device-width, initial-scale=1.0" />
              <title>Halo</title>
              <style>
                :root {
                  --vscode-font-family: "$uiFontFamily", -apple-system, BlinkMacSystemFont, sans-serif;
                  --vscode-font-size: ${uiFontSize}px;
                  --vscode-editor-font-family: "$safeEditorFont", monospace;
                }
              </style>
              <script>
                (function () {
                  window.__HARNESS_DECK_HOST__ = 'jetbrains';
                  var STORAGE_KEY = '$escapedNamespace';
                  var memState = {};
                  try {
                    var raw = window.localStorage.getItem(STORAGE_KEY);
                    if (raw) memState = JSON.parse(raw) || {};
                  } catch (e) {}

                  window.__harnessDeckReceiveFromHost = function (msg) {
                    window.dispatchEvent(new MessageEvent('message', { data: msg }));
                  };

                  window.acquireVsCodeApi = function () {
                    return {
                      postMessage: function (msg) {
                        var serialized = JSON.stringify(msg);
                        if (typeof window.__harnessDeckSendToIde === 'function') {
                          window.__harnessDeckSendToIde(serialized);
                        } else {
                          window.__harnessDeckPendingOutgoing = window.__harnessDeckPendingOutgoing || [];
                          window.__harnessDeckPendingOutgoing.push(serialized);
                        }
                      },
                      getState: function () {
                        return memState;
                      },
                      setState: function (next) {
                        memState = next || {};
                        try {
                          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(memState));
                        } catch (e) {}
                      }
                    };
                  };
                })();
              </script>
              <link rel="stylesheet" href="./index.css" />
            </head>
            <body class="$bodyClass">
              <div id="root"></div>
              <script type="module" src="./index.js"></script>
            </body>
            </html>
        """.trimIndent()
    }

    override fun dispose() {
        runCatching { server.stop(0) }
        executor.shutdownNow()
    }

    private fun contentTypeFor(name: String): String =
        when {
            name.endsWith(".js") || name.endsWith(".mjs") -> "application/javascript; charset=utf-8"
            name.endsWith(".css") -> "text/css; charset=utf-8"
            name.endsWith(".svg") -> "image/svg+xml"
            name.endsWith(".png") -> "image/png"
            name.endsWith(".woff2") -> "font/woff2"
            name.endsWith(".woff") -> "font/woff"
            name.endsWith(".json") || name.endsWith(".map") -> "application/json; charset=utf-8"
            else -> "application/octet-stream"
        }

    private fun escapeCssString(raw: String): String =
        raw.replace("\\", "\\\\").replace("\"", "\\\"")

    private fun escapeJsString(raw: String): String =
        raw.replace("\\", "\\\\").replace("'", "\\'")

    private fun urlEncode(raw: String): String =
        java.net.URLEncoder.encode(raw, StandardCharsets.UTF_8)
}
