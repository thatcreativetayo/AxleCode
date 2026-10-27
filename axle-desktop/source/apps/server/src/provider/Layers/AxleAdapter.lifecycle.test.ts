// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
  type RuntimeMode,
} from "@axle/contracts";
import { it } from "@effect/vitest";
import { afterEach, describe, expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";

import { makeAxleAdapter, readAxleSessionBinding } from "./AxleAdapter.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  const { fileURLToPath } = await import("node:url");
  return {
    ...actual,
    spawn: vi.fn(
      (_binary: string, args: readonly string[], options: NodeChildProcess.SpawnOptions) =>
        actual.spawn(
          process.execPath,
          [fileURLToPath(new URL("./fixtures/axle-runtime.mjs", import.meta.url)), ...args],
          options,
        ),
    ),
  };
});

afterEach(() => vi.clearAllMocks());

const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
type RuntimeCall = {
  readonly args: ReadonlyArray<string>;
  readonly sessionId?: string;
  readonly prompt?: string;
  readonly interactionMode?: string;
};
const readRecords = (path: string): RuntimeCall[] =>
  NodeFS.readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => decodeJson(line) as RuntimeCall);
const threadId = ThreadId.make("runtime-continuity");
const instanceId = ProviderInstanceId.make("axle");

const makeHarness = (runtimeMode: RuntimeMode = "approval-required", failFirst = false) =>
  Effect.gen(function* () {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "axle-lifecycle-"));
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        for (const result of vi.mocked(NodeChildProcess.spawn).mock.results) {
          if (result.type !== "return") continue;
          const child = result.value;
          if (child.exitCode !== null || child.signalCode !== null) continue;
          await new Promise<void>((resolve) => {
            child.once("close", () => resolve());
            child.kill();
          });
        }
        NodeFS.rmSync(cwd, { recursive: true, force: true });
      }),
    );
    const options = {
      instanceId,
      binaryPath: "axle-test-fixture",
      attachmentsDir: cwd,
      environment: { ...process.env, AXLE_TEST_FAIL_FIRST: failFirst ? "1" : "0" },
    };
    const adapter = yield* makeAxleAdapter(options);
    const start = {
      threadId,
      cwd,
      runtimeMode,
      modelSelection: { instanceId, model: "openai/fixture" },
    };
    yield* adapter.startSession(start);
    return { cwd, adapter, options, start };
  });

const untilCompleted = (subscription: PubSub.Subscription<ProviderRuntimeEvent>) =>
  Effect.gen(function* () {
    const events: ProviderRuntimeEvent[] = [];
    while (true) {
      const event = yield* PubSub.take(subscription);
      events.push(event);
      if (event.type === "turn.completed") return { events, completed: event };
    }
  }).pipe(Effect.timeout("10 seconds"));

