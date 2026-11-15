import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

export type ScheduledTaskRunStatus = 'running' | 'succeeded' | 'failed' | 'skipped';
export type ScheduledTaskRunTrigger = 'schedule' | 'manual';

export type ScheduledTaskRow = {
  id: string;
  user_id: number | null;
  name: string;
  prompt: string;
  project_path: string;
  cron_expression: string | null;
  timezone: string;
  run_once_at: string | null;
  enabled: number;
  run_options: string;
  next_run_at: string | null;
  source_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ScheduledTaskRunRow = {
  id: string;
  task_id: string;
  session_id: string | null;
  trigger: ScheduledTaskRunTrigger;
  status: ScheduledTaskRunStatus;
  error: string | null;
  last_reply: string | null;
  started_at: string;
  finished_at: string | null;
};

/** The fields a task is created or edited with; the schedules service validates them first. */
export type ScheduledTaskFields = {
  name: string;
  prompt: string;
  projectPath: string;
  cronExpression: string | null;
  timezone: string;
  runOnceAt: string | null;
  enabled: boolean;
  runOptions: unknown;
  nextRunAt: string | null;
};

const TASK_COLUMNS =
  'id, user_id, name, prompt, project_path, cron_expression, timezone, run_once_at, enabled, run_options, next_run_at, source_id, created_at, updated_at';
const RUN_COLUMNS = 'id, task_id, session_id, trigger, status, error, last_reply, started_at, finished_at';

/** Used by the schedules module to keep scheduled tasks and their run history. */
export const scheduledTasksDb = {
  create(input: ScheduledTaskFields & { userId: number | null; sourceId?: string | null }): ScheduledTaskRow {
    const id = randomUUID();
    getConnection().prepare(
      `INSERT INTO scheduled_tasks (id, user_id, name, prompt, project_path, cron_expression, timezone, run_once_at, enabled, run_options, next_run_at, source_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.userId,
      input.name,
      input.prompt,
      input.projectPath,
      input.cronExpression,
      input.timezone,
      input.runOnceAt,
      input.enabled ? 1 : 0,
      JSON.stringify(input.runOptions ?? {}),
      input.nextRunAt,
      input.sourceId ?? null,
    );
    return this.get(id)!;
  },

  update(id: string, input: ScheduledTaskFields): ScheduledTaskRow | null {
    getConnection().prepare(
      `UPDATE scheduled_tasks SET name = ?, prompt = ?, project_path = ?, cron_expression = ?, timezone = ?, run_once_at = ?,
         enabled = ?, run_options = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(
      input.name,
      input.prompt,
      input.projectPath,
      input.cronExpression,
      input.timezone,
      input.runOnceAt,
      input.enabled ? 1 : 0,
      JSON.stringify(input.runOptions ?? {}),
      input.nextRunAt,
      id,
    );
    return this.get(id);
  },

  get(id: string): ScheduledTaskRow | null {
    const row = getConnection()
      .prepare(`SELECT ${TASK_COLUMNS} FROM scheduled_tasks WHERE id = ?`)
      .get(id) as ScheduledTaskRow | undefined;
    return row ?? null;
  },

  getBySourceId(sourceId: string): ScheduledTaskRow | null {
    const row = getConnection()
      .prepare(`SELECT ${TASK_COLUMNS} FROM scheduled_tasks WHERE source_id = ?`)
      .get(sourceId) as ScheduledTaskRow | undefined;
    return row ?? null;
  },

  /** Every task, by name. The harness has a single user, so this is not filtered by user. */
  list(): ScheduledTaskRow[] {
    return getConnection()
      .prepare(`SELECT ${TASK_COLUMNS} FROM scheduled_tasks ORDER BY name COLLATE NOCASE, created_at`)
      .all() as ScheduledTaskRow[];
  },

  delete(id: string): boolean {
    return getConnection().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id).changes > 0;
  },

  /** Enabled tasks whose next run is at or before `now`. */
  listDue(now: Date): ScheduledTaskRow[] {
    return getConnection()
      .prepare(`SELECT ${TASK_COLUMNS} FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at`)
      .all(now.toISOString()) as ScheduledTaskRow[];
  },

  /**
   * Moves a due task on to its next run, only if nothing else did first.
   * Returns false when another pass already claimed this occurrence.
   */
  claimOccurrence(id: string, expectedNextRunAt: string, nextRunAt: string | null, enabled: boolean): boolean {
    return getConnection().prepare(
      `UPDATE scheduled_tasks SET next_run_at = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND next_run_at = ?`
    ).run(nextRunAt, enabled ? 1 : 0, id, expectedNextRunAt).changes > 0;
  },

  startRun(input: { taskId: string; trigger: ScheduledTaskRunTrigger; status?: ScheduledTaskRunStatus; error?: string | null }): ScheduledTaskRunRow {
    const id = randomUUID();
    const status = input.status ?? 'running';
    getConnection().prepare(
      `INSERT INTO scheduled_task_runs (id, task_id, trigger, status, error, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.taskId,
      input.trigger,
      status,
      input.error ?? null,
      new Date().toISOString(),
      status === 'running' ? null : new Date().toISOString(),
    );
    return this.getRun(id)!;
  },

  setRunSession(id: string, sessionId: string): void {
    getConnection().prepare('UPDATE scheduled_task_runs SET session_id = ? WHERE id = ?').run(sessionId, id);
  },

  finishRun(id: string, input: { status: Exclude<ScheduledTaskRunStatus, 'running'>; error: string | null; lastReply: string | null }): ScheduledTaskRunRow | null {
    getConnection().prepare(
      'UPDATE scheduled_task_runs SET status = ?, error = ?, last_reply = ?, finished_at = ? WHERE id = ?'
    ).run(input.status, input.error, input.lastReply, new Date().toISOString(), id);
    return this.getRun(id);
  },

  /** Runs left marked running by a server that stopped mid-run; they can never finish now. */
  failInterruptedRuns(): number {
    return getConnection().prepare(
      `UPDATE scheduled_task_runs SET status = 'failed', error = 'The server restarted while this was running.', finished_at = ?
       WHERE status = 'running'`
    ).run(new Date().toISOString()).changes;
  },

  getRun(id: string): ScheduledTaskRunRow | null {
    const row = getConnection()
      .prepare(`SELECT ${RUN_COLUMNS} FROM scheduled_task_runs WHERE id = ?`)
      .get(id) as ScheduledTaskRunRow | undefined;
    return row ?? null;
  },

  listRuns(taskId: string, limit = 20): ScheduledTaskRunRow[] {
    return getConnection()
      .prepare(`SELECT ${RUN_COLUMNS} FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?`)
      .all(taskId, limit) as ScheduledTaskRunRow[];
  },

  /** The newest run of each task, for the list's "last run" column. */
  listLatestRuns(): ScheduledTaskRunRow[] {
    return getConnection()
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM scheduled_task_runs r
         WHERE r.started_at = (SELECT MAX(started_at) FROM scheduled_task_runs WHERE task_id = r.task_id)`
      )
      .all() as ScheduledTaskRunRow[];
  },
};
