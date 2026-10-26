use axle_agent::{AgentLoop, AgentLoopOptions, ApprovalConfig, InteractionMode};
use axle_ai::{
    AnthropicProvider, AssistantMessageEvent, CompletionOptions, ContentPart, GeminiProvider,
    LlmProvider, Message, OpenAiProvider, OpenRouterProvider, DEFAULT_OPENROUTER_BASE_URL,
};
use axle_config::{AgentProfile, DEFAULT_CONTEXT_WINDOW_TOKENS};
use axle_extensions::{AxleEvent, EventBus, JsExtensionRunner};
use axle_memory::MemoryStore;
use axle_session::SessionManager;
use axle_tools::{
    is_hidden_control_tool, register_http_mcp_tools_with_header, register_stdio_mcp_tools,
    LocalExecutionTarget, ToolRegistry,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use clap::Parser;
use futures::StreamExt;
use std::env;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration as StdDuration;
use tokio::io::AsyncReadExt;
use tracing_subscriber::EnvFilter;

/// Axle's hosted gateway. The desktop app ships this base URL so every user
/// gets a working provider with an `AXLE_API_KEY`, instead of configuring a
/// vendor key of their own.
const DEFAULT_AXLE_BASE_URL: &str = "https://axle-gateway.axle-download-worker.workers.dev/v1";

/// Axle's own provider is preconfigured, so a user who has not minted an Axle
/// API key still gets a working provider. The hosted gateway hashes any bearer
/// token into the anonymous identity that carries the free daily credit grant,
/// and a real `AXLE_API_KEY` always takes precedence over this fallback.
const DEFAULT_AXLE_API_KEY: &str = "axle-desktop-free";

#[derive(Parser, Debug)]
#[command(name = "axle")]
#[command(about = "Axle AI Coding Agent", long_about = None)]
struct Cli {
    #[arg(short, long, help = "Prompt to execute directly")]
    prompt: Option<String>,

    #[arg(long, conflicts_with = "prompt", help = "Read the prompt from stdin")]
    prompt_stdin: bool,

    #[arg(long = "image-path", value_name = "PATH")]
    image_paths: Vec<String>,

    #[arg(long = "image-mime-type", value_name = "MIME")]
    image_mime_types: Vec<String>,

    #[arg(
        long,
        hide = true,
        help = "Run one provider-native text generation without agent tools or session state"
    )]
    text_only: bool,

    #[arg(long, help = "Reasoning effort for models that support it")]
    effort: Option<String>,

    #[arg(
        long,
        value_parser = ["build", "plan"],
        default_value = "build",
        help = "Interaction policy: build may modify the workspace, plan is read-only"
    )]
    interaction_mode: String,

    #[arg(
        long,
        value_parser = ["approval-required", "auto-accept-edits", "full-access"],
        help = "Tool approval policy; supervised modes require --approval-file"
    )]
    runtime_mode: Option<String>,

    #[arg(
        long,
        help = "File used to answer tool approval requests; enables approval mode"
    )]
    approval_file: Option<String>,

    #[arg(
        long,
        default_value_t = 600,
        help = "Seconds to wait for an approval decision before the tool is denied"
    )]
    approval_timeout_seconds: u64,

    #[arg(
        long,
        help = "Provider-advertised context window, in tokens or k/m notation"
    )]
    context_window: Option<String>,

    #[arg(
        short = 'r',
        long,
        default_value = "openai",
        help = "Model API: axle, openai, anthropic, gemini, fireworks, ollama-cloud, cerebras, groq, openrouter, mistral, deepseek, xai, ollama"
    )]
    provider: String,

    #[arg(
        short,
        long,
        default_value = "gpt-4o",
        help = "Model ID to use (e.g. gpt-4o, claude-3-5-sonnet-latest, gemini-1.5-pro)"
    )]
    model: String,

    #[arg(short, long, default_value = ".", help = "Working directory path")]
    cwd: String,

    #[arg(
        long,
        value_name = "PROGRAM",
        conflicts_with = "no_workspace_context",
        help = "Shell program the bash tool runs local commands with (e.g. powershell, pwsh, bash, cmd); falls back to AXLE_SHELL, then the platform default"
    )]
    shell: Option<String>,

    #[arg(
        long,
        hide = true,
        help = "Disable project/workspace context for a project-free chat"
    )]
    no_workspace_context: bool,

    #[arg(long, help = "Custom Base URL for OpenAI/Ollama-compatible provider")]
    base_url: Option<String>,

    #[arg(
        long,
        value_name = "KEY",
        help = "API key for the selected provider; overrides the provider's *_API_KEY environment variable"
    )]
    api_key: Option<String>,

    #[arg(short, long, help = "Optional JS/TS extension file path to load")]
    extension: Option<String>,

    #[arg(long, help = "Write one machine-readable JSON result to stdout")]
    json: bool,

    #[arg(long, help = "Write newline-delimited JSON token events to stdout")]
    json_stream: bool,

    #[arg(
        long,
        help = "Resume an existing Axle session in the working directory"
    )]
    session: Option<String>,

    #[arg(long, help = "Instructions appended to Axle's built-in system prompt")]
    append_system_prompt: Option<String>,

    #[arg(
        long,
        value_name = "NAME",
        conflicts_with = "no_workspace_context",
        help = "Specialized agent profile from .axle/agents.toml (instructions, provider/model preference, allowed tools)"
    )]
    agent: Option<String>,

    #[arg(long, help = "HTTP MCP endpoint to expose as agent tools")]
    mcp_url: Option<String>,

    #[arg(
        long,
        requires = "mcp_url",
        help = "Environment variable containing the bearer token for --mcp-url"
    )]
    mcp_bearer_token_env_var: Option<String>,

    #[arg(
        long,
        requires = "mcp_header_env_var",
        requires = "mcp_url",
        conflicts_with = "mcp_bearer_token_env_var",
        help = "Custom HTTP MCP authentication header name"
    )]
    mcp_header_name: Option<String>,

    #[arg(
        long,
        requires = "mcp_header_name",
        requires = "mcp_url",
        conflicts_with = "mcp_bearer_token_env_var",
        help = "Environment variable containing a custom HTTP MCP header value"
    )]
    mcp_header_env_var: Option<String>,

    #[arg(
        long,
        value_name = "PROGRAM",
        conflicts_with = "no_workspace_context",
        help = "Local stdio MCP server program to expose as agent tools (e.g. npx)"
    )]
    mcp_stdio_program: Option<String>,

    #[arg(
        long,
        value_name = "ARG",
        requires = "mcp_stdio_program",
        allow_hyphen_values = true,
        help = "Argument passed to --mcp-stdio-program; repeat for multiple arguments"
    )]
    mcp_stdio_arg: Vec<String>,

    #[arg(
        long,
        conflicts_with = "no_workspace_context",
        help = "Register GitHub's remote MCP server tools using GITHUB_PERSONAL_ACCESS_TOKEN (or GITHUB_TOKEN)"
    )]
    github_mcp: bool,
}

