// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import {
  parseProviderHeaders,
  providerHeadersVariable,
  providerPresetHeaders,
  resolveProviderPreset,
  type ServerProviderModel,
} from "@axle/contracts";
import { createModelCapabilities } from "@axle/shared/model";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  isCodexOAuthModel,
  normalizeCodexOAuthEffectiveContextWindowTokens,
  readCodexOAuthContextWindow,
} from "../codexContextWindow.ts";
import { LOCAL_MODEL_PACKS } from "../../localModels/catalog.ts";
import { readInstalledPackIds } from "../../localModels/manager.ts";

type FetchImplementation = typeof globalThis.fetch;

type ProviderDefinition = {
  readonly env?:
    | "OPENAI_API_KEY"
    | "ANTHROPIC_API_KEY"
    | "GEMINI_API_KEY"
    | "FIREWORKS_API_KEY"
    | "OLLAMA_API_KEY"
    | "CEREBRAS_API_KEY"
    | "GROQ_API_KEY"
    | "OPENROUTER_API_KEY"
    | "MISTRAL_API_KEY"
    | "DEEPSEEK_API_KEY"
    | "XAI_API_KEY"
    | "AXLE_API_KEY"
    | "AXLE_LOCAL_API_KEY";
  readonly prefix:
    | "openai-codex"
    | "openai"
    | "anthropic"
    | "google"
    | "fireworks"
    | "ollama-cloud"
    | "cerebras"
    | "groq"
    | "openrouter"
    | "mistral"
    | "deepseek"
    | "xai"
    | "axle"
    | "axle-local";
  readonly label:
    | "OpenAI Codex"
    | "OpenAI"
    | "Claude"
    | "Google"
    | "Fireworks"
    | "Ollama Cloud"
    | "Cerebras"
    | "Groq"
    | "OpenRouter"
    | "Mistral"
    | "DeepSeek"
    | "xAI"
    | "Axle"
    | "Axle Offline";
  readonly load: (
    apiKey: string,
    fetchImplementation: FetchImplementation,
    environment: NodeJS.ProcessEnv,
    modelsDev?: ModelsDevCatalog,
  ) => Promise<ReadonlyArray<RemoteModel>>;
};

function codexAuthDirectory(environment: NodeJS.ProcessEnv): string | undefined {
  const environmentHome = environment.USERPROFILE?.trim() || environment.HOME?.trim();
  return (
    environment.AXLE_CODEX_HOME?.trim() ||
    (environmentHome ? NodePath.join(environmentHome, ".axle", "codex-auth") : undefined)
  );
}

