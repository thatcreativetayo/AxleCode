import type { LocalModelPackId, LocalModelSnapshot } from "@axle/contracts";

import { fetchPrimaryEnvironment } from "../environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";

const LOCAL_MODELS_ROUTE = "/api/axle/local-models";

async function localModelsRequest(
  path: string,
  init: RequestInit = {},
): Promise<LocalModelSnapshot> {
  const requestUrl = resolvePrimaryEnvironmentHttpUrl(`${LOCAL_MODELS_ROUTE}${path}`);
  let response: Response;
  try {
    response = await fetchPrimaryEnvironment(requestUrl, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Could not reach the local model service (${detail}).`, { cause });
  }
  const text = await response.text();
  let payload: unknown = null;
  if (text.trim().length > 0) {
    try {
      payload = JSON.parse(text);
    } catch (cause) {
      throw new Error(`The local model service returned invalid JSON (HTTP ${response.status}).`, {
        cause,
      });
    }
  }
  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `The local model service failed (HTTP ${response.status}).`;
    throw new Error(message);
  }
  return payload as LocalModelSnapshot;
}

export function fetchLocalModels(): Promise<LocalModelSnapshot> {
  return localModelsRequest("");
}

export function installLocalModel(packId: LocalModelPackId): Promise<LocalModelSnapshot> {
  return localModelsRequest("/install", {
    method: "POST",
    body: JSON.stringify({ packId }),
  });
}

export function removeLocalModel(packId: LocalModelPackId): Promise<LocalModelSnapshot> {
  return localModelsRequest("/remove", {
    method: "POST",
    body: JSON.stringify({ packId }),
  });
}

export function startLocalModel(packId: LocalModelPackId): Promise<LocalModelSnapshot> {
  return localModelsRequest("/start", {
    method: "POST",
    body: JSON.stringify({ packId }),
  });
}

export function stopLocalModel(): Promise<LocalModelSnapshot> {
  return localModelsRequest("/stop", { method: "POST", body: JSON.stringify({}) });
}
