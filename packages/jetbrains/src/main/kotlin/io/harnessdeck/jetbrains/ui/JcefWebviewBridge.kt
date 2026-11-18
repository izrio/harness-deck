package io.harnessdeck.jetbrains.ui

import com.google.gson.JsonElement
import com.google.gson.JsonParser
import com.intellij.ide.ui.LafManager
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.util.Disposer
import com.intellij.ui.JBColor
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import io.harnessdeck.jetbrains.protocol.SidecarGson
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import javax.swing.JComponent

internal interface WebviewBridge : Disposable {
    val component: JComponent
    fun postMessage(message: JsonElement)
}

internal object JcefWebviewFactory {
    fun createIfSupported(
        parentDisposable: Disposable,
        resourceServer: WebviewResourceServer,
        onWebviewMessage: (JsonElement) -> Unit,
        onError: (String) -> Unit,
    ): WebviewBridge? {
        if (!JBCefApp.isSupported()) return null
        return JcefWebviewBridge(parentDisposable, resourceServer, onWebviewMessage, onError)
    }
}

private class JcefWebviewBridge(
    parentDisposable: Disposable,
    resourceServer: WebviewResourceServer,
    private val onWebviewMessage: (JsonElement) -> Unit,
    private val onError: (String) -> Unit,
) : WebviewBridge {

    private val browser: JBCefBrowser = JBCefBrowser()
    private val jsQuery: JBCefJSQuery = JBCefJSQuery.create(browser as JBCefBrowserBase)
    override val component: JComponent = browser.component

    @Volatile
    private var pageLoaded = false

    init {
        Disposer.register(parentDisposable, this)

        jsQuery.addHandler { rawJson ->
            runCatching {
                val parsed = JsonParser.parseString(rawJson)
                onWebviewMessage(parsed)
            }.onFailure { err ->
                onError("Invalid webview message: ${err.message}")
            }
            null
        }

        browser.jbCefClient.addLoadHandler(
            object : CefLoadHandlerAdapter() {
                override fun onLoadEnd(cefBrowser: CefBrowser, frame: CefFrame, httpStatusCode: Int) {
                    if (!frame.isMain) return
                    pageLoaded = true
                    val injectCall = jsQuery.inject("payload")
                    val bootstrap = """
                        (function () {
                          window.__harnessDeckSendToIde = function (payload) {
                            $injectCall
                          };
                          var q = window.__harnessDeckPendingOutgoing;
                          if (Array.isArray(q) && q.length > 0) {
                            window.__harnessDeckPendingOutgoing = [];
                            for (var i = 0; i < q.length; i++) {
                              window.__harnessDeckSendToIde(q[i]);
                            }
                          }
                        })();
                    """.trimIndent()
                    cefBrowser.executeJavaScript(bootstrap, cefBrowser.url, 0)
                    syncThemeClass()
                }
            },
            browser.cefBrowser,
        )

        val bus = ApplicationManager.getApplication().messageBus.connect(this)
        bus.subscribe(
            LafManagerListener.TOPIC,
            LafManagerListener { _: LafManager -> syncThemeClass() },
        )

        browser.loadURL(resourceServer.entryUrl())
    }

    override fun postMessage(message: JsonElement) {
        if (!pageLoaded) return
        val json = SidecarGson.instance.toJson(message)
        val script = "window.__harnessDeckReceiveFromHost && window.__harnessDeckReceiveFromHost($json);"
        browser.cefBrowser.executeJavaScript(script, browser.cefBrowser.url, 0)
    }

    private fun syncThemeClass() {
        if (!pageLoaded) return
        val isDark = !JBColor.isBright()
        val script = """
            if (document.body) {
              document.body.classList.toggle('ide-dark', $isDark);
              document.body.classList.toggle('ide-light', ${!isDark});
            }
        """.trimIndent()
        browser.cefBrowser.executeJavaScript(script, browser.cefBrowser.url, 0)
    }

    override fun dispose() {
        Disposer.dispose(jsQuery)
        Disposer.dispose(browser)
    }
}
