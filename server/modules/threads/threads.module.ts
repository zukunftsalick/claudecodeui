import { sessionsDb } from '@/modules/database/index.js';
import { createNotificationEvent, notifyUserIfEnabled } from '@/modules/notifications/index.js';
import { providerRuntimeService, sessionRuntimeExtrasService, sessionsService } from '@/modules/providers/index.js';
import { createThreadsService, readSessionContext } from '@/modules/threads/threads.service.js';
import type { ThreadsService } from '@/modules/threads/threads.service.js';
import { buildThreadsToolServer } from '@/modules/threads/threads.tools.js';
import { chatRunRegistry, onRunSettled, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { AnyRecord, NormalizedMessage } from '@/shared/types.js';

// The orchestrator is plain JS whose defaults make TS infer `null` fields; the runtimes cast it the same way.
const notificationEvent = createNotificationEvent as (event: AnyRecord) => unknown;

/** Safety net for queued messages no run-settled event will deliver (for example after a restart). */
const FLUSH_INTERVAL_MS = 30_000;

/**
 * How many threads may run at once. Each Claude session is a CLI process of a
 * few hundred MB, and the VPS has 4 GB, so the default is 3.
 */
const readMaxRunningThreads = (): number => {
  const parsed = Number.parseInt(process.env.THREADS_MAX_RUNNING ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
};

/** Used by the threads routes and tests through the module barrel. */
export const threadsService: ThreadsService = createThreadsService({
  runTurn: (input) => runDetachedChatTurn(input, { runtime: providerRuntimeService }),
  isProcessing: (sessionId) => chatRunRegistry.isProcessing(sessionId),
  hasBackgroundWork: (sessionId) => providerRuntimeService.hasBackgroundWork(sessionId),
  getRunEvents: (sessionId) => (chatRunRegistry.getRun(sessionId)?.events ?? []) as NormalizedMessage[],
  getPendingApprovals: (sessionId) => providerRuntimeService.getPendingApprovalsForSession(sessionId) as Array<{ toolName?: string }>,
  listRunningSessionIds: () => chatRunRegistry.listRunningRuns().map((run) => run.sessionId),
  createSession: (projectPath, title) => {
    const { sessionId } = sessionsService.createAppSession('claude', projectPath, title);
    sessionsService.renameSessionById(sessionId, title);
    return { sessionId };
  },
  getSessionFolder: (sessionId) => sessionsDb.getSessionById(sessionId)?.project_path ?? null,
  notifyWaiting: ({ userId, sessionId, title, note }) => {
    notifyUserIfEnabled({
      userId,
      event: notificationEvent({
        provider: 'claude',
        sessionId,
        kind: 'action_required',
        code: 'agent.notification',
        meta: { message: `${title} is waiting for you: ${note}`, sessionName: title },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `threads:waiting:${sessionId}:${note}`,
      }),
    });
  },
  maxRunningThreads: readMaxRunningThreads(),
});

let stopContributor: (() => void) | null = null;
let stopRunSettled: (() => void) | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;

/** Used by the server entrypoint at startup: adds the thread tools and folder grants to Claude turns and starts delivery. */
export function initializeThreads(): void {
  if (stopContributor) return;

  stopContributor = sessionRuntimeExtrasService.register((input) => {
    if (input.provider !== 'claude') return null;
    const context = readSessionContext(input);
    if (!context) return null;
    const row = threadsService.noteTurnStarted(context);
    const { server, allowedTools } = buildThreadsToolServer(threadsService, context, row);
    const projectPath = threadsService.projectPathFor(context.sessionId, context.projectPath);
    return {
      mcpServers: { cloudcli: server },
      allowedTools,
      additionalDirectories: projectPath ? threadsService.listFolders(projectPath) : [],
      waitForApprovalIndefinitely: row?.role === 'thread',
    };
  });

  stopRunSettled = onRunSettled((sessionId) => {
    try {
      threadsService.handleRunSettled(sessionId);
    } catch (error) {
      console.error('[Threads] Handling a settled run failed:', error);
    }
  });

  flushTimer = setInterval(() => threadsService.flushAll(), FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
  // Deliver anything left queued by the last run of the server.
  threadsService.flushAll();
}

/** Used by the server entrypoint at shutdown. */
export function closeThreads(): void {
  stopContributor?.();
  stopRunSettled?.();
  if (flushTimer) clearInterval(flushTimer);
  stopContributor = null;
  stopRunSettled = null;
  flushTimer = null;
}
