export const MODEL_PROVIDERS = [
  {
    id: "openai",
    name: "OpenAI",
    mark: "O",
    family: "GPT & reasoning models",
    type: "Cloud",
    copy: "Work with OpenAI models using your API key.",
    key: "OPENAI_API_KEY",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    mark: "A",
    family: "Claude",
    type: "Cloud",
    copy: "Bring Claude into your workflow for reasoning, writing code, and working through changes.",
    key: "ANTHROPIC_API_KEY",
  },
  {
    id: "gemini",
    name: "Google",
    mark: "G",
    family: "Gemini",
    type: "Cloud",
    copy: "Connect a Gemini API key and choose the model available in your Google account.",
    key: "GEMINI_API_KEY",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    mark: "↗",
    family: "A wider model catalog",
    type: "Cloud",
    copy: "Access multiple model families through one provider account and one API key.",
    key: "OPENROUTER_API_KEY",
  },
  {
    id: "fireworks",
    name: "Fireworks",
    mark: "✳",
    family: "Hosted open models",
    type: "Cloud",
    copy: "Use open model families hosted by Fireworks without running your own infrastructure.",
    key: "FIREWORKS_API_KEY",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    mark: "C",
    family: "Fast inference",
    type: "Cloud",
    copy: "Connect to Cerebras inference with the model and account that fit your work.",
    key: "CEREBRAS_API_KEY",
  },
  {
    id: "groq",
    name: "Groq",
    mark: "g",
    family: "Hosted open models",
    type: "Cloud",
    copy: "Bring your Groq API key for an alternative route to supported open models.",
    key: "GROQ_API_KEY",
  },
  {
    id: "nvidia-nim",
    name: "NVIDIA NIM",
    mark: "N",
    family: "NVIDIA-hosted models",
    type: "Cloud",
    copy: "Add an NVIDIA API key and reach the models hosted on build.nvidia.com from your own account.",
    key: "NVIDIA_API_KEY",
  },
  {
    id: "agent-router",
    name: "Agent Router",
    mark: "⇄",
    family: "One key, many models",
    type: "Cloud",
    copy: "Paste the router's base URL and token. Axle identifies the provider, then lists the models your key can reach.",
    key: "AGENT_ROUTER_TOKEN",
  },
  {
    id: "mistral",
    name: "Mistral",
    mark: "M",
    family: "Mistral & Codestral",
    type: "Cloud",
    copy: "Connect a Mistral API key to work with the Mistral and Codestral models available to you.",
    key: "MISTRAL_API_KEY",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    mark: "D",
    family: "Reasoning and code",
    type: "Cloud",
    copy: "Use a DeepSeek API key for chat and coding models, including the reasoning variants.",
    key: "DEEPSEEK_API_KEY",
  },
  {
    id: "xai",
    name: "xAI",
    mark: "X",
    family: "Grok",
    type: "Cloud",
    copy: "Add an xAI API key to bring the Grok models into the same model list.",
    key: "XAI_API_KEY",
  },
  {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    mark: "◉",
    family: "Open models in the cloud",
    type: "Cloud",
    copy: "Use hosted Ollama models when a task needs more than your local hardware.",
    key: "OLLAMA_API_KEY",
  },
  {
    id: "ollama",
    name: "Ollama",
    mark: "◎",
    family: "Your local models",
    type: "Local",
    copy: "Connect a local Ollama runtime. Your machine supplies the compute; no provider key is required.",
    key: "No API key required",
  },
  {
    id: "custom",
    name: "Your own endpoint",
    mark: "⌁",
    family: "Any OpenAI-compatible API",
    type: "Cloud",
    copy: "Bring a base URL and an API key. Axle checks the provider, lists the models it serves, and lets you switch between them.",
    key: "Your key and base URL",
  },
] as const;

