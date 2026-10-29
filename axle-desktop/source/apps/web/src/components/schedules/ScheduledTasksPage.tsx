import {
  BellRingIcon,
  CalendarClockIcon,
  ChevronRightIcon,
  CloudIcon,
  FileSearchIcon,
  HistoryIcon,
  LoaderCircleIcon,
  ExternalLinkIcon,
  NotebookPenIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type FormEvent,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { ThreadId, type ScheduledTaskList, type ServerScheduledTask } from "@axle/contracts";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { openUpgradeDialog } from "../billing/UpgradeDialog";
import { CloudSchedulesPage } from "../cloud/CloudSchedulesPage";
import { scheduledTasksLimit } from "../../entitlements/gates";
import { useEntitlements, resolvedEntitlements } from "../../entitlements/useEntitlements";
import {
  DEFAULT_SCHEDULED_TASKS,
  formatScheduleSummary,
  formatTimeLabel,
  getNextRunLabel,
  removePreloadedScheduledTasks,
  SCHEDULED_TASKS_STORAGE_KEY,
  SCHEDULED_TASKS_SUGGESTION_CYCLE_STORAGE_KEY,
  LEGACY_SCHEDULED_TASKS_STORAGE_KEYS,
  LEGACY_SCHEDULED_TASKS_SUGGESTION_CYCLE_STORAGE_KEYS,
  selectCycledSuggestions,
  type ScheduleDraft,
  type ScheduleFrequency,
  type ScheduledTask,
  type ScheduledTaskAccent,
  ScheduledTaskListSchema,
  WEEKDAY_OPTIONS,
} from "../../scheduledTasks";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Button } from "../ui/button";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { listSchedules, saveSchedule, removeSchedule, runSchedule } from "./scheduleApi";

type TaskFilter = "all" | "active" | "paused";

const FILTER_OPTIONS: ReadonlyArray<{ value: TaskFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
];

const FREQUENCY_OPTIONS: ReadonlyArray<{
  value: ScheduleFrequency;
  label: string;
  description: string;
}> = [
  { value: "hourly", label: "Loop", description: "Repeat on an interval" },
  { value: "daily", label: "Every day", description: "Run once a day" },
  { value: "weekly", label: "Specific day", description: "Run on a weekday" },
  { value: "once", label: "Once", description: "Run one time" },
];

const SUGGESTION_PAGE_SIZE = 3;
const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-input bg-muted/60 px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20";
const SELECT_TRIGGER_CLASS =
  "h-9 min-h-9 w-full rounded-lg border border-input bg-muted/60 px-3 text-[13px] text-foreground shadow-none outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20";
const DROPDOWN_POPUP_CLASS = "bg-popover";
const TEXTAREA_CLASS =
  "min-h-20 w-full resize-y rounded-lg border border-input bg-muted/60 px-3 py-2 text-[13px] leading-5 text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20";
