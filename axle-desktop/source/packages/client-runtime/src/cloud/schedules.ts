import {
  CloudJob,
  CloudSchedule,
  CloudScheduleDeleteResult,
  CloudScheduleInput,
  CloudScheduleList,
  CloudScheduleRuns,
} from "@axle/contracts";
import * as Schema from "effect/Schema";

import { CloudJobsApiError, type CloudJobsTransport } from "./jobs.ts";

/**
 * Control-plane client for Axle Cloud schedules.
 *
 * Cloud schedules are owned by the account API, so a run can start and finish
 * while the user's machine is offline. Like the jobs client, this only speaks
 * the documented `/v1/cloud/schedules` routes and returns decoded contracts.
 */

const decodeSchedule = Schema.decodeUnknownSync(CloudSchedule);
const decodeJob = Schema.decodeUnknownSync(CloudJob);
const decodeScheduleList = Schema.decodeUnknownSync(CloudScheduleList);
const decodeScheduleRuns = Schema.decodeUnknownSync(CloudScheduleRuns);
const decodeDeleteResult = Schema.decodeUnknownSync(CloudScheduleDeleteResult);

export class CloudSchedulesClient {
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

  /** `GET /v1/cloud/schedules` — the caller's schedules, newest first. */
  async listSchedules(): Promise<ReadonlyArray<CloudSchedule>> {
    const result = await this.request({
      method: "GET",
      path: "/v1/cloud/schedules",
      decode: decodeScheduleList,
    });
    return result.schedules;
  }

  /** `POST /v1/cloud/schedules` — creates or updates the schedule by id. */
  async saveSchedule(input: CloudScheduleInput): Promise<CloudSchedule> {
    return this.request({
      method: "POST",
      path: "/v1/cloud/schedules",
      body: input,
      decode: decodeSchedule,
    });
  }

  /** `DELETE /v1/cloud/schedules/{scheduleId}`. */
  async removeSchedule(scheduleId: string): Promise<boolean> {
    const result = await this.request({
      method: "DELETE",
      path: `/v1/cloud/schedules/${encodeURIComponent(scheduleId)}`,
      decode: decodeDeleteResult,
    });
    return result.deleted;
  }

  /** `GET /v1/cloud/schedules/{scheduleId}/runs` — recent dispatched jobs. */
  async listRuns(scheduleId: string): Promise<ReadonlyArray<CloudJob>> {
    const result = await this.request({
      method: "GET",
      path: `/v1/cloud/schedules/${encodeURIComponent(scheduleId)}/runs`,
      decode: decodeScheduleRuns,
    });
    return result.jobs;
  }

  /** `POST /v1/cloud/schedules/{scheduleId}/run` — dispatch a manual run now. */
  async runNow(scheduleId: string): Promise<CloudJob> {
    return this.request({
      method: "POST",
      path: `/v1/cloud/schedules/${encodeURIComponent(scheduleId)}/run`,
      decode: decodeJob,
    });
  }

  private async request<T>(options: {
    readonly method: "GET" | "POST" | "DELETE";
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
