// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  RuntimeItemId,
  ThreadId,
  type ChatAttachment,
  type CanonicalRequestType,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ToolLifecycleItemType,
  TurnId,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type RuntimeMode,
  type ProviderWorkspaceContext,
  LOCAL_MODEL_PACK_IDS,
  type LocalModelPackId,
} from "@axle/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { getModelSelectionStringOptionValue } from "@axle/shared/model";
import { errorTag } from "@axle/shared/observability";
import {
  isCodexOAuthModel,
  normalizeCodexOAuthEffectiveContextWindowTokens,
} from "../codexContextWindow.ts";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { T3_CODE_PULL_REQUEST_REVIEW_INSTRUCTIONS } from "../CodexDeveloperInstructions.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { localModelManager } from "../../localModels/manager.ts";
import { currentAuthSessionId } from "../ProviderExecutionContext.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("axle");
const T3_MCP_BEARER_TOKEN_ENV_VAR = "T3_MCP_BEARER_TOKEN";
const HIDDEN_AXLE_CONTROL_TOOLS = new Set(["end_task"]);
const AXLE_BROWSER_INSTRUCTIONS = `Browser tools are reserved for explicit browser requests and tasks that genuinely require UI interaction or visual verification. Never use preview_* tools for ordinary public-web research, current facts, documentation, news, or URL lookup; use the web_search tool instead. If web_search can answer the request, do not open or navigate the browser. Only use preview_* when the user asks for the browser or the task requires testing an app UI, clicking through a flow, login, rendering, or client-side behavior. When browser work is allowed, the t3-code MCP tools named preview_* control the collaborative browser shared with the user. First call preview_status. If no automation-capable preview is attached, call preview_open. Then use preview_navigate, preview_snapshot, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.`;

// Stream callbacks are synchronous by contract, so publish their events with
// a small module-level runner rather than nesting Effect.runSync in the turn
// effect. This keeps callback ordering while satisfying Effect diagnostics.
function runEffectSync(effect: Effect.Effect<void>): void {
  Effect.runSync(effect);
}

export interface AxleAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly attachmentsDir: string;
  readonly environment: NodeJS.ProcessEnv;
  /** Where Axle Offline model packs are installed, if local models are enabled. */
  readonly localModelsDir?: string | undefined;
  readonly localModelsStatePath?: string | undefined;
  readonly nativeEventLogger?: EventNdjsonLogger | undefined;
  readonly getCustomInstructions?: (() => Effect.Effect<string>) | undefined;
}

export interface AxleProcessResult {
  readonly response: string;
  readonly sessionId?: string | undefined;
}

export interface AxleToolStartedEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: unknown;
}

export interface AxleToolCompletedEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: string;
  readonly isError: boolean;
  /** Wall-clock execution time reported by the Rust runtime, when present. */
  readonly durationMs?: number | undefined;
  /** True when the runtime stopped the tool because it hit a timeout limit. */
  readonly timedOut?: boolean | undefined;
}

export interface AxleToolBackgroundedEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly jobId: string;
}

export interface AxleUsageEvent {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly cumulativeTotalTokens: number;
}

export interface AxleApprovalRequestedEvent {
  readonly requestId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: unknown;
  readonly timeoutSeconds: number;
}

export interface AxleApprovalResolvedEvent {
  readonly requestId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly decision: string;
  readonly reason: string;
}

export interface AxleStreamCallbacks {
  readonly onDelta?: ((delta: string) => void) | undefined;
  readonly onSessionId?: ((sessionId: string) => void) | undefined;
  readonly onToolStarted?: ((event: AxleToolStartedEvent) => void) | undefined;
  readonly onToolBackgrounded?: ((event: AxleToolBackgroundedEvent) => void) | undefined;
  readonly onToolCompleted?: ((event: AxleToolCompletedEvent) => void) | undefined;
  /** A turn-level error frame from a persistent CLI process. */
  readonly onError?: ((message: string) => void) | undefined;
  readonly onUsage?: ((event: AxleUsageEvent) => void) | undefined;
  readonly onApprovalRequested?: ((event: AxleApprovalRequestedEvent) => void) | undefined;
  readonly onApprovalResolved?: ((event: AxleApprovalResolvedEvent) => void) | undefined;
  /** Fired as soon as the terminal JSON result frame is received. */
  readonly onResult?: ((result: AxleProcessResult) => void) | undefined;
}

export interface AxleAssistantSegmentCallbacks {
  readonly onStarted: (segmentId: string) => void;
  readonly onDelta: (segmentId: string, delta: string) => void;
  readonly onCompleted: (segmentId: string, text: string) => void;
}

// Maximum period without provider stdout/stderr activity before we kill one
// Axle process attempt. This is deliberately an inactivity timeout, not a
// total-turn timeout: slow networks and long tool calls are allowed to make
// progress without being killed merely because the turn is old.
export const AXLE_TURN_IDLE_TIMEOUT_MS = Duration.toMillis(Duration.minutes(10));
function sanitizeAxleLogDetail(value: string): string {
  return value
    .replace(
      /((?:api[_-]?key|authorization|bearer|token|password|secret)\s*[:=]\s*)([^\s,;]+)/giu,
      "$1<redacted>",
    )
    .slice(0, 1_000);
}

export function formatAxleProcessError(
  cause: unknown,
  workspaceContext: ProviderWorkspaceContext | undefined,
): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (/freeusagelimit|free usage limit/iu.test(detail)) {
    return "The selected provider model has reached its free usage limit. Select another model or try again later.";
  }
  if (/unexpected argument[\s\S]*--runtime-mode/iu.test(detail)) {
    return "The configured Axle runtime is outdated and cannot enforce the selected permission mode. Rebuild or update the Axle binary, then retry.";
  }
  if (
    workspaceContext === "none" &&
    /unexpected argument[\s\S]*--no-workspace-context/iu.test(detail)
  ) {
    return "The configured Axle runtime is outdated and does not support project-free chats. Rebuild or update the Axle binary, then retry.";
  }
  if (/content\[\]\.thinking[\s\S]*passed back|thinking[\s\S]*must be passed back/iu.test(detail)) {
    return "The provider rejected replayed reasoning from an earlier turn. Axle repaired the session history automatically; send your last message again to continue.";
  }
  if (/invalid schema for function/iu.test(detail)) {
    return "The provider rejected one of Axle's tool schemas. Update Axle to the latest build, then retry. If it persists, switch to another model for this turn.";
  }
  if (/429|rate limit|too many requests/iu.test(detail)) {
    return "The provider is rate-limiting requests. Axle retried automatically; wait a few seconds and send the message again.";
  }
  if (
    /http 5\d\d|internal server error|bad gateway|service unavailable|gateway timeout/iu.test(
      detail,
    )
  ) {
    return "The provider had a temporary server error and Axle's automatic retries were exhausted. Try again in a few seconds.";
  }
  return detail;
}

export function isHiddenAxleControlTool(toolName: string): boolean {
  return HIDDEN_AXLE_CONTROL_TOOLS.has(toolName);
}

export function axleChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...environment };
  // Search is a native tool, not a plugin, and requires no per-user
  // credential. Remove any legacy/static search credentials from the child.
  delete next.AXLE_SEARCH_WORKER_AUTH_TOKEN;
  delete next.AXLE_SEARCH_WORKER_TOKEN;
  delete next.SEARCH_WORKER_TOKEN;
  delete next.AXLE_SEARCH_WORKER_SESSION_TOKEN;
  // Legacy OpenCode gateway credentials are no longer supported. Do not pass
  // them from persisted settings into the runtime.
  delete next.OPENCODE_API_KEY;
  delete next.OPENCODE_BASE_URL;
  return next;
}

interface SessionState {
  session: ProviderSession;
  /** Internal process/session home; never exposed as ProviderSession.cwd. */
  runtimeCwd: string;
  snapshot: ProviderThreadSnapshot;
  nextTurn: number;
}

type AxleChildProcess = ReturnType<typeof NodeChildProcess.spawn>;
type AxlePipedChildProcess = NodeChildProcess.ChildProcessByStdio<Writable, Readable, Readable>;

interface PendingPersistentTurn {
  readonly decoder: ReturnType<typeof makeAxleStreamDecoder>;
  readonly resolve: (result: AxleProcessResult) => void;
  readonly reject: (cause: unknown) => void;
  readonly childKey: string;
  fail?: ((cause: unknown) => void) | undefined;
}

interface PersistentAxleProcess {
  readonly child: AxlePipedChildProcess;
  readonly signature: string;
  stderr: string;
  pending?: PendingPersistentTurn | undefined;
}

