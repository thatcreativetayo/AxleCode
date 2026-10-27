import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useRef, useState, type ComponentType, type SVGProps } from "react";
import {
  BoxesIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  LoaderCircleIcon,
  PlusIcon,
  SaveIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import {
  parseProviderHeaders,
  providerHeadersVariable,
  providerPresetHeaders,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderPreset,
  serializeProviderHeaders,
  type ProviderInstanceConfig,
} from "@axle/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@axle/client-runtime/state/runtime";

import {
  useClientSettingsHydrated,
  usePrimarySettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { fetchPrimaryEnvironment } from "../../environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { usePrimaryEnvironment } from "../../state/environments";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ClaudeAI, FireworksAI, Gemini, Ollama, OpenAI, AxleIcon } from "../Icons";
import {
  CerebrasLogo,
  DeepSeekLogo,
  getDisplayModelName,
  getModelProviderPresentation,
  GroqLogo,
  MistralLogo,
  OpenRouterLogo,
  XaiLogo,
} from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { AxleOfflineSettings } from "./AxleOfflineSettings";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

type Logo = ComponentType<SVGProps<SVGSVGElement>>;

const AXLE_INSTANCE_ID = ProviderInstanceId.make("axle");
const AXLE_DRIVER = ProviderDriverKind.make("axle");
const CODEX_AUTH_PATH = "/api/axle/codex-auth";

type CodexAuthStatus = {
  readonly authenticated: boolean;
  readonly expires?: number | null;
  readonly planUsageAuthorized: boolean;
};

async function codexAuthRequest(path = "", method = "GET"): Promise<CodexAuthStatus> {
  const requestUrl = resolvePrimaryEnvironmentHttpUrl(`${CODEX_AUTH_PATH}${path}`);
  let response: Response;
  try {
    response = await fetchPrimaryEnvironment(requestUrl, {
      method,
      signal: AbortSignal.timeout(path === "/login" ? 15 * 60_000 : 20_000),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Could not reach the local ChatGPT authentication service (${detail}). Restart the app and try again.`,
      { cause },
    );
  }
  const responseText = await response.text();
  let payload: CodexAuthStatus & { readonly error?: string };
  try {
    payload = responseText
      ? (JSON.parse(responseText) as CodexAuthStatus & { readonly error?: string })
      : { authenticated: false, planUsageAuthorized: false };
  } catch (cause) {
    throw new Error(
      `The local ChatGPT authentication service returned an invalid response (HTTP ${response.status}).`,
      { cause },
    );
  }
  if (!response.ok) {
    throw new Error(payload.error || `ChatGPT authentication failed (HTTP ${response.status}).`);
  }
  return payload;
}

/**
 * Environment variable prefixes owned by the built-in providers. A user-added
 * provider must not reuse one, or it would silently reconfigure a vendor.
 */
const RESERVED_ENV_PREFIXES: ReadonlySet<string> = new Set([
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

/**
 * A user-added provider is stored purely as environment variables:
 * `<PREFIX>_BASE_URL`, `<PREFIX>_API_KEY`, `<PREFIX>_LABEL`, plus
 * `<PREFIX>_HEADERS` when the endpoint is one that fingerprinting requires
 * extra request headers from. This pattern is what the server's model
 * discovery scans for, and the derived prefix is also the model slug prefix,
 * which is how the runtime routes the turn back to the same endpoint.
 */
const CUSTOM_PROVIDER_BASE_URL_VARIABLE = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)_BASE_URL$/u;

function customProviderEnvPrefix(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

const isLocalhostProviderUrl = (url: string): boolean =>
  /localhost|127\.0\.0\.1|\[::1\]/u.test(url);

const MODEL_APIS: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly envName: string;
  readonly baseUrlEnvName?: string;
  readonly placeholder: string;
  readonly description: string;
  readonly Logo: Logo;
}> = [
  {
    id: "openai",
    name: "OpenAI",
    envName: "OPENAI_API_KEY",
    placeholder: "sk-...",
    description: "GPT models through the OpenAI API.",
    Logo: OpenAI,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    envName: "ANTHROPIC_API_KEY",
    placeholder: "sk-ant-...",
    description: "Claude models through the Anthropic API.",
    Logo: ClaudeAI,
  },
  {
    id: "google",
    name: "Google",
    envName: "GEMINI_API_KEY",
    placeholder: "AIza...",
    description: "Gemini models through Google AI Studio.",
    Logo: Gemini,
  },
  {
    id: "fireworks",
    name: "Fireworks",
    envName: "FIREWORKS_API_KEY",
    placeholder: "fw_...",
    description: "OpenAI-compatible models through Fireworks AI.",
    Logo: FireworksAI,
  },
  {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    envName: "OLLAMA_API_KEY",
    placeholder: "ollama_...",
    description: "Cloud-hosted Ollama models through ollama.com.",
    Logo: Ollama,
  },
  {
    id: "cerebras",
    name: "Cerebras",
    envName: "CEREBRAS_API_KEY",
    placeholder: "csk-...",
    description: "OpenAI-compatible models through Cerebras Inference.",
    Logo: CerebrasLogo,
  },
  {
    id: "groq",
    name: "Groq",
    envName: "GROQ_API_KEY",
    placeholder: "gsk_...",
    description: "OpenAI-compatible models through GroqCloud.",
    Logo: GroqLogo,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    envName: "OPENROUTER_API_KEY",
    placeholder: "sk-or-...",
    description: "OpenAI-compatible models from many vendors through OpenRouter.",
    Logo: OpenRouterLogo,
  },
  {
    id: "mistral",
    name: "Mistral",
    envName: "MISTRAL_API_KEY",
    baseUrlEnvName: "MISTRAL_BASE_URL",
    placeholder: "Mistral API key",
    description: "Mistral and Codestral models through the Mistral API.",
    Logo: MistralLogo,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    envName: "DEEPSEEK_API_KEY",
    baseUrlEnvName: "DEEPSEEK_BASE_URL",
    placeholder: "sk-...",
    description: "DeepSeek chat and reasoner models through api.deepseek.com.",
    Logo: DeepSeekLogo,
  },
  {
    id: "xai",
    name: "xAI",
    envName: "XAI_API_KEY",
    baseUrlEnvName: "XAI_BASE_URL",
    placeholder: "xai-...",
    description: "Grok models through the xAI API.",
    Logo: XaiLogo,
  },
];

export function ModelsSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const clientSettingsHydrated = useClientSettingsHydrated();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [codexAuth, setCodexAuth] = useState<CodexAuthStatus | null>(null);
  const [codexAuthBusy, setCodexAuthBusy] = useState(false);
  const [codexAuthError, setCodexAuthError] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [customProviderDraft, setCustomProviderDraft] = useState({
    name: "",
    baseUrl: "",
    apiKey: "",
  });
  const [customProviderError, setCustomProviderError] = useState<string | null>(null);
  // The catalogue entry the draft's base URL belongs to, if any. Its name
  // fills in for the user and its headers are what the endpoint is known to
  // require.
  const customProviderDraftPreset = useMemo(
    () => resolveProviderPreset(customProviderDraft.baseUrl),
    [customProviderDraft.baseUrl],
  );
  const customProviderDraftHeaders = useMemo(
    () => providerPresetHeaders(customProviderDraftPreset),
    [customProviderDraftPreset],
  );
  const modelPreferencesRef = useRef(settings.providerModelPreferences);
  const [modelPreferences, setModelPreferences] = useState(settings.providerModelPreferences);

  const instance = settings.providerInstances[AXLE_INSTANCE_ID];
  const variables = useMemo(
    () => new Map((instance?.environment ?? []).map((variable) => [variable.name, variable])),
    [instance?.environment],
  );
  // The providers the user added by hand, read back from the same environment
  // variables discovery scans. Sensitive values arrive redacted, so a stored key
  // is only ever rendered as a "Key saved" badge.
  const customProviders = useMemo(() => {
    const found = new Map<
      string,
      {
        readonly envPrefix: string;
        readonly label: string;
        readonly baseUrl: string;
        readonly hasKey: boolean;
        readonly headers: ReadonlyArray<readonly [string, string]>;
      }
    >();
    for (const variable of instance?.environment ?? []) {
      const envPrefix = CUSTOM_PROVIDER_BASE_URL_VARIABLE.exec(variable.name)?.[1];
      if (!envPrefix || RESERVED_ENV_PREFIXES.has(envPrefix)) continue;
      const baseUrl = variable.value.trim();
      if (baseUrl.length === 0) continue;
      const keyVariable = variables.get(`${envPrefix}_API_KEY`);
      const declared = parseProviderHeaders(
        variables.get(providerHeadersVariable(envPrefix))?.value,
      );
      found.set(envPrefix, {
        envPrefix,
        label: variables.get(`${envPrefix}_LABEL`)?.value.trim() || envPrefix.replaceAll("_", " "),
        baseUrl,
        hasKey: keyVariable?.valueRedacted === true || Boolean(keyVariable?.value),
        // What is actually sent: the provider's own headers when it has them,
        // otherwise whatever its hostname is known to require.
        headers:
          declared.length > 0 ? declared : providerPresetHeaders(resolveProviderPreset(baseUrl)),
      });
    }
    return [...found.values()].toSorted((left, right) =>
      left.envPrefix.localeCompare(right.envPrefix),
    );
  }, [instance?.environment, variables]);

  const providerEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
      ),
    [serverProviders, settings],
  );
  const searchableModels = useMemo(() => {
    const normalizedQuery = modelQuery.trim().toLowerCase();
    return providerEntries
      .flatMap((entry) => {
        const preferences = settings.providerModelPreferences[entry.instanceId] ?? {
          hiddenModels: [],
          modelOrder: [],
        };
        const inventorySettings = {
          ...settings,
          providerModelPreferences: {
            ...settings.providerModelPreferences,
            [entry.instanceId]: {
              ...preferences,
              hiddenModels: [],
            },
          },
        };
        return getAppModelOptionsForInstance(inventorySettings, entry).map((model) => ({
          entry,
          model,
        }));
      })
      .filter(({ entry, model }) =>
        normalizedQuery.length === 0
          ? true
          : `${model.slug} ${model.name} ${model.shortName ?? ""} ${model.subProvider ?? ""} ${entry.displayName}`
              .toLowerCase()
              .includes(normalizedQuery),
      );
  }, [modelQuery, providerEntries, settings]);

  useEffect(() => {
    if (!clientSettingsHydrated) return;
    modelPreferencesRef.current = settings.providerModelPreferences;
    setModelPreferences(settings.providerModelPreferences);
  }, [clientSettingsHydrated, settings.providerModelPreferences]);

  useEffect(() => {
    let active = true;
    void codexAuthRequest()
      .then((status) => {
        if (active) setCodexAuth(status);
      })
      .catch((error: unknown) => {
        if (active) setCodexAuthError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, []);

  const refreshAxleProvider = async () => {
    if (!primaryEnvironment) {
      throw new Error("The local provider is not connected yet. Restart the app and try again.");
    }
    const result = await refreshServerProviders({
      environmentId: primaryEnvironment.environmentId,
      input: { instanceId: AXLE_INSTANCE_ID },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      throw error instanceof Error ? error : new Error(String(error));
    }
  };

  const updateCodexAuthentication = async (operation: "login" | "logout") => {
    setCodexAuthBusy(true);
    setCodexAuthError(null);
    try {
      const status = await codexAuthRequest(`/${operation}`, "POST");
      setCodexAuth(status);
      await refreshAxleProvider();
    } catch (error) {
      setCodexAuthError(error instanceof Error ? error.message : String(error));
    } finally {
      setCodexAuthBusy(false);
    }
  };

  const setModelEnabled = (instanceId: ProviderInstanceId, model: string, enabled: boolean) => {
    if (!clientSettingsHydrated) return;
    const currentPreferences = modelPreferencesRef.current;
    const existing = currentPreferences[instanceId] ?? {
      hiddenModels: [],
      modelOrder: [],
    };
    const hiddenModels = enabled
      ? existing.hiddenModels.filter((slug) => slug !== model)
      : [...new Set([...existing.hiddenModels, model])];
    const nextPreferences = {
      ...currentPreferences,
      [instanceId]: {
        ...existing,
        hiddenModels,
      },
    };

    modelPreferencesRef.current = nextPreferences;
    setModelPreferences(nextPreferences);
    updateSettings({ providerModelPreferences: nextPreferences });
  };

  // Saving re-probes the providers so a reachable key or base URL lists its
  // models immediately, without a restart. The settings write itself is
  // fire-and-forget, so the probe runs once straight away and once after a
  // short delay in case the write and the probe crossed on the wire.
  // Discovery is idempotent, and failures already surface on the provider
  // card, so a failed probe is not re-thrown here.
  const refreshAfterCredentialsChange = () => {
    void refreshAxleProvider().catch(() => {});
    window.setTimeout(() => void refreshAxleProvider().catch(() => {}), 400);
  };

  const commitProviderKey = (api: (typeof MODEL_APIS)[number], keyValue: string) => {
    const providerKeyNames = new Set(MODEL_APIS.map((entry) => entry.envName));
    const legacyEndpointNames = new Set([
      "OPENAI_BASE_URL",
      "ANTHROPIC_BASE_URL",
      "GEMINI_BASE_URL",
      "FIREWORKS_BASE_URL",
      "OLLAMA_CLOUD_BASE_URL",
    ]);
    const existingVariables = (instance?.environment ?? []).filter((variable) => {
      if (variable.name === api.envName) return false;
      if (api.id === "ollama-cloud" && variable.name === "OLLAMA_CLOUD_CONFIGURED") return false;
      return providerKeyNames.has(variable.name) || !legacyEndpointNames.has(variable.name);
    });
    const environment = [...existingVariables];
    if (keyValue.length > 0) {
      environment.push({
        name: api.envName,
        value: keyValue,
        sensitive: true,
        valueRedacted: false,
      });
      if (api.id === "ollama-cloud") {
        environment.push({ name: "OLLAMA_CLOUD_CONFIGURED", value: "true", sensitive: false });
      }
    }

    const nextInstance: ProviderInstanceConfig = {
      driver: AXLE_DRIVER,
      displayName: "OpenAI",
      enabled: true,
      environment,
      config: instance?.config ?? { binaryPath: "" },
    };
    updateSettings({
      providerInstances: {
        ...settings.providerInstances,
        [AXLE_INSTANCE_ID]: nextInstance,
      },
    });
    setDrafts((current) => ({ ...current, [api.envName]: "" }));
    refreshAfterCredentialsChange();
  };

  // Writes any provider environment variable, used for the optional base URL
  // that points a provider at a custom or self-hosted gateway. Unlike a key,
  // a base URL is not a secret, so it is stored unsensitive.
  const commitProviderVariable = (name: string, value: string) => {
    const environment = (instance?.environment ?? []).filter((variable) => variable.name !== name);
    if (value.length > 0) {
      environment.push({ name, value, sensitive: false });
    }
    const nextInstance: ProviderInstanceConfig = {
      driver: AXLE_DRIVER,
      displayName: instance?.displayName ?? "OpenAI",
      enabled: true,
      environment,
      config: instance?.config ?? { binaryPath: "" },
    };
    updateSettings({
      providerInstances: {
        ...settings.providerInstances,
        [AXLE_INSTANCE_ID]: nextInstance,
      },
    });
    setDrafts((current) => ({ ...current, [name]: "" }));
    refreshAfterCredentialsChange();
  };

  // A user-added provider is written as `<PREFIX>_BASE_URL`, `<PREFIX>_API_KEY`,
  // and `<PREFIX>_LABEL`. Writing the whole triple at once keeps the three
  // variables in sync, and empty values remove the provider outright.
  const writeCustomProvider = (
    envPrefix: string,
    next: {
      readonly label: string;
      readonly baseUrl: string;
      readonly apiKey: string;
      readonly headers?: ReadonlyArray<readonly [string, string]>;
    },
  ) => {
    const owned = new Set([
      `${envPrefix}_BASE_URL`,
      `${envPrefix}_API_KEY`,
      `${envPrefix}_LABEL`,
      providerHeadersVariable(envPrefix),
    ]);
    const environment = (instance?.environment ?? []).filter(
      (variable) => !owned.has(variable.name),
    );
    if (next.baseUrl.length > 0) {
      environment.push({ name: `${envPrefix}_BASE_URL`, value: next.baseUrl, sensitive: false });
      environment.push({ name: `${envPrefix}_LABEL`, value: next.label, sensitive: false });
      const headers = next.headers ?? [];
      if (headers.length > 0) {
        environment.push({
          name: providerHeadersVariable(envPrefix),
          value: serializeProviderHeaders(headers),
          sensitive: false,
        });
      }
      if (next.apiKey.length > 0) {
        environment.push({
          name: `${envPrefix}_API_KEY`,
          value: next.apiKey,
          sensitive: true,
          valueRedacted: false,
        });
      }
    }
    updateSettings({
      providerInstances: {
        ...settings.providerInstances,
        [AXLE_INSTANCE_ID]: {
          driver: AXLE_DRIVER,
          displayName: instance?.displayName ?? "OpenAI",
          enabled: true,
          environment,
          config: instance?.config ?? { binaryPath: "" },
        },
      },
    });
    refreshAfterCredentialsChange();
  };

  const addCustomProvider = () => {
    const baseUrl = customProviderDraft.baseUrl.trim();
    // A base URL the catalogue knows names itself, so pasting one is enough.
    const preset = resolveProviderPreset(baseUrl);
    const label = customProviderDraft.name.trim() || preset?.label || "";
    const envPrefix = customProviderEnvPrefix(label);
    if (envPrefix.length === 0) {
      setCustomProviderError("Enter a provider name.");
      return;
    }
    if (RESERVED_ENV_PREFIXES.has(envPrefix)) {
      setCustomProviderError(`"${envPrefix}" belongs to a built-in provider. Choose another name.`);
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      setCustomProviderError(
        "Enter a full base URL, for example https://integrate.api.nvidia.com/v1.",
      );
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      setCustomProviderError("The base URL must start with http:// or https://.");
      return;
    }
    const apiKey = customProviderDraft.apiKey.trim();
    if (apiKey.length === 0 && !isLocalhostProviderUrl(baseUrl)) {
      setCustomProviderError("Enter an API key. Only a localhost server can run without one.");
      return;
    }
    // Writing the detected headers keeps what the settings show in step with
    // what the request carries, and gives the user something to edit.
    writeCustomProvider(envPrefix, {
      label,
      baseUrl,
      apiKey,
      headers: providerPresetHeaders(preset),
    });
    setCustomProviderDraft({ name: "", baseUrl: "", apiKey: "" });
    setCustomProviderError(null);
  };

  return (
    <SettingsPageContainer
      title="Providers"
      description="Axle is included. Connect your own providers to bring their models into the picker."
    >
      <AxleOfflineSettings
        onModelsChanged={() => {
          void refreshAxleProvider().catch(() => {});
        }}
      />

      <SettingsSection title="Provider configuration">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-5 py-4 text-[13px] font-medium text-foreground outline-none transition-colors hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <span className="space-y-1">
              <span className="block">Model APIs and credentials</span>
              <span className="block text-xs font-normal text-muted-foreground">
                Manage API keys and your ChatGPT connection.
              </span>
            </span>
            <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t border-border/60">
            {MODEL_APIS.map((api) => {
              const { id, name, envName, baseUrlEnvName, placeholder, description, Logo } = api;
              const stored = variables.get(envName);
              const configured = stored?.valueRedacted === true || Boolean(stored?.value);
              const draft = drafts[envName] ?? "";
              const baseUrlDraft = baseUrlEnvName ? (drafts[baseUrlEnvName] ?? "") : "";
              const configuredBaseUrl = Boolean(
                baseUrlEnvName ? variables.get(baseUrlEnvName)?.value : undefined,
              );
              return (
                <div key={id} className="border-t border-border/60 px-5 py-4 first:border-t-0">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-background/70 shadow-sm/4">
                        <Logo className="size-5 grayscale" aria-hidden />
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-[13px] font-semibold text-foreground">{name}</h3>
                          {configured ? (
                            <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground">
                              <CheckCircle2Icon className="size-3" /> Configured
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground/80">
                          {description}
                        </p>
                        {id === "openai" ? (
                          <div className="mt-2">
                            <button
                              type="button"
                              className="inline-flex min-h-7 items-center gap-1.5 rounded-sm text-xs text-foreground underline-offset-4 outline-none transition-colors hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                              disabled={codexAuthBusy}
                              onClick={() =>
                                void updateCodexAuthentication(
                                  codexAuth?.planUsageAuthorized ? "logout" : "login",
                                )
                              }
                            >
                              {codexAuthBusy ? (
                                <LoaderCircleIcon className="size-3 animate-spin" />
                              ) : codexAuth?.planUsageAuthorized ? (
                                <CheckCircle2Icon className="size-3 text-foreground" />
                              ) : null}
                              {codexAuth?.authenticated && codexAuth.planUsageAuthorized
                                ? "Disconnect ChatGPT plan"
                                : codexAuthBusy
                                  ? "Signing in to ChatGPT…"
                                  : "Use your ChatGPT plan"}
                            </button>
                            {codexAuth?.planUsageAuthorized ? (
                              <a
                                href="https://chatgpt.com/#settings/usage"
                                target="_blank"
                                rel="noreferrer"
                                className="ml-2 text-xs text-muted-foreground/60 underline-offset-2 hover:text-muted-foreground hover:underline"
                              >
                                Manage usage
                              </a>
                            ) : null}
                            {codexAuth?.authenticated && !codexAuth.planUsageAuthorized ? (
                              <button
                                type="button"
                                className="ml-2 text-xs text-muted-foreground/60 underline-offset-2 hover:text-muted-foreground hover:underline disabled:opacity-50"
                                disabled={codexAuthBusy}
                                onClick={() => void updateCodexAuthentication("logout")}
                              >
                                Disconnect
                              </button>
                            ) : null}
                            <p className="mt-1 text-xs text-muted-foreground/65">
                              {codexAuth?.authenticated && !codexAuth.planUsageAuthorized
                                ? "Signed in, but ChatGPT plan usage permission was not granted."
                                : "Uses eligible OpenAI Responses API requests from your ChatGPT plan."}
                            </p>
                            {codexAuthError ? (
                              <p role="alert" className="mt-1 text-xs text-destructive">
                                {codexAuthError}
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex w-full min-w-0 flex-col gap-2 lg:max-w-md lg:flex-1">
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <input
                          type="password"
                          value={draft}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder={configured ? "Enter a replacement key" : placeholder}
                          aria-label={`${name} API key`}
                          onChange={(event) =>
                            setDrafts((current) => ({ ...current, [envName]: event.target.value }))
                          }
                          className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background/70 px-3 text-sm outline-none shadow-sm/4 transition-colors placeholder:text-muted-foreground/50 focus:border-ring focus:ring-2 focus:ring-ring/20"
                        />
                        <Button
                          type="button"
                          size="sm"
                          className="h-9 shrink-0 gap-1.5"
                          disabled={draft.trim().length === 0}
                          onClick={() => commitProviderKey(api, draft.trim())}
                        >
                          <SaveIcon className="size-3.5" /> Save key
                        </Button>
                        {configured ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-9 shrink-0 gap-1.5 text-destructive hover:text-destructive"
                            onClick={() => commitProviderKey(api, "")}
                          >
                            <Trash2Icon className="size-3.5" /> Remove
                          </Button>
                        ) : null}
                      </div>
                      {baseUrlEnvName ? (
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <input
                            type="text"
                            value={baseUrlDraft}
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={
                              configuredBaseUrl
                                ? "Replace the current base URL"
                                : "https://your-gateway.example/v1"
                            }
                            aria-label={`${name} base URL`}
                            onChange={(event) =>
                              setDrafts((current) => ({
                                ...current,
                                [baseUrlEnvName]: event.target.value,
                              }))
                            }
                            className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background/70 px-3 text-sm outline-none shadow-sm/4 transition-colors placeholder:text-muted-foreground/50 focus:border-ring focus:ring-2 focus:ring-ring/20"
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-9 shrink-0 gap-1.5"
                            disabled={baseUrlDraft.trim().length === 0}
                            onClick={() =>
                              commitProviderVariable(baseUrlEnvName, baseUrlDraft.trim())
                            }
                          >
                            <SaveIcon className="size-3.5" /> Save URL
                          </Button>
                          {configuredBaseUrl ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-9 shrink-0 gap-1.5"
                              onClick={() => commitProviderVariable(baseUrlEnvName, "")}
                            >
                              Reset
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      </SettingsSection>

      <SettingsSection
        title="Custom providers"
        headerAction={
          customProviders.length > 0 ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {customProviders.length} added
            </span>
          ) : null
        }
      >
        <div className="space-y-4 px-4 py-4 sm:px-5">
          <p className="text-xs leading-5 text-muted-foreground">
            Bring your own OpenAI-compatible endpoint. Paste its base URL and API key, and Axle
            checks the endpoint before listing its models above, so you can switch between any of
            them.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              type="text"
              value={customProviderDraft.name}
              autoComplete="off"
              spellCheck={false}
              placeholder="Provider name, e.g. NVIDIA NIM"
              aria-label="Custom provider name"
              onChange={(event) =>
                setCustomProviderDraft((current) => ({ ...current, name: event.target.value }))
              }
              className="h-9 min-w-0 rounded-lg border border-input bg-background/70 px-3 text-sm outline-none shadow-sm/4 transition-colors placeholder:text-muted-foreground/50 focus:border-ring focus:ring-2 focus:ring-ring/20"
            />
            <input
              type="password"
              value={customProviderDraft.apiKey}
              autoComplete="off"
              spellCheck={false}
              placeholder="API key"
              aria-label="Custom provider API key"
              onChange={(event) =>
                setCustomProviderDraft((current) => ({ ...current, apiKey: event.target.value }))
              }
              className="h-9 min-w-0 rounded-lg border border-input bg-background/70 px-3 text-sm outline-none shadow-sm/4 transition-colors placeholder:text-muted-foreground/50 focus:border-ring focus:ring-2 focus:ring-ring/20"
            />
            <input
              type="text"
              value={customProviderDraft.baseUrl}
              autoComplete="off"
              spellCheck={false}
              placeholder="Base URL, e.g. https://integrate.api.nvidia.com/v1"
              aria-label="Custom provider base URL"
              onChange={(event) =>
                setCustomProviderDraft((current) => ({ ...current, baseUrl: event.target.value }))
              }
              className="h-9 min-w-0 rounded-lg border border-input bg-background/70 px-3 text-sm outline-none shadow-sm/4 transition-colors placeholder:text-muted-foreground/50 focus:border-ring focus:ring-2 focus:ring-ring/20 sm:col-span-2"
            />
          </div>
          {customProviderDraftPreset ? (
            <p role="status" className="text-xs leading-5 text-muted-foreground">
              Detected{" "}
              <span className="font-medium text-foreground">{customProviderDraftPreset.label}</span>
              {customProviderDraftHeaders.length > 0
                ? `. This endpoint requires ${customProviderDraftHeaders
                    .map(([name]) => name)
                    .join(", ")}, which Axle sends for you.`
                : "."}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="sm"
              className="h-9 shrink-0 gap-1.5"
              disabled={!clientSettingsHydrated}
              onClick={addCustomProvider}
            >
              <PlusIcon className="size-3.5" /> Add provider
            </Button>
            {customProviderError ? (
              <p role="alert" className="text-xs text-destructive">
                {customProviderError}
              </p>
            ) : null}
          </div>
        </div>
        {customProviders.length > 0 ? (
          <div className="border-t border-border/70">
            {customProviders.map((provider) => (
              <div
                key={provider.envPrefix}
                className="flex flex-col gap-3 border-b border-border/60 px-5 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[13px] font-semibold text-foreground">{provider.label}</h3>
                    {provider.hasKey ? (
                      <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground">
                        <CheckCircle2Icon className="size-3" /> Key saved
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{provider.baseUrl}</p>
                  {provider.headers.length > 0 ? (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground/80">
                      Sends {provider.headers.map(([name]) => name).join(", ")}
                    </p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-9 shrink-0 gap-1.5 text-destructive hover:text-destructive"
                  disabled={!clientSettingsHydrated}
                  onClick={() =>
                    writeCustomProvider(provider.envPrefix, {
                      label: "",
                      baseUrl: "",
                      apiKey: "",
                    })
                  }
                >
                  <Trash2Icon className="size-3.5" /> Remove
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Model visibility"
        icon={<BoxesIcon className="size-3.5" />}
        headerAction={
          <span className="text-xs tabular-nums text-muted-foreground">
            {searchableModels.length} models
          </span>
        }
      >
        <div className="space-y-3 px-4 py-4 sm:px-5">
          <p className="text-xs leading-5 text-muted-foreground">
            Enabled models appear in the model picker. Your selection is saved automatically.
          </p>
          <label className="flex h-9 items-center gap-2.5 rounded-lg border border-input bg-background px-3 transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
            <SearchIcon className="size-4 shrink-0 text-muted-foreground/65" aria-hidden />
            <input
              type="search"
              value={modelQuery}
              onChange={(event) => setModelQuery(event.target.value)}
              placeholder="Search models…"
              aria-label="Search models"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
        </div>

        <div className="max-h-[28rem] overflow-y-auto overscroll-contain rounded-b-xl border-t border-border/70">
          {searchableModels.length === 0 ? (
            <div
              role="status"
              className="space-y-1 px-5 py-8 text-center text-sm text-muted-foreground"
            >
              {providerEntries.length === 0
                ? "Connect a provider to make its models available."
                : "No models match your search."}
            </div>
          ) : (
            searchableModels.map(({ entry, model }) => {
              const preferences = modelPreferences[entry.instanceId] ?? {
                hiddenModels: [],
                modelOrder: [],
              };
              const enabled = !preferences.hiddenModels.includes(model.slug);
              const providerPresentation = getModelProviderPresentation(model);
              const ModelProviderIcon = providerPresentation?.Icon ?? AxleIcon;
              const modelDisplayName = getDisplayModelName(model, { preferShortName: true });
              const providerDisplayName = providerPresentation?.label ?? entry.displayName;
              return (
                <div
                  key={`${entry.instanceId}:${model.slug}`}
                  data-model-enabled={enabled ? "true" : "false"}
                  className="group flex items-center justify-between gap-4 border-b border-border/60 px-5 py-3 transition-colors last:border-b-0 hover:bg-muted/30 data-[model-enabled=false]:bg-muted/15"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/70"
                      title={providerDisplayName}
                    >
                      <ModelProviderIcon className="size-4 grayscale" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium text-foreground">
                        {modelDisplayName}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {providerDisplayName}
                      </div>
                    </div>
                  </div>
                  <Switch
                    checked={enabled}
                    disabled={!clientSettingsHydrated}
                    className="shrink-0"
                    onCheckedChange={(checked) =>
                      setModelEnabled(entry.instanceId, model.slug, Boolean(checked))
                    }
                    aria-label={`${modelDisplayName} in model picker`}
                  />
                </div>
              );
            })
          )}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
