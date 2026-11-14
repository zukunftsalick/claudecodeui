import type { AgentThreadStatus, AgentThreadSummary } from '@/shared/types';

const EXCERPT_CHARS = 180;

type StatusLook = { label: string; className: string };

const STATUS_LOOKS: Record<AgentThreadStatus, StatusLook> = {
  working: { label: 'Working', className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
  waiting: { label: 'Waiting for you', className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' },
  idle: { label: 'Idle', className: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
  done: { label: 'Done', className: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
  failed: { label: 'Failed', className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
};

/** The chip label and colours for a status. Used by ThreadsPanel; exported for tests. */
export function describeThreadStatus(status: AgentThreadStatus): StatusLook {
  return STATUS_LOOKS[status] ?? STATUS_LOOKS.idle;
}

/** Reads a SQLite `CURRENT_TIMESTAMP` ("YYYY-MM-DD HH:MM:SS", UTC) or an ISO string as epoch ms. Used by ThreadsPanel; exported for tests. */
export function parseServerTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const isoLike = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const parsed = Date.parse(isoLike);
  return Number.isNaN(parsed) ? null : parsed;
}

/** "just now", "5m ago", "3h ago", "4d ago". Used by ThreadsPanel; exported for tests. */
export function formatThreadTimeAgo(value: string | null | undefined, now: number = Date.now()): string {
  const time = parseServerTimestamp(value);
  if (time === null) return '';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The first part of a reply, on one line, for a card. Used by ThreadsPanel; exported for tests. */
export function excerptReply(text: string | null | undefined, maxChars: number = EXCERPT_CHARS): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1).trimEnd()}…` : flat;
}

/** Threads in the order the pane lists them: the ones that need the user first, then running, then the rest by recency. Used by ThreadsPanel; exported for tests. */
export function sortThreadsForPane(threads: AgentThreadSummary[]): AgentThreadSummary[] {
  const rank: Record<AgentThreadStatus, number> = { waiting: 0, failed: 1, working: 2, idle: 3, done: 4 };
  return [...threads].sort((a, b) => {
    const byStatus = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    if (byStatus !== 0) return byStatus;
    return (parseServerTimestamp(b.updatedAt) ?? 0) - (parseServerTimestamp(a.updatedAt) ?? 0);
  });
}
