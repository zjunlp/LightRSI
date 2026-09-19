# OpenClaw

OpenClaw is the primary host for LightRSI, with the deepest integration via a native plugin slot.

## Installation

```bash
pnpm component:install:tokenpilot:openclaw
```

This command:
- Updates `~/.openclaw/openclaw.json`
- Enables the TokenPilot plugin
- Switches `plugins.slots.contextEngine` to `layered-context`
- Sets the default `normal` mode
- Attempts to restart the OpenClaw gateway

### Custom Paths

```bash
export LIGHTRSI_OPENCLAW_HOME="/path/to/openclaw-home"
export OPENCLAW_CONFIG_PATH="/path/to/openclaw.json"
pnpm component:install:tokenpilot:openclaw
```

## Expected Output

After install, your `~/.openclaw/openclaw.json` will include a TokenPilot section:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "layered-context"
    },
    "entries": {
      "tokenpilot": {
        "enabled": true,
        "mode": "normal"
      }
    }
  }
}
```

## Verification

Inside an OpenClaw session:

```text
/lightrsi status
```

Expected output:
- `plugin entry enabled`
- `config enabled`
- `mode normal`
- `context engine slot layered-context`
- `stabilizer enabled`
- `reduction enabled`

For a fuller check:

```text
/lightrsi doctor
/lightrsi report
/lightrsi visual
```

## In-Session Commands

OpenClaw supports in-session slash commands:

```text
/lightrsi status          # View current status
/lightrsi report          # Session token/cost report
/lightrsi doctor          # Integration self-check
/lightrsi visual          # Open visual inspector
/lightrsi mode normal     # Switch mode
/lightrsi stabilizer target developer
/lightrsi reduction mode balanced
/lightrsi eviction on
/lightrsi help            # List all commands
```

## Standalone CLI

Commands also work outside OpenClaw:

```bash
lightrsi openclaw status
lightrsi openclaw report
lightrsi openclaw doctor
lightrsi openclaw visual
lightrsi openclaw mode normal
lightrsi openclaw session <session-id> report
```

## Model Selection

```text
lightrsi/gpt-5.4-mini
```

## Context Cleaner

Analyze the current mapped conversation without rewriting its context:

```text
/lightrsi clean
```

If the session cannot be resolved, use `/lightrsi clean --session <session-id>`. Review the returned plan and select only eligible task IDs:

```text
/lightrsi clean --plan <plan-id> --select <task-id-1>,<task-id-2>
/lightrsi clean --status <plan-id>
/lightrsi clean --cancel <plan-id>
```

`/tokenpilot clean` and `/tp clean` are aliases. After explicit approval, a successful OpenClaw clean archives task content through the canonical eviction backend, commits the rewrite, and returns an `applied` receipt immediately. The rewrite uses pointer stubs or drops selected content according to the replacement mode; cancelling a Cleaner plan does not undo an applied rewrite. The standalone entry is `lightrsi openclaw clean --session <session-id>`; in an interactive terminal it can open a selector after analysis.

See [Context Cleaner](/user-guide/context-cleaner) for task protection, accounting, and cancellation limits.

## Recovery

```bash
cp ~/.openclaw/openclaw.json.tokenpilot.bak ~/.openclaw/openclaw.json
```

## Troubleshooting

See [TokenPilot Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting#openclaw) for OpenClaw-specific issues.
