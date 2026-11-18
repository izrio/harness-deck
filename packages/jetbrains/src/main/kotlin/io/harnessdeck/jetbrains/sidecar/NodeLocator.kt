package io.harnessdeck.jetbrains.sidecar

import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.util.SystemInfo
import com.intellij.util.EnvironmentUtil
import java.io.File
import java.net.JarURLConnection
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption

data class ExtractedBundleAssets(
    val sidecarEntry: Path,
    val webviewRoot: Path,
)

object NodeLocator {
    private val PLUGIN_ID = PluginId.getId("io.github.izrio.harnessdeck")

    fun pluginVersion(): String =
        PluginManagerCore.getPlugin(PLUGIN_ID)?.version ?: "0.4.0"

    fun findNodeExecutable(configuredPath: String?): String? {
        val candidates = linkedSetOf<String>()
        if (!configuredPath.isNullOrBlank()) {
            candidates += configuredPath.trim()
        }
        EnvironmentUtil.getValue("HARNESS_DECK_NODE_PATH")?.takeIf { it.isNotBlank() }?.let { candidates += it.trim() }

        val exeName = if (SystemInfo.isWindows) "node.exe" else "node"
        val envPath = EnvironmentUtil.getValue("PATH") ?: System.getenv("PATH") ?: ""
        envPath.split(File.pathSeparatorChar)
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .forEach { dir -> candidates += Paths.get(dir, exeName).toString() }

        val home = System.getProperty("user.home").orEmpty()
        if (SystemInfo.isWindows) {
            listOfNotNull(
                System.getenv("ProgramFiles"),
                System.getenv("LOCALAPPDATA"),
            ).forEach { base ->
                candidates += Paths.get(base, "nodejs", "node.exe").toString()
            }
            if (home.isNotEmpty()) {
                candidates += Paths.get(home, "AppData", "Local", "Volta", "bin", "node.exe").toString()
            }
        } else {
            candidates += listOf(
                "/opt/homebrew/bin/node",
                "/usr/local/bin/node",
                "/usr/bin/node",
            )
            if (home.isNotEmpty()) {
                candidates += Paths.get(home, ".volta", "bin", "node").toString()
                candidates += Paths.get(home, ".local", "bin", "node").toString()
                candidates += Paths.get(home, ".fnm", "aliases", "default", "bin", "node").toString()
                val nvmVersions = Paths.get(home, ".nvm", "versions", "node").toFile()
                if (nvmVersions.isDirectory) {
                    nvmVersions.listFiles()
                        ?.filter { it.isDirectory }
                        ?.sortedByDescending { it.name }
                        ?.forEach { verDir ->
                            candidates += Paths.get(verDir.absolutePath, "bin", "node").toString()
                        }
                }
            }
        }

        return candidates.firstOrNull { pathStr ->
            val file = File(pathStr)
            file.isFile && (SystemInfo.isWindows || file.canExecute())
        }
    }

    /**
     * 将插件内打包的 `harness-deck/sidecar.cjs` 与 `harness-deck/webview/` 目录下的文件解压到稳定版本目录，
     * 返回磁盘路径供 `node sidecar.cjs` 与嵌入式静态资源服务使用。
     */
    fun ensureBundledAssets(): ExtractedBundleAssets {
        val overrideDir = EnvironmentUtil.getValue("HARNESS_DECK_DIST_DIR")?.takeIf { it.isNotBlank() }
        if (overrideDir != null) {
            val base = Paths.get(overrideDir)
            val sidecar = base.resolve("sidecar.cjs")
            val webview = base.resolve("webview")
            if (Files.isRegularFile(sidecar) && Files.isDirectory(webview)) {
                return ExtractedBundleAssets(sidecar, webview)
            }
        }

        val version = pluginVersion()
        val targetRoot = Paths.get(PathManager.getSystemPath(), "harness-deck", version)
        val sidecarTarget = targetRoot.resolve("sidecar.cjs")
        val webviewTarget = targetRoot.resolve("webview")
        val marker = targetRoot.resolve(".extracted-$version")

        if (Files.isRegularFile(marker) && Files.isRegularFile(sidecarTarget) && Files.isDirectory(webviewTarget)) {
            return ExtractedBundleAssets(sidecarTarget, webviewTarget)
        }

        Files.createDirectories(targetRoot)
        extractResourcePrefix("harness-deck", targetRoot)
        Files.writeString(marker, version)
        return ExtractedBundleAssets(sidecarTarget, webviewTarget)
    }

    private fun extractResourcePrefix(resourcePrefix: String, destination: Path) {
        val classLoader = NodeLocator::class.java.classLoader
        val urls = classLoader.getResources(resourcePrefix)
        while (urls.hasMoreElements()) {
            val url = urls.nextElement()
            when (url.protocol) {
                "file" -> {
                    val srcDir = Paths.get(url.toURI())
                    copyDirectory(srcDir, destination)
                }
                "jar" -> {
                    val conn = url.openConnection() as JarURLConnection
                    val jarFile = conn.jarFile
                    val entryPrefix = "$resourcePrefix/"
                    val entries = jarFile.entries()
                    while (entries.hasMoreElements()) {
                        val entry = entries.nextElement()
                        if (entry.isDirectory || !entry.name.startsWith(entryPrefix)) continue
                        val rel = entry.name.removePrefix(entryPrefix)
                        if (rel.contains("..")) continue
                        val outPath = destination.resolve(rel).normalize()
                        if (!outPath.startsWith(destination)) continue
                        Files.createDirectories(outPath.parent)
                        jarFile.getInputStream(entry).use { input ->
                            Files.copy(input, outPath, StandardCopyOption.REPLACE_EXISTING)
                        }
                    }
                }
            }
        }
    }

    private fun copyDirectory(src: Path, dst: Path) {
        Files.walk(src).use { stream ->
            stream.forEach { path ->
                val rel = src.relativize(path)
                val target = dst.resolve(rel)
                if (Files.isDirectory(path)) {
                    Files.createDirectories(target)
                } else {
                    Files.createDirectories(target.parent)
                    Files.copy(path, target, StandardCopyOption.REPLACE_EXISTING)
                }
            }
        }
    }
}
