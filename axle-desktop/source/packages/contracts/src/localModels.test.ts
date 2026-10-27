import { describe, expect, it } from "vite-plus/test";

import { LOCAL_MODEL_PACK_IDS, LOCAL_MODEL_PACK_MIN_PLAN } from "./localModels.ts";

describe("local model pack catalog metadata", () => {
  it("keeps all six packs and their minimum plans in sync", () => {
    expect(LOCAL_MODEL_PACK_IDS).toEqual([
      "compact",
      "standard",
      "advanced",
      "max",
      "coder",
      "vision",
    ]);
    expect(LOCAL_MODEL_PACK_MIN_PLAN).toEqual({
      compact: "pro",
      standard: "pro",
      advanced: "pro-plus",
      coder: "pro-plus",
      max: "ultra",
      vision: "ultra",
    });
  });
});
