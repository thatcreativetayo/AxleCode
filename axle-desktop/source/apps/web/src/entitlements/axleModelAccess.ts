/**
 * Which Axle models the signed-in plan may reach.
 *
 * Hosted Axle models are enforced by the gateway, which refuses paid models on
 * a free plan; this module mirrors the catalog's `plan` flags so the picker can
 * show them disabled. Hosted gating fails open when the plan cannot be
 * resolved, because the gateway remains the authority.
 *
 * Axle Offline packs have no gateway in front of them. Their install and model
 * entries therefore fail closed when the plan is unresolved, so an outage
 * cannot hand out a paid feature.
 */

import type { CloudEntitlements, LocalModelPackId, LocalModelPlanTier } from "@axle/contracts";
import { LOCAL_MODEL_PACK_IDS, LOCAL_MODEL_PACK_MIN_PLAN } from "@axle/contracts";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { fetchAxleModelRates, type AxleModelRate } from "../account/axleGateway";
import { planTierFromId } from "./planCatalog";
import { resolvedEntitlements, useEntitlements } from "./useEntitlements";

/** The server builds Axle picker slugs as `axle/<gateway model id>`. */
const AXLE_SLUG_PREFIX = "axle/";
/** Axle Offline packs use the custom-provider slug prefix. */
const AXLE_LOCAL_SLUG_PREFIX = "axle-local/";

const PLAN_RANK: Readonly<Record<LocalModelPlanTier, number>> = {
  free: 0,
  pro: 1,
  "pro-plus": 2,
  ultra: 3,
};

/**
 * True when the resolved plan includes the pack. Axle Offline has no gateway
 * to enforce this at request time, so the client fails closed when the plan is
 * unresolved rather than granting a paid feature.
 */
export function localModelPackAllowed(
  planTier: LocalModelPlanTier | null,
  packId: LocalModelPackId,
): boolean {
  if (planTier === null) return false;
  return PLAN_RANK[planTier] >= PLAN_RANK[LOCAL_MODEL_PACK_MIN_PLAN[packId]];
}

const EMPTY_SLUGS: ReadonlySet<string> = new Set();

/**
 * Axle Offline packs are a paid plan feature. Unlike hosted models, there is
 * no gateway in front of them, so the picker needs to lock packs the plan does
 * not include. An unresolved plan locks every pack rather than silently
 * granting a paid feature.
 */
export function lockedAxleLocalModelSlugs(
  entitlements: CloudEntitlements | null,
): ReadonlySet<string> {
  const planTier = planTierFromId(entitlements?.planId);
  const locked = new Set<string>();
  for (const packId of LOCAL_MODEL_PACK_IDS) {
    if (!localModelPackAllowed(planTier, packId)) {
      locked.add(`${AXLE_LOCAL_SLUG_PREFIX}${packId}`);
    }
  }
  return locked;
}

/**
 * Slugs the picker must disable for this plan. Empty unless the plan
 * positively resolved to Free and the catalog loaded — every other
 * combination fails open.
 */
export function lockedAxleModelSlugs(
  entitlements: CloudEntitlements | null,
  rates: ReadonlyArray<AxleModelRate> | null,
): ReadonlySet<string> {
  if (entitlements === null || rates === null) return EMPTY_SLUGS;
  if (planTierFromId(entitlements.planId) !== "free") return EMPTY_SLUGS;
  const locked = new Set<string>();
  for (const rate of rates) {
    if (rate.plan === "paid") locked.add(`${AXLE_SLUG_PREFIX}${rate.id}`);
  }
  return locked;
}

type AxleRatesSnapshot =
  | { readonly status: "idle" | "loading" | "unavailable" }
  | { readonly status: "ready"; readonly rates: ReadonlyArray<AxleModelRate> };

let ratesSnapshot: AxleRatesSnapshot = { status: "idle" };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: AxleRatesSnapshot): void {
  ratesSnapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

export function readAxleRatesSnapshot(): AxleRatesSnapshot {
  return ratesSnapshot;
}

export function subscribeAxleRates(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Loads the public model catalog once per session; `force` refetches it. */
export function loadAxleModelRates(force = false): void {
  if (inflight !== null) return;
  if (!force && ratesSnapshot.status === "ready") return;
  if (ratesSnapshot.status !== "ready") publish({ status: "loading" });
  inflight = fetchAxleModelRates()
    .then((rates) => {
      publish({ status: "ready", rates });
    })
    .catch(() => {
      // An unreachable catalog must never hide models; the gateway still
      // enforces the plan server-side.
      publish({ status: "unavailable" });
    })
    .finally(() => {
      inflight = null;
    });
}

/** The live Axle catalog, or null until it loads (or when unreachable). */
export function useAxleModelRates(): ReadonlyArray<AxleModelRate> | null {
  const snapshot = useSyncExternalStore(
    subscribeAxleRates,
    readAxleRatesSnapshot,
    readAxleRatesSnapshot,
  );

  useEffect(() => {
    loadAxleModelRates();
  }, []);

  return snapshot.status === "ready" ? snapshot.rates : null;
}

/**
 * Axle model slugs the current account cannot use. Empty unless the plan
 * positively resolved to Free; callers show matching picker rows disabled.
 */
export function useLockedAxleModelSlugs(): ReadonlySet<string> {
  const entitlements = useEntitlements();
  const rates = useAxleModelRates();
  return useMemo(() => {
    const resolved = resolvedEntitlements(entitlements);
    const hosted = lockedAxleModelSlugs(resolved, rates);
    const local = lockedAxleLocalModelSlugs(resolved);
    if (local.size === 0) return hosted;
    return new Set([...hosted, ...local]);
  }, [entitlements, rates]);
}
