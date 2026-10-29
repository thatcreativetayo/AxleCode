import {
  CheckIcon,
  LoaderCircleIcon,
  LockIcon,
  LogInIcon,
  PlugIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAccountActions, useAccountState } from "../../account/AccountAuthProvider";
import { openUpgradeDialog } from "../billing/UpgradeDialog";
import { pluginLockedForPlan } from "../../entitlements/gates";
import { useEntitlements, resolvedEntitlements } from "../../entitlements/useEntitlements";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { PluginLogo } from "./PluginLogo";
import {
  connectPlugin,
  disconnectPlugin,
  listPluginStatus,
  loadPluginSessionToken,
  type PluginStatus,
} from "./pluginApi";
import { PLUGINS, matchesPlugin, type PluginDefinition, type PluginId } from "./pluginCatalog";

type GitHubDisconnectBridge = {
  readonly disconnectGitHub?: () => Promise<unknown>;
};

function PluginRow({
  plugin,
  connected,
  busy,
  disabled,
  inactive,
  locked,
  onConnect,
  onDisconnect,
  onUpgrade,
}: {
  readonly plugin: PluginDefinition;
  readonly connected: boolean;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly inactive: boolean;
  readonly locked: boolean;
  readonly onConnect: (pluginId: PluginId) => void;
  readonly onDisconnect: (pluginId: PluginId) => void;
  readonly onUpgrade: (pluginId: PluginId) => void;
}) {
  const actionLabel = busy
    ? "Working…"
    : inactive
      ? "Coming soon"
      : connected
        ? "Disconnect"
        : locked
          ? "Upgrade"
          : "Connect";
  return (
    <li className="flex items-center gap-3 py-4 sm:gap-4">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/30">
        <PluginLogo pluginId={plugin.id} className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="text-sm font-medium text-foreground">{plugin.name}</h3>
          {connected ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <CheckIcon className="size-3" aria-hidden="true" /> Connected
            </span>
          ) : null}
          {inactive ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              Coming soon
            </span>
          ) : locked ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              <LockIcon className="size-3" aria-hidden="true" /> Paid plans
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
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
        disabled={disabled || inactive}
        aria-label={`${actionLabel} ${plugin.name}`}
        aria-busy={busy}
        onClick={() => {
          if (inactive) return;
          if (connected) {
            onDisconnect(plugin.id);
          } else if (locked) {
            onUpgrade(plugin.id);
          } else {
            onConnect(plugin.id);
          }
        }}
        className="min-w-22 shrink-0 text-xs"
      >
        {busy ? <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" /> : null}
        {busy ? "Working…" : actionLabel}
      </Button>
    </li>
  );
}

