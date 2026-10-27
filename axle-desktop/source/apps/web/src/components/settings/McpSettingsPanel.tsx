import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react";
import type { McpServerConnectionStatus } from "@axle/contracts";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { usePrimaryEnvironment } from "../../state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { McpIcon } from "./McpIcon";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const EMPTY_DRAFT = {
  name: "",
  endpoint: "",
  authorizationToken: "",
};

export function McpSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const connections = settings.mcpServers;
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverStatuses, setServerStatuses] = useState<
    ReadonlyMap<string, McpServerConnectionStatus>
  >(() => new Map());
  const [checkingStatus, setCheckingStatus] = useState(false);
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const checkMcpServers = useAtomCommand(serverEnvironment.checkMcpServers, {
    reportFailure: false,
  });

  const save = (next: typeof connections) => updateSettings({ mcpServers: next });
  const refreshServerStatuses = useCallback(async () => {
    if (!environmentId) return;
    setCheckingStatus(true);
    try {
      const result = await checkMcpServers({ environmentId, input: {} });
      if (result._tag === "Success") {
        setServerStatuses(new Map(result.value.map((status) => [status.id, status])));
      }
    } finally {
      setCheckingStatus(false);
    }
  }, [checkMcpServers, environmentId]);

  useEffect(() => {
    if (!environmentId || connections.length === 0) return;
    void refreshServerStatuses();
    const interval = setInterval(() => void refreshServerStatuses(), 60_000);
    return () => clearInterval(interval);
  }, [connections, environmentId, refreshServerStatuses]);

  const resetDraft = useCallback(() => {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
    setError(null);
  }, []);

  const beginEdit = useCallback((connection: (typeof connections)[number]) => {
    setDraft({
      name: connection.name,
      endpoint: connection.url,
      authorizationToken: "",
    });
    setEditingId(connection.id);
    setError(null);
    requestAnimationFrame(() => {
      document.getElementById("mcp-server-form")?.scrollIntoView({ block: "nearest" });
    });
  }, []);

  const submitConnection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedName = draft.name.trim();
    const normalizedEndpoint = draft.endpoint.trim();
    try {
      const parsedEndpoint = new URL(normalizedEndpoint);
      if (parsedEndpoint.protocol !== "https:" && parsedEndpoint.protocol !== "http:") {
        throw new Error("Use an HTTP or HTTPS endpoint.");
      }
      if (!normalizedName) throw new Error("Enter a name for this MCP server.");
      if (
        connections.some(
          (server) =>
            server.id !== editingId && server.name.toLowerCase() === normalizedName.toLowerCase(),
        )
      ) {
        throw new Error("Choose a unique server name.");
      }

      const token = draft.authorizationToken.trim();
      if (editingId) {
        save(
          connections.map((server) => {
            if (server.id !== editingId) return server;
            return {
              ...server,
              name: normalizedName,
              url: parsedEndpoint.href,
              ...(token ? { authorizationToken: token, authorizationTokenRedacted: false } : {}),
            };
          }),
        );
      } else {
        save([
          ...connections,
          {
            id: randomUUID(),
            name: normalizedName,
            url: parsedEndpoint.href,
            authorizationToken: token,
            authorizationTokenRedacted: false,
            enabled: true,
          },
        ]);
      }
      resetDraft();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enter a valid MCP endpoint.");
    }
  };

  const editingConnection = editingId
    ? connections.find((connection) => connection.id === editingId)
    : undefined;

  return (
    <SettingsPageContainer
      title="MCP"
      description="Add streamable HTTP MCP servers here. Connections are saved in server settings and restored after restart. Their status is checked when this page opens and periodically; unreachable servers are marked Offline."
    >
      <div className="-mt-5 flex items-center gap-2">
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          Beta
        </span>
      </div>

      <SettingsSection title="Built-in MCPs" icon={<McpIcon className="size-3.5" />}>
        <SettingsRow
          title="Browser"
          description="Use the shared browser to navigate, inspect pages, and interact with websites."
          status="Available in this session"
        />
        <SettingsRow
          title="Pull request review"
          description="Review a GitHub pull request and post actionable inline feedback."
          status="Available when GitHub is connected"
        />
      </SettingsSection>

      <SettingsSection
        title="Your MCP servers"
        icon={<McpIcon className="size-3.5" />}
        headerAction={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh MCP server statuses"
            onClick={() => void refreshServerStatuses()}
            disabled={checkingStatus || connections.length === 0}
          >
            <RefreshCwIcon className={checkingStatus ? "size-3 animate-spin" : "size-3"} />
          </Button>
        }
      >
        {connections.length === 0 ? (
          <div className="px-4 py-5 text-sm text-muted-foreground sm:px-5">
            No MCP servers added yet.
          </div>
        ) : (
          connections.map((connection) => {
            const status = serverStatuses.get(connection.id);
            return (
              <div
                key={connection.id}
                className="flex min-w-0 items-center gap-3 border-t border-border/60 px-4 py-3.5 sm:px-5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-foreground">
                    {connection.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{connection.url}</p>
                </div>
                <span
                  role="status"
                  title={
                    status
                      ? `Last checked ${new Date(status.checkedAt).toLocaleTimeString()}`
                      : undefined
                  }
                  className={
                    !connection.enabled
                      ? "inline-flex shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                      : status?.status === "online"
                        ? "inline-flex shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
                        : status?.status === "offline"
                          ? "inline-flex shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive"
                          : "inline-flex shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                  }
                >
                  {!connection.enabled
                    ? "Disabled"
                    : status?.status === "online"
                      ? `Online · ${status.toolCount} tools`
                      : status?.status === "offline"
                        ? "Offline"
                        : "Checking…"}
                </span>
                <Switch
                  checked={connection.enabled}
                  onCheckedChange={(enabled) =>
                    save(
                      connections.map((server) =>
                        server.id === connection.id
                          ? { ...server, enabled: Boolean(enabled) }
                          : server,
                      ),
                    )
                  }
                  aria-label={`${connection.enabled ? "Disable" : "Enable"} ${connection.name}`}
                />
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Edit ${connection.name}`}
                  onClick={() => beginEdit(connection)}
                >
                  <PencilIcon className="size-4" />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${connection.name}`}
                  onClick={() => save(connections.filter((item) => item.id !== connection.id))}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
            );
          })
        )}
        <form
          id="mcp-server-form"
          onSubmit={submitConnection}
          className="grid gap-3 border-t border-border/60 p-4 sm:p-5"
        >
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold text-foreground">
              {editingId ? `Edit ${editingConnection?.name ?? "server"}` : "Add a server"}
            </p>
            {editingId ? (
              <Button type="button" size="sm" variant="ghost" onClick={resetDraft}>
                <XIcon className="size-3.5" /> Cancel
              </Button>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-xs font-medium text-foreground">
              Server name
              <Input
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.currentTarget.value }))
                }
                placeholder="My MCP server"
              />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-foreground">
              Server URL
              <Input
                type="url"
                value={draft.endpoint}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, endpoint: event.currentTarget.value }))
                }
                placeholder="https://example.com/mcp"
              />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-foreground sm:col-span-2">
              Bearer token <span className="font-normal text-muted-foreground">(optional)</span>
              <Input
                type="password"
                autoComplete="new-password"
                value={draft.authorizationToken}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    authorizationToken: event.currentTarget.value,
                  }))
                }
                placeholder={
                  editingConnection?.authorizationTokenRedacted
                    ? "A token is saved — leave blank to keep it"
                    : "Stored securely on the server"
                }
              />
            </label>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm">
              {editingId ? (
                "Save changes"
              ) : (
                <>
                  <PlusIcon className="size-4" /> Add server
                </>
              )}
            </Button>
          </div>
        </form>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
