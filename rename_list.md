# LightRSI Rename Checklist

## Naming Contract

- [√] Product and repository name: `LightRSI`.
- [√] npm workspace scope: `@lightrsi/*`.
- [√] Root CLI and public commands: `lightrsi`.
- [√] OpenClaw provider/model prefix: `lightrsi/<model>`.
- [√] Canonical environment prefix: `LIGHTRSI_*`.
- [√] Canonical user state root: `~/.lightrsi/`.
- [√] TokenPilot remains the preset, plugin, paper-method, and host-state namespace.
- [√] Existing Git history, tags, release artifacts, and citations are not rewritten.

## Compatibility Contract

- [√] Read `LIGHTMEM2_*` after `LIGHTRSI_*` and before legacy `TOKENPILOT_*` variables.
- [√] Read existing `~/.lightmem2/` state when canonical `~/.lightrsi/` state is absent, then write canonical state.
- [√] Keep `lightmem2` and `lightmem2-install-*` binary aliases for one compatibility release.
- [√] Recognize the old `lightmem2/<model>` provider during install and migrate it to `lightrsi/<model>`.
- [√] Accept persisted `lightmem2.* /v1` schemas while writing canonical `lightrsi.* /v1` schemas.
- [√] Remove old `lightmem2-*` command skills during reinstall and install new `lightrsi-*` skills.

## Workspace And Packages

- [√] Rename root package and scripts.
- [√] Rename every package manifest from `@lightmem2/*` to `@lightrsi/*`.
- [√] Rename all TypeScript imports and `tsconfig` path aliases.
- [√] Rename package metadata key `lightmem2.role` to `lightrsi.role`.
- [√] Regenerate `pnpm-lock.yaml` and workspace links; do not edit `node_modules` manually.
- [√] Update package boundary validation.

## Runtime And Products

- [√] Rename version constants and product display strings.
- [√] Rename CLI usage, dispatch, visual output, install scripts, and release bundle entries.
- [√] Move canonical CLI state to `~/.lightrsi/state` with legacy fallback.
- [√] Rename MCP package identity and client information.
- [√] Rename temporary paths, cache keys, event sources, and generated identifiers where they are not persisted protocol compatibility keys.

## Host Adapters

- [√] OpenClaw: provider prefix, installer, doctor, commands, package metadata, and package smoke.
- [√] Codex: package, installer alias, hooks, skills, report/doctor output, estimator environment variables, and release smoke.
- [√] Claude Code: package, installer alias, hooks, skills, report/doctor output, estimator environment variables, and release smoke.
- [√] Preserve TokenPilot config/state names where they identify the preset rather than the platform.

## Persisted Data And Protocols

- [√] Inventory schema strings, journal rows, plan stores, trace events, cache entries, and session mappings.
- [√] Add explicit old-schema readers instead of relying on broad string replacement.
- [√] Verify legacy CLI state, Codex journal state, and OpenClaw provider state upgrade paths.
- [√] Verify new LightRSI state does not write into the legacy root.

## Documentation And Website

- [√] Update README, CONTRIBUTING, component docs, adapter docs, and examples.
- [√] Rename website page filenames and internal routes.
- [√] Update GitHub URLs after the repository is renamed.
- [√] Replace old logo and overview assets with LightRSI assets.
- [√] Keep paper-specific TokenPilot descriptions unchanged.
- [√] Position LightRSI as a recursive-improvement runtime whose current implementation focuses on context and agentic memory.

## Verification

- [√] No unintended `@lightmem2/*`, `LightMem2`, `lightmem2`, or `LIGHTMEM2_*` references remain outside explicit compatibility tests/readers and historical records.
- [√] `pnpm install --lockfile-only` succeeds.
- [√] `pnpm typecheck` succeeds.
- [√] `pnpm check:boundaries` succeeds.
- [√] Full package tests succeed.
- [√] `pnpm build` succeeds.
- [√] VitePress documentation build succeeds.
- [√] Local release build and all three host package smokes succeed.
- [√] Isolated fresh-install and legacy-upgrade coverage succeeds for OpenClaw, Codex, and Claude Code.

## GitHub And Local Directory

- [√] Rename the GitHub repository from `LightMem2` to `LightRSI` after local verification.
- [√] Update `lab` and `origin` remote URLs after the GitHub rename.
- [√] Rename the local directory from `LightMem2` to `LightRSI` last.
- [√] Run one final dependency install, doctor inspection, and build from the renamed path.
