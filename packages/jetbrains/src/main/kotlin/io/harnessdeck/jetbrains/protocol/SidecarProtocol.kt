package io.harnessdeck.jetbrains.protocol

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonElement
import com.google.gson.JsonObject

object SidecarGson {
    val instance: Gson = GsonBuilder()
        .disableHtmlEscaping()
        .create()
}

data class EditorSelection(
    val startLine: Int,
    val endLine: Int,
    val text: String,
    val diagnostics: List<String> = emptyList(),
)

data class EditorSnapshot(
    val path: String,
    val languageId: String,
    val selection: EditorSelection? = null,
)

data class WorkspaceFolderItem(
    val name: String,
    val path: String,
)

data class SidecarInitParams(
    val projectPath: String,
    val workspaceFolders: List<WorkspaceFolderItem>,
    val ideLanguage: String,
    val workspaceTrusted: Boolean,
    val windowFocused: Boolean,
    val httpProxy: String? = null,
    val extensionVersion: String = "0.4.0",
    val configRoot: String? = null,
    val activeEditor: EditorSnapshot? = null,
    val dirtyFiles: List<String>? = null,
)

data class EditorStateChangedParams(
    val activeEditor: EditorSnapshot? = null,
    val includeActiveEditor: Boolean = false,
    val dirtyFiles: List<String>? = null,
    val windowFocused: Boolean? = null,
    val workspaceTrusted: Boolean? = null,
    val workspaceFolders: List<WorkspaceFolderItem>? = null,
    val httpProxy: String? = null,
    val includeHttpProxy: Boolean = false,
) {
    fun toJsonObject(gson: Gson = SidecarGson.instance): JsonObject {
        val obj = JsonObject()
        if (includeActiveEditor) {
            obj.add("activeEditor", if (activeEditor != null) gson.toJsonTree(activeEditor) else com.google.gson.JsonNull.INSTANCE)
        }
        if (dirtyFiles != null) {
            obj.add("dirtyFiles", gson.toJsonTree(dirtyFiles))
        }
        if (windowFocused != null) {
            obj.addProperty("windowFocused", windowFocused)
        }
        if (workspaceTrusted != null) {
            obj.addProperty("workspaceTrusted", workspaceTrusted)
        }
        if (workspaceFolders != null) {
            obj.add("workspaceFolders", gson.toJsonTree(workspaceFolders))
        }
        if (includeHttpProxy) {
            if (httpProxy != null) obj.addProperty("httpProxy", httpProxy)
            else obj.add("httpProxy", com.google.gson.JsonNull.INSTANCE)
        }
        return obj
    }
}

sealed interface DiffSideSpec {
    val path: String

    data class Disk(override val path: String) : DiffSideSpec
    data class Virtual(
        override val path: String,
        val label: String,
        val content: String,
    ) : DiffSideSpec
}

sealed interface ResolvedDiffSpec {
    val path: String

    data class Pair(
        override val path: String,
        val title: String,
        val left: DiffSideSpec,
        val right: DiffSideSpec,
    ) : ResolvedDiffSpec

    data class Unified(
        override val path: String,
        val patchText: String,
    ) : ResolvedDiffSpec

    data class CannotPreview(
        override val path: String,
        val message: String,
    ) : ResolvedDiffSpec

    companion object {
        fun fromJson(obj: JsonObject): ResolvedDiffSpec {
            val kind = obj.get("kind")?.asString.orEmpty()
            val path = obj.get("path")?.asString.orEmpty()
            return when (kind) {
                "pair" -> Pair(
                    path = path,
                    title = obj.get("title")?.asString ?: path,
                    left = parseSide(obj.getAsJsonObject("left")),
                    right = parseSide(obj.getAsJsonObject("right")),
                )
                "unified" -> Unified(
                    path = path,
                    patchText = obj.get("patchText")?.asString.orEmpty(),
                )
                else -> CannotPreview(
                    path = path,
                    message = obj.get("message")?.asString.orEmpty(),
                )
            }
        }

        private fun parseSide(obj: JsonObject): DiffSideSpec {
            val kind = obj.get("kind")?.asString.orEmpty()
            val path = obj.get("path")?.asString.orEmpty()
            return if (kind == "disk") {
                DiffSideSpec.Disk(path = path)
            } else {
                DiffSideSpec.Virtual(
                    path = path,
                    label = obj.get("label")?.asString.orEmpty(),
                    content = obj.get("content")?.asString.orEmpty(),
                )
            }
        }
    }
}

data class QuickPickOption(
    val id: String,
    val label: String,
    val description: String? = null,
    val detail: String? = null,
    val picked: Boolean? = null,
)

data class OpenDialogOptions(
    val canSelectFiles: Boolean,
    val canSelectFolders: Boolean,
    val canSelectMany: Boolean,
    val defaultPath: String? = null,
    val title: String,
    val filters: Map<String, List<String>>? = null,
)

data class FileCandidate(
    val path: String,
    val kind: String,
)

data class RemoteStatusBarInfo(
    val enabled: Boolean,
    val running: Boolean,
    val connectedClients: Int,
)

data class StatusBarSnapshot(
    val backendName: String,
    val statusKind: String,
    val modelLabel: String? = null,
    val remote: RemoteStatusBarInfo? = null,
) {
    companion object {
        fun fromJson(obj: JsonObject): StatusBarSnapshot {
            val statusObj = obj.getAsJsonObject("status")
            val remoteObj = obj.getAsJsonObject("remote")
            val remoteInfo = if (remoteObj != null) {
                RemoteStatusBarInfo(
                    enabled = remoteObj.get("enabled")?.asBoolean == true,
                    running = remoteObj.get("running")?.asBoolean == true,
                    connectedClients = remoteObj.get("connectedClients")?.asInt ?: 0,
                )
            } else {
                null
            }
            return StatusBarSnapshot(
                backendName = obj.get("backendName")?.asString ?: "Halo",
                statusKind = statusObj?.get("kind")?.asString ?: "idle",
                modelLabel = obj.get("modelLabel")?.takeIf { !it.isJsonNull }?.asString,
                remote = remoteInfo,
            )
        }
    }
}

data class InputPromptOptions(
    val title: String,
    val prompt: String? = null,
    val value: String? = null,
    val placeHolder: String? = null,
    val password: Boolean = false,
    val allowEmpty: Boolean = false,
)

data class LineRange(
    val startLine: Int,
    val endLine: Int? = null,
)

fun JsonElement?.asStringOrNull(): String? =
    if (this == null || this.isJsonNull) null else this.asString
