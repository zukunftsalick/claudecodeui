import { createPrivateKey, sign as signData } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppError } from '@/shared/utils.js';

/** App Store Connect API key settings, from the environment or ~/.appstoreconnect/config.env. */
export type AscConfig = {
  keyId: string;
  issuerId: string;
  privateKey: string;
};

type JsonApiResource = {
  type: string;
  id: string;
  attributes?: Record<string, any>;
  relationships?: Record<string, { data?: { type: string; id: string } | Array<{ type: string; id: string }> | null }>;
};

type JsonApiDocument = {
  data: JsonApiResource | JsonApiResource[];
  included?: JsonApiResource[];
};

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

type XcodeCloudServiceDependencies = {
  // Reads the key settings; null when no key is set up.
  loadConfig: () => Promise<AscConfig | null>;
  fetch: FetchLike;
  baseUrl: string;
  now: () => number;
};

const DEFAULT_BASE_URL = 'https://api.appstoreconnect.apple.com';
// Apple rejects tokens that live longer than 20 minutes.
const TOKEN_LIFETIME_SECONDS = 15 * 60;
const TOKEN_REUSE_MARGIN_SECONDS = 60;
const BUILD_RUN_PAGE_SIZE = 30;

const base64Url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

/**
 * Signs an ES256 JWT for App Store Connect. Exported for tests. ES256 needs the
 * raw r||s signature (IEEE P1363), not DER, hence `dsaEncoding`.
 */