describe("Axle process lifecycle", () => {
  it.live("does not replay a persisted prompt after a pre-output transport failure", () =>
    Effect.gen(function* () {
      const { cwd, adapter } = yield* makeHarness("approval-required", true);
      const subscription = yield* adapter.subscribeEvents!;
      yield* adapter.sendTurn({ threadId, input: "Remember amber-orchid" });
      const failed = yield* untilCompleted(subscription);
      expect(failed.completed.payload.state).toBe("failed");
      expect(failed.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      expect(readRecords(NodePath.join(cwd, "runtime-calls.jsonl"))).toHaveLength(1);
      const session = (yield* adapter.listSessions())[0]!;
      expect(session.status).toBe("error");
      expect(session.activeTurnId).toBeUndefined();
      const sessionId = readAxleSessionBinding(cwd, String(threadId));
      expect(sessionId).toBeDefined();
      expect(readRecords(NodePath.join(cwd, ".axle", "sessions", `${sessionId}.jsonl`))).toEqual([
        { role: "user", text: "Remember amber-orchid" },
      ]);

      yield* adapter.sendTurn({ threadId, input: "What was the earlier fact?" });
      const continued = yield* untilCompleted(subscription);
      expect(continued.completed.payload.state).toBe("completed");
      expect(
        continued.events.some(
          (event) =>
            event.type === "item.completed" &&
            event.payload.detail === "The earlier fact was amber-orchid.",
        ),
      ).toBe(true);
      expect(readAxleSessionBinding(cwd, String(threadId))).toBe(sessionId);
      const calls = readRecords(NodePath.join(cwd, "runtime-calls.jsonl"));
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({
        sessionId,
        args: expect.arrayContaining(["--session", sessionId]),
      });
    }),
  );

  for (const runtimeMode of ["approval-required", "auto-accept-edits", "full-access"] as const) {
    it.live(
      `continues the same session after restart and settles the result in ${runtimeMode}`,
      () =>
        Effect.gen(function* () {
          const { cwd, adapter, options, start } = yield* makeHarness(runtimeMode);
          const subscription = yield* adapter.subscribeEvents!;
          yield* adapter.sendTurn({ threadId, input: "Remember amber-orchid" });
          const first = yield* untilCompleted(subscription);
          expect(first.completed.payload.state).toBe("completed");
          const session = (yield* adapter.listSessions())[0]!;
          expect(session.status).toBe("ready");
          expect(session.activeTurnId).toBeUndefined();
          // The persistent runtime stays warm between turns. It is only
          // stopped when the session is explicitly stopped.
          expect(vi.mocked(NodeChildProcess.spawn).mock.results[0]?.value.killed).toBe(false);
          const assistantIndex = first.events.findIndex(
            (event) =>
              event.type === "item.completed" && event.payload.itemType === "assistant_message",
          );
          expect(assistantIndex).toBeGreaterThan(-1);
          expect(assistantIndex).toBeLessThan(first.events.length - 1);
          yield* adapter.stopAll();

          const restarted = yield* makeAxleAdapter(options);
          const resumed = yield* restarted.startSession(start);
          expect(resumed.resumeCursor).toEqual(session.resumeCursor);
          const resumedEvents = yield* restarted.subscribeEvents!;
          yield* restarted.sendTurn({ threadId, input: "What was the earlier fact?" });
          const second = yield* untilCompleted(resumedEvents);
          expect(second.completed.payload.state).toBe("completed");
          expect(
            second.events.some(
              (event) =>
                event.type === "item.completed" &&
                event.payload.detail === "The earlier fact was amber-orchid.",
            ),
          ).toBe(true);
          const calls = readRecords(NodePath.join(cwd, "runtime-calls.jsonl"));
          expect(calls).toHaveLength(2);
          for (const call of calls)
            expect(call).toMatchObject({
              args: expect.arrayContaining(["--runtime-mode", runtimeMode, "--approval-file"]),
            });
          expect(calls[1]).toMatchObject({
            args: expect.arrayContaining([
              "--session",
              readAxleSessionBinding(cwd, String(threadId)),
            ]),
          });
          const settled = (yield* restarted.listSessions())[0]!;
          expect(settled.status).toBe("ready");
          expect(settled.activeTurnId).toBeUndefined();
        }),
    );
  }

  it.live("reuses one persistent process across follow-up turns", () =>
    Effect.gen(function* () {
      const { cwd, adapter } = yield* makeHarness();
      const subscription = yield* adapter.subscribeEvents!;
      yield* adapter.sendTurn({ threadId, input: "Remember amber-orchid" });
      const first = yield* untilCompleted(subscription);
      expect(first.completed.payload.state).toBe("completed");

      const child = vi.mocked(NodeChildProcess.spawn).mock.results[0]?.value;
      expect(child?.killed).toBe(false);

      yield* adapter.sendTurn({ threadId, input: "What was the earlier fact?" });
      const second = yield* untilCompleted(subscription);
      expect(second.completed.payload.state).toBe("completed");
      expect(
        second.events.some(
          (event) =>
            event.type === "item.completed" &&
            event.payload.detail === "The earlier fact was amber-orchid.",
        ),
      ).toBe(true);
      expect(NodeChildProcess.spawn).toHaveBeenCalledTimes(1);
      expect(child?.killed).toBe(false);

      const calls = readRecords(NodePath.join(cwd, "runtime-calls.jsonl"));
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        args: expect.arrayContaining(["--persistent-json-stream"]),
      });
      expect(calls[0]?.args).not.toContain("--prompt-stdin");

      yield* adapter.stopAll();
      expect(child?.killed).toBe(true);
    }),
  );

  it.live("restarts the persistent process when process arguments change", () =>
    Effect.gen(function* () {
      const { cwd, adapter } = yield* makeHarness();
      const subscription = yield* adapter.subscribeEvents!;
      yield* adapter.sendTurn({ threadId, input: "Remember amber-orchid" });
      const first = yield* untilCompleted(subscription);
      expect(first.completed.payload.state).toBe("completed");

      const firstChild = vi.mocked(NodeChildProcess.spawn).mock.results[0]?.value;
      yield* adapter.sendTurn({
        threadId,
        input: "What was the earlier fact?",
        modelSelection: { instanceId, model: "openai/other-fixture" },
      });
      const second = yield* untilCompleted(subscription);
      expect(second.completed.payload.state).toBe("completed");
      expect(NodeChildProcess.spawn).toHaveBeenCalledTimes(2);
      expect(firstChild?.killed).toBe(true);

      const calls = readRecords(NodePath.join(cwd, "runtime-calls.jsonl"));
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({
        args: expect.arrayContaining([
          "--model",
          "other-fixture",
          "--session",
          readAxleSessionBinding(cwd, String(threadId)),
        ]),
      });
    }),
  );
});
