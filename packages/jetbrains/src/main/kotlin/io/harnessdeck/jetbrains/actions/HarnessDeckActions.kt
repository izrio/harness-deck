package io.harnessdeck.jetbrains.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.project.DumbAware
import io.harnessdeck.jetbrains.service.HarnessDeckProjectService

abstract class BaseHarnessDeckCommandAction(
    private val commandId: String,
    private val requireEditor: Boolean = false,
) : AnAction(), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val project = e.project
        val hasEditor = !requireEditor || e.getData(CommonDataKeys.EDITOR) != null
        e.presentation.isEnabledAndVisible = project != null && hasEditor
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        project.getService(HarnessDeckProjectService::class.java).executeCommand(commandId)
    }
}

class OpenWorkbenchAction : BaseHarnessDeckCommandAction("openWorkbench")
class OpenChatAction : BaseHarnessDeckCommandAction("openChat")
class NewSessionAction : BaseHarnessDeckCommandAction("newSession")
class InterruptAction : BaseHarnessDeckCommandAction("interrupt")
class SelectBackendAction : BaseHarnessDeckCommandAction("selectBackend")
class SelectModelAction : BaseHarnessDeckCommandAction("selectModel")
class SelectFolderAction : BaseHarnessDeckCommandAction("selectFolder")
class RenameSessionAction : BaseHarnessDeckCommandAction("renameSession")
class ConfigureApiKeyAction : BaseHarnessDeckCommandAction("configureApiKey")
class OpenWebUIAction : BaseHarnessDeckCommandAction("openWebUI")
class RestartRuntimeAction : BaseHarnessDeckCommandAction("restartRuntime")
class ShowLogsAction : BaseHarnessDeckCommandAction("showLogs")

class ExplainSelectionAction : BaseHarnessDeckCommandAction("explainSelection", requireEditor = true)
class FixSelectionAction : BaseHarnessDeckCommandAction("fixSelection", requireEditor = true)
class TestSelectionAction : BaseHarnessDeckCommandAction("testSelection", requireEditor = true)
class AddToChatAction : BaseHarnessDeckCommandAction("addToChat", requireEditor = true)
