import { SparklesIcon } from "lucide-react";
import { useCallback, useState, useSyncExternalStore } from "react";
import { CloudJobsClient } from "@axle/client-runtime/cloud/jobs";

import { useAccountState } from "../../account/AccountAuthProvider";
import { readClerkAccountToken } from "../../account/clerkRuntime";
import { useAccountSnapshot } from "../../account/useAccountSnapshot";
import { resolveCloudPublicConfig } from "../../cloud/publicConfig";
import {
  PLAN_ORDER,
  planTierFromId,
  resolvePricingUrl,
  type PlanTier,
} from "../../entitlements/planCatalog";
import { useEntitlements, resolvedEntitlements } from "../../entitlements/useEntitlements";
import { PlanCard } from "./PlanPackages";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export type UpgradeReason =
  | "models"
  | "cloud-jobs"
  | "schedules"
  | "pull-request-reviews"
  | "plugins"
  | "account-menu";

const REASON_COPY: Record<UpgradeReason, { readonly title: string; readonly description: string }> =
  {
    models: {
      title: "This model is included with paid plans",
      description:
        "Paid plans unlock GLM 5.3, GLM 5.3 Flash, and Nemotron 3 Super, along with monthly credits, cloud jobs, and higher scheduled-task limits.",
    },
    "cloud-jobs": {
      title: "Cloud jobs are part of paid plans",
      description:
        "Cloud jobs run on Axle runners that keep working when this computer is offline, with an included monthly credit bundle.",
    },
    schedules: {
      title: "You have reached the Free scheduled-task limit",
      description:
        "Paid plans raise the limit so recurring work can keep running across all of your chats.",
    },
    "pull-request-reviews": {
      title: "Model-assisted pull-request reviews are part of paid plans",
      description:
        "Paid plans review your pull requests with the model of your choice and post the findings back to GitHub.",
    },
    plugins: {
      title: "Jira, Notion, Slack, and email plugins are part of paid plans",
      description:
        "GitHub is included on Free. Paid plans unlock the other plugins, along with the GLM 5.3 and Nemotron families, monthly credits, and cloud jobs.",
    },
    "account-menu": {
      title: "Get more out of Axle",
      description:
        "Paid plans add the GLM 5.3 and Nemotron families, monthly credits, cloud jobs, higher scheduled-task limits, and pull-request reviews.",
    },
  };

interface UpgradeDialogState {
  readonly open: boolean;
  readonly reason: UpgradeReason;
}

let dialogState: UpgradeDialogState = { open: false, reason: "account-menu" };
const listeners = new Set<() => void>();

function publish(next: UpgradeDialogState): void {
  dialogState = next;
  for (const listener of listeners) {
    listener();
  }
}

export function openUpgradeDialog(reason: UpgradeReason = "account-menu"): void {
  publish({ open: true, reason });
}

export function closeUpgradeDialog(): void {
  publish({ ...dialogState, open: false });
}

function subscribeUpgradeDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readUpgradeDialogState(): UpgradeDialogState {
  return dialogState;
}

export function openExternalUrl(url: string): void {
  const openExternal = window.desktopBridge?.openExternal;
  if (typeof openExternal === "function") {
    void openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Shared by the dialog and the billing page so both start checkout the same way. */
export async function startPlanCheckout(options: {
  readonly accountApiUrl: string;
  readonly plan: Exclude<PlanTier, "free">;
  readonly email: string | null;
}): Promise<void> {
  const client = new CloudJobsClient({
    baseUrl: options.accountApiUrl,
    getToken: readClerkAccountToken,
  });
  const session = await client.createCheckoutSession({
    plan: options.plan,
    ...(options.email !== null ? { email: options.email } : {}),
  });
  openExternalUrl(session.checkoutUrl);
}

/** One-time credit pack: the buyer chose the whole-dollar amount in our UI. */
export async function startCreditsCheckout(options: {
  readonly accountApiUrl: string;
  readonly usd: number;
  readonly email: string | null;
}): Promise<void> {
  const client = new CloudJobsClient({
    baseUrl: options.accountApiUrl,
    getToken: readClerkAccountToken,
  });
  const session = await client.createCheckoutSession({
    plan: "credits",
    usd: options.usd,
    ...(options.email !== null ? { email: options.email } : {}),
  });
  openExternalUrl(session.checkoutUrl);
}

/** Renders once at the app root; opened through `openUpgradeDialog`. */
export function UpgradeDialogHost() {
  const state = useSyncExternalStore(
    subscribeUpgradeDialog,
    readUpgradeDialogState,
    readUpgradeDialogState,
  );
  const account = useAccountState();
  const { state: accountSnapshot } = useAccountSnapshot();
  const entitlements = resolvedEntitlements(useEntitlements());
  const currentPlan = planTierFromId(entitlements?.planId ?? null);
  const pricingUrl = resolvePricingUrl();
  const accountApiUrl = resolveCloudPublicConfig().accountApiUrl;
  const email =
    accountSnapshot.snapshot?.user?.email ??
    account.user?.primaryEmailAddress?.emailAddress ??
    null;
  const [checkoutBusy, setCheckoutBusy] = useState<PlanTier | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const copy = REASON_COPY[state.reason];

  const startCheckout = useCallback(
    async (tier: PlanTier) => {
      if (tier === "free") {
        closeUpgradeDialog();
        return;
      }
      if (accountApiUrl === null) {
        // Deployments without an account API fall back to the marketing page.
        if (pricingUrl !== null) openExternalUrl(pricingUrl);
        return;
      }
      if (account.status !== "signed-in") {
        setCheckoutError("Sign in to upgrade.");
        return;
      }
      setCheckoutBusy(tier);
      setCheckoutError(null);
      try {
        await startPlanCheckout({ accountApiUrl, plan: tier, email });
        closeUpgradeDialog();
      } catch {
        setCheckoutError("Could not start checkout. Please try again.");
      } finally {
        setCheckoutBusy(null);
      }
    },
    [account.status, accountApiUrl, email, pricingUrl],
  );

  const checkoutAvailable = accountApiUrl !== null || pricingUrl !== null;

  return (
    <Dialog
      open={state.open}
      onOpenChange={(open) => {
        if (!open) closeUpgradeDialog();
      }}
    >
      <DialogPopup className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SparklesIcon className="size-4 text-muted-foreground" />
            {copy.title}
          </DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" scrollFade={false}>
          {PLAN_ORDER.map((tier) => (
            <PlanCard
              key={tier}
              tier={tier}
              currentPlan={currentPlan}
              actionDisabled={!checkoutAvailable}
              busy={checkoutBusy === tier}
              onAction={() => void startCheckout(tier)}
            />
          ))}
          {checkoutError !== null ? (
            <p className="text-[11px] leading-4 text-destructive-foreground sm:col-span-2 lg:col-span-4">
              {checkoutError}
            </p>
          ) : null}
          {!checkoutAvailable ? (
            <p className="text-[11px] leading-4 text-muted-foreground sm:col-span-2 lg:col-span-4">
              Paid checkout is not configured in this build.
            </p>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
