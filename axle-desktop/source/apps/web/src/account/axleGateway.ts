/**
 * Client for the Axle hosted provider's gateway.
 *
 * The gateway is the `--provider axle` endpoint: it holds Axle's own upstream
 * key, so a user reaches every Axle model with an Axle API key and no vendor
 * account of their own. Credits are the unit it meters in — every account gets
 * a fresh daily grant of them for free.
 *
 * Balance and usage are read through the local server (`/api/axle/*`), because
 * the gateway identifies a caller by key and provider secrets only ever exist
 * server-side. The model catalog is public and is fetched directly.
 */

import { fetchPrimaryEnvironment } from "../environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";

const DEFAULT_GATEWAY_URL = "https://axle-gateway.axle-download-worker.workers.dev/v1";

export function axleGatewayBaseUrl(): string {
  const configured = import.meta.env.VITE_AXLE_GATEWAY_URL?.trim() || DEFAULT_GATEWAY_URL;
  try {
    return new URL(configured).toString().replace(/\/$/u, "");
  } catch {
    return DEFAULT_GATEWAY_URL;
  }
}

export interface AxleCredits {
  readonly credits: number;
  readonly dailyFreeCredits: number;
  /** The three buckets the total splits into: renews daily, plan, purchased. */
  readonly freeCredits: number;
  readonly planCredits: number;
  readonly paidCredits: number;
}

export interface AxleUsageEntry {
  readonly kind: string;
  readonly credits: number;
  readonly balanceAfter: number;
  readonly model: string | null;
  readonly createdAt: number;
}

export interface AxleModelRate {
  readonly id: string;
  readonly label: string;
  readonly tier: number;
  /** Which plans may use the model; the gateway enforces it, the picker mirrors it. */
  readonly plan: "free" | "paid";
  readonly contextWindow: number;
  readonly creditsPerMillionInput: number;
  readonly creditsPerMillionOutput: number;
}

export class AxleGatewayError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AxleGatewayError";
    this.status = status;
  }
}

function messageFrom(value: unknown, fallback: string): string {
  if (typeof value !== "object" || value === null) return fallback;
  const error = (value as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return fallback;
}

async function environmentGet(path: string): Promise<unknown> {
  const requestUrl = resolvePrimaryEnvironmentHttpUrl(path);
  const response = await fetchPrimaryEnvironment(requestUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const value = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new AxleGatewayError(
      messageFrom(value, `Credits could not be loaded (HTTP ${response.status}).`),
      response.status,
    );
  }
  return value;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * The connected account's balance, applying today's free grant on the way
 * through. `null` means this app has no account key connected to the Axle
 * provider yet, so there is no account balance to show.
 */
export async function fetchAxleCredits(): Promise<AxleCredits | null> {
  const value = (await environmentGet("/api/axle/credits")) as Record<string, unknown> | null;
  if (value?.connected !== true) return null;
  return {
    credits: asNumber(value.credits),
    dailyFreeCredits: asNumber(value.daily_free_credits),
    freeCredits: asNumber(value.free_credits),
    planCredits: asNumber(value.plan_credits),
    paidCredits: asNumber(value.paid_credits),
  };
}

/** Recent grants and spends, newest first. Empty when no account key is connected. */
export async function fetchAxleUsage(limit = 25): Promise<ReadonlyArray<AxleUsageEntry>> {
  const value = (await environmentGet(
    `/api/axle/usage?limit=${encodeURIComponent(String(limit))}`,
  )) as {
    connected?: unknown;
    entries?: unknown;
  } | null;
  if (value?.connected !== true) return [];
  const entries = Array.isArray(value.entries) ? value.entries : [];
  return entries.map((entry) => {
    const row = entry as Record<string, unknown>;
    return {
      kind: typeof row.kind === "string" ? row.kind : "unknown",
      credits: asNumber(row.credits),
      balanceAfter: asNumber(row.balance_after),
      model: typeof row.model === "string" ? row.model : null,
      createdAt: asNumber(row.created_at),
    };
  });
}

/** The Axle model catalog and its credit rates. Public: no key required. */
export async function fetchAxleModelRates(): Promise<ReadonlyArray<AxleModelRate>> {
  const response = await fetch(`${axleGatewayBaseUrl()}/models`, {
    headers: { Accept: "application/json" },
    credentials: "omit",
  });
  const value = (await response.json().catch(() => null)) as { data?: unknown } | null;
  if (!response.ok) {
    throw new AxleGatewayError(
      messageFrom(value, `The Axle gateway refused the request (${response.status}).`),
      response.status,
    );
  }
  const data = Array.isArray(value?.data) ? value.data : [];
  return data.map((entry) => {
    const row = entry as Record<string, unknown>;
    const axle = (row.axle ?? {}) as Record<string, unknown>;
    return {
      id: typeof row.id === "string" ? row.id : "",
      label: typeof axle.label === "string" ? axle.label : String(row.id ?? ""),
      tier: asNumber(axle.tier),
      plan: axle.plan === "paid" ? "paid" : "free",
      contextWindow: asNumber(axle.context_window),
      creditsPerMillionInput: asNumber(axle.credits_per_million_input),
      creditsPerMillionOutput: asNumber(axle.credits_per_million_output),
    };
  });
}

/** Credits formatted the way the gateway stores them: at most six decimals. */
export function formatCredits(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}
