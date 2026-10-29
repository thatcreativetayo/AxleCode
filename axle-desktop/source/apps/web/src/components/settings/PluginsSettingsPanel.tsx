import {
  ArrowUpRightIcon,
  CheckIcon,
  ClockIcon,
  LoaderCircleIcon,
  LockIcon,
  PlugIcon,
  UnplugIcon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAccountState } from "../../account/AccountAuthProvider";
import { pluginLockedForPlan } from "../../entitlements/gates";
import { useEntitlements, resolvedEntitlements } from "../../entitlements/useEntitlements";
import { openUpgradeDialog } from "../billing/UpgradeDialog";
import { PluginLogo } from "../plugins/PluginLogo";
import {
  connectPlugin,
  disconnectPlugin,
  listPluginStatus,
  loadPluginSessionToken,
  type PluginStatus,
} from "../plugins/pluginApi";
import { PLUGINS, getPluginById, type PluginId } from "../plugins/pluginCatalog";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

type GitHubDisconnectBridge = {
  readonly disconnectGitHub?: () => Promise<unknown>;
};

function metadataSummary(status: PluginStatus): string | null {
  const metadata = status.metadata;
  if (!metadata) return null;
  for (const key of ["login", "teamName", "workspaceName", "siteName"] as const) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function PluginsSettingsPanel() {
  const account = useAccountState();
  const entitlements = resolvedEntitlements(useEntitlements());
  const pluginLocked = useCallback(
    (pluginId: PluginId) => pluginLockedForPlan(entitlements, pluginId),
    [entitlements],
  );
  const hasPluginSession =
    loadPluginSessionToken() !== null ||
    ((account.status === "signed-in" || account.status === "signed-out") &&
      account.pluginSessionReady);
  const pluginError =
    account.status === "signed-in" || account.status === "signed-out"
      ? account.pluginError
      : account.status === "error"
        ? account.error
        : null;
  const [statuses, setStatuses] = useState<PluginStatus[]>([]);
  const [busyPluginId, setBusyPluginId] = useState<PluginId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async (options: { readonly forceRefresh?: boolean } = {}) => {
    const sessionToken = loadPluginSessionToken();
    if (!sessionToken) {
      setStatuses([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      setStatuses(await listPluginStatus(sessionToken, options));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Installed plugins could not be loaded.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [hasPluginSession, refresh]);

  const installed = useMemo(
    () =>
      statuses
        .filter((status) => status.connected)
        .flatMap((status) => {
          const plugin = getPluginById(status.pluginId);
          return plugin ? [{ plugin, status }] : [];
        }),
    [statuses],
  );

  const connectedIds = useMemo(
    () => new Set(statuses.filter((status) => status.connected).map((status) => status.pluginId)),
    [statuses],
  );

  const available = useMemo(
    () => PLUGINS.filter((plugin) => !connectedIds.has(plugin.id)),
    [connectedIds],
  );

  const connect = useCallback(
    async (pluginId: PluginId) => {
      if (pluginLocked(pluginId)) {
        openUpgradeDialog("plugins");
        return;
      }
      const sessionToken = loadPluginSessionToken();
      if (!sessionToken) {
        setError(pluginError ?? "Your plugin session is still starting. Please try again shortly.");
        return;
      }
      if (busyPluginId) return;
      setBusyPluginId(pluginId);
      setError(null);
      try {
        await connectPlugin(sessionToken, pluginId);
        await refresh({ forceRefresh: true });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Plugin authorization failed.");
      } finally {
        setBusyPluginId(null);
      }
    },
    [busyPluginId, pluginError, pluginLocked, refresh],
  );

  const remove = useCallback(
    async (pluginId: PluginId) => {
      const sessionToken = loadPluginSessionToken();
      if (!sessionToken || busyPluginId) return;
      setBusyPluginId(pluginId);
      setError(null);
      try {
        await disconnectPlugin(sessionToken, pluginId);
        if (pluginId === "github") {
          const bridge = window.desktopBridge as unknown as GitHubDisconnectBridge | undefined;
          await bridge?.disconnectGitHub?.();
        }
        await refresh({ forceRefresh: true });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Plugin could not be deleted.");
      } finally {
        setBusyPluginId(null);
      }
    },
    [busyPluginId, refresh],
  );

  return (
    <SettingsPageContainer
      title="Plugins"
      description="Manage the tools and services connected to your workspace."
    >
      {!hasPluginSession ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-4 py-3"
        >
          {!pluginError ? (
            <LoaderCircleIcon
              className="size-3.5 shrink-0 animate-spin text-muted-foreground"
              aria-hidden
            />
          ) : null}
          <p className="text-xs text-muted-foreground">
            {pluginError ?? "Preparing your plugin session…"}
          </p>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3"
        >
          <p className="min-w-0 flex-1 text-xs leading-5">{error}</p>
          <Button
            size="xs"
            variant="outline"
            disabled={isLoading}
            onClick={() => void refresh({ forceRefresh: true })}
          >
            Retry
          </Button>
        </div>
      ) : null}

      <SettingsSection
        title="Connected plugins"
        headerAction={
          <Button size="xs" variant="outline" render={<Link to="/plugins" />}>
            Browse plugins
            <ArrowUpRightIcon className="size-3.5" />
          </Button>
        }
      >
        {isLoading && installed.length === 0 ? (
          <div
            role="status"
            className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-muted-foreground"
          >
            <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
            Loading connected plugins…
          </div>
        ) : installed.length === 0 && !error ? (
          <div className="flex flex-col items-center px-5 py-9 text-center">
            <div className="mb-3 grid size-10 place-items-center rounded-xl border border-border bg-muted/40">
              <PlugIcon className="size-5 text-muted-foreground" aria-hidden />
            </div>
            <p className="text-sm font-medium text-foreground">Your tools, connected</p>
            <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
              Connect a plugin to bring its capabilities into Axle. Your connected services will
              appear here.
            </p>
          </div>
        ) : (
          installed.map(({ plugin, status }, index) => {
            const summary = metadataSummary(status);
            const busy = busyPluginId === plugin.id;
            return (
              <div
                key={plugin.id}
                className={
                  index === 0
                    ? "flex flex-wrap items-center gap-3 px-4 py-4 sm:px-5"
                    : "flex flex-wrap items-center gap-3 border-t border-border/70 px-4 py-4 sm:px-5"
                }
              >
                <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-border/70 bg-background/65">
                  <PluginLogo pluginId={plugin.id} className="size-5 grayscale" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground">{plugin.name}</p>
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
                      <CheckIcon className="size-3" aria-hidden />
                      Connected
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {summary ?? plugin.description}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busyPluginId !== null}
                  className="shrink-0"
                  aria-label={`Disconnect ${plugin.name}`}
                  onClick={() => void remove(plugin.id)}
                >
                  {busy ? (
                    <LoaderCircleIcon className="size-3.5 animate-spin" />
                  ) : (
                    <UnplugIcon className="size-3.5" />
                  )}
                  {busy ? "Disconnecting…" : "Disconnect"}
                </Button>
              </div>
            );
          })
        )}
      </SettingsSection>

      <SettingsSection
        title="Available plugins"
        headerAction={
          <span className="text-xs tabular-nums text-muted-foreground">{available.length}</span>
        }
      >
        {available.length === 0 ? (
          <p className="px-4 py-6 text-xs text-muted-foreground sm:px-5">
            All available plugins are connected.
          </p>
        ) : (
          available.map((plugin, index) => {
            const inactive = plugin.inactive === true;
            const locked = !inactive && pluginLocked(plugin.id);
            const busy = busyPluginId === plugin.id;
            return (
              <div
                key={plugin.id}
                className={
                  index === 0
                    ? "flex flex-wrap items-center gap-3 px-4 py-4 sm:px-5"
                    : "flex flex-wrap items-center gap-3 border-t border-border/70 px-4 py-4 sm:px-5"
                }
              >
                <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-border/70 bg-background/65">
                  <PluginLogo pluginId={plugin.id} className="size-5 grayscale" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground">{plugin.name}</p>
                    {inactive ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        <ClockIcon className="size-3" aria-hidden />
                        Coming soon
                      </span>
                    ) : locked ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        <LockIcon className="size-3" aria-hidden />
                        Paid plans
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {inactive
                      ? `${plugin.description} — coming soon.`
                      : locked
                        ? `${plugin.description} — included with paid plans.`
                        : plugin.description}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={inactive || busyPluginId !== null || (!locked && !hasPluginSession)}
                  className="shrink-0"
                  aria-label={`${inactive ? "Coming soon" : locked ? "Upgrade" : "Connect"} ${plugin.name}`}
                  onClick={() => {
                    if (inactive) return;
                    if (locked) {
                      openUpgradeDialog("plugins");
                    } else {
                      void connect(plugin.id);
                    }
                  }}
                >
                  {busy ? (
                    <LoaderCircleIcon className="size-3.5 animate-spin" />
                  ) : inactive ? (
                    <ClockIcon className="size-3.5" />
                  ) : locked ? (
                    <LockIcon className="size-3.5" />
                  ) : (
                    <PlugIcon className="size-3.5" />
                  )}
                  {busy ? "Connecting…" : inactive ? "Coming soon" : locked ? "Upgrade" : "Connect"}
                </Button>
              </div>
            );
          })
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
