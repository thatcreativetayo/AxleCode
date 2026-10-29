# Axle configuration

How to run and configure the `axle` runtime (the Rust binary in `crates/`) and
the desktop app that embeds it. For how the pieces fit together, see
[axle-architecture.md](./axle-architecture.md).

## Build and run the runtime

```powershell
# Build the CLI (debug)
cargo build -p axle_cli

# One-shot prompt against OpenAI (key from the environment)
$env:OPENAI_API_KEY = "sk-..."
cargo run -q -p axle_cli -- -p "summarize this repository"

# Interactive-style single turn in a specific workspace
cargo run -q -p axle_cli -- --cwd C:\work\project -p "run the tests"
```

The desktop app builds the same binary through its own toolchain; the desktop
guide lives in `axle-desktop/source/README.md`.

## Providers and API keys

Select a provider with `--provider <id>` (short `-r`) and a model with
`--model <id>` (short `-m`).

| Provider id | API key environment variable | Endpoint override | Default endpoint |
| --- | --- | --- | --- |
| `axle` | `AXLE_API_KEY` | `AXLE_BASE_URL` | `https://axle-gateway.axle-download-worker.workers.dev/v1` |
| `openai` (default) | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` | `https://api.anthropic.com/v1` |
| `gemini` | `GEMINI_API_KEY` | `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` |
| `openrouter` | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` | OpenRouter; sends Axle attribution headers |
| `fireworks` | `FIREWORKS_API_KEY` | `FIREWORKS_BASE_URL` | `https://api.fireworks.ai/inference/v1` |
| `cerebras` | `CEREBRAS_API_KEY` | `CEREBRAS_BASE_URL` | `https://api.cerebras.ai/v1` |
| `groq` | `GROQ_API_KEY` | `GROQ_BASE_URL` | `https://api.groq.com/openai/v1` |
| `mistral` | `MISTRAL_API_KEY` | `MISTRAL_BASE_URL` | `https://api.mistral.ai/v1` |
| `deepseek` | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` |
| `xai` | `XAI_API_KEY` | `XAI_BASE_URL` | `https://api.x.ai/v1`; alias `grok` |
| `ollama-cloud` | `OLLAMA_API_KEY` | `OLLAMA_CLOUD_BASE_URL` | alias `ollama_cloud` |
| `ollama` | none | `OLLAMA_LOCAL_BASE_URL` | local daemon; `http://localhost:11434/v1` |

Custom OpenAI-compatible endpoints use `--provider ollama --base-url <url>`
(keyless) or any provider id with `--base-url`. Localhost base URLs never
require an API key.

Every provider also reads its own `<PROVIDER>_BASE_URL` variable, so a
self-hosted or proxied gateway can be configured for one provider without
redirecting the others. `--base-url` still wins over the variable, and the
variable wins over the built-in default.

Any provider can take its key from `--api-key <KEY>` or the universal
`AXLE_API_KEY` fallback instead of its own variable; an explicit key wins over
both. This is what lets `--provider axle --base-url <gateway>` point at a
self-hosted or Axle-hosted OpenAI-compatible endpoint.

### Bring your own provider

A provider that is not in the table above is declared entirely through the
environment: set `<PREFIX>_BASE_URL` and `<PREFIX>_API_KEY`, plus optional
`<PREFIX>_LABEL` for the display name. The id is the lowercased prefix with
underscores as hyphens, so `NVIDIA_NIM_BASE_URL` and `NVIDIA_NIM_API_KEY`
produce model slugs like `nvidia-nim/meta/llama-3.1-70b-instruct`, and
`--provider nvidia-nim` resolves those variables again at generation time.
Hosted endpoints need a key; a localhost endpoint does not.

Prefixes owned by the built-in providers cannot be reused this way. For those,
`<PREFIX>_BASE_URL` only overrides the endpoint the vendor is already known to
serve. In the desktop app, Settings → Models → Custom providers writes exactly
these variables and probes the endpoint before listing its models.

### Endpoints that fingerprint their clients

A few OpenAI-compatible routers authorize requests by the client's `User-Agent`
rather than by the key alone, and answer `401 unauthorized client detected` for
a valid key sent without it. Those requirements live in the provider catalogue
(`packages/contracts/src/providerPresets.ts`), which is keyed by hostname, so
pasting a known base URL is enough: the desktop looks the endpoint up and writes
its headers to `<PREFIX>_HEADERS` as a JSON object of header name to value.

```sh
export AGENT_ROUTER_BASE_URL="https://agentrouter.org/v1"
export AGENT_ROUTER_API_KEY="<token>"
export AGENT_ROUTER_HEADERS='{"user-agent":"codex_cli_rs/0.47.0"}'
axle --provider agent-router --model claude-opus-5-5 -p "hello"
```

`<PREFIX>_HEADERS` also overrides a preset's own headers, and adding an entry to
the catalogue is a data edit with no code path to change.

The desktop model picker uses `provider/model` slugs (for example
`anthropic/claude-3-5-sonnet-latest`), split on the first `/`.

## CLI reference

### Input and workspace

| Flag | Meaning |
| --- | --- |
| `-p, --prompt <TEXT>` | Prompt to execute |
| `--prompt-stdin` | Read the prompt from stdin (conflicts with `--prompt`) |
| `-c, --cwd <PATH>` | Working directory (default `.`) |
| `--image-path <PATH>` / `--image-mime-type <MIME>` | Attach images (repeatable) |
| `--append-system-prompt <TEXT>` | Extra instructions appended to the built-in system prompt |
| `--no-workspace-context` (hidden) | Project-free chat; drops workspace tools |
| `--interaction-mode build|plan` | `plan` is read-only (default `build`) |
| `--context-window <N|k|m>` | Provider-advertised context window for compaction estimates |
| `--effort <LEVEL>` | Reasoning effort for models that support it |
| `--extension <PATH>` | Optional JS/TS extension file to load |

