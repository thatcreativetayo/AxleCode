export type DocLink = { href: string; label: string };

export const DOC_SECTIONS: { title: string; links: DocLink[] }[] = [
  {
    title: "Get started",
    links: [
      { href: "/docs#overview", label: "Introduction" },
      { href: "/docs#install", label: "Installation" },
      { href: "/docs#quickstart", label: "Your first task" },
    ],
  },
  {
    title: "Your workspace",
    links: [
      { href: "/docs#projects", label: "Projects & threads" },
      { href: "/docs#providers", label: "Models & providers" },
      { href: "/docs#approvals", label: "Plans & approvals" },
      { href: "/docs#remote-access", label: "Remote access" },
    ],
  },
  {
    title: "Go further",
    links: [
      { href: "/docs#integrations", label: "MCP connections" },
      { href: "/docs#github", label: "GitHub" },
      { href: "/docs#cli", label: "Command line" },
      { href: "/docs#troubleshooting", label: "Troubleshooting" },
    ],
  },
];

const KEYWORDS: Record<string, string> = {
  overview: "start welcome introduction",
  install: "download windows mac macos linux dmg exe appimage",
  quickstart: "first task prompt start tutorial",
  projects: "workspace folder repo repository threads history files context",
  providers:
    "api key models openai claude anthropic gemini google ollama groq fireworks cerebras openrouter",
  approvals: "permissions read only plan mode safety allow decline",
  "remote-access": "tailscale network computer remote phone wsl",
  integrations:
    "mcp server stdio http connection figma linear notion sentry playwright",
  github: "github token git source pull request issue",
  cli: "command line terminal runtime flags configuration config",
  troubleshooting: "help error failed key model rate limit folder",
};

export const DOC_INDEX = DOC_SECTIONS.flatMap((section) =>
  section.links.map((link) => ({
    title: link.label,
    section: section.title,
    href: link.href,
    keywords: KEYWORDS[link.href.split("#")[1]] ?? "",
  })),
);
export const ON_THIS_PAGE = DOC_SECTIONS.flatMap((section) =>
  section.links.map((link) => ({
    href: `#${link.href.split("#")[1]}`,
    label: link.label,
  })),
);
