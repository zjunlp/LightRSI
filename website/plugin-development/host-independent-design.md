# Host-Independent Design

LightRSI separates component packages and host adapters.

From the [components/README.md](https://github.com/zjunlp/LightRSI/blob/main/components/README.md):

- **Component packages**: reusable runtime logic, state and policy layers, host-agnostic contracts
- **Host adapters**: installation and bootstrap, transcript/session bridging, host-specific command and hook surfaces

From the [adapters/README.md](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/README.md):

**Adapter responsibilities** (keep inside adapter layer):
- Host install and uninstall flow
- Host config mutation
- Request / response hook wiring
- Session and transcript bridging
- Host-specific command registration
- Runtime bootstrap and doctor checks
- Host-owned path resolution

**Shared package responsibilities** (keep in shared packages):
- Runtime contracts in `components/packages/foundation/kernel/`
- Host-neutral execution primitives in `components/packages/foundation/runtime-core/`
- State and policy logic in `components/packages/{foundation,features}/**`
- Host abstraction helpers in `components/packages/foundation/host-adapter/`
- Shared command semantics in `components/packages/foundation/product-surface/`
- Standalone product entrypoints in `products/`

From the [HOSTS.md boundary section](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/HOSTS.md):

- `components/packages/*` — reusable component logic
- `components/products/*` — shared product surfaces
- `components/adapters/<host>` — host-specific integration layer

## Related Pages

- [Plugin Directory Structure](/plugin-development/directory-structure) — where to place shared vs. host-specific code
- [Runtime API](/plugin-development/runtime-api) — the shared packages and their public contracts
- [Adapter Architecture](/host-adapter-development/adapter-architecture)
