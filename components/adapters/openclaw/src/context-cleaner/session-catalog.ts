import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalStateDir,
  type CanonicalTranscriptState,
} from "@lightrsi/history";
import type { ContextCleanerSession } from "@lightrsi/cleaner";

function isCanonicalState(value: unknown): value is CanonicalTranscriptState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<CanonicalTranscriptState>;
  return state.version === 1
    && typeof state.sessionId === "string"
    && Boolean(state.sessionId.trim())
    && Array.isArray(state.messages)
    && Array.isArray(state.seenMessageIds)
    && typeof state.updatedAt === "string"
    && Number.isFinite(Date.parse(state.updatedAt));
}

export async function listOpenClawCleanerSessions(
  stateDir: string,
): Promise<ContextCleanerSession[]> {
  const root = canonicalStateDir(stateDir);
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const sessions = await Promise.all(names
    .filter((name) => name.endsWith(".json"))
    .map(async (name): Promise<ContextCleanerSession | undefined> => {
      try {
        const parsed: unknown = JSON.parse(await readFile(join(root, name), "utf8"));
        if (!isCanonicalState(parsed)) return undefined;
        return { sessionId: parsed.sessionId, updatedAt: parsed.updatedAt };
      } catch {
        return undefined;
      }
    }));

  return sessions
    .filter((session): session is ContextCleanerSession => session !== undefined)
    .sort((left, right) => {
      const byTime = Date.parse(right.updatedAt ?? "") - Date.parse(left.updatedAt ?? "");
      return byTime || left.sessionId.localeCompare(right.sessionId);
    });
}
