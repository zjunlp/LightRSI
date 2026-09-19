# Claude Code

Claude Code integration uses a **local gateway + MCP** pattern. TokenPilot runs as a local Anthropic-compatible gateway that Claude Code routes through.

## Installation

```bash
corepack pnpm cleaner:install:claude-code
```

This command:
- Updates `~/.claude/settings.json` for local gateway routing
- Writes `~/.claude/tokenpilot.json`
- Registers the shared `tokenpilot_memory_fault_recover` MCP server in `~/.claude/.claude.json`
- Installs a `SessionStart` hook that auto-starts the local gateway on first use
- Preserves existing Claude files as `.tokenpilot.bak` backups
- Builds the shared CLI, recovery MCP, and selected adapter
- Installs the explicit Cleaner analysis, status, apply, and cancel skills

### Custom Paths

```bash
export CLAUDE_CODE_SETTINGS_PATH="/path/to/settings.json"
export CLAUDE_CODE_MCP_CONFIG_PATH="/path/to/.claude.json"
export TOKENPILOT_CLAUDE_CODE_CONFIG="/path/to/tokenpilot.json"
corepack pnpm cleaner:install:claude-code
```

## Expected Output

After install, these files are created or modified:

| File | Purpose |
| :-- | :-- |
| `~/.claude/settings.json` | Local gateway routing configuration |
| `~/.claude/tokenpilot.json` | TokenPilot plugin configuration |
| `~/.claude/.claude.json` | MCP server registration |
| Config backups | `*.tokenpilot.bak` alongside originals |

## Verification

```bash
lightrsi claude-code status
lightrsi claude-code doctor
```

Expected output:
- `plugin entry enabled`
- `config enabled`
- `mode normal`
- `stabilizer enabled`
- `reduction enabled`
- `proxy healthy: yes`

## First Run

1. Start Claude Code normally
2. Open a **new session** so `SessionStart` can auto-start the local gateway
3. In another terminal, verify:

```bash
lightrsi claude-code doctor
```

::: warning Gateway starts on first session Install success does not guarantee the gateway is already healthy before `SessionStart` fires. Open a new Claude Code session to trigger auto-start. :::

## Standalone CLI

Shared CLI commands:

```bash
lightrsi claude-code status
lightrsi claude-code report
lightrsi claude-code doctor
lightrsi claude-code visual
lightrsi claude-code session <session-id> report
lightrsi claude-code reduction status
lightrsi claude-code stabilizer target developer
lightrsi claude-code mode normal
lightrsi claude-code reduction mode balanced
lightrsi claude-code help
```

## Context Cleaner

Use the installed `lightrsi-clean` skill for analysis only, or open an interactive terminal and run:

```bash
lightrsi claude-code clean
```

The analysis skill must not choose or approve tasks for you. After reviewing the plan, explicitly approve selected task IDs and inspect the receipt:

```bash
lightrsi claude-code clean --plan <plan-id> --select <task-id-1>,<task-id-2>
lightrsi claude-code clean --status <plan-id>
lightrsi claude-code clean --cancel <plan-id>
```

Approval schedules an archived request overlay for a subsequent eligible request in the same session. `scheduled` does not mean `applied`, and cancellation cannot undo an applied clean. Manual Cleaner support does not imply support for OpenClaw's automatic eviction commands or `aggressive` mode.

See [Context Cleaner](/user-guide/context-cleaner) for protected tasks, usage accounting, and the full workflow.

## PATH Setup

The installer uses `~/.local/bin` by default on Linux/macOS. On Windows it creates `lightrsi.cmd` and `tokenpilot-claude-code.cmd`, using the npm command directory when it is already on `PATH`. `LIGHTRSI_BIN_DIR` can override the command directory.

On Linux/macOS, if `lightrsi` is not found after install:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Add to `~/.bashrc` or `~/.zshrc` to make permanent.

## Troubleshooting

For Cleaner snapshot, task-selection, or pending-plan issues, see [Context Cleaner troubleshooting](/user-guide/context-cleaner#troubleshooting).

See [TokenPilot Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting#claude-code) for Claude Code-specific issues.
