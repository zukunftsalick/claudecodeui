import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { agentThreadsDb } from '@/modules/database/index.js';
import type { AgentThreadMessageRow, AgentThreadRow, AgentThreadStoredStatus } from '@/modules/database/index.js';
import type {
  AgentThreadStatus,
  AgentThreadSummary,
  AnyRecord,
  NormalizedMessage,
  ProjectThreadsOverview,
} from '@/shared/types.js';

/** The longest reply kept on a card or relayed to the project chat. */
const MAX_REPLY_CHARS = 4000;
/** A session that sends more than this many messages in an hour is stopped, to break runaway loops. */
const MAX_MESSAGES_PER_HOUR = 60;
const PROJECT_CHAT_TITLE = 'Project chat';
/** Composer options a thread inherits from the chat that started it. */
const INHERITED_RUN_OPTION_KEYS = ['model', 'effort', 'permissionMode', 'toolsSettings'] as const;

/** What the service needs from the rest of the app; the module's index wires the real ones, tests pass fakes. */
type ThreadsServiceDependencies = {
  /** Starts a turn with nobody watching; resolves when the run settles. */
  runTurn(input: { sessionId: string; userId: string | number | null; content: string; options: AnyRecord }): Promise<{ started: boolean; error: string | null }>;
  isProcessing(sessionId: string): boolean;
  hasBackgroundWork(sessionId: string): boolean;
  getRunEvents(sessionId: string): NormalizedMessage[];
  getPendingApprovals(sessionId: string): Array<{ toolName?: string }>;
  listRunningSessionIds(): string[];
  createSession(projectPath: string, title: string): { sessionId: string };
  getSessionFolder(sessionId: string): string | null;
  notifyWaiting(input: { userId: number | null; sessionId: string; title: string; note: string }): void;
  maxRunningThreads: number;
};

type SessionContext = {
  sessionId: string;
  userId: number | null;
  projectPath: string;
  runOptions: AnyRecord;
};

/** Thrown for a request the caller got wrong; the tools return its message to Claude. */
export class ThreadsError extends Error {}

const readUserId = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const pickRunOptions = (options: AnyRecord): AnyRecord => {
  const picked: AnyRecord = {};
  for (const key of INHERITED_RUN_OPTION_KEYS) {
    if (options[key] !== undefined) picked[key] = options[key];
  }
  return picked;
};

const parseJsonObject = (raw: string): AnyRecord => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as AnyRecord : {};
  } catch {
    return {};
  }
};

const trimReply = (text: string): string => (text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}…` : text);

/** Expands `~` and makes a folder absolute; returns null unless it is an existing directory. Exported for tests. */
export function resolveFolder(input: string, baseFolder: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const expanded = trimmed === '~' ? os.homedir() : trimmed.startsWith('~/') ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
  const absolute = path.resolve(baseFolder, expanded);
  try {
    return existsSync(absolute) && statSync(absolute).isDirectory() ? absolute : null;
  } catch {
    return null;
  }
}

/** The text of the last assistant message of a run, or null. Exported for tests. */
export function readLastReply(events: NormalizedMessage[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'text' && event.role === 'assistant' && typeof event.content === 'string' && event.content.trim()) {
      return trimReply(event.content.trim());
    }
  }
  return null;
}

/** Whether a run ended in an error rather than a normal finish or a stop. Exported for tests. */
export function runFailed(events: NormalizedMessage[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as NormalizedMessage & { exitCode?: number; aborted?: boolean };
    if (event.kind === 'complete') {
      return typeof event.exitCode === 'number' && event.exitCode !== 0 && !event.aborted;
    }
  }
  return false;
}

/** Wraps queued messages into the one user turn a session receives them as. Exported for tests. */
export function formatDelivery(messages: Array<Pick<AgentThreadMessageRow, 'from_label' | 'from_session_id' | 'body'>>): string {
  return messages
    .map((message) => {
      const from = message.from_session_id ? ` session="${message.from_session_id}"` : '';
      return `<cloudcli-message from="${message.from_label.replace(/"/g, "'")}"${from}>\n${message.body}\n</cloudcli-message>`;
    })
    .join('\n\n');
}

/** The first message a new thread receives: what it is, how to report, then the task. */
function buildThreadBrief(input: { title: string; coordinatorTitle: string; projectPath: string; folder: string; instructions: string }): string {
  return [
    `You are a thread named "${input.title}", started by the project chat "${input.coordinatorTitle}" for the project at ${input.projectPath}.`,
    `You work in ${input.folder}. Other threads may be working at the same time; stay within your task.`,
    'How to report:',
    '- When the task is finished, call set_status with status "done" and a one-line summary, then end your turn with the full result.',
    '- When you need a decision or something only the user can do, call set_status with status "waiting" and say exactly what you need. The user can open this thread and answer you directly.',
    '- Use message_coordinator for anything the project chat should know or act on before you finish.',
    'Your task:',
    input.instructions,
  ].join('\n');
}

