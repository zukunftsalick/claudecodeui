import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createXcodeCloudService, parseEnvFile, signAscToken } from '../xcode-cloud.service.js';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CONFIG = { keyId: 'ABCDE12345', issuerId: '57246542-96fe-1a63-e053-0824d011072a', privateKey: PRIVATE_KEY_PEM };

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

function createService(routes: Record<string, { status?: number; body: unknown }>, config: typeof CONFIG | null = CONFIG) {
  const calls: Call[] = [];
  const service = createXcodeCloudService({
    loadConfig: async () => config,
    baseUrl: 'https://asc.test',
    now: () => 1_700_000_000_000,
    fetch: async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
      const key = `${init.method ?? 'GET'} ${url.replace('https://asc.test', '')}`;
      const route = routes[key];
      const status = route?.status ?? (route ? 200 : 404);
      return {
        ok: status < 400,
        status,
        json: async () => route?.body ?? { errors: [{ detail: 'not found' }] },
        text: async () => JSON.stringify(route?.body ?? {}),
      };
    },
  });
  return { service, calls };
}

test('parseEnvFile reads the setup script format', () => {
  assert.deepEqual(parseEnvFile('# comment\nASC_KEY_ID=ABC\nASC_ISSUER_ID="x-y"\n\nASC_KEY_PATH=/k.p8\n'), {
    ASC_KEY_ID: 'ABC', ASC_ISSUER_ID: 'x-y', ASC_KEY_PATH: '/k.p8',
  });
});

test('signAscToken makes an ES256 token Apple can verify', () => {
  const token = signAscToken(CONFIG, 100, 1000);
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'ES256', kid: 'ABCDE12345', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString()), {
    iss: CONFIG.issuerId, iat: 100, exp: 1000, aud: 'appstoreconnect-v1',
  });
  assert.equal(Buffer.from(signature, 'base64url').length, 64);
  assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), {
    key: createPublicKey(PRIVATE_KEY_PEM),
    dsaEncoding: 'ieee-p1363',
  }, Buffer.from(signature, 'base64url')));
});

test('without a key every call says so', async () => {
  const { service } = createService({}, null);
  assert.equal(await service.isConfigured(), false);
  await assert.rejects(service.listProducts(), (error: unknown) => error instanceof AppError && error.code === 'XCODE_CLOUD_NOT_CONFIGURED');
});

test('listProducts joins the app and sends a bearer token', async () => {
  const { service, calls } = createService({
    'GET /v1/ciProducts?include=app&limit=50': {
      body: {
        data: [{ type: 'ciProducts', id: 'p1', attributes: { name: 'Designpad', productType: 'APP' }, relationships: { app: { data: { type: 'apps', id: 'a1' } } } }],
        included: [{ type: 'apps', id: 'a1', attributes: { name: 'Designpad', bundleId: 'ai.designpad.app' } }],
      },
    },
  });
  assert.deepEqual(await service.listProducts(), [
    { id: 'p1', name: 'Designpad', productType: 'APP', appId: 'a1', bundleId: 'ai.designpad.app' },
  ]);
  assert.match(calls[0].headers.Authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
});

test('listBuildRuns falls back without include/sort and orders newest first', async () => {
  const { service, calls } = createService({
    'GET /v1/ciProducts/p1/buildRuns?limit=30&include=workflow,sourceBranchOrTag&sort=-number': { status: 400, body: { errors: [{ detail: 'bad param' }] } },
    'GET /v1/ciProducts/p1/buildRuns?limit=30': {
      body: {
        data: [
          { type: 'ciBuildRuns', id: 'r1', attributes: { number: 7, executionProgress: 'COMPLETE', completionStatus: 'SUCCEEDED', sourceCommit: { commitSha: 'abc', message: 'Fix crash\n\nlong body', author: { displayName: 'Pedro' } }, issueCounts: { errors: 0, warnings: 2 } } },
          { type: 'ciBuildRuns', id: 'r2', attributes: { number: 8, executionProgress: 'RUNNING' } },
        ],
      },
    },
  });
  const runs = await service.listBuildRuns('p1');
  assert.equal(calls.length, 2);
  assert.deepEqual(runs.map((run) => run.number), [8, 7]);
  assert.equal(runs[1].commitMessage, 'Fix crash');
  assert.equal(runs[1].issueCounts.warnings, 2);
  assert.equal(runs[0].completionStatus, null);
});

test('startBuild reruns a build or starts a workflow on a branch', async () => {
  const { service, calls } = createService({
    'POST /v1/ciBuildRuns': { status: 201, body: { data: { type: 'ciBuildRuns', id: 'r9', attributes: { number: 9 } } } },
  });
  assert.deepEqual(await service.startBuild({ rebuildOfBuildRunId: 'r1' }), { id: 'r9', number: 9 });
  assert.deepEqual(calls[0].body, { data: { type: 'ciBuildRuns', relationships: { buildRun: { data: { type: 'ciBuildRuns', id: 'r1' } } } } });

  await service.startBuild({ workflowId: 'w1', sourceRefId: 'g1', clean: true });
  assert.deepEqual(calls[1].body, {
    data: {
      type: 'ciBuildRuns',
      attributes: { clean: true },
      relationships: {
        workflow: { data: { type: 'ciWorkflows', id: 'w1' } },
        sourceBranchOrTag: { data: { type: 'scmGitReferences', id: 'g1' } },
      },
    },
  });
  await assert.rejects(service.startBuild({}), (error: unknown) => error instanceof AppError && error.statusCode === 400);
});

test('a rejected key gets a clear message', async () => {
  const { service } = createService({ 'GET /v1/ciProducts?include=app&limit=50': { status: 401, body: { errors: [{ title: 'NOT_AUTHORIZED' }] } } });
  await assert.rejects(service.listProducts(), /Apple rejected the App Store Connect key/);
});

test('build detail gathers actions, issues, artifacts and TestFlight builds', async () => {
  const { service } = createService({
    'GET /v1/ciBuildRuns/r1/actions?limit=50': { body: { data: [{ type: 'ciBuildActions', id: 'x1', attributes: { name: 'Archive - iOS', actionType: 'ARCHIVE', executionProgress: 'COMPLETE', completionStatus: 'FAILED', issueCounts: { errors: 1 } } }] } },
    'GET /v1/ciBuildRuns/r1/builds?limit=10': { body: { data: [{ type: 'builds', id: 'b1', attributes: { version: '42', processingState: 'VALID' } }] } },
    'GET /v1/ciBuildActions/x1/artifacts?limit=50': { body: { data: [{ type: 'ciArtifacts', id: 'f1', attributes: { fileType: 'LOG_BUNDLE', fileName: 'logs.zip', fileSize: 1024, downloadUrl: 'https://dl/logs.zip' } }] } },
    'GET /v1/ciBuildActions/x1/issues?limit=100': { body: { data: [{ type: 'ciIssues', id: 'i1', attributes: { issueType: 'ERROR', message: 'Cannot find X', fileSource: { path: 'App/View.swift', lineNumber: 12 } } }] } },
  });
  const detail = await service.getBuildRunDetail('r1');
  assert.equal(detail.actions[0].completionStatus, 'FAILED');
  assert.deepEqual(detail.actions[0].issues[0], { id: 'i1', issueType: 'ERROR', message: 'Cannot find X', category: null, filePath: 'App/View.swift', lineNumber: 12 });
  assert.equal(detail.actions[0].artifacts[0].downloadUrl, 'https://dl/logs.zip');
  assert.deepEqual(detail.builds, [{ id: 'b1', version: '42', processingState: 'VALID', uploadedDate: null, expired: false }]);
});