export function signAscToken(config: AscConfig, issuedAtSeconds: number, expiresAtSeconds: number): string {
  const header = base64Url(JSON.stringify({ alg: 'ES256', kid: config.keyId, typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    iss: config.issuerId,
    iat: issuedAtSeconds,
    exp: expiresAtSeconds,
    aud: 'appstoreconnect-v1',
  }));
  const signingInput = `${header}.${payload}`;
  const signature = signData('sha256', Buffer.from(signingInput), {
    key: createPrivateKey(config.privateKey),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64Url(signature)}`;
}

// Parses KEY=value lines (the format the VPS setup script writes).
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/**
 * Loads the App Store Connect key: ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH
 * from the environment, falling back to ~/.appstoreconnect/config.env.
 */
async function loadAscConfigFromDisk(): Promise<AscConfig | null> {
  let values: Record<string, string | undefined> = {
    ASC_KEY_ID: process.env.ASC_KEY_ID,
    ASC_ISSUER_ID: process.env.ASC_ISSUER_ID,
    ASC_KEY_PATH: process.env.ASC_KEY_PATH,
  };
  if (!values.ASC_KEY_ID || !values.ASC_ISSUER_ID || !values.ASC_KEY_PATH) {
    try {
      const configPath = path.join(os.homedir(), '.appstoreconnect', 'config.env');
      values = { ...parseEnvFile(await fs.readFile(configPath, 'utf8')), ...Object.fromEntries(Object.entries(values).filter(([, value]) => value)) };
    } catch {
      return null;
    }
  }
  const { ASC_KEY_ID: keyId, ASC_ISSUER_ID: issuerId, ASC_KEY_PATH: keyPath } = values;
  if (!keyId || !issuerId || !keyPath) {
    return null;
  }
  try {
    const privateKey = await fs.readFile(keyPath.replace(/^~(?=\/)/, os.homedir()), 'utf8');
    return { keyId, issuerId, privateKey };
  } catch {
    return null;
  }
}

const asArray = <T>(value: T | T[] | null | undefined): T[] => (Array.isArray(value) ? value : value ? [value] : []);
const relatedId = (resource: JsonApiResource, name: string): string | null => {
  const data = resource.relationships?.[name]?.data;
  return data && !Array.isArray(data) ? data.id : null;
};

const toIssueCounts = (counts: any) => ({
  errors: Number(counts?.errors ?? 0),
  warnings: Number(counts?.warnings ?? 0),
  analyzerWarnings: Number(counts?.analyzerWarnings ?? 0),
  testFailures: Number(counts?.testFailures ?? 0),
});

/**
 * Talks to the App Store Connect API for Xcode Cloud: products, workflows,
 * build runs and their actions, issues, artifacts and TestFlight builds, and
 * starting builds. Used by the xcode-cloud routes; every result is reshaped
 * into small plain objects the panel renders directly.
 */
export function createXcodeCloudService(dependencies: XcodeCloudServiceDependencies) {
  let cachedToken: { value: string; expiresAt: number; keyId: string } | null = null;

  const requireConfig = async (): Promise<AscConfig> => {
    const config = await dependencies.loadConfig();
    if (!config) {
      throw new AppError('No App Store Connect API key is set up on this server.', {
        code: 'XCODE_CLOUD_NOT_CONFIGURED',
        statusCode: 409,
      });
    }
    return config;
  };

  const getToken = (config: AscConfig): string => {
    const nowSeconds = Math.floor(dependencies.now() / 1000);
    if (cachedToken && cachedToken.keyId === config.keyId && cachedToken.expiresAt - TOKEN_REUSE_MARGIN_SECONDS > nowSeconds) {
      return cachedToken.value;
    }
    const expiresAt = nowSeconds + TOKEN_LIFETIME_SECONDS;
    let value: string;
    try {
      value = signAscToken(config, nowSeconds, expiresAt);
    } catch (error) {
      throw new AppError('The App Store Connect key file could not be used to sign a request.', {
        code: 'XCODE_CLOUD_BAD_KEY',
        statusCode: 500,
        details: error instanceof Error ? error.message : String(error),
      });
    }
    cachedToken = { value, expiresAt, keyId: config.keyId };
    return value;
  };

  const request = async (method: 'GET' | 'POST', apiPath: string, body?: unknown): Promise<JsonApiDocument> => {
    const config = await requireConfig();
    const response = await dependencies.fetch(`${dependencies.baseUrl}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${getToken(config)}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      let detail = '';
      try {
        const payload = await response.json() as { errors?: Array<{ title?: string; detail?: string }> };
        detail = (payload.errors ?? []).map((error) => error.detail || error.title).filter(Boolean).join(' ');
      } catch {
        // Body wasn't JSON; the status says enough.
      }
      const statusCode = response.status === 401 || response.status === 403 ? 502 : response.status >= 500 ? 502 : response.status;
      throw new AppError(
        response.status === 401
          ? 'Apple rejected the App Store Connect key. Check the Key ID, Issuer ID and key file.'
          : response.status === 403
            ? `This App Store Connect key isn't allowed to do that. ${detail}`.trim()
            : `App Store Connect returned ${response.status}. ${detail}`.trim(),
        { code: 'XCODE_CLOUD_API_ERROR', statusCode, details: { appleStatus: response.status } },
      );
    }
    return await response.json() as JsonApiDocument;
  };

  const isConfigured = async (): Promise<boolean> => Boolean(await dependencies.loadConfig());

  const listProducts = async () => {
    const document = await request('GET', '/v1/ciProducts?include=app&limit=50');
    const apps = new Map(asArray(document.included).filter((item) => item.type === 'apps').map((app) => [app.id, app]));
    return asArray(document.data).map((product) => {
      const appId = relatedId(product, 'app');
      const app = appId ? apps.get(appId) : undefined;
      return {
        id: product.id,
        name: String(product.attributes?.name ?? app?.attributes?.name ?? 'Untitled'),
        productType: String(product.attributes?.productType ?? 'APP'),
        appId,
        bundleId: app?.attributes?.bundleId ? String(app.attributes.bundleId) : null,
      };
    });
  };

  const listWorkflows = async (productId: string) => {
    const document = await request('GET', `/v1/ciProducts/${encodeURIComponent(productId)}/workflows?limit=50`);
    return asArray(document.data).map((workflow) => ({
      id: workflow.id,
      name: String(workflow.attributes?.name ?? 'Workflow'),
      description: workflow.attributes?.description ? String(workflow.attributes.description) : null,
      isEnabled: workflow.attributes?.isEnabled !== false,
    }));
  };

  const listBuildRuns = async (productId: string) => {
    const base = `/v1/ciProducts/${encodeURIComponent(productId)}/buildRuns?limit=${BUILD_RUN_PAGE_SIZE}`;
    let document: JsonApiDocument;
    try {
      document = await request('GET', `${base}&include=workflow,sourceBranchOrTag&sort=-number`);
    } catch (error) {
      // Older API versions refuse sort/include on this relationship; the bare list still works.
      if (error instanceof AppError && error.statusCode === 400) {
        document = await request('GET', base);
      } else {
        throw error;
      }
    }
    const included = new Map(asArray(document.included).map((item) => [`${item.type}:${item.id}`, item]));
    return asArray(document.data)
      .map((run) => {
        const attributes = run.attributes ?? {};
        const workflowId = relatedId(run, 'workflow');
        const refId = relatedId(run, 'sourceBranchOrTag');
        const workflow = workflowId ? included.get(`ciWorkflows:${workflowId}`) : undefined;
        const ref = refId ? included.get(`scmGitReferences:${refId}`) : undefined;
        const commit = attributes.sourceCommit ?? null;
        return {
          id: run.id,
          number: Number(attributes.number ?? 0),
          workflowId,
          workflowName: workflow?.attributes?.name ? String(workflow.attributes.name) : null,
          sourceRefId: refId,
          branch: ref?.attributes?.name ? String(ref.attributes.name) : null,
          commitSha: commit?.commitSha ? String(commit.commitSha) : null,
          commitMessage: commit?.message ? String(commit.message).split('\n')[0] : null,
          commitAuthor: commit?.author?.displayName ? String(commit.author.displayName) : null,
          isPullRequestBuild: Boolean(attributes.isPullRequestBuild),
          executionProgress: String(attributes.executionProgress ?? 'PENDING'),
          completionStatus: attributes.completionStatus ? String(attributes.completionStatus) : null,
          startReason: attributes.startReason ? String(attributes.startReason) : null,
          createdDate: attributes.createdDate ?? null,
          startedDate: attributes.startedDate ?? null,
          finishedDate: attributes.finishedDate ?? null,
          issueCounts: toIssueCounts(attributes.issueCounts),
        };
      })
      .sort((a, b) => b.number - a.number);
  };

  const getBuildRunDetail = async (buildRunId: string) => {
    const runPath = `/v1/ciBuildRuns/${encodeURIComponent(buildRunId)}`;
    const [actionsDocument, buildsDocument] = await Promise.all([
      request('GET', `${runPath}/actions?limit=50`),
      request('GET', `${runPath}/builds?limit=10`).catch(() => ({ data: [] }) as JsonApiDocument),
    ]);

    const actions = await Promise.all(asArray(actionsDocument.data).map(async (action) => {
      const actionPath = `/v1/ciBuildActions/${encodeURIComponent(action.id)}`;
      const [artifactsDocument, issuesDocument] = await Promise.all([
        request('GET', `${actionPath}/artifacts?limit=50`).catch(() => ({ data: [] }) as JsonApiDocument),
        request('GET', `${actionPath}/issues?limit=100`).catch(() => ({ data: [] }) as JsonApiDocument),
      ]);
      const attributes = action.attributes ?? {};
      return {
        id: action.id,
        name: String(attributes.name ?? attributes.actionType ?? 'Action'),
        actionType: String(attributes.actionType ?? ''),
        executionProgress: String(attributes.executionProgress ?? 'PENDING'),
        completionStatus: attributes.completionStatus ? String(attributes.completionStatus) : null,
        startedDate: attributes.startedDate ?? null,
        finishedDate: attributes.finishedDate ?? null,
        issueCounts: toIssueCounts(attributes.issueCounts),
        artifacts: asArray(artifactsDocument.data).map((artifact) => ({
          id: artifact.id,
          fileType: String(artifact.attributes?.fileType ?? ''),
          fileName: String(artifact.attributes?.fileName ?? artifact.id),
          fileSize: Number(artifact.attributes?.fileSize ?? 0),
          downloadUrl: artifact.attributes?.downloadUrl ? String(artifact.attributes.downloadUrl) : null,
        })),
        issues: asArray(issuesDocument.data).map((issue) => ({
          id: issue.id,
          issueType: String(issue.attributes?.issueType ?? ''),
          message: String(issue.attributes?.message ?? ''),
          category: issue.attributes?.category ? String(issue.attributes.category) : null,
          filePath: issue.attributes?.fileSource?.path ? String(issue.attributes.fileSource.path) : null,
          lineNumber: issue.attributes?.fileSource?.lineNumber ?? null,
        })),
      };
    }));

    const builds = asArray(buildsDocument.data).map((build) => ({
      id: build.id,
      version: String(build.attributes?.version ?? ''),
      processingState: build.attributes?.processingState ? String(build.attributes.processingState) : null,
      uploadedDate: build.attributes?.uploadedDate ?? null,
      expired: Boolean(build.attributes?.expired),
    }));

    return { id: buildRunId, actions, builds };
  };

  // Starts a build: either a rerun of an earlier build (same commit) or a new
  // build of a workflow, optionally on the branch or tag an earlier run used.
  const startBuild = async (input: { workflowId?: string; sourceRefId?: string; rebuildOfBuildRunId?: string; clean?: boolean }) => {
    const relationships: Record<string, unknown> = {};
    if (input.rebuildOfBuildRunId) {
      relationships.buildRun = { data: { type: 'ciBuildRuns', id: input.rebuildOfBuildRunId } };
    } else if (input.workflowId) {
      relationships.workflow = { data: { type: 'ciWorkflows', id: input.workflowId } };
      if (input.sourceRefId) {
        relationships.sourceBranchOrTag = { data: { type: 'scmGitReferences', id: input.sourceRefId } };
      }
    } else {
      throw new AppError('Choose a workflow or a build to run again.', { code: 'XCODE_CLOUD_BAD_REQUEST', statusCode: 400 });
    }
    const document = await request('POST', '/v1/ciBuildRuns', {
      data: {
        type: 'ciBuildRuns',
        ...(input.clean ? { attributes: { clean: true } } : {}),
        relationships,
      },
    });
    const created = asArray(document.data)[0];
    return { id: created?.id ?? null, number: Number(created?.attributes?.number ?? 0) };
  };

  return { isConfigured, listProducts, listWorkflows, listBuildRuns, getBuildRunDetail, startBuild };
}

/** The service wired to the real App Store Connect API (ASC_API_BASE_URL overrides the host, for testing). */
export function createDefaultXcodeCloudService() {
  return createXcodeCloudService({
    loadConfig: loadAscConfigFromDisk,
    fetch: (url, init) => fetch(url, init),
    baseUrl: process.env.ASC_API_BASE_URL || DEFAULT_BASE_URL,
    now: () => Date.now(),
  });
}
