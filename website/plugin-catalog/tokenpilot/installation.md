# TokenPilot Installation

TokenPilot is installed as part of [installing your first plugin](/getting-started/install-first-plugin). This page covers TokenPilot-specific details.

## Prerequisites

Before installing TokenPilot, complete [Install LightRSI](/getting-started/install-lightrsi).

## Install Commands

::: code-group
```bash [OpenClaw]
pnpm component:install:tokenpilot:openclaw
```

```bash [Codex]
npm --prefix components/adapters/codex run build
npm --prefix components/adapters/codex run install:codex
```

```bash [Claude Code]
npm --prefix components/adapters/claude-code run build
npm --prefix components/adapters/claude-code run install:claude-code
```
:::

## What the Installer Does

1. **Builds the adapter** for your host
2. **Updates host configuration** files with TokenPilot settings
3. **Enables the plugin** (sets `enabled: true`)
4. **Sets default mode** to `normal`
5. **Registers hooks/MCP/proxy** needed for runtime operation
6. **Creates backups** of modified files as `.tokenpilot.bak`

## Verify Installation

Run the doctor command for your host:

```bash
lightrsi openclaw doctor
lightrsi codex doctor
lightrsi claude-code doctor
```

All three should report:
- `plugin entry enabled`
- `config enabled`
- `mode normal`
- `stabilizer enabled`
- `reduction enabled`

For Codex and Claude Code, also check:
- `proxy healthy: yes`

## Install with Custom Paths

If your host files are not in the default locations, set environment variables before running the install command. See [Install Your First Plugin](/getting-started/install-first-plugin) for the full list.

## Failed Install?

Check [Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting) for common install problems. If install fails, your original config files are safe — the installer backs up everything before making changes.

### Quick recovery

```bash
# Restore from backups
cp ~/.openclaw/openclaw.json.tokenpilot.bak ~/.openclaw/openclaw.json
cp ~/.claude/settings.json.tokenpilot.bak ~/.claude/settings.json
# etc.
```

## Next

- [Configuration](/plugin-catalog/tokenpilot/configuration) — tune TokenPilot settings
- [Quick Start](/getting-started/quick-start) — start using TokenPilot