export function makeAxleStreamDecoder(callbacks: AxleStreamCallbacks = {}) {
  let stdoutBuffer = "";
  let result: AxleProcessResult | undefined;
  let protocolError: Error | undefined;
  const activeTools = new Map<string, { readonly toolName: string }>();
  const backgroundTools = new Map<string, { readonly toolName: string; readonly jobId: string }>();
  const pendingApprovals = new Map<
    string,
    { readonly toolCallId: string; readonly toolName: string }
  >();

  const failOpenTools = (reason: string) => {
    for (const [toolCallId, tool] of [...activeTools, ...backgroundTools]) {
      callbacks.onToolCompleted?.({
        toolCallId,
        toolName: tool.toolName,
        output: reason,
        isError: true,
      });
    }
    activeTools.clear();
    backgroundTools.clear();
  };

  const failOpenApprovals = (reason: string) => {
    for (const [requestId, approval] of pendingApprovals) {
      callbacks.onApprovalResolved?.({
        requestId,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName,
        decision: "deny",
        reason,
      });
    }
    pendingApprovals.clear();
  };

  const failOpenWork = (reason: string) => {
    failOpenTools(reason);
    failOpenApprovals(reason);
  };

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const event = JSON.parse(trimmed) as {
        type?: unknown;
        delta?: unknown;
        response?: unknown;
        message?: unknown;
        sessionId?: unknown;
        toolCallId?: unknown;
        toolName?: unknown;
        jobId?: unknown;
        arguments?: unknown;
        output?: unknown;
        isError?: unknown;
        durationMs?: unknown;
        timedOut?: unknown;
        requestId?: unknown;
        decision?: unknown;
        reason?: unknown;
        timeoutSeconds?: unknown;
        promptTokens?: unknown;
        completionTokens?: unknown;
        totalTokens?: unknown;
        cumulativeTotalTokens?: unknown;
      };
      const setProtocolError = (message: string) => {
        protocolError ??= new Error(message);
      };
      if (event.type === "delta") {
        if (typeof event.delta !== "string") {
          setProtocolError("Axle returned a malformed text delta event.");
          return;
        }
        callbacks.onDelta?.(event.delta);
        return;
      }
      if (event.type === "thinking_delta") {
        if (typeof event.delta !== "string") {
          setProtocolError("Axle returned a malformed thinking delta event.");
        }
        return;
      }
      if (event.type === "session") {
        if (typeof event.sessionId !== "string") {
          setProtocolError("Axle returned a malformed session event.");
          return;
        }
        callbacks.onSessionId?.(event.sessionId);
        return;
      }
      if (event.type === "tool.started") {
        if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") {
          setProtocolError("Axle returned a malformed tool.started event.");
          return;
        }
        activeTools.set(event.toolCallId, { toolName: event.toolName });
        callbacks.onToolStarted?.({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          arguments: event.arguments,
        });
        return;
      }
      if (event.type === "tool.backgrounded") {
        if (
          typeof event.toolCallId !== "string" ||
          typeof event.toolName !== "string" ||
          typeof event.jobId !== "string"
        ) {
          setProtocolError("Axle returned a malformed tool.backgrounded event.");
          return;
        }
        const activeTool = activeTools.get(event.toolCallId);
        if (!activeTool || activeTool.toolName !== event.toolName) {
          setProtocolError("Axle backgrounded a tool that was not active.");
          return;
        }
        activeTools.delete(event.toolCallId);
        backgroundTools.set(event.toolCallId, {
          toolName: event.toolName,
          jobId: event.jobId,
        });
        callbacks.onToolBackgrounded?.({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          jobId: event.jobId,
        });
        return;
      }
      if (event.type === "usage") {
        if (
          typeof event.promptTokens !== "number" ||
          typeof event.completionTokens !== "number" ||
          typeof event.totalTokens !== "number" ||
          typeof event.cumulativeTotalTokens !== "number"
        ) {
          setProtocolError("Axle returned a malformed usage event.");
          return;
        }
        callbacks.onUsage?.({
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens,
          totalTokens: event.totalTokens,
          cumulativeTotalTokens: event.cumulativeTotalTokens,
        });
        return;
      }
      if (event.type === "tool.completed") {
        if (
          typeof event.toolCallId !== "string" ||
          typeof event.toolName !== "string" ||
          typeof event.output !== "string" ||
          typeof event.isError !== "boolean" ||
          (event.durationMs !== undefined && typeof event.durationMs !== "number") ||
          (event.timedOut !== undefined && typeof event.timedOut !== "boolean")
        ) {
          setProtocolError("Axle returned a malformed tool.completed event.");
          return;
        }
        activeTools.delete(event.toolCallId);
        backgroundTools.delete(event.toolCallId);
        callbacks.onToolCompleted?.({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output: event.output,
          isError: event.isError,
          ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
          ...(typeof event.timedOut === "boolean" ? { timedOut: event.timedOut } : {}),
        });
        return;
      }
      if (event.type === "error") {
        if (typeof event.message !== "string") {
          setProtocolError("Axle returned a malformed error event.");
          return;
        }
        if (typeof event.sessionId === "string") callbacks.onSessionId?.(event.sessionId);
        failOpenTools(event.message);
        callbacks.onError?.(event.message);
        return;
      }
      if (event.type === "approval.requested") {
        if (
          typeof event.requestId !== "string" ||
          typeof event.toolCallId !== "string" ||
          typeof event.toolName !== "string" ||
          typeof event.timeoutSeconds !== "number"
        ) {
          setProtocolError("Axle returned a malformed approval.requested event.");
          return;
        }
        pendingApprovals.set(event.requestId, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        });
        callbacks.onApprovalRequested?.({
          requestId: event.requestId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          arguments: event.arguments,
          timeoutSeconds: event.timeoutSeconds,
        });
        return;
      }
      if (event.type === "approval.resolved") {
        if (
          typeof event.requestId !== "string" ||
          typeof event.toolCallId !== "string" ||
          typeof event.toolName !== "string" ||
          typeof event.decision !== "string" ||
          typeof event.reason !== "string"
        ) {
          setProtocolError("Axle returned a malformed approval.resolved event.");
          return;
        }
        pendingApprovals.delete(event.requestId);
        callbacks.onApprovalResolved?.({
          requestId: event.requestId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          decision: event.decision,
          reason: event.reason,
        });
        return;
      }
      if (event.type === "result") {
        if (typeof event.response !== "string") {
          setProtocolError("Axle returned a malformed result event.");
          return;
        }
        result = {
          response: event.response,
          ...(typeof event.sessionId === "string" ? { sessionId: event.sessionId } : {}),
        };
        callbacks.onResult?.(result);
        return;
      }
      setProtocolError(`Axle returned an unknown streaming event '${String(event.type)}'.`);
    } catch (cause) {
      protocolError ??= new Error("Axle returned an invalid streaming event.", { cause });
    }
  };

  return {
    hasOpenTools(): boolean {
      return activeTools.size > 0 || backgroundTools.size > 0;
    },
    hasPendingApprovals(): boolean {
      return pendingApprovals.size > 0;
    },
    push(chunk: string): void {
      stdoutBuffer += chunk;
      let lineEnd = stdoutBuffer.indexOf("\n");
      while (lineEnd >= 0) {
        const line = stdoutBuffer.slice(0, lineEnd);
        stdoutBuffer = stdoutBuffer.slice(lineEnd + 1);
        processLine(line);
        // A result frame is terminal. Do not let data after it be interpreted
        // as another part of the completed turn while the child is shutting
        // down.
        if (result) {
          stdoutBuffer = "";
          break;
        }
        lineEnd = stdoutBuffer.indexOf("\n");
      }
    },
    failOpenTools,
    failOpenApprovals,
    failOpenWork,
    finish(): AxleProcessResult {
      // Clear the pending buffer before parsing it. `onResult` is allowed to
      // call finish synchronously, so leaving the same line in the buffer
      // would parse the terminal result recursively.
      if (!result && stdoutBuffer.trim().length > 0) {
        const pending = stdoutBuffer;
        stdoutBuffer = "";
        processLine(pending);
      }
      if (protocolError) {
        failOpenWork(protocolError.message);
        throw protocolError;
      }
      if (!result || result.response.trim().length === 0) {
        failOpenTools("Axle ended before this tool returned a result.");
        failOpenApprovals("Axle ended before this approval was resolved.");
        throw new Error("Axle returned an empty streaming result.");
      }
      if (activeTools.size > 0) {
        const error = new Error("Axle ended before this tool returned a result.");
        protocolError ??= error;
        failOpenWork(error.message);
        throw protocolError;
      }
      failOpenApprovals("Axle ended before this approval was resolved.");
      return result;
    },
  };
}

export function makeAxleAssistantSegmenter(
  callbacks: AxleAssistantSegmentCallbacks,
  makeSegmentId: () => string = NodeCrypto.randomUUID,
) {
  let activeSegment: { readonly id: string; text: string } | undefined;
  let sawText = false;

  const closeActiveSegment = () => {
    if (!activeSegment) return;
    callbacks.onCompleted(activeSegment.id, activeSegment.text);
    activeSegment = undefined;
  };

  const pushDelta = (delta: string) => {
    if (delta.length === 0) return;
    if (!activeSegment) {
      activeSegment = { id: makeSegmentId(), text: "" };
      callbacks.onStarted(activeSegment.id);
    }
    activeSegment.text += delta;
    sawText = true;
    callbacks.onDelta(activeSegment.id, delta);
  };

  return {
    pushDelta,
    closeBeforeTool: closeActiveSegment,
    finish(fallbackText: string): void {
      if (activeSegment) {
        closeActiveSegment();
        return;
      }
      if (!sawText && fallbackText.length > 0) {
        pushDelta(fallbackText);
        closeActiveSegment();
      }
    },
  };
}

function humanizeAxleToolName(toolName: string): string {
  const words = toolName
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[._:-]+/u)
    .map((word) => word.trim())
    .filter(Boolean);
  return words.length > 0
    ? words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(" ")
    : "Tool";
}

