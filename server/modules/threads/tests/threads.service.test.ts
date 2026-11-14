import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { agentThreadsDb, closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  createThreadsService,
  formatDelivery,
  readLastReply,
  readSessionContext,
  resolveFolder,
  runFailed,
} from '@/modules/threads/threads.service.js';
import type { AnyRecord, NormalizedMessage } from '@/shared/types.js';

type Turn = { sessionId: string; content: string; options: AnyRecord };

/** Fake app wiring: records turns, and lets a test say which sessions are running and what their last run said. */
function createFakes(maxRunningThreads = 3) {
  const turns: Turn[] = [];
  const running = new Set<string>();
  const events = new Map<string, NormalizedMessage[]>();
  const pending = new Map<string, Array<{ toolName?: string }>>();
  const notified: Array<{ sessionId: string; note: string }> = [];
  const service = createThreadsService({
    runTurn: async (input) => {
      turns.push({ sessionId: input.sessionId, content: input.content, options: input.options });
      return { started: true, error: null };
    },
    isProcessing: (sessionId) => running.has(sessionId),
    hasBackgroundWork: () => false,
    getRunEvents: (sessionId) => events.get(sessionId) ?? [],
    getPendingApprovals: (sessionId) => pending.get(sessionId) ?? [],
    listRunningSessionIds: () => [...running],
    createSession: (projectPath, title) => {
      const sessionId = randomUUID();
      sessionsDb.createAppSession(sessionId, 'claude', projectPath, title);
      return { sessionId };
    },
    getSessionFolder: (sessionId) => sessionsDb.getSessionById(sessionId)?.project_path ?? null,
    notifyWaiting: (input) => notified.push({ sessionId: input.sessionId, note: input.note }),
    maxRunningThreads,
  });
  return { service, turns, running, events, pending, notified };
}

const assistant = (content: string): NormalizedMessage => ({ kind: 'text', role: 'assistant', content } as unknown as NormalizedMessage);
const complete = (exitCode: number, aborted = false): NormalizedMessage => ({ kind: 'complete', exitCode, aborted } as unknown as NormalizedMessage);

/** Lets the fire-and-forget flushes the service starts finish. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function withIsolatedDatabase(runTest: (projectPath: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'threads-db-'));
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

/** A user's ordinary chat in the project, which becomes the coordinator when it starts a thread. */
function createUserChat(projectPath: string): string {
  const sessionId = randomUUID();
  sessionsDb.createAppSession(sessionId, 'claude', projectPath, 'My chat');
  return sessionId;
}

test('pure helpers read replies, failures and folders', async () => {
  assert.equal(readLastReply([assistant('first'), assistant('  last  ')]), 'last');
  assert.equal(readLastReply([]), null);
  assert.equal(runFailed([complete(1)]), true);
  assert.equal(runFailed([complete(1, true)]), false);
  assert.equal(runFailed([complete(0)]), false);
  assert.match(formatDelivery([{ from_label: 'Say "hi"', from_session_id: 's1', body: 'Hello' }]), /<cloudcli-message from="Say 'hi'" session="s1">\nHello\n<\/cloudcli-message>/);
  assert.equal(resolveFolder('', '/'), null);
  assert.equal(resolveFolder('/definitely/not/here', '/'), null);
  assert.equal(resolveFolder('.', tmpdir()), path.resolve(tmpdir()));
  assert.equal(readSessionContext({ sessionId: null, userId: 1, projectPath: '/p', cwd: undefined, runOptions: {} }), null);
  assert.deepEqual(readSessionContext({ sessionId: 's', userId: '7', projectPath: undefined, cwd: '/c', runOptions: {} }), { sessionId: 's', userId: 7, projectPath: '/c', runOptions: {} });
});

