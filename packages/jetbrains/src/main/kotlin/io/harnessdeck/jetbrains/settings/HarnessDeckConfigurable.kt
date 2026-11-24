package io.harnessdeck.jetbrains.settings

import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.ui.TextFieldWithBrowseButton
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.FormBuilder
import java.awt.BorderLayout
import javax.swing.JComponent
import javax.swing.JPanel

class HarnessDeckConfigurable : Configurable {
    private var nodePathField: TextFieldWithBrowseButton? = null

    override fun getDisplayName(): String = "Halo"

    override fun createComponent(): JComponent {
        val field = TextFieldWithBrowseButton().apply {
            addBrowseFolderListener(
                "Select Node.js Executable",
                "Path to Node.js (>= 20) executable used by Halo sidecar",
                null,
                FileChooserDescriptorFactory.createSingleFileNoJarsDescriptor(),
            )
            text = HarnessDeckAppSettings.getInstance().nodeExecutablePath
        }
        nodePathField = field

        val form = FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("Node.js executable (optional):"), field, 1, false)
            .addComponentFillVertically(JPanel(), 0)
            .panel

        return JPanel(BorderLayout()).apply { add(form, BorderLayout.NORTH) }
    }

    override fun isModified(): Boolean =
        (nodePathField?.text?.trim() ?: "") != HarnessDeckAppSettings.getInstance().nodeExecutablePath

    override fun apply() {
        HarnessDeckAppSettings.getInstance().nodeExecutablePath = nodePathField?.text?.trim() ?: ""
    }

    override fun reset() {
        nodePathField?.text = HarnessDeckAppSettings.getInstance().nodeExecutablePath
    }

    override fun disposeUIResources() {
        nodePathField = null
    }
}
