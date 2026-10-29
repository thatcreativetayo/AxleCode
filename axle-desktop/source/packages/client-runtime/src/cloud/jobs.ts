import {
  CloudBillingView,
  CloudCheckoutSession,
  CloudEnvironmentCatalog,
  CloudJob,
  CloudJobCreateInput,
  CloudJobEvent,
  CloudJobResponseInput,
} from "@axle/contracts";
import type { CloudEnvironmentSummary } from "@axle/contracts";
import * as Schema from "effect/Schema";

/**
 * Control-plane client for Axle Cloud jobs.
 *
 * The account API owns every authoritative decision (who may create a job,
 * which environments exist, what a job may cost); this client only speaks the
 * documented `/v1/cloud/jobs` routes and returns decoded contracts. Clients
 * are never authoritative for entitlements, credits, or job state.
 */

export interface CloudJobsTransport {
  /** Account API base URL, e.g. `https://accounts.example.com`. */
  readonly baseUrl: string;
  /** Resolves the current account session token, or null when signed out. */
  readonly getToken: () => Promise<string | null>;
}

export interface CloudJobsApiProblem {
  readonly code: string;
  readonly status: number;
}

export class CloudJobsApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(problem: CloudJobsApiProblem) {
    super(`Cloud jobs request failed (${problem.status} ${problem.code}).`);
    this.name = "CloudJobsApiError";
    this.code = problem.code;
    this.status = problem.status;
  }
}

const decodeJob = Schema.decodeUnknownSync(CloudJob);
const decodeJobList = Schema.decodeUnknownSync(Schema.Struct({ jobs: Schema.Array(CloudJob) }));
const decodeCreatedJob = Schema.decodeUnknownSync(
  Schema.Struct({ job: CloudJob, created: Schema.Boolean }),
);
const decodeEventList = Schema.decodeUnknownSync(
  Schema.Struct({ events: Schema.Array(CloudJobEvent), lastSequence: Schema.Number }),
);
const decodeBilling = Schema.decodeUnknownSync(CloudBillingView);
const decodeCheckout = Schema.decodeUnknownSync(CloudCheckoutSession);
const decodeEnvironmentCatalog = Schema.decodeUnknownSync(CloudEnvironmentCatalog);

export type CloudBilling = CloudBillingView;
export type CloudCheckout = CloudCheckoutSession;

export interface CloudCheckoutRequest {
  readonly plan: "pro" | "pro-plus" | "ultra" | "credits";
  /** Optional prefilled buyer email; the hosted checkout collects it when absent. */
  readonly email?: string;
  readonly seats?: number;
  /** Required for credit packs: the chosen whole-dollar amount, $5 to $500. */
  readonly usd?: number;
}

export interface CloudJobsEventPage {
  readonly events: ReadonlyArray<CloudJobEvent>;
  readonly lastSequence: number;
}

export interface CloudJobsEventQuery {
  readonly after?: number;
  readonly limit?: number;
}

export interface CloudJobsCreateResult {
  readonly job: CloudJob;
  readonly created: boolean;
}

export class CloudJobsClient {
  private readonly baseUrl: string;
  private readonly getToken: () => Promise<string | null>;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(
    transport: CloudJobsTransport,
    fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.baseUrl = transport.baseUrl;
    this.getToken = transport.getToken;
    this.fetchImpl = fetchImpl;
  }

  /** `POST /v1/cloud/jobs` — idempotent on `input.commandId`. */
  async createJob(input: CloudJobCreateInput): Promise<CloudJobsCreateResult> {
    return this.request({
      method: "POST",
      path: "/v1/cloud/jobs",
      body: input,
      decode: decodeCreatedJob,
    });
  }

  /**
   * `GET /v1/cloud/environments` — the operator-configured environments with
   * the provider/model pairs each one accepts.
   */
  async listEnvironments(): Promise<ReadonlyArray<CloudEnvironmentSummary>> {
    const result = await this.request({
      method: "GET",
      path: "/v1/cloud/environments",
      decode: decodeEnvironmentCatalog,
    });
    return result.environments;
  }

