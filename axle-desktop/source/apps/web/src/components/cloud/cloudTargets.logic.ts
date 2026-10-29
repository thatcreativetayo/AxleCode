import type { CloudEnvironmentSummary } from "@axle/contracts";

export interface CloudRepositorySummary {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly isPrivate: boolean | null;
}

export const PINNED_SOURCE_REF = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
export const SOURCE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

export function humanizeIdentifier(value: string): string {
  const words = value.replace(/[_-]+/gu, " ").trim();
  if (words.length === 0) return value;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `https://github.com/owner/repo(.git)` → `owner/repo`; null for other hosts. */
export function repositoryFullNameFromUrl(repositoryUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(repositoryUrl.trim());
  } catch {
    return null;
  }
  if (url.hostname !== "github.com") return null;
  const [owner, project] = url.pathname
    .replace(/^\/+/u, "")
    .split("/")
    .map((part) => part.replace(/\.git$/u, ""));
  if (!owner || !project || project.length === 0) return null;
  return `${owner}/${project}`;
}

export function repositoryUrlForFullName(nameWithOwner: string): string {
  return `https://github.com/${nameWithOwner}`;
}

export function filterRepositoriesByHosts(
  repositories: ReadonlyArray<CloudRepositorySummary>,
  hosts: ReadonlyArray<string>,
): ReadonlyArray<CloudRepositorySummary> {
  if (hosts.length === 0) return repositories;
  return repositories.filter((repository) => {
    try {
      return hosts.includes(new URL(repository.url).hostname);
    } catch {
      return false;
    }
  });
}

export function providersForEnvironment(
  environment: CloudEnvironmentSummary | null,
): ReadonlyArray<string> {
  if (environment === null) return [];
  const providers: string[] = [];
  for (const item of environment.providerModels) {
    if (!providers.includes(item.providerInstanceId)) providers.push(item.providerInstanceId);
  }
  return providers;
}

export function modelsForProvider(
  environment: CloudEnvironmentSummary | null,
  providerInstanceId: string,
): ReadonlyArray<string> {
  if (environment === null) return [];
  return environment.providerModels
    .filter((item) => item.providerInstanceId === providerInstanceId)
    .map((item) => item.model);
}

/**
 * Environments whose provider instance already speaks the Axle gateway expose
 * the whole live Axle catalog, not just the one model in operator config.
 */
export function mergeAxleCatalogModels(
  environments: ReadonlyArray<CloudEnvironmentSummary>,
  models: ReadonlyArray<{ readonly id: string }>,
): ReadonlyArray<CloudEnvironmentSummary> {
  if (models.length === 0) return environments;
  const axleModels = models.map((model) => `axle/${model.id}`);
  return environments.map((environment) => {
    const axleProviders = new Set(
      environment.providerModels
        .filter((item) => item.model.startsWith("axle/"))
        .map((item) => item.providerInstanceId),
    );
    if (axleProviders.size === 0) return environment;
    const known = new Set(
      environment.providerModels.map((item) => `${item.providerInstanceId}\0${item.model}`),
    );
    const additions: Array<{ providerInstanceId: string; model: string }> = [];
    for (const providerInstanceId of axleProviders) {
      for (const model of axleModels) {
        const key = `${providerInstanceId}\0${model}`;
        if (known.has(key)) continue;
        known.add(key);
        additions.push({ providerInstanceId, model });
      }
    }
    return additions.length === 0
      ? environment
      : { ...environment, providerModels: [...environment.providerModels, ...additions] };
  });
}

export function defaultProviderModel(environment: CloudEnvironmentSummary | null): {
  readonly providerInstanceId: string;
  readonly model: string;
} {
  const providerInstanceId = providersForEnvironment(environment)[0] ?? "";
  const model = modelsForProvider(environment, providerInstanceId)[0] ?? "";
  return { providerInstanceId, model };
}

/** Keeps the current pair when valid, otherwise falls back to the first allowed pair. */
export function ensureProviderModel(
  environment: CloudEnvironmentSummary | null,
  providerInstanceId: string,
  model: string,
): { readonly providerInstanceId: string; readonly model: string } {
  const providers = providersForEnvironment(environment);
  if (providers.length === 0) return { providerInstanceId, model };
  const nextProvider = providers.includes(providerInstanceId) ? providerInstanceId : providers[0]!;
  const models = modelsForProvider(environment, nextProvider);
  const nextModel = models.includes(model) ? model : (models[0] ?? "");
  return { providerInstanceId: nextProvider, model: nextModel };
}

export function isPinnedSourceRef(value: string): boolean {
  return PINNED_SOURCE_REF.test(value.trim());
}

export function isValidSourceRef(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 200 && SOURCE_REF_PATTERN.test(trimmed);
}

/** Branch tracking is only available for GitHub repositories today. */
export function hostsAllowBranchTracking(hosts: ReadonlyArray<string>): boolean {
  return hosts.includes("github.com");
}
