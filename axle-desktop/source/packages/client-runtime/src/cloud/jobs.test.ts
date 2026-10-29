import { CloudJob, CloudJobEvent, ProviderInstanceId } from "@axle/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { CloudJobsApiError, CloudJobsClient } from "./jobs.ts";

const revision = "a".repeat(40);

const sampleJob: CloudJob = {
  jobId: "job-1",
  state: "queued",
  runtimeMode: "approval-required",
  scheduleId: null,
  input: {
    commandId: "cmd-1",
    environmentId: "linux-standard",
    repositoryUrl: "https://github.com/example/repo.git",
    sourceRevision: revision,
    prompt: "Fix the failing tests",
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
  createdAt: "2026-10-14T09:00:00.000Z",
  updatedAt: "2026-10-14T09:00:00.000Z",
  deadlineAt: "2026-10-14T10:00:00.000Z",
  cancelRequestedAt: null,
  pendingRequest: null,
  result: null,
  failureCode: null,
  lastSequence: 0,
};

const sampleEvent: CloudJobEvent = {
  sequence: 1,
  kind: "state",
  payload: { state: "queued" },
  createdAt: "2026-10-14T09:00:01.000Z",
};

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
}): { readonly client: CloudJobsClient; readonly calls: Array<CapturedCall> } {
  const calls: Array<CapturedCall> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return options.handle ? await options.handle(call) : jsonResponse(200, {});
  }) as typeof globalThis.fetch;
  const token = options.token === undefined ? "token-123" : options.token;
  const client = new CloudJobsClient(
    { baseUrl: "https://accounts.example.com", getToken: async () => token },
    fetchImpl,
  );
  return { client, calls };
}

