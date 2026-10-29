import type { CloudConfig, CloudEnvironment } from "./cloudConfig.ts";
import { CloudJobError } from "./cloudErrors.ts";

/** Shared target checks for cloud jobs and cloud schedules. */
export function resolveCloudEnvironment(
  config: CloudConfig,
  environmentId: string,
): CloudEnvironment {
  const value = config.environments.find((item) => item.environmentId === environmentId);
  if (!value) throw new CloudJobError("environment_unavailable");
  return value;
}

export function validateCloudRepository(environment: CloudEnvironment, repositoryUrl: string): URL {
  let repository: URL;
  try {
    repository = new URL(repositoryUrl);
  } catch {
    throw new CloudJobError("invalid_repository");
  }
  if (
    repository.protocol !== "https:" ||
    repository.username ||
    repository.password ||
    repository.toString() !== repositoryUrl ||
    repository.port ||
    repository.search ||
    repository.hash ||
    !environment.repositoryHosts.includes(repository.hostname) ||
    !/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:\.git)?$/u.test(repository.pathname) ||
    repository.pathname.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new CloudJobError("invalid_repository");
  }
  return repository;
}

export function validateCloudModel(
  environment: CloudEnvironment,
  providerInstanceId: string,
  model: string,
): void {
  const configured = environment.providerModels.some(
    (item) => item.providerInstanceId === providerInstanceId,
  );
  if (!configured) throw new CloudJobError("model_unavailable");
  const exact = environment.providerModels.some(
    (item) => item.providerInstanceId === providerInstanceId && item.model === model,
  );
  if (exact) return;
  // Axle-gateway providers expose the live public catalog; the worker accepts
  // any model the gateway serves, so only an `axle/` slug is required here.
  const usesAxleCatalog = environment.providerModels.some(
    (item) => item.providerInstanceId === providerInstanceId && item.model.startsWith("axle/"),
  );
  if (usesAxleCatalog && /^axle\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(model)) return;
  throw new CloudJobError("model_unavailable");
}
