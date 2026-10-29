import { ArrowUpRightIcon, CheckIcon, LoaderCircleIcon } from "lucide-react";

import { PLAN_DISPLAY, PLAN_ORDER, type PlanTier } from "../../entitlements/planCatalog";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

function planRank(tier: PlanTier): number {
  return PLAN_ORDER.indexOf(tier);
}

/** Shared with the upgrade dialog and the Settings billing page. */
export function PlanCard({
  tier,
  currentPlan,
  actionDisabled,
  busy,
  onAction,
}: {
  readonly tier: PlanTier;
  readonly currentPlan: PlanTier | null;
  readonly actionDisabled: boolean;
  readonly busy: boolean;
  readonly onAction: () => void;
}) {
  const plan = PLAN_DISPLAY[tier];
  const isCurrent = currentPlan === tier;
  const isPaid = tier !== "free";
  const actionLabel =
    tier === "free"
      ? "Stay on Free"
      : currentPlan !== null && planRank(tier) < planRank(currentPlan)
        ? `Switch to ${plan.name}`
        : `Upgrade to ${plan.name}`;

  return (
    <div
      className={cn(
        "flex flex-col rounded-2xl border border-border bg-card/40 p-5",
        isCurrent && "border-ring/60 bg-accent/20",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{plan.name}</h3>
        {isCurrent ? (
          <Badge variant="outline" size="sm">
            Current plan
          </Badge>
        ) : null}
      </div>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tracking-tight text-foreground">{plan.price}</span>
        <span className="text-[11px] text-muted-foreground">{plan.priceUnit}</span>
      </div>
      <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{plan.tagline}</p>
      <ul className="mt-4 space-y-2">
        {plan.highlights.map((highlight) => (
          <li
            key={highlight}
            className="flex items-start gap-2 text-xs leading-5 text-foreground/85"
          >
            <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-foreground/60" />
            {highlight}
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-5">
        {isCurrent ? (
          <Button variant="outline" size="sm" className="w-full" disabled>
            Current plan
          </Button>
        ) : (
          <Button
            variant={isPaid ? "default" : "outline"}
            size="sm"
            className="w-full"
            disabled={busy || (isPaid && actionDisabled)}
            onClick={onAction}
          >
            {busy ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : isPaid ? (
              <ArrowUpRightIcon className="size-3.5" />
            ) : null}
            {actionLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