fn write_json_line(value: serde_json::Value) {
    println!("{}", value);
    let _ = io::stdout().flush();
}

fn required_api_key(variable: &str) -> anyhow::Result<String> {
    let value = env::var(variable).unwrap_or_default().trim().to_string();
    anyhow::ensure!(
        !value.is_empty(),
        "ERROR: {} environment variable is not set. Set it before running axle.",
        variable
    );
    Ok(value)
}

/// Resolve a provider API key: an explicit `--api-key` wins, then the
/// provider's own environment variable, then `AXLE_API_KEY` as a universal
/// fallback. The fallback lets the Axle hosted gateway (and any other
/// OpenAI-compatible endpoint) work without a vendor-specific variable.
fn resolve_api_key(explicit: Option<&str>, variable: &str) -> anyhow::Result<String> {
    if let Some(value) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        return Ok(value.to_owned());
    }
    if let Ok(value) = env::var(variable) {
        let value = value.trim();
        if !value.is_empty() {
            return Ok(value.to_owned());
        }
    }
    if variable != "AXLE_API_KEY" {
        if let Ok(value) = env::var("AXLE_API_KEY") {
            let value = value.trim();
            if !value.is_empty() {
                return Ok(value.to_owned());
            }
        }
    }
    anyhow::bail!(
        "ERROR: {} environment variable is not set. Set it, pass --api-key, or set AXLE_API_KEY before running axle.",
        variable
    )
}

/// Resolve a provider endpoint: `--base-url` wins, then the provider's own
/// `<PROVIDER>_BASE_URL` variable, then the built-in default. The env fallback
/// is what lets the desktop point one provider instance at a custom or
/// self-hosted gateway without a new command-line flag — and, because the
/// variable is provider-scoped, without redirecting the other providers.
fn configured_base_url(cli_value: Option<&str>, default: &str, variable: &str) -> String {
    cli_value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            env::var(variable)
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| default.to_string())
}

/// Resolve the credential Axle's own provider authenticates with.
///
/// The hosted gateway is part of the product rather than an endpoint the user
/// brought, so it falls back to the built-in token and stays usable before the
/// user has minted an Axle API key. Any other endpoint is one the user pointed
/// `AXLE_BASE_URL` at, and that one still needs a key of their own.
fn resolve_axle_api_key(explicit: Option<&str>, base_url: &str) -> anyhow::Result<String> {
    match resolve_api_key(explicit, "AXLE_API_KEY") {
        Ok(key) => Ok(key),
        Err(error) => {
            if base_url.trim_end_matches('/') == DEFAULT_AXLE_BASE_URL {
                Ok(DEFAULT_AXLE_API_KEY.to_string())
            } else {
                Err(error)
            }
        }
    }
}

/// `--agent` naming a specific provider/model wins over the CLI defaults;
/// either side falls back to the other so both refs stay valid.
fn resolve_provider_and_model(provider: Option<&str>, model: Option<&str>) -> (String, String) {
    (
        provider
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("openai")
            .to_string(),
        model
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("gpt-4o")
            .to_string(),
    )
}

/// Environment variable prefix for a provider id: `nvidia-nim` -> `NVIDIA_NIM`.
///
/// The desktop stores every provider the user brings themselves as a
/// `<PREFIX>_BASE_URL` / `<PREFIX>_API_KEY` pair, so the id carried by the
/// model slug (`<id>/<model>`) is all the runtime needs to route a turn.
fn provider_env_prefix(provider: &str) -> String {
    provider
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect()
}

/// A local server never needs a credential, which is why the OpenAI-compatible
/// provider drops its key requirement for loopback endpoints.
fn is_localhost_url(url: &str) -> bool {
    url.contains("localhost") || url.contains("127.0.0.1") || url.contains("[::1]")
}

fn non_empty_env(variable: &str) -> Option<String> {
    env::var(variable)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// Extra request headers for a provider, from `<PREFIX>_HEADERS`.
///
/// A few OpenAI-compatible routers authorize by client fingerprint rather than
/// by the key alone, and the desktop records the headers an endpoint insists on
/// in this variable. The value is a flat JSON object of header name to string;
/// malformed input is ignored so a bad variable cannot break a turn.
fn provider_headers(prefix: &str) -> Vec<(String, String)> {
    let Some(value) = non_empty_env(&format!("{prefix}_HEADERS")) else {
        return Vec::new();
    };
    let Ok(serde_json::Value::Object(headers)) = serde_json::from_str::<serde_json::Value>(&value)
    else {
        return Vec::new();
    };
    headers
        .into_iter()
        .filter_map(|(name, value)| {
            let name = name.trim().to_owned();
            let value = value.as_str()?.to_owned();
            (!name.is_empty()).then_some((name, value))
        })
        .collect()
}

/// Build a provider for a user-supplied OpenAI-compatible endpoint.
///
/// The endpoint comes from `--base-url` or the provider's own
/// `<PREFIX>_BASE_URL`; the key comes from `--api-key`, `<PREFIX>_API_KEY`, or
/// the universal `AXLE_API_KEY`; and any extra request headers come from
/// `<PREFIX>_HEADERS`. An unknown id with no `<PREFIX>_BASE_URL` keeps the
/// historical OpenAI default so existing invocations do not change behavior.
fn custom_provider(
    provider: &str,
    cli_api_key: Option<&str>,
    cli_base_url: Option<&str>,
) -> anyhow::Result<Arc<dyn LlmProvider>> {
    let prefix = provider_env_prefix(provider);
    let base_variable = format!("{prefix}_BASE_URL");
    let key_variable = format!("{prefix}_API_KEY");
    let endpoint = cli_base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| non_empty_env(&base_variable));

    let Some(endpoint) = endpoint else {
        let key = resolve_api_key(cli_api_key, "OPENAI_API_KEY")?;
        let base_url =
            configured_base_url(cli_base_url, "https://api.openai.com/v1", "OPENAI_BASE_URL");
        return Ok(Arc::new(OpenAiProvider::new(key, Some(base_url))));
    };

    let key = match resolve_api_key(cli_api_key, &key_variable) {
        Ok(key) => key,
        Err(error) => {
            if is_localhost_url(&endpoint) {
                String::new()
            } else {
                return Err(error);
            }
        }
    };
    // The provider name and label are `&'static str` because they are identity
    // strings shared with retry and error reporting. Providers are built once
    // per process, so leaking the custom id here is bounded and intentional.
    let label: &'static str = Box::leak(prefix.to_lowercase().into_boxed_str());
    Ok(Arc::new(OpenAiProvider::new_named_with_headers(
        key,
        Some(endpoint),
        key_variable,
        label,
        label,
        provider_headers(&prefix),
    )))
}

