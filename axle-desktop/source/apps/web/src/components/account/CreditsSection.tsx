import {
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  CoinsIcon,
  GaugeIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  SparklesIcon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { useAccountState } from "../../account/AccountAuthProvider";
import { useAccountSnapshot } from "../../account/useAccountSnapshot";
import {
  fetchAxleCredits,
  fetchAxleModelRates,
  fetchAxleUsage,
  formatCredits,
  type AxleCredits,
  type AxleModelRate,
  type AxleUsageEntry,
} from "../../account/axleGateway";
import { startCreditsCheckout } from "../billing/UpgradeDialog";
import { resolveCloudPublicConfig } from "../../cloud/publicConfig";
import { SettingsSection, useRelativeTimeTick } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { cn } from "../../lib/utils";
import { AccountRow } from "./accountShared";
import { epochToIso, formatTimestamp } from "./accountFormat";

const ENTRY_LABELS: Record<string, string> = {
  daily_grant: "Daily free credits",
  spend: "Model usage",
  settle: "Usage adjustment",
  top_up: "Top-up or refund",
  refund: "Usage adjustment",
};

function entryLabel(kind: string): string {
  return ENTRY_LABELS[kind] ?? kind.replaceAll("_", " ");
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

interface CreditsLoad {
  readonly credits: AxleCredits | null;
  /** `false` when the app is not connected to an Axle account yet. */
  readonly connected: boolean | null;
  readonly usage: ReadonlyArray<AxleUsageEntry>;
  readonly error: string | null;
  readonly loading: boolean;
}

/** Shared with the billing page, which also shows the balance and its buckets. */
export function useAxleCredits(): CreditsLoad & { readonly reload: () => Promise<void> } {
  const [state, setState] = useState<CreditsLoad>({
    credits: null,
    connected: null,
    usage: [],
    error: null,
    loading: true,
  });

  const reload = useCallback(async () => {
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const [credits, usage] = await Promise.all([fetchAxleCredits(), fetchAxleUsage()]);
      setState({ credits, connected: credits !== null, usage, error: null, loading: false });
    } catch (error: unknown) {
      setState((previous) => ({
        ...previous,
        loading: false,
        error: error instanceof Error ? error.message : "Credits could not be loaded.",
      }));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, reload };
}

function BalanceCard({
  credits,
  onRefresh,
  refreshing,
}: {
  readonly credits: AxleCredits;
  readonly onRefresh: () => Promise<void>;
  readonly refreshing: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/80 bg-card/40 px-5 py-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <CoinsIcon className="size-3.5" />
            Axle credits
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-3xl leading-9 font-semibold tracking-tight text-foreground">
              {formatCredits(credits.credits)}
            </span>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          disabled={refreshing}
          onClick={() => void onRefresh()}
        >
          {refreshing ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
          Refresh
        </Button>
      </div>
      <div className="mt-3 grid gap-1.5 text-xs leading-5 text-muted-foreground sm:grid-cols-3">
        <span>
          <span className="text-foreground/80">{formatCredits(credits.freeCredits)}</span> free —
          renews daily
        </span>
        <span>
          <span className="text-foreground/80">{formatCredits(credits.planCredits)}</span> plan —
          monthly allowance
        </span>
        <span>
          <span className="text-foreground/80">{formatCredits(credits.paidCredits)}</span> purchased
          — never expires
        </span>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        Every account gets {formatCredits(credits.dailyFreeCredits)} credits each UTC day for free,
        applied the first time you use the hosted provider that day. The daily grant renews — it
        never accumulates. Paid plans add a monthly allowance, and purchased credits stay until you
        spend them.
      </p>
    </div>
  );
}

/** Model rates only change with a deploy, so they load once and stay put. */
function ModelRatesSection() {
  const [models, setModels] = useState<ReadonlyArray<AxleModelRate> | null>(null);

  useEffect(() => {
    let active = true;
    fetchAxleModelRates()
      .then((rates) => {
        if (active) setModels(rates);
      })
      .catch(() => {
        if (active) setModels([]);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <SettingsSection
      title="Model credit rates"
      icon={<GaugeIcon />}
      headerAction={<span className="text-xs text-muted-foreground">per 1M tokens</span>}
    >
      {models === null ? (
        <div className="flex items-center gap-2 px-1 py-3.5 text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          Loading model rates…
        </div>
      ) : models.length === 0 ? (
        <div className="px-1 py-3.5 text-xs text-muted-foreground">
          Could not load the model catalog. Rates are also listed with the model picker.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead>Context</TableHead>
              <TableHead className="text-end">Input</TableHead>
              <TableHead className="text-end">Output</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {models.map((model) => (
              <TableRow key={model.id}>
                <TableCell className="font-medium text-foreground">{model.label}</TableCell>
                <TableCell>
                  <Badge variant="outline" size="sm">
                    Tier {model.tier}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatContextWindow(model.contextWindow)}
                </TableCell>
                <TableCell className="text-end text-muted-foreground">
                  {formatCredits(model.creditsPerMillionInput)}
                </TableCell>
                <TableCell className="text-end text-muted-foreground">
                  {formatCredits(model.creditsPerMillionOutput)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="px-1 pt-3 text-xs leading-5 text-muted-foreground">
        A turn is reserved at its worst case before it runs and the unused part is refunded from the
        provider's own token report, so a long reply never costs more than it used.
      </p>
    </SettingsSection>
  );
}

function UsageSection({
  usage,
  loading,
}: {
  readonly usage: ReadonlyArray<AxleUsageEntry>;
  readonly loading: boolean;
}) {
  useRelativeTimeTick(30_000);
  return (
    <SettingsSection title="Recent activity" icon={<SparklesIcon />}>
      {loading && usage.length === 0 ? (
        <div className="flex items-center gap-2 px-1 py-3.5 text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          Loading recent activity…
        </div>
      ) : usage.length === 0 ? (
        <div className="px-1 py-3.5 text-xs text-muted-foreground">
          Nothing yet. Send a message on the Axle provider and it will show up here.
        </div>
      ) : (
        <div className="divide-y divide-border/60">
          {usage.map((entry) => {
            const spend = entry.credits < 0;
            return (
              <AccountRow
                key={`${entry.createdAt}-${entry.kind}-${entry.balanceAfter}`}
                title={
                  <span className="flex items-center gap-2">
                    {spend ? (
                      <ArrowDownRightIcon className="size-3.5 text-muted-foreground" />
                    ) : (
                      <ArrowUpRightIcon className="size-3.5 text-muted-foreground" />
                    )}
                    {entryLabel(entry.kind)}
                    {entry.model ? (
                      <Badge variant="outline" size="sm">
                        {entry.model}
                      </Badge>
                    ) : null}
                  </span>
                }
                description={`${formatTimestamp(epochToIso(entry.createdAt))} · balance after ${formatCredits(entry.balanceAfter)}`}
              >
                <span
                  className={
                    spend
                      ? "font-mono text-[13px] tabular-nums text-muted-foreground"
                      : "font-mono text-[13px] tabular-nums text-success-foreground"
                  }
                >
                  {spend ? "" : "+"}
                  {formatCredits(entry.credits)}
                </span>
              </AccountRow>
            );
          })}
        </div>
      )}
      {usage.length > 0 ? (
        <p className="px-1 pt-3 text-xs text-muted-foreground">
          Showing the most recent {usage.length} entries.
        </p>
      ) : null}
    </SettingsSection>
  );
}

function NotConnectedNotice() {
  return (
    <SettingsSection title="Not connected yet" icon={<KeyRoundIcon />}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-1 py-4">
        <p className="max-w-prose text-[13px] leading-6 text-muted-foreground">
          This app is not spending from your Axle account yet. Create an API key here and it is
          connected automatically, or add{" "}
          <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[11px]">
            AXLE_API_KEY
          </code>{" "}
          in Settings → Providers.
        </p>
        <Button size="sm" render={<Link to="/settings/account/api-keys" />}>
          Create an API key
        </Button>
      </div>
    </SettingsSection>
  );
}

function CreditsLoadingPanel({ text }: { readonly text: string }) {
  return (
    <div className="flex items-center gap-2 px-1 py-6 text-[13px] text-muted-foreground">
      <LoaderCircleIcon className="size-4 animate-spin" />
      {text}
    </div>
  );
}

function CreditsErrorPanel({
  error,
  onRetry,
}: {
  readonly error: string;
  readonly onRetry: () => Promise<void>;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/80 bg-card/40 px-4 py-3">
      <span className="text-xs text-muted-foreground">{error}</span>
      <Button size="sm" variant="outline" className="h-8" onClick={() => void onRetry()}>
        Try again
      </Button>
    </div>
  );
}

/** Credit packs start at $5; $1 buys 200 credits on the hosted provider. */
const CREDITS_PER_DOLLAR = 200;
const TOPUP_PRESETS = [5, 10, 25, 50] as const;
const MIN_TOPUP_USD = 5;
const MAX_TOPUP_USD = 500;

function wholeCents(value: number): boolean {
  return Number.isFinite(value) && Math.round(value * 100) === value * 100;
}

/**
 * One-time credit packs. The buyer picks the whole-dollar amount here; the
 * hosted Bachs page takes the payment and the webhook credits the account.
 */
function BuyCreditsSection() {
  const account = useAccountState();
  const { state: accountSnapshot } = useAccountSnapshot();
  const accountApiUrl = resolveCloudPublicConfig().accountApiUrl;
  const email =
    accountSnapshot.snapshot?.user?.email ??
    account.user?.primaryEmailAddress?.emailAddress ??
    null;
  const signedIn = account.status === "signed-in";
  const [amount, setAmount] = useState<number | null>(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buy = useCallback(
    async (usd: number) => {
      if (accountApiUrl === null) {
        setError("Checkout is not configured in this build.");
        return;
      }
      if (!signedIn) {
        setError("Sign in to buy credits.");
        return;
      }
      if (!wholeCents(usd) || usd < MIN_TOPUP_USD || usd > MAX_TOPUP_USD) {
        setError(`Enter an amount between $${MIN_TOPUP_USD} and $${MAX_TOPUP_USD}.`);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await startCreditsCheckout({ accountApiUrl, usd, email });
      } catch {
        setError("Could not start checkout. Please try again.");
      } finally {
        setBusy(false);
      }
    },
    [accountApiUrl, email, signedIn],
  );

  const amountText = amount === null ? "" : String(amount);
  const valid =
    amount !== null && wholeCents(amount) && amount >= MIN_TOPUP_USD && amount <= MAX_TOPUP_USD;

  return (
    <SettingsSection title="Buy credits" icon={<CoinsIcon />}>
      <div className="px-1 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-foreground">Top up your Axle balance</p>
            <p className="mt-1 max-w-prose text-xs leading-5 text-muted-foreground">
              Credits never expire. $1 buys {formatCredits(CREDITS_PER_DOLLAR)} credits, and packs
              start at ${MIN_TOPUP_USD}.
            </p>
          </div>
          {valid && amount !== null ? (
            <span className="text-sm font-medium tabular-nums text-foreground">
              {formatCredits(amount * CREDITS_PER_DOLLAR)} credits
            </span>
          ) : null}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {TOPUP_PRESETS.map((preset) => {
            const selected = amount === preset;
            return (
              <button
                key={preset}
                type="button"
                disabled={busy}
                aria-pressed={selected}
                onClick={() => setAmount(preset)}
                className={cn(
                  "flex flex-col gap-0.5 rounded-xl border px-3 py-2.5 text-left outline-none transition-colors",
                  "focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                  selected
                    ? "border-ring bg-accent/40"
                    : "border-border bg-card/40 hover:border-border/80 hover:bg-muted/30",
                )}
              >
                <span className="text-sm font-semibold text-foreground">${preset}</span>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {formatCredits(preset * CREDITS_PER_DOLLAR)} credits
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="flex-1">
            <span className="mb-1 block text-[11px] text-muted-foreground">
              Custom amount (USD)
            </span>
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-xs text-muted-foreground">
                $
              </span>
              <Input
                type="number"
                min={MIN_TOPUP_USD}
                max={MAX_TOPUP_USD}
                step="0.01"
                value={amountText}
                placeholder="Custom"
                aria-label="Custom credit amount in USD"
                className="h-9 pl-7 text-[13px]"
                onChange={(event) => {
                  const parsed = Number(event.target.value);
                  setAmount(Number.isFinite(parsed) && parsed > 0 ? parsed : null);
                }}
              />
            </div>
          </label>
          <Button
            size="sm"
            className="h-9 sm:min-w-40"
            disabled={busy || !valid || !signedIn || accountApiUrl === null}
            onClick={() => amount !== null && void buy(amount)}
          >
            {busy ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <CoinsIcon className="size-3.5" />
            )}
            {valid && amount !== null
              ? `Buy ${formatCredits(amount * CREDITS_PER_DOLLAR)} credits`
              : "Buy credits"}
          </Button>
        </div>

        <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
          {signedIn
            ? "Checkout opens in Bachs's secure hosted page. Credits are added as soon as payment completes."
            : "Sign in to buy credits."}
        </p>
        {error !== null ? (
          <p className="mt-2 text-[11px] leading-4 text-destructive-foreground">{error}</p>
        ) : null}
      </div>
    </SettingsSection>
  );
}

/**
 * Balance, rates, and activity for the hosted provider. The balance is read
 * through the local server, which resolves the account key the Axle provider
 * itself chats with; an app without that connection shows how to make one
 * instead of a balance that is not really the account's.
 */
export function CreditsSection() {
  const { credits, connected, usage, error, loading, reload } = useAxleCredits();

  if (connected === false) {
    return (
      <>
        <NotConnectedNotice />
        <BuyCreditsSection />
        <ModelRatesSection />
      </>
    );
  }

  if (credits === null) {
    return (
      <>
        {error !== null ? (
          <CreditsErrorPanel error={error} onRetry={reload} />
        ) : (
          <CreditsLoadingPanel text="Loading your credits…" />
        )}
        <BuyCreditsSection />
        <ModelRatesSection />
      </>
    );
  }

  return (
    <>
      <BalanceCard credits={credits} onRefresh={reload} refreshing={loading} />

      {error !== null ? <CreditsErrorPanel error={error} onRetry={reload} /> : null}

      <BuyCreditsSection />
      <ModelRatesSection />
      <UsageSection usage={usage} loading={loading} />
    </>
  );
}
