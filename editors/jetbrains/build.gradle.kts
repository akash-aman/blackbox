import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.24"
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        create(
            providers.gradleProperty("platformType").get(),
            providers.gradleProperty("platformVersion").get(),
        )
        // Optional: integrate with the JetBrains MCP Server plugin when present
        // (Option C in docs/implementation-plan.md). The plugin is loaded on demand
        // through plugin.xml's optional <depends>; we don't need it at compile time
        // because the integration code lives in a separate config-file-only module.

        instrumentationTools()
        testFramework(TestFrameworkType.Platform)
    }
    testImplementation("junit:junit:4.13.2")
}

intellijPlatform {
    pluginConfiguration {
        name = providers.gradleProperty("pluginName")
        version = providers.gradleProperty("pluginVersion")

        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            untilBuild = providers.gradleProperty("pluginUntilBuild").orNull
        }

        description = """
            Blackbox — AI-driven debugging via the Model Context Protocol.
            Set breakpoints, drive debug sessions, inspect variables, and navigate code
            from any MCP-compatible AI client (Cursor, Claude Desktop, etc.) or directly
            from the JetBrains AI Assistant.
        """.trimIndent()
    }

    publishing {
        token = providers.environmentVariable("JETBRAINS_MARKETPLACE_TOKEN")
    }

    pluginVerification {
        ides { recommended() }
    }
}

kotlin {
    jvmToolchain(providers.gradleProperty("javaVersion").get().toInt())
}

tasks {
    test { useJUnit() }
}
