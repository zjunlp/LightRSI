# Core Runtime

The LightRSI core runtime is the **host-independent execution engine** that loads, manages, and runs plugins. It sits between the agent host and the plugins, providing a consistent environment regardless of which host the user is running.

## Responsibilities

| Responsibility | Description |
| :-- | :-- |
| **Plugin loading** | Discovers, validates, and loads plugins from configured directories |
| **Lifecycle management** | Calls plugin hooks at the right time: install, enable, session start, session end, disable, uninstall |
| **Configuration** | Merges host config, plugin config, and user overrides into a resolved configuration |
| **Event routing** | Dispatches host events (messages, tool calls, session state changes) to plugins |
| **Resource isolation** | Ensures plugins cannot interfere with each other or the host |

## Current Implementation

The core runtime is implemented across these workspace packages:

| Package | Purpose |
| :-- | :-- |
| `components/packages/foundation/kernel` | Shared types, interfaces, events, and runtime contracts |
| `components/packages/foundation/runtime-core` | Host-agnostic runtime engine and shared execution logic |
| `components/packages/foundation/host-adapter` | Shared host-adapter contracts and path-resolution interfaces |
| `components/packages/foundation/history` | Canonical state, raw semantic turns, task registry |
| `components/packages/features/eviction` | Policy analysis, reduction/eviction decisions, estimator |
| `components/packages/features/memory` <span class="badge-experimental">experimental</span> | Distillation and retrieval (in progress) |

## Next

- [Plugins](/platform-concepts/plugins) — how plugins are structured
- [Plugin Lifecycle](/platform-concepts/plugin-lifecycle) — the plugin state machine
- [Host Adapters](/platform-concepts/host-adapters) — how hosts connect
