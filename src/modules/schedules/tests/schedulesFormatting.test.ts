import { describe, expect, it } from 'vitest';

import { formatRelative } from '@/modules/schedules/SchedulesPanel';

describe('formatRelative', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');

  it('says how far ahead or behind a time is', () => {
    expect(formatRelative('2026-11-15T15:00:00Z', now)).toBe('in 3h');
    expect(formatRelative('2026-11-15T11:55:00Z', now)).toBe('5m ago');
    expect(formatRelative('2026-11-22T12:00:00Z', now)).toBe('in 7d');
    expect(formatRelative('2026-11-15T12:00:20Z', now)).toBe('in under a minute');
    expect(formatRelative('2026-11-15T11:59:50Z', now)).toBe('just now');
    expect(formatRelative(null, now)).toBe('');
  });
});
