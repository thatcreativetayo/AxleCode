import type { ModelCatalogSectionId } from "./ModelPickerSidebar";

const SUB_PROVIDERS_BY_CATALOG: Readonly<Record<string, ReadonlyArray<string>>> = {
  "catalog:Axle": ["Axle"],
  "catalog:Claude": ["Claude"],
  "catalog:OpenAI": ["OpenAI"],
  "catalog:Google": ["Google"],
  "catalog:Fireworks": ["Fireworks"],
  "catalog:Ollama Cloud": ["Ollama Cloud"],
  "catalog:OpenRouter": ["OpenRouter"],
};

export function isModelInAxleCatalog(
  catalogId: ModelCatalogSectionId,
  subProvider: string | undefined,
): boolean {
  if (!subProvider) return false;
  return SUB_PROVIDERS_BY_CATALOG[catalogId]?.includes(subProvider) ?? false;
}

/**
 * Which rail catalog an Axle model belongs to. Slugs carry the provider the
 * model came from as a prefix, so the prefix is the routing key; anything
 * unrecognized falls back to the OpenAI catalog, which is where Axle's own
 * OpenAI-family models have always been listed.
 */
export function catalogSectionForModel(model: string): ModelCatalogSectionId {
  if (model.startsWith("axle/")) return "catalog:Axle";
  if (model.startsWith("anthropic/")) return "catalog:Claude";
  if (model.startsWith("google/")) return "catalog:Google";
  if (model.startsWith("fireworks/")) return "catalog:Fireworks";
  if (model.startsWith("ollama-cloud/")) return "catalog:Ollama Cloud";
  if (model.startsWith("openrouter/")) return "catalog:OpenRouter";
  return "catalog:OpenAI";
}
