/**
 * Display metadata for the Axle plan catalog.
 *
 * Enforcement always happens server-side from `AXLE_BILLING_CONFIG` and the
 * hosted-provider gateway; this file only decides how a plan is presented.
 * Prices are display copy — keep them in sync with the Bachs products before
 * announcing paid sign-up.
 */

export type PlanTier = "free" | "pro" | "pro-plus" | "ultra";

/** Monthly gateway credits each paid tier grants (100/day stays free for all). */
export const PLAN_MONTHLY_CREDITS: Readonly<Record<PlanTier, number>> = {
  free: 0,
  pro: 2_000,
  "pro-plus": 4_000,
  ultra: 10_000,
};

export interface PlanDisplay {
  readonly tier: PlanTier;
  readonly name: string;
  readonly price: string;
  readonly priceUnit: string;
  readonly tagline: string;
  readonly highlights: readonly string[];
}

export const PLAN_ORDER: readonly PlanTier[] = ["free", "pro", "pro-plus", "ultra"];

export const PLAN_DISPLAY: Record<PlanTier, PlanDisplay> = {
  free: {
    tier: "free",
    name: "Free",
    price: "$0",
    priceUnit: "forever",
    tagline: "Your local workspace, free to keep.",
    highlights: [
      "Local projects, terminal, and Git tools",
      "Bring your own model keys or local models",
      "Google Gemma 4, Meta Muse Glimmer, and Nemotron 3.5 Lightning",
      "100 Axle credits every day",
      "Up to 2 scheduled tasks",
    ],
  },
  pro: {
    tier: "pro",
    name: "Pro",
    price: "$20",
    priceUnit: "per month",
    tagline: "For individual work that should not wait.",
    highlights: [
      "Everything in Free",
      "GLM 5.3, GLM 5.3 Flash, and Nemotron 3 Super",
      "2,000 Axle credits every month",
      "Up to 50 scheduled tasks",
      "Model-assisted pull-request reviews",
      "Cloud schedules that run on an Axle cloud runner",
    ],
  },
  "pro-plus": {
    tier: "pro-plus",
    name: "Pro+",
    price: "$60",
    priceUnit: "per month",
    tagline: "Heavier work, longer runs, more of everything.",
    highlights: [
      "Everything in Pro",
      "4,000 Axle credits every month",
      "Up to 100 scheduled tasks",
      "More concurrent cloud jobs",
    ],
  },
  ultra: {
    tier: "ultra",
    name: "Ultra",
    price: "$200",
    priceUnit: "per month",
    tagline: "The whole engine, with the limits taken off.",
    highlights: [
      "Everything in Pro+",
      "10,000 Axle credits every month",
      "Up to 200 scheduled tasks",
      "The highest cloud-job concurrency",
    ],
  },
};

export function planTierFromId(planId: string | null | undefined): PlanTier | null {
  return planId === "free" || planId === "pro" || planId === "pro-plus" || planId === "ultra"
    ? planId
    : null;
}

/** Upgrade CTAs make sense for every tier except the top one. */
export function planSupportsUpgrade(tier: PlanTier): boolean {
  return tier !== "ultra";
}

/** Where the upgrade CTAs send people; unset means the CTA is disabled. */
export function resolvePricingUrl(): string | null {
  const raw = import.meta.env.VITE_PRICING_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