export const INTEGRATION_CATALOG = [
  {
    name: "GitHub",
    mark: "GH",
    category: "Code",
    kind: "MCP",
    description:
      "Repository context, issues, and pull requests in your working conversation.",
    detail:
      "Connect GitHub's hosted MCP server with a personal access token. Available tools depend on the token permissions you grant.",
    anchor: "github",
  },
  {
    name: "Git",
    mark: "⎇",
    category: "Code",
    kind: "Built in",
    description:
      "Read your working tree, inspect history, and review changes where they happen.",
    detail:
      "Open a project with an existing Git repository. The agent can use local Git commands through the terminal, subject to your approval settings.",
    anchor: "projects",
  },
  {
    name: "Terminal",
    mark: ">_",
    category: "Development",
    kind: "Built in",
    description:
      "Run your project's commands, test suite, and development tools.",
    detail:
      "Your local shell keeps the environment you already use. Review commands and their output in the thread, and configure approvals for sensitive actions.",
    anchor: "approvals",
  },
  {
    name: "Files",
    mark: "{}",
    category: "Development",
    kind: "Built in",
    description:
      "Read, search, and edit files directly inside your project folder.",
    detail:
      "Add a folder to a project to give the agent workspace context. Changes remain in your local files and can be reviewed with your existing tools.",
    anchor: "projects",
  },
  {
    name: "Figma",
    mark: "Fi",
    category: "Design",
    kind: "MCP compatible",
    description:
      "Bring design context into a build through a compatible Figma MCP server.",
    detail:
      "Configure a Figma MCP server supported by your account. Its exposed tools determine which frames, design details, and assets the agent can read.",
    anchor: "integrations",
  },
  {
    name: "Linear",
    mark: "◒",
    category: "Planning",
    kind: "MCP compatible",
    description:
      "Use issue and project context through a compatible Linear MCP connection.",
    detail:
      "Connect a Linear MCP server with the access your workspace allows. Review the server's permissions before enabling its tools.",
    anchor: "integrations",
  },
  {
    name: "Notion",
    mark: "N",
    category: "Knowledge",
    kind: "MCP compatible",
    description:
      "Make selected documentation reachable through a Notion MCP server.",
    detail:
      "Use a compatible Notion MCP server and grant it access to the pages you want to work with. The connection determines available actions.",
    anchor: "integrations",
  },
  {
    name: "Sentry",
    mark: "△",
    category: "Development",
    kind: "MCP compatible",
    description:
      "Connect production error context with a compatible Sentry MCP server.",
    detail:
      "Configure a Sentry MCP server for your organization. Available issue and project tools follow that server's capabilities and permissions.",
    anchor: "integrations",
  },
  {
    name: "Playwright",
    mark: "Pw",
    category: "Development",
    kind: "MCP compatible",
    description:
      "Add browser tools through a locally configured Playwright MCP server.",
    detail:
      "Run a compatible Playwright MCP server over stdio. Browser behavior and the actions it can perform are provided by that server.",
    anchor: "integrations",
  },
  {
    name: "Custom MCP",
    mark: "+",
    category: "Development",
    kind: "MCP",
    description: "Connect your own tools over HTTP or a local stdio process.",
    detail:
      "Axle's runtime supports remote HTTP endpoints and local stdio MCP servers. Supply the endpoint or command, then configure any required authentication.",
    anchor: "integrations",
  },
] as const;

export const PRICING_FAQS = [
  {
    q: "What do I pay for today?",
    a: "The desktop app is free to download and use with your own model keys. Pro is $20 per month, Pro+ is $60 per month, and Ultra is $200 per month, billed monthly in the app. If you connect your own model provider, that provider bills your API usage separately.",
  },
  {
    q: "Do I need a credit card to try Axle?",
    a: "Axle does not ask for a credit card to download the app or use the Free plan. A credit card is required when you subscribe to a paid plan in the app. A hosted model provider may also require billing to be enabled before its API can be used.",
  },
  {
    q: "Can I subscribe to a paid plan?",
    a: "Yes. Pro, Pro+, and Ultra are available as monthly subscriptions from Settings > Billing in the Axle desktop app. The app shows the price and billing terms before checkout.",
  },
  {
    q: "What do the paid plans include?",
    a: "Paid plans add cloud jobs, cloud schedules on an Axle cloud runner, monthly Axle credits, higher concurrency, and model-assisted pull-request reviews. Each plan builds on the one before it.",
  },
  {
    q: "Can I use my existing model accounts?",
    a: "Yes. Add provider API keys in Settings > Models. Which models you can use depends on the access available in that account.",
  },
  {
    q: "Can I connect a provider that is not listed?",
    a: "Yes. Paste any OpenAI-compatible base URL and its API key in Settings > Models. Axle identifies the provider by its host, checks that the endpoint answers, then lists the models your key can reach so you can choose which ones to keep.",
  },
  {
    q: "Where does my code go?",
    a: "Your project files live on your computer. When you use a hosted model, the context needed for a request is sent to that provider. Review the provider's data terms, and use a local model when you want inference to run on your machine.",
  },
] as const;
