import {
  CheckCircle2Icon,
  CpuIcon,
  HardDriveDownloadIcon,
  LoaderCircleIcon,
  LockIcon,
  PlayIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type LocalModelPackId,
  type LocalModelPackState,
  type LocalModelSnapshot,
} from "@axle/contracts";

import { localModelPackAllowed } from "../../entitlements/axleModelAccess";
import { useEntitlements, resolvedEntitlements } from "../../entitlements/useEntitlements";
import { planTierFromId, resolvePricingUrl } from "../../entitlements/planCatalog";
import {
  fetchLocalModels,
  installLocalModel,
  removeLocalModel,
  startLocalModel,
  stopLocalModel,
} from "../../localModels/localModelsClient";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";

const PLAN_LABEL = {
  pro: "Pro",
  "pro-plus": "Pro+",
  ultra: "Ultra",
} as const;

const STATUS_POLL_MS = 2_500;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 GB";
  const gigabytes = bytes / 1_000_000_000;
  return gigabytes >= 10 ? `${gigabytes.toFixed(1)} GB` : `${gigabytes.toFixed(2)} GB`;
}

function packStatusLabel(pack: LocalModelPackState): string {
  switch (pack.status) {
    case "downloading":
      return `Downloading ${Math.round(pack.progress * 100)}%`;
    case "installing":
      return "Installing";
    case "installed":
      return "Installed";
    case "error":
      return "Install failed";
    case "not-installed":
      return "Not installed";
  }
}

