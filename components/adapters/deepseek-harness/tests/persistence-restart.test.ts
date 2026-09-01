import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { createEmptySessionTaskRegistry } from "@lightrsi/history";
import type { SemanticTaskUpdate, TaskStateEstimator } from "@lightrsi/eviction";

import {
  runDshEvictionCycle,
  type CycleSession,
  type EvictionCycleResult,
} from "../src/eviction-cycle.js";
import {
  createTokenPilotProjectionDefinition,
  type TokenPilotProjection,
  type TokenPilotTransactionStatus,
} from "../src/projection.js";
import type {
  AppendOptions,
  AppendedEvent,
  AppendableSession,
} from "../src/surface-transaction.js";
import type { DshLogEventWithMeta } from "../src/types.js";

type SurfaceOp =
  | "append"
  | { op: "replace"; start: number; end: number };

type StoredEvent = DshLogEventWithMeta & {
  time: number;
  surfaceOp?: SurfaceOp;
  sourceEventSeqs?: readonly number[];
};

interface SessionHeaderRecord {
  type: "session";
  version: 0;
  id: string;
  createdAt: number;
  cwd: string;
  delegationDepth: 0;
}

interface TestEnvironment {
  root: string;
  dshHome: string;
  workspace: string;
  port: number;
}

interface ScenarioResult {
  environment: TestEnvironment;
  session: JsonlSession;
  cycle?: EvictionCycleResult;
  beforeTokens: number;
  afterTokens: number;
  projection: TokenPilotProjection;
}

const roots: string[] = [];
const originalDshHome = process.env.DSH_HOME;

afterEach(() => {
  if (originalDshHome === undefined) {
    delete process.env.DSH_HOME;
  } else {
    process.env.DSH_HOME = originalDshHome;
  }

  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function reserveDynamicPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("dynamic TCP port was not allocated"));
        return;
      }

      const port = address.port;

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function createEnvironment(label: string): Promise<TestEnvironment> {
  const root = mkdtempSync(join(tmpdir(), `lightrsi-dsh-${label}-`));
  const dshHome = join(root, "dsh-home");
  const workspace = join(root, "workspace");
  const port = await reserveDynamicPort();

  roots.push(root);
  mkdirSync(dshHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  process.env.DSH_HOME = dshHome;

  assert.equal(process.env.DSH_HOME, dshHome);
  assert.ok(port > 0);

  return { root, dshHome, workspace, port };
}

function eventText(value: unknown): string {
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value.map(eventText).join("");
  }

  if (value === null || typeof value !== "object") return "";

  const record = value as Record<string, unknown>;
  const ownText = typeof record.text === "string" ? record.text : "";
  const contentText = eventText(record.content);

  return ownText + contentText;
}

function messageForEvent(event: StoredEvent): unknown {
  const data = event.data;

  if (event.type === "user/message") return data;

  if (
    (event.type === "assistant/message" || event.type === "tool/result") &&
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data)
  ) {
    return (data as Record<string, unknown>).message;
  }

  return undefined;
}

function foldSurface(events: readonly StoredEvent[]): {
  nodes: number[];
  replaceGeneration: number;
} {
  const nodes: number[] = [];
  let replaceGeneration = 0;

  for (const event of events) {
    if (event.surfaceOp === "append") {
      nodes.push(event.seq);
      continue;
    }

    if (event.surfaceOp === undefined) continue;

    const startIndex = nodes.indexOf(event.surfaceOp.start);
    const endIndex = nodes.indexOf(event.surfaceOp.end);

    if (startIndex < 0 || endIndex < startIndex) {
      throw new Error(
        `invalid persisted surface replacement ${event.surfaceOp.start}..${event.surfaceOp.end}`,
      );
    }

    nodes.splice(startIndex, endIndex - startIndex + 1, event.seq);
    replaceGeneration += 1;
  }

  return { nodes, replaceGeneration };
}

class JsonlSession implements CycleSession {
  readonly events: StoredEvent[];
  readonly surface: { nodes: number[]; replaceGeneration: number };
  private replacementAttempts = 0;
  private failReplacementAt: number | undefined;

