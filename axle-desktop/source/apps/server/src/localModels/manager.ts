// @effect-diagnostics globalDate:off globalFetch:off nodeBuiltinImport:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import type { LocalModelPackId, LocalModelPackState, LocalModelSnapshot } from "@axle/contracts";
import { LOCAL_MODEL_PACK_MIN_PLAN } from "@axle/contracts";

import { LOCAL_MODEL_PACKS, localModelPackSize, type LocalModelPackDefinition } from "./catalog.ts";

interface InstalledPackRecord {
  readonly installedAt: string;
  readonly files: Readonly<Record<string, { readonly sizeBytes: number; readonly sha256: string }>>;
}

interface LocalModelsState {
  readonly version: 1;
  readonly installed: Readonly<Record<string, InstalledPackRecord>>;
}

interface ActiveDownload {
  readonly packId: LocalModelPackId;
  readonly controller: AbortController;
  downloadedBytes: number;
}

interface RuntimeHandle {
  readonly packId: LocalModelPackId;
  readonly port: number;
  readonly baseUrl: string;
  readonly child: ReturnType<typeof NodeChildProcess.spawn>;
  ready: boolean;
  error: string | null;
  stderr: string;
}

const STATE_VERSION = 1 as const;
const HEALTH_TIMEOUT_MS = 10 * 60_000;
const HEALTH_POLL_MS = 500;

const emptyState: LocalModelsState = { version: STATE_VERSION, installed: {} };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readState = async (statePath: string): Promise<LocalModelsState> => {
  try {
    const raw = await NodeFSP.readFile(statePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== STATE_VERSION || !isRecord(parsed.installed)) {
      return emptyState;
    }
    const installed: Record<string, InstalledPackRecord> = {};
    for (const [packId, record] of Object.entries(parsed.installed)) {
      if (!isRecord(record) || !isRecord(record.files)) continue;
      const files: Record<string, { sizeBytes: number; sha256: string }> = {};
      for (const [fileName, fileRecord] of Object.entries(record.files)) {
        if (
          !isRecord(fileRecord) ||
          typeof fileRecord.sizeBytes !== "number" ||
          typeof fileRecord.sha256 !== "string"
        ) {
          continue;
        }
        files[fileName] = {
          sizeBytes: fileRecord.sizeBytes,
          sha256: fileRecord.sha256,
        };
      }
      if (Object.keys(files).length === 0) continue;
      installed[packId] = {
        installedAt:
          typeof record.installedAt === "string" ? record.installedAt : new Date().toISOString(),
        files,
      };
    }
    return { version: STATE_VERSION, installed };
  } catch {
    return emptyState;
  }
};

const writeState = async (statePath: string, state: LocalModelsState): Promise<void> => {
  await NodeFSP.mkdir(NodePath.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await NodeFSP.rename(temporary, statePath);
};

export const readInstalledPackIds = async (statePath: string): Promise<Set<LocalModelPackId>> => {
  const state = await readState(statePath);
  return new Set(
    LOCAL_MODEL_PACKS.filter((pack) => state.installed[pack.id] !== undefined).map(
      (pack) => pack.id,
    ),
  );
};

const platformDirectory = (): string | undefined => {
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "win32-arm64" : "win32-x64";
  }
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
  }
  return undefined;
};

const executableName = (): string =>
  process.platform === "win32" ? "llama-server.exe" : "llama-server";

