# DeepSeek Harness Context Cleaner

This adapter adds a native DeepSeek Harness command for reviewing and safely
cleaning context from completed tasks. It is deliberately two-phase:

1. `/tokenpilot-clean` analyzes the current live session and creates a plan.
2. An explicit selection only writes a durable schedule.
3. The **next normal agent request** claims that schedule and performs one
   canonical DSH surface transaction. A terminal receipt prevents replay.

Analysis, status, and cancellation never change the model-visible context.

## Configure the DSH profile

Install the adapter through its `cordis.patch.yml` as usual, then add a config
block for `tokenpilot-dsh` in the selected DSH profile. Keep `stateDir` outside
the repository and do not commit your key.

```yaml
- id: tokenpilot-dsh
  config:
    enabled: true
    stateDir: C:/Users/you/.lightrsi/dsh
    taskStateEstimator:
      enabled: true
      baseUrl: <your OpenAI-compatible API base URL>
      apiKey: <your API key>
      model: <your task-state-estimation model>
    # Keep this false for a Cleaner-only workflow: task state is still tracked,
    # but automatic eviction cannot rewrite the surface before you select work.
    eviction:
      enabled: false
```

The estimator needs `enabled`, `baseUrl`, `apiKey`, and `model`. Until it has
observed a completed task, Context Cleaner correctly reports no eligible task.

## Native workflow

1. Finish a small, self-contained task in a DSH session. Send one later normal
   request so the task-state estimator can persist its completed state.
2. Run `/tokenpilot-clean`. The response shows a plan ID and each task:
   `[ ]` is selectable, while `[-]` is protected and cannot be selected.
3. Schedule only the desired completed task:

   ```text
   /tokenpilot-clean --plan <plan-id> --select <task-id>
   ```

   The response must say `status: scheduled`; at this point the conversation
   has not changed.
4. Send an ordinary next request, for example `请用一句话总结下一步。` The
   `agent/pre-step` hook performs the one allowed canonical rewrite before
   automatic eviction and DSH compaction.
5. Verify the evidence:

   ```text
   /tokenpilot-clean --status <plan-id>
   ```

   A successful run reports `status: applied` and the prior/next surface
   revision. The same scheduled plan cannot run twice.

To cancel before that next request:

```text
/tokenpilot-clean --cancel <plan-id>
```

`/context-cleaner` remains an alias for older profiles. The native DSH command
is the supported interactive entry point. An external CLI TTY picker is not
advertised here because an external process has no safe access to DSH's live
session surface.

## Verification

From the repository root:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm --dir .\components\adapters\deepseek-harness typecheck
corepack pnpm --dir .\components\adapters\deepseek-harness test
```

For the pinned DSH compatibility smoke, pass a checkout of the required DSH
revision:

```powershell
corepack pnpm --dir .\components\adapters\deepseek-harness compatibility:smoke -- --dsh-checkout="C:\path\to\deepseek-harness"
```
