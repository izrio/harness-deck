import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.2.1"
}

group = "io.harnessdeck"
version = "0.5.2"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    implementation("com.google.code.gson:gson:2.11.0")
    testImplementation(kotlin("test"))
    testImplementation("junit:junit:4.13.2")

    intellijPlatform {
        intellijIdeaCommunity("2024.2.5")
        bundledPlugin("org.jetbrains.plugins.terminal")
        instrumentationTools()
        testFramework(TestFrameworkType.Platform)
    }
}

kotlin {
    jvmToolchain(21)
}

val extensionDistDir = layout.projectDirectory.dir("../extension/dist")
val generatedAssetsDir = layout.buildDirectory.dir("generated-assets")

val syncBundleAssets by tasks.registering(Sync::class) {
    from(extensionDistDir.file("sidecar.cjs")) {
        into("harness-deck")
    }
    from(extensionDistDir.dir("webview")) {
        into("harness-deck/webview")
    }
    into(generatedAssetsDir)
}

sourceSets {
    main {
        resources.srcDir(syncBundleAssets)
    }
}

tasks.named("processResources") {
    dependsOn(syncBundleAssets)
}

intellijPlatform {
    pluginConfiguration {
        id = "io.github.izrio.harnessdeck"
        name = "Harness Deck"
        version = project.version.toString()
        description = """
            Multi-backend AI coding agent deck for JetBrains IDEs (IntelliJ IDEA, WebStorm, PyCharm, GoLand, Rider, etc.):
            native DeepSeek (dsh), Claude Code, Pi, ZCode, and ACP agents (CodeBuddy, OpenCode, custom agents),
            with Workbench (Overview, Schedules, Agents, Kanban Tasks, Cross-project Sessions), Skills, MCP & Providers.
        """.trimIndent()
        vendor {
            name = "izrio"
        }
        ideaVersion {
            sinceBuild = "242"
            untilBuild = provider { null }
        }
    }
}

tasks.test {
    useJUnit()
}
