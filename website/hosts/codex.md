# Codex CLI

Codex CLI integration uses a **local proxy + hooks** pattern. TokenPilot runs as a sidecar proxy that intercepts requests between Codex and the model API.

## Installation

```bash
corepack pnpm cleaner:install:codex
```

This command:
- Keeps your current active Codex provider name
- Reroutes that provider through the local TokenPilot proxy
- Writes `~/.codex/tokenpilot.json`
- Registers hooks in `~/.codex/hooks.json`
- Builds the shared CLI, recovery MCP, and Codex adapter
- Registers `tokenpilot_memory_fault_recover` and `lightrsi_cleaner` MCP servers
- Installs the explicit Cleaner analysis, status, apply, and cancel skills
- Installs the CLI and Cleaner terminal launcher (see PATH Setup below)

### Custom Paths

```bash
export CODEX_CONFIG_PATH="/path/to/config.toml"
export CODEX_HOOKS_CONFIG_PATH="/path/to/hooks.json"
export TOKENPILOT_CODEX_CONFIG="/path/to/tokenpilot.json"
corepack pnpm cleaner:install:codex
```

## Expected Output

After install, these files are created or modified:

| File | Purpose |
| :-- | :-- |
| `~/.codex/tokenpilot.json` | TokenPilot plugin configuration |
| `~/.codex/hooks.json` | SessionStart and other hook registrations |
| Config backups | `*.tokenpilot.bak` alongside originals |

## Verification

```bash
lightrsi codex status
lightrsi codex doctor
```

Expected output:
- `plugin entry enabled`
- `config enabled`
- `mode normal`
- `stabilizer enabled`
- `reduction enabled`
- `proxy healthy: yes`

## First Run

1. Start Codex normally
2. If Codex asks you to review or trust the installed TokenPilot hooks, **approve them**
3. Open a **new session** so `SessionStart` can start the local proxy
4. In another terminal, verify:

```bash
lightrsi codex doctor
```

::: warning Proxy may not start before first trusted session Install success does not guarantee the proxy is already running. If `doctor` still reports `proxy healthy: no` after trusting hooks and opening a new Codex session, use the manual fallback:
```bash
tokenpilot-codex status
tokenpilot-codex start
```
:::

## Standalone CLI

Shared CLI commands:

```bash
lightrsi codex status
lightrsi codex report
lightrsi codex doctor
lightrsi codex visual
lightrsi codex session <session-id> report
lightrsi codex reduction status
lightrsi codex stabilizer target developer
lightrsi codex mode normal
lightrsi codex reduction mode balanced
lightrsi codex help
```

## Context Cleaner

Type `!lightrsi-clean` yourself inside Codex to open the terminal selector, or run `lightrsi codex clean` in an interactive terminal. Review the host/session and task list. Up/Down moves between selectable tasks, Space toggles them, and Enter approves the checked selection; tasks start unchecked.

The installed `lightrsi-clean` skill provides a separate MCP-form path with controls chosen by Codex. It accepts only the user's selected tasks. Cancellation or an empty selection schedules no rewrite.

An accepted selection is `scheduled` for the next eligible host request. Continue the same session, then inspect the receipt:

```bash
lightrsi codex clean --status <plan-id>
```

See [Context Cleaner](/user-guide/context-cleaner) for explicit plan selection, cancellation, protected tasks, and the difference between scheduled and applied savings.

## PATH Setup

The installer uses `~/.local/bin` by default on Linux/macOS. On Windows it creates `lightrsi.cmd`, `lightrsi-clean.cmd`, and `tokenpilot-codex.cmd`, using the npm command directory when it is already on `PATH`. `LIGHTRSI_BIN_DIR` can override the command directory.

On Linux/macOS, if `lightrsi` is not found after install:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Add to `~/.bashrc` or `~/.zshrc` to make permanent.

## Troubleshooting

For Cleaner installation or selection issues, see [Context Cleaner troubleshooting](/user-guide/context-cleaner#troubleshooting). Doctor reports Cleaner MCP and recovery MCP health separately.

See [TokenPilot Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting#codex) for Codex-specific issues.
