import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  CloudEnvironmentId,
  CloudJob,
  CloudJobId,
  CloudSourceRef,
  CloudSourceRevision,
} from "./cloudJobs.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const Identifier = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
);

export const CloudScheduleId = Identifier;

/**
 * Branch, tag, or commit the schedule tracks. Branch names are resolved to a
 * commit through the control plane; a pinned commit is used as supplied.
 */
export const CloudScheduleSourceRef = CloudSourceRef;

export const CloudScheduleFrequency = Schema.Literals(["hourly", "daily", "weekly", "once"]);
export type CloudScheduleFrequency = typeof CloudScheduleFrequency.Type;

export const CloudScheduleWeekday = Schema.Literals([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);
export type CloudScheduleWeekday = typeof CloudScheduleWeekday.Type;

/**
 * A schedule whose runs execute on cloud workers, independently of the user's
 * machine. `repositoryUrl` and `sourceRef` fully describe the workspace each
 * run starts from; no local thread or working tree is involved.
 */
export const CloudScheduleInput = Schema.Struct({
  scheduleId: CloudScheduleId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(32_768)),
  environmentId: CloudEnvironmentId,
  repositoryUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  sourceRef: CloudScheduleSourceRef,
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  frequency: CloudScheduleFrequency,
  intervalHours: Schema.Number,
  time: Schema.String,
  dayOfWeek: CloudScheduleWeekday,
  date: Schema.String,
  timeZone: TrimmedNonEmptyString,
  active: Schema.Boolean,
});
export type CloudScheduleInput = typeof CloudScheduleInput.Type;

/**
 * `GET /v1/cloud/schedules`. `nextRunAt` is null for inactive or one-shot
 * schedules that have already fired. `lastError` is a stable control-plane
 * code, never raw provider or worker output.
 */
export const CloudSchedule = Schema.Struct({
  ...CloudScheduleInput.fields,
  sourceRevision: Schema.NullOr(CloudSourceRevision),
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastJobId: Schema.NullOr(CloudJobId),
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CloudSchedule = typeof CloudSchedule.Type;

export const CloudScheduleList = Schema.Struct({
  schedules: Schema.Array(CloudSchedule),
});
export type CloudScheduleList = typeof CloudScheduleList.Type;

/** `GET /v1/cloud/schedules/{scheduleId}/runs` — the most recent cloud jobs. */
export const CloudScheduleRuns = Schema.Struct({
  jobs: Schema.Array(CloudJob),
});
export type CloudScheduleRuns = typeof CloudScheduleRuns.Type;

export const CloudScheduleDeleteResult = Schema.Struct({
  deleted: Schema.Boolean,
});
export type CloudScheduleDeleteResult = typeof CloudScheduleDeleteResult.Type;
