package io.harnessdeck.jetbrains.ide

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.CaretEvent
import com.intellij.openapi.editor.event.CaretListener
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.editor.event.SelectionEvent
import com.intellij.openapi.editor.event.SelectionListener
import com.intellij.openapi.fileEditor.FileDocumentManagerListener
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.WindowManager
import com.intellij.util.Alarm
import io.harnessdeck.jetbrains.protocol.EditorSnapshot
import io.harnessdeck.jetbrains.protocol.EditorStateChangedParams
import java.awt.event.WindowAdapter
import java.awt.event.WindowEvent

/**
 * 监听 IntelliJ IDEA 的活动编辑器、选区、诊断信息、未保存文件及窗口焦点变化，
 * 以 100ms 防抖同步给 Sidecar（`sidecar/editorStateChanged`）。
 */
class EditorStateSync(
    private val project: Project,
    private val workbench: IdeaWorkbenchAdapter,
    private val onStateChanged: (EditorStateChangedParams) -> Unit,
) : Disposable {

    private val alarm = Alarm(Alarm.ThreadToUse.POOLED_THREAD, this)
    private var lastEditor: EditorSnapshot? = null
    private var lastDirty: List<String>? = null
    private var lastFocused: Boolean? = null

    fun install() {
        lastEditor = workbench.captureActiveEditor()
        lastDirty = workbench.captureDirtyFiles()
        lastFocused = workbench.isWindowFocused()

        val bus = project.messageBus.connect(this)
        bus.subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun selectionChanged(event: FileEditorManagerEvent) {
                    scheduleSync()
                }
            },
        )
        bus.subscribe(
            FileDocumentManagerListener.TOPIC,
            object : FileDocumentManagerListener {
                override fun fileContentReloaded(file: VirtualFile, document: com.intellij.openapi.editor.Document) {
                    scheduleSync()
                }

                override fun unsavedDocumentsDropped() {
                    scheduleSync()
                }
            },
        )

        val multicaster = EditorFactory.getInstance().eventMulticaster
        multicaster.addSelectionListener(
            object : SelectionListener {
                override fun selectionChanged(e: SelectionEvent) {
                    if (e.editor.project == project) scheduleSync()
                }
            },
            this,
        )
        multicaster.addCaretListener(
            object : CaretListener {
                override fun caretPositionChanged(event: CaretEvent) {
                    if (event.editor.project == project) scheduleSync()
                }
            },
            this,
        )
        multicaster.addDocumentListener(
            object : DocumentListener {
                override fun documentChanged(event: DocumentEvent) {
                    scheduleSync()
                }
            },
            this,
        )

        ApplicationManager.getApplication().invokeLater {
            val frame = WindowManager.getInstance().getFrame(project)
            frame?.addWindowFocusListener(
                object : WindowAdapter() {
                    override fun windowGainedFocus(e: WindowEvent?) = scheduleSync()
                    override fun windowLostFocus(e: WindowEvent?) = scheduleSync()
                },
            )
        }
    }

    private fun scheduleSync() {
        alarm.cancelAllRequests()
        alarm.addRequest({ emitDiff() }, 100)
    }

    @Synchronized
    private fun emitDiff() {
        if (project.isDisposed) return
        val editor = workbench.captureActiveEditor()
        val dirty = workbench.captureDirtyFiles()
        val focused = workbench.isWindowFocused()

        val editorChanged = editor != lastEditor
        val dirtyChanged = dirty != lastDirty
        val focusedChanged = focused != lastFocused

        if (!editorChanged && !dirtyChanged && !focusedChanged) return

        lastEditor = editor
        lastDirty = dirty
        lastFocused = focused

        onStateChanged(
            EditorStateChangedParams(
                activeEditor = editor,
                includeActiveEditor = editorChanged,
                dirtyFiles = if (dirtyChanged) dirty else null,
                windowFocused = if (focusedChanged) focused else null,
            ),
        )
    }

    override fun dispose() {
        alarm.cancelAllRequests()
    }
}
