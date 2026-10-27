// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetchInEffect:off
import Mime from "@effect/platform-node/Mime";
import * as NodeChildProcess from "node:child_process";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  LOCAL_MODEL_PACK_IDS,
  ProviderInstanceId,
  type LocalModelPackId,
} from "@axle/contracts";
import { decodeOtlpTraceRecords } from "@axle/shared/observability";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { cast } from "effect/Function";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { OtlpTracer } from "effect/unstable/observability";

import * as ServerConfig from "./config.ts";
import * as ServerSettings from "./serverSettings.ts";
import { ASSET_ROUTE_PREFIX, resolveAsset } from "./assets/AssetAccess.ts";
import { AXLE_HOSTED_BASE_URL } from "./provider/Drivers/AxleModelCatalog.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { traceRelayRequest } from "./cloud/traceRelayRequest.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentScopeRequired,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
} from "./auth/http.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from "./httpCors.ts";
import { localModelManager } from "./localModels/manager.ts";

const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const DESKTOP_RENDERER_ORIGINS = [
  "t3code://app",
  "t3code-dev://app",
  "axle://app",
  "axle-dev://app",
];
const AXLE_CODEX_AUTH_ROUTE = "/api/axle/codex-auth";
const CODEX_AUTH_STATUS_TIMEOUT_MS = 20_000;
const CODEX_AUTH_LOGIN_TIMEOUT_MS = 15 * 60_000;

export const browserApiCorsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const devOrigin = config.devUrl?.origin;
    // Dev uses credentialed requests from Vite or the Electron custom origin, so both must be
    // explicit. Packaged desktop omits credentials and uses Effect's default wildcard origin.
    return HttpRouter.cors({
      ...(devOrigin
        ? { allowedOrigins: [devOrigin, ...DESKTOP_RENDERER_ORIGINS], credentials: true }
        : {}),
      allowedMethods: browserApiCorsAllowedMethods,
      allowedHeaders: browserApiCorsAllowedHeaders,
      maxAge: 600,
    });
  }),
);

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const authenticateRawRouteWithScope = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  });

type AxleCodexAuthStatus = {
  readonly authenticated: boolean;
  readonly subject?: string | null;
  readonly expires?: number | null;
  readonly planUsageAuthorized: boolean;
};

class AxleCodexAuthCommandError extends Data.TaggedError("AxleCodexAuthCommandError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

const runAxleCodexAuthCommand = (argument: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<AxleCodexAuthStatus>((resolve, reject) => {
        const binaryPath = process.env.AXLE_BINARY_PATH?.trim() || "axle";
        const child = NodeChildProcess.spawn(binaryPath, [argument], {
          env: process.env,
          windowsHide: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timeout: ReturnType<typeof setTimeout>;
        const timeoutMs =
          argument === "--codex-login" ? CODEX_AUTH_LOGIN_TIMEOUT_MS : CODEX_AUTH_STATUS_TIMEOUT_MS;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          callback();
        };
        timeout = setTimeout(() => {
          child.kill();
          finish(() => reject(new Error("ChatGPT authentication service timed out.")));
        }, timeoutMs);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("error", (error) => finish(() => reject(error)));
        child.once("close", (code) => {
          finish(() => {
            if (code !== 0) {
              reject(
                new AxleCodexAuthCommandError({
                  detail: stderr.trim() || `Axle exited with code ${code ?? "unknown"}.`,
                }),
              );
              return;
            }
            try {
              resolve(JSON.parse(stdout.trim()) as AxleCodexAuthStatus);
            } catch (cause) {
              reject(
                new AxleCodexAuthCommandError({
                  detail: "Axle returned invalid ChatGPT authentication status.",
                  cause,
                }),
              );
            }
          });
        });
      }),
    catch: (cause) =>
      cause instanceof AxleCodexAuthCommandError
        ? cause
        : new AxleCodexAuthCommandError({
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
  });

const axleCodexAuthResponse = (argument: string) =>
  runAxleCodexAuthCommand(argument).pipe(
    Effect.map((status) => HttpServerResponse.jsonUnsafe(status)),
    Effect.catch((error) =>
      Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.detail }, { status: 500 })),
    ),
  );

