import express from 'express';

import { listListeningServers } from './dev-preview.service.js';

type DevPreviewRouterOptions = {
  domain: string | null;
  serverPort: number;
};

/** Creates the protected route the app polls to list previewable dev servers. */
export function createDevPreviewRouter({ domain, serverPort }: DevPreviewRouterOptions): express.Router {
  const router = express.Router();

  router.get('/status', async (_request, response, next) => {
    try {
      const servers = domain ? await listListeningServers(serverPort) : [];
      response.json({ enabled: Boolean(domain), domain, servers });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
