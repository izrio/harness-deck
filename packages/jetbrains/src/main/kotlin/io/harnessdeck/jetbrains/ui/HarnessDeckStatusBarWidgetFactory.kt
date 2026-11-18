package io.harnessdeck.jetbrains.ui

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.Consumer
import io.harnessdeck.jetbrains.protocol.StatusBarSnapshot
import io.harnessdeck.jetbrains.service.HarnessDeckProjectService
import java.awt.event.MouseEvent

class HarnessDeckStatusBarWidgetFactory : StatusBarWidgetFactory {
    override fun getId(): String = WIDGET_ID

    override fun getDisplayName(): String = "Harness Deck"

    override fun isAvailable(project: Project): Boolean = true

    override fun createWidget(project: Project): StatusBarWidget = HarnessDeckStatusBarWidget(project)

    companion object {
        const val WIDGET_ID = "HarnessDeckStatusBar"
    }
}

private class HarnessDeckStatusBarWidget(private val project: Project) :
    StatusBarWidget,
    StatusBarWidget.TextPresentation {

    private var statusBar: StatusBar? = null
    @Volatile
    private var snapshot: StatusBarSnapshot = StatusBarSnapshot("Harness Deck", "idle", null)

    override fun ID(): String = HarnessDeckStatusBarWidgetFactory.WIDGET_ID

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        val service = project.getService(HarnessDeckProjectService::class.java)
        snapshot = service.currentStatusBarSnapshot()
        service.addStatusListener { next ->
            snapshot = next
            ApplicationManager.getApplication().invokeLater {
                this.statusBar?.updateWidget(ID())
            }
        }
    }

    override fun dispose() {
        statusBar = null
    }

    override fun getText(): String {
        val s = snapshot
        val modelPart = if (!s.modelLabel.isNullOrBlank()) " · ${s.modelLabel}" else ""
        val statePart = when (s.statusKind) {
            "starting", "locating" -> " (starting)"
            "reconnecting" -> " (reconnecting)"
            "notInstalled" -> " (not installed)"
            "failed" -> " (error)"
            else -> ""
        }
        return "${s.backendName}$modelPart$statePart"
    }

    override fun getAlignment(): Float = 0.0f

    override fun getTooltipText(): String =
        "Harness Deck: ${snapshot.backendName} (${snapshot.statusKind}) — Click to open chat"

    override fun getClickConsumer(): Consumer<MouseEvent> = Consumer {
        project.getService(HarnessDeckProjectService::class.java).focusChatView()
    }
}
