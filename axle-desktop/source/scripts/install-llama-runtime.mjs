#!/usr/bin/env node
/**
 * Stages a llama.cpp `llama-server` runtime for Axle Offline development.
 *
 * The desktop app checks `AXLE_LLAMA_SERVER_PATH` first, then the bundled
 * `resources/axle/llama/<platform>/llama-server` path, then PATH. This script
 * downloads the official llama.cpp release for the current machine so
 * `pnpm dev` can run offline packs without a manual install.
 *
 * Set AXLE_LLAMA_CPP_RELEASE_URL to a GitHub release API URL or a direct zip /
 * tar.gz URL to pin a build, and AXLE_LLAMA_SERVER_PATH to reuse an existing
 * binary instead.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "..");
const resourcesRoot = NodePath.join(repoRoot, "apps", "desktop", "resources", "axle", "llama");

const platformKey = (() => {
  if (process.platform === "win32") return process.arch === "arm64" ? "win32-arm64" : "win32-x64";
  if (process.platform === "darwin")
    return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (process.platform === "linux") return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
  return undefined;
})();

const binaryName = process.platform === "win32" ? "llama-server.exe" : "llama-server";

function log(message) {
  process.stdout.write(`[llama-runtime] ${message}\n`);
}

async function exists(path) {
  try {
    await NodeFSP.access(path);
    return true;
  } catch {
    return false;
  }
}

async function downloadFile(url, destination) {
  log(`Downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body === null) {
    throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  }
  const total = Number(response.headers.get("content-length") ?? "0");
  const handle = await NodeFSP.open(destination, "w");
  let received = 0;
  let lastLog = Date.now();
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      await handle.write(buffer);
      received += buffer.length;
      if (Date.now() - lastLog > 5_000) {
        lastLog = Date.now();
        const percent = total > 0 ? ` (${Math.round((received / total) * 100)}%)` : "";
        log(`Downloaded ${(received / 1_000_000).toFixed(1)} MB${percent}`);
      }
    }
  } finally {
    await handle.close();
  }
}

function pickAsset(assets) {
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const candidates =
    process.platform === "win32"
      ? [
          new RegExp(`bin-win-vulkan-${architecture}\\.zip$`, "iu"),
          new RegExp(`bin-win-cpu-${architecture}\\.zip$`, "iu"),
          new RegExp(`bin-win-avx2-${architecture}\\.zip$`, "iu"),
          new RegExp(`bin-win-cuda-\\d+\\.\\d+-${architecture}\\.zip$`, "iu"),
        ]
      : process.platform === "darwin"
        ? [new RegExp(`bin-macos-${architecture}\\.(?:zip|tar\\.gz)$`, "iu")]
        : [
            // Plain Ubuntu builds are the most portable and cover both x64
            // and arm64 Linux desktops.
            new RegExp(`bin-ubuntu-${architecture}\\.(?:zip|tar\\.gz)$`, "iu"),
            new RegExp(`bin-ubuntu-vulkan-${architecture}\\.(?:zip|tar\\.gz)$`, "iu"),
            new RegExp(`bin-linux-${architecture}\\.(?:zip|tar\\.gz)$`, "iu"),
          ];
  for (const pattern of candidates) {
    const asset = assets.find((entry) => pattern.test(entry.name));
    if (asset) return asset;
  }
  return undefined;
}

function usableAssets(payload) {
  return Array.isArray(payload?.assets)
    ? payload.assets.filter(
        (entry) =>
          typeof entry?.name === "string" &&
          typeof entry?.browser_download_url === "string" &&
          entry.browser_download_url.startsWith("https://"),
      )
    : [];
}

function releaseFromPayload(payload) {
  const asset = pickAsset(usableAssets(payload));
  if (!asset) return undefined;
  return { url: asset.browser_download_url, name: asset.name, tag: payload.tag_name };
}

async function fetchJson(url) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "axle-desktop" };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed (HTTP ${response.status}): ${url}`);
  }
  return response.json();
}

async function findRecentRelease() {
  // llama.cpp's stable-looking `latest` release only points at a nightly tag;
  // the actual binaries live on nightly prereleases. Walk the release feed
  // newest-first and take the first build with a runtime for this platform.
  const payload = await fetchJson(
    "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15",
  );
  if (!Array.isArray(payload)) {
    throw new Error("GitHub returned an unexpected llama.cpp release list.");
  }
  for (const release of payload) {
    const candidate = releaseFromPayload(release);
    if (candidate) return candidate;
  }
  throw new Error(
    "No recent llama.cpp release has a runtime asset for this platform. Set AXLE_LLAMA_CPP_RELEASE_URL to a direct download.",
  );
}

async function resolveRelease() {
  const override = process.env.AXLE_LLAMA_CPP_RELEASE_URL?.trim();
  if (override) {
    if (/\/releases(?:\/latest|\/\?.*)?$/u.test(override)) {
      const payload = await fetchJson(override);
      const release = releaseFromPayload(payload);
      if (release) return release;
      log("The requested release has no runtime asset; checking recent llama.cpp releases.");
      return findRecentRelease();
    }
    return { url: override, name: NodePath.basename(new URL(override).pathname), tag: "custom" };
  }

  try {
    return await findRecentRelease();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${detail} Set AXLE_LLAMA_CPP_RELEASE_URL to a direct download.`);
  }
}

async function extractArchive(archive, destination) {
  await NodeFSP.mkdir(destination, { recursive: true });
  if (archive.endsWith(".zip")) {
    if (process.platform === "win32") {
      NodeChildProcess.execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`,
        ],
        { stdio: "inherit" },
      );
    } else {
      NodeChildProcess.execFileSync("unzip", ["-q", "-o", archive, "-d", destination], {
        stdio: "inherit",
      });
    }
    return;
  }
  if (archive.endsWith(".tar.gz") || archive.endsWith(".tgz")) {
    NodeChildProcess.execFileSync("tar", ["-xzf", archive, "-C", destination], {
      stdio: "inherit",
    });
    return;
  }
  throw new Error(`Unsupported archive type: ${NodePath.basename(archive)}`);
}

async function findBinary(directory) {
  const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = NodePath.join(directory, entry.name);
    if (entry.isFile() && entry.name === binaryName) return fullPath;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findBinary(NodePath.join(directory, entry.name));
    if (found) return found;
  }
  return undefined;
}

async function copyDirectory(source, destination) {
  await NodeFSP.mkdir(destination, { recursive: true });
  for (const entry of await NodeFSP.readdir(source, { withFileTypes: true })) {
    const from = NodePath.join(source, entry.name);
    const to = NodePath.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(from, to);
    } else if (entry.isFile()) {
      await NodeFSP.copyFile(from, to);
    }
  }
}

async function main() {
  if (!platformKey) {
    throw new Error(`Unsupported platform ${process.platform}/${process.arch}.`);
  }
  const explicit = process.env.AXLE_LLAMA_SERVER_PATH?.trim();
  if (explicit) {
    if (!(await exists(explicit)))
      throw new Error(`AXLE_LLAMA_SERVER_PATH does not exist: ${explicit}`);
    log(`Using existing runtime at ${explicit}`);
    return;
  }

  const targetDir = NodePath.join(resourcesRoot, platformKey);
  const targetBinary = NodePath.join(targetDir, binaryName);
  if ((await exists(targetBinary)) && process.env.AXLE_LLAMA_FORCE_INSTALL !== "1") {
    log(`Runtime already installed at ${targetBinary}`);
    return;
  }

  const release = await resolveRelease();
  log(`Using llama.cpp ${release.tag ?? "release"} (${release.name})`);
  if (process.env.AXLE_LLAMA_DRY_RUN === "1") {
    log(`Dry run: would download ${release.url}`);
    return;
  }
  const temporaryRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "axle-llama-"));
  const archive = NodePath.join(temporaryRoot, release.name);
  const extracted = NodePath.join(temporaryRoot, "extracted");
  try {
    await downloadFile(release.url, archive);
    await extractArchive(archive, extracted);
    const binary = await findBinary(extracted);
    if (!binary) throw new Error(`The archive did not contain ${binaryName}.`);
    await NodeFSP.rm(targetDir, { recursive: true, force: true });
    await copyDirectory(NodePath.dirname(binary), targetDir);
    if (process.platform !== "win32") {
      await NodeFSP.chmod(NodePath.join(targetDir, binaryName), 0o755);
    }
    log(`Installed runtime at ${NodePath.join(targetDir, binaryName)}`);
  } finally {
    await NodeFSP.rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `[llama-runtime] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
