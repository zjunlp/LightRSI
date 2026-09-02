# TokenPilot Claude Code Adapter

This package contains the current Claude Code adapter for the TokenPilot component. It is gateway-first: Claude Code requests are routed through a local Anthropic-compatible gateway, while hooks and a shared MCP server provide observability and real archive recovery.

This adapter explicitly binds the TokenPilot `stabilizer` and `reduction` features. It does not advertise lifecycle eviction support. Its product registration provides Claude Code state discovery to the shared CLI and Visual surface.

For the shared component overview and host matrix, see:

- [`components/presets/tokenpilot/README.md`](../../presets/tokenpilot/README.md)
- [`components/adapters/HOSTS.md`](../HOSTS.md)
- [`components/adapters/README.md`](../README.md)

## Supports

Supported:

- Claude Code install into local settings and MCP config
- TokenPilot runtime config in `~/.claude/tokenpilot.json`
- local gateway routing through an Anthropic-compatible adapter surface
- real MCP-backed `memory_fault_recover`
- lightweight observability hooks
- stable-prefix rewriting
- request-time reduction
- lightweight session-state and ux-effects tracking
- shared browser visual via `lightrsi claude-code visual`
- standalone `lightrsi claude-code ...` command surface
- local constrained Claude Code skill bridge for `status` / `report` / `doctor` / `visual` / `clean`

Current limitations:

- lifecycle eviction controls
- `mode aggressive`
- native runtime-managed in-host commands
- browser visual parity

## Install

For a release archive, extract it and run the bundled installer directly:

```bash
node /path/to/package/dist/install-claude-code.js
```

The release archive is self-contained: its hooks, recovery MCP server, `lightrsi` command, and `tokenpilot-claude-code` command all run from the extracted package directory. Keep that directory in place after installation.

For a source checkout, use the one-pass Cleaner installation flow:

```bash
cd /path/to/LightRSI
corepack pnpm cleaner:install:claude-code
```

Use `--skip-build` only for a verified existing build. The source installer
rejects missing or stale CLI, MCP, and adapter artifacts before it changes
Claude Code configuration.

If your Claude Code files are not under the default `~/.claude`, set:

```bash
export CLAUDE_CODE_SETTINGS_PATH="/path/to/settings.json"
export CLAUDE_CODE_MCP_CONFIG_PATH="/path/to/.claude.json"
export TOKENPILOT_CLAUDE_CODE_CONFIG="/path/to/tokenpilot.json"
```

Then run the same one-pass installer:

```bash
cd /path/to/LightRSI
corepack pnpm cleaner:install:claude-code
```

If `lightrsi` is not found after install, make sure `~/.local/bin` is on your `PATH`.

The installer will:

- update `~/.claude/settings.json` for local gateway routing
- enable the required tool-search environment flag
- write TokenPilot runtime config to `~/.claude/tokenpilot.json`
- register the shared `tokenpilot_memory_fault_recover` MCP server in `~/.claude/.claude.json`
- install a `SessionStart` hook that auto-starts the local TokenPilot gateway on first use
- install constrained Claude Code command skills under the local Claude skills directory
- preserve existing Claude files as `.tokenpilot.bak` backups before rewriting
- write a conservative `startup_timeout_sec` for the recovery MCP server
- run a post-install MCP startup probe and report degraded mode if recovery MCP is still unavailable

The installed Claude Code skill bridge currently creates these explicit skills:

- `lightrsi-status`
- `lightrsi-report`
- `lightrsi-doctor`
- `lightrsi-visual`
- `lightrsi-clean` (explicit, analysis-only; it never selects or confirms a clean)

These are host entry points, not a separate runtime implementation. They call the existing `lightrsi claude-code ...` CLI surface underneath.

On Windows the installer also creates `lightrsi.cmd` and
`tokenpilot-claude-code.cmd`. If the npm command directory is already on `PATH`,
these commands are available immediately in a new CMD or PowerShell terminal.

## Verify

You can run the adapter doctor immediately after install:

```bash
cd /path/to/LightRSI
npm --prefix components/adapters/claude-code run doctor:claude-code
```

Then use the first real-session path:

