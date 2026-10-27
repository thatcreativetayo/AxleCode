// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderSession,
} from "@axle/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  makeAxleAssistantSegmenter,
  makeAxleProcessArgs,
  makeAxleStreamDecoder,
  normalizeAxleContextWindow,
  parseAxleContextWindowTokens,
  formatAxleProcessError,
  resolveAxleRuntimeContextWindow,
  captureAxleSessionIdentity,
  readAxleSessionBinding,
  resolveAxleSessionId,
  appendAxleApprovalResponse,
  resetAxleApprovalFile,
  axleApprovalDecision,
  axleApprovalDetail,
  axleApprovalRequestType,
  axleToolPresentation,
  isHiddenAxleControlTool,
  axleChildEnvironment,
  writeAxleSessionBinding,
} from "./AxleAdapter.ts";

describe("hidden Axle control tools", () => {
  it("suppresses only the terminal control tool from UI lifecycle rendering", () => {
    expect(isHiddenAxleControlTool("end_task")).toBe(true);
    expect(isHiddenAxleControlTool("update_plan")).toBe(false);
    expect(isHiddenAxleControlTool("preview_click")).toBe(false);
  });
});

describe("native search worker environment", () => {
  it("removes legacy/static search credentials", () => {
    const input = {
      PATH: "test-path",
      AXLE_SEARCH_WORKER_AUTH_TOKEN: "native-worker-auth-token",
      AXLE_SEARCH_WORKER_SESSION_TOKEN: "client-configured-token",
      AXLE_SEARCH_WORKER_TOKEN: "legacy-client-token",
      SEARCH_WORKER_TOKEN: "legacy-worker-token",
      OPENCODE_API_KEY: "legacy-zen-key",
      OPENCODE_BASE_URL: "https://legacy.invalid/v1",
    };
    expect(axleChildEnvironment(input)).toEqual({ PATH: "test-path" });
  });
});

