# Plugin Catalog

This catalog introduces LightRSI's context-management preset and user-facing cleanup product. Host adapters provide their installation and runtime integration; availability differs by host.

## TokenPilot Preset {#available-plugins}

| Preset | Capability | Status | Hosts |
| :-- | :-- | :-- | :-- |
| [TokenPilot](./tokenpilot/overview) | Cache-aware context management | <span class="badge-stable">Stable</span> | OpenClaw, Codex, Claude Code, DeepSeek Harness |

[DeepSeek Harness](/hosts/deepseek-harness) provides a native Cordis integration with opt-in context eviction and session status. Capabilities vary by host; see [Host Compatibility](/hosts/compatibility).

## Context Cleaner Product

[Context Cleaner](/user-guide/context-cleaner) provides an inspect, select, approve, and verify workflow for task-level cleanup. It reuses shared task and host rewrite capabilities. It is a user-facing product, while TokenPilot is a preset of context-management policies.

Public Cleaner entrypoints are available for OpenClaw, Codex, and Claude Code. DeepSeek Harness currently exposes automatic eviction and session status, but no public Cleaner workflow. See [Cleaner host support](/user-guide/context-cleaner#supported-hosts).

## Host Plugins and Adapters

OpenClaw's native plugin and DeepSeek Harness's Cordis plugin are host integration mechanisms. Codex uses a local proxy and hooks; Claude Code uses a local gateway and MCP. Installing an adapter does not imply that every preset capability or product entrypoint is available on that host.

## Status Badges {#plugin-statuses}

| Badge | Meaning |
| :-- | :-- |
| <span class="badge-stable">Stable</span> | Identifies the established capability described on the page; host-specific support and limitations still apply |
| <span class="badge-experimental">Experimental</span> | Identifies work in progress whose behavior and interfaces may change |

These labels do not guarantee identical support across hosts or a frozen API.
