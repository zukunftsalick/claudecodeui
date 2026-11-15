import { providerRuntimeService, sessionsService } from '@/modules/providers/index.js';
import { sendNtfyNotification } from '@/modules/schedules/schedules-ntfy.service.js';
import { createSchedulesService } from '@/modules/schedules/schedules.service.js';
import type { SchedulesService } from '@/modules/schedules/schedules.service.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { NormalizedMessage } from '@/shared/types.js';

/** How often due tasks are looked for. Schedules are per minute, so this keeps runs within ~30s of their time. */
const POLL_INTERVAL_MS = 30_000;

/**
 * How many scheduled runs may go at once. Each Claude session is a CLI process
 * of a few hundred MB on a 4 GB VPS, and threads have their own limit.
 */
const readMaxRunning = (): number => {
  const parsed = Number.parseInt(process.env.SCHEDULES_MAX_RUNNING ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
};

/** Used by the schedules routes (through the barrel) and the runner below. */
export const schedulesService: SchedulesService = createSchedulesService({
  createSession: (projectPath, title) => {
    const { sessionId } = sessionsService.createAppSession('claude', projectPath, title);
    sessionsService.renameSessionById(sessionId, title);
    return { sessionId };
  },
  runTurn: (input) => runDetachedChatTurn(input, { runtime: providerRuntimeService }),
  getRunEvents: (sessionId) => (chatRunRegistry.getRun(sessionId)?.events ?? []) as NormalizedMessage[],
  notifyRunFinished: ({ task, run }) => {
    try {
      sendNtfyNotification(task, run);
    } catch (error) {
      console.warn('[Schedules] Notification failed:', error);
    }
  },
  maxRunning: readMaxRunning(),
});

let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Used by the server entrypoint at startup: starts the runner that fires due tasks. */
export function initializeSchedules(): void {
  if (pollTimer) return;
  const recovered = schedulesService.recoverInterruptedRuns();
  if (recovered > 0) console.log(`[Schedules] Marked ${recovered} interrupted run(s) as failed`);

  const poll = () => {
    try {
      schedulesService.dispatchDue();
    } catch (error) {
      console.error('[Schedules] Dispatch pass failed:', error);
    }
  };
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  pollTimer.unref?.();
  poll();
}

/** Used by the server entrypoint at shutdown. */
export function closeSchedules(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