test('startThread makes the chat a coordinator and delivers the brief to a new thread', async () => {
  await withIsolatedDatabase(async (projectPath) => {
    const { service, turns } = createFakes();
    const chatId = createUserChat(projectPath);
    const thread = await service.startThread(
      { sessionId: chatId, userId: 1, projectPath, runOptions: { model: 'opus', permissionMode: 'default', unrelated: true } },
      { title: 'Write tests', instructions: 'Add tests for the parser.' },
    );
    await settle();

    assert.equal(service.getRow(chatId)?.role, 'coordinator');
    assert.equal(thread.role, 'thread');
    assert.equal(thread.coordinatorSessionId, chatId);
    assert.equal(sessionsDb.getSessionById(thread.sessionId)?.project_path, projectPath);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].sessionId, thread.sessionId);
    assert.match(turns[0].content, /Add tests for the parser\./);
    assert.match(turns[0].content, /set_status/);
    // Inherits composer options, but only the known keys.
    assert.deepEqual(turns[0].options, { model: 'opus', permissionMode: 'default' });

    const overview = service.overview(projectPath);
    assert.equal(overview.coordinator?.sessionId, chatId);
    assert.deepEqual(overview.threads.map((entry) => entry.sessionId), [thread.sessionId]);
  });
});

test('a thread cannot start threads, and bad input is refused', async () => {
  await withIsolatedDatabase(async (projectPath) => {
    const { service } = createFakes();
    const chatId = createUserChat(projectPath);
    const context = { sessionId: chatId, userId: 1, projectPath, runOptions: {} };
    await assert.rejects(service.startThread(context, { title: ' ', instructions: 'x' }), /title/);
    await assert.rejects(service.startThread(context, { title: 'x', instructions: 'y', folder: '/no/such/folder' }), /does not exist/);
    const thread = await service.startThread(context, { title: 'T', instructions: 'Do it' });
    await assert.rejects(
      service.startThread({ sessionId: thread.sessionId, userId: 1, projectPath, runOptions: {} }, { title: 'Nested', instructions: 'x' }),
      /Only a project chat/,
    );
  });
});

test('messages wait while the target is busy and arrive together when it settles', async () => {
  await withIsolatedDatabase(async (projectPath) => {
    const { service, turns, running } = createFakes();
    const chatId = createUserChat(projectPath);
    const thread = await service.startThread({ sessionId: chatId, userId: 1, projectPath, runOptions: {} }, { title: 'T', instructions: 'Go' });
    await settle();
    turns.length = 0;

    running.add(thread.sessionId);
    service.sendMessage({ toSessionId: thread.sessionId, fromSessionId: chatId, fromLabel: 'Project chat', body: 'one' });
    service.sendMessage({ toSessionId: thread.sessionId, fromSessionId: chatId, fromLabel: 'Project chat', body: 'two' });
    await settle();
    assert.equal(turns.length, 0);
    assert.equal(service.get(thread.sessionId)?.queuedMessages, 2);
    assert.equal(service.get(thread.sessionId)?.status, 'working');

    running.delete(thread.sessionId);
    service.flushAll();
    await settle();
    assert.equal(turns.length, 1);
    assert.match(turns[0].content, /one[\s\S]*two/);
    assert.equal(service.get(thread.sessionId)?.queuedMessages, 0);
    assert.throws(() => service.sendMessage({ toSessionId: chatId, fromSessionId: chatId, fromLabel: 'x', body: 'me' }), /itself/);
  });
});

test('the running-thread cap holds back threads but never the project chat', async () => {
  await withIsolatedDatabase(async (projectPath) => {
    const { service, turns, running } = createFakes(1);
    const chatId = createUserChat(projectPath);
    const context = { sessionId: chatId, userId: 1, projectPath, runOptions: {} };
    const first = await service.startThread(context, { title: 'A', instructions: 'a' });
    running.add(first.sessionId);
    turns.length = 0;
    const second = await service.startThread(context, { title: 'B', instructions: 'b' });
    await settle();
    assert.equal(turns.length, 0);
    assert.equal(service.get(second.sessionId)?.queuedMessages, 1);

    service.sendMessage({ toSessionId: chatId, fromSessionId: first.sessionId, fromLabel: 'Thread "A"', body: 'progress' });
    await settle();
    assert.deepEqual(turns.map((turn) => turn.sessionId), [chatId]);
  });
});

