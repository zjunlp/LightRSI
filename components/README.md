# Components

This directory contains the shared packages, feature modules, presets, products, and host adapters that make up LightRSI.

The current public repository ships one component:

| Component | Status | Role | Docs |
| :-- | :-- | :-- | :-- |
| `TokenPilot` | public | Preset combining Stabilizer, Reduction, and Eviction | [presets/tokenpilot/README.md](./presets/tokenpilot/README.md) |

## Component And Adapter Split

LightRSI separates:

- component packages
  - reusable runtime logic
  - state and policy layers
  - host-agnostic contracts
- host adapters
  - installation and bootstrap
  - transcript/session bridging
  - host-specific command and hook surfaces

This layout is meant to let a single component support multiple agent hosts over time.

TokenPilot is represented by `presets/tokenpilot/`; it no longer owns the shared packages, adapters, or products. Adapters explicitly bind the preset and declare which TokenPilot features they support. Products discover host state through adapter-provided registrations rather than a second hardcoded host map.

## How To Read This Directory

Use the root [README.md](../README.md) first if you want the fastest path to:

- install the repo
- install the current component
- verify the runtime path in a real session

Use a preset subtree when you need product-specific material such as:

- command surface
- package layout
- configuration details
- runtime state layout
- debugging notes
- links to benchmark-specific reproduction docs maintained in the separate TokenPilot experiment repository

## Current Layout

```text
components/
├── packages/
│   ├── foundation/
│   │   ├── kernel/
│   │   ├── runtime-core/
│   │   ├── host-adapter/
│   │   ├── history/
│   │   ├── artifact-store/
│   │   └── product-surface/
│   └── features/
│       ├── stabilizer/
│       ├── reduction/
│       ├── eviction/
│       ├── cleaner/
│       └── memory/
├── presets/
│   └── tokenpilot/
├── adapters/
│   ├── openclaw/
│   ├── codex/
│   ├── claude-code/
│   └── deepseek-harness/
└── products/
    ├── cli/
    └── mcp/
```

Current preset bindings:

| Host | TokenPilot feature support |
| :-- | :-- |
| OpenClaw | Stabilizer, Reduction, Eviction |
| Codex | Stabilizer, Reduction, Eviction |
| Claude Code | Stabilizer, Reduction |

## Naming Boundary

At the repository level, the framework name is `LightRSI`.

Workspace npm packages use the `@lightrsi` scope:

| Layer | Package identities |
| :-- | :-- |
| Foundation | `@lightrsi/kernel`, `@lightrsi/runtime-core`, `@lightrsi/host-adapter`, `@lightrsi/history`, `@lightrsi/artifact-store`, `@lightrsi/product-surface` |
| Features | `@lightrsi/stabilizer`, `@lightrsi/reduction`, `@lightrsi/eviction`, `@lightrsi/cleaner`, `@lightrsi/memory` |
| Preset | `@lightrsi/tokenpilot` |
| Products | `@lightrsi/cli`, `@lightrsi/mcp` |
| Adapters | `@lightrsi/openclaw-adapter`, `@lightrsi/codex-adapter`, `@lightrsi/claude-code-adapter` |
| Compatibility adapter | `@lightrsi/deepseek-harness-adapter` |

These names define workspace ownership. They do not imply that every internal package is independently published; release entrypoints and their public export contracts are versioned separately.

Source ownership follows the same boundary:

- foundation packages expose product-neutral contracts such as
  `ProductSurfaceHostBridge`, `StatePathResolver`, and `HostIdentity`
- presets own branded composition and presentation identity; TokenPilot owns
  its display name, `/tokenpilot` command, and compatibility aliases
- adapters own host-specific compatibility paths and environment bridges

At the current runtime-compatibility layer, the shipped component still uses the established `tokenpilot` namespace for plugin id and persisted state. On OpenClaw, the current public session model prefix is `lightrsi/<model>`, while Codex CLI and Claude Code use the standalone `lightrsi <host> ...` command surface. That boundary is intentional for now so the repo can move toward a multi-component layout without breaking the current working paths.
