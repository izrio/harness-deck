package io.harnessdeck.jetbrains.ide

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import java.util.concurrent.CompletableFuture

object TerminalRunnerHelper {
    fun runCommands(project: Project, name: String, cwd: String, commands: List<String>): CompletableFuture<Void> {
        val future = CompletableFuture<Void>()
        val joined = commands.joinToString(" && ")
        ApplicationManager.getApplication().invokeLater {
            try {
                val mgr = org.jetbrains.plugins.terminal.TerminalToolWindowManager.getInstance(project)
                val widget = mgr.createShellWidget(cwd, name, true, true)
                widget.sendCommandToExecute(joined)
                future.complete(null)
            } catch (t: Throwable) {
                future.completeExceptionally(t)
            }
        }
        return future
    }
}
