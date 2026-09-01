# Adapter Playbook

This document is the implementation checklist for adding a new TokenPilot host adapter inside LightRSI.

Use it before adding support for a new coding-agent host such as Codex CLI, Claude Code, or DeepSeek Harness.

## Design First

Define the host model before writing adapter code:

- can the host rewrite requests before model execution?
- can the host rewrite responses after model execution?
- does the host expose streaming chunks, final responses, or both?
- does the host expose transcript history directly, or must it be reconstructed?
- is integration file-based, hook-based, plugin-based, or API-based?

## Required Surfaces

Every adapter should make these explicit:

- install flow
  - how the adapter is installed
  - what config file or plugin registry is updated
  - how uninstall would work
- session identity
  - session id
  - turn id
  - workspace root
- transcript bridge
  - host message format to TokenPilot canonical form
- request / response hooks
  - stable-prefix path
  - reduction path
  - eviction path
  - recovery path
- runtime state
  - state root
  - namespace
  - archive storage path
- control surface
  - status
  - report
  - visual inspection
  - debugging entrypoints

## Package Placement

Preferred structure:

```text
components/
├── packages/
│   ├── foundation/
│   └── features/
├── presets/
├── products/
└── adapters/<host>/
```

Shared logic belongs in `packages/foundation/*` or `packages/features/*`. Host-specific config, transcript parsing, command wiring, and install logic belong in the host adapter.

## Regression Gates

At minimum, an adapter change should pass:

```bash
pnpm typecheck
```

If adapter-specific tests exist, run the relevant package test command as well.

## Current Reference

The current reference adapter is:

- [components/adapters/openclaw/README.md](../components/adapters/openclaw/README.md)

The current host integration index is:

- [components/adapters/HOSTS.md](../components/adapters/HOSTS.md)