1. Start Claude Code normally.
2. Open a new Claude Code session so `SessionStart` can auto-start the local gateway.
3. In another terminal, verify through the shared CLI:

```bash
lightrsi claude-code status
lightrsi claude-code doctor
lightrsi claude-code report
lightrsi claude-code mode normal
lightrsi claude-code reduction status
lightrsi claude-code stabilizer target developer
```

The Claude Code gateway is now auto-started from the installed `SessionStart` hook. After the first Claude Code session starts, `lightrsi claude-code doctor` should report `proxy healthy: yes` without a separate manual start step.

Expected first-run shape:

- `lightrsi claude-code doctor` reports `proxy healthy: yes`
- `lightrsi claude-code status` shows `stabilizer` and `reduction` enabled
- after a few turns, `lightrsi claude-code report` no longer says `No TokenPilot session stats yet.`

Claude Code currently supports `mode conservative` and `mode normal`. `mode aggressive` is not available on the current adapter.

## Commands

Claude Code command surface:

```bash
lightrsi claude-code status
lightrsi claude-code report
lightrsi claude-code doctor
lightrsi claude-code visual
lightrsi claude-code mode conservative
lightrsi claude-code mode normal
lightrsi claude-code stabilizer on
lightrsi claude-code stabilizer off
lightrsi claude-code stabilizer target developer
lightrsi claude-code stabilizer target user
lightrsi claude-code reduction on
lightrsi claude-code reduction off
lightrsi claude-code reduction mode light
lightrsi claude-code reduction mode balanced
lightrsi claude-code reduction pass toolPayloadTrim off
```

Supported reduction passes:

- `readStateCompaction`
- `toolPayloadTrim`
- `htmlSlimming`
- `execOutputTruncation`
- `agentsStartupOptimization`

Not supported:

- `lightrsi claude-code settings ...`
- `lightrsi claude-code eviction ...`
- `lightrsi claude-code mode aggressive`
- `lightrsi claude-code stabilizer hook ...`

## Doctor Coverage

Doctor checks report whether:

- Claude settings are installed
- observability hooks are installed
- observability hooks are complete or only partially installed
- observability hooks still point to the expected current handler command
- gateway routing is active
- tool search is enabled
- recovery MCP is installed
- MCP `TOKENPILOT_STATE_DIR` matches the TokenPilot config state dir
- MCP command / args still match the current TokenPilot install
- MCP startup timeout still matches the expected install value
- proxy health is reachable
- session-state / ux-effects data already exist

## Report And Visual

`lightrsi claude-code report` and `lightrsi claude-code visual` intentionally serve different purposes:

- `report`
  - savings-oriented summary from `ux-effects`
- `visual`
  - shared browser visual surface preselected to the current Claude Code host and session

Current visual data includes:

- stability snapshots
- reduction snapshots
- recent cache-audit summaries
- browser-side host and session selection through the shared visual surface

Claude Code still persists lightweight observability state from gateway + hooks, but `lightrsi claude-code visual` now opens the shared browser visual surface rather than a text-only view.

## Runtime Files

The current adapter writes state under:

```text
~/.claude/tokenpilot-state/tokenpilot/
```

Useful files:

- `event-trace.jsonl`
- `session-state/latest.json`
- `session-state/sessions/<session>.json`
- `session-state/bindings/<session>.jsonl`
- `ux-effects/latest.json`
- `ux-effects/sessions/<session>.json`

## Debugging

Useful checks:

```bash
cat ~/.claude/tokenpilot.json
cat ~/.claude/settings.json
cat ~/.claude/.claude.json
npm --prefix components/adapters/claude-code run doctor:claude-code
```

If install finishes in degraded MCP mode, gateway routing and reduction remain usable; only the real `memory_fault_recover` tool path is unavailable until MCP startup succeeds.

## Package Scripts

Primary package scripts:

```bash
npm --prefix components/adapters/claude-code run build
npm --prefix components/adapters/claude-code run typecheck
npm --prefix components/adapters/claude-code test
npm --prefix components/adapters/claude-code run install:claude-code
npm --prefix components/adapters/claude-code run doctor:claude-code
```
