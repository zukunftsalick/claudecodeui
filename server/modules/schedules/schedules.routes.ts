import express from 'express';
import type { Request, Response } from 'express';

import { SchedulesError } from '@/modules/schedules/schedules.service.js';
import type { ScheduledTaskInput, SchedulesService } from '@/modules/schedules/schedules.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import type { AnyRecord } from '@/shared/types.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

const badRequest = (message: string): AppError => new AppError(message, { code: 'INVALID_REQUEST', statusCode: 400 });

function readUserId(request: Request): number | null {
  const userId = Number((request as AuthenticatedRequest).user?.id);
  return Number.isInteger(userId) ? userId : null;
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${field} is required.`);
  return value;
}

const readOptionalString = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

/** Turns a create or edit body into the service's input; the service does the real checks. */
function readTaskInput(body: unknown): ScheduledTaskInput {
  const raw = (body ?? {}) as AnyRecord;
  return {
    name: readRequiredString(raw.name, 'name'),
    prompt: readRequiredString(raw.prompt, 'prompt'),
    projectPath: readRequiredString(raw.projectPath, 'projectPath'),
    cronExpression: readOptionalString(raw.cronExpression),
    timezone: readOptionalString(raw.timezone),
    runOnceAt: readOptionalString(raw.runOnceAt),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
    runOptions: raw.runOptions && typeof raw.runOptions === 'object' && !Array.isArray(raw.runOptions) ? raw.runOptions as AnyRecord : undefined,
  };
}

/** Runs a service call and turns a SchedulesError (a request the caller got wrong) into a 400. */
function call<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof SchedulesError) throw badRequest(error.message);
    throw error;
  }
}

/** Used by the server entrypoint to mount `/api/schedules` (the Schedules tab). */
export function createSchedulesRouter(service: SchedulesService): express.Router {
  const router = express.Router();

  router.get('/', asyncHandler(async (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse({ tasks: service.list() }));
  }));

  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const input = readTaskInput(req.body);
    res.status(201).json(createApiSuccessResponse(call(() => service.create(readUserId(req), input))));
  }));

  router.post('/import', asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as AnyRecord;
    const projectPath = readRequiredString(body.projectPath, 'projectPath');
    res.json(createApiSuccessResponse(call(() => service.importTasks(readUserId(req), body.data, projectPath))));
  }));

  router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
    const input = readTaskInput(req.body);
    res.json(createApiSuccessResponse(call(() => service.update(readRequiredString(req.params.id, 'id'), input))));
  }));

  router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
    const enabled = (req.body as AnyRecord | undefined)?.enabled;
    if (typeof enabled !== 'boolean') throw badRequest('enabled must be true or false.');
    res.json(createApiSuccessResponse(call(() => service.setEnabled(readRequiredString(req.params.id, 'id'), enabled))));
  }));

  router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
    call(() => service.remove(readRequiredString(req.params.id, 'id')));
    res.json(createApiSuccessResponse({ deleted: true }));
  }));

  router.get('/:id/runs', asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse({ runs: call(() => service.listRuns(readRequiredString(req.params.id, 'id'))) }));
  }));

  router.post('/:id/run', asyncHandler(async (req: Request, res: Response) => {
    // The run goes on in the background; the tab follows it through the list.
    const { run } = call(() => service.runNow(readRequiredString(req.params.id, 'id')));
    res.status(202).json(createApiSuccessResponse({ run }));
  }));

  return router;
}