const pathExists = (path: string): boolean => {
  try {
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const commandOnPath = (command: string): string | undefined => {
  try {
    const result = NodeChildProcess.spawnSync(
      process.platform === "win32" ? "where.exe" : "which",
      [command],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.status !== 0) return undefined;
    return result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
  } catch {
    return undefined;
  }
};

export function resolveLlamaServerPath(): string | undefined {
  const explicit = process.env.AXLE_LLAMA_SERVER_PATH?.trim();
  if (explicit) return pathExists(explicit) ? explicit : undefined;

  const platform = platformDirectory();
  const binary = executableName();
  const relative = platform ? NodePath.join("axle", "llama", platform, binary) : undefined;
  const resourcesPath = (process as NodeJS.Process & { readonly resourcesPath?: string })
    .resourcesPath;
  const candidates = [
    ...(process.env.AXLE_RESOURCES_DIR?.trim() && relative
      ? [NodePath.join(process.env.AXLE_RESOURCES_DIR.trim(), relative)]
      : []),
    ...(typeof resourcesPath === "string" && relative
      ? [NodePath.join(resourcesPath, relative)]
      : []),
    ...(relative
      ? [
          NodePath.resolve(import.meta.dirname, "../../../desktop/resources", relative),
          NodePath.resolve(process.cwd(), "apps/desktop/resources", relative),
        ]
      : []),
  ];
  for (const candidate of candidates) {
    if (pathExists(candidate)) return candidate;
  }
  return commandOnPath("llama-server");
}

const createAbortTimeout = (milliseconds: number): AbortSignal => AbortSignal.timeout(milliseconds);

const findFreePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        server.close(() => reject(new Error("Could not allocate a loopback port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const statSize = async (path: string): Promise<number | undefined> => {
  try {
    return (await NodeFSP.stat(path)).size;
  } catch {
    return undefined;
  }
};

const hashFile = async (filePath: string): Promise<string> => {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
};

const ensureInside = (root: string, candidate: string): boolean => {
  const relative = NodePath.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

export class LocalModelManager {
  readonly modelsDir: string;
  readonly statePath: string;
  readonly packs: ReadonlyArray<LocalModelPackDefinition>;
  private state: LocalModelsState = emptyState;
  private initialized = false;
  private active = new Map<LocalModelPackId, ActiveDownload>();
  private pending = new Set<LocalModelPackId>();
  private cancelRequested = new Set<LocalModelPackId>();
  private errors = new Map<LocalModelPackId, string>();
  private runtime: RuntimeHandle | undefined;
  private runtimeStarting: LocalModelPackId | undefined;
  private runtimeError: { readonly packId: LocalModelPackId; readonly message: string } | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(input: {
    readonly modelsDir: string;
    readonly statePath: string;
    readonly packs?: ReadonlyArray<LocalModelPackDefinition>;
  }) {
    this.modelsDir = input.modelsDir;
    this.statePath = input.statePath;
    this.packs = input.packs ?? LOCAL_MODEL_PACKS;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await NodeFSP.mkdir(this.modelsDir, { recursive: true });
    this.state = await readState(this.statePath);
    this.initialized = true;
    // If a previous server process was killed mid-download, the partial file
    // stays and the next install resumes from its byte offset.
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private pack(packId: LocalModelPackId): LocalModelPackDefinition | undefined {
    return this.packs.find((pack) => pack.id === packId);
  }

  private packDir(pack: LocalModelPackDefinition): string {
    return NodePath.join(this.modelsDir, pack.id);
  }

  private packFilePath(pack: LocalModelPackDefinition, fileName: string): string {
    return NodePath.join(this.packDir(pack), fileName);
  }

  private isInstalled(pack: LocalModelPackDefinition): boolean {
    const record = this.state.installed[pack.id];
    if (!record) return false;
    return pack.files.every((entry) => {
      const installed = record.files[entry.fileName];
      return (
        installed !== undefined &&
        installed.sizeBytes === entry.sizeBytes &&
        installed.sha256.toLowerCase() === entry.sha256.toLowerCase() &&
        NodeFS.existsSync(this.packFilePath(pack, entry.fileName))
      );
    });
  }

  private packState(pack: LocalModelPackDefinition): LocalModelPackState {
    const installed = this.isInstalled(pack);
    const active = this.active.get(pack.id);
    const pending = this.pending.has(pack.id);
    const error = this.errors.get(pack.id);
    const total = localModelPackSize(pack);
    return {
      id: pack.id,
      name: pack.name,
      description: pack.description,
      model: pack.model,
      quantization: pack.quantization,
      sizeBytes: total,
      minRamGb: pack.minRamGb,
      contextWindowTokens: pack.contextWindowTokens,
      minPlanTier: LOCAL_MODEL_PACK_MIN_PLAN[pack.id],
      capabilities: pack.id === "vision" ? ["text", "code", "vision"] : ["text", "code"],
      license: pack.license,
      sourceUrl: pack.sourceUrl,
      status: active
        ? "downloading"
        : pending
          ? "installing"
          : installed
            ? "installed"
            : error
              ? "error"
              : "not-installed",
      progress: active
        ? Math.min(1, active.downloadedBytes / Math.max(total, 1))
        : installed
          ? 1
          : 0,
      installedBytes: installed ? total : 0,
      error: active || pending ? null : (error ?? null),
    };
  }

  async snapshot(): Promise<LocalModelSnapshot> {
    await this.ensureInitialized();
    const packs = this.packs.map((pack) => this.packState(pack));
    const runtime = this.runtime;
    return {
      packs,
      runtime: {
        status: runtime
          ? runtime.error
            ? "error"
            : runtime.ready
              ? "ready"
              : "starting"
          : this.runtimeStarting
            ? "starting"
            : this.runtimeError
              ? "error"
              : "stopped",
        packId: runtime?.packId ?? this.runtimeStarting ?? this.runtimeError?.packId ?? null,
        error: runtime?.error ?? this.runtimeError?.message ?? null,
        runtimeAvailable: resolveLlamaServerPath() !== undefined,
      },
      totalInstalledBytes: packs.reduce((total, pack) => total + pack.installedBytes, 0),
      modelsDir: this.modelsDir,
    };
  }

  async install(packId: LocalModelPackId, sourcePath?: string): Promise<LocalModelSnapshot> {
    await this.ensureInitialized();
    const pack = this.pack(packId);
    if (!pack) throw new Error(`Unknown local model pack '${packId}'.`);
    return this.exclusive(async () => {
      // A queued removal may have arrived while this install waited behind
      // another pack. Skip the download; the removal that follows deletes any
      // partial files.
      if (this.cancelRequested.delete(packId)) return this.snapshot();
      this.errors.delete(packId);
      if (this.isInstalled(pack)) return this.snapshot();
      try {
        if (sourcePath?.trim()) {
          await this.installFromPath(pack, sourcePath.trim());
        } else {
          await this.downloadPack(pack);
        }
        const files = Object.fromEntries(
          pack.files.map((entry) => [
            entry.fileName,
            { sizeBytes: entry.sizeBytes, sha256: entry.sha256 },
          ]),
        );
        this.state = {
          version: STATE_VERSION,
          installed: {
            ...this.state.installed,
            [packId]: { installedAt: new Date().toISOString(), files },
          },
        };
        await writeState(this.statePath, this.state);
        return this.snapshot();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        this.errors.set(packId, message);
        throw cause;
      } finally {
        this.active.delete(packId);
      }
    });
  }

  /**
   * Starts an install without holding the HTTP request open. The UI polls
   * `snapshot()` for progress; errors surface on the pack itself.
   */
  async startInstall(packId: LocalModelPackId, sourcePath?: string): Promise<LocalModelSnapshot> {
    await this.ensureInitialized();
    const pack = this.pack(packId);
    if (!pack) throw new Error(`Unknown local model pack '${packId}'.`);
    this.cancelRequested.delete(packId);
    this.errors.delete(packId);
    this.pending.add(packId);
    void this.install(packId, sourcePath)
      .catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        this.errors.set(packId, message);
      })
      .finally(() => {
        this.pending.delete(packId);
      });
    return this.snapshot();
  }

  private async installFromPath(pack: LocalModelPackDefinition, sourcePath: string): Promise<void> {
    const targetDir = this.packDir(pack);
    await NodeFSP.mkdir(targetDir, { recursive: true });
    const sourceStat = await NodeFSP.stat(sourcePath).catch(() => undefined);
    if (sourceStat?.isDirectory()) {
      for (const entry of pack.files) {
        const candidate = NodePath.join(sourcePath, entry.fileName);
        if (!NodeFS.existsSync(candidate)) {
          throw new Error(`${pack.name} needs ${entry.fileName} in ${sourcePath}.`);
        }
        await this.copyAndVerify(
          candidate,
          this.packFilePath(pack, entry.fileName),
          entry.sizeBytes,
          entry.sha256,
        );
      }
      return;
    }
    if (!sourceStat?.isFile()) {
      throw new Error(`Local model path does not exist: ${sourcePath}`);
    }
    const primary = pack.files.find((entry) => entry.fileName === pack.primaryFileName);
    if (!primary) throw new Error(`${pack.name} has no primary model file.`);
    await this.copyAndVerify(
      sourcePath,
      this.packFilePath(pack, primary.fileName),
      primary.sizeBytes,
      primary.sha256,
    );
    for (const entry of pack.files) {
      if (entry.fileName === primary.fileName) continue;
      const sibling = NodePath.join(NodePath.dirname(sourcePath), entry.fileName);
      if (!NodeFS.existsSync(sibling)) {
        throw new Error(
          `${pack.name} also needs ${entry.fileName} beside the selected file (${NodePath.dirname(sourcePath)}).`,
        );
      }
      await this.copyAndVerify(
        sibling,
        this.packFilePath(pack, entry.fileName),
        entry.sizeBytes,
        entry.sha256,
      );
    }
  }

  private async copyAndVerify(
    source: string,
    destination: string,
    expectedSize: number,
    expectedSha256: string,
  ): Promise<void> {
    this.ensureSafeDestination(destination);
    const temporary = `${destination}.part`;
    await NodeFSP.copyFile(source, temporary);
    const stat = await NodeFSP.stat(temporary);
    if (stat.size !== expectedSize) {
      await NodeFSP.rm(temporary, { force: true });
      throw new Error(
        `Local model file ${NodePath.basename(source)} is ${stat.size} bytes; expected ${expectedSize} bytes.`,
      );
    }
    const digest = await hashFile(temporary);
    if (digest.toLowerCase() !== expectedSha256.toLowerCase()) {
      await NodeFSP.rm(temporary, { force: true });
      throw new Error(
        `Local model file ${NodePath.basename(source)} failed checksum verification.`,
      );
    }
    await NodeFSP.rename(temporary, destination);
  }

  private ensureSafeDestination(destination: string): void {
    if (!ensureInside(this.modelsDir, destination)) {
      throw new Error("Refusing to write a local model outside the models directory.");
    }
  }

  private async downloadPack(pack: LocalModelPackDefinition): Promise<void> {
    const totalBytes = localModelPackSize(pack);
    const targetDir = this.packDir(pack);
    await NodeFSP.mkdir(targetDir, { recursive: true });
    let resumedBytes = 0;
    const previousRecord = this.state.installed[pack.id];
    for (const entry of pack.files) {
      const destination = this.packFilePath(pack, entry.fileName);
      this.ensureSafeDestination(destination);
      const finalized = await statSize(destination);
      const recordedSha256 = previousRecord?.files[entry.fileName]?.sha256?.toLowerCase();
      if (
        finalized === entry.sizeBytes &&
        (recordedSha256 === undefined || recordedSha256 === entry.sha256.toLowerCase())
      ) {
        continue;
      }
      if (finalized !== undefined) await NodeFSP.rm(destination, { force: true });
      const partial = await statSize(`${destination}.part`);
      if (partial !== undefined) resumedBytes += Math.min(partial, entry.sizeBytes);
    }
    const active: ActiveDownload = {
      packId: pack.id,
      controller: new AbortController(),
      downloadedBytes: resumedBytes,
    };
    this.active.set(pack.id, active);
    for (const entry of pack.files) {
      const destination = this.packFilePath(pack, entry.fileName);
      this.ensureSafeDestination(destination);
      await this.downloadFile(entry, destination, active);
    }
  }

  private async downloadFile(
    entry: LocalModelPackDefinition["files"][number],
    destination: string,
    active: ActiveDownload,
  ): Promise<void> {
    if (active.controller.signal.aborted) {
      throw new Error("The model download was cancelled.");
    }
    const partPath = `${destination}.part`;
    let existing = 0;
    try {
      existing = (await NodeFSP.stat(partPath)).size;
    } catch {
      existing = 0;
    }
    if (existing > entry.sizeBytes) {
      active.downloadedBytes = Math.max(0, active.downloadedBytes - existing);
      await NodeFSP.rm(partPath, { force: true });
      existing = 0;
    }
    if (existing === entry.sizeBytes) {
      active.downloadedBytes += 0;
      await this.verifyAndPromote(partPath, destination, entry.sizeBytes, entry.sha256);
      return;
    }

    let attempt = 0;
    while (attempt < 3) {
      attempt += 1;
      try {
        const response = await fetch(entry.url, {
          headers: existing > 0 ? { Range: `bytes=${existing}-` } : {},
          redirect: "follow",
          signal: active.controller.signal,
        });
        if (response.status === 416 && existing === entry.sizeBytes) {
          await this.verifyAndPromote(partPath, destination, entry.sizeBytes, entry.sha256);
          return;
        }
        if (!response.ok || response.body === null) {
          throw new Error(`Download failed with HTTP ${response.status}.`);
        }
        const append = response.status === 206 && existing > 0;
        if (!append && existing > 0) {
          // The server ignored our Range header, so the partial file is about
          // to be truncated. Drop its bytes from the progress counter too.
          active.downloadedBytes = Math.max(0, active.downloadedBytes - existing);
          existing = 0;
        }
        const handle = await NodeFSP.open(partPath, append ? "a" : "w");
        try {
          const body = NodeStream.Readable.fromWeb(
            response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
          );
          for await (const chunk of body) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
            await handle.write(buffer);
            active.downloadedBytes += buffer.length;
            existing += buffer.length;
          }
        } finally {
          await handle.close();
        }
        const stat = await NodeFSP.stat(partPath);
        if (stat.size !== entry.sizeBytes) {
          throw new Error(
            `Downloaded ${stat.size} bytes for ${entry.fileName}; expected ${entry.sizeBytes}.`,
          );
        }
        await this.verifyAndPromote(partPath, destination, entry.sizeBytes, entry.sha256);
        return;
      } catch (cause) {
        if (active.controller.signal.aborted) {
          throw new Error("The model download was cancelled.");
        }
        if (attempt >= 3) throw cause;
        await sleep(750 * attempt);
      }
    }
  }

  private async verifyAndPromote(
    partPath: string,
    destination: string,
    expectedSize: number,
    expectedSha256: string,
  ): Promise<void> {
    const stat = await NodeFSP.stat(partPath);
    if (stat.size !== expectedSize) {
      throw new Error(`Downloaded file has ${stat.size} bytes; expected ${expectedSize}.`);
    }
    const digest = await hashFile(partPath);
    if (digest.toLowerCase() !== expectedSha256.toLowerCase()) {
      await NodeFSP.rm(partPath, { force: true });
      throw new Error(
        `Downloaded file ${NodePath.basename(destination)} failed checksum verification.`,
      );
    }
    await NodeFSP.rename(partPath, destination);
  }

  async remove(packId: LocalModelPackId): Promise<LocalModelSnapshot> {
    await this.ensureInitialized();
    // Cancel an in-flight download before waiting for the install queue, or a
    // multi-gigabyte download would delay the removal indefinitely. Also mark
    // a queued install so it can skip its download when its turn arrives.
    this.cancelRequested.add(packId);
    this.active.get(packId)?.controller.abort();
    return this.exclusive(async () => {
      this.cancelRequested.delete(packId);
      if (this.runtime?.packId === packId) await this.stopRuntime();
      if (this.runtimeStarting === packId) this.runtimeStarting = undefined;
      if (this.runtimeError?.packId === packId) this.runtimeError = undefined;
      const pack = this.pack(packId);
      if (pack) await NodeFSP.rm(this.packDir(pack), { recursive: true, force: true });
      const installed = { ...this.state.installed };
      delete installed[packId];
      this.state = { version: STATE_VERSION, installed };
      this.errors.delete(packId);
      await writeState(this.statePath, this.state);
      return this.snapshot();
    });
  }

  /**
   * Kicks off model loading without waiting for llama-server to finish reading
   * the GGUF. The HTTP route returns immediately and the UI polls `snapshot()`.
   */
  async startRuntime(packId: LocalModelPackId): Promise<LocalModelSnapshot> {
    await this.ensureInitialized();
    const pack = this.pack(packId);
    if (!pack) throw new Error(`Unknown local model pack '${packId}'.`);
    if (!this.isInstalled(pack)) {
      throw new Error(`${pack.name} is not installed yet. Install it from Providers first.`);
    }
    if (this.runtime?.packId === packId && this.runtime.ready) return this.snapshot();
    this.runtimeError = undefined;
    this.runtimeStarting = packId;
    void this.ensureRuntime(packId)
      .catch((cause) => {
        this.runtimeError = {
          packId,
          message:
            cause instanceof Error ? cause.message : "The local runtime could not be started.",
        };
      })
      .finally(() => {
        if (this.runtimeStarting === packId) this.runtimeStarting = undefined;
      });
    return this.snapshot();
  }

  async ensureRuntime(packId: LocalModelPackId): Promise<{
    readonly baseUrl: string;
    readonly apiKey: string;
  }> {
    await this.ensureInitialized();
    if (
      this.runtime !== undefined &&
      this.runtime.packId === packId &&
      this.runtime.ready &&
      !this.runtime.error &&
      this.runtime.child.exitCode === null
    ) {
      return { baseUrl: this.runtime.baseUrl, apiKey: "" };
    }
    return this.exclusive(async () => {
      this.runtimeError = undefined;
      if (
        this.runtime !== undefined &&
        this.runtime.packId === packId &&
        this.runtime.ready &&
        !this.runtime.error &&
        this.runtime.child.exitCode === null
      ) {
        return { baseUrl: this.runtime.baseUrl, apiKey: "" };
      }
      const pack = this.pack(packId);
      if (!pack) throw new Error(`Unknown local model pack '${packId}'.`);
      if (!this.isInstalled(pack)) {
        throw new Error(`${pack.name} is not installed yet. Install it from Providers first.`);
      }
      const binary = resolveLlamaServerPath();
      if (!binary) {
        throw new Error(
          "The local inference runtime is missing. Run `pnpm local-runtime:install`, set AXLE_LLAMA_SERVER_PATH, or reinstall Axle.",
        );
      }
      await this.stopRuntime();
      const port = await findFreePort();
      const primary = this.packFilePath(pack, pack.primaryFileName);
      const mmproj = pack.mmprojFileName ? this.packFilePath(pack, pack.mmprojFileName) : undefined;
      const threads = Math.max(4, Math.floor(NodeOS.cpus().length / 2));
      const args = [
        "--model",
        primary,
        "--alias",
        pack.id,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--ctx-size",
        String(pack.contextWindowTokens),
        "--threads",
        String(threads),
        "--gpu-layers",
        "999",
        "--parallel",
        "1",
        "--jinja",
        ...(mmproj ? ["--mmproj", mmproj] : []),
      ];
      const child = NodeChildProcess.spawn(binary, args, {
        cwd: this.packDir(pack),
        env: { ...process.env, LLAMA_SERVER_NO_WEBUI: "1" },
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const runtime: RuntimeHandle = {
        packId,
        port,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        child,
        ready: false,
        error: null,
        stderr: "",
      };
      this.runtime = runtime;
      const appendStderr = (chunk: Buffer) => {
        runtime.stderr = `${runtime.stderr}${chunk.toString("utf8")}`;
        if (runtime.stderr.length > 65_536) runtime.stderr = runtime.stderr.slice(-65_536);
      };
      child.stderr?.on("data", appendStderr);
      child.stdout?.on("data", () => undefined);
      const killOnProcessExit = () => {
        if (child.exitCode !== null) return;
        try {
          child.kill();
        } catch {
          // The process may already be gone.
        }
      };
      process.once("exit", killOnProcessExit);
      child.once("error", (cause) => {
        runtime.error = cause.message;
      });
      child.once("exit", (code, signal) => {
        process.removeListener("exit", killOnProcessExit);
        if (this.runtime === runtime) {
          runtime.ready = false;
          if (runtime.error === null) {
            runtime.error =
              code === 0
                ? "The local runtime stopped."
                : `The local runtime exited (${signal ?? code ?? "unknown"}).${runtime.stderr.trim() ? ` ${runtime.stderr.trim().slice(-1000)}` : ""}`;
          }
        }
      });
      const healthUrl = `http://127.0.0.1:${port}/health`;
      const deadline = Date.now() + HEALTH_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (runtime.error) throw new Error(runtime.error);
        if (child.exitCode !== null) {
          throw new Error(
            runtime.stderr.trim().slice(-2000) || "The local runtime exited before it was ready.",
          );
        }
        try {
          const response = await fetch(healthUrl, { signal: createAbortTimeout(2_000) });
          if (response.ok) {
            runtime.ready = true;
            return { baseUrl: runtime.baseUrl, apiKey: "" };
          }
        } catch {
          // The server starts listening before the model finishes loading.
        }
        await sleep(HEALTH_POLL_MS);
      }
      runtime.error = "The local runtime did not become ready in time.";
      try {
        child.kill();
      } catch {
        // The process may already be gone.
      }
      throw new Error(runtime.error);
    });
  }

  async stopRuntime(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = undefined;
    this.runtimeStarting = undefined;
    this.runtimeError = undefined;
    if (!runtime) return;
    runtime.ready = false;
    if (runtime.child.exitCode === null) {
      runtime.child.kill();
      await Promise.race([
        new Promise<void>((resolve) => runtime.child.once("exit", () => resolve())),
        sleep(5_000),
      ]);
      if (runtime.child.exitCode === null) {
        try {
          runtime.child.kill("SIGKILL");
        } catch {
          // Best effort; the process may already be gone.
        }
      }
    }
  }
}

const managers = new Map<string, LocalModelManager>();

/** One manager per state file, shared by RPC/HTTP routes and provider turns. */
export function localModelManager(input: {
  readonly modelsDir: string;
  readonly statePath: string;
}): LocalModelManager {
  const key = NodePath.resolve(input.statePath);
  const existing = managers.get(key);
  if (existing) return existing;
  const created = new LocalModelManager(input);
  managers.set(key, created);
  return created;
}
