import { CloudJobsApiError, CloudJobsClient } from "@axle/client-runtime/cloud/jobs";
import { CloudJobCreateInput as CloudJobCreateInputSchema } from "@axle/contracts";
import type { CloudJob, CloudJobEvent, CloudJobPendingRequest } from "@axle/contracts";
import * as Schema from "effect/Schema";
import {
  BanIcon,
  CheckIcon,
  CloudIcon,
  CloudOffIcon,
  LogInIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { readClerkAccountToken } from "../../account/clerkRuntime";
import { useAccountActions } from "../../account/AccountAuthProvider";
import { openUpgradeDialog } from "../billing/UpgradeDialog";
import { cloudJobsLocked } from "../../entitlements/gates";
import { useEntitlements, resolvedEntitlements } from "../../entitlements/useEntitlements";
import { resolveCloudPublicConfig } from "../../cloud/publicConfig";
import { cn, randomUUID } from "../../lib/utils";
import { formatRelativeTimeLabel, formatRelativeTimeUntilLabel } from "../../timestampFormat";
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
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import {
  CloudRepositoryField,
  CloudSourceRefField,
  CloudTargetFields,
  InteractionModeField,
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

const TERMINAL_JOB_STATES: ReadonlySet<CloudJob["state"]> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

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

const EVENT_KIND_LABELS: Record<CloudJobEvent["kind"], string> = {
  state: "state",
  runtime: "runtime",
  request: "request",
  response: "response",
  cancellation: "cancellation",
};

function isUnauthorized(error: unknown): boolean {
  return error instanceof CloudJobsApiError && error.status === 401;
}

function describeError(error: unknown): string {
  if (error instanceof CloudJobsApiError) {
    if (error.code.startsWith("invalid_")) {
      return "The request was rejected. Check the entered values and try again.";
    }
    switch (error.code) {
      case "unauthorized":
        return "Your account session expired. Sign in again to continue.";
      case "network_error":
        return "Could not reach the account service. Check your connection and retry.";
      case "cloud_not_configured":
        return "Cloud execution is not configured for this deployment.";
      case "cloud_not_entitled":
        return "Cloud jobs are included with Axle Pro. Upgrade to start cloud runs.";
      case "cloud_access_denied":
      case "forbidden":
        return "Your account does not have access to cloud execution.";
      case "capacity_exceeded":
        return "Cloud capacity is exhausted right now. Try again shortly.";
      case "environment_unavailable":
        return "That environment is not available right now.";
      case "model_unavailable":
        return "That model is not available for cloud jobs.";
      case "source_revision_unavailable":
        return "That branch or tag could not be resolved to a commit. Choose another branch or paste a full commit SHA.";
      case "invalid_source_ref":
        return "Branch tracking requires a GitHub repository. Paste a full commit SHA instead.";
      case "event_limit_exceeded":
        return "This job produced too many events and stopped streaming.";
      case "not_found":
        return "That job no longer exists.";
      case "unexpected_response":
        return "The account service returned an unexpected response.";
      default:
        return error.status === 0
          ? "Could not reach the account service. Check your connection and retry."
          : `Cloud jobs request failed (${error.status} ${error.code}).`;
    }
  }
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "Something went wrong.";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index] ?? "KB"}`;
}

function shortRevision(revision: string): string {
  return revision.length > 12 ? revision.slice(0, 12) : revision;
}

function describePayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2) ?? String(payload);
  } catch {
    return String(payload);
  }
}

function PageShell({ children }: { readonly children: ReactNode }) {
  return (
    <main className="@container/cloud flex min-h-0 flex-1 flex-col overflow-hidden bg-background pt-[var(--workspace-topbar-height)] text-foreground">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border @3xl/cloud:flex-row">
        {children}
      </div>
    </main>
  );
}

function JobsAsideShell({ children }: { readonly children: ReactNode }) {
  return (
    <aside
      aria-label="Cloud jobs"
      className="flex max-h-[45%] min-h-48 w-full shrink-0 flex-col border-b border-border bg-muted/15 @3xl/cloud:max-h-none @3xl/cloud:w-80 @3xl/cloud:border-b-0 @3xl/cloud:border-r"
    >
      {children}
    </aside>
  );
}
function JobListItem({
  job,
  selected,
  onSelect,
}: {
  readonly job: CloudJob;
  readonly selected: boolean;
  readonly onSelect: (jobId: string) => void;
}) {
  const presentation = JOB_STATE_PRESENTATION[job.state];
  const title = job.input.prompt.split(/\r?\n/)[0]?.trim() || job.input.prompt.trim();
  return (
    <button
      type="button"
      aria-pressed={selected}
      data-testid={`cloud-job-item-${job.jobId}`}
      className={cn(
        "w-full border-b border-border/60 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected ? "bg-muted/60" : "hover:bg-muted/30",
      )}
      onClick={() => onSelect(job.jobId)}
    >
      <div className="flex items-center gap-2">
        <CloudIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{title}</span>
        <Badge variant={presentation.variant} size="sm">
          {presentation.label}
        </Badge>
      </div>
      <div className="mt-1.5 flex items-center gap-2 pl-5.5 text-[11px] text-muted-foreground">
        <span className="truncate">{job.input.environmentId}</span>
        <span aria-hidden="true">·</span>
        <span className="truncate font-mono">{shortRevision(job.input.sourceRevision)}</span>
        <span className="ml-auto shrink-0">{formatRelativeTimeLabel(job.updatedAt)}</span>
      </div>
    </button>
  );
}

function PendingRequestCard({
  request,
  busy,
  inputDraft,
  onInputDraftChange,
  onRespond,
}: {
  readonly request: CloudJobPendingRequest;
  readonly busy: boolean;
  readonly inputDraft: string;
  readonly onInputDraftChange: (value: string) => void;
  readonly onRespond: (request: CloudJobPendingRequest, payload: unknown) => void;
}) {
  const isApproval = request.kind === "approval";
  const draftReady = inputDraft.trim().length > 0;
  return (
    <section
      aria-label={isApproval ? "Approval request" : "Input request"}
      className="rounded-lg border border-warning/40 bg-warning/8 px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <ShieldAlertIcon className="size-4 text-warning-foreground" />
        <h2 className="text-sm font-semibold text-foreground">
          {isApproval ? "The cloud agent needs your approval" : "The cloud agent needs your input"}
        </h2>
      </div>
      <div className="mt-2 max-h-48 overflow-auto rounded-md border border-border/60 bg-background/70 p-2.5 font-mono text-[11px] leading-5 text-foreground/80">
        <pre className="whitespace-pre-wrap break-words">{describePayload(request.payload)}</pre>
      </div>
      {isApproval ? (
        <div className="mt-3 flex items-center gap-2">
          <Button
            size="sm"
            variant="default"
            disabled={busy}
            data-testid="cloud-job-approve"
            onClick={() => onRespond(request, { decision: "allow" })}
          >
            {busy ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <CheckIcon className="size-3.5" />
            )}
            Approve
          </Button>
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={busy}
            data-testid="cloud-job-deny"
            onClick={() => onRespond(request, { decision: "deny" })}
          >
            <BanIcon className="size-3.5" />
            Deny
          </Button>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <Textarea
            aria-label="Response to the cloud agent"
            value={inputDraft}
            disabled={busy}
            placeholder="Type the information the agent is waiting for"
            className="min-h-20 bg-background text-sm"
            onChange={(event) => onInputDraftChange(event.target.value)}
          />
          <Button
            size="sm"
            variant="default"
            disabled={busy || !draftReady}
            data-testid="cloud-job-send-input"
            onClick={() => onRespond(request, inputDraft.trim())}
          >
            {busy ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
            Send response
          </Button>
        </div>
      )}
    </section>
  );
}

function EventsList({ events }: { readonly events: ReadonlyArray<CloudJobEvent> }) {
  if (events.length === 0) {
    return (
      <p className="px-1 py-3 text-xs text-muted-foreground">
        No runtime events yet. Events appear here as the cloud worker reports progress.
      </p>
    );
  }
  return (
    <ol aria-label="Cloud job events" className="space-y-1.5">
      {events.map((event) => (
        <li
          key={event.sequence}
          className="rounded-md border border-border/60 bg-muted/20 px-3 py-2"
        >
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="font-mono text-foreground/60">#{event.sequence}</span>
            <Badge variant="outline" size="sm">
              {EVENT_KIND_LABELS[event.kind]}
            </Badge>
            <span className="ml-auto shrink-0">{formatRelativeTimeLabel(event.createdAt)}</span>
          </div>
          <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-foreground/80">
            {describePayload(event.payload).slice(0, 2000)}
          </pre>
        </li>
      ))}
    </ol>
  );
}

function ArtifactsSection({ job }: { readonly job: CloudJob }) {
  if (job.result === null) return null;
  return (
    <section
      aria-label="Result artifacts"
      className="rounded-lg border border-border bg-muted/15 px-4 py-3"
    >
      <h2 className="text-sm font-semibold text-foreground">Result</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        <span className="font-mono">{shortRevision(job.result.sourceRevision)}</span>
        {" -> "}
        <span className="font-mono">{shortRevision(job.result.headRevision)}</span>
      </p>
      {job.result.artifacts.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">No artifacts were produced.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border/60 rounded-md border border-border/60 bg-background/60">
          {job.result.artifacts.map((artifact) => (
            <li
              key={`${artifact.kind}-${artifact.storageKey}`}
              className="flex items-center gap-2 px-3 py-2 text-xs"
            >
              <Badge variant="secondary" size="sm">
                {artifact.kind}
              </Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-foreground/80">
                {artifact.storageKey}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {formatBytes(artifact.sizeBytes)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">
        Artifacts are stored by the cloud service. Apply or cherry-pick changes from your local
        checkout once you have reviewed the diff.
      </p>
    </section>
  );
}
function CreateJobDialog({
  client,
  catalog,
  open,
  onOpenChange,
  onCreated,
}: {
  readonly client: CloudJobsClient;
  readonly catalog: CloudEnvironmentCatalogState;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (job: CloudJob) => void;
}) {
  const [environmentId, setEnvironmentId] = useState("linux-standard");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [sourceRevision, setSourceRevision] = useState("");
  const [prompt, setPrompt] = useState("");
  const [providerInstanceId, setProviderInstanceId] = useState("");
  const [model, setModel] = useState("");
  const [interactionMode, setInteractionMode] = useState<"default" | "plan">("default");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const commandIdRef = useRef<string | null>(null);
  const repositoryState = useGitHubRepositories(open);
  const branchState = useGitHubBranches(repositoryUrl, open);
  const selectedEnvironment =
    catalog.environments.find((item) => item.environmentId === environmentId) ?? null;

  useEffect(() => {
    if (!open) return;
    commandIdRef.current = `create-${randomUUID()}`;
    setSubmitting(false);
    setSubmitError(null);
  }, [open]);

  useEffect(() => {
    if (!open || catalog.environments.length === 0) return;
    setEnvironmentId((current) =>
      catalog.environments.some((item) => item.environmentId === current)
        ? current
        : catalog.environments[0]!.environmentId,
    );
  }, [catalog.environments, open]);

  useEffect(() => {
    if (!open || selectedEnvironment === null) return;
    const fallback = defaultProviderModel(selectedEnvironment);
    setProviderInstanceId((current) =>
      providersForEnvironment(selectedEnvironment).includes(current)
        ? current
        : fallback.providerInstanceId,
    );
  }, [open, selectedEnvironment]);

  useEffect(() => {
    if (!open || selectedEnvironment === null) return;
    const allowedModels = modelsForProvider(selectedEnvironment, providerInstanceId);
    setModel((current) => (allowedModels.includes(current) ? current : (allowedModels[0] ?? "")));
  }, [open, providerInstanceId, selectedEnvironment]);

  const validationError = useMemo(() => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(environmentId.trim())) {
      return "Environment id must start with a letter or digit and use only letters, digits, dashes, or underscores.";
    }
    const url = repositoryUrl.trim();
    if (url.length === 0 || url.length > 2048) return "Repository URL is required.";
    const revision = sourceRevision.trim();
    if (!isValidSourceRef(revision)) {
      return "Choose a branch or enter a branch, tag, or full commit id without spaces.";
    }
    if (
      selectedEnvironment !== null &&
      !hostsAllowBranchTracking(selectedEnvironment.repositoryHosts) &&
      !isPinnedSourceRef(revision)
    ) {
      return "This environment only supports GitHub branch tracking. Paste a full commit SHA.";
    }
    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt.length === 0) return "Describe the task for the cloud agent.";
    if (trimmedPrompt.length > 32768) return "The task description is too long.";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(providerInstanceId.trim())) {
      return "Provider instance id must start with a letter or digit and use only letters, digits, dashes, or underscores.";
    }
    const trimmedModel = model.trim();
    if (trimmedModel.length === 0 || trimmedModel.length > 200) return "Model is required.";
    return null;
  }, [
    environmentId,
    model,
    prompt,
    providerInstanceId,
    repositoryUrl,
    selectedEnvironment,
    sourceRevision,
  ]);

  const handleSubmit = useCallback(async () => {
    if (submitting || validationError !== null) return;
    setSubmitting(true);
    setSubmitError(null);
    let input;
    try {
      input = Schema.decodeUnknownSync(CloudJobCreateInputSchema)({
        commandId: commandIdRef.current ?? `create-${randomUUID()}`,
        environmentId: environmentId.trim(),
        repositoryUrl: repositoryUrl.trim(),
        sourceRevision: sourceRevision.trim(),
        prompt: prompt.trim(),
        providerInstanceId: providerInstanceId.trim(),
        model: model.trim(),
        runtimeMode: "approval-required" as const,
        interactionMode,
      });
    } catch {
      setSubmitError(
        "Some values are invalid. Check the revision, environment id, and provider instance id.",
      );
      setSubmitting(false);
      return;
    }
    try {
      const result = await client.createJob(input);
      onCreated(result.job);
      onOpenChange(false);
    } catch (error) {
      setSubmitError(describeError(error));
    } finally {
      setSubmitting(false);
    }
  }, [
    client,
    environmentId,
    interactionMode,
    model,
    onCreated,
    onOpenChange,
    prompt,
    providerInstanceId,
    repositoryUrl,
    sourceRevision,
    submitting,
    validationError,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg" showCloseButton={!submitting}>
        <DialogHeader>
          <DialogTitle>New cloud job</DialogTitle>
          <DialogDescription>
            Runs on an independent Axle cloud runner. It keeps executing while this computer is
            offline, and every step that needs permission waits for your approval.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3" scrollFade={false}>
          <div className="space-y-1.5">
            <Label htmlFor="cloud-job-prompt">Task</Label>
            <Textarea
              id="cloud-job-prompt"
              value={prompt}
              disabled={submitting}
              placeholder="Describe the outcome you want in the repository…"
              className="min-h-24"
              onChange={(event) => setPrompt(event.target.value)}
            />
          </div>
          <CloudRepositoryField
            repositoryUrl={repositoryUrl}
            hosts={selectedEnvironment?.repositoryHosts ?? []}
            repositories={repositoryState.repositories}
            bridgeAvailable={repositoryState.bridgeAvailable}
            busy={repositoryState.busy}
            error={repositoryState.error}
            disabled={submitting}
            onRefresh={repositoryState.refresh}
            onChange={(value) => {
              setRepositoryUrl(value);
              setSourceRevision("");
            }}
          />
          <CloudSourceRefField
            value={sourceRevision}
            supported={branchState.supported}
            branches={branchState.branches}
            defaultBranch={branchState.defaultBranch}
            busy={branchState.busy}
            error={branchState.error}
            disabled={submitting}
            label="Branch or commit"
            helper="Runs start from the latest commit on this branch. The exact commit is captured when you start the job."
            onChange={setSourceRevision}
          />
          <CloudTargetFields
            environments={catalog.environments}
            environmentsBusy={catalog.busy}
            environmentsError={catalog.error}
            environmentId={environmentId}
            providerInstanceId={providerInstanceId}
            model={model}
            disabled={submitting}
            idPrefix="cloud-job"
            onChange={(patch) => {
              if (patch.environmentId !== undefined) setEnvironmentId(patch.environmentId);
              if (patch.providerInstanceId !== undefined)
                setProviderInstanceId(patch.providerInstanceId);
              if (patch.model !== undefined) setModel(patch.model);
            }}
          />
          <InteractionModeField
            value={interactionMode}
            disabled={submitting}
            onChange={setInteractionMode}
          />
          {validationError !== null ? (
            <p role="alert" className="text-xs leading-5 text-muted-foreground">
              {validationError}
            </p>
          ) : null}
          {submitError !== null ? (
            <p role="alert" className="text-xs leading-5 text-destructive-foreground">
              {submitError}
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
            data-testid="cloud-job-create-submit"
            disabled={submitting || validationError !== null}
            onClick={() => void handleSubmit()}
          >
            {submitting ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <PlusIcon className="size-3.5" />
            )}
            Start cloud job
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
export function CloudJobsPage() {
  const { signIn } = useAccountActions();
  const entitlements = resolvedEntitlements(useEntitlements());
  const jobsLocked = cloudJobsLocked(entitlements);
  const client = useMemo(() => {
    const { accountApiUrl } = resolveCloudPublicConfig();
    if (accountApiUrl === null) return null;
    return new CloudJobsClient({ baseUrl: accountApiUrl, getToken: readClerkAccountToken });
  }, []);
  const catalog = useCloudEnvironmentCatalog(client);

  const [phase, setPhase] = useState<"loading" | "ready" | "signed_out" | "unconfigured" | "error">(
    client === null ? "unconfigured" : "loading",
  );
  const [jobs, setJobs] = useState<ReadonlyArray<CloudJob>>([]);
  const [jobsBusy, setJobsBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [job, setJob] = useState<CloudJob | null>(null);
  const [events, setEvents] = useState<ReadonlyArray<CloudJobEvent>>([]);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [inputDraft, setInputDraft] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const openCreateFlow = useCallback(() => {
    if (jobsLocked) {
      openUpgradeDialog("cloud-jobs");
      return;
    }
    setCreateOpen(true);
  }, [jobsLocked]);

  const listRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const eventsCursorRef = useRef<{ jobId: string | null; lastSequence: number }>({
    jobId: null,
    lastSequence: 0,
  });
  const respondCommandRef = useRef<{ requestId: string | null; commandId: string | null }>({
    requestId: null,
    commandId: null,
  });

  const refreshJobs = useCallback(async () => {
    if (client === null) return;
    const requestId = ++listRequestRef.current;
    setJobsBusy(true);
    try {
      const nextJobs = await client.listJobs();
      if (listRequestRef.current !== requestId) return;
      setJobs(nextJobs);
      setLoadError(null);
      setPhase("ready");
      setSelectedJobId((previous) =>
        previous !== null && nextJobs.some((candidate) => candidate.jobId === previous)
          ? previous
          : (nextJobs[0]?.jobId ?? null),
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
      if (listRequestRef.current === requestId) setJobsBusy(false);
    }
  }, [client]);

  useEffect(() => {
    if (client === null) return;
    void refreshJobs();
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      void refreshJobs();
    }, 5000);
    const handleVisibility = () => {
      if (!document.hidden) void refreshJobs();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [client, refreshJobs]);

  useEffect(() => {
    if (client === null || selectedJobId === null) {
      setJob(null);
      setEvents([]);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    let initialLoaded = false;
    const requestId = ++detailRequestRef.current;
    const cursor = { jobId: selectedJobId, lastSequence: 0 };
    eventsCursorRef.current = cursor;
    setJob(null);
    setEvents([]);
    setDetailError(null);
    setActionError(null);
    setInputDraft("");

    const loadInitial = async () => {
      try {
        const [nextJob, page] = await Promise.all([
          client.getJob(selectedJobId),
          client.listEvents(selectedJobId, { limit: 200 }),
        ]);
        if (cancelled || detailRequestRef.current !== requestId) return;
        setJob(nextJob);
        setEvents(page.events);
        cursor.lastSequence = page.lastSequence;
        initialLoaded = true;
      } catch (error) {
        if (cancelled || detailRequestRef.current !== requestId) return;
        if (isUnauthorized(error)) {
          setPhase("signed_out");
          return;
        }
        setDetailError(describeError(error));
      }
    };

    const poll = async () => {
      if (!initialLoaded) return;
      try {
        const [nextJob, page] = await Promise.all([
          client.getJob(selectedJobId),
          client.listEvents(selectedJobId, { after: cursor.lastSequence, limit: 500 }),
        ]);
        if (cancelled || detailRequestRef.current !== requestId) return;
        setJob(nextJob);
        cursor.lastSequence = Math.max(cursor.lastSequence, page.lastSequence);
        if (page.events.length > 0) {
          setEvents((previous) => [...previous, ...page.events].slice(-500));
        }
        setDetailError(null);
      } catch (error) {
        if (cancelled || detailRequestRef.current !== requestId) return;
        if (isUnauthorized(error)) {
          setPhase("signed_out");
          return;
        }
        setDetailError(describeError(error));
      }
    };

    void loadInitial();
    const interval = window.setInterval(() => {
      if (!document.hidden) void poll();
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [client, selectedJobId]);

  const respondCommandIdFor = useCallback((requestId: string): string => {
    const current = respondCommandRef.current;
    if (current.requestId === requestId && current.commandId !== null) return current.commandId;
    const commandId = `resp-${randomUUID()}`;
    respondCommandRef.current = { requestId, commandId };
    return commandId;
  }, []);

  const handleRespond = useCallback(
    async (request: CloudJobPendingRequest, payload: unknown) => {
      if (client === null || job === null || actionBusy) return;
      setActionBusy(true);
      setActionError(null);
      try {
        const updated = await client.respondToRequest(job.jobId, {
          commandId: respondCommandIdFor(request.requestId),
          requestId: request.requestId,
          payload,
        });
        respondCommandRef.current = { requestId: null, commandId: null };
        setJob(updated);
        setInputDraft("");
        void refreshJobs();
      } catch (error) {
        if (error instanceof CloudJobsApiError && error.status === 404) {
          respondCommandRef.current = { requestId: null, commandId: null };
        }
        setActionError(describeError(error));
      } finally {
        setActionBusy(false);
      }
    },
    [actionBusy, client, job, refreshJobs, respondCommandIdFor],
  );

  const handleCancel = useCallback(async () => {
    if (client === null || job === null || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const updated = await client.cancelJob(job.jobId);
      setJob(updated);
      void refreshJobs();
    } catch (error) {
      setActionError(describeError(error));
    } finally {
      setActionBusy(false);
    }
  }, [actionBusy, client, job, refreshJobs]);

  const handleCreated = useCallback(
    (created: CloudJob) => {
      setPhase("ready");
      setSelectedJobId(created.jobId);
      setJobs((previous) => [
        created,
        ...previous.filter((candidate) => candidate.jobId !== created.jobId),
      ]);
      void refreshJobs();
    },
    [refreshJobs],
  );

  if (client === null || phase === "unconfigured") {
    return (
      <PageShell>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CloudOffIcon />
            </EmptyMedia>
            <EmptyTitle>Cloud execution is not configured</EmptyTitle>
            <EmptyDescription>
              This build has no account service URL. Set <code>VITE_ACCOUNT_API_URL</code> to the
              Axle account API to create and monitor cloud jobs.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageShell>
    );
  }

  if (phase === "signed_out") {
    return (
      <PageShell>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CloudIcon />
            </EmptyMedia>
            <EmptyTitle>Sign in to use Axle Cloud</EmptyTitle>
            <EmptyDescription>
              Cloud jobs are tied to your account. Sign in, then return here to start and monitor
              independent cloud runs.
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
              disabled={jobsBusy}
              onClick={() => void refreshJobs()}
            >
              <RefreshCwIcon className={cn("size-3.5", jobsBusy && "animate-spin")} />
              Check again
            </Button>
          </div>
        </Empty>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <JobsAsideShell>
        <div className="shrink-0 border-b border-border px-4 pb-3 pt-3">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold tracking-tight">Cloud jobs</h1>
            <Badge variant="outline" size="sm" className="gap-1">
              <CloudIcon className="size-3" />
              Cloud
            </Badge>
            {jobsLocked ? (
              <Badge variant="secondary" size="sm">
                Pro
              </Badge>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh cloud jobs"
                disabled={jobsBusy}
                onClick={() => void refreshJobs()}
              >
                <RefreshCwIcon className={cn("size-4", jobsBusy && "animate-spin")} />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                data-testid="cloud-job-create-open"
                onClick={openCreateFlow}
              >
                <PlusIcon className="size-3.5" />
                New job
              </Button>
            </div>
          </div>
          <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
            Independent cloud runners. Jobs keep executing when your computer is offline. Local
            sessions are not listed here.
          </p>
          {jobsLocked ? (
            <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
              Cloud jobs are included with Axle Pro.{" "}
              <button
                type="button"
                className="underline underline-offset-2 transition-colors hover:text-foreground"
                onClick={() => openUpgradeDialog("cloud-jobs")}
              >
                Upgrade
              </button>
            </p>
          ) : null}
          {loadError !== null ? (
            <p role="alert" className="mt-2 text-xs leading-5 text-muted-foreground">
              {loadError}
            </p>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {phase === "loading" ? (
            <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              Loading cloud jobs…
            </div>
          ) : jobs.length === 0 ? (
            <div className="px-4 py-4 text-xs leading-5 text-muted-foreground">
              {phase === "error"
                ? "Cloud jobs could not be loaded. Retry with the refresh button."
                : "No cloud jobs yet. Start one to run an agent in the cloud."}
            </div>
          ) : (
            jobs.map((candidate) => (
              <JobListItem
                key={candidate.jobId}
                job={candidate}
                selected={candidate.jobId === selectedJobId}
                onSelect={setSelectedJobId}
              />
            ))
          )}
        </div>
      </JobsAsideShell>
      <section
        aria-label="Cloud job detail"
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <JobDetailPanel
          job={job}
          selectedJobId={selectedJobId}
          events={events}
          detailError={detailError}
          actionBusy={actionBusy}
          actionError={actionError}
          inputDraft={inputDraft}
          onInputDraftChange={setInputDraft}
          onRespond={handleRespond}
          onCancel={handleCancel}
          onRetry={() => void refreshJobs()}
          onCreate={openCreateFlow}
        />
      </section>
      <CreateJobDialog
        client={client}
        catalog={catalog}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />
    </PageShell>
  );
}

function JobDetailPanel({
  job,
  selectedJobId,
  events,
  detailError,
  actionBusy,
  actionError,
  inputDraft,
  onInputDraftChange,
  onRespond,
  onCancel,
  onRetry,
  onCreate,
}: {
  readonly job: CloudJob | null;
  readonly selectedJobId: string | null;
  readonly events: ReadonlyArray<CloudJobEvent>;
  readonly detailError: string | null;
  readonly actionBusy: boolean;
  readonly actionError: string | null;
  readonly inputDraft: string;
  readonly onInputDraftChange: (value: string) => void;
  readonly onRespond: (request: CloudJobPendingRequest, payload: unknown) => void;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onCreate: () => void;
}) {
  if (selectedJobId === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CloudIcon />
          </EmptyMedia>
          <EmptyTitle>{detailError ? "Job unavailable" : "No cloud job selected"}</EmptyTitle>
          <EmptyDescription>
            {detailError ??
              "Select a job from the list, or start a new cloud job to run an agent independently of this device."}
          </EmptyDescription>
        </EmptyHeader>
        <div className="flex items-center gap-2">
          {detailError ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCwIcon className="size-3.5" />
              Retry
            </Button>
          ) : null}
          <Button variant="default" size="sm" onClick={onCreate}>
            <PlusIcon className="size-3.5" />
            New cloud job
          </Button>
        </div>
      </Empty>
    );
  }

  if (job === null) {
    if (detailError !== null) {
      return (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CloudOffIcon />
            </EmptyMedia>
            <EmptyTitle>Cloud job could not be loaded</EmptyTitle>
            <EmptyDescription>{detailError}</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCwIcon className="size-3.5" />
            Retry
          </Button>
        </Empty>
      );
    }
    return (
      <div className="flex items-center gap-2 px-5 py-6 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        Loading job…
      </div>
    );
  }

  const presentation = JOB_STATE_PRESENTATION[job.state];
  const title = job.input.prompt.split(/\r?\n/)[0]?.trim() || job.input.prompt.trim();
  const terminal = TERMINAL_JOB_STATES.has(job.state);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-4 px-5 py-4">
        <header className="space-y-2">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h1
                className="truncate text-sm font-semibold tracking-tight"
                title={job.input.prompt}
              >
                {title}
              </h1>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <CloudIcon className="size-3" />
                  Cloud · {job.input.environmentId}
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono">{shortRevision(job.input.sourceRevision)}</span>
                <span aria-hidden="true">·</span>
                <span>Updated {formatRelativeTimeLabel(job.updatedAt)}</span>
              </p>
            </div>
            <Badge variant={presentation.variant}>{presentation.label}</Badge>
            {!terminal ? (
              <Button
                variant="destructive-outline"
                size="sm"
                disabled={actionBusy || job.cancelRequestedAt !== null}
                data-testid="cloud-job-cancel"
                onClick={onCancel}
              >
                {actionBusy ? (
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                ) : (
                  <BanIcon className="size-3.5" />
                )}
                {job.cancelRequestedAt !== null ? "Cancelling…" : "Cancel"}
              </Button>
            ) : null}
          </div>
          {job.failureCode !== null ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-xs text-destructive-foreground"
            >
              Cloud job failed: {job.failureCode.replaceAll("_", " ")}.
            </p>
          ) : null}
          {actionError !== null ? (
            <p
              role="alert"
              className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
            >
              {actionError}
            </p>
          ) : null}
        </header>

        {job.pendingRequest !== null ? (
          <PendingRequestCard
            request={job.pendingRequest}
            busy={actionBusy}
            inputDraft={inputDraft}
            onInputDraftChange={onInputDraftChange}
            onRespond={onRespond}
          />
        ) : null}

        <section
          aria-label="Job details"
          className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-muted/15 px-4 py-3 text-xs sm:grid-cols-4"
        >
          <div>
            <div className="text-muted-foreground">Created</div>
            <time
              dateTime={job.createdAt}
              title={job.createdAt}
              className="mt-0.5 block text-foreground/90"
            >
              {formatRelativeTimeLabel(job.createdAt)}
            </time>
          </div>
          <div>
            <div className="text-muted-foreground">Deadline</div>
            <time
              dateTime={job.deadlineAt}
              title={job.deadlineAt}
              className="mt-0.5 block text-foreground/90"
            >
              {formatRelativeTimeUntilLabel(job.deadlineAt)}
            </time>
          </div>
          <div>
            <div className="text-muted-foreground">Model</div>
            <div className="mt-0.5 truncate font-mono text-foreground/90" title={job.input.model}>
              {job.input.model}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Mode</div>
            <div className="mt-0.5 text-foreground/90">
              {job.input.interactionMode === "plan" ? "Plan first" : "Default"}
            </div>
          </div>
        </section>

        <section
          aria-label="Task"
          className="rounded-lg border border-border bg-muted/15 px-4 py-3"
        >
          <h2 className="text-sm font-semibold text-foreground">Task</h2>
          <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-5 text-foreground/85">
            {job.input.prompt}
          </p>
          <p className="mt-2 font-mono text-[11px] text-muted-foreground">
            {job.input.repositoryUrl}
          </p>
        </section>

        <ArtifactsSection job={job} />

        <section aria-label="Runtime events">
          <h2 className="mb-2 text-sm font-semibold text-foreground">Events</h2>
          <EventsList events={events} />
        </section>
      </div>
    </div>
  );
}
