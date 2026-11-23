package io.harnessdeck.jetbrains.ide

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import java.util.concurrent.CompletableFuture

object TerminalRunnerHelper {
    fun runCommands(
        project: Project,
        name: String,
        cwd: String,
        commands: List<String>,
        env: Map<String, String> = emptyMap(),
    ): CompletableFuture<Void> {
        val future = CompletableFuture<Void>()
        val isWindows = System.getProperty("os.name").orEmpty().lowercase().contains("win")
        val envSetup = if (env.isNotEmpty() && isWindows) {
            env.entries.map { (k, v) ->
                val escaped = v.replace("'", "''")
                "\$env:$k='$escaped'"
            }
        } else {
            emptyList()
        }
        val joined = (envSetup + commands).joinToString(if (isWindows) "; " else " && ")
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
