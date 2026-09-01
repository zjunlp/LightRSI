import type {
  ContextMutationPlan,
  ModelContextRewriteMode,
  ModelContextSnapshot,
} from "@lightrsi/host-adapter";

export const CONTEXT_CLEAN_SCHEMA_VERSION = 1 as const;
export const CONTEXT_CLEAN_STORE_SCHEMA_VERSION = 1 as const;

export type ContextCleanTokenCountMode = "exact" | "estimated" | "chars_only";

export type ContextCleanLifecycleState =
  | "active"
  | "unresolved"
  | "completed"
  | "aborted"
  | "unknown";

export type ContextCleanRecommendation = "clean" | "keep" | "protected";

export type ContextCleanStatus =
  | "analyzed"
  | "approved"
  | "scheduled"
  | "applied"
  | "stale"
  | "cancelled"
  | "failed";

export const TERMINAL_CONTEXT_CLEAN_STATUSES = [
  "applied",
  "stale",
  "cancelled",
  "failed",
] as const satisfies readonly ContextCleanStatus[];

export const CONTEXT_CLEAN_STATUS_TRANSITIONS = {
  analyzed: ["approved", "cancelled", "failed"],
  approved: ["scheduled", "stale", "cancelled", "failed"],
  scheduled: ["applied", "stale", "cancelled", "failed"],
  applied: [],
  stale: [],
  cancelled: [],
  failed: [],
} as const satisfies Record<ContextCleanStatus, readonly ContextCleanStatus[]>;

export function isContextCleanStatus(value: unknown): value is ContextCleanStatus {
  return typeof value === "string" && Object.hasOwn(CONTEXT_CLEAN_STATUS_TRANSITIONS, value);
}

export function isTerminalContextCleanStatus(
  status: ContextCleanStatus,
): boolean {
  return (TERMINAL_CONTEXT_CLEAN_STATUSES as readonly ContextCleanStatus[])
    .includes(status);
}

export function canTransitionContextCleanStatus(
  from: ContextCleanStatus,
  to: ContextCleanStatus,
): boolean {
  return from === to || (CONTEXT_CLEAN_STATUS_TRANSITIONS[from] as readonly ContextCleanStatus[])
    .includes(to);
}

export type ContextCleanTaskBreakdown = {
  taskId: string;
  label: string;
  description: string;
  summary: string;
  lifecycleState: ContextCleanLifecycleState;
  itemIds: string[];
  /** Digests captured at analysis time, keyed by stable item id. */
  itemDigests: Record<string, string>;
  tokenCount: number | null;
  charCount: number;
  tokenPercent: number | null;
  recallCount?: number;
  recommendation: ContextCleanRecommendation;
  reasonCodes: string[];
  selectable: boolean;
};

export type ContextCleanPlan = {
  schemaVersion: typeof CONTEXT_CLEAN_SCHEMA_VERSION;
  planId: string;
  hostId: string;
  sessionId: string;
  baseRevision: string;
  model?: string;
  contextWindowTokens?: number;
  usedTokens: number | null;
  usedChars: number;
  /** Protected context not attributed to a task, such as system instructions. */
  protectedTokens: number | null;
  protectedChars: number;
  /** Context that is neither task-attributed nor protected. */
  unassignedTokens: number | null;
  unassignedChars: number;
  tokenCountMode: ContextCleanTokenCountMode;
  tokenCountMethod: string;
  tasks: ContextCleanTaskBreakdown[];
  createdAt: string;
};

export type ContextCleanEvidence = {
  previousRevision?: string;
  nextRevision?: string;
  operationIds?: string[];
  itemIds?: string[];
  eventIds?: string[];
  archiveRefs?: string[];
  providerResponseId?: string;
};

type ContextCleanReceiptBase = {
  schemaVersion: typeof CONTEXT_CLEAN_SCHEMA_VERSION;
  planId: string;
  hostId: string;
  sessionId: string;
  /** Empty while analyzed; user approval freezes this selection for later states. */
  selectedTaskIds: string[];
  estimatedSavedTokens: number | null;
  estimatedSavedChars: number;
  tokenCountMode: ContextCleanTokenCountMode;
  deferredTaskIds: string[];
  reasons: string[];
  updatedAt: string;
};

export type ContextCleanPendingReceipt = ContextCleanReceiptBase & {
  status: "analyzed" | "approved" | "scheduled";
  appliedSavedTokens?: never;
  appliedSavedChars?: never;
  evidence?: ContextCleanEvidence;
  /** Whether recommendation fell back to the deterministic safe policy. */
  fallbackUsed: boolean;
};

export type ContextCleanScheduledReceipt = Omit<
  ContextCleanPendingReceipt,
  "status"
> & {
  status: "scheduled";
};

export type ContextCleanAppliedReceipt = ContextCleanReceiptBase & {
  status: "applied";
  appliedSavedTokens: number | null;
  appliedSavedChars: number;
  fallbackUsed: false;
  evidence: ContextCleanEvidence & {
    previousRevision: string;
    nextRevision: string;
    operationIds: string[];
    itemIds: string[];
  };
};

