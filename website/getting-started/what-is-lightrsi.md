# What is LightRSI

LightRSI is a **modular runtime for recursive improvement in long-running LLM agents**. It provides the shared lifecycle, state, safety, observability, and host integration needed to build an improvement capability once and run it across OpenClaw, Codex, Claude Code, and future hosts. The current implementation focuses on context and agentic memory.

## Platform, Preset, and Product {#lightrsi-vs-tokenpilot}

LightRSI, TokenPilot, and Context Cleaner describe different parts of the system:

| Name | Type | Role |
| :-- | :-- | :-- |
| LightRSI | Runtime and platform | Shared lifecycle, state, safety, observability, and host integration |
| TokenPilot | Context-management preset | Composes stable-prefix, reduction, and eviction capabilities |
| Context Cleaner | User-facing product | Lets users inspect tasks, approve a selection, and check the cleanup result |

Host adapters connect these capabilities to OpenClaw, Codex, Claude Code, and DeepSeek Harness. Some integrations are installed as native host plugins; supported features and product entrypoints vary by host.

## Context Cleaner

[Context Cleaner](/user-guide/context-cleaner) is LightRSI's product for user-approved context cleanup. It groups session context by task, presents recommendations and protected content, and applies only an explicitly selected clean. TokenPilot supplies reusable context-management policies; Cleaner provides an interactive workflow on top of the shared task and host rewrite capabilities.

Available user entrypoints and apply timing differ by host. See the [Cleaner host table](/user-guide/context-cleaner#supported-hosts) before following the workflow.

## What Problems It Solves

- **Long sessions get expensive**. As agent sessions grow, every turn carries more context, which means more tokens and higher costs.
- **Context is repetitive**. Much of what gets sent to the model each turn is identical to the previous turn — wasteful if not cached.
- **Tool output is noisy**. Large tool responses can pollute future turns with irrelevant data.
- **Sessions don't prune themselves**. Without eviction, old context accumulates until sessions hit limits or become too slow.

LightRSI provides shared infrastructure for these capabilities. TokenPilot, its first preset, composes stable-prefix rewriting, context reduction, and lifecycle-aware eviction.

## What It Doesn't Solve

- **Short, single-turn interactions**. If your sessions are always one-shot, there is nothing for caching or eviction to optimize.
- **Model quality or accuracy**. LightRSI doesn't change model behavior — it changes what context gets sent to the model.
- **All memory problems**. Long-term memory is an experimental feature area; TokenPilot focuses on the current session's context window.

## Relationship to the Paper

The [TokenPilot paper](https://arxiv.org/abs/2606.17016) describes the cache-efficient context management technique. TokenPilot is LightRSI's first preset.

## Next Steps

- [Quick Start](/getting-started/quick-start) — get running in under 5 minutes
- [Core Concepts](/platform-concepts/core-runtime) — understand the platform architecture
- [TokenPilot Overview](/plugin-catalog/tokenpilot/overview) — explore the context-management preset
- [Context Cleaner](/user-guide/context-cleaner) — review and approve task-level cleanup
