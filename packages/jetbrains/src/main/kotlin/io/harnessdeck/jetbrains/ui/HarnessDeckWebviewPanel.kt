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
import java.awt.BorderLayout
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.SwingConstants

class HarnessDeckWebviewPanel(
    parentDisposable: Disposable,
    private val resourceServer: WebviewResourceServer,
    private val onWebviewMessage: (JsonElement) -> Unit,
    private val onError: (String) -> Unit = {},
) : Disposable {

    val component: JComponent
    private val browser: JBCefBrowser?
    private val jsQuery: JBCefJSQuery?
    @Volatile
    private var pageLoaded = false

    init {
        Disposer.register(parentDisposable, this)

        if (!JBCefApp.isSupported()) {
            browser = null
            jsQuery = null
            val fallback = JPanel(BorderLayout())
            fallback.add(
                JLabel(
                    "JCEF is not supported in this JetBrains runtime. Please switch to a JetBrains Runtime with JCEF enabled.",
                    SwingConstants.CENTER,
                ),
                BorderLayout.CENTER,
            )
            component = fallback
        } else {
            val jbBrowser = JBCefBrowser()
            val query = JBCefJSQuery.create(jbBrowser as JBCefBrowserBase)
            browser = jbBrowser
            jsQuery = query
            component = jbBrowser.component

            query.addHandler { rawJson ->
                runCatching {
                    val parsed = JsonParser.parseString(rawJson)
                    onWebviewMessage(parsed)
                }.onFailure { err ->
                    onError("Invalid webview message: ${err.message}")
                }
                null
            }

            jbBrowser.jbCefClient.addLoadHandler(
                object : CefLoadHandlerAdapter() {
                    override fun onLoadEnd(cefBrowser: CefBrowser, frame: CefFrame, httpStatusCode: Int) {
                        if (!frame.isMain) return
                        pageLoaded = true
                        val injectCall = query.inject("payload")
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
                jbBrowser.cefBrowser,
            )

            val bus = ApplicationManager.getApplication().messageBus.connect(this)
            bus.subscribe(
                LafManagerListener.TOPIC,
                LafManagerListener { _: LafManager -> syncThemeClass() },
            )

            jbBrowser.loadURL(resourceServer.entryUrl())
        }
    }

    fun postMessage(message: JsonElement) {
        val b = browser ?: return
        if (!pageLoaded) return
        val json = SidecarGson.instance.toJson(message)
        val script = "window.__harnessDeckReceiveFromHost && window.__harnessDeckReceiveFromHost($json);"
        b.cefBrowser.executeJavaScript(script, b.cefBrowser.url, 0)
    }

    private fun syncThemeClass() {
        val b = browser ?: return
        if (!pageLoaded) return
        val isDark = !JBColor.isBright()
        val script = """
            if (document.body) {
              document.body.classList.toggle('ide-dark', $isDark);
              document.body.classList.toggle('ide-light', ${!isDark});
            }
        """.trimIndent()
        b.cefBrowser.executeJavaScript(script, b.cefBrowser.url, 0)
    }

    override fun dispose() {
        jsQuery?.let { Disposer.dispose(it) }
        browser?.let { Disposer.dispose(it) }
    }
}
