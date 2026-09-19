import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { apply, inject, name } from "../src/index.js";
import type { DshPluginContext } from "../src/types.js";

type OptionalContext = {
  inject?: (services: readonly string[], callback: (ctx: unknown) => void) => void;
};

const CONFIGURED = {
  enabled: true,
  stateDir: "C:/tmp/lightrsi-index-test",
  eviction: { enabled: true },
  taskStateEstimator: { baseUrl: "https://api.example.com", apiKey: "sk-x", model: "m" },
};

function injectedRoot(events: string[], commands: string[]) {
  const commandContext: OptionalContext & {
    commands: { register(definition: { name: string }): () => void };
  } = {
    commands: {
      register(definition) {
        commands.push(definition.name);
        return () => {};
      },
    },
    inject(services, callback) {
      if (services.includes("sessions")) callback({ sessions: { list: () => [], get: () => undefined } });
      if (services.includes("sessionProjections")) {
        callback({
          sessionProjections: {
            register: () => () => {},
            snapshot: () => ({ asOfSeq: -1, values: {} }),
          },
        });
      }
    },
  };
  const runtime: DshPluginContext = {
    on(event) { events.push(event); },
    tokenMeter: { measure: () => ({}) },
  };
  return {
    inject(services: readonly string[], callback: (ctx: unknown) => void) {
      if (services.includes("commands")) callback(commandContext);
      if (services.includes("tokenMeter")) callback(runtime);
    },
  } satisfies OptionalContext;
}

describe("plugin entry (install smoke)", () => {
  it("exposes a headless-safe Cordis name + empty root inject metadata", () => {
    assert.equal(name, "tokenpilot-dsh");
    assert.deepEqual(inject, []);
  });

  it("attaches Cleaner, eviction, and commands only after their optional services arrive", () => {
    const events: string[] = [];
    const commands: string[] = [];
    apply(injectedRoot(events, commands), CONFIGURED);
    assert.deepEqual(events, ["agent/pre-step", "agent/pre-step"]);
    assert.deepEqual(commands.sort(), ["context-cleaner", "tokenpilot-clean", "tokenpilot-status"]);
  });

  it("is safe in a headless profile where optional services are absent", () => {
    assert.doesNotThrow(() => apply({}, CONFIGURED));
  });

  it("keeps read-only commands available but attaches no mutation handlers when the master flag is off", () => {
    const events: string[] = [];
    const commands: string[] = [];
    apply(injectedRoot(events, commands), { enabled: false, eviction: { enabled: true } });
    assert.deepEqual(events, []);
    assert.deepEqual(commands.sort(), ["context-cleaner", "tokenpilot-clean", "tokenpilot-status"]);
  });

  it("tolerates missing/garbage config (defaults to off, attaches nothing)", () => {
    for (const junk of [undefined, null, "nope", 42, []]) {
      assert.doesNotThrow(() => apply({}, junk));
    }
  });
});
