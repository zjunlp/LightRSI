# TokenPilot Overview

TokenPilot is the first official LightRSI plugin. It is a **cache-aware context runtime** that reduces token usage and cost in long-running agent sessions.

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

TokenPilot has three full host integrations, each with a different integration style. LightRSI also contains a separate DeepSeek Harness compatibility adapter; it is not included in the full TokenPilot feature table below.

| Host | Integration | Page |
| :-- | :-- | :-- |
| OpenClaw | Native plugin slot | [OpenClaw](/hosts/openclaw) |
| Codex CLI | Local proxy + hooks | [Codex](/hosts/codex) |
| Claude Code | Local gateway + MCP | [Claude Code](/hosts/claude-code) |

Features are consistent across hosts. Differences are documented on each host page.

## Quick Tour

- [Installation](/plugin-catalog/tokenpilot/installation) — get TokenPilot running
- [Configuration](/plugin-catalog/tokenpilot/configuration) — settings and defaults
- [Runtime Modes](/plugin-catalog/tokenpilot/runtime-modes) — conservative, normal, aggressive
- [Benchmarks](/plugin-catalog/tokenpilot/benchmarks) — evaluation results
- [Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting) — common problems and fixes
