# Install Your First Plugin

After [installing LightRSI](/getting-started/install-lightrsi), install a plugin to add capabilities. Currently, TokenPilot is the only official plugin.

## Install TokenPilot

Pick your host:

### OpenClaw

```bash
pnpm component:install:tokenpilot:openclaw
```

This command:
- Updates `~/.openclaw/openclaw.json`
- Enables the TokenPilot plugin
- Switches `plugins.slots.contextEngine` to `layered-context`
- Sets the default `normal` mode
- Attempts to restart the OpenClaw gateway

**Custom paths:**

```bash
export LIGHTRSI_OPENCLAW_HOME="/path/to/openclaw-home"
export OPENCLAW_CONFIG_PATH="/path/to/openclaw.json"
pnpm component:install:tokenpilot:openclaw
```

### Codex

```bash
corepack pnpm cleaner:install:codex
```

This command:
- Reroutes your active Codex provider through the local TokenPilot proxy
- Writes `~/.codex/tokenpilot.json`
- Registers hooks in `~/.codex/hooks.json`
- Registers the shared `tokenpilot_memory_fault_recover` MCP server
- Builds and installs the shared `lightrsi` CLI and the analysis-only `lightrsi-clean` skill

**Custom paths:**

```bash
export CODEX_CONFIG_PATH="/path/to/config.toml"
export CODEX_HOOKS_CONFIG_PATH="/path/to/hooks.json"
export TOKENPILOT_CODEX_CONFIG="/path/to/tokenpilot.json"
corepack pnpm cleaner:install:codex
```

### Claude Code

```bash
corepack pnpm cleaner:install:claude-code
```

This command:
- Updates `~/.claude/settings.json` for local gateway routing
- Writes `~/.claude/tokenpilot.json`
- Registers the shared `tokenpilot_memory_fault_recover` MCP server
- Installs a `SessionStart` hook that auto-starts the gateway
- Backs up existing Claude files as `.tokenpilot.bak`
- Builds and installs the shared `lightrsi` CLI and the analysis-only `lightrsi-clean` skill

**Custom paths:**

```bash
export CLAUDE_CODE_SETTINGS_PATH="/path/to/settings.json"
export CLAUDE_CODE_MCP_CONFIG_PATH="/path/to/.claude.json"
export TOKENPILOT_CLAUDE_CODE_CONFIG="/path/to/tokenpilot.json"
corepack pnpm cleaner:install:claude-code
```

## Verify Installation

```bash
lightrsi doctor
```

Or check per-host:

```bash
lightrsi openclaw doctor
lightrsi codex doctor
lightrsi claude-code doctor
lightrsi codex clean --help
lightrsi claude-code clean --help
```

Look for: `plugin entry enabled`, `config enabled`, `proxy healthy: yes`.

## What Changed

The installer modifies these files (backups saved as `.tokenpilot.bak`):

| Host | Files Modified |
| :-- | :-- |
| OpenClaw | `~/.openclaw/openclaw.json` |
| Codex | `~/.codex/tokenpilot.json`, `~/.codex/hooks.json` |
| Claude Code | `~/.claude/settings.json`, `~/.claude/tokenpilot.json`, `~/.claude/.claude.json` |

## Next

- [Runtime Modes](/plugin-catalog/tokenpilot/runtime-modes) — choose your risk/aggressiveness level
- [CLI Reference](/user-guide/cli-reference) — all available commands
- [Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting) — common install issues
