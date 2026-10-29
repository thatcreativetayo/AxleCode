import { CloudJobsApiError, type CloudJobsClient } from "@axle/client-runtime/cloud/jobs";
import type { CloudEnvironmentSummary } from "@axle/contracts";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { fetchAxleModelRates } from "../../account/axleGateway";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import {
  defaultProviderModel,
  filterRepositoriesByHosts,
  humanizeIdentifier,
  isPinnedSourceRef,
  mergeAxleCatalogModels,
  modelsForProvider,
  providersForEnvironment,
  repositoryFullNameFromUrl,
  type CloudRepositorySummary,
} from "./cloudTargets.logic";

export interface CloudEnvironmentCatalogState {
  readonly environments: ReadonlyArray<CloudEnvironmentSummary>;
  readonly busy: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

interface GitHubBranchOption {
  readonly name: string;
  readonly sha: string;
  readonly isDefault: boolean;
}

interface GitHubBranchListResult {
  readonly repository: string;
  readonly defaultBranch: string | null;
  readonly branches: ReadonlyArray<GitHubBranchOption>;
  readonly error: string | null;
}

interface CloudGitHubBridge {
  readonly listGitHubRepositories: (input: {
    readonly cwds: string[];
  }) => Promise<{ readonly repositories: CloudRepositorySummary[]; readonly error: string | null }>;
  readonly listGitHubBranches?: (input: {
    readonly repository: string;
  }) => Promise<GitHubBranchListResult>;
}

function getCloudGitHubBridge(): CloudGitHubBridge | null {
  const bridge = window.desktopBridge as unknown as Partial<CloudGitHubBridge> | undefined;
  if (!bridge || typeof bridge.listGitHubRepositories !== "function") return null;
  return bridge as CloudGitHubBridge;
}

function describeCatalogError(error: unknown): string {
  if (error instanceof CloudJobsApiError) {
    if (error.status === 401) return "Sign in to load cloud environments.";
    if (error.status === 0) return "Could not reach the account service to load environments.";
    return `Could not load cloud environments (${error.code}).`;
  }
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Could not load cloud environments.";
}

export function useCloudEnvironmentCatalog(
  client: CloudJobsClient | null,
): CloudEnvironmentCatalogState {
  const [environments, setEnvironments] = useState<ReadonlyArray<CloudEnvironmentSummary>>([]);
  const [busy, setBusy] = useState(client !== null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    setBusy(true);
    void Promise.all([client.listEnvironments(), fetchAxleModelRates().catch(() => [])])
      .then(([next, axleModels]) => {
        if (cancelled) return;
        setEnvironments(mergeAxleCatalogModels(next, axleModels));
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(describeCatalogError(cause));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, reloadToken]);

  const refresh = useCallback(() => setReloadToken((current) => current + 1), []);
  return { environments, busy, error, refresh };
}

export interface CloudRepositoryState {
  readonly bridgeAvailable: boolean;
  readonly repositories: ReadonlyArray<CloudRepositorySummary>;
  readonly busy: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

export function useGitHubRepositories(enabled: boolean): CloudRepositoryState {
  const bridge = useMemo(getCloudGitHubBridge, []);
  const [repositories, setRepositories] = useState<ReadonlyArray<CloudRepositorySummary>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!enabled || bridge === null) return;
    let cancelled = false;
    setBusy(true);
    void bridge
      .listGitHubRepositories({ cwds: [] })
      .then((result) => {
        if (cancelled) return;
        setRepositories(result.repositories);
        setError(result.error);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, enabled, reloadToken]);

  const refresh = useCallback(() => setReloadToken((current) => current + 1), []);
  return { bridgeAvailable: bridge !== null, repositories, busy, error, refresh };
}

export interface CloudBranchState {
  readonly supported: boolean;
  readonly branches: ReadonlyArray<GitHubBranchOption>;
  readonly defaultBranch: string | null;
  readonly busy: boolean;
  readonly error: string | null;
}

export function useGitHubBranches(repositoryUrl: string, enabled: boolean): CloudBranchState {
  const bridge = useMemo(getCloudGitHubBridge, []);
  const fullName = repositoryFullNameFromUrl(repositoryUrl);
  const listBranches = bridge?.listGitHubBranches;
  const supported = listBranches !== undefined && fullName !== null;
  const [branches, setBranches] = useState<ReadonlyArray<GitHubBranchOption>>([]);
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBranches([]);
    setDefaultBranch(null);
    setError(null);
    if (!enabled || !supported || fullName === null || listBranches === undefined) {
      setBusy(false);
      return;
    }
    let cancelled = false;
    setBusy(true);
    void listBranches({ repository: fullName })
      .then((result) => {
        if (cancelled) return;
        setBranches(result.branches);
        setDefaultBranch(result.defaultBranch);
        setError(result.error);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, fullName, listBranches, supported]);

  return { supported, branches, defaultBranch, busy, error };
}

function HelperText({ children }: { readonly children: ReactNode }) {
  return <p className="text-[11px] leading-4 text-muted-foreground">{children}</p>;
}

function TextToggle({
  children,
  onClick,
  disabled,
}: {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly disabled: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="text-[11px] text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function CloudTargetFields({
  environments,
  environmentsBusy,
  environmentsError,
  environmentId,
  providerInstanceId,
  model,
  disabled,
  idPrefix,
  onChange,
}: {
  readonly environments: ReadonlyArray<CloudEnvironmentSummary>;
  readonly environmentsBusy: boolean;
  readonly environmentsError: string | null;
  readonly environmentId: string;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly disabled: boolean;
  readonly idPrefix: string;
  readonly onChange: (patch: {
    readonly environmentId?: string;
    readonly providerInstanceId?: string;
    readonly model?: string;
  }) => void;
}) {
  const environment = environments.find((item) => item.environmentId === environmentId) ?? null;
  const providers = providersForEnvironment(environment);
  const models = modelsForProvider(environment, providerInstanceId);
  const fallback = environmentsError !== null || (!environmentsBusy && environments.length === 0);

  if (fallback) {
    return (
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-environment`}>Environment</Label>
          <Input
            id={`${idPrefix}-environment`}
            value={environmentId}
            disabled={disabled}
            placeholder="linux-standard"
            onChange={(event) => onChange({ environmentId: event.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-provider`}>Provider</Label>
            <Input
              id={`${idPrefix}-provider`}
              value={providerInstanceId}
              disabled={disabled}
              placeholder="anthropic-default"
              onChange={(event) => onChange({ providerInstanceId: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-model`}>Model</Label>
            <Input
              id={`${idPrefix}-model`}
              value={model}
              disabled={disabled}
              placeholder="claude-sonnet-4-5"
              onChange={(event) => onChange({ model: event.target.value })}
            />
          </div>
        </div>
        <HelperText>
          {environmentsError ?? "No cloud environments are available."} Enter the operator-provided
          IDs manually.
        </HelperText>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-environment`}>Environment</Label>
        <Select
          value={environmentId}
          disabled={disabled || environmentsBusy}
          onValueChange={(value) => {
            if (value === null) return;
            const next = environments.find((item) => item.environmentId === value) ?? null;
            const nextTargets = defaultProviderModel(next);
            onChange({ environmentId: value, ...nextTargets });
          }}
        >
          <SelectTrigger id={`${idPrefix}-environment`} className="w-full">
            <SelectValue placeholder="Choose an environment" />
          </SelectTrigger>
          <SelectContent>
            {environments.map((item) => (
              <SelectItem key={item.environmentId} value={item.environmentId}>
                {humanizeIdentifier(item.environmentId)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <HelperText>
          The cloud runner that hosts this job. Environments and their models are set up by Axle.
        </HelperText>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-provider`}>Provider</Label>
          <Select
            value={providerInstanceId}
            disabled={disabled || environmentsBusy || providers.length === 0}
            onValueChange={(value) => {
              if (value === null) return;
              const firstModel = modelsForProvider(environment, value)[0] ?? model;
              onChange({ providerInstanceId: value, model: firstModel });
            }}
          >
            <SelectTrigger id={`${idPrefix}-provider`} className="w-full">
              <SelectValue placeholder="Choose a provider" />
            </SelectTrigger>
            <SelectContent>
              {providers.map((provider) => (
                <SelectItem key={provider} value={provider}>
                  {humanizeIdentifier(provider)}
                </SelectItem>
              ))}
              {!providers.includes(providerInstanceId) && providerInstanceId.length > 0 ? (
                <SelectItem value={providerInstanceId}>
                  {humanizeIdentifier(providerInstanceId)}
                </SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-model`}>Model</Label>
          <Select
            value={model}
            disabled={disabled || environmentsBusy || models.length === 0}
            onValueChange={(value) => {
              if (value !== null) onChange({ model: value });
            }}
          >
            <SelectTrigger id={`${idPrefix}-model`} className="w-full">
              <SelectValue placeholder="Choose a model" />
            </SelectTrigger>
            <SelectContent>
              {models.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {candidate}
                </SelectItem>
              ))}
              {!models.includes(model) && model.length > 0 ? (
                <SelectItem value={model}>{model}</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </div>
      </div>
      <HelperText>
        Provider is the configured cloud account; the model list only shows models allowed for the
        selected environment.
      </HelperText>
    </div>
  );
}

export function CloudRepositoryField({
  repositoryUrl,
  hosts,
  repositories,
  bridgeAvailable,
  busy,
  error,
  disabled,
  onRefresh,
  onChange,
}: {
  readonly repositoryUrl: string;
  readonly hosts: ReadonlyArray<string>;
  readonly repositories: ReadonlyArray<CloudRepositorySummary>;
  readonly bridgeAvailable: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly disabled: boolean;
  readonly onRefresh: () => void;
  readonly onChange: (repositoryUrl: string) => void;
}) {
  const [manual, setManual] = useState(!bridgeAvailable);
  const filtered = filterRepositoriesByHosts(repositories, hosts);
  const currentFullName = repositoryFullNameFromUrl(repositoryUrl);
  const currentRepository =
    currentFullName === null
      ? null
      : (filtered.find((repository) => repository.nameWithOwner === currentFullName) ?? null);

  const renderInput = (placeholder: string) => (
    <Input
      id="cloud-repository"
      value={repositoryUrl}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="cloud-repository">Repository</Label>
        {bridgeAvailable && filtered.length > 0 ? (
          <TextToggle disabled={disabled} onClick={() => setManual((current) => !current)}>
            {manual ? "Choose from GitHub" : "Enter URL manually"}
          </TextToggle>
        ) : null}
      </div>
      {!bridgeAvailable ? (
        <>
          {renderInput("https://github.com/you/repo.git")}
          <HelperText>
            Connect GitHub in the desktop app to pick from a repository list. You can still paste an
            HTTPS clone URL.
          </HelperText>
        </>
      ) : manual ? (
        <>
          {renderInput("https://github.com/you/repo.git")}
          <HelperText>
            Paste an HTTPS clone URL, for example https://github.com/you/repo.git.
          </HelperText>
        </>
      ) : busy && repositories.length === 0 ? (
        <>
          <Select value="" disabled>
            <SelectTrigger id="cloud-repository" className="w-full">
              <SelectValue placeholder="Loading repositories…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__loading">Loading repositories…</SelectItem>
            </SelectContent>
          </Select>
          <HelperText>Loading repositories from your GitHub account.</HelperText>
        </>
      ) : filtered.length === 0 ? (
        <>
          {renderInput("https://github.com/you/repo.git")}
          <HelperText>
            No repositories match this environment. Enter an HTTPS clone URL manually.
          </HelperText>
        </>
      ) : (
        <>
          <Select
            value={currentRepository?.url ?? ""}
            disabled={disabled}
            onValueChange={(value) => {
              if (value !== null) onChange(value);
            }}
          >
            <SelectTrigger id="cloud-repository" className="w-full">
              <SelectValue placeholder="Choose a repository" />
            </SelectTrigger>
            <SelectContent>
              {filtered.map((repository) => (
                <SelectItem key={repository.nameWithOwner} value={repository.url}>
                  {repository.nameWithOwner}
                  {repository.isPrivate === true ? " (private)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <HelperText>
            Repositories from your connected GitHub account that this environment accepts.
          </HelperText>
        </>
      )}
      {error !== null ? (
        <p className="flex items-center gap-2 text-[11px] leading-4 text-muted-foreground">
          <span>{error}</span>
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={onRefresh}
          >
            Retry
          </button>
        </p>
      ) : null}
    </div>
  );
}

export function CloudSourceRefField({
  value,
  supported,
  branches,
  defaultBranch,
  busy,
  error,
  disabled,
  label,
  helper,
  onChange,
}: {
  readonly value: string;
  readonly supported: boolean;
  readonly branches: ReadonlyArray<GitHubBranchOption>;
  readonly defaultBranch: string | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly disabled: boolean;
  readonly label: string;
  readonly helper: ReactNode;
  readonly onChange: (value: string) => void;
}) {
  const [manual, setManual] = useState(!supported);

  useEffect(() => {
    setManual(!supported);
  }, [supported]);

  useEffect(() => {
    if (!supported || manual || value.trim().length > 0) return;
    const next = defaultBranch ?? branches[0]?.name ?? null;
    if (next !== null && next.length > 0) onChange(next);
  }, [branches, defaultBranch, manual, onChange, supported, value]);

  const known = branches.some((branch) => branch.name === value);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="cloud-source-ref">{label}</Label>
        {supported ? (
          <TextToggle disabled={disabled} onClick={() => setManual((current) => !current)}>
            {manual ? "Choose a branch" : "Enter a commit SHA"}
          </TextToggle>
        ) : null}
      </div>
      {!supported ? (
        <Input
          id="cloud-source-ref"
          value={value}
          disabled={disabled}
          placeholder="main or a full commit SHA"
          className="font-mono text-xs"
          onChange={(event) => onChange(event.target.value)}
        />
      ) : manual ? (
        <Input
          id="cloud-source-ref"
          value={value}
          disabled={disabled}
          placeholder="main or a full commit SHA"
          className="font-mono text-xs"
          onChange={(event) => onChange(event.target.value)}
        />
      ) : !busy && branches.length === 0 ? (
        <Input
          id="cloud-source-ref"
          value={value}
          disabled={disabled}
          placeholder="main or a full commit SHA"
          className="font-mono text-xs"
          onChange={(event) => onChange(event.target.value)}
        />
      ) : busy && branches.length === 0 ? (
        <Select value="" disabled>
          <SelectTrigger id="cloud-source-ref" className="w-full">
            <SelectValue placeholder="Loading branches…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__loading">Loading branches…</SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <Select
          value={value}
          disabled={disabled}
          onValueChange={(next) => {
            if (next !== null) onChange(next);
          }}
        >
          <SelectTrigger id="cloud-source-ref" className="w-full font-mono text-xs">
            <SelectValue placeholder="Choose a branch" />
          </SelectTrigger>
          <SelectContent>
            {branches.map((branch) => (
              <SelectItem key={branch.name} value={branch.name}>
                {branch.name}
                {branch.name === defaultBranch ? " (default)" : ""}
              </SelectItem>
            ))}
            {value.length > 0 && !known ? (
              <SelectItem value={value}>
                {isPinnedSourceRef(value) ? `Pinned commit ${value.slice(0, 12)}` : value}
              </SelectItem>
            ) : null}
          </SelectContent>
        </Select>
      )}
      <HelperText>{helper}</HelperText>
      {error !== null ? (
        <p className="text-[11px] leading-4 text-muted-foreground">{error}</p>
      ) : null}
    </div>
  );
}

export function InteractionModeField({
  value,
  disabled,
  onChange,
}: {
  readonly value: "default" | "plan";
  readonly disabled: boolean;
  readonly onChange: (value: "default" | "plan") => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="cloud-interaction-mode">Interaction mode</Label>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === "default" || next === "plan") onChange(next);
        }}
      >
        <SelectTrigger id="cloud-interaction-mode" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">Default</SelectItem>
          <SelectItem value="plan">Plan first</SelectItem>
        </SelectContent>
      </Select>
      <HelperText>
        Default starts working immediately. Plan first asks the agent to propose a plan and wait for
        your approval before it changes files.
      </HelperText>
    </div>
  );
}