export const axleCodexAuthRouteLayer = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    AXLE_CODEX_AUTH_ROUTE,
    Effect.gen(function* () {
      yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
      return yield* axleCodexAuthResponse("--codex-auth-status");
    }),
  ),
  HttpRouter.add(
    "POST",
    `${AXLE_CODEX_AUTH_ROUTE}/login`,
    Effect.gen(function* () {
      yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
      return yield* axleCodexAuthResponse("--codex-login");
    }),
  ),
  HttpRouter.add(
    "POST",
    `${AXLE_CODEX_AUTH_ROUTE}/logout`,
    Effect.gen(function* () {
      yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
      return yield* axleCodexAuthResponse("--codex-logout");
    }),
  ),
);

const AXLE_CREDITS_ROUTE = "/api/axle/credits";
const AXLE_USAGE_ROUTE = "/api/axle/usage";
const AXLE_GATEWAY_TIMEOUT_MS = 20_000;
const AXLE_USAGE_DEFAULT_LIMIT = 25;
const AXLE_USAGE_MAX_LIMIT = 100;
const AXLE_INSTANCE_ID = ProviderInstanceId.make("axle");

class AxleGatewayRequestError extends Data.TaggedError("AxleGatewayRequestError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

function axleGatewayBaseUrl(): string {
  const configured = process.env.AXLE_BASE_URL?.trim() || AXLE_HOSTED_BASE_URL;
  return configured.replace(/\/+$/u, "");
}

export function messageFromAxleGatewayBody(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string" && error.trim().length > 0) return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return fallback;
}

/** Clamps the requested activity-page size into something the gateway accepts. */
export function axleUsageLimit(raw: string | null): number {
  const parsed = raw === null || raw.trim().length === 0 ? Number.NaN : Number(raw);
  return Number.isFinite(parsed)
    ? Math.min(Math.max(Math.trunc(parsed), 1), AXLE_USAGE_MAX_LIMIT)
    : AXLE_USAGE_DEFAULT_LIMIT;
}

/** Structural slice of the settings the Axle provider reads its variables from. */
type AxleProviderSettingsView = {
  readonly providerInstances: Readonly<
    Record<
      string,
      | {
          readonly environment?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
        }
      | undefined
    >
  >;
};

function axleProviderVariable(settings: AxleProviderSettingsView, name: string): string | null {
  const variable = settings.providerInstances[AXLE_INSTANCE_ID]?.environment?.find(
    (entry) => entry.name === name,
  );
  const value = variable?.value.trim() ?? "";
  return value.length > 0 ? value : null;
}

/** The account key the Axle provider itself chats with, or null when unconnected. */
export function axleCredentialFromSettings(settings: AxleProviderSettingsView): string | null {
  return axleProviderVariable(settings, "AXLE_API_KEY");
}

/** A user-set gateway override on the provider instance, when one exists. */
export function axleBaseUrlFromSettings(settings: AxleProviderSettingsView): string | null {
  return axleProviderVariable(settings, "AXLE_BASE_URL")?.replace(/\/+$/u, "") ?? null;
}

const resolveAxleProviderSettings = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const settings = yield* settingsService.getSettings;
  return {
    apiKey: axleCredentialFromSettings(settings),
    baseUrl: axleBaseUrlFromSettings(settings),
  };
});

