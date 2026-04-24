# Blackbox — JetBrains Plugin

> **Status**: Planned

JetBrains IDE plugin (IntelliJ, PhpStorm, WebStorm, PyCharm, GoLand) implementing the Blackbox tool contract.

## Architecture

- **Language**: Kotlin
- **Build**: Gradle + IntelliJ Platform Plugin
- **Debug APIs**: `XDebuggerManager`, `XBreakpointManager`, `XDebugSession`
- **Editor APIs**: `FileEditorManager`, `PsiFile`
- **Workspace APIs**: `ProjectFileIndex`, `InspectionManager`
- **MCP Transport**: JetBrains native MCP support or custom stdio bridge

## Tool Contract

All tools must match the schemas defined in [`/schema/tools.json`](../../schema/tools.json).
