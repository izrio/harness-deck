package io.harnessdeck.jetbrains.ui

import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.LightVirtualFile
import io.harnessdeck.jetbrains.service.HarnessDeckProjectService
import java.beans.PropertyChangeListener
import javax.swing.JComponent

class HarnessDeckWorkbenchVirtualFile(title: String) :
    LightVirtualFile(title, PlainTextFileType.INSTANCE, "") {
    init {
        isWritable = false
    }
}

class HarnessDeckWorkbenchEditorProvider : FileEditorProvider, DumbAware {
    override fun accept(project: Project, file: VirtualFile): Boolean =
        file is HarnessDeckWorkbenchVirtualFile

    override fun createEditor(project: Project, file: VirtualFile): FileEditor =
        HarnessDeckWorkbenchFileEditor(project, file)

    override fun getEditorTypeId(): String = "harness-deck-workbench"

    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.HIDE_DEFAULT_EDITOR
}

private class HarnessDeckWorkbenchFileEditor(
    private val project: Project,
    private val virtualFile: VirtualFile,
) : UserDataHolderBase(), FileEditor {

    private val service = project.getService(HarnessDeckProjectService::class.java)
    private val panel = service.createWebviewPanel(this)

    override fun getComponent(): JComponent = panel.component

    override fun getPreferredFocusedComponent(): JComponent = panel.component

    override fun getName(): String = virtualFile.name

    override fun setState(state: FileEditorState) {}

    override fun isModified(): Boolean = false

    override fun isValid(): Boolean = true

    override fun addPropertyChangeListener(listener: PropertyChangeListener) {}

    override fun removePropertyChangeListener(listener: PropertyChangeListener) {}

    override fun getFile(): VirtualFile = virtualFile

    override fun dispose() {}
}
