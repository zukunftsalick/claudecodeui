import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import type { createXcodeCloudService } from './xcode-cloud.service.js';

// App Store Connect ids are opaque strings; this keeps them path-safe.
const readId = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new AppError(`Invalid ${label}.`, { code: 'XCODE_CLOUD_BAD_REQUEST', statusCode: 400 });
  }
  return value;
};

const readOptionalId = (value: unknown, label: string): string | undefined => (
  value === undefined || value === null || value === '' ? undefined : readId(value, label)
);

/** Creates the protected Xcode Cloud routes the Builds tab calls; each one delegates to the service. */
export function createXcodeCloudRouter(service: ReturnType<typeof createXcodeCloudService>): express.Router {
  const router = express.Router();

  router.get('/status', asyncHandler(async (_request, response) => {
    response.json({ configured: await service.isConfigured() });
  }));

  router.get('/products', asyncHandler(async (_request, response) => {
    response.json({ products: await service.listProducts() });
  }));

  router.get('/products/:productId/workflows', asyncHandler(async (request, response) => {
    response.json({ workflows: await service.listWorkflows(readId(request.params.productId, 'product id')) });
  }));

  router.get('/products/:productId/build-runs', asyncHandler(async (request, response) => {
    response.json({ buildRuns: await service.listBuildRuns(readId(request.params.productId, 'product id')) });
  }));

  router.get('/build-runs/:buildRunId', asyncHandler(async (request, response) => {
    response.json(await service.getBuildRunDetail(readId(request.params.buildRunId, 'build id')));
  }));

  router.post('/build-runs', asyncHandler(async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const result = await service.startBuild({
      workflowId: readOptionalId(body.workflowId, 'workflow id'),
      sourceRefId: readOptionalId(body.sourceRefId, 'branch id'),
      rebuildOfBuildRunId: readOptionalId(body.rebuildOfBuildRunId, 'build id'),
      clean: body.clean === true,
    });
    response.status(201).json(result);
  }));

  return router;
}