  /** `GET /v1/cloud/jobs` — the caller's jobs, newest first. */
  async listJobs(): Promise<ReadonlyArray<CloudJob>> {
    const result = await this.request({
      method: "GET",
      path: "/v1/cloud/jobs",
      decode: decodeJobList,
    });
    return result.jobs;
  }

  /** `GET /v1/cloud/jobs/{jobId}`. */
  async getJob(jobId: string): Promise<CloudJob> {
    return this.request({
      method: "GET",
      path: `/v1/cloud/jobs/${encodeURIComponent(jobId)}`,
      decode: decodeJob,
    });
  }

  /** `GET /v1/cloud/jobs/{jobId}/events` — cursor paginated. */
  async listEvents(jobId: string, query: CloudJobsEventQuery = {}): Promise<CloudJobsEventPage> {
    const params = new URLSearchParams();
    if (query.after !== undefined) params.set("after", String(query.after));
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const suffix = params.size === 0 ? "" : `?${params.toString()}`;
    return this.request({
      method: "GET",
      path: `/v1/cloud/jobs/${encodeURIComponent(jobId)}/events${suffix}`,
      decode: decodeEventList,
    });
  }

  /** `POST /v1/cloud/jobs/{jobId}/responses` — answers an approval or input request. */
  async respondToRequest(jobId: string, input: CloudJobResponseInput): Promise<CloudJob> {
    return this.request({
      method: "POST",
      path: `/v1/cloud/jobs/${encodeURIComponent(jobId)}/responses`,
      body: input,
      decode: decodeJob,
    });
  }

  /** `POST /v1/cloud/jobs/{jobId}/cancel`. */
  async cancelJob(jobId: string): Promise<CloudJob> {
    return this.request({
      method: "POST",
      path: `/v1/cloud/jobs/${encodeURIComponent(jobId)}/cancel`,
      decode: decodeJob,
    });
  }

  /**
   * `GET /v1/cloud/billing` — the caller's plan, credit balance, and resolved
   * entitlements. `account.entitlements` is null on unmetered deployments.
   */
  async getBilling(): Promise<CloudBilling> {
    return this.request({
      method: "GET",
      path: "/v1/cloud/billing",
      decode: decodeBilling,
    });
  }

  /**
   * `POST /v1/billing/checkout` — a hosted payment session for a paid plan.
   * The caller opens `checkoutUrl` in a browser; the plan is applied
   * server-side when the provider's webhook confirms payment.
   */
  async createCheckoutSession(input: CloudCheckoutRequest): Promise<CloudCheckout> {
    return this.request({
      method: "POST",
      path: "/v1/billing/checkout",
      body: input,
      decode: decodeCheckout,
    });
  }

  private async request<T>(options: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: unknown;
    readonly decode: (value: unknown) => T;
  }): Promise<T> {
    const token = await this.getToken();
    if (token === null) {
      throw new CloudJobsApiError({ code: "unauthorized", status: 401 });
    }
    const url = new URL(options.path, `${this.baseUrl}/`).toString();
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (options.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: options.method,
        headers,
        credentials: "omit",
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch {
      throw new CloudJobsApiError({ code: "network_error", status: 0 });
    }

    if (!response.ok) {
      let code = `http_${response.status}`;
      try {
        const payload: unknown = await response.json();
        if (
          payload !== null &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          typeof (payload as { error?: unknown }).error === "string"
        ) {
          code = (payload as { error: string }).error;
        }
      } catch {
        // Keep the status-derived code; the body was not the documented error envelope.
      }
      throw new CloudJobsApiError({ code, status: response.status });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CloudJobsApiError({ code: "unexpected_response", status: response.status });
    }
    try {
      return options.decode(payload);
    } catch {
      throw new CloudJobsApiError({ code: "unexpected_response", status: response.status });
    }
  }
}
