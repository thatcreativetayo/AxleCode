import { SparklesIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { useAccountState } from "../../account/AccountAuthProvider";
import { useAccountSnapshot } from "../../account/useAccountSnapshot";
import { startPlanCheckout } from "../billing/UpgradeDialog";
import { PlanCard } from "../billing/PlanPackages";
import { resolveCloudPublicConfig } from "../../cloud/publicConfig";
import { PLAN_ORDER, planTierFromId, type PlanTier } from "../../entitlements/planCatalog";
import { useEntitlements, resolvedEntitlements } from "../../entitlements/useEntitlements";
import { SettingsSection } from "../settings/settingsLayout";

/**
 * The plan tab of the billing page: the same plan package cards as the
 * upgrade dialog, rendered inline. Enforcement stays server-side; this section
 * only presents and starts hosted checkouts. An unresolved plan displays as
 * Free — every account falls back to the Free tier — while the note under the
 * heading explains what could not be refreshed.
 */
export function BillingPlanSection() {
  const account = useAccountState();
  const { state: accountSnapshot } = useAccountSnapshot();
  const entitlementSnapshot = useEntitlements();
  const entitlements = resolvedEntitlements(entitlementSnapshot);
  const resolvedPlan = planTierFromId(entitlements?.planId ?? null);
  const currentPlan: PlanTier = resolvedPlan ?? "free";
  const accountApiUrl = resolveCloudPublicConfig().accountApiUrl;
  const email =
    accountSnapshot.snapshot?.user?.email ??
    account.user?.primaryEmailAddress?.emailAddress ??
    null;
  const [checkoutBusy, setCheckoutBusy] = useState<PlanTier | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  const checkout = useCallback(
    async (tier: PlanTier) => {
      if (tier === "free" || accountApiUrl === null) return;
      if (account.status !== "signed-in") return;
      setCheckoutBusy(tier);
      setCheckoutError(null);
      try {
        await startPlanCheckout({ accountApiUrl, plan: tier, email });
      } catch {
        setCheckoutError("Could not start checkout. Please try again.");
      } finally {
        setCheckoutBusy(null);
      }
    },
    [account.status, accountApiUrl, email],
  );

  const planNote = (() => {
    if (resolvedPlan !== null) return null;
    if (entitlementSnapshot.status === "loading") return "Checking your plan…";
    if (account.status !== "signed-in") return "Sign in to sync your plan across your devices.";
    if (accountApiUrl === null) {
      return "This build has no account service, so plans and checkout are unavailable.";
    }
    return "Your plan could not be refreshed; showing the Free plan until it loads.";
  })();

  const checkoutAvailable = accountApiUrl !== null;

  return (
    <SettingsSection title="Plans" icon={<SparklesIcon />}>
      <div className="pt-4">
        {planNote !== null ? (
          <p className="pb-3 text-xs leading-5 text-muted-foreground">{planNote}</p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {PLAN_ORDER.map((tier) => (
            <PlanCard
              key={tier}
              tier={tier}
              currentPlan={currentPlan}
              actionDisabled={account.status !== "signed-in" || !checkoutAvailable}
              busy={checkoutBusy === tier}
              onAction={() => void checkout(tier)}
            />
          ))}
        </div>
        {checkoutError !== null ? (
          <p className="pt-3 text-[11px] leading-4 text-destructive-foreground">{checkoutError}</p>
        ) : null}
        {!checkoutAvailable ? (
          <p className="pt-3 text-[11px] leading-4 text-muted-foreground">
            Paid checkout is not configured in this build.
          </p>
        ) : null}
      </div>
    </SettingsSection>
  );
}
