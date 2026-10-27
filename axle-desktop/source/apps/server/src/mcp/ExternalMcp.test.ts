import type { McpServerConfig } from "@axle/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { callExternalMcpTool, listExternalMcpTools } from "./ExternalMcp.ts";

const encoder = new TextEncoder();

const config = {
  id: "mcp-test-server",
  name: "Test MCP",
  url: "https://mcp.example.test/rpc",
  authorizationToken: "secret-token",
  authorizationTokenRedacted: false,
  enabled: true,
} satisfies McpServerConfig;

const sseEvent = (payload: unknown): Uint8Array =>
  encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

const sseResponse = (chunks: ReadonlyArray<Uint8Array>, sessionId?: string): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
  });
};

const acceptedResponse = (): Response => new Response(null, { status: 202 });

const initializeResponse = (): Response =>
  sseResponse([sseEvent({ jsonrpc: "2.0", id: 1, result: {} })], "session-42");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("external MCP HTTP client", () => {
  it("reads SSE events across split UTF-8 chunks and skips keep-alive events", async () => {
    const toolName = "café ☕";
    const toolsEvent = encoder.encode(
      `: keep-alive\n\n${new TextDecoder().decode(
        sseEvent({
          jsonrpc: "2.0",
          id: 2,
          result: { tools: [{ name: toolName, inputSchema: { type: "object" } }] },
        }),
      )}`,
    );
    const splitAt = toolsEvent.findIndex((byte) => byte === 0xc3) + 1;
    expect(splitAt).toBeGreaterThan(0);

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(initializeResponse())
      .mockResolvedValueOnce(acceptedResponse())
      .mockResolvedValueOnce(
        sseResponse([
          toolsEvent.slice(0, splitAt),
          toolsEvent.slice(splitAt, splitAt + 1),
          toolsEvent.slice(splitAt + 1),
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listExternalMcpTools(config)).resolves.toEqual([
      { name: toolName, inputSchema: { type: "object" } },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const initializeCall = fetchMock.mock.calls[0]!;
    expect(initializeCall[1]?.headers).toMatchObject({
      authorization: "Bearer secret-token",
      accept: "application/json, text/event-stream",
    });
    const initializeBody = JSON.parse(String(initializeCall[1]?.body)) as {
      method?: string;
      params?: { clientInfo?: { name?: string } };
    };
    expect(initializeBody.method).toBe("initialize");
    expect(initializeBody.params?.clientInfo?.name).toBe("Axle");

    const listCall = fetchMock.mock.calls[2]!;
    expect(listCall[1]?.headers).toMatchObject({ "mcp-session-id": "session-42" });
    expect(JSON.parse(String(listCall[1]?.body))).toMatchObject({
      method: "tools/list",
      params: {},
    });
  });

  it("accepts a final SSE event without a trailing blank line", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(initializeResponse())
      .mockResolvedValueOnce(acceptedResponse())
      .mockResolvedValueOnce(
        sseResponse([
          encoder.encode(
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } })}`,
          ),
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listExternalMcpTools(config)).resolves.toEqual([]);
  });

  it("forwards tool calls with their arguments and returns the result", async () => {
    const result = {
      content: [{ type: "text", text: "café ready" }],
      isError: false,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(initializeResponse())
      .mockResolvedValueOnce(acceptedResponse())
      .mockResolvedValueOnce(sseResponse([sseEvent({ jsonrpc: "2.0", id: 3, result })]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(callExternalMcpTool(config, "brew", { size: "large" })).resolves.toEqual(result);

    const callBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as {
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    expect(callBody).toMatchObject({
      method: "tools/call",
      params: { name: "brew", arguments: { size: "large" } },
    });
  });
});
