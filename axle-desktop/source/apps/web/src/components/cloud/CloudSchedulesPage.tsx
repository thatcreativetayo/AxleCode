import { CloudJobsApiError, CloudJobsClient } from "@axle/client-runtime/cloud/jobs";
import { CloudSchedulesClient } from "@axle/client-runtime/cloud/schedules";
import { CloudScheduleInput as CloudScheduleInputSchema } from "@axle/contracts";
import type { CloudEnvironmentSummary } from "@axle/contracts";
import type {
  CloudJob,
  CloudSchedule,
  CloudScheduleFrequency,
  CloudScheduleWeekday,
} from "@axle/contracts";
import { validateScheduleTiming } from "@axle/shared/scheduleTiming";
import * as Schema from "effect/Schema";
import {
  CalendarClockIcon,
  CloudIcon,
  CloudOffIcon,
  GitBranchIcon,
  HistoryIcon,
  LoaderCircleIcon,
  LogInIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { readClerkAccountToken } from "../../account/clerkRuntime";
import { useAccountActions } from "../../account/AccountAuthProvider";
import { resolveCloudPublicConfig } from "../../cloud/publicConfig";
import { cloudJobsLocked, scheduledTasksLimit } from "../../entitlements/gates";
import { resolvedEntitlements, useEntitlements } from "../../entitlements/useEntitlements";
import { cn, randomUUID } from "../../lib/utils";
import { formatRelativeTimeLabel, formatRelativeTimeUntilLabel } from "../../timestampFormat";
import { openUpgradeDialog } from "../billing/UpgradeDialog";
import { formatScheduleSummary } from "../../scheduledTasks";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  CloudRepositoryField,
  CloudSourceRefField,
  CloudTargetFields,
  useCloudEnvironmentCatalog,
  useGitHubBranches,
  useGitHubRepositories,
  type CloudEnvironmentCatalogState,
} from "./cloudTargets";
import {
  defaultProviderModel,
  hostsAllowBranchTracking,
  isPinnedSourceRef,
  isValidSourceRef,
  modelsForProvider,
  providersForEnvironment,
} from "./cloudTargets.logic";

const FREQUENCY_OPTIONS: ReadonlyArray<{
  readonly value: CloudScheduleFrequency;
  readonly label: string;
  readonly description: string;
}> = [
  { value: "hourly", label: "Loop", description: "Repeat on an interval" },
  { value: "daily", label: "Every day", description: "Run once a day" },
  { value: "weekly", label: "Specific day", description: "Run on a weekday" },
  { value: "once", label: "Once", description: "Run one time" },
];

const WEEKDAY_OPTIONS: ReadonlyArray<{
  readonly value: CloudScheduleWeekday;
  readonly label: string;
}> = [
  { value: "monday", label: "Monday" },
  { value: "tuesday", label: "Tuesday" },
  { value: "wednesday", label: "Wednesday" },
  { value: "thursday", label: "Thursday" },
  { value: "friday", label: "Friday" },
  { value: "saturday", label: "Saturday" },
  { value: "sunday", label: "Sunday" },
];

const decodeScheduleInput = Schema.decodeUnknownSync(CloudScheduleInputSchema);

const JOB_STATE_PRESENTATION: Record<
  CloudJob["state"],
  {
    readonly label: string;
    readonly variant: "outline" | "info" | "warning" | "success" | "error" | "secondary";
  }
> = {
  queued: { label: "Queued", variant: "outline" },
  provisioning: { label: "Provisioning", variant: "info" },
  running: { label: "Running", variant: "info" },
  waiting_for_approval: { label: "Needs approval", variant: "warning" },
  waiting_for_input: { label: "Needs input", variant: "warning" },
  finalizing: { label: "Finalizing", variant: "info" },
  completed: { label: "Completed", variant: "success" },
  failed: { label: "Failed", variant: "error" },
  cancelled: { label: "Cancelled", variant: "secondary" },
  interrupted: { label: "Interrupted", variant: "warning" },
};

function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function tomorrowDateInputValue(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof CloudJobsApiError && error.status === 401;
}

