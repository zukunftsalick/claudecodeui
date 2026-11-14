import express from 'express';
import type { Request, Response } from 'express';

import type { AgentThreadStoredStatus } from '@/modules/database/index.js';
import { ThreadsError } from '@/modules/threads/threads.service.js';
import type { ThreadsService } from '@/modules/threads/threads.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

const STORED_STATUSES: AgentThreadStoredStatus[] = ['idle', 'waiting', 'done', 'failed'];

const badRequest = (message: string): AppError => new AppError(message, { code: 'INVALID_REQUEST', statusCode: 400 });

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${field} is required.`);
  return value.trim();
}

function readUserId(request: Request): number | null {
  const userId = Number((request as AuthenticatedRequest).user?.id);
  return Number.isInteger(userId) ? userId : null;
}

/** Runs a service call and turns a ThreadsError (a request the caller got wrong) into a 400. */
function call<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof ThreadsError) throw badRequest(error.message);
    throw error;
  }
}

/** Used by the server entrypoint to mount `/api/threads` (the threads pane). */
export function createThreadsRouter(service: ThreadsService): express.Router {
  const router = express.Router();

  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    const projectPath = readRequiredString(req.query.projectPath, 'projectPath');
    res.json(createApiSuccessResponse(service.overview(projectPath)));
  }));

  router.post('/project-chat', asyncHandler(async (req: Request, res: Response) => {
    const projectPath = readRequiredString(req.body?.projectPath, 'projectPath');
    res.json(createApiSuccessResponse(call(() => service.createProjectChat({ projectPath, userId: readUserId(req) }))));
  }));

  router.patch('/:sessionId', asyncHandler(async (req: Request, res: Response) => {
    const sessionId = readRequiredString(req.params.sessionId, 'sessionId');
    const { status, title, note } = (req.body ?? {}) as { status?: unknown; title?: unknown; note?: unknown };
    if (status === undefined && title === undefined) throw badRequest('Send a status or a title.');
    if (status !== undefined && !STORED_STATUSES.includes(status as AgentThreadStoredStatus)) {
      throw badRequest(`status must be one of ${STORED_STATUSES.join(', ')}.`);
    }
    let summary = call(() => service.get(sessionId));
    if (!summary) throw new AppError(`No thread or project chat with id ${sessionId}.`, { code: 'NOT_FOUND', statusCode: 404 });
    if (typeof title === 'string') summary = call(() => service.rename(sessionId, title));
    if (status !== undefined) {
      summary = call(() => service.setStatus(sessionId, status as AgentThreadStoredStatus, typeof note === 'string' ? note : null));
    }
    res.json(createApiSuccessResponse(summary));
  }));

  router.post('/folders', asyncHandler(async (req: Request, res: Response) => {
    const projectPath = readRequiredString(req.body?.projectPath, 'projectPath');
    const folder = readRequiredString(req.body?.folder, 'folder');
    const added = call(() => service.allowFolder(projectPath, folder));
    res.json(createApiSuccessResponse({ folder: added, folders: service.listFolders(projectPath) }));
  }));

  router.delete('/folders', asyncHandler(async (req: Request, res: Response) => {
    const projectPath = readRequiredString(req.body?.projectPath, 'projectPath');
    const folder = readRequiredString(req.body?.folder, 'folder');
    const removed = service.removeFolder(projectPath, folder);
    res.json(createApiSuccessResponse({ removed, folders: service.listFolders(projectPath) }));
  }));

  return router;
}
