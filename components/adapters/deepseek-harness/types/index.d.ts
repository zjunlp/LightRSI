export interface DshPluginContext {
  on(
    event: "agent/pre-step",
    handler: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
  ): void;
  tokenMeter?: {
    measure(session: unknown): unknown;
  };
  commands?: {
    register(definition: unknown): () => void;
  };
  inject?(
    services: readonly string[],
    callback: (scope: unknown) => void,
  ): unknown;
}

export declare const name = "tokenpilot-dsh";
/** The root plugin is headless-safe; optional Cordis services are injected in apply(). */
export declare const inject: readonly string[];
export declare function apply(ctx: unknown, rawConfig?: unknown): void;

export interface DshCleanerCapabilityParams {
  stateDir: string;
  sessions: {
    list(): readonly unknown[];
    get(sessionId: string): unknown;
  };
  loadRegistry(sessionId: string): unknown | Promise<unknown>;
}

/** Public factory; its host-neutral result is intentionally opaque here. */
export declare function createDshCleanerCapabilities(
  params: DshCleanerCapabilityParams,
): unknown;

/** Resolve a LightRSI-owned state directory without reading DSH session data. */
export declare function resolveDshStateDir(config: unknown): string | undefined;
/** Metadata consumed by LightRSI product/CLI composition. */
export declare const DSH_PRODUCT_HOST_REGISTRATION: unknown;
