import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { AgentThreadRow } from '@/modules/database/index.js';
import { ThreadsError } from '@/modules/threads/threads.service.js';
import type { ThreadsService } from '@/modules/threads/threads.service.js';
import type { AgentThreadSummary, AnyRecord, ThreadSessionContext } from '@/shared/types.js';

/** The MCP server name; Claude sees the tools as `mcp__cloudcli__<tool>`. */
const SERVER_NAME = 'cloudcli';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });

/** Runs a tool body, turning a ThreadsError (or any failure) into an error result Claude can read. */
async function guarded(run: () => string | Promise<string>): Promise<ToolResult> {
  try {
    return ok(await run());
  } catch (error) {
    const message = error instanceof ThreadsError || error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

const describeThread = (thread: AgentThreadSummary): AnyRecord => ({
  thread_id: thread.sessionId,
  role: thread.role,
  title: thread.title,
  status: thread.status,
  note: thread.statusNote,
  folder: thread.folder,
  queued_messages: thread.queuedMessages,
  updated_at: thread.updatedAt,
});

const COORDINATOR_INSTRUCTIONS = [
  'CloudCLI project chat tools.',
  'This chat can act as the project chat: it starts threads, which are parallel Claude sessions that each do one piece of work.',
  'Use start_thread for independent pieces of work that can run at the same time (for example separate features, research, or checks in different folders). Do small or tightly coupled work yourself.',
  'Give each thread complete, self-contained instructions: it does not see this conversation.',
  'Thread reports arrive in this chat by themselves as <cloudcli-message> turns when a thread finishes, fails or needs the user. Do not poll with list_threads or read_thread in a loop, and do not wait or sleep for them; end your turn and you will be woken.',
  'Only a few threads run at once; extra ones wait their turn automatically.',
  'Use allow_folder only when the user wants this project to reach a folder outside it; the user approves each grant.',
].join('\n');

const THREAD_INSTRUCTIONS = [
  'CloudCLI thread tools. You are a thread started by a project chat (the coordinator).',
  'Call set_status with "done" and a summary when your task is finished, or "waiting" when you need the user.',
  'Use message_coordinator to tell the project chat something before you finish; use message_thread only when a sibling thread really needs to know.',
  'Messages from others arrive by themselves as <cloudcli-message> turns. Do not poll for them.',
].join('\n');

/**
 * Builds the in-process `cloudcli` MCP server for one turn of one session.
 * Used by the threads module's index (the runtime extras contributor).
 * Returns the server plus the tool names that run without a prompt:
 * every tool except `allow_folder`, which the user approves each time.
 */
export function buildThreadsToolServer(service: ThreadsService, context: ThreadSessionContext, row: AgentThreadRow | null): { server: unknown; allowedTools: string[] } {
  const isThread = row?.role === 'thread';
  const selfLabel = (): string => {
    const current = service.getRow(context.sessionId);
    if (!current) return 'Project chat';
    return current.role === 'thread' ? `Thread "${current.title}"` : current.title;
  };

  /** A target this session may talk to or read: one of the threads it can see. */
  const requireVisible = (threadId: string): AgentThreadSummary => {
    const target = service.listVisibleTo(context.sessionId).find((thread) => thread.sessionId === threadId);
    if (!target) throw new ThreadsError(`No thread with id ${threadId} is visible to this chat. Use list_threads to see the ids.`);
    return target;
  };

  const listThreads = tool('list_threads', 'Lists the threads of this project chat with their status (working, waiting, idle, done, failed).', {}, () =>
    guarded(() => {
      const threads = service.listVisibleTo(context.sessionId);
      if (threads.length === 0) return 'There are no threads yet.';
      return JSON.stringify(threads.map(describeThread), null, 2);
    }));

  const messageThread = tool(
    'message_thread',
    isThread
      ? 'Sends a message to a sibling thread (or the project chat). It is delivered as soon as that session is free.'
      : 'Sends a message to one of your threads, for example an answer or more work. It is delivered as soon as that thread is free.',
    { thread_id: z.string().describe('The thread id from list_threads.'), text: z.string().describe('The message.') },
    (args) =>
      guarded(() => {
        const target = requireVisible(args.thread_id);
        service.sendMessage({ toSessionId: target.sessionId, fromSessionId: context.sessionId, fromLabel: selfLabel(), body: args.text });
        return `Message queued for "${target.title}" (${target.status}). It is delivered when that session is free.`;
      }),
  );

  const allowFolder = tool(
    'allow_folder',
    'Lets this project (its project chat and threads) use a folder outside the project, such as ~/projects. The user approves each grant. It applies from the next turn.',
    { path: z.string().describe('Absolute path, or one starting with ~/.') },
    (args) =>
      guarded(() => {
        const projectPath = service.projectPathFor(context.sessionId, context.projectPath);
        if (!projectPath) throw new ThreadsError('This chat has no project folder.');
        const folder = service.allowFolder(projectPath, args.path);
        return `Allowed ${folder} for this project. It is available from the next turn of each chat.`;
      }),
  );

  const listFolders = tool('list_folders', 'Lists the folders outside the project that this project may use.', {}, () =>
    guarded(() => {
      const projectPath = service.projectPathFor(context.sessionId, context.projectPath);
      const folders = projectPath ? service.listFolders(projectPath) : [];
      return folders.length > 0 ? folders.join('\n') : 'No extra folders are allowed. The project folder itself always is.';
    }));

  const tools = isThread
    ? [
      tool('message_coordinator', 'Sends a message to the project chat that started this thread.', { text: z.string().describe('The message.') }, (args) =>
        guarded(() => {
          const current = service.getRow(context.sessionId);
          if (!current?.coordinator_session_id) throw new ThreadsError('This thread has no project chat.');
          service.sendMessage({ toSessionId: current.coordinator_session_id, fromSessionId: context.sessionId, fromLabel: selfLabel(), body: args.text });
          return 'Message queued for the project chat.';
        })),
      messageThread,
      listThreads,
      tool(
        'set_status',
        'Records where this thread stands: "done" when the task is finished, "waiting" when you need the user. The project chat is told when your turn ends.',
        { status: z.enum(['waiting', 'done']), note: z.string().describe('One line: what you finished, or exactly what you need.') },
        (args) =>
          guarded(() => {
            service.setStatus(context.sessionId, args.status, args.note);
            return `Status set to ${args.status}.`;
          }),
      ),
      allowFolder,
      listFolders,
    ]
    : [
      tool(
        'start_thread',
        'Starts a thread: a new, parallel Claude session that works on one task and reports back here when it is done or needs the user.',
        {
          title: z.string().describe('A short name for the thread, shown on its card.'),
          instructions: z.string().describe('Complete, self-contained instructions. The thread does not see this conversation.'),
          folder: z.string().optional().describe('The folder it works in. Defaults to the project folder.'),
        },
        (args) =>
          guarded(async () => {
            const thread = await service.startThread(context, args);
            return `Started thread "${thread.title}" (thread_id ${thread.sessionId}) in ${thread.folder}. Its report arrives here by itself; do not poll for it.`;
          }),
      ),
      listThreads,
      tool('read_thread', 'Shows one thread\'s status and its last reply.', { thread_id: z.string() }, (args) =>
        guarded(() => {
          const target = requireVisible(args.thread_id);
          return JSON.stringify({ ...describeThread(target), last_reply: target.lastReply }, null, 2);
        })),
      messageThread,
      tool('close_thread', 'Marks a thread done, for example when its work is no longer needed.', { thread_id: z.string() }, (args) =>
        guarded(() => {
          const target = requireVisible(args.thread_id);
          if (target.role !== 'thread') throw new ThreadsError('Only threads can be closed.');
          service.setStatus(target.sessionId, 'done', 'Closed by the project chat.');
          return `Closed "${target.title}".`;
        })),
      allowFolder,
      listFolders,
    ];

  const server = createSdkMcpServer({
    name: SERVER_NAME,
    version: '1.0.0',
    instructions: isThread ? THREAD_INSTRUCTIONS : COORDINATOR_INSTRUCTIONS,
    tools,
  });

  const allowedTools = tools.filter((entry) => entry.name !== 'allow_folder').map((entry) => `mcp__${SERVER_NAME}__${entry.name}`);
  return { server, allowedTools };
}