export function axleToolPresentation(
  toolName: string,
  argumentsValue: unknown,
): {
  readonly itemType: ToolLifecycleItemType;
  readonly title: string;
  readonly data: Record<string, unknown>;
} {
  const normalizedName = toolName.trim().toLowerCase();
  const rawInput =
    argumentsValue !== null && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
      ? (argumentsValue as Record<string, unknown>)
      : {};
  const pluginId =
    normalizedName === "axle_plugin_call" &&
    typeof rawInput.pluginId === "string" &&
    rawInput.pluginId.trim().length > 0
      ? rawInput.pluginId.trim().toLowerCase()
      : undefined;
  const isBrowserTool = normalizedName.startsWith("preview_");
  const isMcpTool = isBrowserTool || normalizedName === "getpullrequestcomments";
  const itemType: ToolLifecycleItemType =
    normalizedName === "bash" || normalizedName === "bash_monitor"
      ? "command_execution"
      : normalizedName === "write" || normalizedName === "edit"
        ? "file_change"
        : normalizedName === "web_search"
          ? "web_search"
          : isMcpTool
            ? "mcp_tool_call"
            : "dynamic_tool_call";
  const kind =
    normalizedName === "bash" || normalizedName === "bash_monitor"
      ? "execute"
      : normalizedName === "grep" || normalizedName === "find"
        ? "search"
        : normalizedName;
  const titleByName: Record<string, string> = {
    ask_user: "Ask user",
    bash: "Terminal",
    bash_monitor: "Monitor command",
    edit: "Edit file",
    find: "Find",
    grep: "Grep",
    ls: "List files",
    memory_add: "Save memory",
    memory_delete: "Forget memory",
    memory_search: "Search memory",
    memory_update: "Update memory",
    read: "Read file",
    web_search: "Search the web",
    update_plan: "Update plan",
    write: "Write file",
    preview_status: "Get browser status",
    preview_open: "Open browser",
    preview_navigate: "Navigate browser",
    preview_resize: "Resize browser",
    preview_snapshot: "Inspect browser page",
    preview_click: "Click browser",
    preview_type: "Type in browser",
    preview_press: "Press key in browser",
    preview_scroll: "Scroll browser",
    preview_evaluate: "Evaluate browser JavaScript",
    preview_wait_for: "Wait for browser",
    preview_recording_start: "Start browser recording",
    preview_recording_stop: "Stop browser recording",
    getpullrequestcomments: "Get pull request comments",
  };
  return {
    itemType,
    title: titleByName[normalizedName] ?? humanizeAxleToolName(toolName),
    data: {
      kind,
      toolName,
      rawInput,
      ...(pluginId ? { pluginId } : {}),
      ...(typeof rawInput.command === "string" ? { command: rawInput.command } : {}),
    },
  };
}

/**
 * Map a gated Axle tool onto the canonical request types the orchestration
 * layer turns into approval activities. Command and file-change approvals get
 * their dedicated UI treatment; every other gated tool (for example an MCP
 * tool) is a dynamic tool call.
 */
export function axleApprovalRequestType(toolName: string): CanonicalRequestType {
  const normalizedName = toolName.trim().toLowerCase();
  if (normalizedName === "bash") return "command_execution_approval";
  if (normalizedName === "write" || normalizedName === "edit") return "apply_patch_approval";
  return "dynamic_tool_call";
}

const AXLE_APPROVAL_DETAIL_MAX_CHARS = 240;

/** Human-readable one-liner shown with the pending approval request. */
export function axleApprovalDetail(toolName: string, argumentsValue: unknown): string {
  const presentation = axleToolPresentation(toolName, argumentsValue);
  const rawInput =
    argumentsValue !== null && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
      ? (argumentsValue as Record<string, unknown>)
      : {};
  const subject =
    typeof rawInput.command === "string" && rawInput.command.trim().length > 0
      ? rawInput.command.trim()
      : typeof rawInput.path === "string" && rawInput.path.trim().length > 0
        ? rawInput.path.trim()
        : undefined;
  const detail = subject
    ? `${presentation.title}: ${subject}`
    : `${presentation.title} requires approval`;
  return detail.length > AXLE_APPROVAL_DETAIL_MAX_CHARS
    ? `${detail.slice(0, AXLE_APPROVAL_DETAIL_MAX_CHARS - 1)}…`
    : detail;
}

/** Translate a runtime approval verdict (allow/deny) into contract decisions. */
export function axleApprovalDecision(runtimeDecision: string): ProviderApprovalDecision {
  return runtimeDecision === "allow" ? "accept" : "decline";
}

export function parseAxleModelSelection(model: string | undefined): {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl?: string | undefined;
} {
  const selected = model?.trim() || "GPT-5.6 Sol";
  const slash = selected.indexOf("/");
  if (slash <= 0 || slash === selected.length - 1) {
    return { provider: "openai", model: selected };
  }
  const provider = selected.slice(0, slash);
  const modelId = selected.slice(slash + 1);
  if (provider === "google") {
    return { provider: "gemini", model: modelId };
  }
  return { provider, model: modelId };
}

export function parseAxleContextWindowTokens(value: string | undefined): number | undefined {
  if (!value) return undefined;
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

export function normalizeAxleContextWindow(
  model: string,
  value: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!isCodexOAuthModel(model)) return value;
  const requestedTokens = parseAxleContextWindowTokens(value);
  const effectiveTokens = normalizeCodexOAuthEffectiveContextWindowTokens(
    model,
    requestedTokens,
    environment,
  );
  if (effectiveTokens === undefined) return undefined;
  if (effectiveTokens % 1_000_000 === 0) return `${effectiveTokens / 1_000_000}m`;
  if (effectiveTokens % 1_000 === 0) return `${effectiveTokens / 1_000}k`;
  return `${effectiveTokens}`;
}

/**
 * Models.dev can describe a model when the provider has not exposed a
 * capability yet. Keep that fallback visible for non-OAuth providers, but use
 * the account-safe Codex OAuth fallback in the runtime even when the catalog
 * only supplied Models.dev metadata.
 */
export function resolveAxleRuntimeContextWindow(
  model: string,
  selection: ModelSelection | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (selection?.contextWindowSource === "models.dev" && !isCodexOAuthModel(model)) {
    return undefined;
  }
  return normalizeAxleContextWindow(
    model,
    selection ? getModelSelectionStringOptionValue(selection, "contextWindow") : undefined,
    environment,
  );
}

const AXLE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Project-free chats still need a stable process/session home for Axle's
 * durable transcript, but that home must never be the user's project or the
 * server process CWD.
 */
function projectFreeRuntimeCwd(attachmentsDir: string, threadId: string): string {
  const threadKey = NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 32);
  const cwd = NodePath.join(attachmentsDir, "project-free", threadKey);
  NodeFS.mkdirSync(cwd, { recursive: true });
  return cwd;
}

function axleSessionFile(cwd: string, sessionId: string): string {
  return NodePath.join(cwd, ".axle", "sessions", `${sessionId}.jsonl`);
}

function usableAxleSessionId(cwd: string, value: unknown): string | undefined {
  if (typeof value !== "string" || !AXLE_SESSION_ID_PATTERN.test(value)) return undefined;
  return NodeFS.existsSync(axleSessionFile(cwd, value)) ? value : undefined;
}

function sessionBindingFile(cwd: string, threadId: string): string {
  const bindingId = NodeCrypto.createHash("sha256").update(threadId).digest("hex");
  return NodePath.join(cwd, ".axle", "t3-sessions", `${bindingId}.json`);
}

export function readAxleSessionBinding(cwd: string, threadId: string): string | undefined {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(sessionBindingFile(cwd, threadId), "utf8")) as {
      version?: unknown;
      threadId?: unknown;
      axleSessionId?: unknown;
    };
    if (parsed.version !== 1 || parsed.threadId !== threadId) return undefined;
    return usableAxleSessionId(cwd, parsed.axleSessionId);
  } catch {
    return undefined;
  }
}

/** Ensure runtime session files stay out of ordinary working-tree changes. */
function ensureAxleGitignored(cwd: string): void {
  const gitignorePath = NodePath.join(cwd, ".gitignore");
  const axleEntry = "/.axle/";

  let content: string;
  try {
    content = NodeFS.readFileSync(gitignorePath, "utf8");
  } catch {
    // No .gitignore yet — create one.
    NodeFS.writeFileSync(gitignorePath, `${axleEntry}\n`, "utf8");
    return;
  }

  const hasEntry = content.split("\n").some((line) => {
    const trimmed = line.trim();
    return (
      trimmed === axleEntry || trimmed === "/.axle" || trimmed === ".axle/" || trimmed === ".axle"
    );
  });

  if (!hasEntry) {
    NodeFS.writeFileSync(gitignorePath, `${content.trimEnd()}\n${axleEntry}\n`, "utf8");
  }
}

