export const REPOSITORY_URL = "https://github.com/thatcreativetayo/AxleCode";

export const PRODUCT_STEPS = [
  { tag: "01 / Understand", title: "Start with the whole problem.", copy: "Point Axle at your project and describe what you want to change. It searches the code, reads the relevant files, and follows the details that connect them.", bullets: ["Work directly in your existing project folder", "Bring files and screenshots into the conversation", "Keep the reasoning and the work in one thread"] },
  { tag: "02 / Plan", title: "Make room to think first.", copy: "Use Plan mode to explore an approach before making edits. Ask questions, add constraints, and work through the tradeoffs with your code close at hand.", bullets: ["Read-only exploration in Plan mode", "Choose a model for the task in front of you", "Set approval controls for sensitive actions"] },
  { tag: "03 / Build", title: "Move from an idea to a real change.", copy: "Axle can edit files, run commands, and work with Git. Follow the changes as they happen, with the code and terminal output available to inspect.", bullets: ["Edits land in the files you already own", "Use your project's build tools and test runner", "Inspect the diff without losing the conversation"] },
  { tag: "04 / Continue", title: "Pick up where the work left off.", copy: "Your threads are saved locally. Come back to an investigation, check what changed, or connect to your computer from another device when you need to.", bullets: ["Persistent threads with history and search", "Keep related work organized by project", "Remote access over your network or Tailscale"] },
] as const;

export const FEATURE_DETAILS = [
  { group: "Make the change", items: [
    { title: "File tools", copy: "Read, search, and edit the files in your project." },
    { title: "Terminal access", copy: "Run commands and see the output in the same workspace." },
    { title: "Git workflow", copy: "Inspect changes, understand a branch, and work with your repository." },
    { title: "Streaming responses", copy: "Follow the response and the work as they happen." },
  ] },
  { group: "Make it yours", items: [
    { title: "Provider choice", copy: "Connect OpenAI, Anthropic, Google, OpenRouter, NVIDIA, Mistral, or any OpenAI-compatible endpoint with your own key." },
    { title: "Plan mode", copy: "Explore a problem with read-only tools before moving to edits." },
    { title: "Approval controls", copy: "Choose how sensitive file and command actions are approved." },
    { title: "Light and dark", copy: "Choose the theme that works best for your environment." },
  ] },
  { group: "Keep moving", items: [
    { title: "Project folders", copy: "Work with your existing folders, without moving your code." },
    { title: "Persistent threads", copy: "Return to earlier work with local history and search." },
    { title: "Windows and WSL", copy: "Use the local environment that fits your project." },
    { title: "Remote access", copy: "Reach your computer over your network or through Tailscale." },
  ] },
  { group: "Beyond the chat", items: [
    { title: "Pull requests", copy: "Review a pull request and follow the diff without leaving the app." },
    { title: "Cloud jobs", copy: "Move a long-running task to a cloud worker and collect the result later." },
    { title: "Plugins", copy: "Add capability with plugins and MCP servers under the permissions you set." },
    { title: "Schedules", copy: "Run a prompt on a schedule so recurring work takes care of itself." },
  ] },
] as const;

export const PRINCIPLES = [
  { number: "01", title: "Your computer. Your code.", copy: "A development workspace should fit around your repository. Axle works with ordinary files, familiar tools, and the environment you already use." },
  { number: "02", title: "Choice is part of the product.", copy: "Different tasks call for different models. Bring your own provider accounts and choose the model that makes sense for the work." },
  { number: "03", title: "The work should be visible.", copy: "See the tool calls, read the command output, and inspect the changes. Useful assistance leaves you with a clear picture of what happened." },
  { number: "04", title: "Build in the open.", copy: "The source is available under the MIT license. Read it, run it, improve it, or make it work a little differently for yourself." },
] as const;

export const PRODUCT_UPDATES = [
  { id: "remote-access", date: "October 12, 2026", datetime: "2026-10-12", tag: "New capability", title: "Your workspace, within reach.", summary: "Remote access now has a home in General settings. Connect to your computer over your local network or with Tailscale, with the controls available from the desktop app.", items: ["Remote access settings are available in the General panel.", "The sidebar now follows the active light or dark theme."], commits: ["d4aee15", "428b80a"] },
  { id: "workspace-reliability", date: "October 12, 2026", datetime: "2026-10-12", tag: "Improvements", title: "A steadier start to every task.", summary: "This update tightens the handoff between the desktop app and its local environment, with fixes for draft startup and account sessions.", items: ["Drafts wait for the local environment to become available before starting.", "Signing out correctly revokes the desktop session.", "Desktop type checking errors were resolved."], commits: ["da13e60", "965ac05"] },
  { id: "release-workflow", date: "October 12, 2026", datetime: "2026-10-12", tag: "Developer experience", title: "A clearer path from source to desktop.", summary: "The project guide now covers installation, local development, and how the desktop app works. Release automation also received a few practical improvements.", items: ["Tag builds create and publish a GitHub release.", "Linux signing is optional in the release workflow.", "The README includes the current app and setup instructions."], commits: ["10debad", "7668bf6", "e8bf01b"] },
] as const;
