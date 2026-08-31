import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createTokenPilotProjectionDefinition,
  registerTokenPilotProjection,
  type TokenPilotProjection,
  type TokenPilotProjectionDefinition,
} from "../src/projection.js";

import {
  executeTokenPilotStatusCommand,
  registerTokenPilotCommands,
  type TokenPilotCommandContext,
  type TokenPilotCommandDefinition,
} from "../src/commands.js";

import type {
  DshLogEventWithMeta,
  DshSession,
} from "../src/types.js";

function createSession(
  events: readonly DshLogEventWithMeta[],
): DshSession {
  return {
    id: "session-projection-test",
    events,
    surface: {
      replaceGeneration: 1,
    },
  };
}

function createAppliedReplacementEvent():
  DshLogEventWithMeta {
  return {
    seq: 3,
    time: 1_800_000_000_000,
    type: "assistant/message",

    surfaceOp: {
      op: "replace",
      start: 2,
      end: 2,
    },

    sourceEventSeqs: [2],

    data: {
      turn: 1,
      step: 1,

      message: {
        id: "lightrsi-eviction-test-3",
        role: "assistant",

        content: [
          {
            type: "text",
            text: "[evicted: completed task @2]",
          },
        ],

        source: {
          kind: "plugin",
          plugin: "tokenpilot-dsh",

          tokenpilot: {
            evictionId: "eviction-test",
            lastEstimatorRun:
              1_800_000_000_000,
            candidateCount: 3,
            estimatedTokens: 180,
            appliedTokens: 120,
            deferredReasons: [],
          },
        },
      },
    },
  } as unknown as DshLogEventWithMeta;
}

function createFullSeed():
  DshLogEventWithMeta[] {
  return [
    {
      seq: 1,
      type: "turn/start",
      data: {
        turn: 1,
      },
    },

    {
      seq: 2,
      type: "user/message",
      data: {
        role: "user",
        content: [
          {
            type: "text",
            text: "A completed task that may be evicted.",
          },
        ],
      },
    },

    createAppliedReplacementEvent(),

    {
      seq: 4,
      type: "command/run",
      data: {
        commandId: "command-before-status",
        name: "unrelated-command",
        source: {
          kind: "user",
        },
      },
      ignorable: true,
    },
  ];
}

function replay(
  events: readonly DshLogEventWithMeta[],
  enabled = true,
): TokenPilotProjection {
  const definition =
    createTokenPilotProjectionDefinition(enabled);

  let state = definition.init();

  for (const event of events) {
    state = definition.apply(state, event);
  }

  return definition.view(state);
}

describe("TokenPilot session projection", () => {
  it("initializes a complete empty whole-session value", () => {
    const definition =
      createTokenPilotProjectionDefinition(false);

    assert.deepEqual(definition.init(), {
      enabled: false,
      lastEstimatorRun: null,
      candidateCount: null,
      estimatedTokens: null,
      appliedTokens: null,
      deferredReasons: [],
      lastTransaction: null,
    });

    assert.equal(definition.key, "tokenpilot");
    assert.equal(definition.stateVersion, 1);
  });

  it("replays the complete seed into evidence-backed applied state", () => {
    const projection = replay(createFullSeed());

    assert.deepEqual(projection, {
      enabled: true,
      lastEstimatorRun:
        1_800_000_000_000,
      candidateCount: 3,
      estimatedTokens: 180,
      appliedTokens: 120,
      deferredReasons: [],

      lastTransaction: {
        evictionId: "eviction-test",
        status: "applied",
        sourceEventSeq: 3,
        appliedSourceEventSeqs: [2],
      },
    });
  });

  it("returns the same state reference for unrelated events", () => {
    const definition =
      createTokenPilotProjectionDefinition(true);

    const initial = definition.init();

    const next = definition.apply(initial, {
      seq: 1,
      type: "turn/start",
      data: {
        turn: 1,
      },
    });

    assert.equal(
      next,
      initial,
      "unrelated events must not publish a changed projection",
    );
  });

  it("accepts a complete deferred whole-value state event", () => {
    const definition =
      createTokenPilotProjectionDefinition(true);

    const event = {
      seq: 8,
      type: "tokenpilot/state",

      data: {
        enabled: true,
        lastEstimatorRun:
          1_800_000_100_000,
        candidateCount: 4,
        estimatedTokens: 500,
        appliedTokens: 0,

        deferredReasons: [
          "minimum-pending-turns",
        ],

        lastTransaction: {
          evictionId: "eviction-deferred",
          status: "deferred",
          sourceEventSeq: 8,
          appliedSourceEventSeqs: [],
        },
      },
    } as unknown as DshLogEventWithMeta;

    const projection = definition.apply(
      definition.init(),
      event,
    );

    assert.deepEqual(projection, {
      enabled: true,
      lastEstimatorRun:
        1_800_000_100_000,
      candidateCount: 4,
      estimatedTokens: 500,
      appliedTokens: 0,

      deferredReasons: [
        "minimum-pending-turns",
      ],

      lastTransaction: {
        evictionId: "eviction-deferred",
        status: "deferred",
        sourceEventSeq: 8,
        appliedSourceEventSeqs: [],
      },
    });
  });

  it("registers through ctx.sessionProjections.register", () => {
    let registered:
      | TokenPilotProjectionDefinition
      | undefined;

    let disposed = false;

    const dispose =
      registerTokenPilotProjection(
        {
          sessionProjections: {
            register: (definition) => {
              registered = definition;

              return () => {
                disposed = true;
              };
            },
          },
        },
        true,
      );

    assert.ok(registered);
    assert.equal(registered.key, "tokenpilot");
    assert.equal(
      registered.init().enabled,
      true,
    );

    dispose();

    assert.equal(disposed, true);
  });
});