describe("makeAxleStreamDecoder", () => {
  it("allows the result callback to finish the decoder synchronously", () => {
    let finished: unknown;
    let decoder: ReturnType<typeof makeAxleStreamDecoder>;
    decoder = makeAxleStreamDecoder({
      onResult: () => {
        finished = decoder.finish();
      },
    });

    decoder.push('{"type":"result","response":"Done"}\n');

    expect(finished).toEqual({ response: "Done" });
    expect(decoder.finish()).toEqual({ response: "Done" });
  });

  it("signals protocol completion immediately when the terminal result frame arrives", () => {
    const results: unknown[] = [];
    const decoder = makeAxleStreamDecoder({
      onResult: (result) => results.push(result),
    });

    decoder.push('{"type":"result","response":"Done","sessionId":"session-1"}\n');

    expect(results).toEqual([{ response: "Done", sessionId: "session-1" }]);
    expect(decoder.finish()).toEqual({ response: "Done", sessionId: "session-1" });
  });

  it("captures a durable session identity before a one-shot turn completes", () => {
    const sessionIds: string[] = [];
    const decoder = makeAxleStreamDecoder({
      onSessionId: (sessionId) => sessionIds.push(sessionId),
    });

    decoder.push('{"type":"session","sessionId":"session-1"}\n');
    decoder.push('{"type":"result","response":"Done","sessionId":"session-1"}\n');

    expect(sessionIds).toEqual(["session-1"]);
    expect(decoder.finish()).toEqual({ response: "Done", sessionId: "session-1" });
  });

  it("emits token deltas before the final process result across split stdout chunks", () => {
    const deltas: string[] = [];
    const decoder = makeAxleStreamDecoder({ onDelta: (delta) => deltas.push(delta) });

    decoder.push('{"type":"delta","del');
    expect(deltas).toEqual([]);

    decoder.push('ta":"Hel"}\n{"type":"delta","delta":"lo"}\n');
    expect(deltas).toEqual(["Hel", "lo"]);

    decoder.push('{"type":"result","response":"Hello","sessionId":"session-1"}');
    expect(decoder.finish()).toEqual({ response: "Hello", sessionId: "session-1" });
  });

  it("streams tool lifecycle events before the final result across split stdout chunks", () => {
    const events: Array<{ readonly type: string; readonly value: unknown }> = [];
    const decoder = makeAxleStreamDecoder({
      onToolStarted: (value) => events.push({ type: "started", value }),
      onToolCompleted: (value) => events.push({ type: "completed", value }),
    });

    decoder.push('{"type":"tool.started","toolCallId":"call-1","toolName":"read","arg');
    expect(events).toEqual([]);

    decoder.push(
      'uments":{"path":"README.md"}}\n' +
        '{"type":"tool.completed","toolCallId":"call-1","toolName":"read",' +
        '"output":"hello","isError":false,"durationMs":1234,"timedOut":false}\n',
    );

    expect(events).toEqual([
      {
        type: "started",
        value: {
          toolCallId: "call-1",
          toolName: "read",
          arguments: { path: "README.md" },
        },
      },
      {
        type: "completed",
        value: {
          toolCallId: "call-1",
          toolName: "read",
          output: "hello",
          isError: false,
          durationMs: 1234,
          timedOut: false,
        },
      },
    ]);

    decoder.push('{"type":"result","response":"Done"}\n');
    expect(decoder.finish()).toEqual({ response: "Done" });
  });

  it("exposes an open tool lifecycle so process inactivity does not kill active work", () => {
    const decoder = makeAxleStreamDecoder();

    expect(decoder.hasOpenTools()).toBe(false);
    decoder.push(
      '{"type":"tool.started","toolCallId":"call-1","toolName":"bash","arguments":{}}\n',
    );
    expect(decoder.hasOpenTools()).toBe(true);
    decoder.push(
      '{"type":"tool.completed","toolCallId":"call-1","toolName":"bash",' +
        '"output":"done","isError":false}\n',
    );
    expect(decoder.hasOpenTools()).toBe(false);
    decoder.push('{"type":"result","response":"Done"}\n');
    expect(decoder.finish()).toEqual({ response: "Done" });
  });

  it("keeps backgrounded tools open until a monitor collects them", () => {
    const backgrounded: unknown[] = [];
    const completed: unknown[] = [];
    const decoder = makeAxleStreamDecoder({
      onToolBackgrounded: (event) => backgrounded.push(event),
      onToolCompleted: (event) => completed.push(event),
    });

    decoder.push(
      '{"type":"tool.started","toolCallId":"call-bg","toolName":"bash","arguments":{}}\n' +
        '{"type":"tool.backgrounded","toolCallId":"call-bg","toolName":"bash","jobId":"job-1"}\n',
    );

    expect(backgrounded).toEqual([{ toolCallId: "call-bg", toolName: "bash", jobId: "job-1" }]);
    expect(decoder.hasOpenTools()).toBe(true);

    decoder.push('{"type":"result","response":"Command started in the background."}\n');
    expect(decoder.finish()).toEqual({ response: "Command started in the background." });
    // A backgrounded tool is intentionally not failed just because the turn
    // result arrived; a later monitor call still owns its completion.
    expect(decoder.hasOpenTools()).toBe(true);
    expect(completed).toEqual([]);
  });

  it("rejects a backgrounded frame for a tool that is not active", () => {
    const decoder = makeAxleStreamDecoder();
    decoder.push(
      '{"type":"tool.backgrounded","toolCallId":"call-bg","toolName":"bash","jobId":"job-1"}\n',
    );
    expect(() => decoder.finish()).toThrow("backgrounded a tool that was not active");
  });

  it("surfaces turn-level error frames and fails open tool lifecycles", () => {
    const errors: string[] = [];
    const completed: unknown[] = [];
    const decoder = makeAxleStreamDecoder({
      onError: (message) => errors.push(message),
      onToolCompleted: (event) => completed.push(event),
    });
    decoder.push(
      '{"type":"tool.started","toolCallId":"call-err","toolName":"bash","arguments":{}}\n' +
        '{"type":"error","message":"Provider connection lost.","sessionId":"session-1"}\n',
    );

    expect(errors).toEqual(["Provider connection lost."]);
    expect(completed).toEqual([
      {
        toolCallId: "call-err",
        toolName: "bash",
        output: "Provider connection lost.",
        isError: true,
      },
    ]);
    expect(decoder.hasOpenTools()).toBe(false);
  });

  it("flags timed-out tools and rejects non-numeric durations", () => {
    const completed: unknown[] = [];
    const decoder = makeAxleStreamDecoder({
      onToolCompleted: (value) => completed.push(value),
    });
    decoder.push(
      '{"type":"tool.completed","toolCallId":"call-2","toolName":"bash",' +
        '"output":"Command timed out after 5 seconds","isError":true,' +
        '"durationMs":5001,"timedOut":true}\n',
    );
    expect(completed).toEqual([
      {
        toolCallId: "call-2",
        toolName: "bash",
        output: "Command timed out after 5 seconds",
        isError: true,
        durationMs: 5001,
        timedOut: true,
      },
    ]);

    const malformed = makeAxleStreamDecoder();
    malformed.push(
      '{"type":"tool.completed","toolCallId":"call-3","toolName":"bash",' +
        '"output":"done","isError":false,"durationMs":"soon"}\n',
    );
    expect(() => malformed.finish()).toThrow("malformed tool.completed event");
  });

  it("forwards real token usage events to the desktop context meter", () => {
    const usage: unknown[] = [];
    const decoder = makeAxleStreamDecoder({ onUsage: (value) => usage.push(value) });
    decoder.push(
      '{"type":"usage","promptTokens":1200,"completionTokens":80,' +
        '"totalTokens":1280,"cumulativeTotalTokens":2400}\n' +
        '{"type":"result","response":"Done"}\n',
    );

    expect(decoder.finish()).toEqual({ response: "Done" });
    expect(usage).toEqual([
      {
        promptTokens: 1200,
        completionTokens: 80,
        totalTokens: 1280,
        cumulativeTotalTokens: 2400,
      },
    ]);
  });

  it("rejects malformed protocol events instead of silently buffering forever", () => {
    const decoder = makeAxleStreamDecoder();
    decoder.push("not-json\n");
    expect(() => decoder.finish()).toThrow("invalid streaming event");
  });

  it("rejects an early EOF that never delivered a terminal result", () => {
    const decoder = makeAxleStreamDecoder();
    decoder.push('{"type":"delta","delta":"partial"}\n');

    expect(() => decoder.finish()).toThrow("empty streaming result");
  });

  it("does not complete a turn while a tool lifecycle is still open", () => {
    const completed: unknown[] = [];
    const decoder = makeAxleStreamDecoder({
      onToolCompleted: (event) => completed.push(event),
    });

    decoder.push(
      '{"type":"tool.started","toolCallId":"call-1","toolName":"read","arguments":{}}\n' +
        '{"type":"result","response":"Done"}\n',
    );

    expect(() => decoder.finish()).toThrow("before this tool returned a result");
    expect(completed).toEqual([
      {
        toolCallId: "call-1",
        toolName: "read",
        output: "Axle ended before this tool returned a result.",
        isError: true,
      },
    ]);
  });

  it("rejects malformed and unknown protocol frames instead of ignoring them", () => {
    const malformed = makeAxleStreamDecoder();
    malformed.push('{"type":"tool.started","toolCallId":"call-1"}\n');
    expect(() => malformed.finish()).toThrow("malformed tool.started event");

    const unknown = makeAxleStreamDecoder();
    unknown.push('{"type":"provider.warning","message":"unexpected"}\n');
    expect(() => unknown.finish()).toThrow("unknown streaming event");
  });

  it("fails a tool lifecycle when the child ends before sending its completion", () => {
    const completed: unknown[] = [];
    const decoder = makeAxleStreamDecoder({
      onToolCompleted: (event) => completed.push(event),
    });

    decoder.push(
      '{"type":"tool.started","toolCallId":"call-1","toolName":"update_plan","arguments":{}}\n',
    );
    decoder.failOpenTools("Axle process stopped.");

    expect(completed).toEqual([
      {
        toolCallId: "call-1",
        toolName: "update_plan",
        output: "Axle process stopped.",
        isError: true,
      },
    ]);
  });
});

