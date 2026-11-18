package io.harnessdeck.jetbrains.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

@Service(Service.Level.APP)
@State(
    name = "HarnessDeckAppSettings",
    storages = [Storage("harnessDeck.xml")],
)
class HarnessDeckAppSettings : PersistentStateComponent<HarnessDeckAppSettings.State> {
    data class State(
        var nodeExecutablePath: String = "",
    )

    private var state = State()

    override fun getState(): State = state

    override fun loadState(state: State) {
        this.state = state
    }

    var nodeExecutablePath: String
        get() = state.nodeExecutablePath
        set(value) {
            state.nodeExecutablePath = value.trim()
        }

    companion object {
        fun getInstance(): HarnessDeckAppSettings =
            ApplicationManager.getApplication().getService(HarnessDeckAppSettings::class.java)
    }
}