describe("CloudJobsClient", () => {
  it("creates a job with the bearer token and decoded contracts", async () => {
    const { client, calls } = createClient({
      handle: (call) => {
        expect(call.url).toBe("https://accounts.example.com/v1/cloud/jobs");
        expect(call.init?.method).toBe("POST");
        const headers = call.init?.headers as Record<string, string>;
        expect(headers.authorization).toBe("Bearer token-123");
        expect(headers["content-type"]).toBe("application/json");
        const body = JSON.parse(String(call.init?.body)) as typeof sampleJob.input;
        expect(body).toEqual(sampleJob.input);
        return jsonResponse(201, { job: sampleJob, created: true });
      },
    });
    const result = await client.createJob(sampleJob.input);
    expect(result.created).toBe(true);
    expect(result.job.jobId).toBe("job-1");
    expect(calls).toHaveLength(1);
  });

  it("lists jobs", async () => {
    const { client } = createClient({ handle: () => jsonResponse(200, { jobs: [sampleJob] }) });
    const jobs = await client.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.state).toBe("queued");
  });

  it("lists the environment catalog used by pickers", async () => {
    const { client, calls } = createClient({
      handle: () =>
        jsonResponse(200, {
          environments: [
            {
              environmentId: "linux-standard",
              repositoryHosts: ["github.com"],
              providerModels: [
                { providerInstanceId: "anthropic-default", model: "claude-sonnet-4-5" },
              ],
            },
          ],
        }),
    });
    const environments = await client.listEnvironments();
    expect(calls[0]?.url).toBe("https://accounts.example.com/v1/cloud/environments");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(environments[0]?.environmentId).toBe("linux-standard");
    expect(environments[0]?.repositoryHosts).toEqual(["github.com"]);
    expect(environments[0]?.providerModels[0]?.model).toBe("claude-sonnet-4-5");
  });

  it("gets a single job by encoded id", async () => {
    const { client, calls } = createClient({
      handle: () => jsonResponse(200, sampleJob),
    });
    const job = await client.getJob("job-1");
    expect(job.jobId).toBe("job-1");
    expect(calls[0]?.url).toBe("https://accounts.example.com/v1/cloud/jobs/job-1");
  });

  it("paginates events with after and limit", async () => {
    const { client, calls } = createClient({
      handle: () => jsonResponse(200, { events: [sampleEvent], lastSequence: 1 }),
    });
    const page = await client.listEvents("job-1", { after: 0, limit: 50 });
    expect(page.events).toHaveLength(1);
    expect(page.lastSequence).toBe(1);
    expect(calls[0]?.url).toBe(
      "https://accounts.example.com/v1/cloud/jobs/job-1/events?after=0&limit=50",
    );
  });

  it("responds to a pending request and cancels jobs", async () => {
    const seen: Array<CapturedCall> = [];
    const { client } = createClient({
      handle: (call) => {
        seen.push(call);
        return jsonResponse(200, sampleJob);
      },
    });
    await client.respondToRequest("job-1", {
      commandId: "cmd-2",
      requestId: "req-1",
      payload: { decision: "allow" },
    });
    await client.cancelJob("job-1");
    expect(seen[0]?.url).toBe("https://accounts.example.com/v1/cloud/jobs/job-1/responses");
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({
      commandId: "cmd-2",
      requestId: "req-1",
      payload: { decision: "allow" },
    });
    expect(seen[1]?.url).toBe("https://accounts.example.com/v1/cloud/jobs/job-1/cancel");
    expect(seen[1]?.init?.method).toBe("POST");
  });

  it("reads billing with resolved entitlements", async () => {
    const { client, calls } = createClient({
      handle: () =>
        jsonResponse(200, {
          account: {
            planId: "pro",
            balance: 480,
            updatedAt: "2026-10-14T09:00:00.000Z",
            entitlements: {
              planId: "pro",
              cloudJobsEnabled: true,
              monthlyCredits: 500,
              maxConcurrentJobs: 4,
              features: {
                scheduledTasksMax: 50,
                pullRequestReviews: true,
                teamSharing: false,
              },
            },
          },
          entries: [
            {
              entryId: 2,
              kind: "reservation",
              amount: -20,
              jobId: "job-1",
              note: null,
              createdAt: "2026-10-14T09:00:00.000Z",
            },
          ],
        }),
    });
    const billing = await client.getBilling();
    expect(calls[0]?.url).toBe("https://accounts.example.com/v1/cloud/billing");
    expect(billing.account.entitlements?.planId).toBe("pro");
    expect(billing.account.entitlements?.features.pullRequestReviews).toBe(true);
    expect(billing.entries).toHaveLength(1);
  });

  it("accepts unmetered billing views with null entitlements", async () => {
    const { client } = createClient({
      handle: () =>
        jsonResponse(200, {
          account: {
            planId: "operator",
            balance: 0,
            updatedAt: "2026-10-14T09:00:00.000Z",
            entitlements: null,
          },
          entries: [],
        }),
    });
    const billing = await client.getBilling();
    expect(billing.account.entitlements).toBeNull();
  });

  it("creates a hosted checkout session for a paid plan", async () => {
    const { client, calls } = createClient({
      handle: () =>
        jsonResponse(200, {
          checkoutId: "chk_1M2N3o4P5q6R7s8T",
          checkoutUrl: "https://checkout.bachs.io/c/Mz9wDp3sVn7QaTf",
        }),
    });
    const session = await client.createCheckoutSession({
      plan: "pro",
      email: "buyer@example.com",
    });
    expect(calls[0]?.url).toBe("https://accounts.example.com/v1/billing/checkout");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      plan: "pro",
      email: "buyer@example.com",
    });
    expect(session.checkoutId).toBe("chk_1M2N3o4P5q6R7s8T");
    expect(session.checkoutUrl).toBe("https://checkout.bachs.io/c/Mz9wDp3sVn7QaTf");
  });

  it("rejects checkout responses that do not decode as contracts", async () => {
    const { client } = createClient({
      handle: () => jsonResponse(200, { checkoutId: "chk_1" }),
    });
    const failure = (await client
      .createCheckoutSession({ plan: "ultra", email: "buyer@example.com" })
      .catch((error: unknown) => error)) as CloudJobsApiError;
    expect(failure.code).toBe("unexpected_response");
  });

  it("maps documented error envelopes to typed errors", async () => {
    const { client } = createClient({
      handle: () => jsonResponse(403, { error: "cloud_access_denied" }),
    });
    const failure = await client.listJobs().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CloudJobsApiError);
    const typed = failure as CloudJobsApiError;
    expect(typed.code).toBe("cloud_access_denied");
    expect(typed.status).toBe(403);
  });

  it("falls back to a status-derived code when the body is not an envelope", async () => {
    const { client } = createClient({ handle: () => jsonResponse(500, "boom") });
    const failure = (await client.listJobs().catch((error: unknown) => error)) as CloudJobsApiError;
    expect(failure.code).toBe("http_500");
  });

  it("fails closed without a session token", async () => {
    const { client, calls } = createClient({ token: null });
    const failure = (await client.listJobs().catch((error: unknown) => error)) as CloudJobsApiError;
    expect(failure.code).toBe("unauthorized");
    expect(calls).toHaveLength(0);
  });

  it("rejects responses that do not decode as contracts", async () => {
    const { client } = createClient({
      handle: () => jsonResponse(200, { jobs: [{ jobId: "job-1" }] }),
    });
    const failure = (await client.listJobs().catch((error: unknown) => error)) as CloudJobsApiError;
    expect(failure.code).toBe("unexpected_response");
  });

  it("reports transport failures without leaking details", async () => {
    const { client } = createClient({
      handle: () => {
        throw new TypeError("fetch failed");
      },
    });
    const failure = (await client.listJobs().catch((error: unknown) => error)) as CloudJobsApiError;
    expect(failure.code).toBe("network_error");
    expect(failure.status).toBe(0);
  });

  it("still decodes fixtures through the contract schema", () => {
    expect(Schema.decodeUnknownSync(CloudJob)(sampleJob).jobId).toBe("job-1");
  });

  it("binds the default fetch to the global scope", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(jsonResponse(200, { jobs: [] }));
    } as typeof globalThis.fetch;
    try {
      const client = new CloudJobsClient({
        baseUrl: "https://accounts.example.com",
        getToken: async () => "token-123",
      });
      await expect(client.listJobs()).resolves.toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
