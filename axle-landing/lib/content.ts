export const PROVIDERS = [
  { name: "OpenAI", models: "GPT-5, GPT-5 mini, o-series", note: "Flagship reasoning and general purpose." },
  { name: "Anthropic", models: "Claude Opus, Sonnet, Haiku", note: "Long context, careful edits, strong tool use." },
  { name: "Google", models: "Gemini 2.5 Pro, Flash", note: "Very large context windows for whole repositories." },
  { name: "Fireworks", models: "Open weights, fast", note: "Low latency hosting for open models." },
  { name: "Ollama Cloud", models: "Llama, Qwen, Mistral", note: "Local first, cloud when you need the headroom." },
  { name: "Cerebras", models: "Llama, Qwen", note: "The highest throughput inference available." },
  { name: "Groq", models: "Llama, Mixtral", note: "Instant completions for tight edit loops." },
] as const;

export const PILLARS = [
  {
    tag: "01",
    title: "Coding intelligence",
    copy: "Axle reads the whole repository, not the open file. It plans across modules, traces call sites, and proposes edits that still hold together after the diff lands.",
    bullets: [
      "Repository wide context with symbol and call graph awareness",
      "Multi step plans you review before a single line changes",
      "Edit proposals with inline diffs and a one key revert",
    ],
  },
  {
    tag: "02",
    title: "Compatibility",
    copy: "Axle fits the stack you already ship. Your language, your package manager, your build tooling, your test runner, and the frameworks your team actually uses.",
    bullets: [
      "Twenty languages with first class language server support",
      "Monorepos, workspaces, and polyglot repositories",
      "Runs inside your existing terminal, git remote, and CI",
    ],
  },
  {
    tag: "03",
    title: "Connectivity",
    copy: "Bring the tools that already hold your context. Issues, design files, logs, and docs stay reachable, so the assistant stops asking you to paste things in.",
    bullets: [
      "Native integrations for trackers, docs, and design tools",
      "Bring your own model keys, or run open weights locally",
      "Everything scoped by permissions you control per project",
    ],
  },
] as const;

export const INTEGRATIONS = [
  { name: "GitHub", group: "Source control", note: "Pull requests, reviews, and repository search." },
  { name: "GitLab", group: "Source control", note: "Merge requests and pipeline status." },
  { name: "Bitbucket", group: "Source control", note: "Repositories and pull request workflow." },
  { name: "Linear", group: "Issues", note: "Create and update issues without leaving the editor." },
  { name: "Jira", group: "Issues", note: "Sync tickets against the work you just shipped." },
  { name: "Notion", group: "Docs", note: "Specs and internal documentation as context." },
  { name: "Slack", group: "Comms", note: "Summaries and handoffs into a channel." },
  { name: "Figma", group: "Design", note: "Frames and tokens while building interface work." },
  { name: "Sentry", group: "Observability", note: "Trace an error to the line that raised it." },
  { name: "Datadog", group: "Observability", note: "Logs and metrics beside the code." },
  { name: "Vercel", group: "Deploy", note: "Preview builds and deploy status." },
  { name: "Docker", group: "Runtime", note: "Containers and compose services." },
  { name: "PostgreSQL", group: "Data", note: "Schema aware query help." },
  { name: "Supabase", group: "Data", note: "Tables, policies, and edge functions." },
  { name: "Stripe", group: "Payments", note: "Products, prices, and webhook flows." },
  { name: "PlanetScale", group: "Data", note: "Branch workflows for MySQL." },
  { name: "Playwright", group: "Testing", note: "Generate and repair end to end tests." },
  { name: "Terraform", group: "Infra", note: "Plan and review infrastructure changes." },
  { name: "Kubernetes", group: "Infra", note: "Manifests and rollout checks." },
  { name: "Cloudflare", group: "Infra", note: "Workers, KV, and DNS." },
] as const;

