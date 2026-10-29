import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { LocalModelPackId } from "./localModels.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const Identifier = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
);
export const CloudJobId = Identifier;
export const CloudEnvironmentId = Identifier;
export const CloudJobCommandId = Identifier;
export const CloudSourceRevision = Schema.String.check(
  Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
);

/**
 * User-supplied branch, tag, or commit. The control plane resolves refs to a
 * pinned commit before a job is persisted, so workers only ever see
 * `CloudSourceRevision`.
 */
export const CloudSourceRef = TrimmedNonEmptyString.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
);

/** This describes whole-agent hosting, not Rust's per-tool ExecutionTarget. */
export const AgentExecutionTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local") }),
  Schema.Struct({ kind: Schema.Literal("cloud"), environmentId: CloudEnvironmentId }),
]);
export type AgentExecutionTarget = typeof AgentExecutionTarget.Type;

export const CloudJobState = Schema.Literals([
  "queued",
  "provisioning",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "finalizing",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type CloudJobState = typeof CloudJobState.Type;

/**
 * How the worker drives the CLI. Manual jobs stay approval-required; scheduled
 * jobs run full-access so they can finish while the user is offline. The mode
 * is chosen by the control plane, never by a client-supplied job input.
 */
export const CloudJobRuntimeMode = Schema.Literals(["approval-required", "full-access"]);
export type CloudJobRuntimeMode = typeof CloudJobRuntimeMode.Type;

export const CloudJobCreateInput = Schema.Struct({
  commandId: CloudJobCommandId,
  environmentId: CloudEnvironmentId,
  repositoryUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  sourceRevision: CloudSourceRef,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(32_768)),
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  // Full access is deliberately not a cloud default or a client-supplied escape hatch.
  runtimeMode: Schema.Literal("approval-required"),
  interactionMode: Schema.Literals(["default", "plan"]),
});
export type CloudJobCreateInput = typeof CloudJobCreateInput.Type;

export const CloudJobLimits = Schema.Struct({
  maxDurationSeconds: PositiveInt,
  maxEvents: PositiveInt,
  cpuMillis: PositiveInt,
  memoryMb: PositiveInt,
  diskMb: PositiveInt,
  networkPolicy: Schema.Literal("restricted"),
});
export type CloudJobLimits = typeof CloudJobLimits.Type;

export const CloudEnvironmentProviderModel = Schema.Struct({
  providerInstanceId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  model: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
});
export type CloudEnvironmentProviderModel = typeof CloudEnvironmentProviderModel.Type;

/**
 * Safe, client-visible projection of an operator-configured cloud
 * environment. Worker identities, tokens, and job limits are never included.
 */
export const CloudEnvironmentSummary = Schema.Struct({
  environmentId: CloudEnvironmentId,
  repositoryHosts: Schema.Array(Schema.String),
  providerModels: Schema.Array(CloudEnvironmentProviderModel),
});
export type CloudEnvironmentSummary = typeof CloudEnvironmentSummary.Type;

/** `GET /v1/cloud/environments` — picker data for cloud job and schedule forms. */
export const CloudEnvironmentCatalog = Schema.Struct({
  environments: Schema.Array(CloudEnvironmentSummary),
});
export type CloudEnvironmentCatalog = typeof CloudEnvironmentCatalog.Type;

export const CloudJobPendingRequest = Schema.Struct({
  requestId: Identifier,
  kind: Schema.Literals(["approval", "input"]),
  // The existing runtime owns approval/user-input payloads. This is a durable envelope.
  payload: Schema.Unknown,
});
export type CloudJobPendingRequest = typeof CloudJobPendingRequest.Type;

export const CloudJobResult = Schema.Struct({
  sourceRevision: CloudSourceRevision,
  headRevision: CloudSourceRevision,
  artifacts: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["diff", "git-bundle", "log"]),
      storageKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
      sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      sizeBytes: NonNegativeInt,
    }),
  ).check(Schema.isMaxLength(32)),
});
export type CloudJobResult = typeof CloudJobResult.Type;

export const CloudJob = Schema.Struct({
  jobId: CloudJobId,
  state: CloudJobState,
  runtimeMode: CloudJobRuntimeMode,
  /** Set when the job was dispatched by a cloud schedule. */
  scheduleId: Schema.NullOr(Identifier),
  input: CloudJobCreateInput,
  limits: CloudJobLimits,
  generation: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deadlineAt: IsoDateTime,
  cancelRequestedAt: Schema.NullOr(IsoDateTime),
  pendingRequest: Schema.NullOr(CloudJobPendingRequest),
  result: Schema.NullOr(CloudJobResult),
  failureCode: Schema.NullOr(Schema.String),
  lastSequence: NonNegativeInt,
});
export type CloudJob = typeof CloudJob.Type;

