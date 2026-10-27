// Deterministic runtime used by AxleAdapter.lifecycle.test.ts.
// Persists each prompt before provider output, just like the Rust agent loop.
// Supports both the one-shot prompt-stdin protocol and the persistent
// newline-delimited JSON protocol used by the desktop adapter.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const cwd = value("--cwd");
const persistent = args.includes("--persistent-json-stream");
const initialSessionId = args.includes("--session")
  ? value("--session")
  : "11111111-1111-4111-8111-111111111111";
let sessionId = initialSessionId;
const sessionFile = () => NodePath.join(cwd, ".axle", "sessions", `${sessionId}.jsonl`);
const callFile = NodePath.join(cwd, "runtime-calls.jsonl");
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const readHistory = () =>
  NodeFS.existsSync(sessionFile())
    ? NodeFS.readFileSync(sessionFile(), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
const firstCall = () => !NodeFS.existsSync(callFile);

const runTurn = (prompt, interactionMode) => {
  const isFirstCall = firstCall();
  NodeFS.mkdirSync(NodePath.dirname(sessionFile()), { recursive: true });
  NodeFS.appendFileSync(sessionFile(), `${JSON.stringify({ role: "user", text: prompt })}\n`);
  NodeFS.appendFileSync(
    callFile,
    `${JSON.stringify({ args, sessionId, prompt, interactionMode })}\n`,
  );
  emit({ type: "session", sessionId });

  if (isFirstCall && process.env.AXLE_TEST_FAIL_FIRST === "1") {
    process.stderr.write("ECONNRESET while contacting provider\n");
    process.exitCode = 1;
    return false;
  }
  if (prompt === "Wait until interrupted") {
    setInterval(() => {}, 1_000);
    return true;
  }
  const response = readHistory().some((message) => message.text.includes("amber-orchid"))
    ? "The earlier fact was amber-orchid."
    : "Remembered.";
  NodeFS.appendFileSync(
    sessionFile(),
    `${JSON.stringify({ role: "assistant", text: response })}\n`,
  );
  emit({ type: "delta", delta: response });
  emit({ type: "result", response, sessionId });
  return true;
};

if (!persistent) {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  const keepAlive = runTurn(prompt);
  // Simulate a provider/MCP resource holding the process open after its result.
  if (keepAlive) setInterval(() => {}, 1_000);
} else {
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line);
      if (typeof request.sessionId === "string") sessionId = request.sessionId;
      const keepAlive = runTurn(
        typeof request.prompt === "string" ? request.prompt : "",
        request.interactionMode,
      );
      if (!keepAlive) process.exit();
    }
  }
}
