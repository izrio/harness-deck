package io.harnessdeck.jetbrains.ui

import com.google.gson.JsonElement
import com.intellij.openapi.Disposable
import com.intellij.openapi.util.Disposer
import java.awt.BorderLayout
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.SwingConstants

class HarnessDeckWebviewPanel(
    parentDisposable: Disposable,
    resourceServer: WebviewResourceServer,
    onWebviewMessage: (JsonElement) -> Unit,
    onError: (String) -> Unit = {},
) : Disposable {

    val component: JComponent
    private val bridge: WebviewBridge?

    init {
        Disposer.register(parentDisposable, this)

        val created = runCatching {
            JcefWebviewFactory.createIfSupported(
                parentDisposable = this,
                resourceServer = resourceServer,
                onWebviewMessage = onWebviewMessage,
                onError = onError,
            )
        }.onFailure { err ->
            onError("Failed to initialize JCEF webview: ${err::class.java.simpleName}: ${err.message}")
        }.getOrNull()

        if (created == null) {
            bridge = null
            val fallback = JPanel(BorderLayout())
            fallback.add(
                JLabel(
                    "JCEF is not available. Please ensure a JetBrains Runtime with JCEF is active and the 'Web Browser (JCEF)' plugin is enabled.",
                    SwingConstants.CENTER,
                ),
                BorderLayout.CENTER,
            )
            component = fallback
        } else {
            bridge = created
            component = created.component
        }
    }

    fun postMessage(message: JsonElement) {
        bridge?.postMessage(message)
    }

    override fun dispose() = Unit
}
