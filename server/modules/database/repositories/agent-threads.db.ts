import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

export type AgentThreadRole = 'coordinator' | 'thread';

/** What a row records; whether the session is working right now is never stored. */
export type AgentThreadStoredStatus = 'idle' | 'waiting' | 'done' | 'failed';

export type AgentThreadRow = {
  session_id: string;
  role: AgentThreadRole;
  user_id: number | null;
  project_path: string;
  coordinator_session_id: string | null;
  title: string;
  status: AgentThreadStoredStatus;
  status_note: string | null;
  last_reply: string | null;
  run_options: string;
  created_at: string;
  updated_at: string;
};

export type AgentThreadMessageRow = {
  id: string;
  to_session_id: string;
  from_session_id: string | null;
  from_label: string;
  body: string;
  created_at: string;
  delivered_at: string | null;
};

const THREAD_COLUMNS =
  'session_id, role, user_id, project_path, coordinator_session_id, title, status, status_note, last_reply, run_options, created_at, updated_at';
const MESSAGE_COLUMNS = 'id, to_session_id, from_session_id, from_label, body, created_at, delivered_at';

/** Used by the threads module to keep project chats, their threads and the messages between them. */
export const agentThreadsDb = {
  upsert(input: {
    sessionId: string;
    role: AgentThreadRole;
    userId: number | null;
    projectPath: string;
    coordinatorSessionId: string | null;
    title: string;
    runOptions: unknown;
  }): AgentThreadRow {
    const db = getConnection();
    db.prepare(
      `INSERT INTO agent_threads (session_id, role, user_id, project_path, coordinator_session_id, title, run_options)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         user_id = COALESCE(excluded.user_id, agent_threads.user_id),
         run_options = excluded.run_options,
         updated_at = CURRENT_TIMESTAMP`
    ).run(
      input.sessionId,
      input.role,
      input.userId,
      input.projectPath,
      input.coordinatorSessionId,
      input.title,
      JSON.stringify(input.runOptions ?? {}),
    );
    return this.get(input.sessionId)!;
  },

  get(sessionId: string): AgentThreadRow | null {
    const row = getConnection()
      .prepare(`SELECT ${THREAD_COLUMNS} FROM agent_threads WHERE session_id = ?`)
      .get(sessionId) as AgentThreadRow | undefined;
    return row ?? null;
  },

  /** Every coordinator and thread of a project, oldest first, skipping archived sessions. */
  listForProject(projectPath: string): AgentThreadRow[] {
    return getConnection()
      .prepare(
        `SELECT ${THREAD_COLUMNS.split(', ').map((column) => `t.${column}`).join(', ')}
         FROM agent_threads t
         JOIN sessions s ON s.session_id = t.session_id
         WHERE t.project_path = ? AND COALESCE(s.isArchived, 0) = 0
         ORDER BY t.created_at ASC, t.rowid ASC`
      )
      .all(projectPath) as AgentThreadRow[];
  },

  listThreadsOf(coordinatorSessionId: string): AgentThreadRow[] {
    return getConnection()
      .prepare(
        `SELECT ${THREAD_COLUMNS} FROM agent_threads
         WHERE coordinator_session_id = ? ORDER BY created_at ASC, rowid ASC`
      )
      .all(coordinatorSessionId) as AgentThreadRow[];
  },

  setStatus(sessionId: string, status: AgentThreadStoredStatus, note: string | null): void {
    getConnection()
      .prepare('UPDATE agent_threads SET status = ?, status_note = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?')
      .run(status, note, sessionId);
  },

  setLastReply(sessionId: string, reply: string | null): void {
    getConnection()
      .prepare('UPDATE agent_threads SET last_reply = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?')
      .run(reply, sessionId);
  },

  setTitle(sessionId: string, title: string): void {
    getConnection()
      .prepare('UPDATE agent_threads SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?')
      .run(title, sessionId);
  },

  addMessage(input: { toSessionId: string; fromSessionId: string | null; fromLabel: string; body: string }): AgentThreadMessageRow {
    const db = getConnection();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO agent_thread_messages (id, to_session_id, from_session_id, from_label, body) VALUES (?, ?, ?, ?, ?)`
    ).run(id, input.toSessionId, input.fromSessionId, input.fromLabel, input.body);
    return db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM agent_thread_messages WHERE id = ?`).get(id) as AgentThreadMessageRow;
  },

  listUndelivered(toSessionId?: string): AgentThreadMessageRow[] {
    const db = getConnection();
    if (toSessionId) {
      return db
        .prepare(`SELECT ${MESSAGE_COLUMNS} FROM agent_thread_messages WHERE delivered_at IS NULL AND to_session_id = ? ORDER BY created_at ASC, rowid ASC`)
        .all(toSessionId) as AgentThreadMessageRow[];
    }
    return db
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM agent_thread_messages WHERE delivered_at IS NULL ORDER BY created_at ASC, rowid ASC`)
      .all() as AgentThreadMessageRow[];
  },

  /** Marks messages delivered; returns how many were still undelivered (a racing flush gets 0). */
  markDelivered(ids: string[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(', ');
    return getConnection()
      .prepare(`UPDATE agent_thread_messages SET delivered_at = CURRENT_TIMESTAMP WHERE delivered_at IS NULL AND id IN (${placeholders})`)
      .run(...ids).changes;
  },

  /** Puts messages back in the queue after a turn could not start. */
  markUndelivered(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    getConnection()
      .prepare(`UPDATE agent_thread_messages SET delivered_at = NULL WHERE id IN (${placeholders})`)
      .run(...ids);
  },

  /** How many messages a session sent in the last `seconds`, for the runaway-loop guard. */
  countSentInLast(fromSessionId: string, seconds: number): number {
    const row = getConnection()
      .prepare(`SELECT COUNT(*) AS count FROM agent_thread_messages WHERE from_session_id = ? AND created_at >= datetime('now', ?)`)
      .get(fromSessionId, `-${Math.max(0, Math.floor(seconds))} seconds`) as { count: number };
    return row.count;
  },

  listFolderGrants(projectPath: string): string[] {
    return (getConnection()
      .prepare('SELECT folder_path FROM project_folder_grants WHERE project_path = ? ORDER BY created_at ASC, rowid ASC')
      .all(projectPath) as Array<{ folder_path: string }>).map((row) => row.folder_path);
  },

  addFolderGrant(projectPath: string, folderPath: string): void {
    getConnection()
      .prepare('INSERT OR IGNORE INTO project_folder_grants (project_path, folder_path) VALUES (?, ?)')
      .run(projectPath, folderPath);
  },

  removeFolderGrant(projectPath: string, folderPath: string): boolean {
    return getConnection()
      .prepare('DELETE FROM project_folder_grants WHERE project_path = ? AND folder_path = ?')
      .run(projectPath, folderPath).changes > 0;
  },
};
