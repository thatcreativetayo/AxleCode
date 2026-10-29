import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CloudJob } from "@axle/contracts";
import { AccountSessionAccessError } from "./errors.ts";
import { createCloudRequestHandler } from "./cloudHandler.ts";
import type { CloudScheduleStore } from "./cloudScheduleStore.ts";
import { CloudJobError, createCloudJobStore } from "./cloudStore.ts";
import {
  billingConfigFixture,
  cloudConfigFixture,
  cloudInputFixture,
  cloudScheduleFixture,
} from "./cloudTestFixtures.ts";

describe("cloud HTTP authorization and routing", () => {
  const query = vi.fn(
    async (_operation: string, _args: Record<string, unknown>): Promise<unknown> => null,
  );
  const touchSession = vi.fn(async () => {});
  let userId: string;
  let handle: ReturnType<typeof createCloudRequestHandler>;
  beforeEach(() => {
    vi.resetAllMocks();
    userId = "user-a";
    handle = createCloudRequestHandler({
      config: cloudConfigFixture,
      store: createCloudJobStore(query, cloudConfigFixture),
      authenticate: async () => ({ userId, sessionId: "session-a" }),
      touchSession,
      corsOrigin: "https://app.invalid",
    });
  });
  const request = (path: string, method = "GET", body?: unknown, token?: string) =>
    handle(
      new Request(`https://account.invalid${path}`, {
        method,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  it("returns an explicit disabled response without touching account or worker state", async () => {
    handle = createCloudRequestHandler({
      config: null,
      store: null,
      authenticate: vi.fn(),
      touchSession,
      corsOrigin: "*",
    });
    expect((await request("/v1/cloud/jobs", "POST", cloudInputFixture))?.status).toBe(503);
    expect(touchSession).not.toHaveBeenCalled();
  });
  it("preserves unrelated account routing", async () =>
    expect(await request("/v1/account")).toBeNull());
  it("rejects revoked sessions before any job read or mutation", async () => {
    touchSession.mockRejectedValue(new AccountSessionAccessError());
    for (const path of [
      "/v1/cloud/jobs",
      "/v1/cloud/jobs/job-a/events",
      "/v1/cloud/jobs/job-a/cancel",
    ]) {
      expect((await request(path, path.endsWith("cancel") ? "POST" : "GET"))?.status).toBe(401);
    }
    expect(query).not.toHaveBeenCalled();
  });
  it("denies new work without an operator grant, while permitting owner cancellation", async () => {
    userId = "not-entitled";
    expect((await request("/v1/cloud/jobs", "POST", cloudInputFixture))?.status).toBe(403);
    await request("/v1/cloud/jobs/job-a/cancel", "POST");
    expect(query).toHaveBeenCalledExactlyOnceWith("cancel", { userId, jobId: "job-a" });
  });
  it("passes only verified ownership to reads and cursor replay", async () => {
    await request("/v1/cloud/jobs/job-a/events?after=12&limit=50");
    expect(query).toHaveBeenCalledWith("events", {
      userId: "user-a",
      jobId: "job-a",
      after: 12,
      limit: 50,
    });
    expect((await request("/v1/cloud/jobs/job-a/events?after=-1"))?.status).toBe(400);
  });
  it("does not disclose whether another account owns a job", async () => {
    query.mockRejectedValue(new CloudJobError("not_found"));
    const response = await request("/v1/cloud/jobs/job-b");
    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({ error: "not_found" });
  });
  it("rejects user tokens and workers outside their environment grant", async () => {
    expect(
      (
        await request(
          "/v1/cloud-workers/linux-test/claim",
          "POST",
          { workerId: "worker-test" },
          "user-jwt",
        )
      )?.status,
    ).toBe(401);
    expect(
      (
        await request(
          "/v1/cloud-workers/another/claim",
          "POST",
          { workerId: "worker-test" },
          cloudConfigFixture.workers[0]!.token,
        )
      )?.status,
    ).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
  it("uses trusted worker identity and returns no lease for an empty queue", async () => {
    query.mockResolvedValue(null);
    expect(
      (
        await request(
          "/v1/cloud-workers/linux-test/claim",
          "POST",
          { workerId: "worker-test" },
          cloudConfigFixture.workers[0]!.token,
        )
      )?.status,
    ).toBe(204);
    expect(query).toHaveBeenCalledWith(
      "claim",
      expect.objectContaining({ workerId: "worker-test", environmentId: "linux-test" }),
    );
    expect(touchSession).not.toHaveBeenCalled();
  });
  it("maps lease loss to conflict and rejects missing fencing fields", async () => {
    const body = { workerId: "worker-test", leaseToken: "private-capability", generation: 1 };
    query.mockRejectedValue(new CloudJobError("lease_lost"));
    expect(
      (
        await request(
          "/v1/cloud-workers/linux-test/jobs/job-a/heartbeat",
          "POST",
          body,
          cloudConfigFixture.workers[0]!.token,
        )
      )?.status,
    ).toBe(409);
    query.mockClear();
    expect(
      (
        await request(
          "/v1/cloud-workers/linux-test/jobs/job-a/heartbeat",
          "POST",
          { workerId: "worker-test" },
          cloudConfigFixture.workers[0]!.token,
        )
      )?.status,
    ).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
  it("serves a safe environment catalog for job and schedule pickers", async () => {
    const response = await request("/v1/cloud/environments");
    expect(response?.status).toBe(200);
    const payload = await response?.json();
    expect(payload).toEqual({
      environments: [
        {
          environmentId: "linux-test",
          repositoryHosts: ["github.com"],
          providerModels: [{ providerInstanceId: "axle", model: "configured-model" }],
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain(cloudConfigFixture.workers[0]!.token);
    expect(touchSession).toHaveBeenCalled();
  });
  it("rejects malformed source refs before resolving them", async () => {
    expect(
      (
        await request("/v1/cloud/jobs", "POST", {
          ...cloudInputFixture,
          sourceRevision: "not a ref",
        })
      )?.status,
    ).toBe(400);
  });
  it("resolves a branch to a pinned commit before persisting the job", async () => {
    const resolve = vi.fn(async () => "b".repeat(40));
    handle = createCloudRequestHandler({
      config: cloudConfigFixture,
      store: createCloudJobStore(query, cloudConfigFixture),
      revisions: { resolve },
      authenticate: async () => ({ userId, sessionId: "session-a" }),
      touchSession,
      corsOrigin: "https://app.invalid",
    });
    query.mockImplementation(async (operation: string) =>
      operation === "create" ? { job: {}, created: true } : null,
    );
    const response = await request("/v1/cloud/jobs", "POST", {
      ...cloudInputFixture,
      sourceRevision: "main",
    });
    expect(response?.status).toBe(201);
    expect(resolve).toHaveBeenCalledWith(cloudInputFixture.repositoryUrl, "main");
    expect(query).toHaveBeenCalledWith(
      "create",
      expect.objectContaining({
        input: expect.objectContaining({ sourceRevision: "b".repeat(40) }),
      }),
    );
  });
  it("reports source_revision_unavailable when no GitHub resolver is configured", async () => {
    const response = await request("/v1/cloud/jobs", "POST", {
      ...cloudInputFixture,
      sourceRevision: "main",
    });
    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({ error: "source_revision_unavailable" });
  });
  it("keeps SQL errors and secrets out of responses", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    query.mockRejectedValue(new Error("postgresql://secret:password@private-host"));
    const response = await request("/v1/cloud/jobs");
    expect(response?.status).toBe(500);
    expect(await response?.json()).toEqual({ error: "internal_error" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("password");
    log.mockRestore();
  });
  it("serves the caller's own billing view and refuses grants without an operator token", async () => {
    query.mockImplementation(async (operation: string) =>
      operation === "billing"
        ? {
            account: { planId: "operator", balance: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
            entries: [],
          }
        : null,
    );
    const response = await request("/v1/cloud/billing");
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      account: { planId: "operator", entitlements: null },
    });
    expect(query).toHaveBeenCalledWith("billing", {
      userId: "user-a",
      planId: "operator",
      monthlyCredits: 0,
    });
    expect(
      (
        await request("/v1/cloud/credits/grant", "POST", {
          userId: "user-a",
          entryId: "top-up-1",
          amount: 5,
        })
      )?.status,
    ).toBe(403);
    expect(query).not.toHaveBeenCalledWith("grant", expect.anything());
  });
  it("grants credits only with the configured operator token after body validation", async () => {
    const admin = billingConfigFixture.adminToken!;
    handle = createCloudRequestHandler({
      config: cloudConfigFixture,
      billing: billingConfigFixture,
      store: createCloudJobStore(query, cloudConfigFixture, billingConfigFixture),
      authenticate: async () => ({ userId, sessionId: "session-a" }),
      touchSession,
      corsOrigin: "https://app.invalid",
    });
    const grant = (body: unknown, token: string) =>
      handle(
        new Request("https://account.invalid/v1/cloud/credits/grant", {
          method: "POST",
          headers: { "x-axle-admin": token },
          body: JSON.stringify(body),
        }),
      );
    expect((await grant({ userId: "user-a", entryId: "top-up-1" }, admin))?.status).toBe(400);
    expect(
      (
        await grant(
          { userId: "user-a", entryId: "top-up-1", amount: 5 },
          "wrong-token-wrong-token-wrong-token",
        )
      )?.status,
    ).toBe(403);
    expect((await grant({ userId: "user-a", entryId: "top-up-1", amount: 5 }, admin))?.status).toBe(
      200,
    );
    expect(query).toHaveBeenCalledWith(
      "grant",
      expect.objectContaining({
        userId: "user-a",
        entryId: "top-up-1",
        amount: 5,
        planId: "pro",
        monthlyCredits: 120,
      }),
    );
    expect(touchSession).not.toHaveBeenCalled();
  });
  it("maps entitlement and credit failures to client-visible statuses", async () => {
    query.mockRejectedValue(new CloudJobError("insufficient_credits"));
    expect((await request("/v1/cloud/jobs", "POST", cloudInputFixture))?.status).toBe(402);
    query.mockRejectedValue(new CloudJobError("credit_account_missing"));
    expect((await request("/v1/cloud/jobs", "POST", cloudInputFixture))?.status).toBe(402);
    query.mockRejectedValue(new CloudJobError("cloud_not_entitled"));
    expect((await request("/v1/cloud/jobs", "POST", cloudInputFixture))?.status).toBe(403);
  });
});

describe("cloud schedule HTTP routing", () => {
  const query = vi.fn(async () => null);
  const touchSession = vi.fn(async () => {});
  const scheduleView = {
    ...cloudScheduleFixture,
    sourceRevision: null,
    nextRunAt: null,
    lastJobId: null,
    lastError: null,
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
  };
  const schedules = {
    list: vi.fn(async () => ({ schedules: [scheduleView] })),
    get: vi.fn(async () => scheduleView),
    save: vi.fn(async () => scheduleView),
    remove: vi.fn(async () => true),
    due: vi.fn(async () => []),
    advance: vi.fn(async () => true),
    recordResult: vi.fn(async () => {}),
  } as unknown as CloudScheduleStore;
  const runSchedule = vi.fn(
    async (): Promise<CloudJob> => ({ jobId: "job-a" }) as unknown as CloudJob,
  );
  let userId: string;
  let handle: ReturnType<typeof createCloudRequestHandler>;
  beforeEach(() => {
    vi.resetAllMocks();
    userId = "user-a";
    handle = createCloudRequestHandler({
      config: cloudConfigFixture,
      store: createCloudJobStore(query, cloudConfigFixture),
      schedules,
      runSchedule,
      authenticate: async () => ({ userId, sessionId: "session-a" }),
      touchSession,
      corsOrigin: "https://app.invalid",
    });
  });
  const request = (path: string, method = "GET", body?: unknown) =>
    handle(
      new Request(`https://account.invalid${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  it("lists schedules for the authenticated owner", async () => {
    const response = await request("/v1/cloud/schedules");
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ schedules: [scheduleView] });
    expect(schedules.list).toHaveBeenCalledWith("user-a");
  });

  it("saves a validated schedule for an allowed operator user", async () => {
    const response = await request("/v1/cloud/schedules", "POST", cloudScheduleFixture);
    expect(response?.status).toBe(200);
    expect(schedules.save).toHaveBeenCalledWith("user-a", cloudScheduleFixture);
  });

  it("rejects schedule bodies that fail contract validation", async () => {
    expect((await request("/v1/cloud/schedules", "POST", { title: "incomplete" }))?.status).toBe(
      400,
    );
    expect(schedules.save).not.toHaveBeenCalled();
  });

  it("denies schedule mutations without an operator grant", async () => {
    userId = "user-b";
    expect((await request("/v1/cloud/schedules", "POST", cloudScheduleFixture))?.status).toBe(403);
    expect((await request("/v1/cloud/schedules/schedule-1/run", "POST", undefined))?.status).toBe(
      403,
    );
    expect(schedules.save).not.toHaveBeenCalled();
    expect(runSchedule).not.toHaveBeenCalled();
  });

  it("removes a schedule and reports whether it was deleted", async () => {
    const response = await request("/v1/cloud/schedules/schedule-1", "DELETE");
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ deleted: true });
    expect(schedules.remove).toHaveBeenCalledWith("user-a", "schedule-1");
  });

  it("dispatches a manual run through the runner", async () => {
    const response = await request("/v1/cloud/schedules/schedule-1/run", "POST", undefined);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ jobId: "job-a" });
    expect(runSchedule).toHaveBeenCalledWith("user-a", "schedule-1");
  });

  it("lists runs for a schedule under the verified owner", async () => {
    await request("/v1/cloud/schedules/schedule-1/runs");
    expect(query).toHaveBeenCalledWith("list-by-schedule", {
      userId: "user-a",
      scheduleId: "schedule-1",
    });
  });

  it("returns disabled for schedule routes when the control plane has no schedule store", async () => {
    handle = createCloudRequestHandler({
      config: cloudConfigFixture,
      store: createCloudJobStore(query, cloudConfigFixture),
      authenticate: async () => ({ userId: "user-a", sessionId: "session-a" }),
      touchSession,
      corsOrigin: "https://app.invalid",
    });
    expect((await request("/v1/cloud/schedules"))?.status).toBe(503);
  });
});
