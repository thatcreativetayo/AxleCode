// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

import {
  CloudJobCreateInput,
  CloudJobResponseInput,
  CloudScheduleInput,
  CloudWorkerClaimInput,
  CloudWorkerLeaseInput,
  CloudWorkerUpdateInput,
} from "@axle/contracts";
import type { CloudJob } from "@axle/contracts";
import { AccountAuthenticationError, type AccountPrincipal } from "./auth.ts";
import { AccountSessionAccessError } from "./errors.ts";
import type { CloudConfig } from "./cloudConfig.ts";
import type { BillingConfig } from "./billingConfig.ts";
import type { CloudRevisionResolver } from "./cloudRevision.ts";
import type { CloudScheduleStore } from "./cloudScheduleStore.ts";
import { CloudJobError, type CloudJobStore } from "./cloudStore.ts";

const PINNED_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const decodeCreate = Schema.decodeUnknownSync(CloudJobCreateInput);
const decodeSchedule = Schema.decodeUnknownSync(CloudScheduleInput);
const decodeResponse = Schema.decodeUnknownSync(CloudJobResponseInput);
const decodeClaim = Schema.decodeUnknownSync(CloudWorkerClaimInput);
const decodeLease = Schema.decodeUnknownSync(CloudWorkerLeaseInput);
const decodeUpdate = Schema.decodeUnknownSync(CloudWorkerUpdateInput);