const requestAxleGateway = (path: string, apiKey: string, baseUrl: string | null) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${baseUrl ?? axleGatewayBaseUrl()}${path}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(AXLE_GATEWAY_TIMEOUT_MS),
      });
      const body: unknown = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, body };
    },
    catch: (cause) =>
      new AxleGatewayRequestError({
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

/**
 * Credits and recent activity as the gateway sees them, resolved server-side
 * because settings only ever carry provider secrets server-side. An app that
 * has not been connected to an Axle account reports `{ connected: false }`
 * instead of querying with the shared built-in token, which no account is
 * behind.
 */
const axleCreditsProxyResponse = (path: string) =>
  Effect.gen(function* () {
    const { apiKey, baseUrl } = yield* resolveAxleProviderSettings;
    if (apiKey === null) {
      return HttpServerResponse.jsonUnsafe({ connected: false });
    }
    const result = yield* requestAxleGateway(path, apiKey, baseUrl).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          ok: false,
          status: 502,
          body: { error: `The Axle gateway could not be reached (${error.detail}).` },
        }),
      ),
    );
    if (!result.ok) {
      return HttpServerResponse.jsonUnsafe(
        {
          connected: true,
          error: messageFromAxleGatewayBody(
            result.body,
            `The Axle gateway refused the request (HTTP ${result.status}).`,
          ),
        },
        { status: result.status },
      );
    }
    const body =
      typeof result.body === "object" && result.body !== null
        ? (result.body as Record<string, unknown>)
        : {};
    return HttpServerResponse.jsonUnsafe({ connected: true, ...body });
  }).pipe(
    Effect.orElseSucceed(() =>
      HttpServerResponse.jsonUnsafe(
        { connected: true, error: "Credits could not be loaded from the local server." },
        { status: 500 },
      ),
    ),
  );

export const axleCreditsRouteLayer = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    AXLE_CREDITS_ROUTE,
    Effect.gen(function* () {
      yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
      return yield* axleCreditsProxyResponse("/credits");
    }),
  ),
  HttpRouter.add(
    "GET",
    AXLE_USAGE_ROUTE,
    Effect.gen(function* () {
      yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      const limit = axleUsageLimit(Option.isNone(url) ? null : url.value.searchParams.get("limit"));
      return yield* axleCreditsProxyResponse(`/usage?limit=${limit}`);
    }),
  ),
);

const AXLE_LOCAL_MODELS_ROUTE = "/api/axle/local-models";

const localModelManagerFor = (config: {
  readonly modelsDir: string;
  readonly localModelsStatePath: string;
}) =>
  localModelManager({
    modelsDir: config.modelsDir,
    statePath: config.localModelsStatePath,
  });

const localModelJsonResponse = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status });

const localModelFailure = (cause: unknown, status = 500) =>
  localModelJsonResponse(
    {
      error: cause instanceof Error ? cause.message : "The local model operation failed.",
    },
    status,
  );

type LocalModelAction = {
  readonly packId: LocalModelPackId;
  readonly sourcePath?: string;
};

class LocalModelOperationError extends Data.TaggedError("LocalModelOperationError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

const localModelOperationError = (cause: unknown) =>
  new LocalModelOperationError({
    detail: cause instanceof Error ? cause.message : "The local model operation failed.",
    cause,
  });

const parseLocalModelAction = (body: unknown): LocalModelAction | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const packId = record.packId;
  if (typeof packId !== "string" || !LOCAL_MODEL_PACK_IDS.includes(packId as LocalModelPackId)) {
    return undefined;
  }
  const sourcePath = typeof record.sourcePath === "string" ? record.sourcePath.trim() : "";
  return {
    packId: packId as LocalModelPackId,
    ...(sourcePath.length > 0 ? { sourcePath } : {}),
  };
};

const readLocalModelAction = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => undefined));
    return parseLocalModelAction(body);
  });

/**
 * Install/remove/run Axle Offline packs. Model bytes never pass through the
 * renderer: the server downloads, verifies, and starts them. Launching the
 * runtime is asynchronous so a multi-minute model load cannot hold an HTTP
 * request open; the client polls GET `/api/axle/local-models`.
 */
