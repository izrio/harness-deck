# Harness Deck — JetBrains IDE Plugin (`packages/jetbrains`)

IntelliJ Platform (2024.2+) plugin for IntelliJ IDEA, WebStorm, PyCharm, GoLand, Rider, and other JetBrains IDEs.

## Architecture

- **Frontend (`packages/webview-ui`)**: Rendered inside `JBCefBrowser`, served over an ephemeral loopback HTTP server (`127.0.0.1:0` with a per-session random URL token) and bridged via `JBCefJSQuery` (`window.__HARNESS_DECK_HOST__ = 'jetbrains'`).
- **Backend (`packages/extension/dist/sidecar.cjs`)**: Spawned as a managed Node.js (>= 20) child process per open project, communicating via NDJSON JSON-RPC 2.0 over stdin/stdout.
- **Shared Persistence (`~/.harness-deck/`)**: `settings.json`, `global-state.json`, and `workspaces/<hash>.json` are shared with VS Code and across JetBrains windows.
- **Secrets (`PasswordSafe`)**: Provider API keys are stored via IntelliJ `PasswordSafe` and never written in plaintext to `settings.json`.

## Build & Run

1. Build the shared Webview UI and Node.js Sidecar bundle from the repository root:

```bash
pnpm install
pnpm build
```

2. Build, test, or launch a sandbox IDE with the JetBrains plugin (requires JDK 21 and Gradle 8.11+):

```bash
cd packages/jetbrains
gradle test
gradle buildPlugin
gradle runIde
```
