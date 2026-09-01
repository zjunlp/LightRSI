# TokenPilot Adapters

This directory contains host-specific integration layers for the TokenPilot component.

Shared runtime logic belongs under `components/packages/`. Anything that depends on one concrete host should stay under `components/adapters/<host>/`.

Each adapter owns two explicit declarations in addition to its runtime code:

- a TokenPilot preset binding describing the supported feature subset
- a product registration describing host identity and state discovery

The shared CLI and browser Visual surface consume those registrations instead of maintaining separate hardcoded host metadata.

## Current Status

Adapter inventory:

- `openclaw/`
  - production adapter
- `codex/`
  - adapter for Codex CLI
- `claude-code/`
  - adapter for Claude Code
- `deepseek-harness/`
  - Cordis adapter and compatibility smoke path for DeepSeek Harness
- future adapters
  - other host-specific integrations

## What Belongs In An Adapter

Keep these responsibilities inside the adapter layer:

- host install and uninstall flow
- host config mutation
- request / response hook wiring
- session and transcript bridging
- host-specific command registration
- runtime bootstrap and doctor checks
- host-owned path resolution

Keep these responsibilities in shared packages:

- runtime contracts in `packages/foundation/kernel/`
- host-neutral execution primitives in `packages/foundation/runtime-core/`
- shared state infrastructure in `packages/foundation/history/`
- feature and policy logic in `packages/features/*` and `presets/*`
- host abstraction helpers in `packages/foundation/host-adapter/`
- shared command semantics in `packages/foundation/product-surface/`
- standalone product entrypoints in `products/`

## Recommended Adapter Shape

```text
adapters/
└── <host>/
    ├── README.md
    ├── package.json
    ├── src/
    │   ├── commands/        # host command binding
    │   ├── integration/     # host lifecycle and hook wiring
    │   ├── state/           # host path and runtime state helpers
    │   └── index.ts
    ├── scripts/             # install / doctor / packaging helpers
    └── tests/
```

The exact subtree can vary by host, but the split should stay readable:

- `src/`
  - runtime integration code
- `scripts/`
  - operator-facing tooling
- `tests/`
  - adapter-level checks

## New Adapter Checklist

When adding a new host adapter, cover these surfaces explicitly:

1. Install surface
   - where the host extension or plugin lives
   - how configuration is written
   - how to enable, disable, and remove it
2. Session bridge
   - how session ids, turn ids, and workspace roots are resolved
3. Transcript bridge
   - how raw host messages are decoded into shared envelopes
   - how rewritten envelopes are encoded back into the host request format
4. Request / response lifecycle
   - before-call rewriting
   - after-call reduction
   - tool-result persistence
   - streaming and non-streaming handling
5. State roots
   - state dir
   - archive dir
   - debug trace dir
6. Product surface
   - `status`
   - `report`
   - `doctor`
   - `visual`
   - mode switching
7. Verification
   - adapter unit tests
   - one smoke install path
   - one end-to-end session check

## Recommended Development Order

Use this order when bringing up a new adapter:

1. start with the shared host envelope bridge in `packages/foundation/host-adapter/`
2. wire one minimal request path through the host
3. make `status` and `doctor` work first
4. add reduction and persistence hooks
5. add visual and richer command surfaces last

This keeps the first working version small and makes boundary mistakes easier to spot.

## Related Docs

- [../README.md](../README.md)
- [HOSTS.md](./HOSTS.md)
- [openclaw/README.md](./openclaw/README.md)
- [codex/README.md](./codex/README.md)
- [claude-code/README.md](./claude-code/README.md)
- [deepseek-harness/](./deepseek-harness/)
