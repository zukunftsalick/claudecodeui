import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scheduledTasksDb } from '@/modules/database/index.js';
import type { ScheduledTaskRow, ScheduledTaskRunRow, ScheduledTaskRunTrigger } from '@/modules/database/index.js';
import { CronError, assertTimeZone, describeCron, nextCronRun, parseCron } from '@/modules/schedules/cron-schedule.js';
import type { AnyRecord, NormalizedMessage } from '@/shared/types.js';

/** What the service needs from the rest of the app; the module's wiring passes the real ones, tests pass fakes. */
export type SchedulesServiceDependencies = {
  /** Creates the empty chat a run happens in. */
  createSession(projectPath: string, title: string): { sessionId: string };
  /** Starts a turn with nobody watching; resolves when the run settles. */
  runTurn(input: { sessionId: string; userId: number | null; content: string; options: AnyRecord }): Promise<{ started: boolean; error: string | null }>;
  /** The settled run's events, for its last reply and whether it failed. */
  getRunEvents(sessionId: string): NormalizedMessage[];
  /** Tells the owner a run finished. Never throws. */
  notifyRunFinished(input: { task: ScheduledTaskSummary; run: ScheduledTaskRun }): void;
  /** How many tasks may run at once; more wait for the next poll. */
  maxRunning: number;
  now?: () => Date;
};

/** Thrown for a request the caller got wrong; the routes turn it into a 400. */
export class SchedulesError extends Error {}

/** One run, as the Schedules tab shows it. */
export type ScheduledTaskRun = {
  id: string;
  taskId: string;
  sessionId: string | null;
  trigger: ScheduledTaskRunTrigger;
  status: ScheduledTaskRunRow['status'];
  error: string | null;
  lastReply: string | null;
  startedAt: string;
  finishedAt: string | null;
};

/** One task, as the Schedules tab lists it. */
export type ScheduledTaskSummary = {
  id: string;
  name: string;
  prompt: string;
  projectPath: string;
  cronExpression: string | null;
  timezone: string;
  runOnceAt: string | null;
  enabled: boolean;
  runOptions: AnyRecord;
  nextRunAt: string | null;
  sourceId: string | null;
  scheduleLabel: string;
  isRunning: boolean;
  lastRun: ScheduledTaskRun | null;
  createdAt: string;
};

/** What a create or edit request carries, after the routes checked the types. */
export type ScheduledTaskInput = {
  name: string;
  prompt: string;
  projectPath: string;
  cronExpression?: string | null;
  timezone?: string | null;
  runOnceAt?: string | null;
  enabled?: boolean;
  runOptions?: AnyRecord;
};

const MAX_PROMPT_LENGTH = 100_000;
const MAX_REPLY_CHARS = 4_000;
/**
 * An occurrence missed by more than this (the server was off) is skipped
 * rather than run late: a "morning brief" at 3 PM is noise, and after a long
 * outage every task would otherwise fire at once.
 */
const MAX_LATENESS_MS = 6 * 60 * 60 * 1000;
/** Permission modes a run may use; the default lets Claude work without stopping for approvals it can never get. */
const PERMISSION_MODES = new Set(['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan']);
const DEFAULT_PERMISSION_MODE = 'auto';
const RUN_OPTION_KEYS = ['model', 'effort', 'permissionMode'] as const;

const parseJsonObject = (raw: string): AnyRecord => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as AnyRecord : {};
  } catch {
    return {};
  }
};

/** Expands `~` and makes a folder absolute. Exported for tests. */
export function expandFolder(input: string): string {
  const trimmed = input.trim();
  const expanded = trimmed === '~' ? os.homedir() : trimmed.startsWith('~/') ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
  return path.resolve(expanded);
}