export function createCloudRequestHandler(options: {
  config: CloudConfig | null;
  store: CloudJobStore | null;
  schedules?: CloudScheduleStore | null;
  billing?: BillingConfig | null;
  /** Dispatches a manual run; ownership is enforced by the runner. */
  runSchedule?: ((userId: string, scheduleId: string) => Promise<CloudJob>) | null;
  /** Resolves branch/tag job sources to the commit a worker checks out. */
  revisions?: CloudRevisionResolver | null;
  authenticate: (request: Request) => Promise<AccountPrincipal>;
  touchSession: (principal: AccountPrincipal) => Promise<void>;
  corsOrigin: string;
}) {
  const headers = {
    "access-control-allow-origin": options.corsOrigin,
    "access-control-allow-headers": "authorization, content-type, x-axle-admin",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  const json = (status: number, payload: unknown) =>
    new Response(payload === null ? null : JSON.stringify(payload), { status, headers });
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const workerRoute = url.pathname.startsWith("/v1/cloud-workers/");
    if (!workerRoute && !url.pathname.startsWith("/v1/cloud/")) return null;
    if (request.method === "OPTIONS") return json(204, null);
    const { config, store } = options;
    if (!config || !store) return json(503, { error: "cloud_not_configured" });
    try {
      if (workerRoute) {
        const route =
          /^\/v1\/cloud-workers\/([a-zA-Z0-9_-]+)\/(claim|recover|jobs\/([a-zA-Z0-9_-]+)\/(heartbeat|update))$/u.exec(
            url.pathname,
          );
        if (!route || request.method !== "POST") return json(404, { error: "not_found" });
        const environmentId = route[1]!;
        const body = await readJson(request);
        const workerId = typeof body.workerId === "string" ? body.workerId : "";
        const worker = config.workers.find((entry) => entry.workerId === workerId);
        const token =
          /^Bearer ([^\s]+)$/iu.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
        if (
          !worker ||
          !NodeCrypto.timingSafeEqual(
            NodeCrypto.createHash("sha256").update(worker.token).digest(),
            NodeCrypto.createHash("sha256").update(token).digest(),
          )
        )
          throw new AccountAuthenticationError();
        if (!worker.environmentIds.includes(environmentId))
          return json(403, { error: "forbidden" });
        if (route[2] === "claim" || route[2] === "recover") {
          parse(decodeClaim, { workerId, environmentId });
          if (route[2] === "recover") {
            await store.recover(environmentId);
            return json(200, { recovered: true });
          }
          const lease = await store.claim(workerId, environmentId);
          return json(lease ? 200 : 204, lease);
        }
        const jobId = route[3]!;
        if (route[4] === "heartbeat")
          return json(200, await store.heartbeat(jobId, environmentId, parse(decodeLease, body)));
        return json(200, await store.update(jobId, environmentId, parse(decodeUpdate, body)));
      }

      if (url.pathname === "/v1/cloud/credits/grant") {
        if (request.method !== "POST") return json(404, { error: "not_found" });
        const adminToken = options.billing?.adminToken ?? "";
        const supplied = request.headers.get("x-axle-admin") ?? "";
        if (
          adminToken.length === 0 ||
          !NodeCrypto.timingSafeEqual(
            NodeCrypto.createHash("sha256").update(adminToken).digest(),
            NodeCrypto.createHash("sha256").update(supplied).digest(),
          )
        )
          return json(403, { error: "forbidden" });
        const grant = parseGrant(await readJson(request));
        return json(200, {
          userId: grant.userId,
          entryId: grant.entryId,
          ...(await store.grant(grant.userId, grant)),
        });
      }

      const principal = await options.authenticate(request);
      // Preserve account revocation checks for every protected cloud operation.
      await options.touchSession(principal);
      if (url.pathname === "/v1/cloud/environments" && request.method === "GET") {
        return json(200, {
          environments: config.environments.map((environment) => ({
            environmentId: environment.environmentId,
            repositoryHosts: environment.repositoryHosts,
            providerModels: environment.providerModels,
          })),
        });
      }
      const baseRoute = url.pathname === "/v1/cloud/jobs";
      if (url.pathname === "/v1/cloud/billing" && request.method === "GET") {
        return json(200, await store.billing(principal.userId));
      }
      const scheduleRoute =
        /^\/v1\/cloud\/schedules(?:\/([a-zA-Z0-9_-]+)(?:\/(run|runs))?)?$/u.exec(url.pathname);
      if (scheduleRoute) {
        const schedules = options.schedules;
        if (!schedules) return json(503, { error: "cloud_not_configured" });
        const scheduleId = scheduleRoute[1];
        const action = scheduleRoute[2];
        if (scheduleId === undefined && request.method === "GET")
          return json(200, await schedules.list(principal.userId));
        if (scheduleId === undefined && request.method === "POST") {
          if (!config.allowedUserIds.includes(principal.userId))
            return json(403, { error: "cloud_access_denied" });
          return json(
            200,
            await schedules.save(principal.userId, parse(decodeSchedule, await readJson(request))),
          );
        }
        if (scheduleId !== undefined && action === undefined && request.method === "DELETE") {
          if (!config.allowedUserIds.includes(principal.userId))
            return json(403, { error: "cloud_access_denied" });
          return json(200, { deleted: await schedules.remove(principal.userId, scheduleId) });
        }
        if (scheduleId !== undefined && action === "runs" && request.method === "GET")
          return json(200, await store.listBySchedule(principal.userId, scheduleId));
        if (scheduleId !== undefined && action === "run" && request.method === "POST") {
          if (!config.allowedUserIds.includes(principal.userId))
            return json(403, { error: "cloud_access_denied" });
          if (!options.runSchedule) return json(503, { error: "cloud_not_configured" });
          return json(200, await options.runSchedule(principal.userId, scheduleId));
        }
        return json(404, { error: "not_found" });
      }
      if (baseRoute && request.method === "GET")
        return json(200, await store.list(principal.userId));
      if (baseRoute && request.method === "POST") {
        if (!config.allowedUserIds.includes(principal.userId))
          return json(403, { error: "cloud_access_denied" });
        const input = parse(decodeCreate, await readJson(request));
        // Jobs always persist a pinned commit; branch and tag names are
        // resolved once at creation so a worker never tracks a moving ref.
        let sourceRevision = input.sourceRevision.toLowerCase();
        if (!PINNED_REVISION.test(sourceRevision)) {
          if (!options.revisions) throw new CloudJobError("source_revision_unavailable");
          sourceRevision = await options.revisions.resolve(
            input.repositoryUrl,
            input.sourceRevision,
          );
          if (!PINNED_REVISION.test(sourceRevision))
            throw new CloudJobError("source_revision_unavailable");
        }
        const result = await store.create(principal.userId, { ...input, sourceRevision });
        return json(result.created ? 201 : 200, result);
      }
      const route = /^\/v1\/cloud\/jobs\/([a-zA-Z0-9_-]+)(?:\/(events|cancel|responses))?$/u.exec(
        url.pathname,
      );
      if (!route) return json(404, { error: "not_found" });
      const jobId = route[1]!;
      if (!route[2] && request.method === "GET")
        return json(200, await store.get(principal.userId, jobId));
      if (route[2] === "events" && request.method === "GET") {
        return json(
          200,
          await store.events(
            principal.userId,
            jobId,
            cursor(url.searchParams.get("after"), 0, 0, 2_147_483_647),
            cursor(url.searchParams.get("limit"), 200, 1, 500),
          ),
        );
      }
      if (route[2] === "cancel" && request.method === "POST")
        return json(200, await store.cancel(principal.userId, jobId));
      if (route[2] === "responses" && request.method === "POST") {
        if (!config.allowedUserIds.includes(principal.userId))
          return json(403, { error: "cloud_access_denied" });
        return json(
          200,
          await store.respond(
            principal.userId,
            jobId,
            parse(decodeResponse, await readJson(request)),
          ),
        );
      }
      return json(404, { error: "not_found" });
    } catch (error) {
      if (error instanceof AccountAuthenticationError || error instanceof AccountSessionAccessError)
        return json(401, { error: "unauthorized" });
      if (error instanceof CloudJobError) {
        const status =
          error.code === "not_found"
            ? 404
            : ["insufficient_credits", "credit_account_missing"].includes(error.code)
              ? 402
              : error.code === "cloud_not_entitled"
                ? 403
                : ["capacity_exceeded", "event_limit_exceeded"].includes(error.code)
                  ? 429
                  : ["environment_unavailable", "model_unavailable"].includes(error.code)
                    ? 422
                    : error.code.startsWith("invalid_")
                      ? 400
                      : 409;
        return json(status, { error: error.code });
      }
      // Neither worker capabilities, submitted prompts, nor DB error details are logged.
      console.error("Cloud control plane request failed", {
        method: request.method,
        path: url.pathname,
      });
      return json(500, { error: "internal_error" });
    }
  };
}

function parse<A>(decode: (value: unknown) => A, value: unknown): A {
  try {
    return decode(value);
  } catch {
    throw new CloudJobError("invalid_request");
  }
}
async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > 64 * 1024)
    throw new CloudJobError("invalid_request");
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new CloudJobError("invalid_request");
  }
}
function parseGrant(body: Record<string, unknown>): {
  userId: string;
  entryId: string;
  amount: number;
  note?: string;
} {
  const { userId, entryId, amount, note } = body;
  if (typeof userId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(userId))
    throw new CloudJobError("invalid_user_id");
  if (typeof entryId !== "string") throw new CloudJobError("invalid_entry_id");
  if (typeof amount !== "number") throw new CloudJobError("invalid_amount");
  if (note !== undefined && (typeof note !== "string" || note.length > 512))
    throw new CloudJobError("invalid_note");
  return note === undefined ? { userId, entryId, amount } : { userId, entryId, amount, note };
}
function cursor(value: string | null, fallback: number, minimum: number, maximum: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/u.test(value)) throw new CloudJobError("invalid_cursor");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum)
    throw new CloudJobError("invalid_cursor");
  return number;
}