function describeError(error: unknown): string {
  if (error instanceof CloudJobsApiError) {
    switch (error.code) {
      case "unauthorized":
        return "Your account session expired. Sign in again to continue.";
      case "network_error":
        return "Could not reach the account service. Check your connection and retry.";
      case "cloud_not_configured":
        return "Cloud schedules are not configured for this deployment.";
      case "cloud_not_entitled":
        return "Cloud schedules are included with Axle Pro. Upgrade to create schedules.";
      case "cloud_access_denied":
      case "forbidden":
        return "Your account does not have access to cloud schedules.";
      case "schedule_limit_reached":
        return "You have reached your plan's scheduled-task limit. Upgrade or remove a schedule.";
      case "source_revision_unavailable":
        return "The branch could not be resolved to a commit. Check the branch name and try again.";
      case "invalid_source_ref":
        return "Branch tracking requires a GitHub repository. Other hosts must pin a full commit id.";
      case "invalid_repository":
        return "That repository is not allowed in the selected environment.";
      case "invalid_schedule":
        return "The schedule timing is invalid. Check the date, time, and time zone.";
      case "not_found":
        return "That schedule no longer exists.";
      case "unexpected_response":
        return "The account service returned an unexpected response.";
      default:
        return error.code.startsWith("invalid_")
          ? "The request was rejected. Check the entered values and try again."
          : error.status === 0
            ? "Could not reach the account service. Check your connection and retry."
            : `Cloud schedules request failed (${error.status} ${error.code}).`;
    }
  }
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "Something went wrong.";
}

function shortRevision(revision: string): string {
  return revision.length > 12 ? revision.slice(0, 12) : revision;
}

interface ScheduleDraft {
  readonly title: string;
  readonly prompt: string;
  readonly environmentId: string;
  readonly repositoryUrl: string;
  readonly sourceRef: string;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly frequency: CloudScheduleFrequency;
  readonly intervalHours: number;
  readonly time: string;
  readonly dayOfWeek: CloudScheduleWeekday;
  readonly date: string;
  readonly timeZone: string;
  readonly active: boolean;
}

function emptyDraft(): ScheduleDraft {
  return {
    title: "",
    prompt: "",
    environmentId: "linux-standard",
    repositoryUrl: "",
    sourceRef: "",
    providerInstanceId: "",
    model: "",
    frequency: "daily",
    intervalHours: 1,
    time: "09:00",
    dayOfWeek: "monday",
    date: tomorrowDateInputValue(),
    timeZone: systemTimeZone(),
    active: true,
  };
}

function draftFromSchedule(schedule: CloudSchedule): ScheduleDraft {
  return {
    title: schedule.title,
    prompt: schedule.prompt,
    environmentId: schedule.environmentId,
    repositoryUrl: schedule.repositoryUrl,
    sourceRef: schedule.sourceRef,
    providerInstanceId: schedule.providerInstanceId,
    model: schedule.model,
    frequency: schedule.frequency,
    intervalHours: schedule.intervalHours,
    time: schedule.time,
    dayOfWeek: schedule.dayOfWeek,
    date: schedule.date || tomorrowDateInputValue(),
    timeZone: schedule.timeZone,
    active: schedule.active,
  };
}

function draftValidationError(
  draft: ScheduleDraft,
  environment: CloudEnvironmentSummary | null,
): string | null {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(draft.environmentId.trim())) {
    return "Environment id must start with a letter or digit and use only letters, digits, dashes, or underscores.";
  }
  const repositoryUrl = draft.repositoryUrl.trim();
  if (repositoryUrl.length === 0 || repositoryUrl.length > 2048) {
    return "Repository URL is required.";
  }
  const sourceRef = draft.sourceRef.trim();
  if (!isValidSourceRef(sourceRef)) {
    return "Choose a branch or enter a branch, tag, or full commit id without spaces.";
  }
  if (
    environment !== null &&
    !hostsAllowBranchTracking(environment.repositoryHosts) &&
    !isPinnedSourceRef(sourceRef)
  ) {
    return "This environment only supports GitHub branch tracking. Paste a full commit SHA.";
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(draft.providerInstanceId.trim())) {
    return "Provider instance id must start with a letter or digit and use only letters, digits, dashes, or underscores.";
  }
  const model = draft.model.trim();
  if (model.length === 0 || model.length > 200) return "Model is required.";
  if (draft.title.trim().length === 0) return "Give the schedule a name.";
  const prompt = draft.prompt.trim();
  if (prompt.length === 0) return "Describe what the cloud agent should do.";
  if (prompt.length > 32768) return "The task description is too long.";
  try {
    validateScheduleTiming({
      frequency: draft.frequency,
      intervalHours: draft.intervalHours,
      time: draft.time,
      dayOfWeek: draft.dayOfWeek,
      date: draft.date,
      timeZone: draft.timeZone.trim(),
    });
  } catch (error) {
    return error instanceof Error ? error.message : "Check the schedule timing.";
  }
  return null;
}

