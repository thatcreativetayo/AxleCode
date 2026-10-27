import type { CloudEntitlements } from "@axle/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { AxleModelRate } from "../account/axleGateway";
import {
  lockedAxleLocalModelSlugs,
  lockedAxleModelSlugs,
  localModelPackAllowed,
} from "./axleModelAccess";

const rate = (id: string, plan: "free" | "paid"): AxleModelRate => ({
  id,
  label: id,
  tier: 0,
  plan,
  contextWindow: 128_000,
  creditsPerMillionInput: 10,
  creditsPerMillionOutput: 20,
});

const rates: ReadonlyArray<AxleModelRate> = [
  rate("gemma-4", "free"),
  rate("glm-5.3", "paid"),
  rate("nemotron-3-super", "paid"),
];

const entitlements = (planId: string): CloudEntitlements => ({
  planId,
  cloudJobsEnabled: planId !== "free",
  monthlyCredits: 0,
  maxConcurrentJobs: 1,
  features: { scheduledTasksMax: 2, pullRequestReviews: false, teamSharing: false },
});

describe("locked Axle model slugs", () => {
  it("locks nothing when no plan was positively resolved", () => {
    expect(lockedAxleModelSlugs(null, rates).size).toBe(0);
  });

  it("locks nothing when the catalog is unavailable", () => {
    expect(lockedAxleModelSlugs(entitlements("free"), null).size).toBe(0);
  });

  it("locks paid models on the Free plan", () => {
    expect([...lockedAxleModelSlugs(entitlements("free"), rates)].sort()).toEqual([
      "axle/glm-5.3",
      "axle/nemotron-3-super",
    ]);
  });

  it("locks nothing on a paid plan", () => {
    for (const planId of ["pro", "pro-plus", "ultra"]) {
      expect(lockedAxleModelSlugs(entitlements(planId), rates).size).toBe(0);
    }
  });

  it("fails open for an unrecognized plan id", () => {
    expect(lockedAxleModelSlugs(entitlements("enterprise"), rates).size).toBe(0);
  });
});

describe("Axle Offline pack access", () => {
  it("fails closed when the plan is unresolved", () => {
    expect(localModelPackAllowed(null, "compact")).toBe(false);
    expect([...lockedAxleLocalModelSlugs(null)]).toHaveLength(6);
  });

  it("maps packs to their minimum paid tier", () => {
    for (const packId of ["compact", "standard"] as const) {
      expect(localModelPackAllowed("free", packId)).toBe(false);
      expect(localModelPackAllowed("pro", packId)).toBe(true);
    }
    expect(localModelPackAllowed("pro", "advanced")).toBe(false);
    expect(localModelPackAllowed("pro-plus", "advanced")).toBe(true);
    expect(localModelPackAllowed("pro-plus", "coder")).toBe(true);
    expect(localModelPackAllowed("pro-plus", "max")).toBe(false);
    expect(localModelPackAllowed("ultra", "max")).toBe(true);
    expect(localModelPackAllowed("ultra", "vision")).toBe(true);
  });

  it("locks only the packs the plan does not include", () => {
    expect([...lockedAxleLocalModelSlugs(entitlements("free"))].sort()).toEqual([
      "axle-local/advanced",
      "axle-local/coder",
      "axle-local/compact",
      "axle-local/max",
      "axle-local/standard",
      "axle-local/vision",
    ]);
    expect([...lockedAxleLocalModelSlugs(entitlements("pro"))].sort()).toEqual([
      "axle-local/advanced",
      "axle-local/coder",
      "axle-local/max",
      "axle-local/vision",
    ]);
    expect([...lockedAxleLocalModelSlugs(entitlements("pro-plus"))].sort()).toEqual([
      "axle-local/max",
      "axle-local/vision",
    ]);
    expect([...lockedAxleLocalModelSlugs(entitlements("ultra"))]).toHaveLength(0);
  });
});