export const TIERS = [
  {
    id: "solo",
    name: "Solo",
    priceMonthly: 0,
    priceAnnual: 0,
    tagline: "For one developer and any repository.",
    cta: "Download free",
    highlight: false,
    features: [
      "Unlimited local projects",
      "Bring your own model keys",
      "Repository wide context",
      "20 language servers",
      "Community support",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    priceMonthly: 22,
    priceAnnual: 18,
    tagline: "For professionals shipping every day.",
    cta: "Start Pro",
    highlight: true,
    features: [
      "Everything in Solo",
      "Hosted inference credits included",
      "Parallel agents on one task",
      "Pull request review on every branch",
      "Priority support, one business day",
    ],
  },
  {
    id: "team",
    name: "Team",
    priceMonthly: 46,
    priceAnnual: 38,
    tagline: "For teams sharing one codebase.",
    cta: "Start Team",
    highlight: false,
    features: [
      "Everything in Pro",
      "Shared rulebooks and prompts",
      "Centralized billing and seats",
      "SSO and audit logs",
      "Private model routing",
    ],
  },
] as const;

export const COMPARISON = [
  {
    group: "Core",
    rows: [
      { label: "Unlimited local projects", solo: true, pro: true, team: true },
      { label: "Repository wide context", solo: true, pro: true, team: true },
      { label: "Language servers included", solo: "20", pro: "20", team: "20" },
      { label: "Bring your own model keys", solo: true, pro: true, team: true },
    ],
  },
  {
    group: "Inference",
    rows: [
      { label: "Hosted credits per month", solo: false, pro: "$10", team: "$25 / seat" },
      { label: "Private model routing", solo: false, pro: false, team: true },
      { label: "Local open weights", solo: true, pro: true, team: true },
    ],
  },
  {
    group: "Collaboration",
    rows: [
      { label: "Parallel agents", solo: false, pro: true, team: true },
      { label: "Shared rulebooks", solo: false, pro: false, team: true },
      { label: "Seat management", solo: false, pro: false, team: true },
    ],
  },
  {
    group: "Security",
    rows: [
      { label: "SSO", solo: false, pro: false, team: true },
      { label: "Audit logs", solo: false, pro: false, team: true },
      { label: "Zero retention mode", solo: true, pro: true, team: true },
    ],
  },
] as const;

export const FAQS = [
  {
    q: "Do I need my own API keys?",
    a: "No, but you can use them. Solo runs entirely on keys you supply, so you pay providers directly. Pro and Team include hosted credits so you can start without configuring anything. Both can live in the same workspace and you can route per project.",
  },
  {
    q: "What happens to my code?",
    a: "It stays where it is. Axle indexes locally and sends only the context a request needs. Zero retention mode is available on every plan, and nothing you write is used to train models.",
  },
  {
    q: "Can I run models locally?",
    a: "Yes. Point Axle at a local runtime or Ollama Cloud and keep the loop on your machine. Local models work with the same context engine, planning, and diff review as hosted ones.",
  },
  {
    q: "How does billing work for teams?",
    a: "Team is priced per seat with a shared pool of inference credits. Seats are added and removed at any time and the difference is prorated on the next invoice. Annual billing takes two months off the total.",
  },
  {
    q: "Is there a discount for open source?",
    a: "Maintainers of public projects get Pro at no cost. Apply from the company page and include a link to the repository you maintain.",
  },
  {
    q: "Can I cancel whenever?",
    a: "Any time, from the account page, without contacting support. Your projects and configuration stay on your machine, and nothing is deleted when a subscription ends.",
  },
] as const;

export const CHANGELOG = [
  {
    version: "2.4.0",
    date: "October 2, 2026",
    tags: ["Agents", "Performance"],
    summary: "Parallel agents, a faster indexer, and per project model routing.",
    items: [
      "Run up to four agents against one task and merge the results into a single review.",
      "Repository indexing is 3.1x faster on monorepos over 200k files.",
      "Model selection is now stored per project instead of per workspace.",
      "The diff view keeps scroll position when you accept a change mid file.",
    ],
  },
  {
    version: "2.3.2",
    date: "September 14, 2026",
    tags: ["Fixes"],
    summary: "Stability work on Windows and a long list of small edits.",
    items: [
      "Fixed terminal integration dropping focus on Windows 11.",
      "A language server restart no longer clears an in progress plan.",
      "Reduced memory held by the context cache between sessions.",
    ],
  },
  {
    version: "2.3.0",
    date: "August 26, 2026",
    tags: ["Models", "Integrations"],
    summary: "New providers, and design files as first class context.",
    items: [
      "Added Cerebras and Groq as first class providers.",
      "Figma frames can be attached to a task and read as structured context.",
      "Sentry issues link directly to the frame that raised them.",
      "Rulebooks sync across a team from a file checked into the repository.",
    ],
  },
  {
    version: "2.2.0",
    date: "August 1, 2026",
    tags: ["Core"],
    summary: "Plans, and the first pass at whole repository reasoning.",
    items: [
      "Axle proposes a multi step plan before editing anything.",
      "Call graph awareness across module and package boundaries.",
      "Revert a whole task in one action, including files it created.",
    ],
  },
  {
    version: "2.1.0",
    date: "July 9, 2026",
    tags: ["Core", "Performance"],
    summary: "The workspace rebuild.",
    items: [
      "New editor shell with a unified task thread.",
      "The command palette now covers every action in the app.",
      "Cold start moved from 4.2 seconds to under one.",
    ],
  },
] as const;

export const PRINCIPLES = [
  {
    title: "No lock in",
    copy: "Your models, your keys, your repository, your machine. Every layer is replaceable and none of it is rented from us.",
  },
  {
    title: "Plain files",
    copy: "Configuration lives in the repository as readable text. Nothing important hides in a database you cannot inspect.",
  },
  {
    title: "Review, then apply",
    copy: "Axle proposes and you decide. Every change arrives as a diff you can read, reject, or revert in one action.",
  },
  {
    title: "Speed is a feature",
    copy: "Sub second completions and an indexer that keeps up with a fresh checkout. Latency is why people abandon tools.",
  },
  {
    title: "Quiet by default",
    copy: "No confetti, no autoplay, no notification you did not ask for. The work is the interface.",
  },
  {
    title: "Boring reliability",
    copy: "The assistant should never be the reason a build breaks. When something fails it degrades to plain editing.",
  },
] as const;

export const STATS = [
  { value: "20", label: "Languages", note: "First class language servers" },
  { value: "7", label: "Providers", note: "Switch without leaving" },
  { value: "0.9s", label: "Cold start", note: "From icon to indexed" },
  { value: "4", label: "Agents", note: "Parallel on one task" },
] as const;

export const TESTIMONIALS = [
  {
    quote:
      "We replaced three tools with Axle and shipped the migration two weeks early. The plan step is what did it. We stopped reviewing surprises.",
    name: "Marisol Vega",
    role: "Staff engineer, Northwind",
  },
  {
    quote:
      "Switching models mid task without losing context is the feature I did not know I needed. Some days Sonnet, some days a local model, same workflow.",
    name: "Ifeanyi Obiora",
    role: "Founder, Ledgerline",
  },
  {
    quote:
      "The index actually understands our monorepo. It found a stale cache invalidation that had survived four code reviews.",
    name: "Dmitri Sokolov",
    role: "Platform lead, Halcyard",
  },
] as const;

export const LANGUAGES = [
  "TypeScript", "Python", "Rust", "Go", "Java", "Kotlin", "Swift", "C++", "C#", "Ruby",
  "PHP", "Elixir", "Scala", "Dart", "Lua", "SQL", "Bash", "Zig", "Haskell", "R",
] as const;