function PageShell({
  children,
  embedded = false,
}: {
  readonly children: ReactNode;
  readonly embedded?: boolean;
}) {
  return (
    <main
      className={cn(
        "@container/cloud flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground",
        !embedded && "pt-[var(--workspace-topbar-height)]",
      )}
    >
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden @3xl/cloud:flex-row",
          !embedded && "border-t border-border",
        )}
      >
        {children}
      </div>
    </main>
  );
}

function SchedulesAsideShell({ children }: { readonly children: ReactNode }) {
  return (
    <aside
      aria-label="Cloud schedules"
      className="flex max-h-[45%] min-h-48 w-full shrink-0 flex-col border-b border-border bg-muted/15 @3xl/cloud:max-h-none @3xl/cloud:w-80 @3xl/cloud:border-b-0 @3xl/cloud:border-r"
    >
      {children}
    </aside>
  );
}

function ScheduleListItem({
  schedule,
  selected,
  onSelect,
}: {
  readonly schedule: CloudSchedule;
  readonly selected: boolean;
  readonly onSelect: (scheduleId: string) => void;
}) {
  const summary = formatScheduleSummary(schedule);
  return (
    <button
      type="button"
      aria-pressed={selected}
      data-testid={`cloud-schedule-item-${schedule.scheduleId}`}
      className={cn(
        "w-full border-b border-border/60 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected ? "bg-muted/60" : "hover:bg-muted/30",
      )}
      onClick={() => onSelect(schedule.scheduleId)}
    >
      <div className="flex items-center gap-2">
        <CalendarClockIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {schedule.title}
        </span>
        {schedule.lastError !== null ? (
          <Badge variant="error" size="sm">
            Error
          </Badge>
        ) : (
          <Badge variant={schedule.active ? "success" : "secondary"} size="sm">
            {schedule.active ? "Active" : "Paused"}
          </Badge>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-2 pl-5.5 text-[11px] text-muted-foreground">
        <span className="truncate">{summary}</span>
        {schedule.active && schedule.nextRunAt !== null ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{formatRelativeTimeUntilLabel(schedule.nextRunAt)}</span>
          </>
        ) : null}
      </div>
    </button>
  );
}

function SourceSection({ schedule }: { readonly schedule: CloudSchedule }) {
  return (
    <section aria-label="Source" className="rounded-lg border border-border bg-muted/15 px-4 py-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <GitBranchIcon className="size-4 text-muted-foreground" />
        Source
      </h2>
      <dl className="mt-2 space-y-1 text-xs">
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-muted-foreground">Repository</dt>
          <dd className="min-w-0 flex-1 break-all font-mono text-foreground/80">
            {schedule.repositoryUrl}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-muted-foreground">Branch or commit</dt>
          <dd className="min-w-0 flex-1 break-all font-mono text-foreground/80">
            {schedule.sourceRef}
          </dd>
        </div>
        {schedule.sourceRevision !== null ? (
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-muted-foreground">Last resolved</dt>
            <dd className="min-w-0 flex-1 font-mono text-foreground/80">
              {shortRevision(schedule.sourceRevision)}
            </dd>
          </div>
        ) : null}
      </dl>
      <p className="mt-2 rounded-md border border-border/60 bg-background/60 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
        Runs clone only code pushed to this ref on the remote. Local uncommitted changes are never
        included, so push before the next run.
      </p>
    </section>
  );
}

function RunHistory({ runs }: { readonly runs: ReadonlyArray<CloudJob> }) {
  if (runs.length === 0) {
    return (
      <section
        aria-label="Run history"
        className="rounded-lg border border-border bg-muted/15 px-4 py-3"
      >
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <HistoryIcon className="size-4 text-muted-foreground" />
          Run history
        </h2>
        <p className="mt-2 text-xs text-muted-foreground">
          No runs yet. Use Run now to dispatch this schedule immediately.
        </p>
      </section>
    );
  }
  return (
    <section
      aria-label="Run history"
      className="rounded-lg border border-border bg-muted/15 px-4 py-3"
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <HistoryIcon className="size-4 text-muted-foreground" />
        Run history
      </h2>
      <ol className="mt-2 divide-y divide-border/60 rounded-md border border-border/60 bg-background/60">
        {runs.map((job) => {
          const presentation = JOB_STATE_PRESENTATION[job.state];
          return (
            <li key={job.jobId} className="flex items-center gap-2 px-3 py-2 text-xs">
              <Badge variant={presentation.variant} size="sm">
                {presentation.label}
              </Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-foreground/70">
                {job.jobId}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {formatRelativeTimeLabel(job.createdAt)}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ScheduleDetail({
  schedule,
  runs,
  busy,
  deleteArmed,
  onEdit,
  onRunNow,
  onDelete,
}: {
  readonly schedule: CloudSchedule;
  readonly runs: ReadonlyArray<CloudJob>;
  readonly busy: boolean;
  readonly deleteArmed: boolean;
  readonly onEdit: () => void;
  readonly onRunNow: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold tracking-tight">{schedule.title}</h2>
          <Badge variant={schedule.active ? "success" : "secondary"} size="sm">
            {schedule.active ? "Active" : "Paused"}
          </Badge>
          <Badge variant="outline" size="sm">
            {formatScheduleSummary(schedule)}
          </Badge>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              data-testid="cloud-schedule-run-now"
              disabled={busy}
              onClick={onRunNow}
            >
              {busy ? (
                <LoaderCircleIcon className="size-3.5 animate-spin" />
              ) : (
                <PlayIcon className="size-3.5" />
              )}
              Run now
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              data-testid="cloud-schedule-edit"
              disabled={busy}
              onClick={onEdit}
            >
              <PencilIcon className="size-3.5" />
              Edit
            </Button>
            <Button
              variant={deleteArmed ? "destructive" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              data-testid="cloud-schedule-delete"
              disabled={busy}
              onClick={onDelete}
            >
              <Trash2Icon className="size-3.5" />
              {deleteArmed ? "Confirm delete" : "Delete"}
            </Button>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            Next run:{" "}
            <span className="text-foreground">
              {schedule.active && schedule.nextRunAt !== null
                ? formatRelativeTimeUntilLabel(schedule.nextRunAt)
                : "paused"}
            </span>
          </span>
          <span>
            Time zone: <span className="text-foreground">{schedule.timeZone}</span>
          </span>
          <span>
            Model:{" "}
            <span className="font-mono text-foreground">
              {schedule.providerInstanceId}/{schedule.model}
            </span>
          </span>
        </div>
      </div>
      <div className="space-y-3 px-5 py-4">
        {schedule.lastError !== null ? (
          <p
            role="alert"
            className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-xs text-warning-foreground"
          >
            <TriangleAlertIcon className="size-4 shrink-0" />
            Last run failed: {schedule.lastError}
          </p>
        ) : null}
        <section
          aria-label="Task"
          className="rounded-lg border border-border bg-muted/15 px-4 py-3"
        >
          <h2 className="text-sm font-semibold text-foreground">Task</h2>
          <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-5 text-foreground/80">
            {schedule.prompt}
          </p>
        </section>
        <SourceSection schedule={schedule} />
        <RunHistory runs={runs} />
        <p className="text-[11px] text-muted-foreground">
          Scheduled runs execute with full access on an Axle cloud worker and keep running while
          this computer is offline. Creating the schedule is treated as consent for those runs.
        </p>
      </div>
    </div>
  );
}

function ScheduleDialog({
  open,
  schedule,
  catalog,
  submitting,
  error,
  onOpenChange,
  onSubmit,
}: {
  readonly open: boolean;
  readonly schedule: CloudSchedule | null;
  readonly catalog: CloudEnvironmentCatalogState;
  readonly submitting: boolean;
  readonly error: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (draft: ScheduleDraft) => void;
}) {
  const [draft, setDraft] = useState<ScheduleDraft>(emptyDraft);
  const [formError, setFormError] = useState<string | null>(null);
  const repositoryState = useGitHubRepositories(open);
  const branchState = useGitHubBranches(draft.repositoryUrl, open);
  const selectedEnvironment =
    catalog.environments.find((item) => item.environmentId === draft.environmentId) ?? null;

  useEffect(() => {
    if (!open) return;
    setDraft(schedule === null ? emptyDraft() : draftFromSchedule(schedule));
    setFormError(null);
  }, [open, schedule]);

  useEffect(() => {
    if (!open || catalog.environments.length === 0) return;
    setDraft((current) => {
      if (catalog.environments.some((item) => item.environmentId === current.environmentId)) {
        return current;
      }
      const environment = catalog.environments[0];
      if (environment === undefined) return current;
      return {
        ...current,
        environmentId: environment.environmentId,
        ...defaultProviderModel(environment),
      };
    });
  }, [catalog.environments, open]);

  useEffect(() => {
    if (!open || selectedEnvironment === null) return;
    setDraft((current) => {
      const fallback = defaultProviderModel(selectedEnvironment);
      const providerInstanceId = providersForEnvironment(selectedEnvironment).includes(
        current.providerInstanceId,
      )
        ? current.providerInstanceId
        : fallback.providerInstanceId;
      const allowedModels = modelsForProvider(selectedEnvironment, providerInstanceId);
      const model = allowedModels.includes(current.model)
        ? current.model
        : (allowedModels[0] ?? fallback.model);
      if (providerInstanceId === current.providerInstanceId && model === current.model) {
        return current;
      }
      return { ...current, providerInstanceId, model };
    });
  }, [open, selectedEnvironment]);

  const validationError = useMemo(
    () => draftValidationError(draft, selectedEnvironment),
    [draft, selectedEnvironment],
  );

  const update = useCallback(
    <Key extends keyof ScheduleDraft>(key: Key, value: ScheduleDraft[Key]) => {
      setDraft((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const handleSubmit = useCallback(() => {
    if (submitting || validationError !== null) return;
    setFormError(null);
    onSubmit(draft);
  }, [draft, onSubmit, submitting, validationError]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-lg" showCloseButton={!submitting}>
        <DialogHeader>
          <DialogTitle>
            {schedule === null ? "New cloud schedule" : "Edit cloud schedule"}
          </DialogTitle>
          <DialogDescription>
            Runs on an independent Axle cloud runner and keeps executing while this computer is
            offline. Each run starts from code pushed to the selected branch.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3" scrollFade={false}>
          <div className="space-y-1.5">
            <Label htmlFor="cloud-schedule-title">Name</Label>
            <Input
              id="cloud-schedule-title"
              value={draft.title}
              disabled={submitting}
              placeholder="Weekly dependency hygiene"
              onChange={(event) => update("title", event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cloud-schedule-prompt">Task</Label>
            <Textarea
              id="cloud-schedule-prompt"
              value={draft.prompt}
              disabled={submitting}
              placeholder="Describe the outcome you want in the repository…"
              className="min-h-24"
              onChange={(event) => update("prompt", event.target.value)}
            />
          </div>
          <CloudRepositoryField
            repositoryUrl={draft.repositoryUrl}
            hosts={selectedEnvironment?.repositoryHosts ?? []}
            repositories={repositoryState.repositories}
            bridgeAvailable={repositoryState.bridgeAvailable}
            busy={repositoryState.busy}
            error={repositoryState.error}
            disabled={submitting}
            onRefresh={repositoryState.refresh}
            onChange={(value) => {
              setDraft((current) => ({ ...current, repositoryUrl: value, sourceRef: "" }));
            }}
          />
          <CloudSourceRefField
            value={draft.sourceRef}
            supported={branchState.supported}
            branches={branchState.branches}
            defaultBranch={branchState.defaultBranch}
            busy={branchState.busy}
            error={branchState.error}
            disabled={submitting}
            label="Branch or commit"
            helper="Each run uses the latest commit on this branch, so push changes before the next run. The exact commit is captured when the run starts."
            onChange={(value) => update("sourceRef", value)}
          />
          <CloudTargetFields
            environments={catalog.environments}
            environmentsBusy={catalog.busy}
            environmentsError={catalog.error}
            environmentId={draft.environmentId}
            providerInstanceId={draft.providerInstanceId}
            model={draft.model}
            disabled={submitting}
            idPrefix="cloud-schedule"
            onChange={(patch) => {
              setDraft((current) => ({ ...current, ...patch }));
            }}
          />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cloud-schedule-frequency">Repeat</Label>
              <Select
                value={draft.frequency}
                onValueChange={(value) => update("frequency", value as CloudScheduleFrequency)}
              >
                <SelectTrigger id="cloud-schedule-frequency" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FREQUENCY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {draft.frequency === "hourly" ? (
              <div className="space-y-1.5">
                <Label htmlFor="cloud-schedule-interval">Every (hours)</Label>
                <Input
                  id="cloud-schedule-interval"
                  type="number"
                  min={1}
                  max={8760}
                  value={draft.intervalHours}
                  disabled={submitting}
                  onChange={(event) =>
                    update("intervalHours", Math.max(1, Number(event.target.value) || 1))
                  }
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="cloud-schedule-time">Time</Label>
                <Input
                  id="cloud-schedule-time"
                  type="time"
                  value={draft.time}
                  disabled={submitting}
                  onChange={(event) => update("time", event.target.value)}
                />
              </div>
            )}
          </div>
          {draft.frequency === "weekly" || draft.frequency === "once" ? (
            <div className="grid grid-cols-2 gap-3">
              {draft.frequency === "weekly" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="cloud-schedule-weekday">Day</Label>
                  <Select
                    value={draft.dayOfWeek}
                    onValueChange={(value) => update("dayOfWeek", value as CloudScheduleWeekday)}
                  >
                    <SelectTrigger id="cloud-schedule-weekday" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEEKDAY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="cloud-schedule-date">Date</Label>
                  <Input
                    id="cloud-schedule-date"
                    type="date"
                    value={draft.date}
                    disabled={submitting}
                    onChange={(event) => update("date", event.target.value)}
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="cloud-schedule-once-time">Time</Label>
                <Input
                  id="cloud-schedule-once-time"
                  type="time"
                  value={draft.time}
                  disabled={submitting}
                  onChange={(event) => update("time", event.target.value)}
                />
              </div>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cloud-schedule-time-zone">Time zone</Label>
              <Input
                id="cloud-schedule-time-zone"
                value={draft.timeZone}
                disabled={submitting}
                placeholder="Africa/Lagos"
                onChange={(event) => update("timeZone", event.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                IANA time zone. Daylight saving changes are applied automatically.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cloud-schedule-active">Status</Label>
              <Select
                value={draft.active ? "active" : "paused"}
                onValueChange={(value) => update("active", value === "active")}
              >
                <SelectTrigger id="cloud-schedule-active" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Paused schedules keep their settings but do not run.
              </p>
            </div>
          </div>
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-muted-foreground">
            <span className="block text-[10px] font-medium uppercase tracking-[0.12em]">
              Schedule preview
            </span>
            <span className="mt-1 block text-sm text-foreground">
              {formatScheduleSummary(draft)}
            </span>
            <span className="mt-0.5 block text-[11px]">
              {draft.timeZone.trim() || "UTC"} ·{" "}
              {draft.active ? "Runs automatically" : "Paused until enabled"}
            </span>
          </div>
          {validationError !== null && draft.title.trim().length > 0 ? (
            <p role="alert" className="text-xs leading-5 text-muted-foreground">
              {validationError}
            </p>
          ) : null}
          {formError !== null ? (
            <p role="alert" className="text-xs leading-5 text-destructive-foreground">
              {formError}
            </p>
          ) : null}
          {error !== null ? (
            <p role="alert" className="text-xs leading-5 text-destructive-foreground">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant="default"
            data-testid="cloud-schedule-create-submit"
            disabled={submitting || validationError !== null}
            onClick={handleSubmit}
          >
            {submitting ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <PlusIcon className="size-3.5" />
            )}
            {schedule === null ? "Create schedule" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function CloudSchedulesPage({ embedded = false }: { readonly embedded?: boolean } = {}) {
  const { signIn } = useAccountActions();
  const entitlements = resolvedEntitlements(useEntitlements());
  const scheduleLimit = scheduledTasksLimit(entitlements);
  const cloudLocked = cloudJobsLocked(entitlements);
  const client = useMemo(() => {
    const { accountApiUrl } = resolveCloudPublicConfig();
    if (accountApiUrl === null) return null;
    return new CloudSchedulesClient({ baseUrl: accountApiUrl, getToken: readClerkAccountToken });
  }, []);
  const catalogClient = useMemo(() => {
    const { accountApiUrl } = resolveCloudPublicConfig();
    if (accountApiUrl === null) return null;
    return new CloudJobsClient({ baseUrl: accountApiUrl, getToken: readClerkAccountToken });
  }, []);
  const catalog = useCloudEnvironmentCatalog(catalogClient);

  const [phase, setPhase] = useState<"loading" | "ready" | "signed_out" | "unconfigured" | "error">(
    client === null ? "unconfigured" : "loading",
  );
  const [schedules, setSchedules] = useState<ReadonlyArray<CloudSchedule>>([]);
  const [listBusy, setListBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<ReadonlyArray<CloudJob>>([]);
  const [runsBusy, setRunsBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CloudSchedule | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const listRequestRef = useRef(0);
  const runsRequestRef = useRef(0);

  const selected = useMemo(
    () => schedules.find((schedule) => schedule.scheduleId === selectedId) ?? null,
    [schedules, selectedId],
  );

  const refreshSchedules = useCallback(async () => {
    if (client === null) return;
    const requestId = ++listRequestRef.current;
    setListBusy(true);
    try {
      const next = await client.listSchedules();
      if (listRequestRef.current !== requestId) return;
      setSchedules(next);
      setLoadError(null);
      setPhase("ready");
      setSelectedId((previous) =>
        previous !== null && next.some((schedule) => schedule.scheduleId === previous)
          ? previous
          : (next[0]?.scheduleId ?? null),
      );
    } catch (error) {
      if (listRequestRef.current !== requestId) return;
      if (isUnauthorized(error)) {
        setPhase("signed_out");
        return;
      }
      setLoadError(describeError(error));
      setPhase((previous) => (previous === "ready" ? "ready" : "error"));
    } finally {
      if (listRequestRef.current === requestId) setListBusy(false);
    }
  }, [client]);

  useEffect(() => {
    if (client === null) return;
    void refreshSchedules();
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      void refreshSchedules();
    }, 10_000);
    const handleVisibility = () => {
      if (!document.hidden) void refreshSchedules();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [client, refreshSchedules]);

  useEffect(() => {
    setDeleteArmed(false);
    setActionError(null);
  }, [selectedId]);

  useEffect(() => {
    if (client === null || selectedId === null) {
      setRuns([]);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    const requestId = ++runsRequestRef.current;
    setRunsBusy(true);
    setRuns([]);

    const load = async () => {
      try {
        const next = await client.listRuns(selectedId);
        if (cancelled || runsRequestRef.current !== requestId) return;
        setRuns(next);
        setDetailError(null);
      } catch (error) {
        if (cancelled || runsRequestRef.current !== requestId) return;
        if (isUnauthorized(error)) {
          setPhase("signed_out");
          return;
        }
        setDetailError(describeError(error));
      } finally {
        if (!cancelled && runsRequestRef.current === requestId) setRunsBusy(false);
      }
    };

    void load();
    const interval = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [client, selectedId]);

  const openCreateFlow = useCallback(() => {
    if (cloudLocked) {
      openUpgradeDialog("cloud-jobs");
      return;
    }
    if (scheduleLimit !== null && schedules.length >= scheduleLimit) {
      openUpgradeDialog("schedules");
      return;
    }
    setEditing(null);
    setSubmitError(null);
    setDialogOpen(true);
  }, [cloudLocked, scheduleLimit, schedules.length]);

  const openEditFlow = useCallback(() => {
    if (selected === null) return;
    setEditing(selected);
    setSubmitError(null);
    setDialogOpen(true);
  }, [selected]);

  const handleSubmit = useCallback(
    async (draft: ScheduleDraft) => {
      if (client === null || submitting) return;
      setSubmitting(true);
      setSubmitError(null);
      try {
        const input = decodeScheduleInput({
          scheduleId: editing?.scheduleId ?? `schedule-${randomUUID()}`,
          title: draft.title.trim(),
          prompt: draft.prompt.trim(),
          environmentId: draft.environmentId.trim(),
          repositoryUrl: draft.repositoryUrl.trim(),
          sourceRef: draft.sourceRef.trim(),
          providerInstanceId: draft.providerInstanceId.trim(),
          model: draft.model.trim(),
          frequency: draft.frequency,
          intervalHours: Math.max(1, Math.round(draft.intervalHours)),
          time: draft.time,
          dayOfWeek: draft.dayOfWeek,
          date: draft.date,
          timeZone: draft.timeZone.trim(),
          active: draft.active,
        });
        const saved = await client.saveSchedule(input);
        setSchedules((previous) => {
          const rest = previous.filter((schedule) => schedule.scheduleId !== saved.scheduleId);
          return [saved, ...rest];
        });
        setSelectedId(saved.scheduleId);
        setDialogOpen(false);
        setEditing(null);
        setPhase("ready");
      } catch (error) {
        setSubmitError(
          error instanceof Error && !(error instanceof CloudJobsApiError)
            ? "Some values are invalid. Check the branch, timing, and provider values."
            : describeError(error),
        );
      } finally {
        setSubmitting(false);
      }
    },
    [client, editing, submitting],
  );

  const handleRunNow = useCallback(async () => {
    if (client === null || selected === null || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const job = await client.runNow(selected.scheduleId);
      setRuns((previous) => [
        job,
        ...previous.filter((candidate) => candidate.jobId !== job.jobId),
      ]);
      void refreshSchedules();
    } catch (error) {
      setActionError(describeError(error));
    } finally {
      setActionBusy(false);
    }
  }, [actionBusy, client, refreshSchedules, selected]);

  const handleDelete = useCallback(async () => {
    if (client === null || selected === null || actionBusy) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setActionBusy(true);
    setActionError(null);
    try {
      await client.removeSchedule(selected.scheduleId);
      const next = schedules.filter((schedule) => schedule.scheduleId !== selected.scheduleId);
      setSchedules(next);
      setSelectedId(next[0]?.scheduleId ?? null);
    } catch (error) {
      setActionError(describeError(error));
    } finally {
      setActionBusy(false);
      setDeleteArmed(false);
    }
  }, [actionBusy, client, deleteArmed, schedules, selected]);

  if (client === null || phase === "unconfigured") {
    return (
      <PageShell embedded={embedded}>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CloudOffIcon />
            </EmptyMedia>
            <EmptyTitle>Cloud schedules are not configured</EmptyTitle>
            <EmptyDescription>
              This build has no account service URL. Set <code>VITE_ACCOUNT_API_URL</code> to the
              Axle account API to create schedules that run while this computer is offline.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageShell>
    );
  }

  if (phase === "signed_out") {
    return (
      <PageShell embedded={embedded}>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarClockIcon />
            </EmptyMedia>
            <EmptyTitle>Sign in to use cloud schedules</EmptyTitle>
            <EmptyDescription>
              Cloud schedules belong to your account. Sign in, then return here to create runs that
              finish even when this computer is off.
            </EmptyDescription>
          </EmptyHeader>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => signIn()}>
              <LogInIcon className="size-3.5" />
              Sign in to Axle
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={listBusy}
              onClick={() => void refreshSchedules()}
            >
              <RefreshCwIcon className={cn("size-3.5", listBusy && "animate-spin")} />
              Check again
            </Button>
          </div>
        </Empty>
      </PageShell>
    );
  }

  return (
    <PageShell embedded={embedded}>
      <SchedulesAsideShell>
        <div className="shrink-0 border-b border-border px-4 pb-3 pt-3">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold tracking-tight">Cloud schedules</h1>
            <Badge variant="outline" size="sm" className="gap-1">
              <CloudIcon className="size-3" />
              Cloud
            </Badge>
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh cloud schedules"
                disabled={listBusy}
                onClick={() => void refreshSchedules()}
              >
                <RefreshCwIcon className={cn("size-4", listBusy && "animate-spin")} />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                data-testid="cloud-schedule-create-open"
                onClick={openCreateFlow}
              >
                <PlusIcon className="size-3.5" />
                New
              </Button>
            </div>
          </div>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            Runs on Axle cloud workers, independent of this computer.
          </p>
          {cloudLocked ? (
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              Cloud schedules are included with Axle Pro.{" "}
              <button
                type="button"
                className="underline underline-offset-2 transition-colors hover:text-foreground"
                onClick={() => openUpgradeDialog("cloud-jobs")}
              >
                Upgrade
              </button>
            </p>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loadError !== null ? (
            <p role="alert" className="px-4 py-3 text-xs leading-5 text-destructive-foreground">
              {loadError}
            </p>
          ) : null}
          {phase === "loading" ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">Loading schedules…</p>
          ) : schedules.length === 0 ? (
            <div className="px-4 py-6 text-center">
              <p className="text-xs text-muted-foreground">
                No cloud schedules yet. Create one to run on the pushed code while this computer is
                offline.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3 h-7 px-2 text-xs"
                onClick={openCreateFlow}
              >
                <PlusIcon className="size-3.5" />
                New schedule
              </Button>
            </div>
          ) : (
            schedules.map((schedule) => (
              <ScheduleListItem
                key={schedule.scheduleId}
                schedule={schedule}
                selected={schedule.scheduleId === selectedId}
                onSelect={setSelectedId}
              />
            ))
          )}
        </div>
      </SchedulesAsideShell>
      {selected === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
          <p className="max-w-sm text-xs leading-5 text-muted-foreground">
            {schedules.length === 0
              ? "Cloud schedules run on the pushed repository state, so the agent can finish while your computer is off."
              : "Select a schedule to see its source, task, and recent runs."}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {actionError !== null || detailError !== null ? (
            <p
              role="alert"
              className="border-b border-border px-5 py-2 text-xs text-destructive-foreground"
            >
              {actionError ?? detailError}
            </p>
          ) : null}
          <ScheduleDetail
            schedule={selected}
            runs={runsBusy && runs.length === 0 ? [] : runs}
            busy={actionBusy}
            deleteArmed={deleteArmed}
            onEdit={openEditFlow}
            onRunNow={() => void handleRunNow()}
            onDelete={() => void handleDelete()}
          />
        </div>
      )}
      <ScheduleDialog
        open={dialogOpen}
        schedule={editing}
        catalog={catalog}
        submitting={submitting}
        error={submitError}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        onSubmit={(draft) => void handleSubmit(draft)}
      />
    </PageShell>
  );
}
