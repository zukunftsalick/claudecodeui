import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, scheduledTasksDb, sessionsDb } from '@/modules/database/index.js';
import { CronError, describeCron, nextCronRun, parseCron } from '@/modules/schedules/cron-schedule.js';
import { buildNtfyRequest, readNtfyConfig } from '@/modules/schedules/schedules-ntfy.service.js';
import { buildRunPrompt, createSchedulesService, readLastReply, readRunError } from '@/modules/schedules/schedules.service.js';
import type { ScheduledTaskRun, ScheduledTaskSummary } from '@/modules/schedules/schedules.service.js';
import type { AnyRecord, NormalizedMessage } from '@/shared/types.js';

const assistant = (content: string): NormalizedMessage => ({ kind: 'text', role: 'assistant', content } as unknown as NormalizedMessage);
const complete = (exitCode: number, aborted = false): NormalizedMessage => ({ kind: 'complete', exitCode, aborted } as unknown as NormalizedMessage);

test('cron: next run in a time zone', () => {
  // Sundays 10:47 Hong Kong = Sundays 02:47 UTC.
  const cron = parseCron('47 10 * * 0');
  const next = nextCronRun(cron, 'Asia/Hong_Kong', new Date('2026-11-15T03:00:00Z'));
  assert.equal(next?.toISOString(), '2026-11-22T02:47:00.000Z');
  // Strictly after: a run exactly at the match moves to the next week.
  assert.equal(nextCronRun(cron, 'Asia/Hong_Kong', new Date('2026-11-22T02:47:00Z'))?.toISOString(), '2026-11-29T02:47:00.000Z');
});

test('cron: steps, ranges, names and either-day matching', () => {
  assert.equal(nextCronRun(parseCron('*/15 * * * *'), 'UTC', new Date('2026-01-01T00:07:00Z'))?.toISOString(), '2026-01-01T00:15:00.000Z');
  assert.equal(nextCronRun(parseCron('0 9 * * MON-FRI'), 'UTC', new Date('2026-11-14T12:00:00Z'))?.toISOString(), '2026-11-16T09:00:00.000Z');
  assert.equal(nextCronRun(parseCron('0 0 1 JAN *'), 'UTC', new Date('2026-03-01T00:00:00Z'))?.toISOString(), '2027-01-01T00:00:00.000Z');
  // Day 1 of the month OR a Friday.
  assert.equal(nextCronRun(parseCron('0 12 1 * 5'), 'UTC', new Date('2026-11-14T00:00:00Z'))?.toISOString(), '2026-11-20T12:00:00.000Z');
  // 7 is Sunday too.
  assert.deepEqual([...parseCron('0 0 * * 7').dayOfWeek.values], [0]);
  // Never matches: stops instead of looping forever.
  assert.equal(nextCronRun(parseCron('0 0 30 2 *'), 'UTC', new Date('2026-01-01T00:00:00Z')), null);
});

test('cron: rejects bad expressions', () => {
  assert.throws(() => parseCron('* * * *'), CronError);
  assert.throws(() => parseCron('60 * * * *'), CronError);
  assert.throws(() => parseCron('a * * * *'), CronError);
  assert.throws(() => parseCron('*/0 * * * *'), CronError);
});

test('cron: plain-words labels', () => {
  assert.equal(describeCron('0 8 * * *'), 'Every day at 08:00');
  assert.equal(describeCron('13 10 * * 1'), 'Mondays at 10:13');
  assert.equal(describeCron('0 9 * * 1-5'), 'Weekdays at 09:00');
  assert.equal(describeCron('*/15 * * * *'), 'Every 15 minutes');
  assert.equal(describeCron('5 4 1,15 * *'), '5 4 1,15 * *');
});

test('reading a run: last reply and error', () => {
  assert.equal(readLastReply([assistant('first'), assistant(' last ')]), 'last');
  assert.equal(readLastReply([]), null);
  assert.equal(readRunError([complete(0)]), null);
  assert.match(readRunError([complete(1)]) ?? '', /code 1/);
  assert.match(readRunError([complete(0, true)]) ?? '', /stopped/);
  const prompt = buildRunPrompt({ name: 'Brief', prompt: 'Do the thing', timezone: 'UTC' }, 'schedule', new Date('2026-11-15T08:00:00Z'));
  assert.match(prompt, /Scheduled task "Brief"/);
  assert.ok(prompt.endsWith('Do the thing'));
});

