// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHTTP from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import type { LocalModelPackDefinition } from "./catalog.ts";
import { LocalModelManager } from "./manager.ts";

const sha256 = (value: Buffer): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

function fakePack(input: {
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly url: string;
}): LocalModelPackDefinition {
  return {
    id: "compact",
    name: "Compact test pack",
    description: "A tiny pack used by tests.",
    model: "Fake 1B",
    quantization: "Q4_K_M",
    minRamGb: 1,
    contextWindowTokens: 1024,
    license: "Apache-2.0",
    sourceUrl: "https://example.invalid/fake",
    primaryFileName: "fake.gguf",
    files: [
      {
        fileName: "fake.gguf",
        url: input.url,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
      },
    ],
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  return NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
}

describe("LocalModelManager", () => {
  it("imports, verifies, records, and removes a pack from a local file", async () => {
    const root = await temporaryDirectory("axle-local-import-");
    const modelsDir = NodePath.join(root, "models");
    const statePath = NodePath.join(root, "state", "local-models.json");
    const sourceDir = NodePath.join(root, "source");
    await NodeFSP.mkdir(sourceDir, { recursive: true });
    const bytes = Buffer.from("a tiny verified gguf fixture\n");
    const sourcePath = NodePath.join(sourceDir, "fake.gguf");
    await NodeFSP.writeFile(sourcePath, bytes);
    const manager = new LocalModelManager({
      modelsDir,
      statePath,
      packs: [fakePack({ sizeBytes: bytes.length, sha256: sha256(bytes), url: "http://unused" })],
    });

    const snapshot = await manager.install("compact", sourcePath);
    expect(snapshot.packs[0]?.status).toBe("installed");
    expect(snapshot.packs[0]?.progress).toBe(1);
    expect(snapshot.totalInstalledBytes).toBe(bytes.length);
    expect(await NodeFSP.readFile(NodePath.join(modelsDir, "compact", "fake.gguf"))).toEqual(bytes);

    const state = JSON.parse(await NodeFSP.readFile(statePath, "utf8")) as {
      installed: Record<string, unknown>;
    };
    expect(state.installed.compact).toBeDefined();

    const removed = await manager.remove("compact");
    expect(removed.packs[0]?.status).toBe("not-installed");
    expect(NodeFS.existsSync(NodePath.join(modelsDir, "compact"))).toBe(false);
  });

  it("rejects a local file whose checksum does not match and reports the failure", async () => {
    const root = await temporaryDirectory("axle-local-bad-hash-");
    const modelsDir = NodePath.join(root, "models");
    const statePath = NodePath.join(root, "state", "local-models.json");
    const sourcePath = NodePath.join(root, "fake.gguf");
    const bytes = Buffer.from("not the expected bytes");
    await NodeFSP.writeFile(sourcePath, bytes);
    const manager = new LocalModelManager({
      modelsDir,
      statePath,
      packs: [
        fakePack({
          sizeBytes: bytes.length,
          sha256: "0000000000000000000000000000000000000000000000000000000000000000",
          url: "http://unused",
        }),
      ],
    });

    await expect(manager.install("compact", sourcePath)).rejects.toThrow(/checksum/iu);
    const snapshot = await manager.snapshot();
    expect(snapshot.packs[0]?.status).toBe("error");
    expect(snapshot.packs[0]?.error).toMatch(/checksum/iu);
  });

  it("cancels an in-flight download when the pack is removed", async () => {
    const root = await temporaryDirectory("axle-local-cancel-");
    const modelsDir = NodePath.join(root, "models");
    const statePath = NodePath.join(root, "state", "local-models.json");
    const bytes = Buffer.from("a model download that never finishes");
    let requested = false;
    const server = NodeHTTP.createServer((_request, response) => {
      requested = true;
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bytes.length),
      });
      response.write(bytes.subarray(0, 4));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("The test server did not bind to a port.");
    }
    try {
      const manager = new LocalModelManager({
        modelsDir,
        statePath,
        packs: [
          fakePack({
            sizeBytes: bytes.length,
            sha256: sha256(bytes),
            url: `http://127.0.0.1:${address.port}/fake.gguf`,
          }),
        ],
      });
      await manager.startInstall("compact");
      for (let attempt = 0; attempt < 100 && !requested; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(requested).toBe(true);

      const removed = await manager.remove("compact");
      expect(removed.packs[0]?.status).toBe("not-installed");
      expect(NodeFS.existsSync(NodePath.join(modelsDir, "compact"))).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("resumes a partial download from the server's byte offset", async () => {
    const root = await temporaryDirectory("axle-local-download-");
    const modelsDir = NodePath.join(root, "models");
    const statePath = NodePath.join(root, "state", "local-models.json");
    const bytes = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
    const ranges: Array<string | undefined> = [];
    const server = NodeHTTP.createServer((request, response) => {
      const range = request.headers.range;
      ranges.push(range);
      const start = range ? Number(range.replace(/^bytes=/u, "").replace(/-$/u, "")) : 0;
      const body = start > 0 ? bytes.subarray(start) : bytes;
      response.writeHead(start > 0 ? 206 : 200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.length),
        ...(start > 0
          ? { "Content-Range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` }
          : {}),
      });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("The test server did not bind to a port.");
    }
    try {
      const partDir = NodePath.join(modelsDir, "compact");
      await NodeFSP.mkdir(partDir, { recursive: true });
      const split = 12;
      await NodeFSP.writeFile(NodePath.join(partDir, "fake.gguf.part"), bytes.subarray(0, split));
      const manager = new LocalModelManager({
        modelsDir,
        statePath,
        packs: [
          fakePack({
            sizeBytes: bytes.length,
            sha256: sha256(bytes),
            url: `http://127.0.0.1:${address.port}/fake.gguf`,
          }),
        ],
      });

      const installing = await manager.startInstall("compact");
      expect(["downloading", "installing"]).toContain(installing.packs[0]?.status);
      await new Promise((resolve) => setTimeout(resolve, 100));
      let snapshot = await manager.snapshot();
      for (
        let attempt = 0;
        attempt < 50 && snapshot.packs[0]?.status !== "installed";
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        snapshot = await manager.snapshot();
      }
      expect(snapshot.packs[0]?.status).toBe("installed");
      expect(await NodeFSP.readFile(NodePath.join(partDir, "fake.gguf"))).toEqual(bytes);
      expect(ranges).toContain(`bytes=${split}-`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
