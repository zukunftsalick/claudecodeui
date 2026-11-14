import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionRuntimeExtrasService } from '@/modules/providers/index.js';
import type { AgentThreadRow } from '@/modules/database/index.js';
import { createThreadsService } from '@/modules/threads/threads.service.js';
import { buildThreadsToolServer } from '@/modules/threads/threads.tools.js';

const noopService = createThreadsService({
  runTurn: async () => ({ started: true, error: null }),
  isProcessing: () => false,
  hasBackgroundWork: () => false,
  getRunEvents: () => [],
  getPendingApprovals: () => [],
  listRunningSessionIds: () => [],
  createSession: () => ({ sessionId: 'new' }),
  getSessionFolder: () => null,
  notifyWaiting: () => undefined,
  maxRunningThreads: 3,
});

const context = { sessionId: 's1', userId: 1, projectPath: '/p', runOptions: {} };

test('chats outside a thread get the coordinator tools; allow_folder always needs approval', () => {
  const { server, allowedTools } = buildThreadsToolServer(noopService, context, null);
  assert.equal((server as { name?: string }).name, 'cloudcli');
  assert.deepEqual(allowedTools.sort(), [
    'mcp__cloudcli__close_thread',
    'mcp__cloudcli__list_folders',
    'mcp__cloudcli__list_threads',
    'mcp__cloudcli__message_thread',
    'mcp__cloudcli__read_thread',
    'mcp__cloudcli__start_thread',
  ]);
});

test('threads get the reporting tools instead', () => {
  const row = { session_id: 's1', role: 'thread' } as AgentThreadRow;
  const { allowedTools } = buildThreadsToolServer(noopService, context, row);
  assert.deepEqual(allowedTools.sort(), [
    'mcp__cloudcli__list_folders',
    'mcp__cloudcli__list_threads',
    'mcp__cloudcli__message_coordinator',
    'mcp__cloudcli__message_thread',
    'mcp__cloudcli__set_status',
  ]);
});

test('the extras service merges contributors and skips one that throws', () => {
  const input = { provider: 'claude' as const, sessionId: 's1', userId: 1, cwd: '/p', projectPath: '/p', runOptions: {} };
  const removeA = sessionRuntimeExtrasService.register(() => ({ mcpServers: { a: 1 }, allowedTools: ['x', 'y'], additionalDirectories: ['/one'] }));
  const removeB = sessionRuntimeExtrasService.register(() => ({ mcpServers: { b: 2 }, allowedTools: ['y'], additionalDirectories: ['/one', '/two'], waitForApprovalIndefinitely: true }));
  const removeC = sessionRuntimeExtrasService.register(() => {
    throw new Error('boom');
  });
  const removeD = sessionRuntimeExtrasService.register(() => null);
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const merged = sessionRuntimeExtrasService.collect(input);
    assert.deepEqual(merged.mcpServers, { a: 1, b: 2 });
    assert.deepEqual(merged.allowedTools, ['x', 'y']);
    assert.deepEqual(merged.additionalDirectories, ['/one', '/two']);
    assert.equal(merged.waitForApprovalIndefinitely, true);
  } finally {
    console.warn = originalWarn;
    removeA();
    removeB();
    removeC();
    removeD();
  }
  assert.deepEqual(sessionRuntimeExtrasService.collect(input), { mcpServers: {}, allowedTools: [], additionalDirectories: [], waitForApprovalIndefinitely: false });
});
