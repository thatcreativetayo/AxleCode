import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";

/**
 * Axle Offline packs are managed by the desktop server. The renderer never
 * needs a model path, port, or API key: it only sees the stable pack id and
 * asks the server to install, remove, or run it.
 */
export const LocalModelPackId = Schema.Literals([
  "compact",
  "standard",
  "advanced",
  "max",
  "coder",
  "vision",
]);
export type LocalModelPackId = typeof LocalModelPackId.Type;

export const LOCAL_MODEL_PACK_IDS = [
  "compact",
  "standard",
  "advanced",
  "max",
  "coder",
  "vision",
] as const satisfies ReadonlyArray<LocalModelPackId>;

/** The lowest paid plan that may install a pack. */
export const LocalModelPlanTier = Schema.Literals(["free", "pro", "pro-plus", "ultra"]);
export type LocalModelPlanTier = typeof LocalModelPlanTier.Type;

export const LOCAL_MODEL_PACK_MIN_PLAN: Readonly<Record<LocalModelPackId, LocalModelPlanTier>> = {
  compact: "pro",
  standard: "pro",
  advanced: "pro-plus",
  coder: "pro-plus",
  max: "ultra",
  vision: "ultra",
};

export const LocalModelPackCapability = Schema.Literals(["text", "code", "vision"]);
export type LocalModelPackCapability = typeof LocalModelPackCapability.Type;

export const LocalModelPackStatus = Schema.Literals([
  "not-installed",
  "downloading",
  "installing",
  "installed",
  "error",
]);
export type LocalModelPackStatus = typeof LocalModelPackStatus.Type;

export const LocalModelPackState = Schema.Struct({
  id: LocalModelPackId,
  name: Schema.String,
  description: Schema.String,
  model: Schema.String,
  quantization: Schema.String,
  sizeBytes: NonNegativeInt,
  minRamGb: PositiveInt,
  contextWindowTokens: PositiveInt,
  minPlanTier: LocalModelPlanTier,
  capabilities: Schema.Array(LocalModelPackCapability),
  license: Schema.String,
  sourceUrl: Schema.String,
  status: LocalModelPackStatus,
  progress: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  installedBytes: NonNegativeInt,
  error: Schema.NullOr(Schema.String),
});
export type LocalModelPackState = typeof LocalModelPackState.Type;

export const LocalModelRuntimeStatus = Schema.Literals(["stopped", "starting", "ready", "error"]);
export type LocalModelRuntimeStatus = typeof LocalModelRuntimeStatus.Type;

export const LocalModelRuntimeState = Schema.Struct({
  status: LocalModelRuntimeStatus,
  packId: Schema.NullOr(LocalModelPackId),
  error: Schema.NullOr(Schema.String),
  runtimeAvailable: Schema.Boolean,
});
export type LocalModelRuntimeState = typeof LocalModelRuntimeState.Type;

export const LocalModelSnapshot = Schema.Struct({
  packs: Schema.Array(LocalModelPackState),
  runtime: LocalModelRuntimeState,
  totalInstalledBytes: NonNegativeInt,
  modelsDir: Schema.String,
});
export type LocalModelSnapshot = typeof LocalModelSnapshot.Type;

export const LocalModelActionInput = Schema.Struct({
  packId: LocalModelPackId,
});
export type LocalModelActionInput = typeof LocalModelActionInput.Type;

/**
 * A local file is accepted for development and for users who already have a
 * GGUF. Normal installs download the pack from its cataloged source and verify
 * the SHA-256 before use.
 */
export const LocalModelInstallInput = Schema.Struct({
  packId: LocalModelPackId,
  sourcePath: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
});
export type LocalModelInstallInput = typeof LocalModelInstallInput.Type;