export function writeAxleSessionBinding(cwd: string, threadId: string, sessionId: string): void {
  if (!usableAxleSessionId(cwd, sessionId)) {
    throw new Error(`Cannot bind missing Axle session '${sessionId}'.`);
  }
  const bindingDirectory = NodePath.join(cwd, ".axle", "t3-sessions");
  const bindingFile = sessionBindingFile(cwd, threadId);
  NodeFS.mkdirSync(bindingDirectory, { recursive: true });
  ensureAxleGitignored(cwd);
  const temporaryFile = `${bindingFile}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  NodeFS.writeFileSync(
    temporaryFile,
    `${JSON.stringify({ version: 1, threadId, axleSessionId: sessionId })}\n`,
    "utf8",
  );
  NodeFS.renameSync(temporaryFile, bindingFile);
}

/**
 * Approval decisions travel to the Axle runtime through a per-thread,
 * append-only NDJSON file that the runtime polls while a gated tool is
 * blocked. The runtime matches decisions by request id, so a stale decision
 * from an earlier turn can never approve a later tool call.
 */
function axleApprovalFile(cwd: string, threadId: string): string {
  const threadKey = NodeCrypto.createHash("sha256").update(threadId).digest("hex");
  return NodePath.join(cwd, ".axle", "approvals", `${threadKey}.jsonl`);
}

/**
 * Start each turn from an empty decision file. Every request id is unique to
 * the turn that created it, so decisions answered after their turn ended are
 * undeliverable by construction and can be discarded.
 */
export function resetAxleApprovalFile(cwd: string, threadId: string): string {
  const file = axleApprovalFile(cwd, threadId);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  ensureAxleGitignored(cwd);
  NodeFS.writeFileSync(file, "", "utf8");
  return file;
}

export function appendAxleApprovalResponse(input: {
  readonly cwd: string;
  readonly threadId: string;
  readonly requestId: string;
  readonly decision: ProviderApprovalDecision;
}): void {
  const file = axleApprovalFile(input.cwd, input.threadId);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  ensureAxleGitignored(input.cwd);
  NodeFS.appendFileSync(
    file,
    `${JSON.stringify({
      type: "approval_response",
      requestId: input.requestId,
      decision: input.decision,
    })}\n`,
    "utf8",
  );
}

export function captureAxleSessionIdentity(
  state: { session: ProviderSession },
  cwd: string,
  threadId: ThreadId,
  sessionId: string,
): void {
  state.session = {
    ...state.session,
    resumeCursor: {
      threadId: String(threadId),
      axleSessionId: sessionId,
      ...(state.session.workspaceContext === "none" ? {} : { cwd }),
    },
    updatedAt: new Date().toISOString(),
  };
  writeAxleSessionBinding(cwd, String(threadId), sessionId);
}

function axleSessionIdFromResumeCursor(value: unknown, threadId: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const cursor = value as { threadId?: unknown; axleSessionId?: unknown };
  if (cursor.threadId !== threadId) return undefined;
  return typeof cursor.axleSessionId === "string" ? cursor.axleSessionId : undefined;
}

function cwdFromResumeCursor(value: unknown, threadId: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const cursor = value as { threadId?: unknown; cwd?: unknown };
  if (cursor.threadId !== threadId || typeof cursor.cwd !== "string") return undefined;
  const cwd = cursor.cwd.trim();
  return cwd.length > 0 ? cwd : undefined;
}

function sessionIdFromResumeCursor(
  cwd: string,
  threadId: string,
  resumeCursor: unknown,
): string | undefined {
  const sessionId = axleSessionIdFromResumeCursor(resumeCursor, threadId);
  return sessionId ? usableAxleSessionId(cwd, sessionId) : undefined;
}

/** Resolve the conversation identity for every follow-up turn. */
export function resolveAxleSessionId(
  cwd: string,
  threadId: string,
  resumeCursor: unknown,
  workspaceContext: ProviderWorkspaceContext = "project",
): string | undefined {
  const requestedSessionId = axleSessionIdFromResumeCursor(resumeCursor, threadId);
  if (requestedSessionId && !usableAxleSessionId(cwd, requestedSessionId)) {
    throw new Error(
      workspaceContext === "none"
        ? `Cannot continue Axle conversation '${threadId}': the persisted session is missing.`
        : `Cannot continue Axle conversation '${threadId}': persisted session '${requestedSessionId}' is missing from '${cwd}'. Refusing to start a new conversation.`,
    );
  }
  return requestedSessionId ?? readAxleSessionBinding(cwd, threadId);
}

export function makeAxleProcessArgs(input: {
  readonly cwd: string;
  readonly prompt: string;
  readonly model: string;
  readonly textOnly?: boolean | undefined;
  readonly images?: ReadonlyArray<{ readonly path: string; readonly mimeType: string }>;
  readonly reasoningEffort?: string | undefined;
  readonly contextWindow?: string | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly sessionId?: string | undefined;
  readonly workspaceContext?: ProviderWorkspaceContext | undefined;
  readonly customInstructions?: string | undefined;
  readonly mcpUrl?: string | undefined;
  readonly mcpBearerTokenEnvVar?: string | undefined;
  readonly approvalFile?: string | undefined;
  readonly persistentJsonStream?: boolean | undefined;
}): string[] {
  const selection = parseAxleModelSelection(input.model);
  const args = [
    "--json-stream",
    "--provider",
    selection.provider,
    "--model",
    selection.model,
    "--cwd",
    input.cwd,
    ...(input.persistentJsonStream ? ["--persistent-json-stream"] : ["--prompt-stdin"]),
  ];
  if (selection.baseUrl) {
    args.push("--base-url", selection.baseUrl);
  }
  if (input.textOnly) {
    args.push("--text-only");
  }
  if (input.sessionId) {
    args.push("--session", input.sessionId);
  }
  if (input.workspaceContext === "none") {
    args.push("--no-workspace-context");
  }
  if (input.reasoningEffort?.trim()) {
    args.push("--effort", input.reasoningEffort.trim());
  }
  if (input.contextWindow?.trim()) {
    args.push("--context-window", input.contextWindow.trim());
  }
  if (input.interactionMode) {
    // The provider contract calls the normal coding mode "default", while
    // Axle's CLI names that same mode "build".
    args.push("--interaction-mode", input.interactionMode === "plan" ? "plan" : "build");
  }
  if (input.runtimeMode) {
    // An explicit policy flag makes an incompatible runtime fail before work
    // begins instead of silently changing the requested permission boundary.
    args.push("--runtime-mode", input.runtimeMode);
  }
  if (!input.persistentJsonStream) {
    for (const image of input.images ?? []) {
      args.push("--image-path", image.path, "--image-mime-type", image.mimeType);
    }
  }
  if (input.customInstructions?.trim()) {
    args.push("--append-system-prompt", input.customInstructions.trim());
  }
  if (input.mcpUrl?.trim() && input.mcpBearerTokenEnvVar?.trim()) {
    args.push("--mcp-url", input.mcpUrl.trim());
    args.push("--mcp-bearer-token-env-var", input.mcpBearerTokenEnvVar.trim());
  }
  if (input.approvalFile?.trim()) {
    args.push("--approval-file", input.approvalFile.trim());
  }
  return args;
}

function runAxle(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly model: string;
  readonly textOnly?: boolean | undefined;
  readonly images?: ReadonlyArray<{ readonly path: string; readonly mimeType: string }>;
  readonly reasoningEffort?: string | undefined;
  readonly contextWindow?: string | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly activeChildren?: Map<string, AxleChildProcess> | undefined;
  readonly childKey?: string | undefined;
  readonly isCancelled?: (() => boolean) | undefined;
  readonly callbacks?: AxleStreamCallbacks | undefined;
  readonly sessionId?: string | undefined;
  readonly workspaceContext?: ProviderWorkspaceContext | undefined;
  readonly customInstructions?: string | undefined;
  readonly mcpUrl?: string | undefined;
  readonly mcpBearerTokenEnvVar?: string | undefined;
  readonly approvalFile?: string | undefined;
}) {
  return Effect.tryPromise({
    try: () =>
      new Promise<AxleProcessResult>((resolve, reject) => {
        const args = makeAxleProcessArgs(input);

        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;

        const child = NodeChildProcess.spawn(input.binaryPath, args, {
          cwd: input.cwd,
          env: input.environment,
          windowsHide: true,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
        if (input.childKey) input.activeChildren?.set(input.childKey, child);

        let stderr = "";
        const appendStderr = (chunk: string) => {
          const next = stderr + chunk;
          stderr = next.length > 65_536 ? next.slice(-65_536) : next;
        };
        const removeActiveChild = () => {
          if (input.childKey && input.activeChildren?.get(input.childKey) === child) {
            input.activeChildren.delete(input.childKey);
          }
        };
        const cleanup = () => {
          if (timeout !== undefined) {
            clearTimeout(timeout);
            timeout = undefined;
          }
          removeActiveChild();
        };
        const resolveOnce = (value: AxleProcessResult) => {
          if (settled) return;
          settled = true;
          cleanup();
          // The JSON result is the protocol-level end of a one-shot turn. Do
          // not wait for a provider/MCP child to close its inherited event
          // loop before settling the desktop turn state.
          child.kill();
          resolve(value);
        };
        const rejectOnce = (cause: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          // A protocol/decode failure can happen while the child is still
          // writing. Do not leave that process alive after the turn has
          // already been converted into a terminal provider failure.
          child.kill();
          reject(cause);
        };
        const decoder = makeAxleStreamDecoder({
          ...input.callbacks,
          onResult: () => {
            try {
              resolveOnce(decoder.finish());
            } catch (cause) {
              rejectOnce(cause);
            }
          },
        });
        const armTimeout = () => {
          if (settled) return;
          if (timeout !== undefined) clearTimeout(timeout);
          timeout = undefined;
          // The Rust tool runner owns each tool's configured timeout and the
          // runtime enforces its own approval timeout, so an open tool
          // lifecycle or a pending approval is positive activity even when the
          // provider pipe is quiet for ten minutes.
          if (decoder.hasOpenTools() || decoder.hasPendingApprovals()) return;
          timeout = setTimeout(() => {
            const message = `Axle turn stalled after ${AXLE_TURN_IDLE_TIMEOUT_MS}ms without provider activity.`;
            appendStderr(`\n${message}`);
            decoder.failOpenWork(message);
            // Reject immediately instead of waiting for the child close event.
            // This guarantees the orchestration layer receives the terminal
            // failure and can leave the UI's running state.
            child.kill("SIGKILL");
            rejectOnce(new Error(message));
          }, AXLE_TURN_IDLE_TIMEOUT_MS);
        };
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          decoder.push(chunk);
          if (chunk.length > 0) armTimeout();
        });
        child.stderr.on("data", (chunk: string) => {
          appendStderr(chunk);
          if (chunk.length > 0) armTimeout();
        });
        child.stdin.on("error", (error) => {
          appendStderr(`\nUnable to send the prompt to Axle: ${error.message}`);
        });
        child.stdin.end(input.prompt, "utf8");
        armTimeout();
        child.once("error", (err) => {
          if (settled) return;
          decoder.failOpenWork(`Axle process error: ${err.message}`);
          rejectOnce(err);
        });
        child.once("close", (code) => {
          if (settled) return;
          cleanup();
          if (code !== 0) {
            decoder.failOpenWork(
              stderr.trim() ||
                `Axle exited before returning a result (exit code ${code ?? "unknown"}).`,
            );
            rejectOnce(
              new Error(
                stderr.trim() ||
                  `Axle exited before returning a result (exit code ${code ?? "unknown"}).`,
              ),
            );
            return;
          }
          try {
            resolveOnce(decoder.finish());
          } catch (cause) {
            rejectOnce(cause);
          }
        });
        if (input.isCancelled?.()) {
          decoder.failOpenWork("Axle turn interrupted.");
          rejectOnce(new Error("Axle turn interrupted."));
        }
      }),
    catch: (cause) =>
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: "standalone",
        detail: formatAxleProcessError(cause, input.workspaceContext),
        cause,
      }),
  });
}

function runPersistentAxle(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly model: string;
  readonly images?: ReadonlyArray<{ readonly path: string; readonly mimeType: string }>;
  readonly reasoningEffort?: string | undefined;
  readonly contextWindow?: string | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly activeChildren: Map<string, AxleChildProcess>;
  readonly childKey: string;
  readonly isCancelled: () => boolean;
  readonly callbacks?: AxleStreamCallbacks | undefined;
  readonly sessionId?: string | undefined;
  readonly workspaceContext?: ProviderWorkspaceContext | undefined;
  readonly customInstructions?: string | undefined;
  readonly mcpUrl?: string | undefined;
  readonly mcpBearerTokenEnvVar?: string | undefined;
  readonly approvalFile?: string | undefined;
  readonly processes: Map<string, PersistentAxleProcess>;
  readonly processKey: string;
}) {
  return Effect.tryPromise({
    try: () =>
      new Promise<AxleProcessResult>((resolve, reject) => {
        if (input.isCancelled()) {
          reject(new Error("Axle turn interrupted."));
          return;
        }
        const args = makeAxleProcessArgs({ ...input, persistentJsonStream: true });
        const signatureArgs = args.filter(
          (argument, index) => argument !== "--session" && args[index - 1] !== "--session",
        );
        const signature = NodeCrypto.createHash("sha256")
          .update(JSON.stringify(signatureArgs))
          .update(JSON.stringify(input.environment))
          .digest("hex");
        let processState = input.processes.get(input.processKey);
        if (
          processState &&
          (processState.signature !== signature || processState.child.exitCode !== null)
        ) {
          input.processes.delete(input.processKey);
          processState.child.kill();
          processState = undefined;
        }
        let createdProcess = false;
        if (!processState) {
          const child = NodeChildProcess.spawn(input.binaryPath, args, {
            cwd: input.cwd,
            env: input.environment,
            windowsHide: true,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
          });
          processState = { child, signature, stderr: "" };
          input.processes.set(input.processKey, processState);
          createdProcess = true;
        }
        const currentProcess = processState;
        const child = currentProcess.child;
        let settled = false;
        let idleTimeout: ReturnType<typeof setTimeout> | undefined;
        currentProcess.stderr = "";
        const appendStderr = (chunk: string) => {
          const next = currentProcess.stderr + chunk;
          currentProcess.stderr = next.length > 65_536 ? next.slice(-65_536) : next;
        };
        const removeActiveChild = () => {
          if (input.activeChildren.get(input.childKey) === child) {
            input.activeChildren.delete(input.childKey);
          }
        };
        const clearIdleTimeout = () => {
          if (idleTimeout !== undefined) {
            clearTimeout(idleTimeout);
            idleTimeout = undefined;
          }
        };
        const clearPending = () => {
          currentProcess.pending = undefined;
          clearIdleTimeout();
          removeActiveChild();
        };
        const settle = (result?: AxleProcessResult, cause?: unknown) => {
          if (settled) return;
          settled = true;
          clearPending();
          if (cause !== undefined) reject(cause);
          else if (result !== undefined) resolve(result);
          else reject(new Error("Axle persistent turn ended without a result."));
        };
        const destroyProcess = () => {
          if (input.processes.get(input.processKey) === currentProcess) {
            input.processes.delete(input.processKey);
          }
          clearIdleTimeout();
          child.kill();
        };
        const decoder = makeAxleStreamDecoder({
          ...input.callbacks,
          onResult: () => {
            try {
              settle(decoder.finish());
            } catch (cause) {
              settle(undefined, cause);
              destroyProcess();
            }
          },
          onError: (message) => {
            input.callbacks?.onError?.(message);
            settle(undefined, new Error(message));
            // A failed turn may have mutated in-memory session state. Discard
            // this process so a retry reloads the durable transcript instead.
            destroyProcess();
          },
        });
        const armIdleTimeout = () => {
          if (settled) return;
          clearIdleTimeout();
          // An open tool or approval is positive activity even when the
          // provider pipe is quiet. Backgrounded tools remain open until a
          // monitor collects them, matching the runtime's lifecycle.
          if (decoder.hasOpenTools() || decoder.hasPendingApprovals()) return;
          idleTimeout = setTimeout(() => {
            const message = `Axle turn stalled after ${AXLE_TURN_IDLE_TIMEOUT_MS}ms without provider activity.`;
            appendStderr(`\n${message}`);
            decoder.failOpenWork(message);
            child.kill("SIGKILL");
            settle(undefined, new Error(message));
          }, AXLE_TURN_IDLE_TIMEOUT_MS);
        };
        const pending: PendingPersistentTurn = {
          decoder,
          resolve,
          reject,
          childKey: input.childKey,
        };
        currentProcess.pending = pending;
        input.activeChildren.set(input.childKey, child);
        pending.fail = (cause) => settle(undefined, cause);
        if (createdProcess) {
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            const activeTurn = currentProcess.pending;
            if (!activeTurn) return;
            activeTurn.decoder.push(chunk);
            if (chunk.length > 0) armIdleTimeout();
          });
          child.stderr.on("data", (chunk: string) => {
            const activeTurn = currentProcess.pending;
            appendStderr(chunk);
            if (activeTurn && chunk.length > 0) armIdleTimeout();
          });
          child.stdin.on("error", (error) => {
            const activeTurn = currentProcess.pending;
            if (!activeTurn) return;
            activeTurn.fail?.(new Error(`Unable to send the prompt to Axle: ${error.message}`));
            destroyProcess();
          });
          child.once("error", (error) => {
            const activeTurn = currentProcess.pending;
            if (!activeTurn) return;
            activeTurn.decoder.failOpenWork(`Axle process error: ${error.message}`);
            activeTurn.fail?.(error);
            destroyProcess();
          });
          child.once("close", (code) => {
            if (input.processes.get(input.processKey) === currentProcess) {
              input.processes.delete(input.processKey);
            }
            const activeTurn = currentProcess.pending;
            if (!activeTurn) return;
            const detail =
              currentProcess.stderr.trim() || `Axle exited (exit code ${code ?? "unknown"}).`;
            activeTurn.decoder.failOpenWork(detail);
            activeTurn.fail?.(new Error(detail));
          });
        }
        try {
          child.stdin.write(
            `${JSON.stringify({
              prompt: input.prompt,
              imagePaths: (input.images ?? []).map((image) => image.path),
              imageMimeTypes: (input.images ?? []).map((image) => image.mimeType),
              interactionMode: input.interactionMode === "plan" ? "plan" : "build",
            })}\n`,
            "utf8",
          );
        } catch (cause) {
          settle(undefined, cause);
          destroyProcess();
        }
        armIdleTimeout();
        if (input.isCancelled()) {
          settle(undefined, new Error("Axle turn interrupted."));
          destroyProcess();
        }
      }),
    catch: (cause) =>
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: "standalone",
        detail: formatAxleProcessError(cause, input.workspaceContext),
        cause,
      }),
  });
}

export const makeAxleAdapter = (options: AxleAdapterOptions) =>
  Effect.gen(function* () {
    const adapterScope = yield* Scope.Scope;
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, SessionState>();
    const activeChildren = new Map<string, AxleChildProcess>();
    const persistentProcesses = new Map<string, PersistentAxleProcess>();
    const activeFibers = new Map<string, Fiber.Fiber<void>>();
    const cancelledTurnKeys = new Set<string>();
    const pendingApprovals = new Map<
      string,
      {
        readonly threadId: ThreadId;
        readonly turnId: TurnId;
        readonly cwd: string;
        readonly toolName: string;
        decision?: ProviderApprovalDecision | undefined;
      }
    >();

    const stamp = (threadId: ThreadId, turnId?: TurnId) => ({
      eventId: EventId.make(NodeCrypto.randomUUID()),
      provider: PROVIDER,
      providerInstanceId: options.instanceId,
      threadId,
      createdAt: new Date().toISOString(),
      ...(turnId ? { turnId } : {}),
    });
    const publish = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);
    const logAdapterEvent = (
      threadId: ThreadId,
      event: string,
      data: Record<string, unknown> = {},
    ) =>
      options.nativeEventLogger
        ? options.nativeEventLogger.write(
            {
              schemaVersion: 1,
              source: "axle",
              event,
              createdAt: new Date().toISOString(),
              ...data,
            },
            threadId,
          )
        : Effect.void;

    const missingSession = (threadId: ThreadId) =>
      Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId: String(threadId),
        }),
      );

    const executeTurn = (
      state: SessionState,
      turnId: TurnId,
      prompt: string,
      model: string,
      images: ReadonlyArray<{ readonly path: string; readonly mimeType: string }>,
      reasoningEffort: string | undefined,
      contextWindow: string | undefined,
      contextWindowTokens: number | undefined,
      interactionMode: ProviderInteractionMode,
    ) => {
      const threadId = state.session.threadId;
      const childKey = `${threadId}:${turnId}`;
      const cwd = state.runtimeCwd;
      const workspaceContext = state.session.workspaceContext ?? "project";
      const isTurnCancelled = () =>
        cancelledTurnKeys.has(childKey) ||
        sessions.get(threadId) !== state ||
        state.session.activeTurnId !== turnId;
      const toolPresentations = new Map<string, ReturnType<typeof axleToolPresentation>>();
      const prepareApprovalFile = (): { readonly file: string } | { readonly error: string } => {
        try {
          return { file: resetAxleApprovalFile(cwd, String(threadId)) };
        } catch (cause) {
          return { error: cause instanceof Error ? cause.message : String(cause) };
        }
      };
      return Effect.gen(function* () {
        if (isTurnCancelled()) return;
        yield* publish({
          type: "turn.started",
          ...stamp(threadId, turnId),
          payload: { model },
        });
        // Every turn starts from an empty decision file. Request ids are
        // unique to the tool call that created them, so a decision answered
        // after its turn ended can never be delivered to a later turn, and
        // resetting keeps the polled file bounded to the current turn.
        const preparedApprovalFile = prepareApprovalFile();
        if ("error" in preparedApprovalFile) {
          const message = `Unable to prepare the tool approval channel: ${preparedApprovalFile.error}`;
          state.session = {
            ...state.session,
            status: "error",
            activeTurnId: undefined,
            lastError: message,
            updatedAt: new Date().toISOString(),
          };
          yield* publish({
            type: "runtime.error",
            ...stamp(threadId, turnId),
            payload: { message, class: "provider_error" },
          });
          yield* publish({
            type: "turn.completed",
            ...stamp(threadId, turnId),
            payload: { state: "failed", errorMessage: message },
          });
          return;
        }
        const approvalFile = preparedApprovalFile.file;
        const assistantSegments = makeAxleAssistantSegmenter({
          onStarted: (segmentId) => {
            runEffectSync(
              publish({
                type: "item.started",
                ...stamp(threadId, turnId),
                itemId: RuntimeItemId.make(segmentId),
                payload: { itemType: "assistant_message", status: "inProgress" },
              }),
            );
          },
          onDelta: (segmentId, delta) => {
            runEffectSync(
              publish({
                type: "content.delta",
                ...stamp(threadId, turnId),
                itemId: RuntimeItemId.make(segmentId),
                payload: { streamKind: "assistant_text", delta },
              }),
            );
          },
          onCompleted: (segmentId, text) => {
            runEffectSync(
              publish({
                type: "item.completed",
                ...stamp(threadId, turnId),
                itemId: RuntimeItemId.make(segmentId),
                payload: {
                  itemType: "assistant_message",
                  status: "completed",
                  detail: text,
                },
              }),
            );
          },
        });

        const customInstructions = options.getCustomInstructions
          ? yield* options.getCustomInstructions()
          : "";
        const authSessionId = yield* currentAuthSessionId;
        const mcpSession = McpProviderSession.readMcpProviderSession(
          threadId,
          options.instanceId,
          authSessionId ?? undefined,
        );
        const activeMcp = workspaceContext === "none" ? undefined : mcpSession;
        const localPackId = (() => {
          const selection = parseAxleModelSelection(model);
          return selection.provider === "axle-local" &&
            LOCAL_MODEL_PACK_IDS.includes(selection.model as LocalModelPackId)
            ? (selection.model as LocalModelPackId)
            : undefined;
        })();
        const turnEnvironment = yield* Effect.gen(function* () {
          if (!localPackId) return options.environment;
          const localModelsDir = options.localModelsDir;
          const localModelsStatePath = options.localModelsStatePath;
          if (!localModelsDir || !localModelsStatePath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "thread.turn.start",
              detail: "Axle Offline is not configured for this server.",
            });
          }
          const runtime = yield* Effect.tryPromise({
            try: () =>
              localModelManager({
                modelsDir: localModelsDir,
                statePath: localModelsStatePath,
              }).ensureRuntime(localPackId),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "thread.turn.start",
                detail:
                  cause instanceof Error
                    ? cause.message
                    : "The Axle Offline runtime could not be started.",
                cause,
              }),
          });
          return {
            ...options.environment,
            AXLE_LOCAL_BASE_URL: runtime.baseUrl,
            AXLE_LOCAL_API_KEY: runtime.apiKey || "axle-local",
            AXLE_LOCAL_MODELS_STATE_PATH: localModelsStatePath,
          };
        });
        const effectiveInstructions = [
          customInstructions.trim(),
          ...(activeMcp
            ? [AXLE_BROWSER_INSTRUCTIONS, T3_CODE_PULL_REQUEST_REVIEW_INSTRUCTIONS]
            : []),
        ]
          .filter((instructions) => instructions.length > 0)
          .join("\n\n");
        let sessionId = resolveAxleSessionId(
          cwd,
          String(threadId),
          state.session.resumeCursor,
          workspaceContext,
        );
        const captureSessionIdentity = (nextSessionId: string) => {
          sessionId = nextSessionId;
          try {
            captureAxleSessionIdentity(state, cwd, threadId, nextSessionId);
          } catch (cause) {
            runEffectSync(
              Effect.logWarning("failed to persist early Axle thread session binding", {
                threadId,
                sessionId: nextSessionId,
                cause,
              }),
            );
          }
        };
        const runOnce = () =>
          Effect.gen(function* () {
            if (isTurnCancelled()) {
              return yield* new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: String(threadId),
                detail: "Axle turn interrupted.",
              });
            }
            yield* logAdapterEvent(threadId, "process.start", {
              attempt: 1,
              maxAttempts: 1,
              model,
              ...(workspaceContext === "none" ? {} : { cwd }),
              workspaceContext,
              hasSession: sessionId !== undefined,
              hasMcpSession: activeMcp !== undefined,
            });
            const result = yield* runPersistentAxle({
              binaryPath: options.binaryPath,
              cwd,
              prompt,
              model,
              images,
              reasoningEffort,
              contextWindow,
              interactionMode,
              runtimeMode: state.session.runtimeMode,
              approvalFile,
              workspaceContext,
              environment: axleChildEnvironment(
                activeMcp
                  ? {
                      ...turnEnvironment,
                      [T3_MCP_BEARER_TOKEN_ENV_VAR]: activeMcp.authorizationHeader.replace(
                        /^Bearer\s+/u,
                        "",
                      ),
                    }
                  : turnEnvironment,
              ),
              activeChildren,
              childKey,
              processes: persistentProcesses,
              processKey: String(threadId),
              sessionId,
              customInstructions: effectiveInstructions,
              isCancelled: isTurnCancelled,
              ...(activeMcp
                ? {
                    mcpUrl: activeMcp.endpoint,
                    mcpBearerTokenEnvVar: T3_MCP_BEARER_TOKEN_ENV_VAR,
                  }
                : {}),
              callbacks: {
                onDelta: (delta) => {
                  if (isTurnCancelled()) return;
                  assistantSegments.pushDelta(delta);
                },
                onSessionId: captureSessionIdentity,
                onUsage: (usage) => {
                  if (isTurnCancelled()) return;
                  runEffectSync(
                    publish({
                      type: "thread.token-usage.updated",
                      ...stamp(threadId, turnId),
                      payload: {
                        usage: {
                          usedTokens: Math.max(0, Math.round(usage.totalTokens)),
                          totalProcessedTokens: Math.max(
                            0,
                            Math.round(usage.cumulativeTotalTokens),
                          ),
                          ...(contextWindowTokens !== undefined
                            ? { maxTokens: contextWindowTokens }
                            : {}),
                          inputTokens: Math.max(0, Math.round(usage.promptTokens)),
                          outputTokens: Math.max(0, Math.round(usage.completionTokens)),
                          lastUsedTokens: Math.max(0, Math.round(usage.totalTokens)),
                          lastInputTokens: Math.max(0, Math.round(usage.promptTokens)),
                          lastOutputTokens: Math.max(0, Math.round(usage.completionTokens)),
                          compactsAutomatically: true,
                        },
                      },
                    }),
                  );
                },
                onToolStarted: (event) => {
                  if (isTurnCancelled()) return;
                  if (isHiddenAxleControlTool(event.toolName)) return;
                  assistantSegments.closeBeforeTool();
                  const toolItemId = RuntimeItemId.make(event.toolCallId);
                  const presentation = axleToolPresentation(event.toolName, event.arguments);
                  toolPresentations.set(event.toolCallId, presentation);
                  const data = { ...presentation.data, toolCallId: event.toolCallId };
                  runEffectSync(
                    publish({
                      type: "item.started",
                      ...stamp(threadId, turnId),
                      itemId: toolItemId,
                      payload: {
                        itemType: presentation.itemType,
                        status: "inProgress",
                        title: presentation.title,
                        data,
                      },
                    }),
                  );
                },
                onToolCompleted: (event) => {
                  if (isHiddenAxleControlTool(event.toolName)) return;
                  const toolItemId = RuntimeItemId.make(event.toolCallId);
                  const presentation =
                    toolPresentations.get(event.toolCallId) ??
                    axleToolPresentation(event.toolName, {});
                  toolPresentations.delete(event.toolCallId);
                  runEffectSync(
                    publish({
                      type: "item.completed",
                      ...stamp(threadId, turnId),
                      itemId: toolItemId,
                      payload: {
                        itemType: presentation.itemType,
                        status: event.isError ? "failed" : "completed",
                        title: presentation.title,
                        // Keep the full output in the structured result only. The
                        // previous event duplicated large tool payloads in both
                        // detail and data, increasing ingestion and UI costs.
                        data: {
                          ...presentation.data,
                          toolCallId: event.toolCallId,
                          result: { output: event.output, isError: event.isError },
                          ...(event.durationMs !== undefined
                            ? { durationMs: event.durationMs }
                            : {}),
                          ...(event.timedOut !== undefined ? { timedOut: event.timedOut } : {}),
                        },
                      },
                    }),
                  );
                },
                onApprovalRequested: (event) => {
                  if (isTurnCancelled()) return;
                  pendingApprovals.set(event.requestId, {
                    threadId,
                    turnId,
                    cwd,
                    toolName: event.toolName,
                  });
                  runEffectSync(
                    publish({
                      type: "request.opened",
                      ...stamp(threadId, turnId),
                      requestId: RuntimeRequestId.make(event.requestId),
                      payload: {
                        requestType: axleApprovalRequestType(event.toolName),
                        detail: axleApprovalDetail(event.toolName, event.arguments),
                        ...(event.arguments !== undefined ? { args: event.arguments } : {}),
                      },
                    }),
                  );
                  runEffectSync(
                    logAdapterEvent(threadId, "approval.requested", {
                      requestId: event.requestId,
                      toolCallId: event.toolCallId,
                      toolName: event.toolName,
                      timeoutSeconds: event.timeoutSeconds,
                    }),
                  );
                },
                onApprovalResolved: (event) => {
                  const pending = pendingApprovals.get(event.requestId);
                  if (!pending) return;
                  pendingApprovals.delete(event.requestId);
                  const decision = pending.decision ?? axleApprovalDecision(event.decision);
                  runEffectSync(
                    publish({
                      type: "request.resolved",
                      ...stamp(pending.threadId, pending.turnId),
                      requestId: RuntimeRequestId.make(event.requestId),
                      payload: {
                        requestType: axleApprovalRequestType(pending.toolName),
                        decision,
                        resolution: { reason: event.reason },
                      },
                    }),
                  );
                  runEffectSync(
                    logAdapterEvent(pending.threadId, "approval.resolved", {
                      requestId: event.requestId,
                      toolCallId: event.toolCallId,
                      toolName: event.toolName,
                      decision,
                      reason: event.reason,
                    }),
                  );
                },
              },
            });
            if (result.sessionId) {
              captureSessionIdentity(result.sessionId);
            }
            yield* logAdapterEvent(threadId, "process.succeeded", {
              attempt: 1,
              responseChars: result.response.length,
              sessionIdPresent: result.sessionId !== undefined,
            });
            return result;
          });
        // A process can persist the user prompt or execute work before its
        // first visible output. Replaying it is not idempotent, even after a
        // transport error. Provider-level retries remain inside the Rust
        // runtime, where they do not append the prompt again.
        const result = yield* runOnce().pipe(
          Effect.tapError((error) =>
            logAdapterEvent(threadId, "process.failed", {
              attempt: 1,
              replaySuppressed: true,
              errorTag: errorTag(error),
              detail: sanitizeAxleLogDetail(error.detail),
            }),
          ),
        );
        // `interruptTurn` owns the terminal interrupted event. If the child
        // also reports a process failure while it is being killed, do not
        // publish a second failed completion for the already-settled turn.
        if (isTurnCancelled()) return;
        assistantSegments.finish(result.response);

        state.snapshot = {
          threadId,
          turns: [
            ...state.snapshot.turns,
            {
              id: turnId,
              items: [
                { type: "userMessage", content: [{ type: "text", text: prompt }] },
                { type: "agentMessage", text: result.response },
              ],
            },
          ],
        };
        state.session = {
          ...state.session,
          status: "ready",
          activeTurnId: undefined,
          lastError: undefined,
          updatedAt: new Date().toISOString(),
          resumeCursor: result.sessionId
            ? {
                threadId: String(threadId),
                axleSessionId: result.sessionId,
                ...(workspaceContext === "none" ? {} : { cwd }),
              }
            : state.session.resumeCursor,
        };

        yield* publish({
          type: "turn.completed",
          ...stamp(threadId, turnId),
          payload: {
            state: "completed",
            ...(result.sessionId
              ? {
                  resumeCursor: {
                    threadId: String(threadId),
                    axleSessionId: result.sessionId,
                    ...(workspaceContext === "none" ? {} : { cwd }),
                  },
                }
              : {}),
          },
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (isTurnCancelled()) return;
            const errorMessage = error?.message ?? "";
            const isContextLengthError =
              errorMessage.includes("context_length_exceeded") ||
              errorMessage.includes("context length") ||
              errorMessage.includes("Context window") ||
              errorMessage.includes("context window");

            // The Rust runtime performs one bounded same-session compaction
            // and retry for context overflow. Preserve the cursor here so a
            // failed recovery can never silently turn the next message into a
            // brand-new conversation.
            if (isContextLengthError) {
              yield* Effect.logWarning(
                "context window recovery failed; preserving session cursor",
                {
                  threadId,
                  turnId,
                },
              );
            }

            state.session = {
              ...state.session,
              status: "error",
              activeTurnId: undefined,
              lastError: errorMessage || "Axle turn failed.",
              updatedAt: new Date().toISOString(),
            };

            yield* publish({
              type: "runtime.error",
              ...stamp(threadId, turnId),
              payload: { message: errorMessage, class: "provider_error" },
            });
            yield* publish({
              type: "turn.completed",
              ...stamp(threadId, turnId),
              payload: {
                state: "failed",
                errorMessage: isContextLengthError
                  ? "Conversation context is full and automatic compaction could not complete. The existing conversation was preserved; retry this message after checking the provider connection."
                  : errorMessage,
              },
            });
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            activeChildren.delete(childKey);
            activeFibers.delete(childKey);
            cancelledTurnKeys.delete(childKey);
            for (const [requestId, pending] of pendingApprovals) {
              if (pending.turnId === turnId) pendingApprovals.delete(requestId);
            }
          }),
        ),
      );
    };

    const interruptTurnImpl = (
      threadId: ThreadId,
      turnId?: TurnId,
    ): Effect.Effect<void, ProviderAdapterError> => {
      const state = sessions.get(threadId);
      if (!state) return missingSession(threadId);
      const targetTurnId = turnId ?? state.session.activeTurnId;
      if (!targetTurnId) return Effect.void;
      const key = `${threadId}:${targetTurnId}`;
      return Effect.gen(function* () {
        cancelledTurnKeys.add(key);
        activeChildren.get(key)?.kill();
        const fiber = activeFibers.get(key);
        if (fiber) yield* Fiber.interrupt(fiber);
        const currentState = sessions.get(threadId);
        if (currentState?.session.activeTurnId === targetTurnId) {
          currentState.session = {
            ...currentState.session,
            status: "ready",
            activeTurnId: undefined,
            lastError: undefined,
            updatedAt: new Date().toISOString(),
          };
        }
        if (!fiber) cancelledTurnKeys.delete(key);
        yield* publish({
          type: "turn.completed",
          ...stamp(threadId, targetTurnId),
          payload: { state: "interrupted" },
        });
      });
    };

    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession: (input) =>
        Effect.sync(() => {
          const now = new Date().toISOString();
          const threadId = String(input.threadId);
          const requestedSessionId = axleSessionIdFromResumeCursor(input.resumeCursor, threadId);
          const workspaceContext: ProviderWorkspaceContext = input.workspaceContext ?? "project";
          const runtimeCwd =
            workspaceContext === "none"
              ? projectFreeRuntimeCwd(options.attachmentsDir, threadId)
              : (input.cwd ?? cwdFromResumeCursor(input.resumeCursor, threadId));
          if (runtimeCwd === undefined) {
            throw new Error(
              `Cannot start Axle conversation '${threadId}': a project workspace CWD is required.`,
            );
          }
          const axleSessionId =
            sessionIdFromResumeCursor(runtimeCwd, threadId, input.resumeCursor) ??
            readAxleSessionBinding(runtimeCwd, threadId);
          if (requestedSessionId && !axleSessionId) {
            throw new Error(
              workspaceContext === "none"
                ? `Cannot resume Axle conversation '${threadId}': the persisted session is not available. Refusing to start a new conversation.`
                : `Cannot resume Axle conversation '${threadId}': session '${requestedSessionId}' is not available in '${runtimeCwd}'. Refusing to start a new conversation.`,
            );
          }
          const resumeCursorWithoutProjectCwd =
            workspaceContext === "none" && cwdFromResumeCursor(input.resumeCursor, threadId)
              ? undefined
              : input.resumeCursor;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            workspaceContext,
            threadId: input.threadId,
            ...(workspaceContext === "none" ? {} : { cwd: runtimeCwd }),
            ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
            ...(input.modelSelection?.contextWindowSource !== "models.dev" ||
            isCodexOAuthModel(input.modelSelection?.model)
              ? (() => {
                  const selectedContext = input.modelSelection
                    ? normalizeAxleContextWindow(
                        input.modelSelection.model,
                        getModelSelectionStringOptionValue(input.modelSelection, "contextWindow"),
                      )
                    : undefined;
                  const selectedContextTokens = parseAxleContextWindowTokens(selectedContext);
                  return selectedContext !== undefined
                    ? {
                        contextWindowTokens: selectedContextTokens,
                        contextWindowSource: isCodexOAuthModel(input.modelSelection?.model)
                          ? ("oauth" as const)
                          : ("provider" as const),
                      }
                    : {};
                })()
              : {}),
            ...(axleSessionId
              ? {
                  resumeCursor: {
                    threadId,
                    axleSessionId,
                    ...(workspaceContext === "none" ? {} : { cwd: runtimeCwd }),
                  },
                }
              : resumeCursorWithoutProjectCwd !== undefined
                ? { resumeCursor: resumeCursorWithoutProjectCwd }
                : {}),
            createdAt: now,
            updatedAt: now,
          };
          sessions.set(input.threadId, {
            session,
            runtimeCwd,
            snapshot: { threadId: input.threadId, turns: [] },
            nextTurn: 0,
          });
          return session;
        }),
      sendTurn: (input) =>
        Effect.gen(function* () {
          const state = sessions.get(input.threadId);
          if (!state) return yield* missingSession(input.threadId);
          const prompt = input.input?.trim();
          if (!prompt) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Axle requires a text prompt.",
            });
          }
          const images = yield* Effect.forEach(
            input.attachments ?? [],
            (attachment: ChatAttachment) =>
              Effect.gen(function* () {
                const path = resolveAttachmentPath({
                  attachmentsDir: options.attachmentsDir,
                  attachment,
                });
                if (!path || !NodeFS.existsSync(path)) {
                  return yield* new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "thread.turn.start",
                    detail: `Attachment '${attachment.name}' could not be loaded by Axle.`,
                  });
                }
                return { path, mimeType: attachment.mimeType };
              }),
          );
          const model = input.modelSelection?.model ?? state.session.model ?? "GPT-5.6 Sol";
          const reasoningEffort = input.modelSelection
            ? getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort")
            : undefined;
          const contextWindow = resolveAxleRuntimeContextWindow(
            model,
            input.modelSelection,
            options.environment,
          );
          const contextWindowTokens = parseAxleContextWindowTokens(contextWindow);
          const effectiveContextWindowTokens = normalizeCodexOAuthEffectiveContextWindowTokens(
            model,
            contextWindowTokens,
            options.environment,
          );
          const interactionMode = input.interactionMode ?? "default";
          state.nextTurn += 1;
          const turnId = TurnId.make(`axle-${state.nextTurn}-${NodeCrypto.randomUUID()}`);
          const modelChanged = state.session.model !== undefined && state.session.model !== model;
          if (modelChanged && contextWindowTokens === undefined) {
            const {
              contextWindowTokens: _previousContextWindowTokens,
              contextWindowSource: _previousContextWindowSource,
              ...sessionWithoutContextWindow
            } = state.session;
            state.session = {
              ...sessionWithoutContextWindow,
              status: "running",
              activeTurnId: turnId,
              model,
              updatedAt: new Date().toISOString(),
            };
          } else {
            state.session = {
              ...state.session,
              status: "running",
              activeTurnId: turnId,
              model,
              ...(effectiveContextWindowTokens !== undefined
                ? {
                    contextWindowTokens: effectiveContextWindowTokens,
                    contextWindowSource: isCodexOAuthModel(model)
                      ? ("oauth" as const)
                      : ("provider" as const),
                  }
                : {}),
              updatedAt: new Date().toISOString(),
            };
          }
          const fiber = yield* executeTurn(
            state,
            turnId,
            prompt,
            model,
            images,
            reasoningEffort,
            contextWindow,
            effectiveContextWindowTokens,
            interactionMode,
          ).pipe(Effect.forkIn(adapterScope));
          activeFibers.set(`${input.threadId}:${turnId}`, fiber);
          return { threadId: input.threadId, turnId };
        }),
      interruptTurn: (threadId, turnId) => interruptTurnImpl(threadId, turnId),
      respondToRequest: (threadId, requestId, decision) => {
        const state = sessions.get(threadId);
        if (!state) return missingSession(threadId);
        const pending = pendingApprovals.get(String(requestId));
        if (!pending || pending.threadId !== threadId) {
          return Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "thread.approval.respond",
              detail: `Unknown pending approval request: ${String(requestId)}.`,
            }),
          );
        }
        return Effect.gen(function* () {
          pending.decision = decision;
          yield* Effect.try({
            try: () =>
              appendAxleApprovalResponse({
                cwd: pending.cwd,
                threadId: String(threadId),
                requestId: String(requestId),
                decision,
              }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "thread.approval.respond",
                detail: `Failed to deliver the approval decision: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
                cause,
              }),
          });
          yield* logAdapterEvent(threadId, "approval.response", {
            requestId: String(requestId),
            decision,
          });
          if (decision === "cancel" && state.session.activeTurnId === pending.turnId) {
            // The runtime reads 'cancel' as a denial, but this user action
            // means "stop the turn". Resolve the request here because
            // interrupting kills the child before it can emit its own
            // resolution.
            pendingApprovals.delete(String(requestId));
            yield* publish({
              type: "request.resolved",
              ...stamp(threadId, pending.turnId),
              requestId: RuntimeRequestId.make(String(requestId)),
              payload: {
                requestType: axleApprovalRequestType(pending.toolName),
                decision: "cancel",
              },
            });
            yield* interruptTurnImpl(threadId, pending.turnId);
          }
        });
      },
      respondToUserInput: (threadId) =>
        sessions.has(threadId)
          ? Effect.fail(
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "respondToUserInput",
                issue: "Axle does not expose structured follow-up requests.",
              }),
            )
          : missingSession(threadId),
      stopSession: (threadId) =>
        Effect.gen(function* () {
          const activeKeys = [
            ...new Set(
              [...activeFibers.keys(), ...activeChildren.keys()].filter((key) =>
                key.startsWith(`${threadId}:`),
              ),
            ),
          ];
          for (const key of activeKeys) cancelledTurnKeys.add(key);
          for (const [key, child] of activeChildren) {
            if (key.startsWith(`${threadId}:`)) child.kill();
          }
          for (const key of activeKeys) {
            const fiber = activeFibers.get(key);
            if (fiber) yield* Fiber.interrupt(fiber);
          }
          const persistent = persistentProcesses.get(String(threadId));
          if (persistent) {
            persistentProcesses.delete(String(threadId));
            persistent.child.kill();
          }
          sessions.delete(threadId);
        }),
      listSessions: () => Effect.sync(() => [...sessions.values()].map((state) => state.session)),
      hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
      readThread: (threadId) => {
        const state = sessions.get(threadId);
        return state ? Effect.succeed(state.snapshot) : missingSession(threadId);
      },
      rollbackThread: (threadId, numTurns) => {
        const state = sessions.get(threadId);
        if (!state) return missingSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 0 || numTurns > state.snapshot.turns.length) {
          return Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "numTurns must be within the current Axle transcript.",
            }),
          );
        }
        return Effect.sync(() => {
          state.snapshot = {
            threadId,
            turns: state.snapshot.turns.slice(0, state.snapshot.turns.length - numTurns),
          };
          state.nextTurn = state.snapshot.turns.length;
          return state.snapshot;
        });
      },
      stopAll: () =>
        Effect.sync(() => {
          for (const child of activeChildren.values()) child.kill();
          activeChildren.clear();
          for (const process of persistentProcesses.values()) process.child.kill();
          persistentProcesses.clear();
          sessions.clear();
        }),
      subscribeEvents: PubSub.subscribe(runtimeEvents),
      streamEvents: Stream.fromPubSub(runtimeEvents),
    };

    return adapter;
  });

export const runAxleTextGeneration = (input: Parameters<typeof runAxle>[0]) =>
  runAxle({ ...input, textOnly: true });
