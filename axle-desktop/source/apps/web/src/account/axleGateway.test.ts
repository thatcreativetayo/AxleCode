import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  AxleGatewayError,
  axleGatewayBaseUrl,
  fetchAxleCredits,
  fetchAxleModelRates,
  fetchAxleUsage,
  formatCredits,
} from "./axleGateway";

vi.mock("../environments/primary/httpLayer", () => ({
  fetchPrimaryEnvironment: (input: RequestInfo | URL, init: RequestInit = {}) =>
    globalThis.fetch(input, init),
}));

vi.mock("../environments/primary/target", () => ({
  resolvePrimaryEnvironmentHttpUrl: (path: string) => `http://127.0.0.1:41999${path}`,
}));

const originalFetch = globalThis.fetch;

function respondWith(payload: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.stubGlobal("fetch", originalFetch);
});

describe("gateway base URL", () => {
  it("defaults to the deployed gateway and has no trailing slash", () => {
    expect(axleGatewayBaseUrl()).toMatch(/^https:\/\/.+\/v1$/u);
  });
});

describe("credits", () => {
  it("reads the balance and its three buckets through the local server", async () => {
    const fetchMock = respondWith({
      connected: true,
      object: "axle.credits",
      credits: 2_191.5,
      credit_usd: 0.005,
      daily_free_credits: 100,
      free_credits: 91.5,
      plan_credits: 2_000,
      paid_credits: 100,
      balance_usd: 10.9575,
    });
    expect(await fetchAxleCredits()).toEqual({
      credits: 2_191.5,
      dailyFreeCredits: 100,
      freeCredits: 91.5,
      planCredits: 2_000,
      paidCredits: 100,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("/api/axle/credits");
    expect(url).not.toContain("axl_");
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("reports no balance when the server has no connected account", async () => {
    respondWith({ connected: false });
    expect(await fetchAxleCredits()).toBeNull();
  });

  it("falls back to zeroes rather than NaN when fields are missing", async () => {
    respondWith({ connected: true });
    const credits = await fetchAxleCredits();
    expect(credits?.credits).toBe(0);
    expect(credits?.dailyFreeCredits).toBe(0);
  });

  it("surfaces the server's own error message on a 401", async () => {
    respondWith({ connected: true, error: "Missing Axle API key." }, 401);
    await expect(fetchAxleCredits()).rejects.toThrow("Missing Axle API key.");
  });

  it("accepts a plain string error body too", async () => {
    respondWith({ connected: true, error: "Revoked." }, 401);
    const error = await fetchAxleCredits().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AxleGatewayError);
    expect((error as AxleGatewayError).message).toBe("Revoked.");
    expect((error as AxleGatewayError).status).toBe(401);
  });
});

describe("usage", () => {
  it("maps ledger rows and drops nothing it can explain", async () => {
    respondWith({
      connected: true,
      object: "axle.usage",
      entries: [
        { kind: "daily_grant", credits: 100, balance_after: 100, model: null, created_at: 1 },
        { kind: "spend", credits: -12.5, balance_after: 87.5, model: "axle-nano", created_at: 2 },
      ],
    });
    expect(await fetchAxleUsage()).toEqual([
      { kind: "daily_grant", credits: 100, balanceAfter: 100, model: null, createdAt: 1 },
      { kind: "spend", credits: -12.5, balanceAfter: 87.5, model: "axle-nano", createdAt: 2 },
    ]);
  });

  it("returns an empty list when the payload has no entries array", async () => {
    respondWith({ connected: true, object: "axle.usage" });
    expect(await fetchAxleUsage()).toEqual([]);
  });

  it("keeps a row whose optional fields are the wrong type", async () => {
    respondWith({
      connected: true,
      entries: [{ kind: "spend", credits: "12", balance_after: null, model: 7 }],
    });
    expect(await fetchAxleUsage()).toEqual([
      { kind: "spend", credits: 0, balanceAfter: 0, model: null, createdAt: 0 },
    ]);
  });

  it("returns an empty list when no account is connected", async () => {
    respondWith({ connected: false, entries: null });
    expect(await fetchAxleUsage()).toEqual([]);
  });
});

describe("model rates", () => {
  it("flattens the OpenAI-shaped catalog", async () => {
    respondWith({
      object: "list",
      data: [
        {
          id: "axle-nano",
          axle: {
            label: "Axle Nano",
            tier: 1,
            context_window: 128000,
            credits_per_million_input: 40,
            credits_per_million_output: 160,
          },
        },
      ],
    });
    expect(await fetchAxleModelRates()).toEqual([
      {
        id: "axle-nano",
        label: "Axle Nano",
        tier: 1,
        plan: "free",
        contextWindow: 128000,
        creditsPerMillionInput: 40,
        creditsPerMillionOutput: 160,
      },
    ]);
  });

  it("marks a paid model as plan-gated", async () => {
    respondWith({
      data: [
        {
          id: "glm-5.3",
          axle: { label: "GLM 5.3", tier: 3, plan: "paid" },
        },
      ],
    });
    expect((await fetchAxleModelRates())[0]?.plan).toBe("paid");
  });

  it("does not need a key", async () => {
    const fetchMock = respondWith({ data: [] });
    await fetchAxleModelRates();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).not.toHaveProperty("Authorization");
  });
});

describe("credit formatting", () => {
  it("keeps whole numbers whole", () => {
    expect(formatCredits(100)).toBe("100");
    expect(formatCredits(0)).toBe("0");
  });

  it("trims trailing zeros from fractional credits", () => {
    expect(formatCredits(12.5)).toBe("12.5");
    expect(formatCredits(91.5)).toBe("91.5");
    expect(formatCredits(0.5)).toBe("0.5");
    expect(formatCredits(12.3456)).toBe("12.35");
    expect(formatCredits(0.004)).toBe("0");
  });
});