/** The text of the last assistant message of a run, or null. Exported for tests. */
export function readLastReply(events: NormalizedMessage[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as NormalizedMessage & { role?: string; content?: unknown };
    if (event.kind === 'text' && event.role === 'assistant' && typeof event.content === 'string' && event.content.trim()) {
      const text = event.content.trim();
      return text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}…` : text;
    }
  }
  return null;
}

/** The error a run ended with, or null if it finished normally. Exported for tests. */
export function readRunError(events: NormalizedMessage[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as NormalizedMessage & { exitCode?: number; aborted?: boolean; error?: unknown; content?: unknown };
    if (event.kind === 'error') {
      return typeof event.content === 'string' && event.content ? event.content : 'The run reported an error.';
    }
    if (event.kind === 'complete') {
      if (event.aborted) return 'The run was stopped.';
      return typeof event.exitCode === 'number' && event.exitCode !== 0 ? `Claude exited with code ${event.exitCode}.` : null;
    }
  }
  return null;
}

/** The note every run starts with, then the task's own prompt. Exported for tests. */
export function buildRunPrompt(task: Pick<ScheduledTaskRow, 'name' | 'prompt' | 'timezone'>, trigger: ScheduledTaskRunTrigger, now: Date): string {
  const when = new Intl.DateTimeFormat('en-GB', {
    timeZone: task.timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(now);
  const how = trigger === 'manual' ? 'started by hand from the Schedules tab' : 'started on its schedule';
  return [
    `[Scheduled task "${task.name}", ${how} on ${when} (${task.timezone}).`,
    'Nobody is watching this chat while it runs, so do not stop to ask questions: make sensible choices and say which ones you made.',
    'Your final message is sent to the owner as this run\'s report, so end with a short summary of the outcome and anything they need to do.]',
    '',
    task.prompt,
  ].join('\n');
}

function toRun(row: ScheduledTaskRunRow): ScheduledTaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id,
    trigger: row.trigger,
    status: row.status,
    error: row.error,
    lastReply: row.last_reply,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

const describeRunOnce = (iso: string, timeZone: string): string => {
  const formatted = new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  return `Once, ${formatted}`;
};

/** Used by the schedules module's wiring and tests; holds the tasks, the runner's passes and runs in flight. */
export function createSchedulesService(dependencies: SchedulesServiceDependencies) {
  const now = dependencies.now ?? (() => new Date());
  /** Task id → run id, for runs in flight. A task never overlaps itself. */
  const runningTasks = new Map<string, string>();

  const summarize = (row: ScheduledTaskRow, lastRun: ScheduledTaskRunRow | null): ScheduledTaskSummary => {
    let scheduleLabel = 'No schedule';
    if (row.cron_expression) scheduleLabel = describeCron(row.cron_expression);
    else if (row.run_once_at) scheduleLabel = describeRunOnce(row.run_once_at, row.timezone);
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      projectPath: row.project_path,
      cronExpression: row.cron_expression,
      timezone: row.timezone,
      runOnceAt: row.run_once_at,
      enabled: row.enabled === 1,
      runOptions: parseJsonObject(row.run_options),
      nextRunAt: row.next_run_at,
      sourceId: row.source_id,
      scheduleLabel,
      isRunning: runningTasks.has(row.id),
      lastRun: lastRun ? toRun(lastRun) : null,
      createdAt: row.created_at,
    };
  };

  const requireTask = (id: string): ScheduledTaskRow => {
    const row = scheduledTasksDb.get(id);
    if (!row) throw new SchedulesError('That scheduled task no longer exists.');
    return row;
  };

  const summaryFor = (row: ScheduledTaskRow): ScheduledTaskSummary => (
    summarize(row, scheduledTasksDb.listRuns(row.id, 1)[0] ?? null)
  );

  /** The next run after `after` for a task's schedule, or null when nothing more is due. */
  const computeNextRun = (
    task: { cronExpression: string | null; timezone: string; runOnceAt: string | null; enabled: boolean },
    after: Date,
  ): string | null => {
    if (!task.enabled) return null;
    if (task.cronExpression) return nextCronRun(parseCron(task.cronExpression), task.timezone, after)?.toISOString() ?? null;
    if (task.runOnceAt) return new Date(task.runOnceAt).getTime() > after.getTime() ? task.runOnceAt : null;
    return null;
  };

  /** Checks and normalizes a create or edit request into stored fields. */
  const validate = (input: ScheduledTaskInput) => {
    const name = input.name.trim().slice(0, 120);
    const prompt = input.prompt.trim();
    if (!name) throw new SchedulesError('A scheduled task needs a name.');
    if (!prompt) throw new SchedulesError('A scheduled task needs a prompt.');
    if (prompt.length > MAX_PROMPT_LENGTH) throw new SchedulesError('That prompt is too long.');

    const projectPath = expandFolder(input.projectPath);
    if (!input.projectPath.trim() || !fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
      throw new SchedulesError(`The folder ${input.projectPath} does not exist on the server.`);
    }

    const timezone = input.timezone?.trim() || 'UTC';
    const cronExpression = input.cronExpression?.trim() || null;
    let runOnceAt: string | null = null;
    try {
      assertTimeZone(timezone);
      if (cronExpression) parseCron(cronExpression);
    } catch (error) {
      if (error instanceof CronError) throw new SchedulesError(error.message);
      throw error;
    }
    if (!cronExpression) {
      if (!input.runOnceAt) throw new SchedulesError('Give either a repeating schedule or a date and time to run once.');
      const once = new Date(input.runOnceAt);
      if (Number.isNaN(once.getTime())) throw new SchedulesError('The run-once time is not a valid date.');
      runOnceAt = once.toISOString();
    }

    const runOptions: AnyRecord = {};
    for (const key of RUN_OPTION_KEYS) {
      const value = input.runOptions?.[key];
      if (typeof value === 'string' && value.trim()) runOptions[key] = value.trim();
    }
    if (!runOptions.permissionMode) runOptions.permissionMode = DEFAULT_PERMISSION_MODE;
    if (!PERMISSION_MODES.has(runOptions.permissionMode as string)) {
      throw new SchedulesError(`Unknown permission mode "${String(runOptions.permissionMode)}".`);
    }

    const enabled = input.enabled ?? true;
    const nextRunAt = computeNextRun({ cronExpression, timezone, runOnceAt, enabled }, now());
    return { name, prompt, projectPath, cronExpression, timezone, runOnceAt, enabled, runOptions, nextRunAt };
  };

  const finish = (runId: string, task: ScheduledTaskRow, status: 'succeeded' | 'failed', error: string | null, lastReply: string | null) => {
    const finished = scheduledTasksDb.finishRun(runId, { status, error, lastReply });
    runningTasks.delete(task.id);
    if (finished) {
      const current = scheduledTasksDb.get(task.id) ?? task;
      dependencies.notifyRunFinished({ task: summarize(current, finished), run: toRun(finished) });
    }
  };

  /** Starts one run and resolves when it settles. Never throws: failures are recorded on the run. */
  const executeRun = async (task: ScheduledTaskRow, trigger: ScheduledTaskRunTrigger, runId: string): Promise<void> => {
    try {
      if (!fs.existsSync(task.project_path)) {
        finish(runId, task, 'failed', `The folder ${task.project_path} no longer exists.`, null);
        return;
      }
      const startedAt = now();
      const stamp = new Intl.DateTimeFormat('en-GB', { timeZone: task.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(startedAt);
      const { sessionId } = dependencies.createSession(task.project_path, `${task.name} · ${stamp}`);
      scheduledTasksDb.setRunSession(runId, sessionId);
      const result = await dependencies.runTurn({
        sessionId,
        userId: task.user_id,
        content: buildRunPrompt(task, trigger, startedAt),
        options: parseJsonObject(task.run_options),
      });
      const events = dependencies.getRunEvents(sessionId);
      const error = !result.started || result.error ? (result.error ?? 'The run did not start.') : readRunError(events);
      finish(runId, task, error ? 'failed' : 'succeeded', error, readLastReply(events));
    } catch (error) {
      finish(runId, task, 'failed', error instanceof Error ? error.message : String(error), null);
    }
  };

  /** Records a run and starts it in the background. Returns the run row, or null if the task is already running. */
  const launch = (task: ScheduledTaskRow, trigger: ScheduledTaskRunTrigger): { run: ScheduledTaskRunRow; done: Promise<void> } | null => {
    if (runningTasks.has(task.id)) return null;
    const run = scheduledTasksDb.startRun({ taskId: task.id, trigger });
    runningTasks.set(task.id, run.id);
    return { run, done: executeRun(task, trigger, run.id) };
  };

  const service = {
    list(): ScheduledTaskSummary[] {
      const latest = new Map(scheduledTasksDb.listLatestRuns().map((run) => [run.task_id, run]));
      return scheduledTasksDb.list().map((row) => summarize(row, latest.get(row.id) ?? null));
    },

    get(id: string): ScheduledTaskSummary {
      return summaryFor(requireTask(id));
    },

    listRuns(id: string): ScheduledTaskRun[] {
      requireTask(id);
      return scheduledTasksDb.listRuns(id, 30).map(toRun);
    },

    create(userId: number | null, input: ScheduledTaskInput & { sourceId?: string | null }): ScheduledTaskSummary {
      const fields = validate(input);
      return summaryFor(scheduledTasksDb.create({ ...fields, userId, sourceId: input.sourceId ?? null }));
    },

    update(id: string, input: ScheduledTaskInput): ScheduledTaskSummary {
      requireTask(id);
      const fields = validate(input);
      return summaryFor(scheduledTasksDb.update(id, fields)!);
    },

    setEnabled(id: string, enabled: boolean): ScheduledTaskSummary {
      const row = requireTask(id);
      return service.update(id, {
        name: row.name,
        prompt: row.prompt,
        projectPath: row.project_path,
        cronExpression: row.cron_expression,
        timezone: row.timezone,
        runOnceAt: row.run_once_at,
        enabled,
        runOptions: parseJsonObject(row.run_options),
      });
    },

    remove(id: string): void {
      if (!scheduledTasksDb.delete(id)) throw new SchedulesError('That scheduled task no longer exists.');
    },

    /** "Run now": starts a run at once, whether or not the task is enabled. */
    runNow(id: string): { run: ScheduledTaskRun; done: Promise<void> } {
      const launched = launch(requireTask(id), 'manual');
      if (!launched) throw new SchedulesError('This task is already running.');
      return { run: toRun(launched.run), done: launched.done };
    },

    /**
     * Imports tasks exported from elsewhere (the claude.ai export file shape:
     * `{ tasks: [{ id, name, prompt, schedule | cron_expression, timezone, run_once_at }] }`).
     * Every imported task starts paused, so nothing runs twice while the
     * original is still switched on. A task already imported is skipped.
     */
    importTasks(userId: number | null, payload: unknown, defaultProjectPath: string): { imported: ScheduledTaskSummary[]; skipped: Array<{ name: string; reason: string }> } {
      const list = Array.isArray(payload)
        ? payload
        : payload && typeof payload === 'object' && Array.isArray((payload as AnyRecord).tasks) ? (payload as AnyRecord).tasks as unknown[] : null;
      if (!list) throw new SchedulesError('Expected a JSON list of tasks, or an object with a "tasks" list.');

      const imported: ScheduledTaskSummary[] = [];
      const skipped: Array<{ name: string; reason: string }> = [];
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const item = entry as AnyRecord;
        const name = typeof item.name === 'string' ? item.name : 'Untitled task';
        const sourceId = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : null;
        if (sourceId && scheduledTasksDb.getBySourceId(sourceId)) {
          skipped.push({ name, reason: 'Already imported.' });
          continue;
        }
        const rawCron = [item.schedule, item.cron_expression, item.cronExpression].find((value) => typeof value === 'string' && value.trim()) as string | undefined;
        // claude.ai stores the zone inside the expression, as "CRON_TZ=Asia/Hong_Kong 47 10 * * 0".
        const tzMatch = rawCron?.match(/^CRON_TZ=(\S+)\s+(.*)$/);
        const cronExpression = tzMatch ? tzMatch[2] : rawCron ?? null;
        const timezone = (typeof item.timezone === 'string' && item.timezone) || tzMatch?.[1] || 'UTC';
        const runOnceAt = [item.run_once_at, item.runOnceAt].find((value) => typeof value === 'string' && value) as string | undefined;
        try {
          imported.push(service.create(userId, {
            name,
            prompt: typeof item.prompt === 'string' ? item.prompt : '',
            projectPath: typeof item.projectPath === 'string' && item.projectPath ? item.projectPath : defaultProjectPath,
            cronExpression,
            timezone,
            runOnceAt: cronExpression ? null : runOnceAt ?? null,
            enabled: false,
            runOptions: {},
            sourceId,
          }));
        } catch (error) {
          skipped.push({ name, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      return { imported, skipped };
    },

    /**
     * One poll of the runner: starts every enabled task that is due, up to the
     * running limit, and moves each on to its next occurrence first so a
     * second pass cannot start it again. Exported for tests through the service.
     */
    dispatchDue(): Array<Promise<void>> {
      const started: Array<Promise<void>> = [];
      const current = now();
      for (const task of scheduledTasksDb.listDue(current)) {
        if (runningTasks.size >= dependencies.maxRunning) break;
        const dueAt = task.next_run_at!;
        const nextRunAt = task.cron_expression
          ? computeNextRun({ cronExpression: task.cron_expression, timezone: task.timezone, runOnceAt: null, enabled: true }, current)
          : null;
        // A fired one-off switches itself off; a recurring task stays on.
        const stillEnabled = Boolean(task.cron_expression);
        if (!scheduledTasksDb.claimOccurrence(task.id, dueAt, nextRunAt, stillEnabled)) continue;

        if (current.getTime() - new Date(dueAt).getTime() > MAX_LATENESS_MS) {
          scheduledTasksDb.startRun({ taskId: task.id, trigger: 'schedule', status: 'skipped', error: `Missed its ${dueAt} run while the server was off.` });
          continue;
        }
        if (runningTasks.has(task.id)) {
          scheduledTasksDb.startRun({ taskId: task.id, trigger: 'schedule', status: 'skipped', error: 'The previous run was still going.' });
          continue;
        }
        const launched = launch(task, 'schedule');
        if (launched) started.push(launched.done);
      }
      return started;
    },

    /** Called once at startup: runs a stopped server left "running" are marked failed. */
    recoverInterruptedRuns(): number {
      return scheduledTasksDb.failInterruptedRuns();
    },
  };

  return service;
}

/** The service's shape, for the routes and the module wiring. */
export type SchedulesService = ReturnType<typeof createSchedulesService>;
