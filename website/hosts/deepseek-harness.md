# DeepSeek Harness

TokenPilot integrates with DeepSeek Harness as a native **Cordis plugin**, registered as `tokenpilot-dsh`. It uses task-state estimation to identify completed work and can replace eligible older content in the context that Harness sends to the model.

Harness continues to own model transport, session persistence, and native compaction. The adapter adds optional context eviction and a read-only session status command; it does not add the proxy-based stable-prefix and reduction pipeline used by other hosts.

## Install

Use Node.js **22.19 or later in the 22.x line, or 24 and later**, as required by the adapter package. You need a LightRSI checkout with workspace dependencies installed and a working DeepSeek Harness checkout.

From the LightRSI repository root, build and package the adapter:

```bash
corepack pnpm install
corepack pnpm --filter @lightrsi/deepseek-harness-adapter build
corepack pnpm --filter @lightrsi/deepseek-harness-adapter pack --pack-destination ./artifacts
```

From your DeepSeek Harness checkout, add the generated archive to the profile you use:

```bash
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add /absolute/path/to/lightrsi-deepseek-harness-adapter-<version>.tgz
```

Replace the archive path with the actual file produced by the pack command. Replace `web` with your chosen profile, such as `headless`.

The package registers the Cordis plugin, but **eviction is disabled by default**. Installing it alone does not enable context changes.

## Configure and Enable

Edit the installed profile's `cordis.patch.yml`. For the default Harness home and the `web` profile, this is `~/.dsh/profiles/web/cordis.patch.yml`; with a custom home, use `$DSH_HOME/profiles/web/cordis.patch.yml`. Replace `web` if you installed into another profile. See the upstream [profile configuration documentation](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/packages/boot/app-boot/README.md#profiles) and [Harness home resolution](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/packages/util/home-paths/README.md).

Add this entry to the existing patch list, or update its existing `tokenpilot-dsh` entry:

The package installation has already inserted the plugin entry. This profile patch updates it by `id`; it does not insert another entry, and `name` does not need to be repeated. These rules follow the pinned Harness [patch implementation](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/vendor/include/src/index.ts).

```yaml
- id: tokenpilot-dsh
  config:
    enabled: true
    stateDir: /absolute/path/to/tokenpilot-dsh-state
    taskStateEstimator:
      enabled: true
      baseUrl: https://your-estimator-endpoint/v1
      apiKey: YOUR_ESTIMATOR_API_KEY
      model: your-estimator-model
    eviction:
      enabled: true
    compaction:
      runEvictionBeforeCompaction: true
```

Replace the placeholders with your own settings. Keep credentials in local configuration, outside version control. `stateDir` must point to a writable, persistent directory: it stores task lifecycle state across restarts.

A patch replaces the matched plugin's entire configuration, so retain any other TokenPilot settings you already use. Home-level patches and explicit overlays can override profile settings.

The shipped `web` profile uses `patchReload: live`, so a valid patch edit is applied without restarting. Profiles configured with `patchReload: startup` (including the shipped `headless`, `sdk`, `sdk-minimal`, and `acp` templates) require a restart with the same profile.

Eviction requires the master switch, estimator switch, and eviction switch to be enabled, a configured estimator endpoint, API key and model, and a durable state directory. If those requirements are not met, the adapter skips context changes and lets the agent continue.

### Configuration Reference

| Setting | Default | Purpose |
| :-- | :-- | :-- |
| `enabled` | `false` | Enable the adapter's eviction handler |
| `stateDir` | Unset | Persistent directory for the task registry |
| `taskStateEstimator.enabled` | `false` | Enable task-state estimation |
| `taskStateEstimator.baseUrl`, `apiKey`, `model` | Unset | Endpoint, credentials, and model for the estimator |
| `taskStateEstimator.requestTimeoutMs` | `60000` | Estimator request timeout in milliseconds |
| `taskStateEstimator.batchTurns` | `5` | Turn batch size passed to the estimator |
| `taskStateEstimator.evictionLookaheadTurns` | `3` | Lookahead window passed to the estimator |
| `eviction.enabled` | `false` | Allow eligible context to be replaced |
| `eviction.minBlockChars` | `200` | Minimum candidate block size in characters |
| `eviction.failureMode` | `bypass` | Continue the agent when optimization fails |
| `compaction.runEvictionBeforeCompaction` | `true` | Run TokenPilot before Harness native compaction |
| `logLevel` | `info` | Set to `debug` to inspect pre-step decisions |