/// Merge `--append-system-prompt` with the selected agent's instructions. The
/// agent text is rendered as a `<agent_profile>` block by `AgentProfile`.
fn compose_append_prompt(
    cli_append: Option<&str>,
    profile: Option<&AgentProfile>,
) -> Option<String> {
    match (cli_append, profile) {
        (Some(existing), Some(profile)) => {
            Some(format!("{existing}\n{}", profile.system_prompt_fragment()))
        }
        (Some(existing), None) => Some(existing.to_string()),
        (None, Some(profile)) => Some(profile.system_prompt_fragment()),
        (None, None) => None,
    }
}

fn parse_context_window_tokens(value: Option<&str>) -> anyhow::Result<Option<usize>> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let normalized = value.to_ascii_lowercase().replace(',', "");
    let (number, multiplier) = if let Some(number) = normalized.strip_suffix('b') {
        (number, 1_000_000_000_f64)
    } else if let Some(number) = normalized.strip_suffix('m') {
        (number, 1_000_000_f64)
    } else if let Some(number) = normalized.strip_suffix('k') {
        (number, 1_000_f64)
    } else if let Some(number) = normalized.strip_suffix("tokens") {
        (number, 1_f64)
    } else {
        (normalized.as_str(), 1_f64)
    };
    let amount: f64 = number
        .trim()
        .parse()
        .map_err(|_| anyhow::anyhow!("Invalid context window '{value}'"))?;
    let tokens = amount * multiplier;
    anyhow::ensure!(
        tokens.is_finite() && tokens > 0.0 && tokens.fract() == 0.0,
        "Context window must be a positive whole number of tokens"
    );
    anyhow::ensure!(
        tokens <= usize::MAX as f64,
        "Context window is too large for this platform"
    );
    Ok(Some(tokens as usize))
}

fn write_stream_event(event: &AssistantMessageEvent) {
    match event {
        AssistantMessageEvent::TextDelta(delta) => {
            write_json_line(serde_json::json!({ "type": "delta", "delta": delta }));
        }
        AssistantMessageEvent::ThinkingDelta(delta) => {
            write_json_line(serde_json::json!({ "type": "thinking_delta", "delta": delta }));
        }
        _ => {}
    }
}

async fn run_text_only(
    provider: Arc<dyn LlmProvider>,
    cli: &Cli,
    model: &str,
) -> anyhow::Result<()> {
    let prompt = if cli.prompt_stdin {
        let mut prompt = String::new();
        tokio::io::stdin().read_to_string(&mut prompt).await?;
        anyhow::ensure!(!prompt.trim().is_empty(), "Prompt stdin was empty");
        prompt
    } else {
        cli.prompt.clone().unwrap_or_default()
    };
    anyhow::ensure!(!prompt.trim().is_empty(), "Prompt was empty");

    let mut user_content = vec![ContentPart::Text { text: prompt }];
    user_content.extend(load_image_parts(&cli.image_paths, &cli.image_mime_types).await?);
    let capabilities = provider.capabilities(model);
    let messages = vec![
        Message::system(
            "You are Axle's concise text-generation helper. Follow the requested output format exactly. Do not use tools or explain your work.",
        ),
        Message::user_with_content(user_content),
    ];
    let options = CompletionOptions {
        model: model.to_string(),
        temperature: if capabilities.supports_temperature {
            Some(0.2)
        } else {
            None
        },
        max_tokens: Some(64),
        reasoning_effort: if capabilities.supports_reasoning_effort {
            cli.effort.clone()
        } else {
            None
        },
        tools: Vec::new(),
        ..Default::default()
    };
    let mut stream = provider.stream(&messages, &options).await?;
    let mut response = String::new();

    while let Some(event) = stream.next().await {
        match event {
            AssistantMessageEvent::TextDelta(delta) => {
                if cli.json_stream {
                    write_json_line(serde_json::json!({
                        "type": "delta",
                        "delta": delta,
                    }));
                }
                response.push_str(&delta);
            }
            AssistantMessageEvent::ThinkingDelta(delta) => {
                if cli.json_stream {
                    write_json_line(serde_json::json!({
                        "type": "thinking_delta",
                        "delta": delta,
                    }));
                }
            }
            AssistantMessageEvent::Done { usage } => {
                if cli.json_stream {
                    if let Some(usage) = usage {
                        write_json_line(serde_json::json!({
                            "type": "usage",
                            "promptTokens": usage.prompt_tokens,
                            "completionTokens": usage.completion_tokens,
                            "totalTokens": usage.total_tokens,
                            "cumulativeTotalTokens": usage.total_tokens,
                        }));
                    }
                }
            }
            AssistantMessageEvent::Error(error) => anyhow::bail!(error),
            AssistantMessageEvent::ToolCallDelta { .. }
            | AssistantMessageEvent::ProviderState(_) => {}
        }
    }

    anyhow::ensure!(
        !response.trim().is_empty(),
        "Provider returned an empty text-generation response"
    );
    if cli.json_stream {
        write_json_line(serde_json::json!({
            "type": "result",
            "response": response,
        }));
    } else if cli.json {
        println!("{}", serde_json::json!({ "response": response }));
    } else {
        println!("{}", response);
    }
    Ok(())
}

