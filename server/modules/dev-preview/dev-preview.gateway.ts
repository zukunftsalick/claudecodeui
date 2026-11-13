import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';

import type { NextFunction, Request, Response } from 'express';

import { isPreviewablePort, parsePreviewHost } from './dev-preview.service.js';

type DevPreviewGatewayOptions = {
  // Base domain preview hosts live under (`p5173.<domain>`); null disables previews.
  domain: string | null;
  // The app's own port, which is never proxied.
  serverPort: number;
  // Returns a truthy user for a valid app session token, null otherwise.
  authenticate: (token: string | null) => unknown;
};

// The app's session token, scoped to one preview host. HttpOnly, so pages
// served from the dev server can't read it, and stripped before forwarding.
const PREVIEW_COOKIE = 'cloudcli_preview';
// Visited once by the app's preview frame to hand over the session token.
export const PREVIEW_AUTH_PATH = '/__cloudcli/preview-auth';
const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** Reads one cookie's value from a Cookie header. Exported for tests. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Removes one cookie from a Cookie header, returning undefined when none remain. Exported for tests. */
export function stripCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && part.split('=')[0] !== name);
  return kept.length ? kept.join('; ') : undefined;
}

/** Keeps a post-login redirect on the same host: only plain absolute paths pass. Exported for tests. */
export function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return '/';
  }
  return value;
}

// Redirects to the dev server's own origin (http://localhost:5173/x) become
// relative, so the browser stays on the preview host.
function rewriteLocation(location: string | undefined, port: number): string | undefined {
  if (location === undefined) return location;
  const match = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d+)(\/.*)?$/i.exec(location);
  if (match && Number(match[1]) === port) {
    return match[2] || '/';
  }
  return location;
}

function sendPage(response: Response, status: number, title: string, message: string): void {
  response
    .status(status)
    .type('html')
    .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
      + '<body style="font:15px system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f8fafc;color:#334155">'
      + `<div style="max-width:28rem;padding:24px;text-align:center"><h1 style="font-size:18px">${title}</h1><p>${message}</p></div>`);
}

function isSecureRequest(request: Request): boolean {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return proto?.split(',')[0].trim() === 'https' || Boolean((request.socket as { encrypted?: boolean }).encrypted);
}

/**
 * Serves dev servers running on this machine at `p<port>.<domain>`, so a page
 * Claude starts (Vite, Next, a static server) can be previewed beside the chat.
 * Used by the server entrypoint: `middleware` goes before every other route and
 * `handleUpgrade` is offered each WebSocket upgrade first (for hot reload).
 * Every request needs the app's session token, held in a host-only cookie.
 */
export function createDevPreviewGateway({ domain, serverPort, authenticate }: DevPreviewGatewayOptions) {
  const previewPortFor = (host: string | undefined): number | null => {
    const port = parsePreviewHost(host, domain);
    return port !== null && isPreviewablePort(port, serverPort) ? port : null;
  };

  const middleware = (request: Request, response: Response, next: NextFunction): void => {
    const port = previewPortFor(request.headers.host);
    if (port === null) {
      next();
      return;
    }

    const url = new URL(request.originalUrl || request.url || '/', 'http://preview.local');

    if (url.pathname === PREVIEW_AUTH_PATH) {
      const token = url.searchParams.get('token');
      if (!authenticate(token)) {
        sendPage(response, 401, 'Sign in again', 'Your CloudCLI session has expired. Reload CloudCLI and open the preview again.');
        return;
      }
      // Platform mode authenticates without a token, so there is nothing to keep.
      if (token) {
        const secure = isSecureRequest(request) ? '; Secure' : '';
        response.setHeader(
          'Set-Cookie',
          `${PREVIEW_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure}`,
        );
      }
      response.redirect(302, safeNextPath(url.searchParams.get('next')));
      return;
    }

    if (!authenticate(readCookie(request.headers.cookie, PREVIEW_COOKIE))) {
      sendPage(response, 401, 'Open this from CloudCLI', `This preview of port ${port} only opens from inside CloudCLI.`);
      return;
    }

    const headers: http.OutgoingHttpHeaders = { ...request.headers };
    const cookie = stripCookie(request.headers.cookie, PREVIEW_COOKIE);
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
    // Cloudflare Access's identity token is for this app, not for the dev server.
    delete headers['cf-access-jwt-assertion'];
    // Dev servers check Host against an allow-list that always includes localhost.
    headers.host = `localhost:${port}`;

    const upstream = http.request({
      host: 'localhost',
      port,
      method: request.method,
      path: request.originalUrl || request.url,
      headers,
      // `localhost` with Node's default happy-eyeballs (on since Node 20) tries
      // both ::1 and 127.0.0.1, since dev servers bind either one.
    }, (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      responseHeaders.location = rewriteLocation(responseHeaders.location, port);
      if (responseHeaders.location === undefined) delete responseHeaders.location;
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(response);
    });

    upstream.on('error', () => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendPage(response, 502, `Nothing is running on port ${port}`, 'Start the dev server again, then reload this preview.');
    });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  };

  // Returns true when the upgrade belonged to a preview host and was handled
  // (proxied or refused); false leaves it to the app's own WebSocket server.
  const handleUpgrade = (request: http.IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const port = previewPortFor(request.headers.host);
    if (port === null) {
      return false;
    }

    if (!authenticate(readCookie(request.headers.cookie, PREVIEW_COOKIE))) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return true;
    }

    const upstream = net.connect({ host: 'localhost', port, autoSelectFamily: true });
    upstream.on('connect', () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      const raw = request.rawHeaders;
      for (let index = 0; index < raw.length; index += 2) {
        const name = raw[index];
        const lower = name.toLowerCase();
        if (lower === 'host') {
          lines.push(`Host: localhost:${port}`);
        } else if (lower === 'cf-access-jwt-assertion') {
          continue;
        } else if (lower === 'cookie') {
          const cookie = stripCookie(raw[index + 1], PREVIEW_COOKIE);
          if (cookie) lines.push(`Cookie: ${cookie}`);
        } else {
          lines.push(`${name}: ${raw[index + 1]}`);
        }
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });

    const closeBoth = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', closeBoth);
    socket.on('error', closeBoth);
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
    return true;
  };

  return { middleware, handleUpgrade };
}
