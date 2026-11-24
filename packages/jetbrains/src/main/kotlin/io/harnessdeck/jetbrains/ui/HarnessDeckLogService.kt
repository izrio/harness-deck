package io.harnessdeck.jetbrains.ui

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.Font
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.CopyOnWriteArrayList
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JTextArea

class HarnessDeckLogService(private val project: Project) {
    private val entries = CopyOnWriteArrayList<String>()
    private val timeFmt = DateTimeFormatter.ofPattern("HH:mm:ss")

    fun append(channel: String, line: String, stream: String? = null) {
        val ts = LocalTime.now().format(timeFmt)
        val tag = if (stream != null) "$channel/$stream" else channel
        entries.add("[$ts] [$tag] $line")
        while (entries.size > 1_500) {
            entries.removeAt(0)
        }
    }

    fun dumpText(): String = entries.joinToString("\n")

    fun showDialog() {
        ApplicationManager.getApplication().invokeLater {
            val dialog = object : DialogWrapper(project) {
                private val textArea = JTextArea(dumpText()).apply {
                    isEditable = false
                    font = Font(Font.MONOSPACED, Font.PLAIN, 12)
                    lineWrap = false
                }

                init {
                    title = "Halo Logs"
                    init()
                }

                override fun createCenterPanel(): JComponent {
                    val panel = JPanel(BorderLayout())
                    panel.preferredSize = Dimension(820, 480)
                    panel.border = JBUI.Borders.empty(4)
                    panel.add(JBScrollPane(textArea), BorderLayout.CENTER)
                    return panel
                }
            }
            dialog.show()
        }
    }
}