fn resolve_approval_config(cli: &Cli) -> anyhow::Result<Option<ApprovalConfig>> {
    // With no explicit mode, preserve the standalone CLI's existing contract:
    // supplying an approval file enables supervision; omitting it does not.
    if cli.runtime_mode.as_deref() == Some("full-access") {
        return Ok(None);
    }
    let file = cli
        .approval_file
        .as_deref()
        .filter(|file| !file.trim().is_empty());
    if cli.runtime_mode.is_some() && file.is_none() {
        anyhow::bail!(
            "--runtime-mode {} requires --approval-file",
            cli.runtime_mode.as_deref().unwrap()
        );
    }
    Ok(file.map(|file| ApprovalConfig {
        file: PathBuf::from(file),
        timeout: StdDuration::from_secs(cli.approval_timeout_seconds),
        auto_accept_edits: cli.runtime_mode.as_deref() == Some("auto-accept-edits"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_modes_require_a_channel_without_changing_legacy_defaults() {
        assert!(
            resolve_approval_config(&Cli::try_parse_from(["axle"]).unwrap())
                .unwrap()
                .is_none()
        );
        let legacy = Cli::try_parse_from(["axle", "--approval-file", "approval.jsonl"]).unwrap();
        assert!(
            !resolve_approval_config(&legacy)
                .unwrap()
                .unwrap()
                .auto_accept_edits
        );
        for mode in ["approval-required", "auto-accept-edits"] {
            let missing = Cli::try_parse_from(["axle", "--runtime-mode", mode]).unwrap();
            assert!(resolve_approval_config(&missing)
                .unwrap_err()
                .to_string()
                .contains("requires --approval-file"));
            let configured = Cli::try_parse_from([
                "axle",
                "--runtime-mode",
                mode,
                "--approval-file",
                "approval.jsonl",
            ])
            .unwrap();
            assert_eq!(
                resolve_approval_config(&configured)
                    .unwrap()
                    .unwrap()
                    .auto_accept_edits,
                mode == "auto-accept-edits"
            );
        }
        let full = Cli::try_parse_from([
            "axle",
            "--runtime-mode",
            "full-access",
            "--approval-file",
            "approval.jsonl",
        ])
        .unwrap();
        assert!(resolve_approval_config(&full).unwrap().is_none());
        assert!(Cli::try_parse_from(["axle", "--runtime-mode", "unknown-mode"]).is_err());
    }

    #[test]
    fn api_key_resolution_prefers_explicit_then_provider_then_axle_fallback() {
        let provider_var = "AXLE_TEST_PROVIDER_API_KEY";
        let saved_provider = env::var(provider_var).ok();
        let saved_axle = env::var("AXLE_API_KEY").ok();
        let restore = |name: &str, saved: Option<String>| match saved {
            Some(value) => env::set_var(name, value),
            None => env::remove_var(name),
        };

        env::remove_var(provider_var);
        env::remove_var("AXLE_API_KEY");
        let error = resolve_api_key(None, provider_var).expect_err("missing key must fail");
        assert!(error.to_string().contains(provider_var));

        env::set_var("AXLE_API_KEY", "axle-fallback");
        assert_eq!(
            resolve_api_key(None, provider_var).unwrap(),
            "axle-fallback"
        );

        env::set_var(provider_var, "provider-specific");
        assert_eq!(
            resolve_api_key(None, provider_var).unwrap(),
            "provider-specific"
        );

        assert_eq!(
            resolve_api_key(Some("explicit"), provider_var).unwrap(),
            "explicit"
        );
        assert_eq!(
            resolve_api_key(Some("   "), provider_var).unwrap(),
            "provider-specific"
        );

        restore(provider_var, saved_provider);
        restore("AXLE_API_KEY", saved_axle);
    }

    #[test]
    fn axle_hosted_endpoint_falls_back_to_the_built_in_credential() {
        let saved_axle = env::var("AXLE_API_KEY").ok();
        env::remove_var("AXLE_API_KEY");
        let restore = || match saved_axle.clone() {
            Some(value) => env::set_var("AXLE_API_KEY", value),
            None => env::remove_var("AXLE_API_KEY"),
        };

        // Axle ships its own provider, so the hosted gateway works with no
        // key, including when the configured URL carries a trailing slash.
        assert_eq!(
            resolve_axle_api_key(None, DEFAULT_AXLE_BASE_URL).unwrap(),
            DEFAULT_AXLE_API_KEY
        );
        assert_eq!(
            resolve_axle_api_key(None, &format!("{DEFAULT_AXLE_BASE_URL}/")).unwrap(),
            DEFAULT_AXLE_API_KEY
        );

        // A self-hosted endpoint is the user's own, and still needs their key.
        let error = resolve_axle_api_key(None, "https://gateway.example/v1")
            .expect_err("a self-hosted endpoint must require a key");
        assert!(error.to_string().contains("AXLE_API_KEY"));

        // An explicit or configured key always beats the fallback.
        assert_eq!(
            resolve_axle_api_key(Some("axl_test_key"), DEFAULT_AXLE_BASE_URL).unwrap(),
            "axl_test_key"
        );
        env::set_var("AXLE_API_KEY", "account-key");
        assert_eq!(
            resolve_axle_api_key(None, DEFAULT_AXLE_BASE_URL).unwrap(),
            "account-key"
        );

        restore();
    }

    #[test]
    fn provider_env_prefix_maps_ids_to_variables() {
        assert_eq!(provider_env_prefix("nvidia-nim"), "NVIDIA_NIM");
        assert_eq!(provider_env_prefix("nvidia_nim"), "NVIDIA_NIM");
        assert_eq!(provider_env_prefix("NVIDIA"), "NVIDIA");
        assert_eq!(provider_env_prefix("my.gateway"), "MY_GATEWAY");
    }

    #[test]
    fn custom_provider_uses_its_own_base_url_and_key_variables() {
        let base_var = "AXLE_TEST_CUSTOM_BASE_URL";
        let key_var = "AXLE_TEST_CUSTOM_API_KEY";
        let saved_base = env::var(base_var).ok();
        let saved_key = env::var(key_var).ok();

        env::remove_var(base_var);
        env::remove_var(key_var);

        // An id that brings no endpoint of its own keeps the OpenAI default.
        let fallback = custom_provider("axle-test-custom", Some("explicit"), None).unwrap();
        assert_eq!(fallback.provider_name(), "openai");

        // With an endpoint configured the id routes to its own provider, and
        // the dash in the id maps onto the underscore in the variable names.
        env::set_var(base_var, "https://integrate.api.example/v1");
        env::set_var(key_var, "nvapi-test");
        let configured = custom_provider("axle-test-custom", None, None).unwrap();
        assert_eq!(configured.provider_name(), "axle_test_custom");

        match saved_base {
            Some(value) => env::set_var(base_var, value),
            None => env::remove_var(base_var),
        }
        match saved_key {
            Some(value) => env::set_var(key_var, value),
            None => env::remove_var(key_var),
        }
    }

    #[test]
    fn provider_headers_reads_the_json_object_and_ignores_junk() {
        let prefix = "AXLE_TEST_PRESET";
        let variable = "AXLE_TEST_PRESET_HEADERS";
        let saved = env::var(variable).ok();

        env::remove_var(variable);
        assert!(provider_headers(prefix).is_empty());

        // A variable that is not a JSON object yields no headers rather than
        // failing the turn.
        env::set_var(variable, "codex_cli_rs/0.47.0");
        assert!(provider_headers(prefix).is_empty());

        // Only string values survive; a numeric value is dropped.
        env::set_var(
            variable,
            r#"{"user-agent":"codex_cli_rs/0.47.0","x-retries":3}"#,
        );
        assert_eq!(
            provider_headers(prefix),
            vec![("user-agent".to_owned(), "codex_cli_rs/0.47.0".to_owned())]
        );

        match saved {
            Some(value) => env::set_var(variable, value),
            None => env::remove_var(variable),
        }
    }

    #[test]
    fn base_url_resolution_prefers_flag_then_provider_env_then_default() {
        let variable = "AXLE_TEST_PROVIDER_BASE_URL";
        let saved = env::var(variable).ok();
        let restore = || match saved {
            Some(ref value) => env::set_var(variable, value),
            None => env::remove_var(variable),
        };

        env::remove_var(variable);
        assert_eq!(
            configured_base_url(None, "https://default.example/v1", variable),
            "https://default.example/v1"
        );

        env::set_var(variable, "https://gateway.example/v1");
        assert_eq!(
            configured_base_url(None, "https://default.example/v1", variable),
            "https://gateway.example/v1"
        );

        // The explicit flag still wins over the environment.
        assert_eq!(
            configured_base_url(
                Some("https://flag.example/v1"),
                "https://default.example/v1",
                variable
            ),
            "https://flag.example/v1"
        );

        // A different provider's variable must not leak into this one.
        env::set_var("AXLE_OTHER_PROVIDER_BASE_URL", "https://other.example/v1");
        assert_eq!(
            configured_base_url(None, "https://default.example/v1", variable),
            "https://gateway.example/v1"
        );
        env::remove_var("AXLE_OTHER_PROVIDER_BASE_URL");

        restore();
    }

    fn profile(provider: Option<&str>, model: Option<&str>) -> AgentProfile {
        AgentProfile {
            name: "test-agent".to_string(),
            description: "Test agent".to_string(),
            instructions: "Follow the test instructions.".to_string(),
            provider: provider.map(ToOwned::to_owned),
            model: model.map(ToOwned::to_owned),
            allowed_tools: Vec::new(),
            workflow: Default::default(),
        }
    }

    #[test]
    fn profile_provider_and_model_win_when_set() {
        let profile = profile(Some("anthropic"), Some("claude-3-5-sonnet-latest"));

        let (provider, model) = resolve_provider_and_model(
            profile.provider.as_deref().or(Some("openai")),
            profile.model.as_deref().or(Some("gpt-4o")),
        );

        assert_eq!(provider, "anthropic");
        assert_eq!(model, "claude-3-5-sonnet-latest");
    }

    #[test]
    fn cli_provider_and_model_fill_gaps_in_the_profile() {
        let profile = profile(None, Some("claude-3-5-sonnet-latest"));

        let (provider, model) = resolve_provider_and_model(
            profile.provider.as_deref().or(Some("gemini")),
            profile.model.as_deref().or(Some("gemini-1.5-pro")),
        );

        assert_eq!(provider, "gemini");
        assert_eq!(model, "claude-3-5-sonnet-latest");
    }

    #[test]
    fn missing_everything_falls_back_to_openai_defaults() {
        let (provider, model) = resolve_provider_and_model(None, None);

        assert_eq!(provider, "openai");
        assert_eq!(model, "gpt-4o");
    }

    #[test]
    fn append_prompt_keeps_existing_instructions_and_adds_the_profile_block() {
        let profile = profile(Some("anthropic"), None);

        let combined = compose_append_prompt(Some("Always answer in French."), Some(&profile))
            .expect("combined prompt");
        assert!(combined.starts_with("Always answer in French."));
        assert!(combined.contains("<agent_profile name=\"test-agent\">"));
        assert!(combined.contains("Follow the test instructions."));

        let profile_only = compose_append_prompt(None, Some(&profile)).expect("profile only");
        assert!(profile_only.starts_with("<agent_profile"));

        let cli_only = compose_append_prompt(Some("Keep it short."), None).expect("cli only");
        assert_eq!(cli_only, "Keep it short.");

        assert!(compose_append_prompt(None, None).is_none());
    }
}

struct ProgressIndicator {
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl ProgressIndicator {
    fn start() -> Self {
        eprint!("Axle is working");
        let _ = io::stderr().flush();
        let (stop, mut stopped) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(750));
            interval.tick().await;
            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        eprint!(".");
                        let _ = io::stderr().flush();
                    }
                    _ = &mut stopped => break,
                }
            }
        });
        Self {
            stop: Some(stop),
            task: Some(task),
        }
    }

    async fn finish(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
        eprintln!();
    }
}