function readCodexOAuthCredentials(environment: NodeJS.ProcessEnv):
  | {
      readonly accessToken: string;
      readonly expiresAt: number;
    }
  | undefined {
  const authDirectory = codexAuthDirectory(environment);
  if (!authDirectory) return undefined;
  try {
    const credentials: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(authDirectory, "auth.json"), "utf8"),
    );
    if (
      isRecord(credentials) &&
      credentials.auth_mode === "siwc" &&
      isRecord(credentials.tokens) &&
      nonEmptyString(credentials.tokens.access_token) &&
      nonEmptyString(credentials.tokens.refresh_token) &&
      nonEmptyString(credentials.tokens.scope) &&
      nonEmptyString(credentials.tokens.client_id) &&
      typeof credentials.tokens.expires === "number" &&
      Number.isSafeInteger(credentials.tokens.expires)
    ) {
      const scopes = new Set(nonEmptyString(credentials.tokens.scope)!.split(/\s+/u));
      if (
        !["offline_access", "resource.invoke", "chatgpt.tokens.use.direct"].every((scope) =>
          scopes.has(scope),
        )
      ) {
        return undefined;
      }
      return {
        accessToken: nonEmptyString(credentials.tokens.access_token)!,
        expiresAt: credentials.tokens.expires,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function hasCodexOAuthAuthentication(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(readCodexOAuthCredentials(environment));
}

type RemoteReasoningEffort = {
  readonly id: string;
  readonly label?: string;
  readonly description?: string;
};

type RemoteContextWindow = {
  readonly id: string;
  readonly tokens: number;
  readonly label?: string;
};

type ContextWindowSource = "provider" | "oauth" | "models.dev";

export type RemoteModel = {
  readonly id: string;
  readonly name?: string | undefined;
  readonly reasoningSupported?: boolean | undefined;
  readonly reasoningEfforts?: ReadonlyArray<RemoteReasoningEffort>;
  readonly defaultReasoningEffort?: string | undefined;
  readonly contextWindows?: ReadonlyArray<RemoteContextWindow>;
  readonly defaultContextWindowTokens?: number | undefined;
  readonly contextWindowSource?: ContextWindowSource | undefined;
};

export type AxleModelDiscovery = {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly configuredProviderCount: number;
  readonly errors: ReadonlyArray<string>;
};

type ModelsDevCatalog = Readonly<Record<string, Readonly<Record<string, Record<string, unknown>>>>>;

const REQUEST_TIMEOUT_MS = 12_000;
const CODEX_MODELS_ENDPOINT = "https://api.openai.com/v1/models";

const CHATGPT_CODEX_MODELS = [
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
  { id: "gpt-6-astra", name: "GPT-6 Astra" },
  { id: "gpt-6-sol", name: "GPT-6 Sol" },
  { id: "gpt-6-luna", name: "GPT-6 Luna" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
] as const satisfies ReadonlyArray<RemoteModel>;
const CHATGPT_CODEX_MODEL_ORDER: ReadonlyMap<string, number> = new Map(
  CHATGPT_CODEX_MODELS.map((model, index) => [`openai-codex/${model.id}`, index] as const),
);

async function refreshCodexOAuthSession(environment: NodeJS.ProcessEnv): Promise<void> {
  const binaryPath = environment.AXLE_BINARY_PATH?.trim() || "axle";
  await new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(binaryPath, ["--codex-auth-refresh"], {
      env: environment,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(stderr.trim() || `Axle auth refresh exited with code ${code ?? "unknown"}.`),
        );
      }
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function humanizeModelId(modelId: string): string {
  return modelId
    .replace(/^models\//u, "")
    .split(/[-_/]+/u)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "gpt") return "GPT";
      if (lower === "ai") return "AI";
      if (lower === "tts") return "TTS";
      if (/^o\d+$/u.test(lower)) return lower;
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function parseReasoningEfforts(value: unknown): ReadonlyArray<RemoteReasoningEffort> {
  if (Array.isArray(value)) {
    const typedEntries = value.filter(
      (entry) => !isRecord(entry) || entry.type === undefined || entry.type === "effort",
    );
    return parseReasoningEffortEntries(
      typedEntries.flatMap((entry) =>
        isRecord(entry) && Array.isArray(entry.values) ? entry.values : [entry],
      ),
    );
  }
  if (!isRecord(value)) return [];

  const options = value.reasoning_options ?? value.reasoningOptions;
  if (options !== undefined) return parseReasoningEfforts(options);
  if (value.type === "effort" && Array.isArray(value.values)) {
    return parseReasoningEffortEntries(value.values);
  }

  const entries =
    value.levels ??
    value.options ??
    value.values ??
    value.efforts ??
    value.supportedEfforts ??
    value.supported_efforts;
  if (Array.isArray(entries)) return parseReasoningEffortEntries(entries);

  const namedLevels = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  return parseReasoningEffortEntries(
    namedLevels.flatMap((id) => {
      const capability = value[id];
      return isRecord(capability) && capability.supported === true
        ? [{ id }]
        : capability === true
          ? [{ id }]
          : [];
    }),
  );
}

function parseReasoningEffortEntries(
  entries: ReadonlyArray<unknown>,
): ReadonlyArray<RemoteReasoningEffort> {
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    if (typeof entry === "string") {
      const id = nonEmptyString(entry);
      if (!id || seen.has(id)) return [];
      seen.add(id);
      return [{ id }];
    }
    if (!isRecord(entry)) return [];
    const id =
      nonEmptyString(entry.reasoningEffort) ??
      nonEmptyString(entry.effort) ??
      nonEmptyString(entry.id);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const label = nonEmptyString(entry.label) ?? nonEmptyString(entry.name);
    const description = nonEmptyString(entry.description);
    return [
      {
        id,
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
      },
    ];
  });
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function contextWindowTokens(value: unknown): number | undefined {
  const numeric = positiveInteger(value);
  if (numeric) return numeric;
  if (typeof value !== "string") return undefined;

  const normalized = value.trim().toLowerCase().replaceAll(",", "");
  const match = normalized.match(/^(\d+(?:\.\d+)?)(?:\s*(tokens?|k|m|b))?$/u);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = match[2] ?? "";
  const multiplier = unit.startsWith("b")
    ? 1_000_000_000
    : unit === "m"
      ? 1_000_000
      : unit === "k"
        ? 1_000
        : 1;
  const tokens = amount * multiplier;
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

function canonicalContextWindowId(tokens: number): string {
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}m`;
  if (tokens % 1_000 === 0) return `${tokens / 1_000}k`;
  return String(tokens);
}

function humanizeContextWindow(tokens: number): string {
  return canonicalContextWindowId(tokens).replace(/m$/u, "M");
}

function parseContextWindowEntry(value: unknown): RemoteContextWindow | undefined {
  if (isRecord(value)) {
    const tokens =
      contextWindowTokens(value.tokens) ??
      contextWindowTokens(value.tokenLimit) ??
      contextWindowTokens(value.contextWindow) ??
      contextWindowTokens(value.context_window) ??
      contextWindowTokens(value.max_context_window) ??
      contextWindowTokens(value.contextLength) ??
      contextWindowTokens(value.context_length) ??
      contextWindowTokens(value.maxTokens) ??
      contextWindowTokens(value.max_tokens) ??
      contextWindowTokens(value.value) ??
      contextWindowTokens(value.size);
    if (!tokens) return undefined;
    const label = nonEmptyString(value.label) ?? nonEmptyString(value.name);
    return {
      id: canonicalContextWindowId(tokens),
      tokens,
      ...(label ? { label } : {}),
    };
  }
  const tokens = contextWindowTokens(value);
  return tokens
    ? { id: canonicalContextWindowId(tokens), tokens, label: humanizeContextWindow(tokens) }
    : undefined;
}

function parseContextWindows(value: Record<string, unknown>): {
  readonly contextWindows: ReadonlyArray<RemoteContextWindow>;
  readonly defaultContextWindowTokens?: number;
} {
  const entries: unknown[] = [];
  const sources = [
    value,
    ...(isRecord(value.capabilities) ? [value.capabilities] : []),
    ...(isRecord(value.capabilities) && isRecord(value.capabilities.context)
      ? [value.capabilities.context]
      : []),
    ...(isRecord(value.limits) ? [value.limits] : []),
    ...(isRecord(value.limit) ? [value.limit] : []),
    ...(isRecord(value.metadata) ? [value.metadata] : []),
  ];
  for (const source of sources) {
    for (const key of [
      "contextWindows",
      "context_windows",
      "supportedContextWindows",
      "supported_context_windows",
    ]) {
      const candidate = source[key];
      if (Array.isArray(candidate)) entries.push(...candidate);
      else if (candidate !== undefined) entries.push(candidate);
    }

    for (const key of [
      "contextWindow",
      "context_window",
      "max_context_window",
      "contextLength",
      "context_length",
      "contextLengthTokens",
      "context_length_tokens",
      "contextWindowSize",
      "context_window_size",
      "maxInputTokens",
      "max_input_tokens",
      "maxContextTokens",
      "max_context_tokens",
      "maxContextLength",
      "max_context_length",
      "maxInputLength",
      "max_input_length",
      "inputTokenLimit",
      "input_token_limit",
    ]) {
      if (source[key] !== undefined) entries.push(source[key]);
    }

    for (const key of ["limit", "limits"]) {
      const limits = source[key];
      if (isRecord(limits) && limits.context !== undefined) entries.push(limits.context);
    }
  }

  const seen = new Set<number>();
  const contextWindows = entries.flatMap((entry) => {
    const parsed = parseContextWindowEntry(entry);
    if (!parsed || seen.has(parsed.tokens)) return [];
    seen.add(parsed.tokens);
    return [parsed];
  });

  const defaultContextWindowTokens = sources
    .flatMap((source) =>
      [
        "defaultContextWindow",
        "default_context_window",
        "defaultContextWindowTokens",
        "default_context_window_tokens",
      ].map((key) => contextWindowTokens(source[key])),
    )
    .find((candidate): candidate is number => candidate !== undefined);

  return {
    contextWindows,
    ...(defaultContextWindowTokens ? { defaultContextWindowTokens } : {}),
  };
}

function remoteModelFromRecord(
  value: Record<string, unknown>,
  contextWindowSource: ContextWindowSource = "provider",
): RemoteModel | undefined {
  const id = nonEmptyString(value.id) ?? nonEmptyString(value.model) ?? nonEmptyString(value.slug);
  if (!id) return undefined;
  const capabilities = isRecord(value.capabilities) ? value.capabilities : undefined;
  const reasoning =
    (isRecord(value.reasoning) ? value.reasoning : undefined) ??
    (isRecord(value.reasoning_capability) ? value.reasoning_capability : undefined) ??
    (isRecord(value.reasoning_capabilities) ? value.reasoning_capabilities : undefined) ??
    (isRecord(capabilities?.reasoning) ? capabilities.reasoning : undefined) ??
    (isRecord(capabilities?.effort) ? capabilities.effort : undefined) ??
    (isRecord(capabilities?.thinking) ? capabilities.thinking : undefined) ??
    (value.reasoning === true || value.thinking === true ? { supported: true } : undefined) ??
    (capabilities?.reasoning === true || capabilities?.thinking === true
      ? { supported: true }
      : undefined);
  const reasoningEfforts = parseReasoningEfforts(
    value.supportedReasoningEfforts ??
      value.supported_reasoning_efforts ??
      value.supported_reasoning_levels ??
      value.reasoningEfforts ??
      value.reasoning_efforts ??
      value.supportedEfforts ??
      value.supported_efforts ??
      value.reasoning_options ??
      value.reasoningOptions ??
      reasoning,
  );
  const reasoningSupported = [
    typeof value.reasoning === "boolean" ? value.reasoning : undefined,
    typeof value.thinking === "boolean" ? value.thinking : undefined,
    isRecord(reasoning) && typeof reasoning.supported === "boolean"
      ? reasoning.supported
      : undefined,
    isRecord(capabilities?.effort) && typeof capabilities.effort.supported === "boolean"
      ? capabilities.effort.supported
      : undefined,
    reasoningEfforts.length > 0 ? true : undefined,
  ].find((candidate): candidate is boolean => candidate !== undefined);
  const defaultReasoningEffort =
    nonEmptyString(value.defaultReasoningEffort) ??
    nonEmptyString(value.default_reasoning_effort) ??
    nonEmptyString(value.default_reasoning_level) ??
    nonEmptyString(isRecord(reasoning) ? reasoning.default : undefined) ??
    nonEmptyString(isRecord(reasoning) ? reasoning.defaultEffort : undefined) ??
    nonEmptyString(isRecord(reasoning) ? reasoning.default_effort : undefined);
  const { contextWindows, defaultContextWindowTokens } = parseContextWindows(value);
  const rawName = nonEmptyString(value.name);
  return {
    id,
    name:
      nonEmptyString(value.display_name) ??
      nonEmptyString(value.displayName) ??
      (rawName?.startsWith("models/") ? undefined : rawName),
    ...(reasoningSupported !== undefined ? { reasoningSupported } : {}),
    ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(contextWindows.length > 0 ? { contextWindows, contextWindowSource } : {}),
    ...(defaultContextWindowTokens ? { defaultContextWindowTokens } : {}),
  };
}

function modelsDevModel(
  modelsDev: ModelsDevCatalog | undefined,
  provider: string,
  modelId: string,
): Record<string, unknown> | undefined {
  return modelsDev?.[provider]?.[modelId];
}

function mergeRemoteModelMetadata(
  model: RemoteModel,
  fallback: Record<string, unknown> | undefined,
): RemoteModel {
  if (!fallback) return model;
  const metadata = remoteModelFromRecord({ ...fallback, id: model.id }, "models.dev");
  if (!metadata) return model;
  return {
    ...model,
    ...(model.name === undefined && metadata.name !== undefined ? { name: metadata.name } : {}),
    ...(model.reasoningSupported === undefined && metadata.reasoningSupported !== undefined
      ? { reasoningSupported: metadata.reasoningSupported }
      : {}),
    ...(model.reasoningEfforts === undefined && metadata.reasoningEfforts !== undefined
      ? { reasoningEfforts: metadata.reasoningEfforts }
      : {}),
    ...(model.defaultReasoningEffort === undefined && metadata.defaultReasoningEffort !== undefined
      ? { defaultReasoningEffort: metadata.defaultReasoningEffort }
      : {}),
    ...(model.contextWindows === undefined && metadata.contextWindows !== undefined
      ? {
          contextWindows: metadata.contextWindows,
          contextWindowSource: "models.dev" as const,
        }
      : {}),
    ...(model.defaultContextWindowTokens === undefined &&
    metadata.defaultContextWindowTokens !== undefined
      ? { defaultContextWindowTokens: metadata.defaultContextWindowTokens }
      : {}),
  };
}

function applyCodexOAuthContextPolicy(
  model: RemoteModel,
  environment: NodeJS.ProcessEnv,
): RemoteModel {
  if (!isCodexOAuthModel(`openai-codex/${model.id}`)) return model;

  const modelSlug = `openai-codex/${model.id}`;
  const oauthContext = readCodexOAuthContextWindow(modelSlug, environment);
  const effectiveDefaultContextWindowTokens = oauthContext?.effectiveContextWindowTokens;
  const maxEffectiveContextWindowTokens = oauthContext?.maxEffectiveContextWindowTokens;
  const contextWindows = (model.contextWindows ?? [])
    .map((contextWindow) => {
      const tokens = normalizeCodexOAuthEffectiveContextWindowTokens(
        modelSlug,
        contextWindow.tokens,
        environment,
      );
      return tokens === undefined
        ? undefined
        : {
            ...contextWindow,
            tokens,
            id: canonicalContextWindowId(tokens),
            ...(contextWindow.tokens !== tokens
              ? { label: humanizeContextWindow(tokens) }
              : contextWindow.label
                ? { label: contextWindow.label }
                : {}),
          };
    })
    .filter((contextWindow): contextWindow is RemoteContextWindow => contextWindow !== undefined)
    .filter(
      (contextWindow, index, all) =>
        all.findIndex((candidate) => candidate.tokens === contextWindow.tokens) === index,
    );
  if (maxEffectiveContextWindowTokens !== undefined) {
    const selectableSizes = [
      64_000,
      128_000,
      256_000,
      512_000,
      1_000_000,
      maxEffectiveContextWindowTokens,
    ].filter((tokens) => tokens <= maxEffectiveContextWindowTokens);
    for (const tokens of selectableSizes) {
      if (contextWindows.some((contextWindow) => contextWindow.tokens === tokens)) continue;
      contextWindows.push({
        id: canonicalContextWindowId(tokens),
        tokens,
        label: humanizeContextWindow(tokens),
      });
    }
    contextWindows.sort((left, right) => left.tokens - right.tokens);
  }
  if (
    effectiveDefaultContextWindowTokens !== undefined &&
    !contextWindows.some(
      (contextWindow) => contextWindow.tokens === effectiveDefaultContextWindowTokens,
    )
  ) {
    contextWindows.push({
      id: canonicalContextWindowId(effectiveDefaultContextWindowTokens),
      tokens: effectiveDefaultContextWindowTokens,
      label: humanizeContextWindow(effectiveDefaultContextWindowTokens),
    });
  }
  const effectiveContextWindows =
    contextWindows.length > 0
      ? contextWindows
      : [
          {
            id: canonicalContextWindowId(effectiveDefaultContextWindowTokens ?? 258_400),
            tokens: effectiveDefaultContextWindowTokens ?? 258_400,
            label: humanizeContextWindow(effectiveDefaultContextWindowTokens ?? 258_400),
          },
        ];
  const requestedDefault = effectiveDefaultContextWindowTokens ?? model.defaultContextWindowTokens;
  const defaultContextWindowTokens = effectiveContextWindows.some(
    (contextWindow) => contextWindow.tokens === requestedDefault,
  )
    ? requestedDefault
    : effectiveContextWindows.at(-1)?.tokens;

  return {
    ...model,
    contextWindows: effectiveContextWindows,
    ...(defaultContextWindowTokens !== undefined ? { defaultContextWindowTokens } : {}),
    contextWindowSource: "oauth",
  };
}

async function fetchJson(
  fetchImplementation: FetchImplementation,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetchImplementation(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    throw new Error("The model endpoint returned an invalid response");
  }
  return payload;
}

function parseOpenAICompatibleModels(payload: Record<string, unknown>): ReadonlyArray<RemoteModel> {
  if (!Array.isArray(payload.data)) return [];
  return payload.data.flatMap((value) =>
    isRecord(value) ? (remoteModelFromRecord(value) ?? []) : [],
  );
}

function parseModelsDevCatalog(payload: Record<string, unknown>): ModelsDevCatalog {
  const providers: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [providerId, providerValue] of Object.entries(payload)) {
    if (!isRecord(providerValue) || !isRecord(providerValue.models)) continue;
    const models: Record<string, Record<string, unknown>> = {};
    for (const [modelId, modelValue] of Object.entries(providerValue.models)) {
      if (isRecord(modelValue)) models[modelId] = modelValue;
    }
    if (Object.keys(models).length > 0) providers[providerId] = models;
  }
  return providers;
}

async function loadModelsDevCatalog(
  fetchImplementation: FetchImplementation,
): Promise<ModelsDevCatalog | undefined> {
  try {
    return parseModelsDevCatalog(
      await fetchJson(fetchImplementation, "https://models.dev/api.json", {}),
    );
  } catch {
    return undefined;
  }
}

/**
 * The Axle hosted provider's default endpoint. Matches the Rust runtime's
 * `DEFAULT_AXLE_BASE_URL`, so discovery and generation hit the same gateway.
 */
export const AXLE_HOSTED_BASE_URL = "https://axle-gateway.axle-download-worker.workers.dev/v1";

/**
 * The credential Axle's own provider falls back to.
 *
 * Axle's hosted gateway is part of the product rather than a vendor the user
 * brings, so the provider is preconfigured and always available. The gateway
 * derives a stable anonymous identity from any bearer token, and that identity
 * is what the free daily credit grant is attached to; an `axl_...` key from the
 * account page takes precedence and moves the spend onto the signed-in account.
 * The token is deliberately not `axl_`-shaped so it can never be mistaken for,
 * or collide with, a real account key.
 */
export const AXLE_BUILT_IN_API_KEY = "axle-desktop-free";

const withoutTrailingSlashes = (value: string): string => value.replace(/\/+$/u, "");

/**
 * Resolve a discovery endpoint. A provider's own `<PROVIDER>_BASE_URL`
 * variable overrides its default so a self-hosted, proxied, or Axle-hosted
 * gateway is discovered exactly where the Rust runtime would send the request.
 * The variable is provider-scoped, so pointing one provider at a gateway never
 * redirects the others. Trailing slashes are trimmed so the `/models` join
 * stays a single slash.
 */
function providerBaseUrl(
  fallback: string,
  environment: NodeJS.ProcessEnv | undefined,
  variable: string,
): string {
  const override = environment?.[variable]?.trim();
  return withoutTrailingSlashes(override && override.length > 0 ? override : fallback);
}

/**
 * Environment variable prefixes owned by the built-in providers. For these,
 * `<PREFIX>_BASE_URL` only overrides a vendor endpoint that is already known.
 */
const BUILT_IN_ENV_PREFIXES: ReadonlySet<string> = new Set([
  "OPENAI",
  "ANTHROPIC",
  "GEMINI",
  "FIREWORKS",
  "OLLAMA",
  "OLLAMA_CLOUD",
  "CEREBRAS",
  "GROQ",
  "OPENROUTER",
  "MISTRAL",
  "DEEPSEEK",
  "XAI",
  "AXLE",
  "AXLE_LOCAL",
]);

const CUSTOM_BASE_URL_VARIABLE = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)_BASE_URL$/u;

const isLocalhostUrl = (url: string): boolean => /localhost|127\.0\.0\.1|\[::1\]/u.test(url);

interface CustomProviderDefinition {
  /** Environment variable prefix, for example `NVIDIA_NIM`. */
  readonly envPrefix: string;
  /** Model slug prefix, for example `nvidia-nim`. */
  readonly prefix: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  /**
   * Extra headers for every request, from `<PREFIX>_HEADERS`. This is how a
   * provider that is not in the catalogue can carry its own requirements.
   */
  readonly headers: ReadonlyArray<readonly [string, string]>;
}

/**
 * Providers the user brought themselves, declared purely as environment
 * variables: `<PREFIX>_BASE_URL` is the endpoint, `<PREFIX>_API_KEY` the
 * credential, the optional `<PREFIX>_LABEL` the display name, and the optional
 * `<PREFIX>_HEADERS` a JSON object of extra request headers. The prefix also
 * becomes the model slug prefix, which is how the runtime routes a turn back
 * to the same endpoint. Built-in prefixes are excluded above, so the same
 * mechanism keeps working as an endpoint override for those vendors.
 */
function customProviders(environment: NodeJS.ProcessEnv): ReadonlyArray<CustomProviderDefinition> {
  return Object.entries(environment)
    .flatMap(([name, rawValue]): ReadonlyArray<CustomProviderDefinition> => {
      const envPrefix = CUSTOM_BASE_URL_VARIABLE.exec(name)?.[1];
      if (!envPrefix || BUILT_IN_ENV_PREFIXES.has(envPrefix)) return [];
      const configuredUrl = rawValue?.trim();
      if (!configuredUrl) return [];
      const baseUrl = withoutTrailingSlashes(configuredUrl);
      const apiKey = environment[`${envPrefix}_API_KEY`]?.trim() ?? "";
      // A hosted endpoint with no credential only answers 401, so it is not
      // worth advertising; a local server legitimately needs no key.
      if (apiKey.length === 0 && !isLocalhostUrl(baseUrl)) return [];
      return [
        {
          envPrefix,
          prefix: envPrefix.toLowerCase().replaceAll("_", "-"),
          label: environment[`${envPrefix}_LABEL`]?.trim() || humanizeModelId(envPrefix),
          baseUrl,
          apiKey,
          headers: parseProviderHeaders(environment[providerHeadersVariable(envPrefix)]),
        },
      ];
    })
    .toSorted((left, right) => left.envPrefix.localeCompare(right.envPrefix));
}

/**
 * A provider the runtime can execute. Built-ins narrow their ids to literals,
 * while a provider the user brought widens them to any prefix.
 */
type RuntimeProviderDefinition = Omit<ProviderDefinition, "env" | "prefix" | "label"> & {
  readonly env?: string;
  readonly prefix: string;
  readonly label: string;
};

/**
 * Headers for a request to an OpenAI-compatible endpoint: whatever its
 * hostname requires, then anything the caller adds on top. `Authorization` is
 * applied last by the caller so a preset can never displace the credential.
 */
function providerPresetRequestHeaders(baseUrl: string): Record<string, string> {
  return Object.fromEntries(providerPresetHeaders(resolveProviderPreset(baseUrl)));
}

async function loadOpenAICompatibleModels(
  apiKey: string,
  fetchImplementation: FetchImplementation,
  baseUrl: string,
  modelsDev: ModelsDevCatalog | undefined,
  modelsDevProvider: string,
  extraHeaders?: ReadonlyArray<readonly [string, string]>,
): Promise<ReadonlyArray<RemoteModel>> {
  const models = parseOpenAICompatibleModels(
    await fetchJson(fetchImplementation, `${baseUrl}/models`, {
      headers: {
        ...providerPresetRequestHeaders(baseUrl),
        ...Object.fromEntries(extraHeaders ?? []),
        Authorization: `Bearer ${apiKey}`,
      },
    }),
  );
  return models.map((model) =>
    mergeRemoteModelMetadata(model, modelsDevModel(modelsDev, modelsDevProvider, model.id)),
  );
}

async function loadOpenAIModels(
  apiKey: string,
  fetchImplementation: FetchImplementation,
  environment: NodeJS.ProcessEnv,
  modelsDev?: ModelsDevCatalog,
): Promise<ReadonlyArray<RemoteModel>> {
  return loadOpenAICompatibleModels(
    apiKey,
    fetchImplementation,
    providerBaseUrl("https://api.openai.com/v1", environment, "OPENAI_BASE_URL"),
    modelsDev,
    "openai",
  );
}

async function loadClaudeModels(
  apiKey: string,
  fetchImplementation: FetchImplementation,
  environment: NodeJS.ProcessEnv,
  modelsDev?: ModelsDevCatalog,
): Promise<ReadonlyArray<RemoteModel>> {
  const baseUrl = providerBaseUrl(
    "https://api.anthropic.com/v1",
    environment,
    "ANTHROPIC_BASE_URL",
  );
  const models: RemoteModel[] = [];
  let afterId: string | undefined;
  do {
    const url = new URL(`${baseUrl}/models`);
    url.searchParams.set("limit", "1000");
    if (afterId) url.searchParams.set("after_id", afterId);
    const payload = await fetchJson(fetchImplementation, url.toString(), {
      headers: {
        ...providerPresetRequestHeaders(baseUrl),
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
      },
    });
    const page = parseOpenAICompatibleModels(payload);
    models.push(...page);
    const hasMore = payload.has_more === true;
    afterId = hasMore ? nonEmptyString(payload.last_id) : undefined;
    if (hasMore && !afterId) break;
  } while (afterId);

  // Anthropic's list response contains the model ids, but capability metadata
  // is returned by the per-model endpoint. Fetch it when the list did not
  // already include the fields (the API has changed between versions).
  return Promise.all(
    models.map(async (model) => {
      if (model.reasoningSupported !== undefined && model.contextWindows?.length) {
        return mergeRemoteModelMetadata(model, modelsDevModel(modelsDev, "anthropic", model.id));
      }
      try {
        const detail = await fetchJson(
          fetchImplementation,
          `${baseUrl}/models/${encodeURIComponent(model.id)}`,
          {
            headers: {
              ...providerPresetRequestHeaders(baseUrl),
              "anthropic-version": "2023-06-01",
              "x-api-key": apiKey,
            },
          },
        );
        const enriched = remoteModelFromRecord({ ...detail, id: model.id });
        return mergeRemoteModelMetadata(
          enriched ? { ...model, ...enriched } : model,
          modelsDevModel(modelsDev, "anthropic", model.id),
        );
      } catch {
        // Model discovery should remain useful when one detail request is
        // unavailable or an older Anthropic endpoint does not support it.
        return mergeRemoteModelMetadata(model, modelsDevModel(modelsDev, "anthropic", model.id));
      }
    }),
  );
}

async function loadGoogleModels(
  apiKey: string,
  fetchImplementation: FetchImplementation,
  environment: NodeJS.ProcessEnv,
  modelsDev?: ModelsDevCatalog,
): Promise<ReadonlyArray<RemoteModel>> {
  const baseUrl = providerBaseUrl(
    "https://generativelanguage.googleapis.com/v1beta",
    environment,
    "GEMINI_BASE_URL",
  );
  const models: RemoteModel[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${baseUrl}/models`);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const payload = await fetchJson(fetchImplementation, url.toString(), {
      headers: { "x-goog-api-key": apiKey },
    });
    if (Array.isArray(payload.models)) {
      for (const value of payload.models) {
        if (!isRecord(value)) continue;
        const methods = Array.isArray(value.supportedGenerationMethods)
          ? value.supportedGenerationMethods
          : [];
        if (!methods.includes("generateContent")) continue;
        const id = nonEmptyString(value.name)?.replace(/^models\//u, "");
        if (!id) continue;
        models.push(remoteModelFromRecord({ ...value, id }) ?? { id });
      }
    }
    pageToken = nonEmptyString(payload.nextPageToken);
  } while (pageToken);
  return Promise.all(
    models.map(async (model) => {
      if (model.reasoningSupported !== undefined && model.contextWindows?.length) {
        return mergeRemoteModelMetadata(model, modelsDevModel(modelsDev, "google", model.id));
      }
      try {
        const detail = await fetchJson(
          fetchImplementation,
          `${baseUrl}/models/${encodeURIComponent(model.id)}`,
          { headers: { "x-goog-api-key": apiKey } },
        );
        const enriched = remoteModelFromRecord({ ...detail, id: model.id });
        return mergeRemoteModelMetadata(
          enriched ? { ...model, ...enriched } : model,
          modelsDevModel(modelsDev, "google", model.id),
        );
      } catch {
        return mergeRemoteModelMetadata(model, modelsDevModel(modelsDev, "google", model.id));
      }
    }),
  );
}

export async function loadCodexModels(
  _apiKey: string,
  fetchImplementation: FetchImplementation,
  environment: NodeJS.ProcessEnv,
  _modelsDev?: ModelsDevCatalog,
): Promise<ReadonlyArray<RemoteModel>> {
  let credentials = readCodexOAuthCredentials(environment);
  if (!credentials) return [];
  if (credentials.expiresAt <= Date.now() + 5 * 60 * 1000) {
    await refreshCodexOAuthSession(environment);
    credentials = readCodexOAuthCredentials(environment);
    if (!credentials) {
      throw new Error("The ChatGPT session could not be refreshed for model discovery");
    }
  }

  try {
    const payload = await fetchJson(fetchImplementation, CODEX_MODELS_ENDPOINT, {
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
    });
    if (!Array.isArray(payload.models)) return CHATGPT_CODEX_MODELS;
    const metadataByModelId = new Map(
      payload.models.flatMap((entry): ReadonlyArray<readonly [string, Record<string, unknown>]> => {
        if (!isRecord(entry)) return [];
        const id =
          nonEmptyString(entry.slug) ?? nonEmptyString(entry.id) ?? nonEmptyString(entry.model);
        return id ? [[id, entry]] : [];
      }),
    );
    return CHATGPT_CODEX_MODELS.map((model) => {
      const metadata = metadataByModelId.get(model.id);
      if (!metadata) return model;
      const enriched = remoteModelFromRecord({ ...metadata, id: model.id });
      return enriched ? { ...enriched, name: model.name } : model;
    });
  } catch {
    return CHATGPT_CODEX_MODELS;
  }
}
export type CodexModelLoader = (
  environment: NodeJS.ProcessEnv,
) => Promise<ReadonlyArray<RemoteModel>>;

const loadCodexModelsForDiscovery: CodexModelLoader = (environment) =>
  loadCodexModels("authenticated", globalThis.fetch, environment);

/**
 * Axle Offline models come from the packs this machine has already installed.
 * The state file is the source of truth, so a pack appears in the picker only
 * after its download and checksum have finished.
 */
async function loadAxleLocalModels(
  _apiKey: string,
  _fetchImplementation: FetchImplementation,
  environment: NodeJS.ProcessEnv,
): Promise<ReadonlyArray<RemoteModel>> {
  const statePath = environment.AXLE_LOCAL_MODELS_STATE_PATH?.trim();
  if (!statePath) return [];
  const installed = await readInstalledPackIds(statePath);
  return LOCAL_MODEL_PACKS.filter((pack) => installed.has(pack.id)).map((pack) => ({
    id: pack.id,
    name: `${pack.name} · ${pack.model}`,
    reasoningSupported: false,
    contextWindows: [
      {
        id: "32k",
        tokens: pack.contextWindowTokens,
        label: `${Math.round(pack.contextWindowTokens / 1024)}K`,
      },
    ],
    defaultContextWindowTokens: pack.contextWindowTokens,
    contextWindowSource: "provider",
  }));
}

const PROVIDERS: ReadonlyArray<ProviderDefinition> = [
  // Axle's own provider. It is configured by the app, not by the user: the
  // gateway, the model catalog, and the free daily credits are all part of the
  // product, so it is present without an `AXLE_API_KEY` and an account key is
  // only an override that ties the spend to the signed-in account.
  {
    env: "AXLE_API_KEY",
    prefix: "axle",
    label: "Axle",
    load: (apiKey, fetchImplementation, environment, modelsDev) =>
      loadOpenAICompatibleModels(
        apiKey,
        fetchImplementation,
        providerBaseUrl(AXLE_HOSTED_BASE_URL, environment, "AXLE_BASE_URL"),
        modelsDev,
        "axle",
      ),
  },
  {
    env: "AXLE_LOCAL_API_KEY",
    prefix: "axle-local",
    label: "Axle Offline",
    load: loadAxleLocalModels,
  },
  {
    prefix: "openai-codex",
    label: "OpenAI Codex",
    load: loadCodexModels,
  },
  {
    env: "OPENAI_API_KEY",
    prefix: "openai",
    label: "OpenAI",
    load: loadOpenAIModels,
  },
  {
    env: "ANTHROPIC_API_KEY",
    prefix: "anthropic",
    label: "Claude",
    load: loadClaudeModels,
  },
  {
    env: "GEMINI_API_KEY",
    prefix: "google",
    label: "Google",
    load: loadGoogleModels,
  },
  {
    env: "FIREWORKS_API_KEY",
    prefix: "fireworks",
    label: "Fireworks",
    load: (apiKey, fetchImplementation, environment, modelsDev) =>
      loadOpenAICompatibleModels(
        apiKey,
        fetchImplementation,
        providerBaseUrl("https://api.fireworks.ai/inference/v1", environment, "FIREWORKS_BASE_URL"),
        modelsDev,
        "fireworks-ai",
      ),
  },
  {
    env: "OLLAMA_API_KEY",
    prefix: "ollama-cloud",
    label: "Ollama Cloud",
    load: (apiKey, fetchImplementation, environment, modelsDev) =>
      loadOpenAICompatibleModels(
        apiKey,
        fetchImplementation,
        providerBaseUrl("https://ollama.com/v1", environment, "OLLAMA_CLOUD_BASE_URL"),
        modelsDev,
        "ollama",
      ),
  },
  {
    env: "CEREBRAS_API_KEY",
    prefix: "cerebras",
    label: "Cerebras",
    load: (apiKey, fetchImplementation, environment, modelsDev) =>
      loadOpenAICompatibleModels(
        apiKey,
        fetchImplementation,
        providerBaseUrl("https://api.cerebras.ai/v1", environment, "CEREBRAS_BASE_URL"),
        modelsDev,
        "cerebras",
      ),
  },
  {
    env: "GROQ_API_KEY",
    prefix: "groq",
    label: "Groq",
    load: (apiKey, fetchImplementation, environment, modelsDev) =>
      loadOpenAICompatibleModels(
        apiKey,
        fetchImplementation,
        providerBaseUrl("https://api.groq.com/openai/v1", environment, "GROQ_BASE_URL"),
        modelsDev,
        "groq",
      ),
  },
  {
    env: "OPENROUTER_API_KEY",
    prefix: "openrouter",
    label: "OpenRouter",
    load: (apiKey, fetchImplementation, environment, modelsDev) =>
      loadOpenAICompatibleModels(
        apiKey,
        fetchImplementation,
        providerBaseUrl("https://openrouter.ai/api/v1", environment, "OPENROUTER_BASE_URL"),
        modelsDev,
        "openrouter",
      ),
  },
  {
    env: "MISTRAL_API_KEY",
    prefix: "mistral",
    label: "Mistral",
    load: (apiKey, fetchImplementation, environment, modelsDev) =>
      loadOpenAICompatibleModels(
        apiKey,
        fetchImplementation,
        providerBaseUrl("https://api.mistral.ai/v1", environment, "MISTRAL_BASE_URL"),
        modelsDev,
        "mistral",
      ),
  },
  {
    env: "DEEPSEEK_API_KEY",
    prefix: "deepseek",
    label: "DeepSeek",
    load: (apiKey, fetchImplementation, environment, modelsDev) =>
      loadOpenAICompatibleModels(
        apiKey,
        fetchImplementation,
        providerBaseUrl("https://api.deepseek.com/v1", environment, "DEEPSEEK_BASE_URL"),
        modelsDev,
        "deepseek",
      ),
  },
  {
    env: "XAI_API_KEY",
    prefix: "xai",
    label: "xAI",
    load: (apiKey, fetchImplementation, environment, modelsDev) =>
      loadOpenAICompatibleModels(
        apiKey,
        fetchImplementation,
        providerBaseUrl("https://api.x.ai/v1", environment, "XAI_BASE_URL"),
        modelsDev,
        "xai",
      ),
  },
];

/**
 * Whether a built-in provider can be probed with the current environment.
 *
 * Most providers exist only once the user supplies a credential. Axle's own
 * provider is the exception: it is part of the product, so it is always
 * available and the built-in credential stands in until an account key is set.
 */
function isProviderAvailable(
  provider: ProviderDefinition,
  environment: NodeJS.ProcessEnv,
): boolean {
  if (provider.prefix === "ollama-cloud") {
    return environment.OLLAMA_CLOUD_CONFIGURED === "true";
  }
  if (provider.prefix === "axle-local") {
    const statePath = environment.AXLE_LOCAL_MODELS_STATE_PATH?.trim();
    return statePath !== undefined && NodeFS.existsSync(statePath);
  }
  if (provider.env === undefined) {
    return hasCodexOAuthAuthentication(environment);
  }
  if (provider.prefix === "axle") {
    return true;
  }
  return Boolean(environment[provider.env]?.trim());
}

/**
 * The credential a provider authenticates its probe with: the user's own
 * variable when they set one, Axle's built-in token for the preconfigured
 * provider, and the OAuth session for Codex.
 */
function providerCredential(
  provider: ProviderDefinition,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (provider.env === undefined) {
    return "authenticated";
  }
  const configured = environment[provider.env]?.trim();
  if (configured) {
    return configured;
  }
  return provider.prefix === "axle" ? AXLE_BUILT_IN_API_KEY : undefined;
}

export async function discoverAxleModels(
  environment: NodeJS.ProcessEnv,
  fetchImplementation: FetchImplementation = globalThis.fetch,
  codexModelLoader: CodexModelLoader = loadCodexModelsForDiscovery,
): Promise<AxleModelDiscovery> {
  const custom = customProviders(environment);
  const configured: ReadonlyArray<{
    readonly provider: RuntimeProviderDefinition;
    readonly apiKey: string;
  }> = [
    ...PROVIDERS.filter((provider) => isProviderAvailable(provider, environment)).map(
      (provider) => ({
        provider,
        apiKey: providerCredential(provider, environment) ?? "",
      }),
    ),
    ...custom.map((provider) => ({
      provider: {
        env: `${provider.envPrefix}_API_KEY`,
        prefix: provider.prefix,
        label: provider.label,
        load: (
          apiKey: string,
          fetchImplementation: FetchImplementation,
          _environment: NodeJS.ProcessEnv,
          modelsDev?: ModelsDevCatalog,
        ) =>
          loadOpenAICompatibleModels(
            apiKey,
            fetchImplementation,
            provider.baseUrl,
            modelsDev,
            provider.prefix,
            provider.headers,
          ),
      } satisfies RuntimeProviderDefinition,
      apiKey: provider.apiKey,
    })),
  ];

  const modelsDev =
    configured.length > 0 ? await loadModelsDevCatalog(fetchImplementation) : undefined;

  const results = await Promise.all(
    configured.map(async ({ provider, apiKey }) => {
      try {
        const loadedRemoteModels =
          provider.prefix === "openai-codex"
            ? await codexModelLoader(environment)
            : await provider.load(apiKey, fetchImplementation, environment, modelsDev);
        const remoteModels =
          provider.prefix === "openai-codex"
            ? loadedRemoteModels
                .map((model) =>
                  mergeRemoteModelMetadata(
                    model,
                    modelsDevModel(modelsDev, "openai-codex", model.id) ??
                      modelsDevModel(modelsDev, "openai", model.id),
                  ),
                )
                .map((model) => applyCodexOAuthContextPolicy(model, environment))
            : loadedRemoteModels;
        const seen = new Set<string>();
        const models = remoteModels.flatMap((remoteModel): ReadonlyArray<ServerProviderModel> => {
          const id = remoteModel.id.trim().replace(/^models\//u, "");
          if (!id || seen.has(id)) return [];
          seen.add(id);
          const name = remoteModel.name?.trim() || humanizeModelId(id);
          const supportedReasoningEfforts = remoteModel.reasoningEfforts ?? [];
          const defaultReasoningEffort = supportedReasoningEfforts.some(
            (effort) => effort.id === remoteModel.defaultReasoningEffort,
          )
            ? remoteModel.defaultReasoningEffort
            : undefined;
          const rawContextWindows = remoteModel.contextWindows ?? [];
          const contextWindows = rawContextWindows;
          const requestedDefaultContextWindowTokens =
            remoteModel.defaultContextWindowTokens === undefined
              ? undefined
              : remoteModel.defaultContextWindowTokens;
          const defaultContextWindowTokens = contextWindows.some(
            (contextWindow) => contextWindow.tokens === requestedDefaultContextWindowTokens,
          )
            ? requestedDefaultContextWindowTokens
            : contextWindows.length === 1
              ? contextWindows[0]?.tokens
              : undefined;
          const optionDescriptors = [
            ...(remoteModel.reasoningSupported !== false && supportedReasoningEfforts.length > 0
              ? [
                  {
                    id: "reasoningEffort",
                    label: "Reasoning",
                    type: "select" as const,
                    options: supportedReasoningEfforts.map((effort) => ({
                      id: effort.id,
                      label: effort.label || humanizeModelId(effort.id),
                      ...(effort.description ? { description: effort.description } : {}),
                      ...(effort.id === defaultReasoningEffort ? { isDefault: true } : {}),
                    })),
                    ...(defaultReasoningEffort ? { currentValue: defaultReasoningEffort } : {}),
                  },
                ]
              : []),
            ...(contextWindows.length > 0
              ? [
                  {
                    id: "contextWindow",
                    label: "Context Window",
                    type: "select" as const,
                    options: contextWindows.map((contextWindow) => ({
                      id: contextWindow.id,
                      label: contextWindow.label || humanizeContextWindow(contextWindow.tokens),
                      ...(contextWindow.tokens === defaultContextWindowTokens
                        ? { isDefault: true }
                        : {}),
                    })),
                    ...(defaultContextWindowTokens
                      ? { currentValue: canonicalContextWindowId(defaultContextWindowTokens) }
                      : {}),
                  },
                ]
              : []),
          ];
          return [
            {
              slug: `${provider.prefix}/${id}`,
              name,
              shortName: name,
              subProvider: provider.label,
              isCustom: false,
              capabilities:
                optionDescriptors.length > 0
                  ? createModelCapabilities({ optionDescriptors })
                  : null,
              ...(remoteModel.contextWindowSource
                ? { contextWindowSource: remoteModel.contextWindowSource }
                : {}),
            },
          ];
        });
        return { models, error: undefined };
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        return {
          models: [] as ReadonlyArray<ServerProviderModel>,
          error: `${provider.label}: ${detail}`,
        };
      }
    }),
  );

  // Built-ins keep their declared order; providers the user brought follow,
  // because their labels are not in `PROVIDERS`.
  const providerOrder = new Map(
    [
      ...PROVIDERS.map((provider) => provider.label),
      ...custom.map((provider) => provider.label),
    ].map((label, index) => [label, index] as const),
  );
  const models = results
    .flatMap((result) => result.models)
    .toSorted((left, right) => {
      const providerDelta =
        (providerOrder.get(left.subProvider ?? "") ?? Number.MAX_SAFE_INTEGER) -
        (providerOrder.get(right.subProvider ?? "") ?? Number.MAX_SAFE_INTEGER);
      const codexModelDelta =
        (CHATGPT_CODEX_MODEL_ORDER.get(left.slug) ?? Number.POSITIVE_INFINITY) -
        (CHATGPT_CODEX_MODEL_ORDER.get(right.slug) ?? Number.POSITIVE_INFINITY);
      return (
        providerDelta ||
        (Number.isFinite(codexModelDelta)
          ? codexModelDelta
          : left.name.localeCompare(right.name, undefined, { numeric: true }))
      );
    })
    .map((model, index) => (index === 0 ? { ...model, isDefault: true } : model));

  return {
    models,
    configuredProviderCount: configured.length,
    errors: results.flatMap((result) => (result.error ? [result.error] : [])),
  };
}