test('ntfy: off without a URL, includes the report and a link', () => {
  assert.equal(readNtfyConfig({}), null);
  const config = readNtfyConfig({ SCHEDULES_NTFY_URL: 'https://ntfy.sh/topic', SCHEDULES_PUBLIC_URL: 'https://code.example.com/' })!;
  const task = { name: 'Growth watch · ✓' } as ScheduledTaskSummary;
  const run = { status: 'succeeded', lastReply: 'All good', sessionId: 's1', error: null } as ScheduledTaskRun;
  const request = buildNtfyRequest(config, task, run);
  assert.equal(request.body, 'All good');
  assert.equal(request.headers.Click, 'https://code.example.com/session/s1');
  assert.equal(request.headers.Title, 'Done: Growth watch ? ?');
  const quiet = buildNtfyRequest({ ...config, includeReply: false }, task, run);
  assert.equal(quiet.body, 'Finished.');
  const failed = buildNtfyRequest(config, task, { ...run, status: 'failed', error: 'boom' });
  assert.equal(failed.body, 'Failed: boom');
  assert.equal(failed.headers.Priority, 'high');
});

type Turn = { sessionId: string; content: string; options: AnyRecord };

function createFakes(clock: { now: Date }, maxRunning = 2) {
  const turns: Turn[] = [];
  const finished: ScheduledTaskRun[] = [];
  let release: (() => void) | null = null;
  let holdRuns = false;
  const service = createSchedulesService({
    createSession: (projectPath, title) => {
      const sessionId = randomUUID();
      sessionsDb.createAppSession(sessionId, 'claude', projectPath, title);
      return { sessionId };
    },
    runTurn: async (input) => {
      turns.push({ sessionId: input.sessionId, content: input.content, options: input.options });
      if (holdRuns) await new Promise<void>((resolve) => { release = resolve; });
      return { started: true, error: null };
    },
    getRunEvents: () => [assistant('Report: done'), complete(0)],
    notifyRunFinished: ({ run }) => finished.push(run),
    maxRunning,
    now: () => clock.now,
  });
  return {
    service,
    turns,
    finished,
    hold: () => { holdRuns = true; },
    release: () => { holdRuns = false; release?.(); },
  };
}

async function withIsolatedDatabase(runTest: (projectPath: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'schedules-db-'));
  const projectPath = path.join(tempDirectory, 'project');
  await mkdir(projectPath);
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest(projectPath);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('service: create validates, computes the next run and lists it', async () => {
  await withIsolatedDatabase(async (projectPath) => {
    const clock = { now: new Date('2026-11-15T03:00:00Z') };
    const { service } = createFakes(clock);
    const task = service.create(1, { name: 'Weekly', prompt: 'Go', projectPath, cronExpression: '47 10 * * 0', timezone: 'Asia/Hong_Kong' });
    assert.equal(task.nextRunAt, '2026-11-22T02:47:00.000Z');
    assert.equal(task.scheduleLabel, 'Sundays at 10:47');
    assert.equal(task.runOptions.permissionMode, 'auto');
    assert.equal(service.list().length, 1);

    assert.throws(() => service.create(1, { name: 'x', prompt: 'y', projectPath: '/does/not/exist', cronExpression: '* * * * *' }), /does not exist/);
    assert.throws(() => service.create(1, { name: 'x', prompt: 'y', projectPath, cronExpression: 'nope' }), /five fields/);
    assert.throws(() => service.create(1, { name: 'x', prompt: 'y', projectPath, timezone: 'Mars/Base' , cronExpression: '* * * * *' }), /not a time zone/);
    assert.throws(() => service.create(1, { name: 'x', prompt: 'y', projectPath }), /either a repeating schedule/);

    const paused = service.setEnabled(task.id, false);
    assert.equal(paused.enabled, false);
    assert.equal(paused.nextRunAt, null);
  });
});

test('service: due tasks run once, in a new chat, and move on', async () => {
  await withIsolatedDatabase(async (projectPath) => {
    const clock = { now: new Date('2026-11-15T02:00:00Z') };
    const { service, turns, finished } = createFakes(clock);
    const task = service.create(1, { name: 'Hourly', prompt: 'Check', projectPath, cronExpression: '30 * * * *', runOptions: { permissionMode: 'acceptEdits', ignored: 'x' } });
    assert.equal(task.nextRunAt, '2026-11-15T02:30:00.000Z');

    assert.equal(service.dispatchDue().length, 0);
    clock.now = new Date('2026-11-15T02:30:10Z');
    await Promise.all(service.dispatchDue());
    // A second pass in the same minute does nothing.
    assert.equal(service.dispatchDue().length, 0);

    assert.equal(turns.length, 1);
    assert.match(turns[0].content, /Scheduled task "Hourly"/);
    assert.deepEqual(turns[0].options, { permissionMode: 'acceptEdits' });
    assert.equal(finished[0].status, 'succeeded');
    assert.equal(finished[0].lastReply, 'Report: done');

    const after = service.get(task.id);
    assert.equal(after.nextRunAt, '2026-11-15T03:30:00.000Z');
    assert.equal(after.lastRun?.status, 'succeeded');
    assert.equal(sessionsDb.getSessionById(after.lastRun!.sessionId!)?.project_path, projectPath);
  });
});