impl Drop for ProgressIndicator {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            task.abort();
            eprintln!();
        }
    }
}

async fn run_prompt(
    agent_loop: &AgentLoop,
    session: &mut SessionManager,
    prompt: &str,
    images: Vec<ContentPart>,
    json_stream: bool,
    show_progress: bool,
) -> anyhow::Result<String> {
    let progress = show_progress.then(ProgressIndicator::start);
    let result = if json_stream {
        agent_loop
            .run_turn_streaming_with_images(prompt, images, session, write_stream_event)
            .await
    } else {
        agent_loop
            .run_turn_with_images(prompt, images, session)
            .await
    };
    if let Some(progress) = progress {
        progress.finish().await;
    }
    result
}

async fn load_image_parts(
    paths: &[String],
    mime_types: &[String],
) -> anyhow::Result<Vec<ContentPart>> {
    anyhow::ensure!(
        paths.len() == mime_types.len(),
        "Each --image-path must have a matching --image-mime-type"
    );
    let mut images = Vec::with_capacity(paths.len());
    for (path, mime_type) in paths.iter().zip(mime_types) {
        let bytes = tokio::fs::read(path).await?;
        anyhow::ensure!(!bytes.is_empty(), "Image attachment '{}' is empty", path);
        images.push(ContentPart::Image {
            data: BASE64_STANDARD.encode(bytes),
            mime_type: mime_type.clone(),
        });
    }
    Ok(images)
}

fn write_result(cli: &Cli, result: &str, session_id: &str) {
    if cli.json_stream {
        write_json_line(serde_json::json!({
            "type": "result",
            "response": result,
            "sessionId": session_id,
        }));
    } else if cli.json {
        println!(
            "{}",
            serde_json::json!({
                "response": result,
                "sessionId": session_id,
            })
        );
    } else {
        println!("\nAxle Response:\n{}", result);
    }
}

fn output_snippet(output: &str, max_bytes: usize) -> &str {
    if output.len() <= max_bytes {
        return output;
    }
    let mut boundary = max_bytes;
    while boundary > 0 && !output.is_char_boundary(boundary) {
        boundary -= 1;
    }
    &output[..boundary]
}