export const axleLocalModelsRouteLayer = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    AXLE_LOCAL_MODELS_ROUTE,
    Effect.gen(function* () {
      yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
      const config = yield* ServerConfig.ServerConfig;
      const snapshot = yield* Effect.promise(() => localModelManagerFor(config).snapshot());
      return localModelJsonResponse(snapshot);
    }),
  ),
  HttpRouter.add(
    "POST",
    `${AXLE_LOCAL_MODELS_ROUTE}/install`,
    Effect.gen(function* () {
      yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const action = yield* readLocalModelAction(request);
      if (!action) return localModelFailure("A valid pack id is required.", 400);
      const config = yield* ServerConfig.ServerConfig;
      return yield* Effect.tryPromise({
        try: () => localModelManagerFor(config).startInstall(action.packId, action.sourcePath),
        catch: localModelOperationError,
      }).pipe(
        Effect.map((snapshot) => localModelJsonResponse(snapshot, 202)),
        Effect.catch((cause) => Effect.succeed(localModelFailure(cause))),
      );
    }),
  ),
  HttpRouter.add(
    "POST",
    `${AXLE_LOCAL_MODELS_ROUTE}/remove`,
    Effect.gen(function* () {
      yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const action = yield* readLocalModelAction(request);
      if (!action) return localModelFailure("A valid pack id is required.", 400);
      const config = yield* ServerConfig.ServerConfig;
      return yield* Effect.tryPromise({
        try: () => localModelManagerFor(config).remove(action.packId),
        catch: localModelOperationError,
      }).pipe(
        Effect.map((snapshot) => localModelJsonResponse(snapshot)),
        Effect.catch((cause) => Effect.succeed(localModelFailure(cause))),
      );
    }),
  ),
  HttpRouter.add(
    "POST",
    `${AXLE_LOCAL_MODELS_ROUTE}/start`,
    Effect.gen(function* () {
      yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const action = yield* readLocalModelAction(request);
      if (!action) return localModelFailure("A valid pack id is required.", 400);
      const config = yield* ServerConfig.ServerConfig;
      return yield* Effect.tryPromise({
        try: () => localModelManagerFor(config).startRuntime(action.packId),
        catch: localModelOperationError,
      }).pipe(
        Effect.map((snapshot) => localModelJsonResponse(snapshot, 202)),
        Effect.catch((cause) => Effect.succeed(localModelFailure(cause))),
      );
    }),
  ),
  HttpRouter.add(
    "POST",
    `${AXLE_LOCAL_MODELS_ROUTE}/stop`,
    Effect.gen(function* () {
      yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
      const config = yield* ServerConfig.ServerConfig;
      return yield* Effect.tryPromise({
        try: () => localModelManagerFor(config).stopRuntime(),
        catch: localModelOperationError,
      }).pipe(
        Effect.flatMap(() => Effect.promise(() => localModelManagerFor(config).snapshot())),
        Effect.map((snapshot) => localModelJsonResponse(snapshot)),
        Effect.catch((cause) => Effect.succeed(localModelFailure(cause))),
      );
    }),
  ),
);

export const serverEnvironmentHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    return handlers.handle(
      "descriptor",
      Effect.fn("environment.metadata.descriptor")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        return yield* serverEnvironment.getDescriptor;
      }, traceRelayRequest),
    );
  }),
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector.BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          bodyJson,
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: HttpBody.jsonUnsafe(bodyJson),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Trace export failed.", { status: 502 }),
        ),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const assetRouteLayer = HttpRouter.add(
  "GET",
  `${ASSET_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const suffix = url.value.pathname.slice(`${ASSET_ROUTE_PREFIX}/`.length);
    const separatorIndex = suffix.indexOf("/");
    if (separatorIndex <= 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const asset = yield* resolveAsset(
      suffix.slice(0, separatorIndex),
      suffix.slice(separatorIndex + 1),
    );
    if (!asset) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return yield* HttpServerResponse.file(asset.path, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig.ServerConfig;
    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir =
      config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
      });
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem.readFile(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
    });
  }),
);
