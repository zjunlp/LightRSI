# Plugins

The current LightRSI architecture separates reusable feature packages, presets, host adapters, and user-facing products. The word **plugin** also appears in host installation commands, where it refers to a host's native integration mechanism.

## Packages, Presets, and Products {#plugin-model}

These layers have different responsibilities:

| Layer | Description |
| :-- | :-- |
| **Shared packages** | Foundation infrastructure and composable features such as stabilization, reduction, and eviction |
| **Presets** | Verified feature combinations, including TokenPilot |
| **Host adapters** | Host discovery, installation, runtime hooks, and product registration |
| **Products** | User-facing workflows and surfaces, including Context Cleaner, the shared CLI, and MCP interfaces |

## TokenPilot and Context Cleaner {#current-plugins}

| Name | Type | Role |
| :-- | :-- | :-- |
| [TokenPilot](/plugin-catalog/tokenpilot/overview) | Preset | Composes cache-aware context-management policies |
| [Context Cleaner](/user-guide/context-cleaner) | Product | Presents tasks and recommendations, takes explicit approval, and reports cleanup status |

Cleaner reuses shared task lifecycle and host rewrite capabilities. Its public workflow is available for OpenClaw, Codex, and Claude Code; DeepSeek Harness does not currently expose a public Cleaner entrypoint.

## Native Host Plugins

TokenPilot integrates with OpenClaw, Codex, Claude Code, and [DeepSeek Harness](/hosts/deepseek-harness). OpenClaw uses a native plugin slot; Harness uses a native Cordis plugin for optional context eviction and session status. Codex uses a local proxy and hooks, while Claude Code uses a local gateway and MCP.

These integration mechanisms do not make every product or feature available on every host. See [Host Compatibility](/hosts/compatibility) for the supported combinations.

## Next

- [Plugin Lifecycle](/platform-concepts/plugin-lifecycle) — the state machine
- [TokenPilot Overview](/plugin-catalog/tokenpilot/overview) — explore the preset
- [Context Cleaner](/user-guide/context-cleaner) — use the cleanup product
- [Build Your First Plugin](/plugin-development/build-your-first-plugin) — start developing