  private constructor(
    readonly id: string,
    readonly file: string,
    events: StoredEvent[],
  ) {
    this.events = events;
    this.surface = foldSurface(events);
  }

  static create(
    environment: TestEnvironment,
    id: string,
    seed: readonly StoredEvent[],
  ): JsonlSession {
    const file = join(environment.dshHome, "sessions", id, "session.jsonl");

    mkdirSync(dirname(file), { recursive: true });

    const header: SessionHeaderRecord = {
      type: "session",
      version: 0,
      id,
      createdAt: 1_800_000_000_000,
      cwd: environment.workspace,
      delegationDepth: 0,
    };

    writeFileSync(
      file,
      [header, ...seed].map((row) => JSON.stringify(row)).join("\n") + "\n",
      "utf8",
    );

    return new JsonlSession(id, file, structuredClone([...seed]));
  }

  static load(file: string): JsonlSession {
    const rows = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);

    const header = rows.shift() as SessionHeaderRecord | undefined;

    assert.equal(header?.type, "session");
    assert.equal(header.version, 0);

    const events = rows as StoredEvent[];

    events.forEach((event, index) => {
      assert.equal(event.seq, index, `durable event seq ${index}`);
    });

    return new JsonlSession(header.id, file, events);
  }

  failOnReplacement(attempt: number): void {
    assert.ok(Number.isSafeInteger(attempt) && attempt > 0);
    this.failReplacementAt = attempt;
  }

  get nextSeq(): number {
    return this.events.length;
  }

  append(type: string, data: unknown, options?: AppendOptions): AppendedEvent {
    if (options?.surfaceOp !== undefined) {
      this.replacementAttempts += 1;

      if (this.replacementAttempts === this.failReplacementAt) {
        throw new Error(`synthetic append failure ${this.replacementAttempts}`);
      }
    }

    const event = {
      type,
      seq: this.nextSeq,
      time: 1_800_000_000_000 + this.nextSeq,
      data: structuredClone(data),
      ...(options?.surfaceOp === undefined
        ? {}
        : { surfaceOp: structuredClone(options.surfaceOp) }),
      ...(options?.sourceEventSeqs === undefined
        ? {}
        : { sourceEventSeqs: [...options.sourceEventSeqs] }),
    } as unknown as StoredEvent;

    this.events.push(event);
    this.applySurfaceEvent(event);
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");

    return { seq: event.seq };
  }

  appendProjectionState(
    input: Omit<TokenPilotProjection, "lastTransaction"> & {
      transaction: {
        evictionId: string;
        status: TokenPilotTransactionStatus;
        appliedSourceEventSeqs: number[];
      };
    },
  ): number {
    const seq = this.nextSeq;
    const event = {
      type: "tokenpilot/state",
      seq,
      time: 1_800_000_000_000 + seq,
      ignorable: true,
      data: {
        enabled: input.enabled,
        lastEstimatorRun: input.lastEstimatorRun,
        candidateCount: input.candidateCount,
        estimatedTokens: input.estimatedTokens,
        appliedTokens: input.appliedTokens,
        deferredReasons: input.deferredReasons,
        lastTransaction: {
          evictionId: input.transaction.evictionId,
          status: input.transaction.status,
          sourceEventSeq: seq,
          appliedSourceEventSeqs: input.transaction.appliedSourceEventSeqs,
        },
      },
    } as unknown as StoredEvent;

    this.events.push(event);
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");

    return seq;
  }

  deriveMessages(): string[] {
    const bySeq = new Map(this.events.map((event) => [event.seq, event]));

    return this.surface.nodes
      .map((seq) => bySeq.get(seq))
      .filter((event): event is StoredEvent => event !== undefined)
      .map((event) => eventText(messageForEvent(event)))
      .filter((text) => text.length > 0);
  }

  private applySurfaceEvent(event: StoredEvent): void {
    if (event.surfaceOp === "append") {
      this.surface.nodes.push(event.seq);
      return;
    }

    if (event.surfaceOp === undefined) return;

    const startIndex = this.surface.nodes.indexOf(event.surfaceOp.start);
    const endIndex = this.surface.nodes.indexOf(event.surfaceOp.end);

    if (startIndex < 0 || endIndex < startIndex) {
      throw new Error(
        `invalid live surface replacement ${event.surfaceOp.start}..${event.surfaceOp.end}`,
      );
    }

    this.surface.nodes.splice(
      startIndex,
      endIndex - startIndex + 1,
      event.seq,
    );
    this.surface.replaceGeneration += 1;
  }
}