export type ContextCleanTerminalReceipt = ContextCleanReceiptBase & {
  status: "stale" | "cancelled" | "failed";
  appliedSavedTokens?: never;
  appliedSavedChars?: never;
  evidence?: ContextCleanEvidence;
  fallbackUsed: boolean;
};

export type ContextCleanReceipt =
  | ContextCleanPendingReceipt
  | ContextCleanAppliedReceipt
  | ContextCleanTerminalReceipt;

export type ContextCleanPlanRecord = {
  storeSchemaVersion: typeof CONTEXT_CLEAN_STORE_SCHEMA_VERSION;
  status: ContextCleanStatus;
  plan: ContextCleanPlan;
  updatedAt: string;
};

export type ContextCleanStoreOutcome =
  | "stored"
  | "transitioned"
  | "unchanged"
  | "missing"
  | "conflict"
  | "bypassed";

export type ContextCleanStoreWriteResult<T> = {
  outcome: ContextCleanStoreOutcome;
  value?: T;
  bypassed: boolean;
  reasons: string[];
};

export type ContextCleanStoreReadResult<T> = {
  value?: T;
  bypassed: boolean;
  reasons: string[];
};

export type ContextCleanSnapshot = ModelContextSnapshot & {
  capturedAt: string;
  model?: string;
  tokenCountMode: ContextCleanTokenCountMode;
  tokenCountMethod: string;
  itemTokenCounts?: Record<string, number>;
};

export type ContextCleanerSession = {
  sessionId: string;
  updatedAt?: string;
};

export type ApprovedContextCleanTask = Pick<
  ContextCleanTaskBreakdown,
  "taskId" | "itemIds" | "itemDigests"
>;

export type ExecuteApprovedContextCleanParams = {
  schemaVersion: typeof CONTEXT_CLEAN_SCHEMA_VERSION;
  cleanPlanId: string;
  hostId: string;
  sessionId: string;
  baseRevision: string;
  approvedAt: string;
  /** Exact task targets shown to and approved by the user. */
  selectedTasks: ApprovedContextCleanTask[];
};

/**
 * The only user-approved values accepted at a Host request boundary. Exact
 * item ids and digests are recovered from the immutable stored plan rather
 * than accepted again from a caller.
 */
export type ContextCleanExecutionRequest = {
  cleanPlanId: string;
  sessionId: string;
  baseRevision: string;
  selectedTaskIds: string[];
};

/** Canonical, Host-neutral state used to validate a scheduled clean. */
export type ContextCleanExecutionSnapshot = {
  snapshot: ModelContextSnapshot;
  activeTaskIds: readonly string[];
  evictableTaskIds: readonly string[];
};

export type ContextCleanPreparedExecution = {
  cleanPlanId: string;
  hostId: string;
  sessionId: string;
  baseRevision: string;
  selectedTasks: ApprovedContextCleanTask[];
  mutationPlan: ContextMutationPlan;
  scheduledReceipt: ContextCleanScheduledReceipt;
};

export type ContextCleanExecutionPrepareResult =
  | {
      outcome: "ready";
      execution: ContextCleanPreparedExecution;
      bypassed: false;
      reasons: [];
    }
  | {
      /** A terminal receipt is replayed without preparing another mutation. */
      outcome: "terminal";
      receipt: ContextCleanReceipt;
      bypassed: false;
      reasons: [];
    }
  | {
      outcome: "missing";
      bypassed: false;
      reasons: string[];
    }
  | {
      /** The original Host request must be preserved for this outcome. */
      outcome: "bypassed";
      receipt?: ContextCleanReceipt;
      bypassed: true;
      reasons: string[];
    };

export function isAppliedContextCleanReceipt(
  receipt: ContextCleanReceipt,
): receipt is ContextCleanAppliedReceipt {
  return receipt.status === "applied";
}

export interface ContextCleanerHostBridge {
  readonly hostId: string;
  readonly rewriteMode: ModelContextRewriteMode;
  listSessions(): Promise<ContextCleanerSession[]>;
  readCleanSnapshot(sessionId: string): Promise<ContextCleanSnapshot>;
  executeApprovedClean(
    params: ExecuteApprovedContextCleanParams,
  ): Promise<ContextCleanReceipt>;
  readCleanReceipt(planId: string): Promise<ContextCleanReceipt | undefined>;
  cancelCleanPlan(planId: string): Promise<ContextCleanReceipt>;
}

/**
 * Shared control-plane operations supplied by the Cleaner owner. Host adapters
 * consume this boundary; they do not implement plan persistence themselves.
 */
export type ContextCleanerControlPlane = Pick<
  ContextCleanerHostBridge,
  "executeApprovedClean" | "readCleanReceipt" | "cancelCleanPlan"
>;

/**
 * Shared scheduled-plan consumer used inside a Host's existing request lock.
 * Host-specific request payloads and actual rewrite commits stay in adapters.
 */
export interface ContextCleanerHostExecutionBridge {
  readonly hostId: string;
  prepareScheduledClean(
    params: ContextCleanExecutionRequest,
  ): Promise<ContextCleanExecutionPrepareResult>;
  recordCleanReceipt(
    receipt: ContextCleanReceipt,
  ): Promise<ContextCleanStoreWriteResult<ContextCleanPlanRecord>>;
}
