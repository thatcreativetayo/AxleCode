import { CloudJob, CloudSchedule, CloudScheduleInput, ProviderInstanceId } from "@axle/contracts";
import { describe, expect, it } from "@effect/vitest";

import { CloudJobsApiError } from "./jobs.ts";
import { CloudSchedulesClient } from "./schedules.ts";

const revision = "a".repeat(40);

const sampleSchedule: CloudSchedule = {
  scheduleId: "schedule-1",
  title: "Dependency hygiene",
  prompt: "Update dependencies and run the test suite.",
  environmentId: "linux-standard",
  repositoryUrl: "https://github.com/example/repo.git",
  sourceRef: "main",
  providerInstanceId: ProviderInstanceId.make("anthropic-default"),
  model: "claude-sonnet-4-5",
  frequency: "weekly",
  intervalHours: 1,
  time: "09:00",
  dayOfWeek: "monday",
  date: "",
  timeZone: "Africa/Lagos",
  active: true,
  sourceRevision: revision,
  nextRunAt: "2026-10-26T08:00:00.000Z",
  lastJobId: null,
  lastError: null,
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:00:00.000Z",
};

const sampleInput: CloudScheduleInput = {
  scheduleId: "schedule-1",
  title: "Dependency hygiene",
  prompt: "Update dependencies and run the test suite.",
  environmentId: "linux-standard",
  repositoryUrl: "https://github.com/example/repo.git",
  sourceRef: "main",
  providerInstanceId: ProviderInstanceId.make("anthropic-default"),
  model: "claude-sonnet-4-5",
  frequency: "weekly",
  intervalHours: 1,
  time: "09:00",
  dayOfWeek: "monday",
  date: "",
  timeZone: "Africa/Lagos",
  active: true,
};

const sampleJob = {
  jobId: "job-1",
  state: "queued",
  runtimeMode: "full-access",
  scheduleId: "schedule-1",
  input: {
    commandId: "scheduled-1",
    environmentId: "linux-standard",
    repositoryUrl: "https://github.com/example/repo.git",
    sourceRevision: revision,
    prompt: "Update dependencies and run the test suite.",
    providerInstanceId: ProviderInstanceId.make("anthropic-default"),
    model: "claude-sonnet-4-5",
    runtimeMode: "approval-required",
    interactionMode: "default",
  },
  limits: {
    maxDurationSeconds: 3600,
    maxEvents: 500,
    cpuMillis: 2_000,
    memoryMb: 4_096,
    diskMb: 8_192,
    networkPolicy: "restricted",
  },
  generation: 0,
  createdAt: "2026-10-19T08:00:00.000Z",
  updatedAt: "2026-10-19T08:00:00.000Z",
  deadlineAt: "2026-10-19T09:00:00.000Z",
  cancelRequestedAt: null,
  pendingRequest: null,
  result: null,
  failureCode: null,
  lastSequence: 0,
} satisfies CloudJob;

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createClient(options: {
  readonly token?: string | null;
  readonly handle?: (call: CapturedCall) => Response | Promise<Response>;
}): { readonly client: CloudSchedulesClient; readonly calls: Array<CapturedCall> } {
  const calls: Array<CapturedCall> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return options.handle ? await options.handle(call) : jsonResponse(200, {});
  }) as typeof globalThis.fetch;
  const token = options.token === undefined ? "token-123" : options.token;
  const client = new CloudSchedulesClient(
    { baseUrl: "https://accounts.example.com", getToken: async () => token },
    fetchImpl,
  );
  return { client, calls };
}

describe("CloudSchedulesClient", () => {
  it("lists schedules with the bearer token and decoded contracts", async () => {
    const { client, calls } = createClient({
      handle: () => jsonResponse(200, { schedules: [sampleSchedule] }),
    });
    const schedules = await client.listSchedules();
    expect(schedules).toEqual([sampleSchedule]);
    expect(calls[0]?.url).toBe("https://accounts.example.com/v1/cloud/schedules");
    expect((calls[0]?.init?.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer token-123",
    );
    expect(calls[0]?.init?.credentials).toBe("omit");
  });

  it("saves a schedule by posting the documented input", async () => {
    const { client, calls } = createClient({ handle: () => jsonResponse(200, sampleSchedule) });
    const saved = await client.saveSchedule(sampleInput);
    expect(saved).toEqual(sampleSchedule);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(sampleInput);
  });

  it("removes a schedule and decodes the deleted flag", async () => {
    const { client, calls } = createClient({ handle: () => jsonResponse(200, { deleted: false }) });
    expect(await client.removeSchedule("schedule-1")).toBe(false);
    expect(calls[0]?.url).toBe("https://accounts.example.com/v1/cloud/schedules/schedule-1");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });

  it("lists dispatched runs for a schedule", async () => {
    const { client, calls } = createClient({
      handle: () => jsonResponse(200, { jobs: [sampleJob] }),
    });
    expect(await client.listRuns("schedule-1")).toEqual([sampleJob]);
    expect(calls[0]?.url).toBe("https://accounts.example.com/v1/cloud/schedules/schedule-1/runs");
  });

  it("dispatches a manual run", async () => {
    const { client, calls } = createClient({ handle: () => jsonResponse(200, sampleJob) });
    expect(await client.runNow("schedule-1")).toEqual(sampleJob);
    expect(calls[0]?.url).toBe("https://accounts.example.com/v1/cloud/schedules/schedule-1/run");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("fails as unauthorized without a session token", async () => {
    const { client, calls } = createClient({ token: null });
    await expect(client.listSchedules()).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });
    expect(calls).toHaveLength(0);
  });

  it("surfaces the control-plane error envelope", async () => {
    const { client } = createClient({
      handle: () => jsonResponse(409, { error: "source_revision_unavailable" }),
    });
    const error = await client.runNow("schedule-1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudJobsApiError);
    expect(error).toMatchObject({ code: "source_revision_unavailable", status: 409 });
  });

  it("binds the default fetch to the global scope", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(jsonResponse(200, { schedules: [] }));
    } as typeof globalThis.fetch;
    try {
      const client = new CloudSchedulesClient({
        baseUrl: "https://accounts.example.com",
        getToken: async () => "token-123",
      });
      await expect(client.listSchedules()).resolves.toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
