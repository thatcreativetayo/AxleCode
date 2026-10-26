<div align="center">
  <img src="axle-desktop/source/apps/marketing/public/icon.png" alt="Axle" width="96" />
  <h1>Axle</h1>
  <p><strong>An AI engineer that lives on your computer.</strong><br/>
  Chat with it and it reads your code, edits files, runs commands, and shows you every change.</p>
</div>

![Axle running a coding task](docs/images/app-screenshot.png)

## What is Axle?

Axle is a desktop app (Windows, macOS, Linux) for working on code with AI. You point it at a folder, ask for something in plain English, and instead of only telling you what to do, it does it: opens the right files, makes the edits, runs your tests and terminal commands, and shows you a diff before anything important happens.

Think of it as a pair programmer sitting inside your machine. You keep your keyboard, your files, and your API keys. Axle is not a website; it runs locally on your computer, and the only network traffic is the model calls you make with your own key.

## Real-world examples

- "Fix the failing checkout test" - it runs the test, reads the failure, follows the code, patches it, and re-runs until it is green.
- "Add a dark mode toggle" - it finds the theme files, writes the styles, wires up the toggle, and runs the build.
- "Why is the dashboard slow on first load?" - it searches the codebase, follows the data flow, and explains with file references.
- "Rename Customer to Account across the repo" - it greps, edits every call site, and typechecks.
- "Summarize what changed on this branch" - it reads the git history and diffs, then writes the summary.

## Install

1. Open the [Releases page](https://github.com/thatcreativetayo/AxleCode/releases).
2. Download the file for your operating system:
   - Windows: `Axle-x64.exe` (installer)
   - macOS: `Axle-arm64.dmg` (Apple silicon) or `Axle-x64.dmg` (Intel)
   - Linux: `Axle-x64.AppImage` or `Axle-amd64.deb`
3. Install and open Axle.
4. Go to **Settings > Models**, paste an API key from OpenAI, Anthropic, or Google, and pick a model.
5. Start chatting.

No folder is required to start. Add project folders when you want the agent to work inside specific code.

## How it works (the 30-second version)

```
You  <->  Axle desktop app (chat window)
              |  starts one axle process per turn
              v
          axle runtime (Rust): model calls, tools, approvals, sessions
              |
              v
     Your files / terminal / git      ...and the model API (your key)
```

1. The Axle window is the chat UI.
2. Every request starts a small local engine (`axle`, written in Rust). It is the part that actually thinks with the model and uses tools.
3. Tools are the boring-but-powerful part: read files, search, edit, run commands, use git.
4. Anything risky - running a command, editing a file - can ask for your approval first.
5. Conversations are saved on disk (`.axle/sessions`), so you can close the app and pick up where you left off.

## Features

- Chat with streaming responses and visible reasoning
- A full toolbelt: file reading and editing, search, terminal, and git
- Approval prompts for sensitive actions, plus a read-only Plan mode
- Projects (folders) and multiple environments, including WSL on Windows
- Remote access: reach your computer from another device over your local network or Tailscale (Settings > Remote access)
- Persistent threads with history and search
- Light and dark themes
- Multiple model providers: OpenAI / Codex, Anthropic / Claude, Google / Gemini, OpenRouter

## Releasing a new version (maintainers)

```bash
git tag v1.1.23
git push origin v1.1.23
```

That is it. The **Build Axle Desktop** workflow builds the Windows installer, macOS DMGs (Intel and Apple silicon), and Linux AppImage/deb, then publishes a GitHub Release with all of them.

## Build from source

Prerequisites: Node.js 24+, [Vite+](https://viteplus.dev/guide/) (`vp`) or pnpm, and a Rust toolchain.

```bash
# 1. Build the Rust engine (from the repository root)
cargo build --release -p axle_cli

# 2. Build and package the desktop app
cd axle-desktop/source
vp i
pnpm dist:desktop:win:x64      # Windows installer
pnpm dist:desktop:dmg:arm64    # macOS (Apple silicon)
pnpm dist:desktop:dmg:x64      # macOS (Intel)
pnpm dist:desktop:linux        # Linux AppImage
pnpm dist:desktop:linux:deb    # Linux deb
```

## Where things live

| Path | What it is |
| --- | --- |
| `crates/` | The Rust engine (`axle` CLI): agent loop, providers, tools, sessions |
| `axle-desktop/source/apps/desktop` | Electron shell - the app window |
| `axle-desktop/source/apps/server` | Local server: orchestration, checkpoints, persistence |
| `axle-desktop/source/apps/web` | The chat UI (React) |
| `docs/` | Architecture and configuration documents |

## Documentation

- [Architecture](docs/axle-architecture.md)
- [Configuration](docs/axle-configuration.md)
- [Getting started](axle-desktop/source/docs/getting-started/quick-start.md)
- [Remote access](axle-desktop/source/docs/user/remote-access.md)
- [Release process](axle-desktop/source/docs/operations/release.md)

## License

MIT - see [axle-desktop/source/LICENSE](axle-desktop/source/LICENSE).