function PackCard({
  pack,
  allowed,
  busy,
  runtime,
  planKnown,
  onInstall,
  onRemove,
  onStart,
  onStop,
}: {
  readonly pack: LocalModelPackState;
  readonly allowed: boolean;
  readonly busy: boolean;
  readonly runtime: LocalModelSnapshot["runtime"];
  readonly planKnown: boolean;
  readonly onInstall: (packId: LocalModelPackId) => void;
  readonly onRemove: (packId: LocalModelPackId) => void;
  readonly onStart: (packId: LocalModelPackId) => void;
  readonly onStop: () => void;
}) {
  const installing = pack.status === "downloading" || pack.status === "installing";
  const running = runtime.status === "ready" && runtime.packId === pack.id;
  const starting = runtime.status === "starting" && runtime.packId === pack.id;
  const requiredPlan = PLAN_LABEL[pack.minPlanTier as keyof typeof PLAN_LABEL] ?? "paid";
  const pricingUrl = resolvePricingUrl();

  return (
    <div className="min-w-0 py-5 first:pt-3" data-testid={`local-model-pack-${pack.id}`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-foreground">{pack.name}</h3>
            <span className="rounded-full border border-border/70 bg-muted/30 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {planKnown ? requiredPlan : `${requiredPlan} required`}
            </span>
            {pack.capabilities.includes("vision") ? (
              <span className="rounded-full border border-border/70 bg-muted/30 px-2 py-0.5 text-[11px] text-muted-foreground">
                Vision
              </span>
            ) : null}
            {running ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                <CheckCircle2Icon className="size-3" />
                Running
              </span>
            ) : null}
          </div>
          <p className="max-w-prose text-[13px] leading-5 text-muted-foreground">
            {pack.description}
          </p>
          <p className="text-xs text-muted-foreground">
            {pack.model} · {pack.quantization} · {formatBytes(pack.sizeBytes)} download ·{" "}
            {pack.minRamGb} GB RAM recommended · {pack.license}
          </p>
          {pack.status === "error" && pack.error ? (
            <p className="max-w-prose text-xs leading-5 text-destructive">{pack.error}</p>
          ) : null}
          {installing ? (
            <div className="max-w-sm space-y-1 pt-1">
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-foreground transition-[width] duration-500"
                  style={{ width: `${Math.max(2, Math.round(pack.progress * 100))}%` }}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">{packStatusLabel(pack)}</p>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!allowed ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <LockIcon className="size-3.5" />
              {pricingUrl ? (
                <a
                  className="font-medium text-foreground underline underline-offset-4"
                  href={pricingUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Upgrade to {requiredPlan}
                </a>
              ) : (
                <span>Requires {requiredPlan}</span>
              )}
            </div>
          ) : null}
          {pack.status === "installed" ? (
            <>
              {allowed ? (
                running ? (
                  <Button size="sm" variant="outline" onClick={onStop} disabled={busy}>
                    <SquareIcon className="size-3.5" />
                    Stop
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onStart(pack.id)}
                    disabled={busy || starting || !runtime.runtimeAvailable}
                  >
                    {starting ? (
                      <LoaderCircleIcon className="size-3.5 animate-spin" />
                    ) : (
                      <PlayIcon className="size-3.5" />
                    )}
                    {starting ? "Starting" : "Start"}
                  </Button>
                )
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => onRemove(pack.id)} disabled={busy}>
                <Trash2Icon className="size-3.5" />
                Remove
              </Button>
            </>
          ) : null}
          {allowed && pack.status !== "installed" ? (
            <Button
              size="sm"
              onClick={() => onInstall(pack.id)}
              disabled={busy || installing || !runtime.runtimeAvailable}
              className={cn(installing && "opacity-80")}
            >
              {installing ? (
                <LoaderCircleIcon className="size-3.5 animate-spin" />
              ) : (
                <HardDriveDownloadIcon className="size-3.5" />
              )}
              {installing ? "Installing" : pack.status === "error" ? "Retry" : "Install"}
            </Button>
          ) : null}
          {installing ? (
            <Button size="sm" variant="ghost" onClick={() => onRemove(pack.id)} disabled={busy}>
              Cancel
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Axle Offline settings. The renderer asks this server to manage models; users
 * never choose a path, port, or localhost URL, and never install Ollama.
 */
export function AxleOfflineSettings({
  onModelsChanged,
}: {
  readonly onModelsChanged?: (() => void) | undefined;
}) {
  const entitlementsSnapshot = useEntitlements();
  const entitlements = resolvedEntitlements(entitlementsSnapshot);
  const planTier = planTierFromId(entitlements?.planId);
  const planKnown = planTier !== null;
  const pricingUrl = resolvePricingUrl();
  const [snapshot, setSnapshot] = useState<LocalModelSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyPackId, setBusyPackId] = useState<LocalModelPackId | null>(null);
  const [stopping, setStopping] = useState(false);
  const onModelsChangedRef = useRef(onModelsChanged);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchLocalModels();
      setSnapshot(next);
      setLoadError(null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refresh();
    };
    tick();
    const timer = setInterval(tick, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refresh]);

  const runPackAction = useCallback(
    async (packId: LocalModelPackId, action: () => Promise<LocalModelSnapshot>) => {
      setBusyPackId(packId);
      setActionError(null);
      try {
        const next = await action();
        setSnapshot(next);
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusyPackId(null);
      }
    },
    [],
  );

  const install = useCallback(
    (packId: LocalModelPackId) => {
      void runPackAction(packId, () => installLocalModel(packId));
    },
    [runPackAction],
  );

  const remove = useCallback(
    (packId: LocalModelPackId) => {
      if (
        !window.confirm(
          "Remove this offline model? Downloaded files and any install progress on this device will be deleted.",
        )
      )
        return;
      void runPackAction(packId, () => removeLocalModel(packId));
    },
    [runPackAction],
  );

  const start = useCallback(
    (packId: LocalModelPackId) => {
      void runPackAction(packId, () => startLocalModel(packId));
    },
    [runPackAction],
  );

  const stop = useCallback(async () => {
    setStopping(true);
    setActionError(null);
    try {
      setSnapshot(await stopLocalModel());
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStopping(false);
    }
  }, []);

  const packs = snapshot?.packs ?? [];
  const installedCount = packs.filter((pack) => pack.status === "installed").length;
  const runtime = snapshot?.runtime;
  const sortedPacks = useMemo(
    () =>
      [...packs].sort((left, right) => {
        const leftAllowed = localModelPackAllowed(planTier, left.id);
        const rightAllowed = localModelPackAllowed(planTier, right.id);
        if (leftAllowed !== rightAllowed) return leftAllowed ? -1 : 1;
        return left.sizeBytes - right.sizeBytes;
      }),
    [packs, planTier],
  );
  const installedKey = useMemo(
    () =>
      packs
        .filter((pack) => pack.status === "installed")
        .map((pack) => pack.id)
        .sort()
        .join(","),
    [packs],
  );
  const previousInstalledKey = useRef<string | null>(null);
  useEffect(() => {
    onModelsChangedRef.current = onModelsChanged;
  }, [onModelsChanged]);
  useEffect(() => {
    if (previousInstalledKey.current === installedKey) return;
    const hadSnapshot = previousInstalledKey.current !== null;
    previousInstalledKey.current = installedKey;
    // Refresh provider discovery when a pack becomes available or is removed,
    // so the model picker and provider list converge without a restart.
    if (hadSnapshot) onModelsChangedRef.current?.();
  }, [installedKey]);

  return (
    <SettingsSection
      title="Axle Offline"
      icon={<CpuIcon />}
      headerAction={
        <span className="text-xs text-muted-foreground">
          {installedCount > 0
            ? `${installedCount} installed · ${formatBytes(snapshot?.totalInstalledBytes ?? 0)}`
            : "Run models on this device"}
        </span>
      }
    >
      <div className="space-y-4 pt-5 text-[13px] leading-5 text-muted-foreground">
        <p className="max-w-prose">
          Download a managed model pack and Axle runs it on this device. There is no Ollama, API
          key, port, or localhost setup to manage. Packs are included with paid plans.
        </p>

        {loadError ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
            {loadError}
          </p>
        ) : null}
        {actionError ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
            {actionError}
          </p>
        ) : null}

        {snapshot && !snapshot.runtime.runtimeAvailable ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-amber-700 dark:text-amber-400">
            <p className="font-medium">The local inference engine is not installed.</p>
            <p className="mt-0.5">
              Run <code className="font-mono">pnpm local-runtime:install</code> in the Axle
              repository. Axle will pick it up automatically; packaged builds include the runtime.
            </p>
          </div>
        ) : null}

        {snapshot && snapshot.runtime.status !== "stopped" ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5">
            <div className="flex items-center gap-2">
              {snapshot.runtime.status === "ready" ? (
                <CheckCircle2Icon className="size-4 text-emerald-500" />
              ) : snapshot.runtime.status === "error" ? (
                <span className="size-2 rounded-full bg-destructive" />
              ) : (
                <LoaderCircleIcon className="size-4 animate-spin" />
              )}
              <span>
                {snapshot.runtime.status === "ready"
                  ? `Local engine ready · ${snapshot.runtime.packId ?? "model"}`
                  : snapshot.runtime.status === "starting"
                    ? `Loading ${snapshot.runtime.packId ?? "model"}…`
                    : snapshot.runtime.error || "The local engine stopped."}
              </span>
            </div>
            {snapshot.runtime.status !== "starting" ? (
              <Button size="sm" variant="ghost" onClick={() => void stop()} disabled={stopping}>
                {stopping ? (
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                ) : (
                  <SquareIcon className="size-3.5" />
                )}
                Stop engine
              </Button>
            ) : null}
          </div>
        ) : null}

        {!planKnown ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
            <LockIcon className="size-4" />
            <span>
              {entitlementsSnapshot.status === "loading"
                ? "Checking your plan…"
                : entitlementsSnapshot.status === "unavailable"
                  ? "Your plan could not be verified. Reconnect and try again."
                  : "Sign in to a paid plan to install Axle Offline packs."}
            </span>
            {pricingUrl ? (
              <a
                className="ml-auto font-medium text-foreground underline underline-offset-4"
                href={pricingUrl}
                target="_blank"
                rel="noreferrer"
              >
                View plans
              </a>
            ) : null}
          </div>
        ) : null}

        <div className="divide-y divide-border/60 border-t border-border/60">
          {sortedPacks.length === 0 && !loadError ? (
            <div className="flex items-center gap-2 py-5 text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" />
              Loading model packs…
            </div>
          ) : null}
          {sortedPacks.map((pack) => (
            <PackCard
              key={pack.id}
              pack={pack}
              allowed={localModelPackAllowed(planTier, pack.id)}
              busy={busyPackId === pack.id}
              runtime={
                runtime ?? {
                  status: "stopped",
                  packId: null,
                  error: null,
                  runtimeAvailable: false,
                }
              }
              planKnown={planKnown}
              onInstall={install}
              onRemove={remove}
              onStart={start}
              onStop={() => void stop()}
            />
          ))}
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground/80">
          Downloads are verified with SHA-256 before they are used. Model files stay on this device.
        </p>
      </div>
    </SettingsSection>
  );
}