fn format_duration_ms(duration_ms: u64) -> String {
    if duration_ms < 1_000 {
        format!("{}ms", duration_ms)
    } else if duration_ms < 60_000 {
        format!("{:.1}s", duration_ms as f64 / 1_000.0)
    } else {
        format!("{:.1}m", duration_ms as f64 / 60_000.0)
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();

    let cli = Cli::parse();
    // Reject an incomplete permission policy before provider setup, session
    // creation, or any tool work. Never degrade supervised execution to full access.
    let approval = resolve_approval_config(&cli)?;

    if !cli.json && !cli.json_stream {
        tracing_subscriber::fmt()
            .with_env_filter(EnvFilter::from_default_env().add_directive("axle=info".parse()?))
            .init();
    }

    // A specialized agent profile is workspace configuration, so it loads
    // before provider construction: the profile can prefer a provider/model,
    // and an unknown name must fail before any network setup.
    let cli_append_prompt = cli.append_system_prompt.clone();
    let cli_provider = cli.provider.clone();
    let cli_model = cli.model.clone();
    let agent_profile: Option<AgentProfile> = match cli.agent.as_deref() {
        Some(name) => {
            let config = axle_config::AgentsConfig::load(&cli.cwd)?;
            let profile = config.get(name).cloned().ok_or_else(|| {
                anyhow::anyhow!(
                    "--agent '{name}' is not defined in {}",
                    Path::new(&cli.cwd)
                        .join(axle_config::AGENT_PROFILES_RELATIVE_PATH)
                        .display()
                )
            })?;
            tracing::info!(
                agent = %profile.name,
                provider = profile.provider.as_deref().unwrap_or("cli default"),
                model = profile.model.as_deref().unwrap_or("cli default"),
                allowed_tools = profile.allowed_tools.len(),
                "Specialized agent profile loaded"
            );
            Some(profile)
        }
        None => None,
    };
    let (effective_provider, effective_model) = resolve_provider_and_model(
        agent_profile
            .as_ref()
            .and_then(|profile| profile.provider.as_deref())
            .or(Some(cli_provider.as_str())),
        agent_profile
            .as_ref()
            .and_then(|profile| profile.model.as_deref())
            .or(Some(cli_model.as_str())),
    );
    let effective_append_prompt =
        compose_append_prompt(cli_append_prompt.as_deref(), agent_profile.as_ref());

    let provider: Arc<dyn LlmProvider> = match effective_provider.to_lowercase().as_str() {
        "anthropic" => {
            let key = resolve_api_key(cli.api_key.as_deref(), "ANTHROPIC_API_KEY")?;
            let base_url = configured_base_url(
                cli.base_url.as_deref(),
                "https://api.anthropic.com/v1",
                "ANTHROPIC_BASE_URL",
            );
            Arc::new(AnthropicProvider::new(key, Some(base_url)))
        }
        "gemini" | "google" => {
            let key = resolve_api_key(cli.api_key.as_deref(), "GEMINI_API_KEY")?;
            let base_url = configured_base_url(
                cli.base_url.as_deref(),
                "https://generativelanguage.googleapis.com/v1beta",
                "GEMINI_BASE_URL",
            );
            Arc::new(GeminiProvider::new_with_base_url(key, Some(base_url)))
        }
        "fireworks" => {
            let key = resolve_api_key(cli.api_key.as_deref(), "FIREWORKS_API_KEY")?;
            let base_url = configured_base_url(
                cli.base_url.as_deref(),
                "https://api.fireworks.ai/inference/v1",
                "FIREWORKS_BASE_URL",
            );
            Arc::new(OpenAiProvider::new_named_with_headers(
                key,
                Some(base_url),
                "FIREWORKS_API_KEY",
                "fireworks",
                "Fireworks",
                provider_headers("FIREWORKS"),
            ))
        }
        "ollama-cloud" | "ollama_cloud" => {
            let key = resolve_api_key(cli.api_key.as_deref(), "OLLAMA_API_KEY")?;
            let base_url = configured_base_url(
                cli.base_url.as_deref(),
                "https://ollama.com/v1",
                "OLLAMA_CLOUD_BASE_URL",
            );
            Arc::new(OpenAiProvider::new_named_with_headers(
                key,
                Some(base_url),
                "OLLAMA_API_KEY",
                "ollama-cloud",
                "Ollama Cloud",
                provider_headers("OLLAMA_CLOUD"),
            ))
        }
        "cerebras" => {
            let key = resolve_api_key(cli.api_key.as_deref(), "CEREBRAS_API_KEY")?;
            let base_url = configured_base_url(
                cli.base_url.as_deref(),
                "https://api.cerebras.ai/v1",
                "CEREBRAS_BASE_URL",
            );
            Arc::new(OpenAiProvider::new_named_with_headers(
                key,
                Some(base_url),
                "CEREBRAS_API_KEY",
                "cerebras",
                "Cerebras",
                provider_headers("CEREBRAS"),
            ))
        }
        "groq" => {
            let key = resolve_api_key(cli.api_key.as_deref(), "GROQ_API_KEY")?;
            let base_url = configured_base_url(
                cli.base_url.as_deref(),
                "https://api.groq.com/openai/v1",
                "GROQ_BASE_URL",
            );
            Arc::new(OpenAiProvider::new_named_with_headers(
                key,
                Some(base_url),
                "GROQ_API_KEY",
                "groq",
                "Groq",
                provider_headers("GROQ"),
            ))
        }
        "openrouter" => {
            let key = resolve_api_key(cli.api_key.as_deref(), "OPENROUTER_API_KEY")?;
            let base_url = configured_base_url(
                cli.base_url.as_deref(),
                DEFAULT_OPENROUTER_BASE_URL,
                "OPENROUTER_BASE_URL",
            );
            Arc::new(OpenRouterProvider::new(key, Some(base_url)))
        }
        "ollama" => {
            let base_url = configured_base_url(
                cli.base_url.as_deref(),
                "http://localhost:11434/v1",
                "OLLAMA_LOCAL_BASE_URL",
            );
            Arc::new(OpenAiProvider::new_named(
                "",
                Some(base_url),
                "OLLAMA_API_KEY",
                "ollama",
                "Ollama",
            ))
        }
        "axle" | "axle-hosted" | "axle_hosted" => {
            let base_url = configured_base_url(
                cli.base_url.as_deref(),
                DEFAULT_AXLE_BASE_URL,
                "AXLE_BASE_URL",
            );
            // The hosted endpoint is Axle's own provider, so it falls back to
            // the built-in credential instead of refusing to start. Any other
            // endpoint the user pointed AXLE_BASE_URL at is theirs, and still
            // needs a key of their own.
            let key = resolve_axle_api_key(cli.api_key.as_deref(), &base_url)?;
            Arc::new(OpenAiProvider::new_named_with_headers(
                key,
                Some(base_url),
                "AXLE_API_KEY",
                "axle",
                "Axle",
                provider_headers("AXLE"),
            ))
        }
        "openai" => {
            let key = resolve_api_key(cli.api_key.as_deref(), "OPENAI_API_KEY")?;
            let base_url = configured_base_url(
                cli.base_url.as_deref(),
                "https://api.openai.com/v1",
                "OPENAI_BASE_URL",
            );
            Arc::new(OpenAiProvider::new_named_with_headers(
                key,
                Some(base_url),
                "OPENAI_API_KEY",
                "openai",
                "OpenAI",
                provider_headers("OPENAI"),
            ))
        }
        "mistral" => {
            let key = resolve_api_key(cli.api_key.as_deref(), "MISTRAL_API_KEY")?;
            let base_url = configured_base_url(
                cli.base_url.as_deref(),
                "https://api.mistral.ai/v1",
                "MISTRAL_BASE_URL",
            );
            Arc::new(OpenAiProvider::new_named_with_headers(
                key,
                Some(base_url),
                "MISTRAL_API_KEY",
                "mistral",
                "Mistral",
                provider_headers("MISTRAL"),
            ))
        }
        "deepseek" => {
            let key = resolve_api_key(cli.api_key.as_deref(), "DEEPSEEK_API_KEY")?;
            let base_url = configured_base_url(
                cli.base_url.as_deref(),
                "https://api.deepseek.com/v1",
                "DEEPSEEK_BASE_URL",
            );
            Arc::new(OpenAiProvider::new_named_with_headers(
                key,
                Some(base_url),
                "DEEPSEEK_API_KEY",
                "deepseek",
                "DeepSeek",
                provider_headers("DEEPSEEK"),
            ))
        }
        "xai" | "grok" => {
            let key = resolve_api_key(cli.api_key.as_deref(), "XAI_API_KEY")?;
            let base_url = configured_base_url(
                cli.base_url.as_deref(),
                "https://api.x.ai/v1",
                "XAI_BASE_URL",
            );
            Arc::new(OpenAiProvider::new_named_with_headers(
                key,
                Some(base_url),
                "XAI_API_KEY",
                "xai",
                "xAI",
                provider_headers("XAI"),
            ))
        }
        custom => custom_provider(custom, cli.api_key.as_deref(), cli.base_url.as_deref())?,
    };

    if cli.text_only {
        run_text_only(provider, &cli, &effective_model).await?;
        return Ok(());
    }

    let project_free_memory_dir = cli.no_workspace_context.then(|| {
        Path::new(&cli.cwd)
            .join(".axle")
            .join("project-free-memory")
    });
    let memory_store = std::sync::Arc::new(tokio::sync::Mutex::new(
        MemoryStore::load(&cli.cwd, project_free_memory_dir.as_deref()).await?,
    ));
    let mut tool_registry = if cli.no_workspace_context {
        ToolRegistry::with_project_free(axle_config::ToolOutputLimits::default())
    } else {
        ToolRegistry::with_memory_store(
            axle_config::ToolOutputLimits::default(),
            memory_store.clone(),
        )
    };
    tool_registry.set_execution_target(Arc::new(LocalExecutionTarget::with_shell_program(
        cli.shell.as_deref(),
    )));
    let execution_target = tool_registry.execution_target();
    tracing::info!(
        target_id = execution_target.id(),
        target_description = %execution_target.describe(),
        "Execution target ready"
    );
    if !cli.no_workspace_context {
        if let Some(mcp_url) = cli.mcp_url.as_deref() {
            let (header_name, token_variable) = if let Some(header_name) =
                cli.mcp_header_name.as_deref()
            {
                let token_variable = cli
                    .mcp_header_env_var
                    .as_deref()
                    .expect("clap validates custom MCP header requirements");
                (header_name, token_variable)
            } else {
                let token_variable = cli
                    .mcp_bearer_token_env_var
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("--mcp-url requires --mcp-bearer-token-env-var or --mcp-header-name with --mcp-header-env-var"))?;
                ("Authorization", token_variable)
            };
            let token = required_api_key(token_variable)?;
            let header_value = if header_name == "Authorization" {
                format!("Bearer {}", token)
            } else {
                token
            };
            let tool_count = register_http_mcp_tools_with_header(
                &mut tool_registry,
                mcp_url,
                header_name,
                &header_value,
            )
            .await?;
            tracing::info!(mcp_url, tool_count, "Loaded HTTP MCP tools");
        }
        if let Some(program) = cli.mcp_stdio_program.as_deref() {
            let tool_count =
                register_stdio_mcp_tools(&mut tool_registry, program, &cli.mcp_stdio_arg).await?;
            tracing::info!(program, tool_count, "Loaded stdio MCP tools");
        }
        if cli.github_mcp {
            let token = ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN"]
                .iter()
                .find_map(|name| env::var(name).ok().filter(|value| !value.trim().is_empty()))
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "--github-mcp requires GITHUB_PERSONAL_ACCESS_TOKEN (or GITHUB_TOKEN). \
                         Create a fine-grained token with repository access at \
                         https://github.com/settings/personal-access-tokens"
                    )
                })?;
            let tool_count = register_http_mcp_tools_with_header(
                &mut tool_registry,
                "https://api.githubcopilot.com/mcp/",
                "Authorization",
                &format!("Bearer {}", token.trim()),
            )
            .await?;
            tracing::info!(tool_count, "Loaded GitHub MCP tools");
        }
    }
    let extension_runner = if !cli.no_workspace_context {
        if let Some(extension_path) = cli.extension.as_deref() {
            let runner = JsExtensionRunner::new();
            runner
                .load_extension_file(Path::new(extension_path))
                .await?;
            let tool_count = runner.register_tools(&mut tool_registry).await?;
            tracing::info!(
                extension_path,
                tool_count,
                "Loaded JavaScript extension API"
            );
            Some(runner)
        } else {
            None
        }
    } else {
        None
    };
    // Apply the agent tool policy last so it covers built-ins, MCP tools and
    // extension tools alike.
    if let Some(profile) = agent_profile.as_ref() {
        tool_registry.restrict_to(&profile.allowed_tools);
    }
    let mut event_bus = EventBus::new();

    if let Some(runner) = extension_runner.clone() {
        event_bus.subscribe(move |event| {
            if let Err(error) = runner.emit_event_nowait(event) {
                tracing::error!("Failed to dispatch event to JavaScript extension: {error}");
            }
        });
    }

    if cli.json_stream {
        event_bus.subscribe(|event| match event {
            AxleEvent::ToolExecutionStart {
                tool_call_id,
                tool_name,
                arguments,
            } if !is_hidden_control_tool(tool_name) => write_json_line(serde_json::json!({
                "type": "tool.started",
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "arguments": arguments,
            })),
            AxleEvent::ToolExecutionEnd {
                tool_call_id,
                tool_name,
                output,
                is_error,
                duration_ms,
                timed_out,
            } if !is_hidden_control_tool(tool_name) => write_json_line(serde_json::json!({
                "type": "tool.completed",
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "output": output,
                "isError": is_error,
                "durationMs": duration_ms,
                "timedOut": timed_out,
            })),
            AxleEvent::UsageUpdate {
                prompt_tokens,
                completion_tokens,
                total_tokens,
                cumulative_total_tokens,
            } => write_json_line(serde_json::json!({
                "type": "usage",
                "promptTokens": prompt_tokens,
                "completionTokens": completion_tokens,
                "totalTokens": total_tokens,
                "cumulativeTotalTokens": cumulative_total_tokens,
            })),
            AxleEvent::ToolApprovalRequested {
                request_id,
                tool_call_id,
                tool_name,
                arguments,
                timeout_seconds,
            } => write_json_line(serde_json::json!({
                "type": "approval.requested",
                "requestId": request_id,
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "arguments": arguments,
                "timeoutSeconds": timeout_seconds,
            })),
            AxleEvent::ToolApprovalResolved {
                request_id,
                tool_call_id,
                tool_name,
                decision,
                reason,
            } => write_json_line(serde_json::json!({
                "type": "approval.resolved",
                "requestId": request_id,
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "decision": decision,
                "reason": reason,
            })),
            _ => {}
        });
    } else if !cli.json {
        event_bus.subscribe(|event| match event {
            AxleEvent::TurnStart { turn_index } => {
                println!("--- Turn {} ---", turn_index);
            }
            AxleEvent::ToolExecutionStart {
                tool_name,
                arguments,
                ..
            } if !is_hidden_control_tool(tool_name) => {
                println!("Tool Call [{}] args: {}", tool_name, arguments);
            }
            AxleEvent::ToolExecutionEnd {
                tool_name,
                is_error,
                output,
                duration_ms,
                timed_out,
                ..
            } if !is_hidden_control_tool(tool_name) => {
                let status = if *timed_out {
                    "TIMED OUT"
                } else if *is_error {
                    "FAILED"
                } else {
                    "OK"
                };
                let duration = format_duration_ms(*duration_ms);
                let snippet = output_snippet(output, 300);
                if *is_error {
                    eprintln!("Tool [{}] status: {} after {}", tool_name, status, duration);
                    eprintln!("   Output snippet: {}", snippet);
                } else {
                    println!("Tool [{}] status: {} in {}", tool_name, status, duration);
                    println!("   Output snippet: {}", snippet);
                }
            }
            AxleEvent::ToolApprovalRequested {
                tool_name,
                timeout_seconds,
                ..
            } => {
                eprintln!(
                    "Approval required for tool [{}]. Waiting up to {}s for a decision via the approval file.",
                    tool_name, timeout_seconds
                );
            }
            AxleEvent::ToolApprovalResolved {
                tool_name,
                decision,
                reason,
                ..
            } => {
                eprintln!(
                    "Approval for tool [{}] resolved: {} ({})",
                    tool_name, decision, reason
                );
            }
            _ => {}
        });
    }

    let mut session = match cli.session.as_deref() {
        Some(session_id) => SessionManager::load(&cli.cwd, session_id).await?,
        None => SessionManager::create_new(&cli.cwd, None).await?,
    };
    if !cli.json && !cli.json_stream {
        println!(
            "Axle AI Agent initialized. Session ID: {}",
            session.session_id()
        );
    } else if cli.json_stream {
        // Publish the durable session identity before the first provider call.
        // The desktop can then reuse the same session if this one-shot process
        // loses its terminal result after the session file was created.
        write_json_line(serde_json::json!({
            "type": "session",
            "sessionId": session.session_id(),
        }));
    }

    let interaction_mode = match cli.interaction_mode.as_str() {
        "plan" => InteractionMode::Plan,
        _ => InteractionMode::Build,
    };
    // The desktop supplies provider/model metadata through --context-window.
    // The standalone CLI has no discovery handshake before its first request,
    // so this conservative value is only a local compaction estimate when
    // metadata is unavailable; it is not advertised as provider capacity.
    let context_window_tokens = parse_context_window_tokens(cli.context_window.as_deref())?
        .or(Some(DEFAULT_CONTEXT_WINDOW_TOKENS));

    const DEFAULT_PROMPT: &str = "Summarize your available tools and environment.";
    let prompt_from_stdin = if cli.prompt_stdin {
        let mut prompt = String::new();
        tokio::io::stdin().read_to_string(&mut prompt).await?;
        anyhow::ensure!(!prompt.trim().is_empty(), "Prompt stdin was empty");
        Some(prompt)
    } else {
        None
    };
    let prompt = prompt_from_stdin
        .as_deref()
        .or(cli.prompt.as_deref())
        .unwrap_or(DEFAULT_PROMPT);
    let memory_context = if cli.no_workspace_context {
        None
    } else {
        let context = memory_store.lock().await.render_context(prompt);
        (!context.is_empty()).then_some(context)
    };

    let loop_options = AgentLoopOptions {
        cwd: cli.cwd.clone(),
        workspace_context: !cli.no_workspace_context,
        model_name: effective_model.clone(),
        temperature: Some(0.7),
        reasoning_effort: cli.effort.clone(),
        append_system_prompt: effective_append_prompt.clone(),
        context_window_tokens,
        memory_context,
        interaction_mode,
        approval,
    };

    let agent_loop = AgentLoop::new(provider, tool_registry, event_bus, loop_options);

    let image_parts = load_image_parts(&cli.image_paths, &cli.image_mime_types).await?;
    if !cli.json && !cli.json_stream {
        if cli.prompt.is_some() {
            println!("\nUser Prompt: {}\n", prompt);
        } else {
            println!("\nNo prompt supplied. Running default Axle status check...\n");
        }
    }

    let interrupted = tokio::select! {
        result = async {
            if prompt.trim().eq_ignore_ascii_case("/compact") {
                let compacted = agent_loop.compact_session(&mut session).await?;
                Ok(if compacted {
                    "Context compacted.".to_string()
                } else {
                    "Context was already compact.".to_string()
                })
            } else {
                run_prompt(
                    &agent_loop,
                    &mut session,
                    prompt,
                    image_parts,
                    cli.json_stream,
                    !cli.json && !cli.json_stream,
                )
                .await
            }
        } => {
            let result = result?;
            write_result(&cli, &result, session.session_id());
            false
        }
        signal = tokio::signal::ctrl_c() => {
            signal?;
            true
        }
    };

    if interrupted {
        session.save().await?;
        if cli.json_stream {
            write_json_line(serde_json::json!({
                "type": "shutdown",
                "message": "Interrupt received; session saved.",
                "sessionId": session.session_id(),
            }));
        } else if cli.json {
            eprintln!(
                "Interrupt received; session {} saved.",
                session.session_id()
            );
        } else {
            println!(
                "\nInterrupt received. Session {} saved. Exiting gracefully.",
                session.session_id()
            );
        }
    }

    Ok(())
}
