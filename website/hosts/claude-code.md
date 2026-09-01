# Claude Code

Claude Code integration uses a **local gateway + MCP** pattern. TokenPilot runs as a local Anthropic-compatible gateway that Claude Code routes through.

## Installation

```bash
npm --prefix components/adapters/claude-code run build
npm --prefix components/adapters/claude-code run install:claude-code
```

This command:
- Updates `~/.claude/settings.json` for local gateway routing
- Writes `~/.claude/tokenpilot.json`
- Registers the shared `tokenpilot_memory_fault_recover` MCP server in `~/.claude/.claude.json`
- Installs a `SessionStart` hook that auto-starts the local gateway on first use
- Preserves existing Claude files as `.tokenpilot.bak` backups

### Custom Paths

```bash
export CLAUDE_CODE_SETTINGS_PATH="/path/to/settings.json"
export CLAUDE_CODE_MCP_CONFIG_PATH="/path/to/.claude.json"
export TOKENPILOT_CLAUDE_CODE_CONFIG="/path/to/tokenpilot.json"
npm --prefix components/adapters/claude-code run build
npm --prefix components/adapters/claude-code run install:claude-code
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

All commands use the standalone CLI:

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

## PATH Setup

If `lightrsi` is not found after install:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Add to `~/.bashrc` or `~/.zshrc` to make permanent.

## Troubleshooting

See [TokenPilot Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting#claude-code) for Claude Code-specific issues.
