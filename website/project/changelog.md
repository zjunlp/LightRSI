# Changelog

## Context Cleaner (2026-09-16)

- User-approved task-level context cleaning is available through [Context Cleaner](/user-guide/context-cleaner).
- OpenClaw supports immediate canonical apply; Codex and Claude Code schedule approved selections for a subsequent eligible request.
- Plans expose protected tasks and accounting; receipts distinguish analysis, scheduling, and application.
- Codex offers a terminal selector and a host-rendered MCP form. Claude Code's analysis skill leaves task selection and approval to the user.

## DeepSeek Harness Support (2026-09-16)

- TokenPilot is available as the native `tokenpilot-dsh` Cordis plugin.
- Opt-in context eviction uses task-state estimation and persistent task state, running before native Harness compaction by default.
- `/tokenpilot-status` reports estimator activity, candidate work, application evidence, and deferrals without starting a model turn.
- See [DeepSeek Harness](/hosts/deepseek-harness) for installation and configuration.

## v0.1.0 (2026-06-28)

- **Initial release** of LightRSI platform and TokenPilot plugin
- TokenPilot support for **OpenClaw** (native plugin)
- TokenPilot support for **Codex CLI** (local proxy + hooks)
- TokenPilot support for **Claude Code** (local gateway + MCP)
- Stable prefix, context reduction, and context eviction subsystems
- `lightrsi` standalone CLI
- Visual inspector (browser-based dashboard)
- Benchmark reproduction moved to the separate [TokenPilot experiment repository](https://github.com/Xubqpanda/TokenPilot)
- [TokenPilot paper](https://arxiv.org/abs/2606.17016) published

## Next

- [Changelog](/project/changelog) — what's coming
- [GitHub Releases](https://github.com/zjunlp/LightRSI/releases)
