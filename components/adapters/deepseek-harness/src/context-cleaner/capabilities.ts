/**
 * Frozen one-way DSH Cleaner capabilities.
 *
 * DSH session/event shapes stay here. The shared Cleaner layer receives only
 * a canonical snapshot, a session catalogue, and durable pointer operations.
 */

import type {
  CleanerHostCapabilities,
  ContextCleanerScheduleRequest,
} from "@lightrsi/cleaner";
import type { SessionTaskRegistry } from "@lightrsi/history";

import { listDshCleanerSessions, type DshCleanerSessionStore } from "./session-catalog.js";
import {
  finalizeDshCleanerSchedule,
  scheduleDshCleanerPlan,
} from "./scheduler.js";
import { buildDshCleanSnapshot, DSH_HOST_ID, surfaceRevision } from "./snapshot.js";

export type DshCleanerCapabilityParams = {
  stateDir: string;
  sessions: DshCleanerSessionStore;
  loadRegistry(sessionId: string): Promise<SessionTaskRegistry> | SessionTaskRegistry;
};

function validScheduleRequest(request: ContextCleanerScheduleRequest): boolean {
  return request.sessionId.trim().length > 0
    && request.cleanPlanId.trim().length > 0
    && request.baseRevision.trim().length > 0
    && request.selectedTaskIds.length > 0
    && new Set(request.selectedTaskIds).size === request.selectedTaskIds.length
    && request.selectedTaskIds.every((taskId) => taskId.trim().length > 0);
}

/** Create the DeepSeek Harness implementation of the frozen Cleaner boundary. */
export function createDshCleanerCapabilities(
  params: DshCleanerCapabilityParams,
): CleanerHostCapabilities {
  const stateDir = params.stateDir.trim();
  if (!stateDir) throw new Error("dsh_clean_state_dir_missing");

  return {
    hostId: DSH_HOST_ID,
    rewriteMode: "canonical",
    snapshotSource: {
      hostId: DSH_HOST_ID,
      rewriteMode: "canonical",
      async readCleanSnapshot(sessionId) {
        const session = params.sessions.get(sessionId);
        if (!session) throw new Error("dsh_clean_snapshot_unavailable");
        const registry = await params.loadRegistry(sessionId);
        return buildDshCleanSnapshot({
          session,
          registry,
          revision: surfaceRevision(session),
        }).snapshot;
      },
    },
    sessionCatalog: {
      async listSessions() {
        return listDshCleanerSessions(params.sessions);
      },
    },
    scheduleWriter: {
      async writeSchedule(request) {
        if (!validScheduleRequest(request)) {
          return {
            outcome: "bypassed" as const,
            reasons: ["dsh_cleaner_schedule_input_invalid"],
          };
        }
        return scheduleDshCleanerPlan({
          stateDir,
          sessionId: request.sessionId,
          cleanPlanId: request.cleanPlanId,
          baseRevision: request.baseRevision,
          selectedTaskIds: [...request.selectedTaskIds],
          scheduledAt: request.scheduledAt,
        });
      },
      abortSchedule(request) {
        return finalizeDshCleanerSchedule({
          stateDir,
          sessionId: request.sessionId,
          cleanPlanId: request.cleanPlanId,
          receiptStatus: request.receiptStatus,
          reasons: [...request.reasons],
          updatedAt: request.updatedAt,
        });
      },
    },
  };
}
