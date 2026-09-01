# Plugins

Plugins are **reusable agent capabilities** that run on the LightRSI platform. Each plugin provides one well-scoped capability — context management, memory, or future features — and works across all supported hosts.

## Plugin Model

A plugin is a self-contained package with:

| Component | Description |
| :-- | :-- |
| **Manifest** | Metadata: ID, version, compatible hosts, permissions needed |
| **Configuration schema** | Declares what settings the plugin accepts, with types and defaults |
| **Lifecycle hooks** | Functions called by the runtime at specific points (install, enable, disable, etc.) |
| **Runtime logic** | The actual behavior: intercepting messages, transforming context, managing state |

## Current Plugins

| Plugin | Capability | Status |
| :-- | :-- | :-- |
| [TokenPilot](/plugin-catalog/tokenpilot/overview) | Cache-aware context management | Stable |

TokenPilot currently provides full host integrations for OpenClaw, Codex, and Claude Code. A narrower DeepSeek Harness compatibility adapter is maintained separately.

## Next

- [Plugin Lifecycle](/platform-concepts/plugin-lifecycle) — the state machine
- [TokenPilot Overview](/plugin-catalog/tokenpilot/overview) — see a real plugin
- [Build Your First Plugin](/plugin-development/build-your-first-plugin) — start developing