describe("axleToolPresentation", () => {
  it("gives browser MCP tools readable titles and an MCP lifecycle type", () => {
    expect(axleToolPresentation("preview_evaluate", { expression: "document.title" })).toEqual({
      itemType: "mcp_tool_call",
      title: "Evaluate browser JavaScript",
      data: {
        kind: "preview_evaluate",
        toolName: "preview_evaluate",
        rawInput: { expression: "document.title" },
      },
    });
  });

  it("preserves a dedicated lifecycle type for web search", () => {
    expect(axleToolPresentation("web_search", { query: "Rust serde" })).toMatchObject({
      itemType: "web_search",
      title: "Search the web",
      data: { toolName: "web_search", rawInput: { query: "Rust serde" } },
    });
  });

  it("humanizes memory tool names while preserving their wire names", () => {
    expect(axleToolPresentation("memory_search", { query: "preferences" })).toMatchObject({
      itemType: "dynamic_tool_call",
      title: "Search memory",
      data: { toolName: "memory_search" },
    });
  });

  it("preserves plugin identity in the lifecycle payload", () => {
    expect(
      axleToolPresentation("axle_plugin_call", {
        pluginId: "GMAIL",
        action: "search_messages",
        input: {},
      }),
    ).toMatchObject({
      itemType: "dynamic_tool_call",
      title: "Axle Plugin Call",
      data: {
        pluginId: "gmail",
        rawInput: { pluginId: "GMAIL", action: "search_messages", input: {} },
      },
    });
  });

  it("humanizes built-in planning tool names", () => {
    expect(axleToolPresentation("update_plan", {})).toMatchObject({
      itemType: "dynamic_tool_call",
      title: "Update plan",
    });
  });

  it("renders bash_monitor as a command lifecycle", () => {
    expect(axleToolPresentation("bash_monitor", { command_id: "job-1" })).toMatchObject({
      itemType: "command_execution",
      title: "Monitor command",
      data: { kind: "execute", toolName: "bash_monitor" },
    });
  });
});

