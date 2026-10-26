import type { Metadata } from "next";
import type { ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  Code2,
  Folder,
  KeyRound,
  ShieldCheck,
} from "lucide-react";
import { DocsSearch } from "@/components/site/docs-search";
import { CodeBlock } from "@/components/site/code-block";
import { Button } from "@/components/ui/button";
import { MODEL_PROVIDERS } from "@/lib/catalog";
import { DocsNavigation } from "./docs-navigation";

export const metadata: Metadata = {
  title: "Documentation",
  description:
    "Install Axle, connect a model, start a project, and work with approvals, MCP tools, and the local runtime.",
};

function DocSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-32 border-t border-white/10 pt-10">
      <h2 className="mb-5 text-[27px] font-medium leading-tight tracking-[-0.035em]">
        {title}
      </h2>
      <div className="space-y-5 text-[14px] leading-7 text-mute">
        {children}
      </div>
    </section>
  );
}
function Note({ children }: { children: ReactNode }) {
  return (
    <div className="hairline flex gap-3 rounded-xl bg-[#101010] p-5 text-[12px] leading-6">
      <BookOpen size={17} className="mt-1 shrink-0 text-paper" />
      <div>{children}</div>
    </div>
  );
}

export default function DocsPage() {
  return (
    <div className="mx-auto w-full max-w-7xl px-6 pb-24 pt-32 sm:pt-40">
      <div className="mb-8 flex items-center gap-2 text-xs text-mute">
        <span>Developers</span>
        <ChevronRight size={12} />
        <span className="text-paper">Documentation</span>
      </div>
      <div className="grid items-start gap-12 lg:grid-cols-[190px_minmax(0,1fr)] xl:grid-cols-[200px_minmax(0,1fr)_160px] xl:gap-14">
        <aside className="lg:sticky lg:top-28">
          <DocsSearch />
          <div className="mt-7 hidden lg:block">
            <DocsNavigation />
          </div>
          <details className="mt-4 rounded-xl border border-white/10 p-4 lg:hidden">
            <summary className="cursor-pointer text-xs text-mute">
              Browse documentation
            </summary>
            <div className="mt-6">
              <DocsNavigation />
            </div>
          </details>
          <a
            className="mt-8 hidden items-center gap-2 border-t border-white/10 pt-5 text-xs text-mute lg:flex"
            href="https://github.com/axle-ai-code/Axle"
          >
            <Code2 size={14} /> View source <ArrowUpRight size={12} />
          </a>
        </aside>
        <article className="min-w-0 space-y-12">
          <header id="overview" className="scroll-mt-32">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-mute">
              Start building
            </span>
            <h1 className="mt-4 text-[42px] font-medium leading-[1.04] tracking-[-0.055em] sm:text-[56px]">
              A place for your
              <br />
              next good idea.
            </h1>
            <p className="mt-6 max-w-xl text-[15px] leading-8 text-mute">
              Axle brings AI, your code, and your tools into one desktop
              workspace. Start with a conversation. Connect a project when you
              are ready to build.
            </p>
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              {[
                {
                  href: "#install",
                  icon: ArrowDownToLine,
                  title: "Get set up",
                  copy: "From download to your first task.",
                },
                {
                  href: "#providers",
                  icon: KeyRound,
                  title: "Connect a model",
                  copy: "Bring the intelligence you trust.",
                },
              ].map(({ href, icon: Icon, title, copy }) => (
                <a
                  key={href}
                  href={href}
                  className="hairline rounded-2xl bg-[#101010] p-5 transition-colors duration-[400ms] ease-premium hover:border-white/25"
                >
                  <Icon size={19} className="text-mute" />
                  <h2 className="mt-4 text-sm font-medium">{title}</h2>
                  <p className="mt-2 text-xs leading-6 text-mute">{copy}</p>
                </a>
              ))}
            </div>
          </header>
          <DocSection id="install" title="Make yourself at home.">
            <p>
              Download the desktop app for macOS, Windows, or Linux. Choose the
              build that matches your machine, run the installer, and open the
              app.
            </p>
            <Button href="/download" size="md">
              Download Axle <ArrowUpRight size={15} />
            </Button>
            <div className="hairline overflow-hidden rounded-xl">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">Desktop download formats</caption>
                <thead className="border-b border-white/10 text-paper">
                  <tr>
                    <th className="px-4 py-3 font-medium" scope="col">
                      Platform
                    </th>
                    <th className="px-4 py-3 font-medium" scope="col">
                      Installer
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  <tr>
                    <th scope="row" className="px-4 py-3 font-normal">
                      macOS
                    </th>
                    <td className="px-4 py-3">Apple silicon or Intel DMG</td>
                  </tr>
                  <tr>
                    <th scope="row" className="px-4 py-3 font-normal">
                      Windows
                    </th>
                    <td className="px-4 py-3">x64 installer</td>
                  </tr>
                  <tr>
                    <th scope="row" className="px-4 py-3 font-normal">
                      Linux
                    </th>
                    <td className="px-4 py-3">AppImage or Debian package</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs">
              Current release artifacts retain the Axle filename. The download
              page links to those builds.
            </p>
          </DocSection>
          <DocSection id="quickstart" title="Your first task.">
            <span id="first-task" className="scroll-mt-32" />
            <ol className="space-y-6">
              {[
                {
                  title: "Connect your model",
                  copy: (
                    <>
                      Open{" "}
                      <strong className="font-medium text-paper">
                        Settings → Models
                      </strong>
                      . Add a provider API key and choose an available model.
                    </>
                  ),
                },
                {
                  title: "Add a project",
                  copy: "Choose a local folder with code you want to work on. You can also start a conversation without a project.",
                },
                {
                  title: "Describe an outcome",
                  copy: "Ask a clear question or describe a change. Include any constraints that matter to you.",
                },
                {
                  title: "Read, review, continue",
                  copy: "Follow the response, inspect tool output, and review file changes. Keep the conversation going with a follow-up.",
                },
              ].map((step, index) => (
                <li className="flex gap-4" key={step.title}>
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/15 font-mono text-[10px] text-paper">
                    {index + 1}
                  </span>
                  <div>
                    <h3 className="font-medium text-paper">{step.title}</h3>
                    <p className="mt-1 text-[13px] leading-7">{step.copy}</p>
                  </div>
                </li>
              ))}
            </ol>
            <CodeBlock
              label="A good first prompt"
              code={[
                "Explain how this project is structured.",
                "Find the main entry points and tell me how to run the tests.",
                "Do not change any files yet.",
              ]}
            />
          </DocSection>
          <DocSection id="projects" title="A workspace around your code.">
            <span id="context" className="scroll-mt-32" />
            <p>
              Projects connect conversations to folders on your machine. Your
              existing language, framework, package manager, and Git history
              remain part of the work.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="hairline rounded-xl p-5">
                <Folder size={18} className="mb-4 text-paper" />
                <h3 className="text-sm text-paper">Projects</h3>
                <p className="mt-2 text-xs leading-6">
                  Point the workspace at the folder you want to work with. Check
                  the folder before asking for changes.
                </p>
              </div>
              <div className="hairline rounded-xl p-5">
                <BookOpen size={18} className="mb-4 text-paper" />
                <h3 className="text-sm text-paper">Threads</h3>
                <p className="mt-2 text-xs leading-6">
                  Keep related work in one conversation. Start a new thread when
                  the subject changes.
                </p>
              </div>
            </div>
            <p>
              The runtime saves conversation history under{" "}
              <code className="text-[12px] text-paper">.axle/sessions</code>.
              Keep private credentials out of prompts and source files.
            </p>
          </DocSection>
          <DocSection id="providers" title="Choose your intelligence.">
            <span id="config" className="scroll-mt-32" />
            <p>
              Manage desktop API keys in{" "}
              <strong className="font-medium text-paper">
                Settings → Models
              </strong>
              . Select a provider, add the key from your account, and choose a
              model you have access to. Hosted model usage is billed by that
              provider.
            </p>
            <div className="hairline overflow-hidden rounded-xl">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[440px] text-left text-xs">
                  <caption className="sr-only">
                    Provider IDs and runtime API key variables
                  </caption>
                  <thead className="border-b border-white/10 text-paper">
                    <tr>
                      <th className="px-4 py-3 font-medium" scope="col">
                        Provider
                      </th>
                      <th className="px-4 py-3 font-medium" scope="col">
                        Runtime environment variable
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {MODEL_PROVIDERS.map((provider) => (
                      <tr key={provider.id}>
                        <th scope="row" className="px-4 py-3 font-normal">
                          {provider.name}
                        </th>
                        <td className="px-4 py-3 font-mono text-[10px]">
                          {provider.key}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <h3 className="pt-2 font-medium text-paper">
              A provider that is not on the list
            </h3>
            <p>
              Add any OpenAI-compatible endpoint with its own base URL and API
              key. Axle matches the host against the providers it knows, sends
              the request headers that endpoint expects, checks that it
              answers, and then lists the models your key can reach so you can
              choose which ones to keep.
            </p>
            <h3 className="pt-2 font-medium text-paper">
              Prefer a local model?
            </h3>
            <p>
              Run Ollama on your machine and choose a model you have installed.
              The runtime uses{" "}
              <code className="text-xs text-paper">
                http://localhost:11434/v1
              </code>{" "}
              by default. A localhost endpoint does not require a provider key.
            </p>
            <Note>
              Model availability and capabilities vary by provider and account.
              A provider listing does not include its paid usage in Axle.
            </Note>
          </DocSection>
          <DocSection id="approvals" title="Stay part of the process.">
            <div className="flex items-center gap-2 text-paper">
              <ShieldCheck size={18} />
              <span className="text-sm font-medium">
                Plan first, or start building.
              </span>
            </div>
            <p>
              Plan mode lets you investigate a project without making changes.
              Build mode allows the tools needed to carry out a task. Choose the
              mode that fits the work in front of you.
            </p>
            <p>
              When an approval is requested, read the action and choose whether
              to allow it, allow it for the session, decline it, or cancel the
              turn. Your choice applies to the action shown.
            </p>
            <CodeBlock
              label="Runtime · read-only plan"
              code={[
                "axle --interaction-mode plan --cwd ./my-project \\",
                '  -p "Explain the authentication flow and suggest improvements"',
              ]}
            />
            <Note>
              Review commands and file changes before sharing or shipping them.
              Your existing tests and code review remain part of the workflow.
            </Note>
          </DocSection>
          <DocSection id="remote-access" title="Your workspace, within reach.">
            <p>
              Open{" "}
              <strong className="font-medium text-paper">
                Settings → Remote access
              </strong>{" "}
              to configure access to your computer from another device. The
              desktop app supports connections over your local network or
              Tailscale.
            </p>
            <p>
              Keep the host computer running and follow the connection
              instructions shown in the app. On Windows, project environments
              can also use WSL when it is installed and configured.
            </p>
          </DocSection>
          <DocSection id="integrations" title="Connect tools with MCP.">
            <p>
              Model Context Protocol lets a server expose tools to the agent.
              You can connect a remote HTTP endpoint or start a local stdio
              server. The server determines which tools are available.
            </p>
            <div className="space-y-4">
              <div className="border-l border-white/20 pl-5">
                <h3 className="text-sm font-medium text-paper">Remote HTTP</h3>
                <p className="mt-1 text-[13px]">
                  Supply the server URL with{" "}
                  <code className="text-xs text-paper">--mcp-url</code>. For
                  authenticated endpoints, use{" "}
                  <code className="text-xs text-paper">
                    --mcp-bearer-token-env-var
                  </code>
                  , or the supported custom-header flags.
                </p>
              </div>
              <div className="border-l border-white/20 pl-5">
                <h3 className="text-sm font-medium text-paper">Local stdio</h3>
                <p className="mt-1 text-[13px]">
                  Supply the server command with{" "}
                  <code className="text-xs text-paper">
                    --mcp-stdio-program
                  </code>
                  . Pass arguments using repeated{" "}
                  <code className="text-xs text-paper">--mcp-stdio-arg</code>{" "}
                  flags.
                </p>
              </div>
            </div>
            <p>
              Use the installation and authentication instructions supplied by
              the MCP server. Third-party servers may need a separate account,
              subscription, or access token.
            </p>
            <a
              href="/integrations"
              className="inline-flex items-center gap-2 text-sm text-paper"
            >
              Explore connections <ArrowUpRight size={15} />
            </a>
          </DocSection>
          <DocSection id="github" title="Bring GitHub into the loop.">
            <p>
              The runtime has a shortcut for GitHub's hosted MCP server. Set{" "}
              <code className="text-xs text-paper">
                GITHUB_PERSONAL_ACCESS_TOKEN
              </code>{" "}
              or <code className="text-xs text-paper">GITHUB_TOKEN</code> in
              your environment, then add the{" "}
              <code className="text-xs text-paper">--github-mcp</code> flag.
            </p>
            <CodeBlock
              label="Runtime · GitHub MCP"
              code={[
                "axle --github-mcp --cwd ./my-project \\",
                '  -p "Find the open issues relevant to this project"',
              ]}
            />
            <p>
              Grant the token only the repository permissions needed for your
              task. The available tools and actions follow your GitHub access
              and the server's capabilities.
            </p>
          </DocSection>
          <DocSection id="cli" title="A runtime you can work with.">
            <span id="api-reference" className="scroll-mt-32" />
            <p>
              The command-line runtime currently ships as{" "}
              <code className="text-xs text-paper">axle</code>. The examples
              below assume the binary is on your path and the provider's API key
              is configured in your environment.
            </p>
            <CodeBlock
              label="Runtime · a single task"
              code={[
                "axle --provider openai --cwd ./my-project \\",
                '  -p "Run the tests and explain any failures"',
              ]}
            />
            <div className="hairline overflow-hidden rounded-xl">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[440px] text-left text-xs">
                  <caption className="sr-only">Common runtime flags</caption>
                  <thead className="border-b border-white/10 text-paper">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-medium">
                        Flag
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        Purpose
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {[
                      ["-p, --prompt", "The task to carry out"],
                      ["--cwd", "Set the working directory"],
                      ["--provider / --model", "Choose a provider and model"],
                      [
                        "--interaction-mode plan",
                        "Investigate without making edits",
                      ],
                      ["--session", "Resume a saved session"],
                      ["--json / --json-stream", "Machine-readable output"],
                      ["--base-url", "Use a compatible custom endpoint"],
                    ].map(([flag, purpose]) => (
                      <tr key={flag}>
                        <th
                          scope="row"
                          className="px-4 py-3 font-mono text-[10px] font-normal text-paper"
                        >
                          {flag}
                        </th>
                        <td className="px-4 py-3">{purpose}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <h3
              id="rulebooks"
              className="scroll-mt-32 pt-3 font-medium text-paper"
            >
              Agent profiles
            </h3>
            <p>
              Specialized runtime agents can be configured in{" "}
              <code className="text-xs text-paper">.axle/agents.toml</code>.
              Profiles support instructions, provider and model overrides, and
              an allowed tool list.
            </p>
            <CodeBlock
              label=".axle/agents.toml"
              code={[
                "[[agents]]",
                'name = "code-reviewer"',
                'description = "Read-only code review."',
                'instructions = "Review the requested files. Explain findings with file and line references."',
                'allowed_tools = ["read", "grep", "find", "ls"]',
              ]}
            />
            <a
              href="https://github.com/axle-ai-code/Axle/blob/main/docs/axle-configuration.md"
              className="inline-flex items-center gap-2 text-sm text-paper"
            >
              Full runtime configuration <ArrowUpRight size={15} />
            </a>
          </DocSection>
          <DocSection
            id="troubleshooting"
            title="When something needs a second look."
          >
            <div className="space-y-7">
              {[
                {
                  title: "The model does not respond",
                  copy: "Check that the key belongs to the selected provider, the model is available to your account, and any required provider billing is enabled. Look at the error in the thread for more detail.",
                },
                {
                  title: "The project cannot be found",
                  copy: "Confirm the project points to a folder that exists in the selected environment. A Windows path and a WSL path refer to different filesystem locations.",
                },
                {
                  title: "An MCP server will not connect",
                  copy: "Check the server URL or command, required credentials, and the server's own logs. For local servers, confirm the executable is available to the runtime.",
                },
                {
                  title: "An action is waiting",
                  copy: "Look for an approval request in the thread. Read the requested action and make a choice to let the task continue or stop it.",
                },
              ].map((item) => (
                <div key={item.title}>
                  <h3 className="text-sm font-medium text-paper">
                    {item.title}
                  </h3>
                  <p className="mt-2 text-[13px] leading-7">{item.copy}</p>
                </div>
              ))}
            </div>
            <div className="mt-8 border-t border-white/10 pt-7">
              <p className="text-sm text-paper">Still need a hand?</p>
              <a
                href="https://github.com/axle-ai-code/Axle/issues"
                className="mt-3 inline-flex items-center gap-2 text-xs text-mute"
              >
                Open an issue with the error and steps to reproduce{" "}
                <ArrowUpRight size={14} />
              </a>
            </div>
          </DocSection>
        </article>
        <aside className="sticky top-28 hidden xl:block">
          <DocsNavigation contents />
          <div className="mt-9 border-t border-white/10 pt-5">
            <p className="text-[11px] text-mute">Something unclear?</p>
            <a
              href="https://github.com/axle-ai-code/Axle/issues"
              className="mt-3 inline-flex items-center gap-2 text-[11px]"
            >
              Suggest an edit <ArrowUpRight size={12} />
            </a>
          </div>
        </aside>
      </div>
    </div>
  );
}
