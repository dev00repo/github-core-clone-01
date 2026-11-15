// HTTP plumbing shared by every surface: JSON replies, bodies, auth, request ids.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export type SurfaceHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
) => Promise<boolean>;

const JSON_TYPE = 'application/json; charset=utf-8';
const BODY_CAP = 1024 * 1024;

/** Deterministic per-request id: a counter, never a hash or a clock. */
export function requestId(store: Store): string {
  store.reqCounter += 1;
  return `req-${store.reqCounter}`;
}

/**
 * Answer with a JSON body. Always sets the JSON content type and a non-empty
 * X-GitHub-Request-Id — every reply carries one, errors included.
 */
export function sendJson(
  res: ServerResponse,
  store: Store,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const buf = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': requestId(store),
    ...extra,
  });
  res.end(buf);
}

/** A JSON error body: {"message": "..."}. */
export function sendError(res: ServerResponse, store: Store, status: number, message: string): void {
  sendJson(res, store, status, { message });
}

/** The bearer token of `Authorization: Bearer <t>`, or null when absent/malformed. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match === null ? null : match[1];
}

/**
 * Read the whole request body as bytes (cap 64 MiB by default).
 *
 * Event-based accumulation, not `for await...of`: the async iterator's
 * generator machinery costs ~10 us per body even when the body arrives in a
 * single chunk, and every POST in the benchmark pays it. Same contract as
 * before: too-big stops the stream and reports 'too-big', a stream error
 * reports 'read-error'.
 */
export function readRawBody(
  req: IncomingMessage,
  cap = 64 * 1024 * 1024,
): Promise<{ ok: true; data: Buffer } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: { ok: true; data: Buffer } | { ok: false; reason: string }): void => {
      if (done) return;
      done = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > cap) {
        // The caller answers 400 and never needs the rest of the body.
        // Destroying the stream mirrors the old for-await early return.
        try {
          req.destroy();
        } catch {
          // Already gone.
        }
        finish({ ok: false, reason: 'too-big' });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish({ ok: true, data: Buffer.concat(chunks) });
    const onError = (): void => finish({ ok: false, reason: 'read-error' });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * Read a JSON request body. An empty body reads as {}. Invalid JSON or a body
 * over the 1 MiB cap fails; the caller answers 400.
 */
export async function readJsonBody(
  req: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: 'malformed' | 'too-big' }> {
  const raw = await readRawBody(req, BODY_CAP);
  if (!raw.ok) return { ok: false, reason: raw.reason === 'too-big' ? 'too-big' : 'malformed' };
  const text = raw.data.toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

/**
 * The parsed URL of a request, cached per request object. The dispatcher,
 * the REST handler and the git handler each need the path and the query,
 * and `new URL()` costs ~1.6 us a parse — three parses per REST request
 * for nothing. One parse, shared; identical results (same URL object).
 */
const parsedUrls = new WeakMap<IncomingMessage, URL | null>();

function parsedUrl(req: IncomingMessage): URL | null {
  const cached = parsedUrls.get(req);
  if (cached !== undefined) return cached;
  let parsed: URL | null;
  try {
    parsed = new URL(req.url ?? '/', 'http://entry');
  } catch {
    parsed = null;
  }
  parsedUrls.set(req, parsed);
  return parsed;
}

/** The query string of a request, never throwing. */
export function parseQuery(req: IncomingMessage): URLSearchParams {
  return parsedUrl(req)?.searchParams ?? new URLSearchParams();
}

/** The path of a request URL, or '/' when it does not parse (never throws). */
export function pathOf(req: IncomingMessage): string {
  return parsedUrl(req)?.pathname ?? '/';
}

/** decodeURIComponent, or null when the segment is not valid percent-encoding. */
export function decodeSeg(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** Split a path into its '/'-separated segments (no leading empty segment). */
export function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}