describe("TokenPilot status command", () => {
  it("returns rich state and its authoritative source event", async () => {
    const events = createFullSeed();
    const session = createSession(events);
    const projection = replay(events);

    let registered:
      | TokenPilotCommandDefinition
      | undefined;

    let disposed = false;
    let snapshotCalls = 0;

    const ctx: TokenPilotCommandContext = {
      commands: {
        register: (definition) => {
          registered = definition;

          return () => {
            disposed = true;
          };
        },
      },

      sessionProjections: {
        snapshot: (receivedSession) => {
          snapshotCalls += 1;

          assert.equal(
            receivedSession,
            session,
          );

          return {
            asOfSeq: 4,
            values: {
              tokenpilot: projection,
            },
          };
        },
      },
    };

    const dispose =
      registerTokenPilotCommands(ctx);

    assert.ok(registered);

    assert.equal(
      registered.name,
      "tokenpilot-status",
    );

    assert.equal(
      registered.recordInput,
      false,
    );

    /*
     * The mock agent intentionally exposes only a session.
     * There is no prompt(), run(), or model-turn method.
     */
    const result = await registered.handler({
      commandId: "command-status-1",

      agent: {
        session,
      },

      rawInput: "",

      signal: {
        aborted: false,
      },
    });

    if (result.kind !== "success") {
      assert.fail(result.text);
    }

    assert.equal(
      result.sourceEventSeq,
      3,
    );

    assert.match(
      result.text ?? "",
      /enabled: yes/u,
    );

    assert.match(
      result.text ?? "",
      /estimated: 180 token\(s\)/u,
    );

    assert.match(
      result.text ?? "",
      /scheduled: 3 candidate\(s\) \(applied\)/u,
    );

    assert.match(
      result.text ?? "",
      /applied: 120 token\(s\), evidence-backed/u,
    );

    assert.match(
      result.text ?? "",
      /authoritative event seq: 3/u,
    );

    assert.equal(snapshotCalls, 1);

    dispose();

    assert.equal(disposed, true);
  });

  it("rejects unexpected command arguments before reading state", () => {
    const session = createSession([]);

    const ctx: TokenPilotCommandContext = {
      commands: {
        register: () => () => {},
      },

      sessionProjections: {
        snapshot: () => {
          throw new Error(
            "snapshot must not be read for invalid input",
          );
        },
      },
    };

    const result =
      executeTokenPilotStatusCommand(
        ctx,
        {
          commandId: "command-invalid-1",

          agent: {
            session,
          },

          rawInput: " unexpected",

          signal: {
            aborted: false,
          },
        },
      );

    assert.deepEqual(result, {
      kind: "error",
      text: "Usage: /tokenpilot-status",
    });
  });

  it("reports unavailable projection state without starting a model turn", () => {
    const session = createSession([]);

    const ctx: TokenPilotCommandContext = {
      commands: {
        register: () => () => {},
      },

      sessionProjections: {
        snapshot: () => ({
          asOfSeq: -1,
          values: {},
        }),
      },
    };

    const result =
      executeTokenPilotStatusCommand(
        ctx,
        {
          commandId: "command-empty-1",

          agent: {
            session,
          },

          rawInput: "",

          signal: {
            aborted: false,
          },
        },
      );

    assert.deepEqual(result, {
      kind: "error",
      text:
        "TokenPilot projection is unavailable for this session.",
    });
  });

  it("stops immediately when the command is cancelled", () => {
    const session = createSession([]);

    const ctx: TokenPilotCommandContext = {
      commands: {
        register: () => () => {},
      },

      sessionProjections: {
        snapshot: () => {
          throw new Error(
            "cancelled command must not read a snapshot",
          );
        },
      },
    };

    const result =
      executeTokenPilotStatusCommand(
        ctx,
        {
          commandId: "command-cancelled-1",

          agent: {
            session,
          },

          rawInput: "",

          signal: {
            aborted: true,
          },
        },
      );

    assert.deepEqual(result, {
      kind: "error",
      text:
        "TokenPilot status request was cancelled.",
    });
  });
});
