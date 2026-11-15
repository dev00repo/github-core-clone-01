// The server: one dispatcher over the four surfaces, plus the health probe,
// the API root, and the JSON 404 fallback. The surfaces live in src/*.ts and
// each answers for its own path prefix.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Store } from './src/store.ts';
import { pathOf, sendJson } from './src/http.ts';
import { handleRest } from './src/rest.ts';
import { handleGit } from './src/git.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

/** Build the server. It binds nothing until the caller listens. */
export function createApp(store: Store): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, store, 200, { ok: true });
          return;
        }

        // The GitHub API root: a 200 with the token's scopes.
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(
            res,
            store,
            200,
            { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
            { 'x-oauth-scopes': 'repo, read:org' },
          );
          return;
        }

        if (path === '/api/graphql') {
          if (await handleGraphql(req, res, store)) return;
        } else if (path === '/mcp') {
          if (await handleMcp(req, res, store)) return;
        } else if (path.startsWith('/api/v3/')) {
          if (await handleRest(req, res, store)) return;
        } else if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
          if (await handleGit(req, res, store)) return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, store, 404, { message: 'Not Found' });
      } catch (err) {
        // A request handler must never take the server down with it.
        try {
          sendJson(res, store, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          try {
            res.destroy();
          } catch {
            // Nothing left to do for this socket.
          }
        }
      }
    })();
  });
}
