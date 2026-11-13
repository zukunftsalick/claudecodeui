import assert from 'node:assert/strict';

import { test } from 'vitest';

import { describeStatus, formatDuration, formatTimeAgo } from '@/modules/xcode-cloud/XcodeCloudPanel';

const NOW = Date.parse('2026-11-14T10:00:00Z');

test('formatTimeAgo rounds to the largest sensible unit', () => {
  assert.equal(formatTimeAgo(null, NOW), '');
  assert.equal(formatTimeAgo('2026-11-14T09:59:30Z', NOW), 'just now');
  assert.equal(formatTimeAgo('2026-11-14T09:55:00Z', NOW), '5m ago');
  assert.equal(formatTimeAgo('2026-11-14T07:00:00Z', NOW), '3h ago');
  assert.equal(formatTimeAgo('2026-11-10T10:00:00Z', NOW), '4d ago');
});

test('formatDuration counts to now while a build runs', () => {
  assert.equal(formatDuration('2026-11-14T09:55:48Z', '2026-11-14T10:00:00Z', NOW), '4m 12s');
  assert.equal(formatDuration('2026-11-14T09:59:20Z', null, NOW), '40s');
  assert.equal(formatDuration(null, null, NOW), '');
});

test('describeStatus prefers progress over result', () => {
  assert.equal(describeStatus('RUNNING', null).label, 'Running');
  assert.equal(describeStatus('PENDING', null).label, 'Queued');
  assert.equal(describeStatus('COMPLETE', 'SUCCEEDED').label, 'Succeeded');
  assert.equal(describeStatus('COMPLETE', 'FAILED').label, 'Failed');
});
