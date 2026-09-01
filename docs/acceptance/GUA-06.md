# GUA-06 Cross-host Acceptance

## Scope

- Independent validator: 观祥
- Maintainer review and corrections: 徐步强
- Providers: committed mock upstreams only
- Secrets/API keys: none

This acceptance checks context rewrite behavior through real adapter gateway runtimes. The reusable harness belongs to `@lightrsi/host-adapter`; host tests remain in their owning adapter packages.

## Claude Request Overlay

Command:

```text
pnpm --dir components/adapters/claude-code test
```

The focused acceptance test verifies:

- Five successful full-history requests pass through two distinct Claude gateway runtime lifetimes.
- The first runtime handles three requests, closes, and the second runtime handles two requests using the same isolated state directory.
- Every successful captured upstream request, not only the final request in a phase, removes `EVICT_ME_<uuid>` and preserves `KEEP_ME_<uuid>`.
- Anthropic `tool_use` and `tool_result` cardinality and closure remain valid in every successful request.
- Saved characters are derived from the original payload and actual captured request bodies.
- The second runtime observes trace evidence written by the first runtime.
- An injected clone failure bypasses eviction, forwards the original request, preserves tool closure, and records `analysis_or_apply_error` without raw context in the trace.

Claude status: **PASS** for mock non-streaming request-overlay acceptance.

The restart check proves that request overlay remains safe across process lifetimes and that the isolated state directory is retained. Claude eviction is currently recomputed from each full request; this test does not claim persistent rewrite-plan replay or recovery.

## Codex Response-chain Rebase

Command:

```text
pnpm --dir components/adapters/codex test
```

The focused estimator-driven acceptance test verifies:

- Ten successful requests pass through two distinct Codex proxy runtime lifetimes using one isolated state directory and one response-chain session.
- A fake estimator consumes the real canonical delta and automatically drives `registry -> shared lifecycle planner -> ContextMutationPlan -> rebase`; the test does not inject `contextRewrite.mutationPlan`.
- The task registry persists across restart (`version 0 -> 1 -> 2`) and the estimator observes the expected base versions (`0`, then `1`).
- Each lifetime first commits four setup turns containing one evictable and one retained tool pair. The shared oracle scores the planner-triggering request from each phase, identified by its current-user subject marker.
- Both captured stateless rebase requests remove `previous_response_id` and `EVICT_ME_<uuid>`, preserve `KEEP_ME_<uuid>` and the current turn, and retain complete Responses `function_call` / `function_call_output` closure.
- No fallback request succeeds in either phase.

Codex status: **PASS** for non-streaming estimator-driven mock-upstream acceptance across proxy restart. Streaming, fallback, cooldown, epoch recovery, journal ordering, malformed closure, and provider-compatibility scenarios stay covered by the adapter's dedicated tests.

Unlike a full-history gateway request, a Codex native continuation carries old history implicitly through `previous_response_id`. Consequently the shared oracle is used here for sentinel, closure, and fallback safety on the two planner-triggering requests; raw request-byte savings are not claimed by this test.

## DeepSeek Harness Compatibility

Command:

```text
pnpm --filter @lightrsi/deepseek-harness-adapter compatibility:smoke -- --dsh-checkout=/absolute/path/to/deepseek-harness
```

The compatibility smoke pins the tested DSH release to version `0.1.2-alpha.3` at commit `dd6322d604e00eec1ba5e0c8541159906a21094a` and checks the declared Node range before running. It builds and packs the adapter, runs the adapter projection/restart tests, builds DSH, runs DSH's keyless headless smoke, verifies idempotent plugin installation in both web and headless profiles, starts the Web host on an isolated loopback port, and verifies plugin removal.

The child processes receive only a small non-secret environment allowlist. HOME, XDG directories, DSH_HOME, and Windows application-data directories are redirected to a temporary root; real user configuration and credentials are not read. An unknown checkout requires `--allow-unknown` and is observation-only: the script reports `mutationEnabled: false` and does not claim compatibility with the pinned release.

## Three-host Fixture Oracle

The existing GUA-02 suite runs the same four logical fixtures through the OpenClaw reference backend, Claude overlay backend, and Codex response-chain backend:

```text
pnpm --dir components/adapters/openclaw test
```

It remains the cross-host target-set oracle. GUA-06 complements it with real Claude gateway and Codex proxy HTTP paths against mock upstreams; it does not replace the OpenClaw reference-backend ownership boundary.

## Architecture

- Generic acceptance recording, restart orchestration, sentinel inspection, fallback accounting, and multi-protocol closure checks live in `@lightrsi/host-adapter`.
- Claude and Codex acceptance import the shared harness through the package API and do not import another adapter's source tree.
- Each scored phase fails if any successful upstream request retains eviction content, loses required content, or breaks tool protocol closure.

## Limitations

- Mock providers only; no real Claude or Codex provider is called, and mock capability evidence does not upgrade production provider compatibility.
- Claude streaming acceptance remains separate from this non-streaming test.
- Codex streaming and failure-matrix acceptance remains in dedicated adapter tests rather than this focused shared-oracle scenario.
- Persistent Claude rewrite-plan replay is not implemented or claimed.
