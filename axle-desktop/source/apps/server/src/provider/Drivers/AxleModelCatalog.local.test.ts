// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { LOCAL_MODEL_PACKS } from "../../localModels/catalog.ts";
import { discoverAxleModels } from "./AxleModelCatalog.ts";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const emptyFetch = (async () => jsonResponse({ data: [] })) as unknown as typeof fetch;

describe("Axle Offline model discovery", () => {
  it("only exposes installed packs", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "axle-local-catalog-"));
    const statePath = NodePath.join(root, "local-models.json");
    await NodeFSP.writeFile(
      statePath,
      `${JSON.stringify({
        version: 1,
        installed: {
          compact: {
            installedAt: new Date(0).toISOString(),
            files: {
              "Qwen3-4B-Q4_K_M.gguf": {
                sizeBytes: 2_497_280_256,
                sha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
              },
            },
          },
        },
      })}\n`,
      "utf8",
    );

    try {
      const result = await discoverAxleModels(
        { AXLE_LOCAL_MODELS_STATE_PATH: statePath },
        emptyFetch,
      );
      expect(result.models.map((model) => model.slug)).toContain("axle-local/compact");
      expect(result.models.map((model) => model.slug)).not.toContain("axle-local/standard");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("hides the provider when no local state exists", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "axle-local-catalog-"));
    const statePath = NodePath.join(root, "local-models.json");
    try {
      const result = await discoverAxleModels(
        { AXLE_LOCAL_MODELS_STATE_PATH: statePath },
        emptyFetch,
      );
      expect(result.models.some((model) => model.slug.startsWith("axle-local/"))).toBe(false);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the real catalog at six packs", () => {
    expect(LOCAL_MODEL_PACKS.map((pack) => pack.id)).toEqual([
      "compact",
      "standard",
      "advanced",
      "max",
      "coder",
      "vision",
    ]);
  });
});
