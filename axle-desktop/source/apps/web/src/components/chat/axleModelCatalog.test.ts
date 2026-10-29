import { describe, expect, it } from "vite-plus/test";

import { catalogSectionForModel, isModelInAxleCatalog } from "./axleModelCatalog";

describe("catalogSectionForModel", () => {
  it("routes Axle's hosted models to their own catalog", () => {
    expect(catalogSectionForModel("axle/axle-20b")).toBe("catalog:Axle");
    expect(catalogSectionForModel("axle/axle-552b")).toBe("catalog:Axle");
  });

  it("routes each vendor catalog to its own section", () => {
    expect(catalogSectionForModel("anthropic/claude-opus-5")).toBe("catalog:Claude");
    expect(catalogSectionForModel("google/gemini-test")).toBe("catalog:Google");
    expect(catalogSectionForModel("fireworks/llama-v3p1")).toBe("catalog:Fireworks");
    expect(catalogSectionForModel("ollama-cloud/llama3.2")).toBe("catalog:Ollama Cloud");
    expect(catalogSectionForModel("openrouter/anthropic/claude-3.5-sonnet")).toBe(
      "catalog:OpenRouter",
    );
    expect(catalogSectionForModel("openai/gpt-test")).toBe("catalog:OpenAI");
  });
});

describe("isModelInAxleCatalog", () => {
  it("lists Axle's hosted models in the Axle catalog", () => {
    expect(isModelInAxleCatalog("catalog:Axle", "Axle")).toBe(true);
    expect(isModelInAxleCatalog("catalog:Axle", "OpenAI")).toBe(false);
    expect(isModelInAxleCatalog("catalog:OpenAI", "Axle")).toBe(false);
  });

  it("shows OpenAI API models in the OpenAI catalog", () => {
    expect(isModelInAxleCatalog("catalog:OpenAI", "OpenAI")).toBe(true);
  });

  it("keeps other providers out of the OpenAI catalog", () => {
    expect(isModelInAxleCatalog("catalog:OpenAI", "Claude")).toBe(false);
    expect(isModelInAxleCatalog("catalog:OpenAI", "Google")).toBe(false);
  });
});