/** Used by the threads module's index (wiring), routes and session tools. */
export function createThreadsService(dependencies: ThreadsServiceDependencies) {
  // Sessions that already told their coordinator something this turn, so the
  // end-of-turn relay does not repeat it.
  const reportedThisTurn = new Set<string>();
  // Sessions whose current turn was started by delivered messages rather than
  // by the user typing in them. A thread reports back at the end of such a turn
  // even when it set no status, so the project chat is never left waiting.
  const deliveredTurns = new Set<string>();

  const liveStatus = (row: AgentThreadRow): { status: AgentThreadStatus; note: string | null } => {
    if (dependencies.isProcessing(row.session_id)) {
      const pending = dependencies.getPendingApprovals(row.session_id);
      if (pending.length > 0) {
        return { status: 'waiting', note: `Needs your OK to use ${pending[0].toolName || 'a tool'}` };
      }
      return { status: 'working', note: row.status_note };
    }
    return { status: row.status, note: row.status_note };
  };

  const summarize = (row: AgentThreadRow): AgentThreadSummary => {
    const { status, note } = liveStatus(row);
    return {
      sessionId: row.session_id,
      role: row.role,
      title: row.title,
      status,
      statusNote: note,
      lastReply: row.last_reply,
      folder: dependencies.getSessionFolder(row.session_id) ?? row.project_path,
      coordinatorSessionId: row.coordinator_session_id,
      queuedMessages: agentThreadsDb.listUndelivered(row.session_id).length,
      updatedAt: row.updated_at,
    };
  };

  const requireRow = (sessionId: string): AgentThreadRow => {
    const row = agentThreadsDb.get(sessionId);
    if (!row) throw new ThreadsError(`No thread or project chat with id ${sessionId}.`);
    return row;
  };

  const runningThreadCount = (): number =>
    dependencies.listRunningSessionIds().filter((id) => agentThreadsDb.get(id)?.role === 'thread').length;

  const service = {
    /** Makes a chat the project chat of its project (idempotent) and returns its row. */
    ensureCoordinator(context: SessionContext): AgentThreadRow {
      const existing = agentThreadsDb.get(context.sessionId);
      if (existing) return existing;
      return agentThreadsDb.upsert({
        sessionId: context.sessionId,
        role: 'coordinator',
        userId: context.userId,
        projectPath: context.projectPath,
        coordinatorSessionId: null,
        title: PROJECT_CHAT_TITLE,
        runOptions: pickRunOptions(context.runOptions),
      });
    },

    /** Creates a new, empty project chat for a project (the pane's "New project chat"). */
    createProjectChat(input: { projectPath: string; userId: number | null }): AgentThreadSummary {
      const { sessionId } = dependencies.createSession(input.projectPath, PROJECT_CHAT_TITLE);
      const row = agentThreadsDb.upsert({
        sessionId,
        role: 'coordinator',
        userId: input.userId,
        projectPath: input.projectPath,
        coordinatorSessionId: null,
        title: PROJECT_CHAT_TITLE,
        runOptions: {},
      });
      return summarize(row);
    },

    /** Called at the start of every turn of a session that takes part, before its tools are built. */
    noteTurnStarted(context: SessionContext): AgentThreadRow | null {
      const row = agentThreadsDb.get(context.sessionId);
      if (!row) return null;
      reportedThisTurn.delete(context.sessionId);
      // The turn's own options become the defaults for later unattended turns.
      const runOptions = pickRunOptions(context.runOptions);
      if (Object.keys(runOptions).length > 0) {
        agentThreadsDb.upsert({
          sessionId: row.session_id,
          role: row.role,
          userId: context.userId ?? row.user_id,
          projectPath: row.project_path,
          coordinatorSessionId: row.coordinator_session_id,
          title: row.title,
          runOptions,
        });
      }
      // A new turn means someone answered or sent more work: it is no longer waiting, done or failed.
      if (row.status !== 'idle') agentThreadsDb.setStatus(row.session_id, 'idle', null);
      return agentThreadsDb.get(context.sessionId);
    },

    async startThread(context: SessionContext, input: { title: string; instructions: string; folder?: string }): Promise<AgentThreadSummary> {
      const title = input.title.trim().slice(0, 80);
      const instructions = input.instructions.trim();
      if (!title) throw new ThreadsError('A thread needs a title.');
      if (!instructions) throw new ThreadsError('A thread needs instructions.');
      const coordinator = service.ensureCoordinator(context);
      if (coordinator.role !== 'coordinator') throw new ThreadsError('Only a project chat can start threads. Use message_coordinator to ask for one.');

      let folder = coordinator.project_path;
      if (input.folder) {
        const resolved = resolveFolder(input.folder, coordinator.project_path);
        if (!resolved) throw new ThreadsError(`The folder ${input.folder} does not exist.`);
        folder = resolved;
      }

      const { sessionId } = dependencies.createSession(folder, title);
      const row = agentThreadsDb.upsert({
        sessionId,
        role: 'thread',
        userId: context.userId ?? coordinator.user_id,
        projectPath: coordinator.project_path,
        coordinatorSessionId: coordinator.session_id,
        title,
        runOptions: { ...parseJsonObject(coordinator.run_options), ...pickRunOptions(context.runOptions) },
      });
      service.sendMessage({
        toSessionId: sessionId,
        fromSessionId: coordinator.session_id,
        fromLabel: coordinator.title,
        body: buildThreadBrief({ title, coordinatorTitle: coordinator.title, projectPath: coordinator.project_path, folder, instructions }),
        // The brief is the thread's own first turn, not a message to count against the sender.
        skipRateLimit: true,
      });
      return summarize(agentThreadsDb.get(row.session_id)!);
    },

    /** Queues a message for a session and delivers it as soon as that session is free. */
    sendMessage(input: { toSessionId: string; fromSessionId: string | null; fromLabel: string; body: string; skipRateLimit?: boolean }): void {
      const body = input.body.trim();
      if (!body) throw new ThreadsError('The message is empty.');
      requireRow(input.toSessionId);
      if (input.fromSessionId && input.fromSessionId === input.toSessionId) throw new ThreadsError('A session cannot message itself.');
      if (input.fromSessionId && !input.skipRateLimit && agentThreadsDb.countSentInLast(input.fromSessionId, 3600) >= MAX_MESSAGES_PER_HOUR) {
        throw new ThreadsError(`Too many messages in the last hour (limit ${MAX_MESSAGES_PER_HOUR}). Stop and tell the user what is going on.`);
      }
      agentThreadsDb.addMessage({ toSessionId: input.toSessionId, fromSessionId: input.fromSessionId, fromLabel: input.fromLabel, body });
      if (input.fromSessionId) {
        const sender = agentThreadsDb.get(input.fromSessionId);
        if (sender?.coordinator_session_id === input.toSessionId) reportedThisTurn.add(input.fromSessionId);
      }
      void service.flush(input.toSessionId);
    },

    /** Delivers a session's queued messages as one turn, if it is free. Resolves when that turn settles. */
    async flush(sessionId: string): Promise<void> {
      const row = agentThreadsDb.get(sessionId);
      if (!row) return;
      if (dependencies.isProcessing(sessionId) || dependencies.hasBackgroundWork(sessionId)) return;
      if (row.role === 'thread' && runningThreadCount() >= dependencies.maxRunningThreads) return;
      const queued = agentThreadsDb.listUndelivered(sessionId);
      if (queued.length === 0) return;
      const ids = queued.map((message) => message.id);
      if (agentThreadsDb.markDelivered(ids) === 0) return;
      deliveredTurns.add(sessionId);
      const result = await dependencies.runTurn({
        sessionId,
        userId: row.user_id,
        content: formatDelivery(queued),
        options: parseJsonObject(row.run_options),
      });
      if (!result.started) {
        deliveredTurns.delete(sessionId);
        agentThreadsDb.markUndelivered(ids);
        if (result.error) console.warn(`[Threads] Could not deliver to ${sessionId}: ${result.error}`);
      }
    },

    /** Retries every session with queued messages (after a run settles, and on a timer). */
    flushAll(): void {
      const sessions = new Set(agentThreadsDb.listUndelivered().map((message) => message.to_session_id));
      // Project chats first: they are never held back by the running-thread limit.
      const ordered = [...sessions].sort((a, b) => Number(agentThreadsDb.get(a)?.role === 'thread') - Number(agentThreadsDb.get(b)?.role === 'thread'));
      for (const sessionId of ordered) void service.flush(sessionId);
    },

    /** Records how a run ended and tells the project chat when one of its threads finished, failed or needs the user. */
    handleRunSettled(sessionId: string): void {
      const row = agentThreadsDb.get(sessionId);
      if (row) {
        const events = dependencies.getRunEvents(sessionId);
        const reply = readLastReply(events);
        if (reply) agentThreadsDb.setLastReply(sessionId, reply);
        let current = agentThreadsDb.get(sessionId)!;
        if (runFailed(events) && current.status !== 'done') {
          agentThreadsDb.setStatus(sessionId, 'failed', 'The last turn ended with an error.');
          current = agentThreadsDb.get(sessionId)!;
        }
        const coordinatorId = current.coordinator_session_id;
        const alreadyReported = reportedThisTurn.delete(sessionId);
        const wasDelivered = deliveredTurns.delete(sessionId);
        const worthReporting = current.status !== 'idle' || wasDelivered;
        if (current.role === 'thread' && coordinatorId && agentThreadsDb.get(coordinatorId) && !alreadyReported && worthReporting) {
          const label = {
            done: 'is done',
            waiting: 'is waiting for the user',
            failed: 'failed',
            idle: 'finished its turn without marking the task done',
          }[current.status];
          const note = current.status_note ? `\n${current.status_note}` : '';
          service.sendMessage({
            toSessionId: coordinatorId,
            fromSessionId: sessionId,
            fromLabel: `Thread "${current.title}"`,
            body: `Thread "${current.title}" ${label}.${note}${reply ? `\n\nIts last reply:\n${reply}` : ''}`,
            skipRateLimit: true,
          });
        }
      }
      service.flushAll();
    },

    setStatus(sessionId: string, status: AgentThreadStoredStatus, note: string | null): AgentThreadSummary {
      const row = requireRow(sessionId);
      agentThreadsDb.setStatus(sessionId, status, note?.trim() ? note.trim().slice(0, 500) : null);
      if (status === 'waiting') {
        dependencies.notifyWaiting({ userId: row.user_id, sessionId, title: row.title, note: note?.trim() || 'It needs you.' });
      }
      return summarize(agentThreadsDb.get(sessionId)!);
    },

    rename(sessionId: string, title: string): AgentThreadSummary {
      requireRow(sessionId);
      const trimmed = title.trim().slice(0, 80);
      if (!trimmed) throw new ThreadsError('A title cannot be empty.');
      agentThreadsDb.setTitle(sessionId, trimmed);
      return summarize(agentThreadsDb.get(sessionId)!);
    },

    get(sessionId: string): AgentThreadSummary | null {
      const row = agentThreadsDb.get(sessionId);
      return row ? summarize(row) : null;
    },

    getRow(sessionId: string): AgentThreadRow | null {
      return agentThreadsDb.get(sessionId);
    },

    /** The threads a session may see: a coordinator's own, or a thread's siblings and its coordinator. */
    listVisibleTo(sessionId: string): AgentThreadSummary[] {
      const row = agentThreadsDb.get(sessionId);
      if (!row) return [];
      const coordinatorId = row.role === 'coordinator' ? row.session_id : row.coordinator_session_id;
      if (!coordinatorId) return [];
      const coordinator = agentThreadsDb.get(coordinatorId);
      return [
        ...(coordinator && row.role === 'thread' ? [summarize(coordinator)] : []),
        ...agentThreadsDb.listThreadsOf(coordinatorId).map(summarize),
      ];
    },

    overview(projectPath: string): ProjectThreadsOverview {
      const rows = agentThreadsDb.listForProject(projectPath);
      const coordinators = rows.filter((row) => row.role === 'coordinator');
      // The pane shows one project chat: the most recently active one.
      const coordinator = [...coordinators].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
      return {
        projectPath,
        coordinator: coordinator ? summarize(coordinator) : null,
        threads: rows.filter((row) => row.role === 'thread').map(summarize).reverse(),
        folders: agentThreadsDb.listFolderGrants(projectPath),
        maxRunningThreads: dependencies.maxRunningThreads,
      };
    },

    listFolders(projectPath: string): string[] {
      return agentThreadsDb.listFolderGrants(projectPath);
    },

    allowFolder(projectPath: string, folder: string): string {
      const resolved = resolveFolder(folder, projectPath);
      if (!resolved) throw new ThreadsError(`The folder ${folder} does not exist.`);
      if (resolved === path.resolve(projectPath)) throw new ThreadsError('That is the project folder itself, which is always allowed.');
      agentThreadsDb.addFolderGrant(projectPath, resolved);
      return resolved;
    },

    removeFolder(projectPath: string, folder: string): boolean {
      return agentThreadsDb.removeFolderGrant(projectPath, folder);
    },

    /** The project a session belongs to for folder grants: a thread uses its project chat's. */
    projectPathFor(sessionId: string | null, fallback: string | undefined): string | null {
      const row = sessionId ? agentThreadsDb.get(sessionId) : null;
      return row?.project_path ?? fallback ?? null;
    },
  };

  return service;
}

export type ThreadsService = ReturnType<typeof createThreadsService>;

/** Turns the session context a tool call needs out of a provider's turn input. Exported for the session tools. */
export function readSessionContext(input: { sessionId: string | null; userId: string | number | null; projectPath: string | undefined; cwd: string | undefined; runOptions: AnyRecord }): SessionContext | null {
  const projectPath = input.projectPath || input.cwd;
  if (!input.sessionId || !projectPath) return null;
  return { sessionId: input.sessionId, userId: readUserId(input.userId), projectPath, runOptions: input.runOptions };
}