test('service: one-offs switch off after firing; long-missed runs are skipped', async () => {
  await withIsolatedDatabase(async (projectPath) => {
    const clock = { now: new Date('2026-11-15T00:00:00Z') };
    const { service, turns } = createFakes(clock);
    const once = service.create(1, { name: 'Remind', prompt: 'Remind me', projectPath, runOnceAt: '2026-11-15T01:00:00Z' });
    const daily = service.create(1, { name: 'Daily', prompt: 'Daily', projectPath, cronExpression: '0 2 * * *' });

    // The server was off for a day: the one-off is 23h late, the daily one 22h late.
    clock.now = new Date('2026-11-16T00:00:00Z');
    await Promise.all(service.dispatchDue());
    assert.equal(turns.length, 0);
    assert.equal(service.get(once.id).enabled, false);
    assert.equal(service.get(once.id).lastRun?.status, 'skipped');
    assert.equal(service.get(daily.id).nextRunAt, '2026-11-16T02:00:00.000Z');

    const soon = service.create(1, { name: 'Soon', prompt: 'Now', projectPath, runOnceAt: '2026-11-16T00:01:00Z' });
    clock.now = new Date('2026-11-16T00:01:30Z');
    await Promise.all(service.dispatchDue());
    assert.equal(turns.length, 1);
    assert.equal(service.get(soon.id).enabled, false);
    assert.equal(service.get(soon.id).nextRunAt, null);
  });
});

test('service: run now, no overlap, and recovery after a restart', async () => {
  await withIsolatedDatabase(async (projectPath) => {
    const clock = { now: new Date('2026-11-15T00:00:00Z') };
    const fakes = createFakes(clock);
    const task = fakes.service.create(1, { name: 'Manual', prompt: 'Go', projectPath, cronExpression: '0 0 1 1 *', enabled: false });
    fakes.hold();
    const { done } = fakes.service.runNow(task.id);
    assert.equal(fakes.service.get(task.id).isRunning, true);
    assert.throws(() => fakes.service.runNow(task.id), /already running/);
    fakes.release();
    await done;
    assert.equal(fakes.service.get(task.id).isRunning, false);
    assert.equal(fakes.service.listRuns(task.id)[0].trigger, 'manual');

    scheduledTasksDb.startRun({ taskId: task.id, trigger: 'schedule' });
    assert.equal(fakes.service.recoverInterruptedRuns(), 1);
    assert.equal(fakes.service.listRuns(task.id)[0].status, 'failed');
  });
});

test('service: imports the claude.ai export paused, once', async () => {
  await withIsolatedDatabase(async (projectPath) => {
    const clock = { now: new Date('2026-11-15T00:00:00Z') };
    const { service } = createFakes(clock);
    const data = {
      tasks: [
        { id: 'trig_a', name: 'Weekly', schedule: '47 10 * * 0', timezone: 'Asia/Hong_Kong', prompt: 'Weekly prompt' },
        { id: 'trig_b', name: 'Stats', cron_expression: 'CRON_TZ=Asia/Hong_Kong 13 10 * * 1', prompt: 'Stats prompt' },
        { id: 'trig_c', name: 'Remind', run_once_at: '2026-12-13T02:00:00Z', prompt: 'Remind prompt' },
        { id: 'trig_d', name: 'Broken', schedule: 'bad', prompt: 'x' },
      ],
    };
    const first = service.importTasks(1, data, projectPath);
    assert.equal(first.imported.length, 3);
    assert.deepEqual(first.skipped.map((entry) => entry.name), ['Broken']);
    assert.ok(first.imported.every((task) => !task.enabled && task.nextRunAt === null));
    assert.equal(first.imported[1].timezone, 'Asia/Hong_Kong');
    assert.equal(first.imported[1].cronExpression, '13 10 * * 1');

    const second = service.importTasks(1, data, projectPath);
    assert.equal(second.imported.length, 0);
    assert.equal(second.skipped.filter((entry) => entry.reason === 'Already imported.').length, 3);

    // Switching one on gives it a next run.
    assert.equal(service.setEnabled(first.imported[2].id, true).nextRunAt, '2026-12-13T02:00:00.000Z');
  });
});
