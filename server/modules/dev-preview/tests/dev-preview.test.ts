import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createDevPreviewGateway, readCookie, safeNextPath, stripCookie } from '../dev-preview.gateway.js';
import { isPreviewablePort, parsePreviewHost, parseProcNetTcp } from '../dev-preview.service.js';

test('parsePreviewHost reads p<port> hosts under the configured domain only', () => {
  assert.equal(parsePreviewHost('p5173.example.com', 'example.com'), 5173);
  assert.equal(parsePreviewHost('P3000.Example.com:443', 'example.com'), 3000);
  assert.equal(parsePreviewHost('code.example.com', 'example.com'), null);
  assert.equal(parsePreviewHost('p5173.evil.com', 'example.com'), null);
  assert.equal(parsePreviewHost('p5173.example.com.evil.com', 'example.com'), null);
  assert.equal(parsePreviewHost('p22.example.com', 'example.com'), null);
  assert.equal(parsePreviewHost('p99999.example.com', 'example.com'), null);
  assert.equal(parsePreviewHost('p5173.example.com', null), null);
});

test('isPreviewablePort refuses privileged ports and the app itself', () => {
  assert.equal(isPreviewablePort(5173, 3001), true);
  assert.equal(isPreviewablePort(3001, 3001), false);
  assert.equal(isPreviewablePort(80, 3001), false);
});

test('parseProcNetTcp keeps listening sockets on local addresses', () => {
  const text = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1',
    '   1: 00000000:0BB9 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1',
    '   2: 0100007F:1435 0100007F:D2F0 01 00000000:00000000 00:00000000 00000000  1000        0 333 1',
    '   3: 0A00000F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 444 1',
  ].join('\n');
  assert.deepEqual(parseProcNetTcp(text), [
    { port: 5173, inode: '111' },
    { port: 3001, inode: '222' },
  ]);
});

test('cookie helpers read and strip only the named cookie', () => {
  assert.equal(readCookie('a=1; cloudcli_preview=tok%20en; b=2', 'cloudcli_preview'), 'tok en');
  assert.equal(readCookie('a=1', 'cloudcli_preview'), null);
  assert.equal(stripCookie('a=1; cloudcli_preview=x; b=2', 'cloudcli_preview'), 'a=1; b=2');
  assert.equal(stripCookie('cloudcli_preview=x', 'cloudcli_preview'), undefined);
});

test('safeNextPath only allows same-host paths', () => {
  assert.equal(safeNextPath('/app?x=1'), '/app?x=1');
  assert.equal(safeNextPath('//evil.com'), '/');
  assert.equal(safeNextPath('https://evil.com'), '/');
  assert.equal(safeNextPath(null), '/');
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

test('the gateway proxies authenticated preview requests and refuses others', async (t) => {
  let seenHeaders: http.IncomingHttpHeaders = {};
  const devServer = http.createServer((request, response) => {
    seenHeaders = request.headers;
    if (request.url === '/redirect') {
      response.writeHead(302, { location: `http://localhost:${devPort}/landing` });
      response.end();
      return;
    }
    response.end(`dev:${request.url}`);
  });
  const devPort = await listen(devServer);

  const gateway = createDevPreviewGateway({
    domain: 'example.com',
    serverPort: 3001,
    authenticate: (token) => (token === 'good' ? { id: 1 } : null),
  });
  const app = express();
  app.use(gateway.middleware);
  app.get('/', (_request, response) => response.send('app'));
  const appServer = http.createServer(app);
  const appPort = await listen(appServer);
  t.after(() => {
    devServer.close();
    appServer.close();
  });

  const request = (path: string, host: string, cookie?: string) => new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: appPort, path, headers: { host, ...(cookie ? { cookie } : {}) } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });

  const previewHost = `p${devPort}.example.com`;

  // The app's own host is untouched.
  assert.equal((await request('/', 'code.example.com')).body, 'app');

  // No session cookie: refused, nothing reaches the dev server.
  assert.equal((await request('/x', previewHost)).status, 401);

  // A bad token can't log in; a good one sets the cookie and redirects.
  assert.equal((await request('/__cloudcli/preview-auth?token=bad', previewHost)).status, 401);
  const login = await request('/__cloudcli/preview-auth?token=good&next=/page', previewHost);
  assert.equal(login.status, 302);
  assert.equal(login.headers.location, '/page');
  assert.match(String(login.headers['set-cookie']), /cloudcli_preview=good; Path=\/; HttpOnly/);

  // With the cookie the request is proxied, the token is stripped and Host rewritten.
  const proxied = await request('/page?q=1', previewHost, 'other=1; cloudcli_preview=good');
  assert.equal(proxied.body, 'dev:/page?q=1');
  assert.equal(seenHeaders.cookie, 'other=1');
  assert.equal(seenHeaders.host, `localhost:${devPort}`);

  // Redirects back to the dev server's own origin stay on the preview host.
  const redirect = await request('/redirect', previewHost, 'cloudcli_preview=good');
  assert.equal(redirect.headers.location, '/landing');
});
