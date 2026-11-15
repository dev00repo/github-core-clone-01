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
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(store),
    ...extra,
  });
  res.end(text);
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

/** Read the whole request body as bytes (cap 64 MiB by default). */
export async function readRawBody(
  req: IncomingMessage,
  cap = 64 * 1024 * 1024,
): Promise<{ ok: true; data: Buffer } | { ok: false; reason: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > cap) return { ok: false, reason: 'too-big' };
      chunks.push(buf);
    }
  } catch {
    return { ok: false, reason: 'read-error' };
  }
  return { ok: true, data: Buffer.concat(chunks) };
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

/** The query string of a request, never throwing. */
export function parseQuery(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** The path of a request URL, or '/' when it does not parse (never throws). */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
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