describe("makeAxleAssistantSegmenter", () => {
  it("closes narration before a tool and starts a fresh block when text resumes", () => {
    const events: string[] = [];
    let nextId = 0;
    const segments = makeAxleAssistantSegmenter(
      {
        onStarted: (id) => events.push(`start:${id}`),
        onDelta: (id, delta) => events.push(`delta:${id}:${delta}`),
        onCompleted: (id, text) => events.push(`complete:${id}:${text}`),
      },
      () => `assistant-${++nextId}`,
    );

    segments.pushDelta("Let me check. ");
    segments.pushDelta("One moment.");
    segments.closeBeforeTool();
    events.push("tool");
    segments.pushDelta("The file is ready.");
    segments.finish("Let me check. One moment.The file is ready.");

    expect(events).toEqual([
      "start:assistant-1",
      "delta:assistant-1:Let me check. ",
      "delta:assistant-1:One moment.",
      "complete:assistant-1:Let me check. One moment.",
      "tool",
      "start:assistant-2",
      "delta:assistant-2:The file is ready.",
      "complete:assistant-2:The file is ready.",
    ]);
  });

  it("uses the final response only when no text delta was emitted", () => {
    const events: string[] = [];
    const segments = makeAxleAssistantSegmenter(
      {
        onStarted: (id) => events.push(`start:${id}`),
        onDelta: (id, delta) => events.push(`delta:${id}:${delta}`),
        onCompleted: (id, text) => events.push(`complete:${id}:${text}`),
      },
      () => "assistant-fallback",
    );

    segments.finish("Fallback response");

    expect(events).toEqual([
      "start:assistant-fallback",
      "delta:assistant-fallback:Fallback response",
      "complete:assistant-fallback:Fallback response",
    ]);
  });
});