## Verify in a Session

After loading the configured profile, open a Harness session and run:

```text
/tokenpilot-status
```

This command reads session state without creating a model turn or modifying context. It reports:

| Field | Meaning |
| :-- | :-- |
| `enabled` | Whether the adapter's master switch is enabled |
| `last estimator run` | The most recent recorded estimator run |
| `candidate count` | Recorded candidate count, or `unknown` when unavailable |
| `estimated` | Estimated token savings |
| `scheduled` | Work that reached the candidate or transaction stage |
| `applied` | Token savings supported by recorded application evidence |
| `deferred reasons` | Reasons work could not be applied |
| `last transaction status` | The latest recorded eviction transaction outcome |

An enabled adapter does not guarantee an eviction on every turn. A new session may report `never`, `none`, or `unknown` until relevant events have been recorded. Estimated and scheduled savings are not proof that a context change was applied.

The status command requires Harness's `commands` and `sessionProjections` services. A headless composition without those services can load the adapter but will not expose this command.

## How Eviction Works

On an eligible agent step, TokenPilot reads session events, updates task lifecycle state, validates eviction candidates, and applies replacements to the current context. By default, this runs **before Harness native compaction**, then re-measures context size so subsequent processing sees the updated size.

The safety checks retain current-turn content, active or unresolved tasks, and compaction checkpoints. Tool results are eligible only when their call/result relationship is complete and safe; the assistant's tool-call structure is preserved. A changed session revision or unsupported required event prevents an unsafe rewrite.

Optimization failures use the `bypass` policy so the agent can continue. Preserve the default compaction ordering unless you are deliberately testing a different configuration.

Replacements are recorded as new session events; the original event log remains available for audit and replay. If only part of a replacement batch succeeds, the adapter records a partial result rather than claiming that all changes were rolled back.

## Troubleshooting

| Symptom | What to check |
| :-- | :-- |
| `/tokenpilot-status` is unavailable | Confirm the plugin was added to the active profile and that the profile supplies both command and session projection services |
| Status shows `enabled: no` | Enable the `tokenpilot-dsh` master switch in that profile |
| No estimator activity or eviction | Check the estimator and eviction switches, estimator endpoint/key/model, and persistent `stateDir` |
| Tasks remain in context | They may still be active, unresolved, current, too small, or fail tool-pair safety checks; inspect deferrals before expecting savings |
| Optimization is skipped | Set `logLevel` to `debug` and inspect `[tokenpilot:dsh] pre-step` logs for reasons such as `estimator-not-configured`, `registry-not-configured`, or `unrecognized-required-event` |

To disable automatic eviction, set `eviction.enabled` to `false`. To disable the eviction handler entirely, set the top-level `enabled` to `false`, then reload the configured profile. Disabling future eviction does not undo context changes already applied.

## Integration Boundaries

DeepSeek Harness uses its own plugin installation and `/tokenpilot-status` command. The shared `lightrsi ... doctor`, `report`, `visual`, and runtime-mode walkthroughs for other hosts do not apply to this integration.

For adapter development, see [Adapter Testing](/host-adapter-development/adapter-testing). The compatibility smoke checks package installation and host integration; it is separate from validating eviction with your estimator and live sessions.

## Next

The install and session commands follow the project [README](https://github.com/zjunlp/LightRSI/blob/main/README.md#installation). The additional configuration defaults and status fields are defined by the adapter's [configuration](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/deepseek-harness/src/config.ts) and [status command](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/deepseek-harness/src/commands.ts).

- [Host Compatibility](/hosts/compatibility) — compare integration capabilities
- [TokenPilot Overview](/plugin-catalog/tokenpilot/overview) — understand the context-management techniques
