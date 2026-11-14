import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import { ThreadsError } from '@/modules/threads/threads.service.js';
import type { ThreadsService } from '@/modules/threads/threads.service.js';
import { createThreadsRouter } from '@/modules/threads/threads.routes.js';
import { AppError } from '@/shared/utils.js';

/** Starts the router with a stub service; returns a fetch helper and the calls the stub saw. */
async function startRouter(t: { after(fn: () => void): void }, stub: Partial<ThreadsService>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Request & { user?: { id: number } }).user = { id: 7 };
    next();
  });
  app.use('/api/threads', createThreadsRouter(stub as ThreadsService));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof AppError ? error.statusCode : 500;
    res.status(status).json({ success: false, error: { message: error instanceof Error ? error.message : String(error) } });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/threads`;
  return (url: string, init?: { method?: string; body?: unknown }) =>
    fetch(`${base}${url}`, {
      method: init?.method ?? 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
}

test('GET / needs a projectPath and returns the overview', async (t) => {
  const call = await startRouter(t, { overview: (projectPath: string) => ({ projectPath, coordinator: null, threads: [], folders: [], maxRunningThreads: 3 }) });
  assert.equal((await call('/')).status, 400);
  const response = await call('/?projectPath=%2Fp');
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { data: { projectPath: string } }).data.projectPath, '/p');
});

test('POST /project-chat passes the user id', async (t) => {
  let seen: unknown = null;
  const call = await startRouter(t, {
    createProjectChat: (input: { projectPath: string; userId: number | null }) => {
      seen = input;
      return { sessionId: 'c1' } as ReturnType<ThreadsService['createProjectChat']>;
    },
  });
  const response = await call('/project-chat', { method: 'POST', body: { projectPath: '/p' } });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, { projectPath: '/p', userId: 7 });
});

test('PATCH validates status and maps service errors to 400', async (t) => {
  const call = await startRouter(t, {
    get: () => ({ sessionId: 's1' }) as ReturnType<ThreadsService['get']>,
    setStatus: () => {
      throw new ThreadsError('nope');
    },
  });
  assert.equal((await call('/s1', { method: 'PATCH', body: {} })).status, 400);
  assert.equal((await call('/s1', { method: 'PATCH', body: { status: 'working' } })).status, 400);
  const response = await call('/s1', { method: 'PATCH', body: { status: 'done' } });
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /nope/);
});

test('folders can be added and removed', async (t) => {
  const folders = new Set<string>();
  const call = await startRouter(t, {
    allowFolder: (_projectPath: string, folder: string) => {
      folders.add(folder);
      return folder;
    },
    removeFolder: (_projectPath: string, folder: string) => folders.delete(folder),
    listFolders: () => [...folders],
  });
  assert.equal((await call('/folders', { method: 'POST', body: { projectPath: '/p' } })).status, 400);
  const added = await call('/folders', { method: 'POST', body: { projectPath: '/p', folder: '/x' } });
  assert.deepEqual(((await added.json()) as { data: { folders: string[] } }).data.folders, ['/x']);
  const removed = await call('/folders', { method: 'DELETE', body: { projectPath: '/p', folder: '/x' } });
  assert.deepEqual(((await removed.json()) as { data: { removed: boolean; folders: string[] } }).data, { removed: true, folders: [] });
});
