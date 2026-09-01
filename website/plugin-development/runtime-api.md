# Runtime API

The shared packages under `components/packages/` provide host-agnostic runtime logic:

| Package | Description |
| :-- | :-- |
| `components/packages/foundation/kernel/` | Shared contracts, events, and runtime-facing types |
| `components/packages/foundation/runtime-core/` | Host-agnostic runtime engine and reduction pipeline |
| `components/packages/foundation/history/` | Canonical state, anchors, lifecycle bookkeeping |
| `components/packages/features/eviction/` | Reduction and eviction analysis / policy logic |
| `components/packages/features/memory/` | Experimental memory layer (distillation and retrieval still in progress) |
| `components/packages/foundation/host-adapter/` | Shared host contracts and path-resolution interfaces |
| `components/packages/foundation/product-surface/` | Shared user-facing command actions and product semantics |

These are the actual packages in the repository.

## Related Pages

- [Plugin Directory Structure](/plugin-development/directory-structure) — where each package lives
- [Host-Independent Design](/plugin-development/host-independent-design) — the architectural rationale