class DurableTokenMeter {
  measure(session: JsonlSession): number {
    const characters = session
      .deriveMessages()
      .reduce((total, message) => total + message.length, 0);

    return Math.ceil(characters / 4);
  }
}

function userMessage(id: string, text: string): Record<string, unknown> {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

function assistantMessage(id: string, text: string): Record<string, unknown> {
  return {
    turn: 1,
    step: 1,
    message: {
      id,
      role: "assistant",
      content: [{ type: "text", text }],
      source: {
        kind: "model",
        provider: "fixture-provider",
        model: "fixture-model",
      },
    },
  };
}

function seedEvents(): StoredEvent[] {
  const rows: Array<Omit<StoredEvent, "time">> = [
    { seq: 0, type: "turn/start", data: { turn: 1 } },
    {
      seq: 1,
      type: "user/message",
      data: userMessage(
        "message-evict-user",
        "EVICT_ME_11111111-1111-4111-8111-111111111111 completed user context",
      ),
      surfaceOp: "append",
    },
    {
      seq: 2,
      type: "assistant/message",
      data: assistantMessage(
        "message-evict-assistant",
        "EVICT_ME_22222222-2222-4222-8222-222222222222 completed assistant context",
      ),
      surfaceOp: "append",
    },
    { seq: 3, type: "turn/end", data: { turn: 1 } },
    { seq: 4, type: "turn/start", data: { turn: 2 } },
    {
      seq: 5,
      type: "user/message",
      data: userMessage(
        "message-keep-active",
        "KEEP_ME_33333333-3333-4333-8333-333333333333 active context",
      ),
      surfaceOp: "append",
    },
    { seq: 6, type: "turn/end", data: { turn: 2 } },
    { seq: 7, type: "turn/start", data: { turn: 3 } },
    {
      seq: 8,
      type: "user/message",
      data: userMessage(
        "message-keep-current",
        "KEEP_ME_44444444-4444-4444-8444-444444444444 current context",
      ),
      surfaceOp: "append",
    },
  ];

  return rows.map((row) => ({
    ...row,
    time: 1_800_000_000_000 + row.seq,
  })) as StoredEvent[];
}

function estimator(mode: "completed" | "active" | "failure"): TaskStateEstimator {
  return {
    estimate: async () => {
      if (mode === "failure") {
        throw new Error("synthetic estimator failure");
      }

      const completed = mode === "completed";
      const taskUpdates: SemanticTaskUpdate[] = [
        {
          taskId: "task-turn-1",
          objective: "synthetic completed task",
          lifecycle: completed ? "completed" : "active",
          coveredTurnAbsIds: ["restart-session:t1"],
          ...(completed
            ? { completionEvidence: ["synthetic completion evidence"] }
            : {}),
        },
        {
          taskId: "task-turn-2",
          objective: "synthetic active task",
          lifecycle: "active",
          coveredTurnAbsIds: ["restart-session:t2"],
        },
        {
          taskId: "task-turn-3",
          objective: "synthetic current task",
          lifecycle: "active",
          coveredTurnAbsIds: ["restart-session:t3"],
        },
      ];

      return { baseVersion: 0, taskUpdates };
    },
  };
}

function revision(session: AppendableSession): string {
  const events = (session as CycleSession).events;

  return [
    session.id,
    events.at(-1)?.seq ?? -1,
    session.surface.replaceGeneration,
    session.surface.nodes.join(","),
  ].join("|");
}

function registryPath(environment: TestEnvironment, sessionId: string): string {
  return join(environment.dshHome, "tokenpilot", `${sessionId}.registry.json`);
}

function registryPersistence(environment: TestEnvironment, sessionId: string) {
  const path = registryPath(environment, sessionId);

  return {
    load: () => {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as ReturnType<
          typeof createEmptySessionTaskRegistry
        >;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return createEmptySessionTaskRegistry(sessionId);
      }
    },
    persist: (
      next: ReturnType<typeof createEmptySessionTaskRegistry>,
      expectedVersion: number,
    ) => {
      let currentVersion = 0;

      try {
        currentVersion = (
          JSON.parse(readFileSync(path, "utf8")) as { version: number }
        ).version;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      assert.equal(currentVersion, expectedVersion, "registry CAS version");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(next)}\n`, "utf8");
    },
  };
}

function replayProjection(events: readonly StoredEvent[]): TokenPilotProjection {
  const definition = createTokenPilotProjectionDefinition(true);
  let state = definition.init();

  for (const event of events) {
    state = definition.apply(state, event);
  }

  return definition.view(state);
}

function recordEvidence(
  session: JsonlSession,
  input: {
    status: TokenPilotTransactionStatus;
    evictionId: string;
    candidateCount: number;
    estimatedTokens: number;
    appliedTokens: number;
    deferredReasons: string[];
    appliedSourceEventSeqs: number[];
  },
): TokenPilotProjection {
  session.appendProjectionState({
    enabled: true,
    lastEstimatorRun: 1_800_000_010_000,
    candidateCount: input.candidateCount,
    estimatedTokens: input.estimatedTokens,
    appliedTokens: input.appliedTokens,
    deferredReasons: input.deferredReasons,
    transaction: {
      evictionId: input.evictionId,
      status: input.status,
      appliedSourceEventSeqs: input.appliedSourceEventSeqs,
    },
  });

  return replayProjection(session.events);
}

async function runScenario(input: {
  label: string;
  estimatorMode?: "completed" | "active" | "failure";
  computeRevision?: (session: AppendableSession) => string;
  failReplacementAt?: number;
  minBlockChars?: number;
  recordState?: boolean;
}): Promise<ScenarioResult> {
  const environment = await createEnvironment(input.label);
  const session = JsonlSession.create(
    environment,
    "restart-session",
    seedEvents(),
  );
  const meter = new DurableTokenMeter();
  const beforeTokens = meter.measure(session);
  const persistence = registryPersistence(environment, session.id);

  if (input.failReplacementAt !== undefined) {
    session.failOnReplacement(input.failReplacementAt);
  }

  let cycle: EvictionCycleResult | undefined;
  let failure: unknown;

  try {
    cycle = await runDshEvictionCycle({
      session,
      registry: persistence.load(),
      estimator: estimator(input.estimatorMode ?? "completed"),
      computeRevision: input.computeRevision ?? revision,
      evictionId: `eviction-${input.label}`,
      minBlockChars: input.minBlockChars,
      persistRegistry: persistence.persist,
    });
  } catch (error) {
    failure = error;
  }

  const afterTokens = meter.measure(session);

  if (input.estimatorMode === "failure") {
    assert.match(String(failure), /synthetic estimator failure/);
  } else {
    assert.equal(failure, undefined);
    assert.ok(cycle);
  }

  let projection = replayProjection(session.events);

  if (input.recordState !== false) {
    const appliedSourceEventSeqs = cycle?.result.appliedSeqs ?? [];
    const status: TokenPilotTransactionStatus =
      cycle?.result.status === "committed"
        ? "applied"
        : cycle?.result.status === "partial"
          ? "partial"
          : "deferred";
    const deferredReasons =
      input.estimatorMode === "failure"
        ? ["estimator-failure"]
        : input.failReplacementAt === 1
          ? ["append-failure"]
          : cycle?.result.deferReason !== undefined
            ? [cycle.result.deferReason]
            : cycle?.result.status === "empty"
              ? ["no-candidate"]
              : [];

    projection = recordEvidence(session, {
      status,
      evictionId: `eviction-${input.label}`,
      candidateCount:
        appliedSourceEventSeqs.length + (cycle?.result.failedSeqs.length ?? 0),
      estimatedTokens: Math.max(0, beforeTokens - afterTokens),
      appliedTokens: Math.max(0, beforeTokens - afterTokens),
      deferredReasons,
      appliedSourceEventSeqs,
    });
  }

  return {
    environment,
    session,
    cycle,
    beforeTokens,
    afterTokens,
    projection,
  };
}

function replacementEvents(session: JsonlSession): StoredEvent[] {
  return session.events.filter(
    (event) =>
      typeof event.surfaceOp === "object" &&
      event.surfaceOp.op === "replace" &&
      eventText(messageForEvent(event)).startsWith("[evicted:"),
  );
}

describe("DeepSeek Harness persistence/restart acceptance", () => {
  it("restores successful eviction from durable JSONL evidence", async () => {
    const lifecycleA = await runScenario({ label: "success" });

    assert.equal(lifecycleA.cycle?.result.status, "committed");
    assert.deepEqual(lifecycleA.cycle?.result.appliedSeqs, [1, 2]);
    assert.ok(lifecycleA.afterTokens < lifecycleA.beforeTokens);

    const lifecycleB = JsonlSession.load(lifecycleA.session.file);
    const restoredProjection = replayProjection(lifecycleB.events);
    const derived = lifecycleB.deriveMessages().join("\n");

    assert.doesNotMatch(derived, /EVICT_ME_/);
    assert.match(derived, /KEEP_ME_33333333/);
    assert.match(derived, /KEEP_ME_44444444/);
    assert.deepEqual(lifecycleB.surface, lifecycleA.session.surface);
    assert.deepEqual(restoredProjection, lifecycleA.projection);
    assert.equal(
      restoredProjection.appliedTokens,
      lifecycleA.beforeTokens - lifecycleA.afterTokens,
    );

    const replacements = replacementEvents(lifecycleB);
    assert.deepEqual(
      replacements.map((event) => event.sourceEventSeqs),
      [[1], [2]],
    );

    const rawLog = readFileSync(lifecycleA.session.file, "utf8");
    assert.match(rawLog, /EVICT_ME_11111111/);
    assert.match(rawLog, /EVICT_ME_22222222/);
  });

  it("restores a no-candidate lifecycle with zero surface mutation", async () => {
    const lifecycleA = await runScenario({
      label: "no-candidate",
      estimatorMode: "active",
    });

    assert.equal(lifecycleA.cycle?.result.status, "empty");
    assert.equal(replacementEvents(lifecycleA.session).length, 0);

    const lifecycleB = JsonlSession.load(lifecycleA.session.file);

    assert.deepEqual(lifecycleB.surface.nodes, [1, 2, 5, 8]);
    assert.equal(lifecycleB.surface.replaceGeneration, 0);
    assert.deepEqual(replayProjection(lifecycleB.events).deferredReasons, [
      "no-candidate",
    ]);
  });

  it("persists stale-revision deferral without writing a replacement", async () => {
    let reads = 0;
    const lifecycleA = await runScenario({
      label: "stale-revision",
      computeRevision: () => (reads++ === 0 ? "revision-a" : "revision-b"),
    });

    assert.equal(lifecycleA.cycle?.result.status, "deferred");
    assert.equal(lifecycleA.cycle?.result.deferReason, "revision-changed");
    assert.equal(replacementEvents(lifecycleA.session).length, 0);

    const lifecycleB = JsonlSession.load(lifecycleA.session.file);
    assert.deepEqual(replayProjection(lifecycleB.events).deferredReasons, [
      "revision-changed",
    ]);
  });

  it("persists estimator failure as fail-open evidence", async () => {
    const lifecycleA = await runScenario({
      label: "estimator-failure",
      estimatorMode: "failure",
    });

    assert.equal(replacementEvents(lifecycleA.session).length, 0);
    assert.deepEqual(lifecycleA.session.surface.nodes, [1, 2, 5, 8]);

    const lifecycleB = JsonlSession.load(lifecycleA.session.file);
    assert.deepEqual(replayProjection(lifecycleB.events).deferredReasons, [
      "estimator-failure",
    ]);
  });

  it("persists first-append failure with no canonical mutation", async () => {
    const lifecycleA = await runScenario({
      label: "append-failure",
      failReplacementAt: 1,
    });

    assert.equal(lifecycleA.cycle?.result.status, "deferred");
    assert.deepEqual(lifecycleA.cycle?.result.appliedSeqs, []);
    assert.equal(replacementEvents(lifecycleA.session).length, 0);

    const lifecycleB = JsonlSession.load(lifecycleA.session.file);
    assert.deepEqual(replayProjection(lifecycleB.events).deferredReasons, [
      "append-failure",
    ]);
  });

  it("restores only the replacement that landed during a partial commit", async () => {
    const lifecycleA = await runScenario({
      label: "partial-commit",
      failReplacementAt: 2,
    });

    assert.equal(lifecycleA.cycle?.result.status, "partial");
    assert.deepEqual(lifecycleA.cycle?.result.appliedSeqs, [1]);
    assert.deepEqual(lifecycleA.cycle?.result.failedSeqs, [2]);

    const lifecycleB = JsonlSession.load(lifecycleA.session.file);
    const derived = lifecycleB.deriveMessages().join("\n");
    const restoredProjection = replayProjection(lifecycleB.events);

    assert.doesNotMatch(derived, /EVICT_ME_11111111/);
    assert.match(derived, /EVICT_ME_22222222/);
    assert.equal(restoredProjection.lastTransaction?.status, "partial");
    assert.deepEqual(
      restoredProjection.lastTransaction?.appliedSourceEventSeqs,
      [1],
    );
  });

  it(
    "settles an orphaned replacement transaction after restart without continuing it",
    async () => {
      const lifecycleA = await runScenario({
        label: "orphaned",
        failReplacementAt: 2,
        recordState: false,
      });

      assert.equal(lifecycleA.cycle?.result.status, "partial");
      assert.equal(
        lifecycleA.session.events.some(
          (event) => event.type === "tokenpilot/state",
        ),
        false,
      );

      const lifecycleB = JsonlSession.load(lifecycleA.session.file);
      const replacementsBeforeRecovery = replacementEvents(lifecycleB);

      assert.equal(replacementsBeforeRecovery.length, 1);

      const restoredBeforeRecovery = replayProjection(lifecycleB.events);

      recordEvidence(lifecycleB, {
        status: "partial",
        evictionId:
          restoredBeforeRecovery.lastTransaction?.evictionId ??
          "eviction-orphaned",
        candidateCount: 2,
        estimatedTokens: lifecycleA.beforeTokens - lifecycleA.afterTokens,
        appliedTokens: lifecycleA.beforeTokens - lifecycleA.afterTokens,
        deferredReasons: ["orphaned-transaction"],
        appliedSourceEventSeqs: [1],
      });

      const lifecycleC = JsonlSession.load(lifecycleA.session.file);

      assert.equal(replacementEvents(lifecycleC).length, 1);
      assert.deepEqual(replayProjection(lifecycleC.events).deferredReasons, [
        "orphaned-transaction",
      ]);
    },
  );

  it("preserves TokenPilot evidence when native compaction runs afterward", async () => {
    const lifecycleA = await runScenario({ label: "compaction" });
    const tokenPilotProjection = lifecycleA.projection;

    lifecycleA.session.append(
      "assistant/message",
      {
        turn: 3,
        step: 1,
        message: {
          id: "native-compaction-summary",
          role: "assistant",
          content: [
            {
              type: "text",
              text: "KEEP_ME_55555555-5555-4555-8555-555555555555 compacted summary",
            },
          ],
          source: {
            kind: "plugin",
            plugin: "dsh-compaction-basic",
          },
        },
      },
      {
        surfaceOp: { op: "replace", start: 8, end: 8 },
        sourceEventSeqs: [8],
      },
    );

    const lifecycleB = JsonlSession.load(lifecycleA.session.file);
    const derived = lifecycleB.deriveMessages().join("\n");

    assert.match(derived, /compacted summary/);
    assert.doesNotMatch(derived, /EVICT_ME_/);
    assert.deepEqual(replayProjection(lifecycleB.events), tokenPilotProjection);
    assert.equal(lifecycleB.surface.replaceGeneration, 3);
  });
});