describe("Axle session continuity", () => {
  it("explains when a project-free turn is using an outdated Axle binary", () => {
    expect(
      formatAxleProcessError("error: unexpected argument '--no-workspace-context' found", "none"),
    ).toBe(
      "The configured Axle runtime is outdated and does not support project-free chats. Rebuild or update the Axle binary, then retry.",
    );
    expect(
      formatAxleProcessError(
        "error: unexpected argument '--no-workspace-context' found",
        "project",
      ),
    ).toContain("unexpected argument");
  });

  it("explains thinking-replay and schema rejections with actionable next steps", () => {
    expect(
      formatAxleProcessError(
        'agent_router API error (HTTP 400 Bad Request): {"error":{"message":"The `content[].thinking` in the thinking mode must be passed back to the API."}}',
        "project",
      ),
    ).toContain("repaired the session history automatically");
    expect(
      formatAxleProcessError(
        'agent_router API error (HTTP 400 Bad Request): {"error":{"message":"Invalid schema for function \'ls\': null is not of type \\"array\\""}}',
        "project",
      ),
    ).toContain("tool schemas");
    expect(
      formatAxleProcessError("agent_router API error (HTTP 429 Too Many Requests)", "project"),
    ).toContain("rate-limiting");
    expect(
      formatAxleProcessError("agent_router API error (HTTP 502 Bad Gateway)", "project"),
    ).toContain("temporary server error");
  });

  it("uses the provider-native text-only path for metadata generation", () => {
    const args = makeAxleProcessArgs({
      cwd: "C:\\workspace",
      prompt: "Name this thread",
      model: "openai-codex/gpt-5.6-sol",
      textOnly: true,
    });

    expect(args).toContain("--text-only");
    expect(args).not.toContain("--session");
  });

  it("disables workspace context for project-free runtime turns", () => {
    const args = makeAxleProcessArgs({
      cwd: "C:\\project-free-runtime",
      prompt: "Answer without project context",
      model: "openai/gpt-4o",
      textOnly: true,
      workspaceContext: "none",
    });

    expect(args).toContain("--text-only");
    expect(args).toContain("--no-workspace-context");
  });

  it("passes saved custom instructions into the Axle runtime", () => {
    const args = makeAxleProcessArgs({
      cwd: "C:\\workspace",
      prompt: "Create the feature",
      model: "openai/gpt-4o",
      customInstructions: "Prefer TypeScript and explain risky changes.",
    });

    expect(args).toContain("--append-system-prompt");
    expect(args.at(args.indexOf("--append-system-prompt") + 1)).toBe(
      "Prefer TypeScript and explain risky changes.",
    );
  });

  it("passes the desktop MCP endpoint without putting its bearer token on the command line", () => {
    const args = makeAxleProcessArgs({
      cwd: "C:\\workspace",
      prompt: "Test the page",
      model: "openai/gpt-4o",
      mcpUrl: "http://127.0.0.1:43123/mcp",
      mcpBearerTokenEnvVar: "T3_MCP_BEARER_TOKEN",
    });

    expect(args.at(args.indexOf("--mcp-url") + 1)).toBe("http://127.0.0.1:43123/mcp");
    expect(args.at(args.indexOf("--mcp-bearer-token-env-var") + 1)).toBe("T3_MCP_BEARER_TOKEN");
    expect(args.join(" ")).not.toContain("Bearer ");
  });

  it("sends only the new follow-up while resuming the exact existing session", () => {
    const args = makeAxleProcessArgs({
      cwd: "C:\\workspace",
      prompt: "Now make it green",
      model: "openai/gpt-4o",
      sessionId: "11111111-1111-4111-8111-111111111111",
    });

    expect(args).toContain("--session");
    expect(args.at(args.indexOf("--session") + 1)).toBe("11111111-1111-4111-8111-111111111111");
    expect(args).toContain("--prompt-stdin");
    expect(args).not.toContain("Now make it green");
    expect(args.join(" ")).not.toContain("Continue this coding conversation");
  });

  it("keeps long prompts off the Windows command line and forwards reasoning effort", () => {
    const prompt = "x".repeat(100_000);
    const args = makeAxleProcessArgs({
      cwd: "C:\\workspace",
      prompt,
      model: "openai-codex/gpt-5.6-sol",
      reasoningEffort: "xhigh",
    });

    expect(args).toContain("--prompt-stdin");
    expect(args).not.toContain(prompt);
    expect(args.at(args.indexOf("--effort") + 1)).toBe("xhigh");
  });

  it("forwards provider-selected context windows and Plan mode", () => {
    const args = makeAxleProcessArgs({
      cwd: "C:\\workspace",
      prompt: "Plan the migration",
      model: "openai/gpt-4o",
      contextWindow: "200k",
      interactionMode: "plan",
    });

    expect(args.at(args.indexOf("--context-window") + 1)).toBe("200k");
    expect(args.at(args.indexOf("--interaction-mode") + 1)).toBe("plan");
    expect(parseAxleContextWindowTokens("200k")).toBe(200_000);
    expect(parseAxleContextWindowTokens("unsupported")).toBeUndefined();
  });

  it("caps only the OAuth Codex context window", () => {
    const environment = { AXLE_CODEX_HOME: "C:\\axle-test-codex-home-that-does-not-exist" };
    expect(normalizeAxleContextWindow("openai-codex/gpt-5.6-sol", "1m", environment)).toBe(
      "258400",
    );
    expect(normalizeAxleContextWindow("openai/gpt-5.6-sol", "1m", environment)).toBe("1m");
    expect(normalizeAxleContextWindow("openai-codex/gpt-5.6-sol", "128k", environment)).toBe(
      "128k",
    );
  });

  it("does not pass an unverified Models.dev context window to the runtime", () => {
    const environment = { AXLE_CODEX_HOME: "C:\\axle-test-codex-home-that-does-not-exist" };
    expect(
      resolveAxleRuntimeContextWindow(
        "openai-codex/gpt-5.6-sol",
        {
          instanceId: ProviderInstanceId.make("axle"),
          model: "openai-codex/gpt-5.6-sol",
          contextWindowSource: "models.dev",
          options: [{ id: "contextWindow", value: "1m" }],
        },
        environment,
      ),
    ).toBe("258400");
    expect(
      resolveAxleRuntimeContextWindow("openai-codex/gpt-5.6-sol", {
        instanceId: ProviderInstanceId.make("axle"),
        model: "openai-codex/gpt-5.6-sol",
        contextWindowSource: "provider",
        options: [{ id: "contextWindow", value: "258400" }],
      }),
    ).toBe("258400");
  });

  it("maps the provider default mode to Axle's build mode", () => {
    const args = makeAxleProcessArgs({
      cwd: "C:\\workspace",
      prompt: "Add the feature",
      model: "openai/gpt-4o",
      interactionMode: "default",
    });

    expect(args.at(args.indexOf("--interaction-mode") + 1)).toBe("build");
  });

  it("passes persisted image files and MIME types to the Rust runtime", () => {
    const args = makeAxleProcessArgs({
      cwd: "C:\\workspace",
      prompt: "Describe this image",
      model: "openai-codex/gpt-5.6-sol",
      images: [{ path: "C:\\state\\attachments\\image.png", mimeType: "image/png" }],
    });

    expect(args.at(args.indexOf("--image-path") + 1)).toBe("C:\\state\\attachments\\image.png");
    expect(args.at(args.indexOf("--image-mime-type") + 1)).toBe("image/png");
  });

  it("persists the early session identity so an interrupted turn keeps its chat context", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "axle-interrupted-session-"));
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const threadId = ThreadId.make("thread-interrupted");
    const now = "2026-01-01T00:00:00.000Z";
    const state: { session: ProviderSession } = {
      session: {
        provider: ProviderDriverKind.make("axle"),
        providerInstanceId: ProviderInstanceId.make("axle"),
        status: "running",
        runtimeMode: "full-access",
        threadId,
        cwd,
        createdAt: now,
        updatedAt: now,
      },
    };
    try {
      const sessionsDirectory = NodePath.join(cwd, ".axle", "sessions");
      NodeFS.mkdirSync(sessionsDirectory, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(sessionsDirectory, `${sessionId}.jsonl`),
        "session created before provider work\n",
      );

      // The runtime publishes this identity before doing provider work. It must
      // be durable even when interruption prevents a terminal result frame.
      captureAxleSessionIdentity(state, cwd, threadId, sessionId);
      state.session = { ...state.session, status: "ready", activeTurnId: undefined };

      const resumedSessionId = resolveAxleSessionId(
        cwd,
        String(threadId),
        state.session.resumeCursor,
      );
      const args = makeAxleProcessArgs({
        cwd,
        prompt: "remember the message before I stopped you",
        model: "openai/gpt-4o",
        sessionId: resumedSessionId,
      });

      expect(state.session.resumeCursor).toEqual({
        threadId: String(threadId),
        axleSessionId: sessionId,
        cwd,
      });
      expect(readAxleSessionBinding(cwd, String(threadId))).toBe(sessionId);
      expect(args.at(args.indexOf("--session") + 1)).toBe(sessionId);
    } finally {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("persists separate thread bindings and restores them after adapter restart", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "axle-session-binding-"));
    const firstSession = "11111111-1111-4111-8111-111111111111";
    const secondSession = "22222222-2222-4222-8222-222222222222";
    try {
      const sessionsDirectory = NodePath.join(cwd, ".axle", "sessions");
      NodeFS.mkdirSync(sessionsDirectory, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(sessionsDirectory, `${firstSession}.jsonl`),
        "session one\n",
      );
      NodeFS.writeFileSync(
        NodePath.join(sessionsDirectory, `${secondSession}.jsonl`),
        "session two\n",
      );

      writeAxleSessionBinding(cwd, "thread-one", firstSession);
      writeAxleSessionBinding(cwd, "thread-two", secondSession);

      expect(NodeFS.readFileSync(NodePath.join(cwd, ".gitignore"), "utf8")).toContain("/.axle/");
      expect(readAxleSessionBinding(cwd, "thread-one")).toBe(firstSession);
      expect(readAxleSessionBinding(cwd, "thread-two")).toBe(secondSession);
      expect(readAxleSessionBinding(cwd, "thread-three")).toBeUndefined();
      expect(resolveAxleSessionId(cwd, "thread-one", undefined)).toBe(firstSession);
    } finally {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refuses to silently start a new conversation when resume state is missing", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "axle-session-missing-"));
    try {
      expect(() =>
        resolveAxleSessionId(cwd, "thread-one", {
          threadId: "thread-one",
          axleSessionId: "11111111-1111-4111-8111-111111111111",
        }),
      ).toThrow(/Refusing to start a new conversation/u);
    } finally {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("Axle approval stream", () => {
  it("streams approval requests and resolutions across split stdout chunks", () => {
    const events: Array<{ readonly type: string; readonly value: unknown }> = [];
    const decoder = makeAxleStreamDecoder({
      onApprovalRequested: (event) => events.push({ type: "requested", value: event }),
      onApprovalResolved: (event) => events.push({ type: "resolved", value: event }),
    });

    decoder.push(
      '{"type":"approval.requested","requestId":"call-1:123","toolCallId":"call-1",' +
        '"toolName":"bash","arg',
    );
    expect(events).toEqual([]);
    expect(decoder.hasPendingApprovals()).toBe(false);

    decoder.push('uments":{"command":"rm -rf build"},"timeoutSeconds":600}\n');
    expect(decoder.hasPendingApprovals()).toBe(true);
    expect(events).toEqual([
      {
        type: "requested",
        value: {
          requestId: "call-1:123",
          toolCallId: "call-1",
          toolName: "bash",
          arguments: { command: "rm -rf build" },
          timeoutSeconds: 600,
        },
      },
    ]);

    decoder.push(
      '{"type":"approval.resolved","requestId":"call-1:123","toolCallId":"call-1",' +
        '"toolName":"bash","decision":"allow","reason":"Approved in the desktop app."}\n',
    );
    expect(decoder.hasPendingApprovals()).toBe(false);
    expect(events[1]).toEqual({
      type: "resolved",
      value: {
        requestId: "call-1:123",
        toolCallId: "call-1",
        toolName: "bash",
        decision: "allow",
        reason: "Approved in the desktop app.",
      },
    });
  });

  it("counts a pending approval as activity so inactivity cannot kill the turn", () => {
    const decoder = makeAxleStreamDecoder();

    expect(decoder.hasPendingApprovals()).toBe(false);
    decoder.push(
      '{"type":"approval.requested","requestId":"r1","toolCallId":"c1","toolName":"write",' +
        '"arguments":{"path":"src/app.ts"},"timeoutSeconds":60}\n',
    );
    expect(decoder.hasPendingApprovals()).toBe(true);
    decoder.push(
      '{"type":"approval.resolved","requestId":"r1","toolCallId":"c1","toolName":"write",' +
        '"decision":"deny","reason":"Denied in the desktop app."}\n',
    );
    expect(decoder.hasPendingApprovals()).toBe(false);
  });

  it("rejects malformed approval frames instead of ignoring them", () => {
    const missingDeadline = makeAxleStreamDecoder();
    missingDeadline.push('{"type":"approval.requested","requestId":"r1"}\n');
    expect(() => missingDeadline.finish()).toThrow("malformed approval.requested event");

    const missingReason = makeAxleStreamDecoder();
    missingReason.push(
      '{"type":"approval.resolved","requestId":"r1","toolCallId":"c1","toolName":"write",' +
        '"decision":"allow"}\n',
    );
    expect(() => missingReason.finish()).toThrow("malformed approval.resolved event");
  });

  it("denies open approvals when the child stops before resolving them", () => {
    const resolutions: unknown[] = [];
    const decoder = makeAxleStreamDecoder({
      onApprovalResolved: (event) => resolutions.push(event),
    });
    decoder.push(
      '{"type":"approval.requested","requestId":"r1","toolCallId":"c1","toolName":"bash",' +
        '"arguments":{},"timeoutSeconds":60}\n',
    );

    decoder.failOpenWork("Axle process stopped.");

    expect(decoder.hasPendingApprovals()).toBe(false);
    expect(resolutions).toEqual([
      {
        requestId: "r1",
        toolCallId: "c1",
        toolName: "bash",
        decision: "deny",
        reason: "Axle process stopped.",
      },
    ]);
  });

  it("denies a still-open approval when the turn ends with a result", () => {
    const resolutions: unknown[] = [];
    const decoder = makeAxleStreamDecoder({
      onApprovalResolved: (event) => resolutions.push(event),
    });
    decoder.push(
      '{"type":"approval.requested","requestId":"r1","toolCallId":"c1","toolName":"bash",' +
        '"arguments":{},"timeoutSeconds":60}\n{"type":"result","response":"Done"}\n',
    );

    expect(decoder.finish()).toEqual({ response: "Done" });
    expect(resolutions).toEqual([
      {
        requestId: "r1",
        toolCallId: "c1",
        toolName: "bash",
        decision: "deny",
        reason: "Axle ended before this approval was resolved.",
      },
    ]);
  });
});

describe("Axle approval presentation", () => {
  it("maps gated tools onto canonical request types", () => {
    expect(axleApprovalRequestType("bash")).toBe("command_execution_approval");
    expect(axleApprovalRequestType("Write")).toBe("apply_patch_approval");
    expect(axleApprovalRequestType("edit")).toBe("apply_patch_approval");
    expect(axleApprovalRequestType("mcp__github__create_issue")).toBe("dynamic_tool_call");
  });

  it("describes the pending action with the exact command or path", () => {
    expect(axleApprovalDetail("bash", { command: "pnpm test  " })).toBe("Terminal: pnpm test");
    expect(axleApprovalDetail("write", { path: "src/app.ts" })).toBe("Write file: src/app.ts");
    expect(axleApprovalDetail("read", {})).toBe("Read file requires approval");

    const capped = axleApprovalDetail("bash", { command: "x".repeat(300) });
    expect(capped.length).toBe(240);
    expect(capped.endsWith("\u2026")).toBe(true);
  });

  it("translates runtime verdicts into contract decisions", () => {
    expect(axleApprovalDecision("allow")).toBe("accept");
    expect(axleApprovalDecision("deny")).toBe("decline");
    expect(axleApprovalDecision("timeout")).toBe("decline");
  });
});

describe("Axle approval decision file", () => {
  it("writes per-thread decision records the runtime can match by request id", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "axle-approvals-"));
    try {
      const file = resetAxleApprovalFile(cwd, "thread-one");
      expect(NodeFS.readFileSync(file, "utf8")).toBe("");

      appendAxleApprovalResponse({
        cwd,
        threadId: "thread-one",
        requestId: "call-1:123",
        decision: "accept",
      });
      appendAxleApprovalResponse({
        cwd,
        threadId: "thread-one",
        requestId: "call-2:456",
        decision: "decline",
      });
      expect(NodeFS.readFileSync(file, "utf8")).toBe(
        '{"type":"approval_response","requestId":"call-1:123","decision":"accept"}\n' +
          '{"type":"approval_response","requestId":"call-2:456","decision":"decline"}\n',
      );

      resetAxleApprovalFile(cwd, "thread-one");
      expect(NodeFS.readFileSync(file, "utf8")).toBe("");
      expect(resetAxleApprovalFile(cwd, "thread-two")).not.toBe(file);
    } finally {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps the decision directory ignored by git", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "axle-approvals-"));
    try {
      resetAxleApprovalFile(cwd, "thread-one");
      expect(NodeFS.readFileSync(NodePath.join(cwd, ".gitignore"), "utf8")).toContain("/.axle/");
    } finally {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("makeAxleProcessArgs approval flag", () => {
  it("passes --approval-file only when a decision channel was prepared", () => {
    const base = {
      cwd: "C:\\workspace",
      prompt: "Run the tests",
      model: "openai/gpt-4o",
    };
    expect(makeAxleProcessArgs(base)).not.toContain("--approval-file");

    const args = makeAxleProcessArgs({
      ...base,
      approvalFile: "C:\\workspace\\.axle\\approvals\\thread.jsonl",
    });
    expect(args.at(args.indexOf("--approval-file") + 1)).toBe(
      "C:\\workspace\\.axle\\approvals\\thread.jsonl",
    );
  });
});