export function PluginsPage() {
  const account = useAccountState();
  const { signIn } = useAccountActions();
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
  const [query, setQuery] = useState("");
  const [statuses, setStatuses] = useState<PluginStatus[]>([]);
  const [busyPluginId, setBusyPluginId] = useState<PluginId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (options: { readonly forceRefresh?: boolean } = {}) => {
    const sessionToken = loadPluginSessionToken();
    if (!sessionToken) {
      setStatuses([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setStatuses(await listPluginStatus(sessionToken, options));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Plugins could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [hasPluginSession, refresh]);

  const connectedIds = useMemo(
    () => new Set(statuses.filter((entry) => entry.connected).map((entry) => entry.pluginId)),
    [statuses],
  );
  const visiblePlugins = useMemo(
    () => PLUGINS.filter((plugin) => matchesPlugin(plugin, query)),
    [query],
  );
  const installed = visiblePlugins.filter((plugin) => connectedIds.has(plugin.id));
  const explore = visiblePlugins.filter((plugin) => !connectedIds.has(plugin.id));

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

  const disconnect = useCallback(
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
        setError(cause instanceof Error ? cause.message : "Plugin could not be disconnected.");
      } finally {
        setBusyPluginId(null);
      }
    },
    [busyPluginId, refresh],
  );

  return (
    <main
      className="h-full min-h-0 min-w-0 flex-1 overflow-y-auto bg-background text-foreground"
      aria-labelledby="plugins-title"
    >
      <div className="mx-auto w-full max-w-4xl px-5 pb-12 pt-16 sm:px-8">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 id="plugins-title" className="text-2xl font-semibold tracking-tight">
              Plugins
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Connect the tools your work depends on.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {account.status === "signed-out" ? (
              <Button size="sm" onClick={() => signIn()}>
                <LogInIcon className="size-4" />
                Sign in
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh plugin connections"
              disabled={!hasPluginSession || loading || busyPluginId !== null}
              onClick={() => void refresh({ forceRefresh: true })}
            >
              <RefreshCwIcon className={loading ? "size-4 animate-spin" : "size-4"} />
            </Button>
          </div>
        </header>

        <div className="relative mt-6">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search plugins"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search plugins"
            type="search"
            className="h-9 rounded-lg border-border bg-background pl-9 pr-9 text-sm shadow-none"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear plugin search"
              onClick={() => setQuery("")}
              className="absolute right-1 top-1 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </div>

        {!hasPluginSession ? (
          <div
            role="status"
            className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-3"
          >
            <PlugIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <p className="text-xs text-muted-foreground">
              {pluginError ?? "Preparing your plugin session…"}
            </p>
          </div>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="mt-4 flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-3 py-3"
          >
            <p className="min-w-0 flex-1 text-xs leading-5 text-foreground">{error}</p>
            <Button
              size="xs"
              variant="ghost"
              disabled={loading || busyPluginId !== null}
              onClick={() => void refresh({ forceRefresh: true })}
            >
              Retry
            </Button>
          </div>
        ) : null}

        {loading && statuses.length === 0 ? (
          <div role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" /> Checking
            connections…
          </div>
        ) : null}

        {installed.length > 0 ? (
          <section className="mt-8" aria-labelledby="connected-plugins-title">
            <div className="flex items-center gap-2 border-b border-border pb-3">
              <h2
                id="connected-plugins-title"
                className="text-xs font-medium text-muted-foreground"
              >
                Connected
              </h2>
              <span className="text-xs tabular-nums text-muted-foreground">{installed.length}</span>
            </div>
            <ul className="divide-y divide-border/70">
              {installed.map((plugin) => (
                <PluginRow
                  key={plugin.id}
                  plugin={plugin}
                  connected
                  busy={busyPluginId === plugin.id}
                  disabled={busyPluginId !== null || loading || !hasPluginSession}
                  inactive={false}
                  locked={false}
                  onConnect={connect}
                  onDisconnect={disconnect}
                  onUpgrade={() => openUpgradeDialog("plugins")}
                />
              ))}
            </ul>
          </section>
        ) : null}

        {explore.length > 0 ? (
          <section className="mt-8" aria-labelledby="available-plugins-title">
            <div className="flex items-center gap-2 border-b border-border pb-3">
              <h2
                id="available-plugins-title"
                className="text-xs font-medium text-muted-foreground"
              >
                Available plugins
              </h2>
              <span className="text-xs tabular-nums text-muted-foreground">{explore.length}</span>
            </div>
            <ul className="divide-y divide-border/70">
              {explore.map((plugin) => (
                <PluginRow
                  key={plugin.id}
                  plugin={plugin}
                  connected={false}
                  busy={busyPluginId === plugin.id}
                  disabled={busyPluginId !== null || loading || !hasPluginSession}
                  inactive={plugin.inactive === true}
                  locked={!plugin.inactive && pluginLocked(plugin.id)}
                  onConnect={connect}
                  onDisconnect={disconnect}
                  onUpgrade={() => openUpgradeDialog("plugins")}
                />
              ))}
            </ul>
          </section>
        ) : null}

        {visiblePlugins.length === 0 ? (
          <div role="status" className="py-12 text-center">
            <p className="text-sm font-medium">No matching plugins</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Try a tool name or a capability, like email or issues.
            </p>
            <Button variant="ghost" size="sm" className="mt-3" onClick={() => setQuery("")}>
              Clear search
            </Button>
          </div>
        ) : null}
      </div>
    </main>
  );
}