const TIME_OPTIONS = Array.from({ length: 96 }, (_, index) => {
  const totalMinutes = index * 15;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const value = `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
  return { value, label: formatTimeLabel(value) };
});

interface ScheduleSuggestion {
  title: string;
  schedule: string;
  description: string;
  accent: ScheduledTaskAccent;
  icon: ComponentType<{ className?: string }>;
  draft: ScheduleDraft;
}

function tomorrowDateInputValue(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

function emptyScheduleDraft(): ScheduleDraft {
  return {
    title: "",
    prompt: "",
    frequency: "daily",
    intervalHours: 1,
    time: "08:00",
    dayOfWeek: "monday",
    date: tomorrowDateInputValue(),
  };
}

const SUGGESTIONS: readonly ScheduleSuggestion[] = [
  {
    title: "Daily brief",
    schedule: "Weekdays at 8:00 AM",
    description: "Start each weekday with a summary of your calendar, unread email, and priorities",
    accent: "blue",
    icon: BellRingIcon,
    draft: {
      title: "Daily brief",
      prompt: "Start each weekday with a summary of my calendar, unread email, and priorities.",
      frequency: "weekly",
      intervalHours: 1,
      time: "08:00",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Weekly review",
    schedule: "Fridays at 4:00 PM",
    description: "Turn your recent work into a concise status update every Friday",
    accent: "violet",
    icon: NotebookPenIcon,
    draft: {
      title: "Weekly review",
      prompt: "Turn my recent work into a concise status update every Friday.",
      frequency: "weekly",
      intervalHours: 1,
      time: "16:00",
      dayOfWeek: "friday",
      date: "",
    },
  },
  {
    title: "Follow-up monitor",
    schedule: "Weekdays at 9:00 AM",
    description:
      "Review recent email and calendar activity and flag anything that needs your attention",
    accent: "green",
    icon: FileSearchIcon,
    draft: {
      title: "Follow-up monitor",
      prompt:
        "Review recent email and calendar activity and flag anything that needs my attention.",
      frequency: "weekly",
      intervalHours: 1,
      time: "09:00",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Inbox zero check",
    schedule: "Every day at 5:00 PM",
    description: "Summarize unanswered messages and suggest the next follow-up for each one",
    accent: "blue",
    icon: BellRingIcon,
    draft: {
      title: "Inbox zero check",
      prompt: "Summarize unanswered messages and suggest the next follow-up for each one.",
      frequency: "daily",
      intervalHours: 1,
      time: "17:00",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Stand-up prep",
    schedule: "Weekdays at 9:15 AM",
    description: "Turn yesterday's work and today's calendar into a short stand-up update",
    accent: "violet",
    icon: NotebookPenIcon,
    draft: {
      title: "Stand-up prep",
      prompt: "Turn yesterday's work and today's calendar into a short stand-up update.",
      frequency: "weekly",
      intervalHours: 1,
      time: "09:15",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Project pulse",
    schedule: "Mondays at 10:00 AM",
    description: "Review project activity and call out risks, blockers, and recent progress",
    accent: "green",
    icon: FileSearchIcon,
    draft: {
      title: "Project pulse",
      prompt: "Review project activity and call out risks, blockers, and recent progress.",
      frequency: "weekly",
      intervalHours: 1,
      time: "10:00",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Reading roundup",
    schedule: "Sundays at 6:00 PM",
    description: "Collect the articles I saved this week and summarize the ideas worth revisiting",
    accent: "blue",
    icon: NotebookPenIcon,
    draft: {
      title: "Reading roundup",
      prompt: "Collect the articles I saved this week and summarize the ideas worth revisiting.",
      frequency: "weekly",
      intervalHours: 1,
      time: "18:00",
      dayOfWeek: "sunday",
      date: "",
    },
  },
  {
    title: "Meeting prep",
    schedule: "Weekdays at 8:30 AM",
    description:
      "Prepare a concise briefing from the day's meetings, attendees, and open decisions",
    accent: "violet",
    icon: BellRingIcon,
    draft: {
      title: "Meeting prep",
      prompt: "Prepare a concise briefing from the day's meetings, attendees, and open decisions.",
      frequency: "weekly",
      intervalHours: 1,
      time: "08:30",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Expense check",
    schedule: "Fridays at 3:00 PM",
    description: "Review recent expenses and flag missing receipts or unusual charges",
    accent: "green",
    icon: FileSearchIcon,
    draft: {
      title: "Expense check",
      prompt: "Review recent expenses and flag missing receipts or unusual charges.",
      frequency: "weekly",
      intervalHours: 1,
      time: "15:00",
      dayOfWeek: "friday",
      date: "",
    },
  },
  {
    title: "Repository watch",
    schedule: "Every 2 hours",
    description: "Watch the repository for important changes and summarize new activity",
    accent: "blue",
    icon: FileSearchIcon,
    draft: {
      title: "Repository watch",
      prompt: "Watch the repository for important changes and summarize new activity.",
      frequency: "hourly",
      intervalHours: 2,
      time: "",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Focus plan",
    schedule: "Every day at 8:45 AM",
    description: "Choose three priorities for today from my active projects and calendar",
    accent: "violet",
    icon: NotebookPenIcon,
    draft: {
      title: "Focus plan",
      prompt: "Choose three priorities for today from my active projects and calendar.",
      frequency: "daily",
      intervalHours: 1,
      time: "08:45",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Team update",
    schedule: "Thursdays at 2:00 PM",
    description: "Draft a clear team update from the week's completed work and open questions",
    accent: "green",
    icon: BellRingIcon,
    draft: {
      title: "Team update",
      prompt: "Draft a clear team update from the week's completed work and open questions.",
      frequency: "weekly",
      intervalHours: 1,
      time: "14:00",
      dayOfWeek: "thursday",
      date: "",
    },
  },
  {
    title: "News digest",
    schedule: "Every day at 7:30 AM",
    description: "Summarize the most important news for the topics I am tracking",
    accent: "blue",
    icon: BellRingIcon,
    draft: {
      title: "News digest",
      prompt: "Summarize the most important news for the topics I am tracking.",
      frequency: "daily",
      intervalHours: 1,
      time: "07:30",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Calendar sweep",
    schedule: "Mondays at 8:15 AM",
    description:
      "Look ahead at the next seven days and flag schedule conflicts or preparation gaps",
    accent: "violet",
    icon: FileSearchIcon,
    draft: {
      title: "Calendar sweep",
      prompt: "Look ahead at the next seven days and flag schedule conflicts or preparation gaps.",
      frequency: "weekly",
      intervalHours: 1,
      time: "08:15",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Customer feedback",
    schedule: "Wednesdays at 11:00 AM",
    description: "Group new customer feedback into themes and highlight the most urgent requests",
    accent: "green",
    icon: NotebookPenIcon,
    draft: {
      title: "Customer feedback",
      prompt: "Group new customer feedback into themes and highlight the most urgent requests.",
      frequency: "weekly",
      intervalHours: 1,
      time: "11:00",
      dayOfWeek: "wednesday",
      date: "",
    },
  },
  {
    title: "Learning log",
    schedule: "Saturdays at 5:30 PM",
    description:
      "Review this week's notes and turn the most useful lessons into a short learning log",
    accent: "blue",
    icon: NotebookPenIcon,
    draft: {
      title: "Learning log",
      prompt:
        "Review this week's notes and turn the most useful lessons into a short learning log.",
      frequency: "weekly",
      intervalHours: 1,
      time: "17:30",
      dayOfWeek: "saturday",
      date: "",
    },
  },
  {
    title: "End-of-day recap",
    schedule: "Every day at 6:30 PM",
    description: "Summarize what changed today and carry unfinished priorities into tomorrow",
    accent: "violet",
    icon: BellRingIcon,
    draft: {
      title: "End-of-day recap",
      prompt: "Summarize what changed today and carry unfinished priorities into tomorrow.",
      frequency: "daily",
      intervalHours: 1,
      time: "18:30",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Dependency watch",
    schedule: "Every 4 hours",
    description: "Check dependencies for important updates and note anything that needs review",
    accent: "green",
    icon: FileSearchIcon,
    draft: {
      title: "Dependency watch",
      prompt: "Check dependencies for important updates and note anything that needs review.",
      frequency: "hourly",
      intervalHours: 4,
      time: "",
      dayOfWeek: "monday",
      date: "",
    },
  },
  {
    title: "Personal planning",
    schedule: "Sundays at 7:00 PM",
    description: "Plan the week ahead around my priorities, commitments, and available focus time",
    accent: "blue",
    icon: NotebookPenIcon,
    draft: {
      title: "Personal planning",
      prompt: "Plan the week ahead around my priorities, commitments, and available focus time.",
      frequency: "weekly",
      intervalHours: 1,
      time: "19:00",
      dayOfWeek: "sunday",
      date: "",
    },
  },
  {
    title: "Launch monitor",
    schedule: "Once on a specific date",
    description: "Check launch-day activity and report anything that needs an immediate response",
    accent: "violet",
    icon: FileSearchIcon,
    draft: {
      title: "Launch monitor",
      prompt: "Check launch-day activity and report anything that needs an immediate response.",
      frequency: "once",
      intervalHours: 1,
      time: "10:00",
      dayOfWeek: "monday",
      date: tomorrowDateInputValue(),
    },
  },
];

function taskMatchesFilter(task: { active: boolean }, filter: TaskFilter): boolean {
  if (filter === "all") return true;
  return filter === "active" ? task.active : !task.active;
}

export function ScheduledTasksPage() {
  const [legacyTasks, setLegacyTasks] = useLocalStorage(
    SCHEDULED_TASKS_STORAGE_KEY,
    DEFAULT_SCHEDULED_TASKS,
    ScheduledTaskListSchema,
    { legacyKeys: LEGACY_SCHEDULED_TASKS_STORAGE_KEYS },
  );
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const entitlements = resolvedEntitlements(useEntitlements());
  const taskLimit = scheduledTasksLimit(entitlements);
  const [tasks, setTasks] = useState<readonly ServerScheduledTask[]>([]);
  const [targets, setTargets] = useState<ScheduledTaskList["targets"]>([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [targetThreadId, setTargetThreadId] = useState("");
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [historyTaskId, setHistoryTaskId] = useState<string | null>(null);
  const [importingTaskId, setImportingTaskId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [activeTab, setActiveTab] = useState<"tasks" | "cloud">("tasks");
  const [suggestionCycleIndex, setSuggestionCycleIndex] = useLocalStorage(
    SCHEDULED_TASKS_SUGGESTION_CYCLE_STORAGE_KEY,
    0,
    Schema.Number,
    { legacyKeys: LEGACY_SCHEDULED_TASKS_SUGGESTION_CYCLE_STORAGE_KEYS },
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft>(emptyScheduleDraft);
  const [formError, setFormError] = useState("");
  const didAdvanceSuggestionCycle = useRef(false);
  const errorText = (cause: unknown) =>
    cause instanceof Error ? cause.message : "Scheduled tasks could not be updated. Try again.";
  const refresh = useCallback(async () => {
    try {
      const result = await listSchedules();
      setTasks(result.tasks);
      setTargets(result.targets);
      setPageError("");
    } catch (cause) {
      setPageError(
        cause instanceof Error ? cause.message : "Scheduled tasks could not be loaded. Try again.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 10_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    if (didAdvanceSuggestionCycle.current) return;
    didAdvanceSuggestionCycle.current = true;
    setSuggestionCycleIndex((currentIndex) => currentIndex + 1);
  }, [setSuggestionCycleIndex]);

  useEffect(() => {
    const cleanedTasks = removePreloadedScheduledTasks(legacyTasks);
    if (cleanedTasks.length !== legacyTasks.length) {
      setLegacyTasks(cleanedTasks);
    }
  }, [setLegacyTasks, legacyTasks]);

  const visibleTasks = useMemo(
    () =>
      tasks.filter(
        (task) =>
          taskMatchesFilter(task, filter) &&
          `${task.title} ${task.prompt} ${formatScheduleSummary(task)}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [filter, query, tasks],
  );

  const visibleSuggestions = useMemo(
    () => selectCycledSuggestions(SUGGESTIONS, suggestionCycleIndex, SUGGESTION_PAGE_SIZE),
    [suggestionCycleIndex],
  );

  const editingTask =
    editingTaskId === null ? null : tasks.find((task) => task.id === editingTaskId);
  const historyTask = tasks.find((task) => task.id === historyTaskId);
  const targetLabel = (threadId: ThreadId) =>
    targets.find((target) => target.threadId === threadId)?.title ?? "Unavailable chat";
  const formatRunTime = (value: string, zone: string) =>
    new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  const runLabel = (status: string) =>
    ({
      pending: "Starting",
      running: "Running",
      "needs-attention": "Needs your input",
      succeeded: "Completed",
      failed: "Failed",
      skipped: "Skipped",
    })[status] ?? status;
  const openTaskChat = (threadId: ThreadId) => {
    if (primaryEnvironmentId)
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: primaryEnvironmentId, threadId },
      });
  };

  const openCreateDialog = (suggestionDraft?: ScheduleDraft) => {
    if (taskLimit !== null && tasks.length >= taskLimit) {
      openUpgradeDialog("schedules");
      return;
    }
    setEditingTaskId(null);
    setImportingTaskId(null);
    setTargetThreadId(targets[0]?.threadId ?? "");
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    setDraft(suggestionDraft ? { ...suggestionDraft } : emptyScheduleDraft());
    setFormError("");
    setDialogOpen(true);
  };

  const openEditDialog = (task: ServerScheduledTask) => {
    setEditingTaskId(task.id);
    setImportingTaskId(null);
    setTargetThreadId(task.threadId);
    setTimeZone(task.timeZone);
    setDraft({
      title: task.title,
      prompt: task.prompt,
      frequency: task.frequency,
      intervalHours: task.intervalHours,
      time: task.time,
      dayOfWeek: task.dayOfWeek,
      date: task.date,
    });
    setFormError("");
    setDialogOpen(true);
  };

  const handleTaskSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.title.trim()) {
      setFormError("Add a name for this scheduled task.");
      return;
    }
    if (!draft.prompt.trim()) {
      setFormError("Describe what Axle should do when this task runs.");
      return;
    }

    if (!targetThreadId) {
      setFormError("Choose the chat where this task should run.");
      return;
    }
    if (busy) return;
    setBusy("save");
    try {
      const saved = await saveSchedule({
        ...draft,
        ...(editingTask ? { id: editingTask.id } : {}),
        threadId: ThreadId.make(targetThreadId),
        timeZone,
        active: editingTask?.active ?? true,
      });
      setTasks((current) => [...current.filter((task) => task.id !== saved.id), saved]);
      if (importingTaskId)
        setLegacyTasks((current) => current.filter((task) => task.id !== importingTaskId));
      setDialogOpen(false);
      setFormError("");
    } catch (cause) {
      setFormError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const importDraft = (task: ScheduledTask) => {
    openCreateDialog({
      title: task.title,
      prompt: task.description,
      frequency: task.frequency,
      intervalHours: task.intervalHours,
      time: task.time,
      dayOfWeek: task.dayOfWeek,
      date: task.date,
    });
    setImportingTaskId(task.id);
  };

  const performTaskAction = async (task: ServerScheduledTask, action: "toggle" | "run") => {
    if (busy) return;
    setBusy(task.id);
    setPageError("");
    try {
      const updated =
        action === "run"
          ? await runSchedule(task.id)
          : await saveSchedule({ ...task, active: !task.active });
      setTasks((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (cause) {
      setPageError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const deleteEditingTask = async () => {
    if (!editingTaskId || busy) return;
    setBusy("delete");
    try {
      await removeSchedule(editingTaskId);
      setTasks((current) => current.filter((task) => task.id !== editingTaskId));
      setDialogOpen(false);
      setEditingTaskId(null);
    } catch (cause) {
      setFormError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const pageHeader = (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <h1
          id="scheduled-tasks-title"
          className="text-2xl font-semibold tracking-tight text-foreground"
        >
          Scheduled tasks
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {activeTab === "cloud"
            ? "Run recurring work on Axle cloud workers, independent of this computer."
            : "Run recurring work in your chats, with their existing model and permissions."}
        </p>
      </div>
      {activeTab === "tasks" ? (
        <Button
          type="button"
          data-testid="schedules-create-button"
          size="sm"
          className="self-start"
          disabled={loading || targets.length === 0}
          onClick={() => openCreateDialog()}
        >
          <PlusIcon className="size-3.5" />
          Create task
        </Button>
      ) : null}
    </header>
  );

  const scheduleTabs = (
    <div
      role="tablist"
      aria-label="Schedule type"
      className="mt-5 flex items-center gap-1 border-b border-border pb-3"
    >
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "tasks"}
        className={cn(
          "inline-flex h-8 items-center gap-2 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          activeTab === "tasks"
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
        onClick={() => setActiveTab("tasks")}
      >
        <CalendarClockIcon className="size-3.5" />
        Chat tasks
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "cloud"}
        className={cn(
          "inline-flex h-8 items-center gap-2 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          activeTab === "cloud"
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
        onClick={() => setActiveTab("cloud")}
      >
        <CloudIcon className="size-3.5" />
        Cloud schedules
      </button>
    </div>
  );

  if (activeTab === "cloud") {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
          <div className="mx-auto w-full max-w-4xl px-5 pt-16 sm:px-8">
            {pageHeader}
            {scheduleTabs}
          </div>
          <CloudSchedulesPage embedded />
        </div>
      </SidebarInset>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="relative min-h-0 flex-1 overflow-y-auto bg-background">
        <div
          aria-labelledby="scheduled-tasks-title"
          className="mx-auto w-full max-w-4xl px-5 pb-12 pt-16 sm:px-8"
        >
          {pageHeader}

          {scheduleTabs}

          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            Tasks run while this Axle environment is online. Missed recurring runs resume once when
            it reconnects.
          </p>

          {taskLimit !== null ? (
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
              {tasks.length >= taskLimit
                ? `You have reached the Free limit of ${taskLimit} scheduled tasks. `
                : `Free includes up to ${taskLimit} scheduled tasks. `}
              <button
                type="button"
                className="underline underline-offset-2 transition-colors hover:text-foreground"
                onClick={() => openUpgradeDialog("schedules")}
              >
                {tasks.length >= taskLimit ? "Upgrade for more" : "See plans"}
              </button>
            </p>
          ) : null}

          {pageError ? (
            <div
              role="alert"
              className="mt-4 flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3"
            >
              <p className="min-w-0 flex-1 text-xs leading-5">{pageError}</p>
              <Button size="xs" variant="outline" onClick={() => void refresh()}>
                Retry
              </Button>
            </div>
          ) : null}
          {!loading && targets.length === 0 && !pageError ? (
            <p className="mt-4 rounded-lg border border-border p-3 text-xs leading-5 text-muted-foreground">
              Create a chat in a project first. Then choose it here as the context for a scheduled
              task.
            </p>
          ) : null}
          {legacyTasks.length > 0 ? (
            <section
              className="mt-5 rounded-lg border border-border p-3"
              aria-label="Saved local task drafts"
            >
              <p className="text-xs font-medium">
                {legacyTasks.length} saved local draft{legacyTasks.length === 1 ? "" : "s"}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Choose a chat for each draft to enable execution.
              </p>
              <div className="mt-2 divide-y divide-border">
                {legacyTasks.map((task) => (
                  <div key={task.id} className="flex items-center gap-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-xs">{task.title}</span>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={targets.length === 0}
                      onClick={() => importDraft(task)}
                    >
                      Set up
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <label className="mt-6 flex h-9 items-center rounded-lg border border-input bg-background px-3 text-muted-foreground focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
            <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
            <input
              aria-label="Search scheduled tasks"
              className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
              placeholder="Search scheduled tasks"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          <div
            className="mt-5 flex items-center gap-1 border-b border-border pb-3"
            role="group"
            aria-label="Filter tasks by status"
          >
            {FILTER_OPTIONS.map((option) => {
              const isSelected = filter === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={isSelected}
                  className={cn(
                    "inline-flex h-8 items-center gap-2 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    isSelected
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                  onClick={() => setFilter(option.value)}
                >
                  {option.label}
                  <span className="tabular-nums text-muted-foreground">
                    {tasks.filter((task) => taskMatchesFilter(task, option.value)).length}
                  </span>
                </button>
              );
            })}
          </div>

          <section aria-label="Scheduled task list">
            {loading ? (
              <div
                role="status"
                className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground"
              >
                <LoaderCircleIcon className="size-4 animate-spin" /> Loading scheduled tasks…
              </div>
            ) : visibleTasks.length > 0 ? (
              <div className="divide-y divide-border/70">
                {visibleTasks.map((task) => (
                  <article
                    key={task.id}
                    className="group flex items-center gap-3 py-4"
                    data-testid={`scheduled-task-${task.id}`}
                  >
                    <CalendarClockIcon
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <button
                      type="button"
                      className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                      onClick={() => openEditDialog(task)}
                    >
                      <span className="block truncate text-sm font-medium leading-5 text-foreground group-hover:underline underline-offset-4">
                        {task.title}
                      </span>
                      <span className="mt-1 block truncate text-xs leading-5 text-muted-foreground">
                        {targetLabel(task.threadId)} · {task.prompt}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs leading-5 text-muted-foreground">
                        <span>{formatScheduleSummary(task)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{task.timeZone}</span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {task.nextRunAt && task.active
                            ? `Next ${formatRunTime(task.nextRunAt, task.timeZone)}`
                            : task.frequency === "once" && task.runs.length > 0
                              ? "Finished"
                              : "Paused"}
                        </span>
                      </span>
                      {task.runs[0] ? (
                        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                          {runLabel(task.runs[0].status)}
                          {task.runs[0].error ? ` · ${task.runs[0].error}` : ""}
                        </span>
                      ) : null}
                    </button>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Run ${task.title} now`}
                        title="Run now"
                        disabled={
                          busy !== null ||
                          task.runs.some((run) =>
                            ["pending", "running", "needs-attention"].includes(run.status),
                          )
                        }
                        onClick={() => void performTaskAction(task, "run")}
                      >
                        {busy === task.id ? (
                          <LoaderCircleIcon className="size-3.5 animate-spin" />
                        ) : (
                          <PlayIcon className="size-3.5" />
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        aria-label={task.active ? `Pause ${task.title}` : `Resume ${task.title}`}
                        title={task.active ? "Pause task" : "Resume task"}
                        disabled={busy !== null}
                        onClick={() => void performTaskAction(task, "toggle")}
                      >
                        {task.active ? (
                          <PauseIcon className="size-3.5" />
                        ) : (
                          <CalendarClockIcon className="size-3.5" />
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`View run history for ${task.title}`}
                        title="Run history"
                        onClick={() => setHistoryTaskId(task.id)}
                      >
                        <HistoryIcon className="size-3.5" />
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div role="status" className="py-10 text-center">
                <CalendarClockIcon
                  className="mx-auto size-5 text-muted-foreground"
                  aria-hidden="true"
                />
                <h2 className="mt-3 text-sm font-medium">
                  {query.trim()
                    ? "No matching tasks"
                    : filter === "all"
                      ? "Your recurring work starts here"
                      : `No ${filter} tasks`}
                </h2>
                <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                  {query.trim()
                    ? "Try another name or a phrase from the task."
                    : filter === "all"
                      ? "Create a task or start with one of the suggestions below."
                      : `Tasks you ${filter === "active" ? "resume" : "pause"} will appear here.`}
                </p>
                {query.trim() ? (
                  <Button variant="ghost" size="sm" className="mt-3" onClick={() => setQuery("")}>
                    Clear search
                  </Button>
                ) : null}
              </div>
            )}
          </section>

          <section className="mt-6 border-t border-border pt-5" aria-labelledby="suggestions-title">
            <h2 id="suggestions-title" className="text-xs font-medium text-muted-foreground">
              Start with a suggestion
            </h2>
            <div className="mt-3 divide-y divide-border/70">
              {visibleSuggestions.map((suggestion) => {
                const Icon = suggestion.icon;
                return (
                  <button
                    key={suggestion.title}
                    type="button"
                    disabled={loading || targets.length === 0}
                    className="group flex w-full items-start gap-3 rounded-md px-2 py-4 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    onClick={() => openCreateDialog(suggestion.draft)}
                  >
                    <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm font-medium leading-5 text-foreground">
                        {suggestion.title}
                        <span className="text-xs font-normal text-muted-foreground">
                          {formatScheduleSummary(suggestion.draft)}
                        </span>
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                        {suggestion.description}
                      </span>
                    </span>
                    <ChevronRightIcon
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-50 group-hover:opacity-100"
                      aria-hidden="true"
                    />
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!busy) setDialogOpen(open);
        }}
      >
        <DialogPopup className="max-w-md overflow-hidden border-border bg-popover text-popover-foreground">
          <form onSubmit={(event) => void handleTaskSubmit(event)}>
            <DialogHeader className="gap-1.5 border-b border-border bg-popover p-5 pb-3">
              <DialogTitle className="text-lg text-popover-foreground">
                {editingTask ? "Edit scheduled task" : "Create scheduled task"}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Tell Axle what to do and choose when it should run.
              </DialogDescription>
            </DialogHeader>
            <div
              data-slot="dialog-panel"
              className="max-h-[65dvh] space-y-4 overflow-y-auto bg-popover px-5 pb-5 pt-4"
            >
              <div className="grid gap-2">
                <span className="text-xs font-medium">Run in chat</span>
                <Select
                  value={targetThreadId}
                  onValueChange={(value) => {
                    if (typeof value === "string") setTargetThreadId(value);
                  }}
                >
                  <SelectTrigger aria-label="Run in chat" className={SELECT_TRIGGER_CLASS}>
                    <SelectValue placeholder="Choose a chat" />
                  </SelectTrigger>
                  <SelectPopup matchTriggerWidth className="max-h-60">
                    {targets.map((target) => (
                      <SelectItem key={target.threadId} value={target.threadId}>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-xs font-medium">{target.title}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {target.projectTitle}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <p className="text-xs leading-5 text-muted-foreground">
                  Uses this chat’s model, workspace, conversation, and approval settings. Busy chats
                  are skipped.
                </p>
              </div>
              <label className="grid gap-2">
                <span className="text-[13px] font-medium text-foreground">Task name</span>
                <input
                  aria-label="Task name"
                  autoFocus
                  className={FIELD_CLASS}
                  data-testid="schedule-task-name"
                  placeholder="e.g. Daily brief"
                  value={draft.title}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, title: event.target.value }))
                  }
                />
              </label>

              <label className="grid gap-2">
                <span className="text-[13px] font-medium text-foreground">
                  What should Axle do?
                </span>
                <textarea
                  aria-label="Task prompt"
                  className={TEXTAREA_CLASS}
                  data-testid="schedule-task-prompt"
                  placeholder="Review my recent work and send me the important changes."
                  value={draft.prompt}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, prompt: event.target.value }))
                  }
                />
              </label>

              <div className="grid gap-2">
                <span className="text-[13px] font-medium text-foreground">Repeat</span>
                <Select
                  value={draft.frequency}
                  onValueChange={(value) => {
                    if (!value) return;
                    setDraft((current) => ({
                      ...current,
                      frequency: value as ScheduleFrequency,
                    }));
                  }}
                >
                  <SelectTrigger aria-label="Repeat frequency" className={SELECT_TRIGGER_CLASS}>
                    <SelectValue>
                      {FREQUENCY_OPTIONS.find((option) => option.value === draft.frequency)
                        ?.label ?? "Every day"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup
                    className="max-h-56"
                    popupClassName={DROPDOWN_POPUP_CLASS}
                    alignItemWithTrigger={false}
                  >
                    {FREQUENCY_OPTIONS.map((option) => (
                      <SelectItem
                        key={option.value}
                        value={option.value}
                        hideIndicator
                        className="min-h-10 py-1.5"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[13px] font-medium">{option.label}</span>
                          <span className="text-[11px] text-muted-foreground">
                            {option.description}
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>

              {draft.frequency === "hourly" ? (
                <label className="grid gap-2">
                  <span className="text-[13px] font-medium text-foreground">Loop interval</span>
                  <span className="flex items-center gap-2">
                    <input
                      aria-label="Loop interval in hours"
                      className={cn(FIELD_CLASS, "w-24")}
                      min={1}
                      max={24}
                      type="number"
                      value={draft.intervalHours}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          intervalHours: Math.max(1, Number(event.target.value) || 1),
                        }))
                      }
                    />
                    <span className="text-[13px] text-muted-foreground">hour(s)</span>
                  </span>
                </label>
              ) : null}

              {draft.frequency === "daily" ||
              draft.frequency === "weekly" ||
              draft.frequency === "once" ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {draft.frequency === "weekly" ? (
                    <label className="grid gap-2">
                      <span className="text-[13px] font-medium text-foreground">Day</span>
                      <Select
                        value={draft.dayOfWeek}
                        onValueChange={(value) => {
                          if (!value) return;
                          setDraft((current) => ({
                            ...current,
                            dayOfWeek: value as ScheduleDraft["dayOfWeek"],
                          }));
                        }}
                      >
                        <SelectTrigger aria-label="Day of week" className={SELECT_TRIGGER_CLASS}>
                          <SelectValue>
                            {WEEKDAY_OPTIONS.find((option) => option.value === draft.dayOfWeek)
                              ?.label ?? "Mondays"}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup
                          className="max-h-52"
                          popupClassName={DROPDOWN_POPUP_CLASS}
                          alignItemWithTrigger={false}
                        >
                          {WEEKDAY_OPTIONS.map((option) => (
                            <SelectItem
                              key={option.value}
                              value={option.value}
                              hideIndicator
                              className="min-h-7 py-1 text-[13px]"
                            >
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </label>
                  ) : null}
                  {draft.frequency === "once" ? (
                    <label className="grid gap-2">
                      <span className="text-[13px] font-medium text-foreground">Date</span>
                      <input
                        aria-label="Scheduled date"
                        className={FIELD_CLASS}
                        type="date"
                        value={draft.date}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, date: event.target.value }))
                        }
                      />
                    </label>
                  ) : null}
                  <label className="grid gap-2">
                    <span className="text-[13px] font-medium text-foreground">Time</span>
                    <Select
                      value={draft.time}
                      onValueChange={(value) => {
                        if (!value) return;
                        setDraft((current) => ({ ...current, time: value }));
                      }}
                    >
                      <SelectTrigger aria-label="Scheduled time" className={SELECT_TRIGGER_CLASS}>
                        <SelectValue>{formatTimeLabel(draft.time)}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup
                        className="max-h-52"
                        popupClassName={DROPDOWN_POPUP_CLASS}
                        alignItemWithTrigger={false}
                      >
                        {TIME_OPTIONS.map((option) => (
                          <SelectItem
                            key={option.value}
                            value={option.value}
                            hideIndicator
                            className="min-h-7 py-1 text-[13px]"
                          >
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </label>
                </div>
              ) : null}

              <label className="grid gap-2">
                <span className="text-xs font-medium">Time zone</span>
                <input
                  aria-label="Time zone"
                  value={timeZone}
                  onChange={(event) => setTimeZone(event.target.value)}
                  className={FIELD_CLASS}
                  placeholder="Africa/Lagos"
                  required
                />
                <span className="text-xs text-muted-foreground">
                  IANA time zone. Daylight saving changes are applied automatically.
                </span>
              </label>
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-[13px] text-muted-foreground">
                <span className="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  Schedule preview
                </span>
                <span className="mt-1 block text-sm text-foreground">
                  {formatScheduleSummary(draft)}
                </span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  {timeZone} · {getNextRunLabel(draft)}
                </span>
              </div>

              {formError ? (
                <p className="text-sm text-destructive" role="alert">
                  {formError}
                </p>
              ) : null}
            </div>
            <DialogFooter
              variant="bare"
              className="border-t border-border bg-muted/50 px-5 pt-3 pb-4"
            >
              {editingTask ? (
                <button
                  type="button"
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-2 text-[13px] text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
                  disabled={busy !== null}
                  onClick={() => void deleteEditingTask()}
                >
                  <Trash2Icon className="size-4" />
                  Delete
                </button>
              ) : (
                <span />
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  className="inline-flex h-8 items-center justify-center rounded-lg px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  onClick={() => setDialogOpen(false)}
                  disabled={busy !== null}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy !== null || !targetThreadId}
                  className="inline-flex h-8 items-center justify-center rounded-lg bg-foreground px-3 text-[13px] font-medium text-background transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  {busy === "save" ? "Saving…" : editingTask ? "Save changes" : "Schedule task"}
                </button>
              </div>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={historyTaskId !== null}
        onOpenChange={(open) => {
          if (!open) setHistoryTaskId(null);
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{historyTask?.title ?? "Task history"}</DialogTitle>
            <DialogDescription>
              Recent runs and their outcomes. Times use {historyTask?.timeZone ?? timeZone}.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60dvh] overflow-y-auto px-5 py-4">
            {historyTask?.runs.length ? (
              <ol className="divide-y divide-border">
                {historyTask.runs.map((run) => (
                  <li key={run.id} className="py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium">{runLabel(run.status)}</span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {formatRunTime(run.startedAt, historyTask.timeZone)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {run.manual ? "Manual run" : "Scheduled run"}
                      {run.completedAt
                        ? ` · Ended ${formatRunTime(run.completedAt, historyTask.timeZone)}`
                        : ""}
                    </p>
                    {run.error ? <p className="mt-2 text-xs leading-5">{run.error}</p> : null}
                    <Button
                      className="mt-2"
                      size="xs"
                      variant="ghost"
                      onClick={() => openTaskChat(run.threadId)}
                      disabled={!primaryEnvironmentId}
                    >
                      <ExternalLinkIcon className="size-3" /> Open chat
                    </Button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="py-5 text-center text-xs text-muted-foreground">
                No runs yet. Use Run now to try this task.
              </p>
            )}
          </div>
        </DialogPopup>
      </Dialog>
    </SidebarInset>
  );
}
