// The HTTP server: routing, authentication and body handling shared by the
// four surfaces. Everything except the health probe requires the bearer
// token from MAKEFUN_SHOP_TOKEN; a missing or wrong token is a 401 with a
// JSON message, on every surface alike.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

export interface Ctx {
  store: Store;
  /** The request's bearer token, already verified. */
  token: string;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

export function sendBody(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    parts.push(buf);
  }
  return Buffer.concat(parts);
}

/** The bearer token of a request, or null when absent or not a bearer. */
function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match === null ? null : match[1];
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function createApp(): Server {
  const store = new Store();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestSeq = 0;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://forge');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Authentication: every other route, every surface. The request id
        // is assigned before auth so even a 401 REST reply carries one.
        if (path.startsWith('/api/v3')) {
          requestSeq += 1;
          res.setHeader('x-github-request-id', `F0RG-${requestSeq}`);
        }
        const token = bearerOf(req);
        if (expectedToken !== '' && token !== expectedToken) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        const ctx: Ctx = { store, token: token ?? '' };

        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

        if (path === '/api/v3' || path === '/api/v3/') {
          if (method !== 'GET') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          sendJson(
            res,
            200,
            {
              current_user_url: '/api/v3/user',
              repository_url: '/api/v3/repos/{owner}/{repo}',
              issue_search_url: '/api/v3/search/issues?q={query}',
              rate_limit_url: '/api/v3/rate_limit',
            },
            { 'x-oauth-scopes': 'repo, read:org' },
          );
          return;
        }
        if (path.startsWith('/api/v3/')) {
          await handleRest(ctx, req, res, path, url.searchParams, body);
          return;
        }
        if (path === '/api/graphql') {
          await handleGraphql(ctx, req, res, body);
          return;
        }
        if (path === '/mcp') {
          await handleMcp(ctx, req, res, body);
          return;
        }
        const git = GIT_PATH.exec(path);
        if (git !== null) {
          await handleGit(ctx, req, res, git[1], git[2], git[3], url.searchParams, body);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
        } else {
          res.end();
        }
      }
    })();
  });
}
