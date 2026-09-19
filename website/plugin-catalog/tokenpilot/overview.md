# TokenPilot Overview

TokenPilot is LightRSI's first **context-management preset**. It composes cache-aware context policies for long-running agent sessions, with the goal of reducing token usage and cost.

[Context Cleaner](/user-guide/context-cleaner) is the user-facing product for reviewing tasks and approving a specific cleanup. It reuses shared task and host rewrite capabilities; its interactive workflow is distinct from TokenPilot's automatic runtime policies.

## What TokenPilot Does

Agent sessions grow. Every turn adds more messages, more tool outputs, more context. The model sees all of it, and you pay for all of it. Much of that context is repetitive — identical prefixes sent every turn, bloated tool outputs, stale history.

TokenPilot addresses this with three techniques:

```text
┌─────────────────────────────────────────────────────┐
│                 TokenPilot Pipeline                   │
├─────────────────────────────────────────────────────┤
│  1. Stable Prefix                                    │
│     Rewrites context into cache-stable form           │
│     → Higher cache hit rate                          │
├─────────────────────────────────────────────────────┤
│  2. Context Reduction                                │
│     Trims oversized tool output before it pollutes   │
│     → Leaner context per turn                        │
├─────────────────────────────────────────────────────┤
│  3. Context Eviction                                 │
│     Limits how much old context is carried forward   │
│     → Sessions don't grow unbounded                  │
└─────────────────────────────────────────────────────┘
```

## Evaluation

TokenPilot is evaluated on PinchBench and Claw-Eval in isolated and continuous modes. Benchmark tasks, runners, configurations, and current results are maintained in the separate [TokenPilot experiment repository](https://github.com/Xubqpanda/TokenPilot); see [Benchmarks](/plugin-catalog/tokenpilot/benchmarks) for the reproduction entrypoint.

## Supported Hosts

TokenPilot integrates with four hosts. DeepSeek Harness uses a native Cordis plugin for optional context eviction and session status; its setup and capabilities differ from the other adapters.

| Host | Integration | Page |
| :-- | :-- | :-- |
| OpenClaw | Native plugin slot | [OpenClaw](/hosts/openclaw) |
| Codex CLI | Local proxy + hooks | [Codex](/hosts/codex) |
| Claude Code | Local gateway + MCP | [Claude Code](/hosts/claude-code) |
| DeepSeek Harness | Native Cordis plugin | [DeepSeek Harness](/hosts/deepseek-harness) |

Feature availability varies by host. See [Host Compatibility](/hosts/compatibility) and each host's setup guide before choosing configuration or commands.

## Quick Tour

- [Installation](/plugin-catalog/tokenpilot/installation) — get TokenPilot running
- [Configuration](/plugin-catalog/tokenpilot/configuration) — settings and defaults
- [Runtime Modes](/plugin-catalog/tokenpilot/runtime-modes) — conservative, normal, aggressive
- [Benchmarks](/plugin-catalog/tokenpilot/benchmarks) — evaluation results
- [Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting) — common problems and fixes