test('a settled thread reports to the project chat once, with its status and reply', async () => {
  await withIsolatedDatabase(async (projectPath) => {
    const { service, turns, events, notified } = createFakes();
    const chatId = createUserChat(projectPath);
    const thread = await service.startThread({ sessionId: chatId, userId: 1, projectPath, runOptions: {} }, { title: 'T', instructions: 'Go' });
    await settle();
    turns.length = 0;

    service.setStatus(thread.sessionId, 'done', 'Parser tests added');
    events.set(thread.sessionId, [assistant('All 12 tests pass.'), complete(0)]);
    service.handleRunSettled(thread.sessionId);
    await settle();

    const summary = service.get(thread.sessionId)!;
    assert.equal(summary.status, 'done');
    assert.equal(summary.lastReply, 'All 12 tests pass.');
    assert.equal(turns.length, 1);
    assert.equal(turns[0].sessionId, chatId);
    assert.match(turns[0].content, /Thread "T" is done\.\nParser tests added/);
    assert.match(turns[0].content, /All 12 tests pass\./);

    // A user turn typed straight into the thread that sets nothing is not relayed.
    service.noteTurnStarted({ sessionId: thread.sessionId, userId: 1, projectPath, runOptions: {} });
    assert.equal(service.get(thread.sessionId)?.status, 'idle');
    turns.length = 0;
    service.handleRunSettled(thread.sessionId);
    await settle();
    assert.equal(turns.length, 0);

    service.setStatus(thread.sessionId, 'waiting', 'Which database?');
    assert.deepEqual(notified, [{ sessionId: thread.sessionId, note: 'Which database?' }]);
  });
});

test('a failed run is marked failed, and a message already sent this turn suppresses the relay', async () => {
  await withIsolatedDatabase(async (projectPath) => {
    const { service, turns, events } = createFakes();
    const chatId = createUserChat(projectPath);
    const thread = await service.startThread({ sessionId: chatId, userId: 1, projectPath, runOptions: {} }, { title: 'T', instructions: 'Go' });
    await settle();

    events.set(thread.sessionId, [complete(1)]);
    turns.length = 0;
    service.handleRunSettled(thread.sessionId);
    await settle();
    assert.equal(service.get(thread.sessionId)?.status, 'failed');
    assert.match(turns[0].content, /failed/);

    service.noteTurnStarted({ sessionId: thread.sessionId, userId: 1, projectPath, runOptions: {} });
    service.sendMessage({ toSessionId: chatId, fromSessionId: thread.sessionId, fromLabel: 'Thread "T"', body: 'Here is my result' });
    service.setStatus(thread.sessionId, 'done', null);
    events.set(thread.sessionId, [complete(0)]);
    await settle();
    turns.length = 0;
    service.handleRunSettled(thread.sessionId);
    await settle();
    assert.equal(turns.length, 0);
  });
});

test('pending approvals show as waiting, and folder grants are per project', async () => {
  await withIsolatedDatabase(async (projectPath) => {
    const { service, running, pending } = createFakes();
    const chatId = createUserChat(projectPath);
    const thread = await service.startThread({ sessionId: chatId, userId: 1, projectPath, runOptions: {} }, { title: 'T', instructions: 'Go' });
    running.add(thread.sessionId);
    pending.set(thread.sessionId, [{ toolName: 'Bash' }]);
    const summary = service.get(thread.sessionId)!;
    assert.equal(summary.status, 'waiting');
    assert.match(summary.statusNote ?? '', /Bash/);

    const extra = path.dirname(projectPath);
    assert.throws(() => service.allowFolder(projectPath, projectPath), /project folder itself/);
    assert.equal(service.allowFolder(projectPath, extra), extra);
    assert.deepEqual(service.listFolders(projectPath), [extra]);
    // A thread uses its project chat's grants.
    assert.equal(service.projectPathFor(thread.sessionId, '/elsewhere'), projectPath);
    assert.equal(service.projectPathFor(null, '/elsewhere'), '/elsewhere');
    assert.equal(service.removeFolder(projectPath, extra), true);
    assert.deepEqual(agentThreadsDb.listFolderGrants(projectPath), []);
  });
});

test('createProjectChat makes a fresh coordinator that the overview shows', async () => {
  await withIsolatedDatabase(async (projectPath) => {
    const { service } = createFakes();
    const chat = service.createProjectChat({ projectPath, userId: 1 });
    assert.equal(chat.role, 'coordinator');
    assert.equal(chat.title, 'Project chat');
    assert.equal(service.overview(projectPath).coordinator?.sessionId, chat.sessionId);
    assert.equal(service.rename(chat.sessionId, '  Launch plan ').title, 'Launch plan');
  });
});
