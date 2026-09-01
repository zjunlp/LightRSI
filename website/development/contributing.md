# Contributing

LightRSI is still moving quickly. The most useful contributions are usually:

- Host adapter fixes for real agent workflows
- Install and onboarding improvements
- Visual, report, and doctor usability improvements
- Benchmark reproduction fixes
- Tests that lock down real regressions

## Quick Start

Clone the repository and build the shared packages:

```bash
git clone https://github.com/zjunlp/LightRSI.git
cd LightRSI
corepack enable
pnpm install
pnpm build
pnpm typecheck
```

If you are changing the standalone CLI path, also run:

```bash
pnpm lightrsi:build
pnpm lightrsi:typecheck
pnpm lightrsi:test
```

## Before Opening a PR

- Keep changes scoped to one problem when possible.
- Add or update tests for behavior changes.
- Prefer real host-path verification over mock-only fixes.
- Avoid breaking the default first-run install path.

## Reporting Issues

When reporting a bug, include:

- **Host**: `OpenClaw`, `Codex`, `Claude Code`, or `DeepSeek Harness`
- **Install path**: Default or custom config path
- **Exact commands**: What you ran
- **Config**: Relevant config snippets (with sensitive values redacted)
- **Doctor / Status output**: Output from `lightrsi <host> doctor` and `lightrsi <host> status`
- **Logs**: Any relevant log output or screenshots for visual or runtime-specific issues

## Community

- Use [GitHub Issues](https://github.com/zjunlp/LightRSI/issues) for actionable bugs and feature requests.
- Use [Discord](https://discord.gg/gHdVfWz3) for setup help, debugging, and discussion.
