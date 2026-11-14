import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  describeThreadStatus,
  excerptReply,
  formatThreadTimeAgo,
  parseServerTimestamp,
  sortThreadsForPane,
} from '@/modules/threads/utils/threadCards';
import type { AgentThreadSummary } from '@/shared/types';

const NOW = Date.parse('2026-11-14T10:00:00Z');

const card = (sessionId: string, status: AgentThreadSummary['status'], updatedAt: string): AgentThreadSummary => ({
  sessionId,
  role: 'thread',
  title: sessionId,
  status,
  statusNote: null,
  lastReply: null,
  folder: '/p',
  coordinatorSessionId: 'c',
  queuedMessages: 0,
  updatedAt,
});

test('parseServerTimestamp reads SQLite timestamps as UTC', () => {
  assert.equal(parseServerTimestamp('2026-11-14 09:00:00'), Date.parse('2026-11-14T09:00:00Z'));
  assert.equal(parseServerTimestamp('2026-11-14T09:00:00Z'), Date.parse('2026-11-14T09:00:00Z'));
  assert.equal(parseServerTimestamp('garbage'), null);
  assert.equal(parseServerTimestamp(null), null);
});

test('formatThreadTimeAgo rounds to a sensible unit', () => {
  assert.equal(formatThreadTimeAgo('2026-11-14 09:59:30', NOW), 'just now');
  assert.equal(formatThreadTimeAgo('2026-11-14 09:55:00', NOW), '5m ago');
  assert.equal(formatThreadTimeAgo('2026-11-14 07:00:00', NOW), '3h ago');
  assert.equal(formatThreadTimeAgo('2026-11-10 10:00:00', NOW), '4d ago');
  assert.equal(formatThreadTimeAgo(null, NOW), '');
});

test('excerptReply flattens and trims', () => {
  assert.equal(excerptReply('a\n\n  b'), 'a b');
  assert.equal(excerptReply('abcdefghij', 5), 'abcd…');
  assert.equal(excerptReply(null), '');
});

test('describeThreadStatus has a label for every status', () => {
  assert.equal(describeThreadStatus('waiting').label, 'Waiting for you');
  assert.equal(describeThreadStatus('working').label, 'Working');
  assert.equal(describeThreadStatus('done').label, 'Done');
  assert.equal(describeThreadStatus('failed').label, 'Failed');
  assert.equal(describeThreadStatus('idle').label, 'Idle');
});

test('sortThreadsForPane puts what needs the user first, then newest', () => {
  const sorted = sortThreadsForPane([
    card('done-old', 'done', '2026-11-14 08:00:00'),
    card('working', 'working', '2026-11-14 09:00:00'),
    card('waiting', 'waiting', '2026-11-14 07:00:00'),
    card('done-new', 'done', '2026-11-14 09:30:00'),
    card('failed', 'failed', '2026-11-14 06:00:00'),
  ]);
  assert.deepEqual(sorted.map((entry) => entry.sessionId), ['waiting', 'failed', 'working', 'done-new', 'done-old']);
});