export const CloudJobEvent = Schema.Struct({
  sequence: PositiveInt,
  kind: Schema.Literals(["state", "runtime", "request", "response", "cancellation"]),
  payload: Schema.Unknown,
  createdAt: IsoDateTime,
});
export type CloudJobEvent = typeof CloudJobEvent.Type;

/** Worker capability never appears in user-facing job snapshots or events. */
export const CloudJobLease = Schema.Struct({
  job: CloudJob,
  leaseToken: TrimmedNonEmptyString,
  leaseExpiresAt: IsoDateTime,
  response: Schema.NullOr(Schema.Struct({ requestId: Identifier, payload: Schema.Unknown })),
});
export type CloudJobLease = typeof CloudJobLease.Type;

export const CloudWorkerClaimInput = Schema.Struct({
  workerId: Identifier,
  environmentId: CloudEnvironmentId,
});
export const CloudWorkerLeaseInput = Schema.Struct({
  workerId: Identifier,
  leaseToken: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  generation: PositiveInt,
});
export type CloudWorkerLeaseInput = typeof CloudWorkerLeaseInput.Type;

export const CloudWorkerUpdateInput = Schema.Struct({
  ...CloudWorkerLeaseInput.fields,
  commandId: CloudJobCommandId,
  state: Schema.optionalKey(CloudJobState),
  event: Schema.optionalKey(Schema.Unknown),
  pendingRequest: Schema.optionalKey(CloudJobPendingRequest),
  result: Schema.optionalKey(CloudJobResult),
  failureCode: Schema.optionalKey(
    Schema.Literals(["provisioning_failed", "runtime_failed", "artifact_failed"]),
  ),
});
export type CloudWorkerUpdateInput = typeof CloudWorkerUpdateInput.Type;

export const CloudJobResponseInput = Schema.Struct({
  commandId: CloudJobCommandId,
  requestId: Identifier,
  payload: Schema.Unknown,
});
export type CloudJobResponseInput = typeof CloudJobResponseInput.Type;

/**
 * Plan feature switches resolved server-side from the operator's billing
 * configuration. `cloudJobsEnabled` and the credit limits are enforced by the
 * account API; the remaining switches are advisory gates for client surfaces
 * that run on the user's own machine.
 */
export const CloudPlanFeatures = Schema.Struct({
  /** Maximum saved scheduled tasks; use a high value (1000) for effectively unlimited. */
  scheduledTasksMax: NonNegativeInt,
  pullRequestReviews: Schema.Boolean,
  teamSharing: Schema.Boolean,
  /**
   * Advisory gate for Axle Offline. The desktop still maps pack ids to plan
   * tiers locally so an older account API cannot accidentally unlock a pack.
   */
  localModelsEnabled: Schema.optionalKey(Schema.Boolean),
  localModelPacks: Schema.optionalKey(Schema.Array(LocalModelPackId)),
});
export type CloudPlanFeatures = typeof CloudPlanFeatures.Type;

export const CloudEntitlements = Schema.Struct({
  planId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  cloudJobsEnabled: Schema.Boolean,
  monthlyCredits: NonNegativeInt,
  maxConcurrentJobs: PositiveInt,
  features: CloudPlanFeatures,
});
export type CloudEntitlements = typeof CloudEntitlements.Type;

export const CloudCreditLedgerEntry = Schema.Struct({
  entryId: Schema.Number,
  kind: Schema.Literals(["monthly_grant", "reservation", "settlement", "adjustment"]),
  amount: Schema.Number,
  jobId: Schema.NullOr(Schema.String),
  note: Schema.Unknown,
  createdAt: Schema.String,
});
export type CloudCreditLedgerEntry = typeof CloudCreditLedgerEntry.Type;

/**
 * `GET /v1/cloud/billing`. `account.entitlements` is null when the deployment
 * has no billing configuration (unmetered operator mode), which clients treat
 * as every feature unlocked.
 */
export const CloudBillingView = Schema.Struct({
  account: Schema.Struct({
    planId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
    balance: NonNegativeInt,
    updatedAt: Schema.String,
    entitlements: Schema.NullOr(CloudEntitlements),
  }),
  entries: Schema.Array(CloudCreditLedgerEntry),
});
export type CloudBillingView = typeof CloudBillingView.Type;

/**
 * `POST /v1/billing/checkout` — a hosted payment session for a paid plan. The
 * caller opens `checkoutUrl` in a browser; the plan is applied server-side when
 * the provider's webhook confirms payment.
 */
export const CloudCheckoutSession = Schema.Struct({
  checkoutId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  checkoutUrl: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
});
export type CloudCheckoutSession = typeof CloudCheckoutSession.Type;