### Providers, sessions, output

| Flag | Meaning |
| --- | --- |
| `-r, --provider <ID>` / `-m, --model <ID>` | Provider and model selection |
| `--base-url <URL>` | Override the provider endpoint |
| `--api-key <KEY>` | API key override; wins over every `*_API_KEY` / `AXLE_API_KEY` variable |
| `--session <ID>` | Resume an existing session in the working directory |
| `--json` | One machine-readable JSON result on stdout |
| `--json-stream` | NDJSON event stream on stdout (the desktop boundary; see the architecture doc) |
| `--text-only` (hidden) | One provider-native generation with no tools or session |

### Approvals

| Flag | Meaning |
| --- | --- |
| `--approval-file <PATH>` | Enable the approval gate; decisions are read from this JSONL file |
| `--approval-timeout-seconds <N>` | Wait before denying (default 600) |

Decision lines are `{"type":"approval_response","requestId":"<id>","decision":"allow"}`.
`allow`/`approved`/`accept`/`accept_for_session` approve;
`deny`/`denied`/`decline`/`cancel` deny. See the architecture doc for the
request-id format and the desktop's per-thread file location.

### MCP and integrations

| Flag | Meaning |
| --- | --- |
| `--mcp-url <URL>` | HTTP MCP endpoint exposed as tools |
| `--mcp-bearer-token-env-var <VAR>` | Env var holding the bearer token |
| `--mcp-header-name <NAME>` + `--mcp-header-env-var <VAR>` | Custom auth header instead of bearer |
| `--mcp-stdio-program <PROGRAM>` / `--mcp-stdio-arg <ARG>` | Local stdio MCP server (repeat `--mcp-stdio-arg`) |
| `--github-mcp` | GitHub's hosted remote MCP server, using `GITHUB_PERSONAL_ACCESS_TOKEN` (or `GITHUB_TOKEN`) |

## Workspace files (`.axle/`)

Everything Axle persists lives under the working directory's `.axle/` folder,
which `axle_session` adds to `.gitignore` automatically.

| Path | Contents |
| --- | --- |
| `.axle/sessions/<id>.jsonl` | Durable session transcript (append-only, flushed per write) |
| `.axle/agents.toml` | Specialized agent profiles for `--agent <NAME>` |
| `.axle/approvals/<name>.jsonl` | Approval decisions (the desktop names files `<sha256(threadId)>.jsonl`) |
| `.axle/memories.json` | Project memory store (the global store lives outside the workspace; see the environment table) |
| `.axle/project-free-memory/memories.json` | Memory store for `--no-workspace-context` chats |

### Agent profiles (`.axle/agents.toml`)

```toml
[[agents]]
name = "code-reviewer"
description = "Read-only reviewer."
instructions = """
Review the code the user points you at. Report findings with file and line.
Never edit files.
"""
allowed_tools = ["read", "grep", "find", "ls", "web_search"]

[[agents]]
name = "claude-reviewer"
provider = "anthropic"
model = "claude-3-5-sonnet-latest"
allowed_tools = ["read", "grep", "find", "ls", "web_search"]
```

Fields: `name` (required), `description`, `instructions` (appended to the
system prompt), `provider` / `model` (override the CLI defaults when set), and
`allowed_tools` (empty or omitted means every tool). Unknown fields are
rejected at load time. The repository ships working examples in `.axle/agents.toml`.

## Environment variables

| Variable | Effect |
| --- | --- |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `FIREWORKS_API_KEY`, `CEREBRAS_API_KEY`, `GROQ_API_KEY`, `OLLAMA_API_KEY` | Provider credentials (see the table above) |
| `AXLE_API_KEY` | Universal fallback key for any provider, and the key for `--provider axle` |
| `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GEMINI_BASE_URL`, `OPENROUTER_BASE_URL`, `FIREWORKS_BASE_URL`, `CEREBRAS_BASE_URL`, `GROQ_BASE_URL`, `OLLAMA_CLOUD_BASE_URL`, `AXLE_BASE_URL` | Per-provider endpoint override (see the table above) |
| `<PREFIX>_LABEL` | Display name for a provider declared through `<PREFIX>_BASE_URL` |
| `<PREFIX>_HEADERS` | Extra request headers as a JSON object, for endpoints that fingerprint their clients. Filled in automatically when the base URL matches a catalogue preset, and overrides that preset when set |
| `GITHUB_PERSONAL_ACCESS_TOKEN` / `GITHUB_TOKEN` | Token for `--github-mcp` |
| `AXLE_SHELL` | Shell program the `bash` tool uses (overridden by `--shell`) |
| `AXLE_HOME` | Base directory for the global memory store (`<AXLE_HOME>/memory/memories.json`) |
| `AXLE_MEMORY_GLOBAL_DIR` | Directory holding the global `memories.json` (wins over `AXLE_HOME`) |

## Desktop configuration

- Model API keys are managed in the app under **Settings > Models** rather than
  environment variables; the server passes provider/model to the runtime as
  `--provider` / `--model`.
- Approval files are created per thread under the workspace and are
  gitignored; the web UI's Approve once / Always allow this session / Decline /
  Cancel turn actions map onto the decision values above.
- Environment forwarding (including into WSL) is implemented in
  `axle-desktop/source/apps/desktop/src/backend/DesktopBackendConfiguration.ts`.
- Deeper desktop documentation (remote access, CI, workspace layout) lives in
  `axle-desktop/source/docs/`.
