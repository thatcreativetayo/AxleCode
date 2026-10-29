# Axle: content-page research

Research completed 13 October 2026, before UI implementation. Each page received a Kroma UI-inspiration call and a Kroma component-code call, followed by focused searches. Sources were searched together first and individually where the combined results favored a single gallery. References inform composition and interaction, not product claims.

## Models

- Kroma UI search: `dark AI model provider switcher platform model cards minimal` across Mobbin, Awwwards, Dribbble. [Multi-LLM Switching UI](https://dribbble.com/shots/26950667-Multi-LLM-Switching-UI) suggests a compact selector, clear active state, and provider-first labeling. Borrow the hierarchy for an interactive model-selection demonstration.
- Kroma component search: `tabs card grid provider selector` across shadcn/ui and Magic UI. [shadcn Card](https://ui.shadcn.com/docs/components/base/card) supports a consistent heading, provider family, short description, and footer pattern. Use hairline boundaries and restrained spacing.
- Focused Kroma component search across Radix UI and Aceternity UI returned [Radix Tabs](https://www.radix-ui.com/primitives/docs/components/tabs). Borrow keyboard navigation and correct tab/panel semantics for provider switching.
- Follow-up AI-model UI search scoped to Awwwards/Mobbin timed out; other references above succeeded. Do not claim that timed-out source was reviewed.
- Section direction: concise page hero; responsive provider grid; a working switch-model story; practical provider-configuration link. Avoid benchmark claims or invented current model versions.

## Integrations

- Kroma UI search: `integration directory search filter cards dark developer tools` across Mobbin, Awwwards, Dribbble. [Mobbin developer tools](https://mobbin.com/explore/web/app-categories/developer-tools) suggests persistent search, compact categorization and predictable cards. [Dribbble dark theme cards](https://dribbble.com/search/dark-theme-cards) informs low-contrast surfaces and simple icon/title pairing.
- Kroma component search across shadcn/ui and Magic UI returned [Input](https://ui.shadcn.com/docs/components/base/input), [Tabs](https://ui.shadcn.com/docs/components/base/tabs), and [Data Table filtering](https://ui.shadcn.com/docs/components/base/data-table). Borrow labeled search, count feedback and keyboard-operable category filters; display cards rather than a data table.
- Focused Kroma component search across Magic UI and Aceternity UI returned [Magic UI components](https://magicui.design/docs/components) and [Aceternity feature sections](https://ui.aceternity.com/feature-section). Borrow a quiet reveal and clear card hierarchy; avoid continuous animated lists for the directory itself.
- Section direction: hero explaining MCP-compatible connectivity; live search/category filtering with meaningful empty state; cards distinguish local tools from third-party MCP connections; setup CTA links to docs.

## Pricing

- Kroma UI search: `minimal dark SaaS pricing comparison table pricing cards` across Mobbin, Awwwards, Dribbble returned [Dark Mode Pricing](https://dribbble.com/shots/27653891-Dark-Mode-Pricing-Page-UI-SaaS-Plans-Comparison) and [Clean Minimalist Pricing](https://dribbble.com/shots/27470729-SaaS-Pricing-Page-Design-Clean-Minimalist-UI). Borrow aligned features and a restrained emphasized middle tier, without excessive badges.
- Follow-up Kroma UI search scoped to Mobbin returned [Pricing page examples](https://mobbin.com/explore/sites/sections/pricing-page). Borrow consistent CTAs and a visibly separate comparison section.
- Kroma component search across shadcn/ui and Magic UI returned [Radio Group](https://ui.shadcn.com/docs/components/base/radio-group) and [Accordion](https://ui.shadcn.com/docs/components/base/accordion). Borrow real monthly/annual state and accessible collapsible FAQs.
- Focused Kroma component search across Radix UI returned [Toggle Group](https://www.radix-ui.com/primitives/docs/components/toggle-group) and [Accordion](https://www.radix-ui.com/primitives/docs/components/accordion). Use correct pressed state, keyboard access, associated headers and controlled expanded state.
- Section direction: three tiers as requested, transparent billing language, toggled totals, table with row/column headers, honest FAQs. Repository does not substantiate the previous site's Pro/Team prices or hosted credits. Do not silently present those as verified billing terms.

## Docs

- Kroma UI search: `developer documentation dark sidebar code content table of contents` across Mobbin, Awwwards, Dribbble; followed by a focused `documentation website` search across Awwwards/Mobbin. Returned [Awwwards documentation](https://www.awwwards.com/inspiration/documentation-design-framework-thesprkl), [Systematic documentation](https://www.awwwards.com/market/product_67d800ee5664f562693309), and [Mobbin Craft document](https://mobbin.com/explore/screens/7c3a89ce-df5a-470f-81f9-3683e21f9d96). Borrow a calm reading column, distinct left navigation and narrow right contents rail.
- Kroma component search across shadcn/ui and Magic UI returned [Sidebar](https://ui.shadcn.com/docs/components/base/sidebar) and [Sidebar blocks](https://ui.shadcn.com/blocks/sidebar). Borrow grouped navigation, an active section and a mobile disclosure.
- Focused Kroma component search returned [Command](https://ui.shadcn.com/docs/components/base/command). Borrow a searchable section index with a labeled search field, clear empty result, and keyboard-accessible links. Copy buttons must copy the actual visible snippet and announce success/failure.
- Section direction: real desktop quickstart; model/key configuration; projects and threads; approvals; MCP; troubleshooting. Use the checked-in runtime documentation for actual CLI options. Never invent a `axle` executable, hosted API, or installer script.

## Repository facts and endpoints

- Existing `axle-landing` is already a Next App Router application with all eight requested routes. It is being rebuilt rather than used as visual source. Its previous marketing content includes unsupported testimonials, historical release entries, pricing, hosted credits, SSO, and imaginary commands; these are not product evidence.
- `README.md` documents installation, Settings > Models, local files/terminal/git, approval controls, persistent threads, Windows/macOS/Linux, and provider-key setup. It links `https://github.com/thatcreativetayo/AxleCode/releases`.
- `docs/axle-configuration.md` documents actual runtime provider IDs: `openai`, `anthropic`, `gemini`, `openrouter`, `fireworks`, `cerebras`, `groq`, `ollama-cloud`, and `ollama`. Real flags include `--provider`, `--model`, `--cwd`, and `-p`.
- `axle-download-worker/wrangler.toml` configures the latest-release API as `https://api.github.com/repos/axle-ai-code/Axle/releases/latest`; the public release repository is `https://github.com/axle-ai-code/Axle/releases`. Prefer the configured current repository over the older README link after endpoint validation.
- `axle-download-worker/src/index.test.js` confirms public download entry points at `https://axle.llc/get`, with `?platform=windows`, `?platform=macos`, and `?platform=linux`, and a public `/get/manifest` route. These are repository-configured URLs, not evidence that the live server is healthy.
- `axle-auth-worker/wrangler.toml` configures `PUBLIC_BASE_URL = "https://auth.axle.llc"`. Inspect supported worker routes before selecting a sign-in URL.
- Axle is the requested marketing brand; shipped artifacts and binary names currently remain Axle. The site should avoid suggesting a renamed binary already exists.
