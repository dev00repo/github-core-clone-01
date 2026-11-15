// Git smart HTTP surface: protocol v0/v2 upload-pack, v0 receive-pack,
// packfile read (plain + OFS/REF deltas) and write (plain objects only).
// From-scratch implementation against INTERFACES.md §3/§5 and notes/git.md.
//
// Determinism: no wall clock, no Math.random in request paths. Request ids
// come from the store counter via requestId().

import type { IncomingMessage, ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { Store, RepoRec } from './store.ts';
import {
  parseQuery,
  pathOf,
  readRawBody,
  requestId,
  sendError,
  type SurfaceHandler,
} from './http.ts';
import { ZERO_OID, isHex40, sha1Hex } from './util.ts';

// ---------------------------------------------------------------------------
// pkt-line framing

const PKT_MAX = 65520;
const PKT_PAYLOAD_MAX = 65516;

function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

class PktError extends Error {}

/** Decode pkt-lines from `buf` starting at `start`. Stops after `stopAtFlush`
 *  (the first flush packet is returned and decoding stops, leaving the rest
 *  of the buffer unconsumed — the receive-pack raw pack follows it). */
function decodePkts(
  buf: Buffer,
  start = 0,
  stopAtFlush = false,
): { packets: Pkt[]; end: number } {
  const packets: Pkt[] = [];
  let pos = start;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new PktError('pktline-truncated');
    const head = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new PktError('pktline-header');
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      pos += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end' });
      pos += 4;
      continue;
    }
    if (len === 3 || len > PKT_MAX || len < 4) throw new PktError('pktline-too-long');
    if (pos + len > buf.length) throw new PktError('pktline-truncated');
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { packets, end: pos };
}

/** The data payloads of decoded packets as UTF-8 lines (trailing \n stripped). */
function pktLines(packets: Pkt[]): string[] {
  const out: string[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    let s = p.payload.toString('utf8');
    if (s.endsWith('\n')) s = s.slice(0, -1);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// small helpers

function sha1Buf(data: Buffer): Buffer {
  return createHash('sha1').update(data).digest();
}

function sendBinary(
  res: ServerResponse,
  store: Store,
  status: number,
  contentType: string,
  body: Buffer,
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(store),
  });
  res.end(body);
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headRefName(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Follow annotated-tag objects until a non-tag object (or a missing one). */
function peelOid(store: Store, repo: RepoRec, oid: string): string {
  let cur = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(cur)) return cur;
    seen.add(cur);
    const obj = store.getObject(repo, cur);
    if (obj === undefined || obj.type !== 'tag') return cur;
    const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (m === null) return cur;
    cur = m[1];
  }
}

function tagObjectTarget(data: Buffer): string | undefined {
  const m = /^object ([0-9a-f]{40})$/m.exec(data.toString('utf8'));
  return m === null ? undefined : m[1];
}

/** The peeled (target) oid of an annotated tag, or undefined when not a tag. */
function peeledOf(store: Store, repo: RepoRec, oid: string): string | undefined {
  const obj = store.getObject(repo, oid);
  if (obj === undefined || obj.type !== 'tag') return undefined;
  return peelOid(store, repo, oid);
}

// ---------------------------------------------------------------------------
// packfile writing (plain objects only)

const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function encodeEntryHeader(typeCode: number, size: number): Buffer {
  const out: number[] = [];
  let s = size;
  const first = (typeCode << 4) | (s & 0x0f);
  s >>= 4;
  const rest: number[] = [];
  while (s > 0) {
    let b = s & 0x7f;
    s >>= 7;
    if (s > 0) b |= 0x80;
    rest.push(b);
  }
  out.push(rest.length > 0 ? first | 0x80 : first, ...rest);
  return Buffer.from(out);
}

function writePack(objects: { type: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = TYPE_CODES[obj.type];
    if (typeCode === undefined) continue;
    parts.push(encodeEntryHeader(typeCode, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, sha1Buf(body)]);
}

// ---------------------------------------------------------------------------
// packfile reading (plain + OFS_DELTA + REF_DELTA)

function readVarintSize(buf: Buffer, pos: number): { size: number; pos: number } {
  let size = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    if (p >= buf.length) throw new PktError('pack-truncated');
    const b = buf[p];
    p += 1;
    size += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
    if (shift > 63) throw new PktError('pack-corrupt');
  }
  return { size, pos: p };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const src = readVarintSize(delta, pos);
  pos = src.pos;
  const tgt = readVarintSize(delta, pos);
  pos = tgt.pos;
  if (src.size !== base.length) throw new PktError('delta-base-size');
  const chunks: Buffer[] = [];
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          if (pos >= delta.length) throw new PktError('delta-corrupt');
          offset |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          if (pos >= delta.length) throw new PktError('delta-corrupt');
          size |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length || written + size > tgt.size) {
        throw new PktError('delta-corrupt');
      }
      chunks.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op !== 0) {
      if (pos + op > delta.length) throw new PktError('delta-corrupt');
      chunks.push(delta.subarray(pos, pos + op));
      pos += op;
      written += op;
    } else {
      throw new PktError('delta-corrupt');
    }
  }
  if (written !== tgt.size) throw new PktError('delta-size');
  return Buffer.concat(chunks);
}

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  baseOffset?: number;
  baseOid?: string;
  data: Buffer; // inflated bytes: raw object bytes, or delta bytes
}

/**
 * Parse a packfile into oid -> {type, data}. Deltas resolve against earlier /
 * later entries in the same pack, then against `resolveBase` (objects the
 * receiver already holds — thin packs on fetch, the store on receive-pack).
 */
function parsePack(
  store: Store,
  buf: Buffer,
  resolveBase: (oid: string) => { type: string; data: Buffer } | undefined,
): Map<string, { type: string; data: Buffer }> {
  if (buf.length < 32) throw new PktError('pack-truncated');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new PktError('pack-header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PktError('pack-version');
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const computed = sha1Buf(buf.subarray(0, buf.length - 20));
  if (!trailer.equals(computed)) throw new PktError('pack-checksum');

  const entries: RawEntry[] = [];
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = pos;
    if (pos >= buf.length - 20) throw new PktError('pack-truncated');
    let b = buf[pos];
    pos += 1;
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while ((b & 0x80) !== 0) {
      if (pos >= buf.length - 20) throw new PktError('pack-truncated');
      b = buf[pos];
      pos += 1;
      size += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new PktError('pack-corrupt');
    }
    if (typeCode !== 1 && typeCode !== 2 && typeCode !== 3 && typeCode !== 4 && typeCode !== 6 && typeCode !== 7) {
      throw new PktError('pack-type');
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      if (pos >= buf.length - 20) throw new PktError('pack-truncated');
      let byte = buf[pos];
      pos += 1;
      let value = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (pos >= buf.length - 20) throw new PktError('pack-truncated');
        byte = buf[pos];
        pos += 1;
        value = ((value + 1) << 7) + (byte & 0x7f);
      }
      baseOffset = entryOffset - value;
      if (baseOffset < 0 || baseOffset >= entryOffset) throw new PktError('pack-delta');
    } else if (typeCode === 7) {
      if (pos + 20 > buf.length - 20) throw new PktError('pack-truncated');
      baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const inflated = inflateSync(buf.subarray(pos), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const consumed = inflated.engine.bytesWritten;
    pos += consumed;
    if (inflated.buffer.length !== size) throw new PktError('pack-size');
    entries.push({ offset: entryOffset, typeCode, size, baseOffset, baseOid, data: inflated.buffer });
  }
  if (pos !== buf.length - 20) throw new PktError('pack-trailing');

  const byOffset = new Map<number, RawEntry>();
  for (const e of entries) byOffset.set(e.offset, e);
  const resolvedByOffset = new Map<number, { type: string; data: Buffer }>();
  const resolvedByOid = new Map<string, { type: string; data: Buffer }>();
  const resolving = new Set<number>();

  const resolveEntry = (entry: RawEntry): { type: string; data: Buffer } => {
    const cached = resolvedByOffset.get(entry.offset);
    if (cached !== undefined) return cached;
    if (resolving.has(entry.offset)) throw new PktError('pack-delta-cycle');
    resolving.add(entry.offset);
    let result: { type: string; data: Buffer };
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: { type: string; data: Buffer } | undefined;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset as number);
        if (baseEntry === undefined) throw new PktError('pack-delta-base');
        base = resolveEntry(baseEntry);
      } else {
        const baseOid = entry.baseOid as string;
        const inPack = [...resolvedByOid.entries()].find(([oid]) => oid === baseOid);
        if (inPack !== undefined) {
          base = inPack[1];
        } else {
          base = resolveBase(baseOid);
          if (base === undefined) {
            // The base may be a delta entry in this pack not yet resolved;
            // find the raw entry whose oid it would be only after resolving
            // it — resolve every unresolved entry and retry.
            for (const candidate of entries) {
              if (!resolvedByOffset.has(candidate.offset)) resolveEntry(candidate);
            }
            const retry = resolvedByOid.get(baseOid);
            if (retry !== undefined) base = retry;
          }
          if (base === undefined) throw new PktError('pack-delta-base');
        }
      }
      const data = applyDelta(base.data, entry.data);
      result = { type: base.type, data };
    } else {
      const type = CODE_TYPES[entry.typeCode] as string;
      result = { type, data: entry.data };
    }
    resolving.delete(entry.offset);
    resolvedByOffset.set(entry.offset, result);
    resolvedByOid.set(store.oidFor(result.type, result.data), result);
    return result;
  };

  for (const entry of entries) resolveEntry(entry);
  return resolvedByOid;
}

// ---------------------------------------------------------------------------
// fetch object selection

function treeClosure(store: Store, repo: RepoRec, treeOid: string, into: Set<string>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (into.has(oid)) continue;
    const obj = store.getObject(repo, oid);
    if (obj === undefined) continue;
    into.add(oid);
    if (obj.type === 'tree') {
      for (const e of store.parseTree(obj.data)) stack.push(e.oid);
    }
  }
}

interface FetchSelection {
  delivered: { oid: string; type: string; data: Buffer }[];
  shallowOut: string[];
  unshallowOut: string[];
  ackOids: string[];
}

/** Resolve a want/have oid to its commit oid (peeling tags), if it is one. */
function toCommitOid(store: Store, repo: RepoRec, oid: string): string | undefined {
  const peeled = peelOid(store, repo, oid);
  const obj = store.getObject(repo, peeled);
  if (obj !== undefined && obj.type === 'commit') return peeled;
  return undefined;
}

function collectFetch(
  store: Store,
  repo: RepoRec,
  wants: string[],
  haves: string[],
  shallowIn: string[],
  depth: number | null,
): FetchSelection {
  const included = new Set<string>();
  const includedCommits = new Set<string>();
  const shallowInSet = new Set(shallowIn);

  // Seed the walk from the wants.
  const queue: { oid: string; dist: number }[] = [];
  const bestDist = new Map<string, number>();
  const enqueueCommit = (oid: string, dist: number): void => {
    const prev = bestDist.get(oid);
    if (prev !== undefined && prev <= dist) return;
    bestDist.set(oid, dist);
    queue.push({ oid, dist });
  };
  for (const want of wants) {
    const obj = store.getObject(repo, want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      included.add(want);
      const target = toCommitOid(store, repo, want);
      if (target !== undefined) {
        enqueueCommit(target, 0);
      } else {
        const peeled = peelOid(store, repo, want);
        const targetObj = store.getObject(repo, peeled);
        if (targetObj !== undefined) {
          included.add(peeled);
          if (targetObj.type === 'tree') treeClosure(store, repo, peeled, included);
        }
      }
    } else if (obj.type === 'commit') {
      enqueueCommit(want, 0);
    } else if (obj.type === 'tree') {
      treeClosure(store, repo, want, included);
    } else {
      included.add(want);
    }
  }

  for (let qi = 0; qi < queue.length; qi += 1) {
    const { oid, dist } = queue[qi];
    if (includedCommits.has(oid)) continue;
    if (depth !== null && dist >= depth) continue;
    const obj = store.getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    includedCommits.add(oid);
    included.add(oid);
    const commit = store.parseCommit(obj.data);
    treeClosure(store, repo, commit.tree, included);
    for (const parent of commit.parents) enqueueCommit(parent, dist + 1);
  }

  // What the client already holds: full reachability from the haves, except
  // a shallow boundary commit's parents are NOT held (its history is cut).
  const held = new Set<string>();
  const heldQueue: string[] = [];
  const heldSeen = new Set<string>();
  const seedHeld = (oid: string): void => {
    const obj = store.getObject(repo, oid);
    if (obj === undefined) return;
    if (obj.type === 'tag') {
      held.add(oid);
      const target = toCommitOid(store, repo, oid);
      if (target !== undefined) seedHeld(target);
      return;
    }
    if (obj.type === 'commit' && !heldSeen.has(oid)) {
      heldSeen.add(oid);
      heldQueue.push(oid);
    } else if (obj.type === 'tree') {
      treeClosure(store, repo, oid, held);
    } else {
      held.add(oid);
    }
  };
  for (const have of haves) seedHeld(have);
  for (const boundary of shallowIn) seedHeld(boundary);
  for (let hi = 0; hi < heldQueue.length; hi += 1) {
    const oid = heldQueue[hi];
    const obj = store.getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    held.add(oid);
    const commit = store.parseCommit(obj.data);
    treeClosure(store, repo, commit.tree, held);
    if (shallowInSet.has(oid)) continue; // boundary: parents not held
    for (const parent of commit.parents) {
      if (!heldSeen.has(parent)) {
        heldSeen.add(parent);
        heldQueue.push(parent);
      }
    }
  }

  const delivered: { oid: string; type: string; data: Buffer }[] = [];
  for (const oid of [...included].sort()) {
    if (held.has(oid)) continue;
    const obj = store.getObject(repo, oid);
    if (obj === undefined) continue;
    delivered.push({ oid, type: obj.type, data: obj.data });
  }

  const shallowOut: string[] = [];
  for (const oid of [...includedCommits].sort()) {
    const obj = store.getObject(repo, oid);
    if (obj === undefined) continue;
    const parents = store.parseCommit(obj.data).parents.filter((p) => store.getObject(repo, p) !== undefined);
    if (parents.length > 0 && parents.every((p) => !includedCommits.has(p))) shallowOut.push(oid);
  }
  const unshallowOut: string[] = [];
  for (const oid of [...shallowInSet].sort()) {
    if (!includedCommits.has(oid)) continue;
    const obj = store.getObject(repo, oid);
    if (obj === undefined) continue;
    const parents = store.parseCommit(obj.data).parents.filter((p) => store.getObject(repo, p) !== undefined);
    if (parents.every((p) => includedCommits.has(p))) unshallowOut.push(oid);
  }

  // ACKs: haves that are ancestors of (or equal to) a wanted commit.
  const wantCommits: string[] = [];
  for (const want of wants) {
    const c = toCommitOid(store, repo, want);
    if (c !== undefined) wantCommits.push(c);
  }
  const ackOids: string[] = [];
  for (const have of haves) {
    const hc = toCommitOid(store, repo, have);
    if (hc === undefined) continue;
    if (wantCommits.some((wc) => store.isAncestor(repo, hc, wc))) ackOids.push(hc);
  }

  return { delivered, shallowOut, unshallowOut, ackOids };
}

// ---------------------------------------------------------------------------
// sideband chunking (pack bytes -> pkt-lines with a 1-byte band prefix)

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = PKT_PAYLOAD_MAX - 1; // 1 byte band + data, payload <= 65516
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

// ---------------------------------------------------------------------------
// advertisements

function v0UploadCaps(repo: RepoRec): string {
  return [
    'side-band-64k',
    'multi_ack',
    'multi_ack_detailed',
    'thin-pack',
    'no-progress',
    'ofs-delta',
    'shallow',
    'deepen-relative',
    `symref=HEAD:${headRefName(repo)}`,
  ].join(' ');
}

function v0ReceiveCaps(): string {
  return 'report-status side-band-64k delete-refs ofs-delta';
}

function v0Advertisement(store: Store, repo: RepoRec, service: string): Buffer {
  const isUpload = service === 'git-upload-pack';
  const caps = isUpload ? v0UploadCaps(repo) : v0ReceiveCaps();
  const preamble = `# service=${service}\n`;
  // v0 wire format: preamble line, then a flush, then the ref lines, then
  // a final flush. Real git clients require the flush after the preamble.
  const parts: Buffer[] = [pktLine(preamble), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const tip = repo.refs.get(headRefName(repo));
    parts.push(pktLine(`${tip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) {
      parts.push(pktLine(`${oid} ${name}\n`));
      const peeled = peeledOf(store, repo, oid);
      if (peeled !== undefined) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

/** Convert a relative deepen (N generations beyond the client's current
 *  shallow boundary) into an absolute depth from the wanted tips, as real
 *  upload-pack does for `deepen-relative`. The boundary sits at distance d
 *  from a tip and counts as depth d+1, so the new absolute depth is
 *  d + 1 + N. Falls back to N when no boundary is reachable from the wants. */
function relativeToAbsoluteDepth(
  store: Store,
  repo: RepoRec,
  wants: string[],
  shallowIn: string[],
  relative: number,
): number {
  const boundary = new Set(shallowIn);
  if (boundary.size === 0) return relative;
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    const c = toCommitOid(store, repo, want);
    if (c !== undefined && !dist.has(c)) {
      dist.set(c, 0);
      queue.push(c);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head];
    head += 1;
    const d = dist.get(oid) as number;
    if (boundary.has(oid)) return d + 1 + relative;
    const obj = store.getObject(repo, oid);
    if (obj === undefined) continue;
    for (const p of store.parseCommit(obj.data).parents) {
      if (!dist.has(p)) {
        dist.set(p, d + 1);
        queue.push(p);
      }
    }
  }
  return relative;
}

// ---------------------------------------------------------------------------
// upload-pack: v2 ls-refs

function handleLsRefs(store: Store, repo: RepoRec, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  const headTip = repo.refs.get(headRefName(repo));
  // The HEAD line is included when no prefix was requested, or when a
  // requested prefix matches "HEAD" (git's clone asks for ref-prefix HEAD).
  const includeHead = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
  if (includeHead) {
    if (headTip !== undefined) {
      parts.push(
        pktLine(`${headTip} HEAD${symrefs ? ` symref-target:${headRefName(repo)}` : ''}\n`),
      );
    } else {
      parts.push(
        pktLine(`unborn HEAD${symrefs ? ` symref-target:${headRefName(repo)}` : ''}\n`),
      );
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (prefixes.length > 0 && !prefixes.some((p) => name.startsWith(p))) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledOf(store, repo, oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack: fetch (v2 and v0 share the selection; framing differs)

function buildFetchResponseV2(
  store: Store,
  repo: RepoRec,
  wants: string[],
  haves: string[],
  shallowIn: string[],
  depth: number | null,
): Buffer {
  const sel = collectFetch(store, repo, wants, haves, shallowIn, depth);
  const pack = writePack(sel.delivered);
  const parts: Buffer[] = [];
  // The acknowledgments section is only sent when the client sent haves.
  // The client always sends `done`, so the section ends with `ready` and a
  // DELIM (more sections follow); a bare NAK + flush would make git start
  // another negotiation round instead of reading the packfile.
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (sel.ackOids.length > 0) {
      for (const ack of sel.ackOids) parts.push(pktLine(`ACK ${ack}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  if (sel.shallowOut.length > 0 || sel.unshallowOut.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of sel.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of sel.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  const wantedRefs: string[] = [];
  const wantSet = new Set(wants);
  for (const [name, oid] of sortedRefs(repo)) {
    if (wantSet.has(oid)) wantedRefs.push(`${oid} ${name}`);
  }
  if (wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const line of wantedRefs) parts.push(pktLine(`${line}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function buildFetchResponseV0(
  store: Store,
  repo: RepoRec,
  wants: string[],
  haves: string[],
  shallowIn: string[],
  depth: number | null,
  multiAck: 0 | 1 | 2,
  done: boolean,
  section2: boolean,
): Buffer {
  const sel = collectFetch(store, repo, wants, haves, shallowIn, depth);
  const parts: Buffer[] = [];
  // 1. Shallow list (plain pkt-lines) + flush. Real upload-pack sends this
  //    at the end of receive_needs — in EVERY round, before any ACK/NAK —
  //    whenever a deepen was requested, because the client consumes the
  //    shallow list first (fetch-pack reads it inline after sending
  //    wants+deepen, and again via consume_shallow_list after `done`).
  //    It is only sent when a deepen was requested: a fetch from a shallow
  //    client without deepen gets no shallow section at all.
  if (depth !== null) {
    for (const oid of sel.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of sel.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  // 2. Negotiation response, only when the client sent a second section
  //    (haves and/or `done`). A wants+deepen-only round gets just the
  //    shallow section above and the response ends there.
  if (!section2) return Buffer.concat(parts);
  const acks = sel.ackOids;
  if (done) {
    // Final round: ACKs, then the pack directly (no flush between the
    // ACKs and the pack), then a final flush. With multi_ack_detailed the
    // server ACKs each common have as `common` and ends with one bare
    // ACK; with plain multi_ack the per-have suffix is `continue`; with
    // no multi_ack there is a single bare ACK. No common have → NAK.
    if (acks.length > 0) {
      if (multiAck === 0) {
        // No multi_ack: exactly one bare ACK (the first common have).
        parts.push(pktLine(`ACK ${acks[0]}\n`));
      } else {
        const suffix = multiAck === 2 ? ' common' : ' continue';
        for (let i = 0; i < acks.length - 1; i += 1) {
          parts.push(pktLine(`ACK ${acks[i]}${suffix}\n`));
        }
        parts.push(pktLine(`ACK ${acks[acks.length - 1]}\n`));
      }
    } else {
      parts.push(pktLine('NAK\n'));
    }
    const pack = writePack(sel.delivered);
    for (const p of sidebandPackets(pack)) parts.push(p);
    parts.push(PKT_FLUSH);
  } else {
    // Negotiation round: ACKs, then NAK when multi_ack is set (or when
    // no have is known at all). No pack, no trailing flush — the response
    // simply ends and the client sends the next round or `done`.
    if (acks.length > 0) {
      if (multiAck === 2) {
        for (const ack of acks) parts.push(pktLine(`ACK ${ack} common\n`));
      } else if (multiAck === 1) {
        for (const ack of acks) parts.push(pktLine(`ACK ${ack} continue\n`));
      } else {
        parts.push(pktLine(`ACK ${acks[0]}\n`));
      }
    }
    if (multiAck > 0 || acks.length === 0) parts.push(pktLine('NAK\n'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(
  store: Store,
  repo: RepoRec,
  body: Buffer,
): Buffer {
  // Command lines up to the first flush; the pack follows raw.
  const { packets, end } = decodePkts(body, 0, true);
  const lines = pktLines(packets);
  const commands: PushCommand[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul); // first line's capabilities
    const parts = line.split(' ');
    if (parts.length !== 3 || !isHex40(parts[0]) || !isHex40(parts[1]) || !parts[2].startsWith('refs/')) {
      throw new PktError('push-command');
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) throw new PktError('push-command');

  const packBytes = body.subarray(end);
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);

  let unpackOk = true;
  let unpackDetail = '';
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'missing pack';
    } else {
      try {
        const objects = parsePack(store, packBytes, (oid) => store.getObject(repo, oid));
        for (const [, obj] of objects) store.putObject(repo, obj.type, obj.data);
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      }
    }
  }

  // Fast-forward decisions, one report line per command, in command order.
  const reportLines: string[] = [];
  if (unpackOk) reportLines.push('unpack ok');
  else reportLines.push(`unpack ${unpackDetail}`);
  for (const cmd of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${cmd.ref} unpack failed`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.oldOid === ZERO_OID && cmd.newOid === ZERO_OID) {
      reportLines.push(`ng ${cmd.ref} invalid command`);
    } else if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        reportLines.push(`ng ${cmd.ref} already exists`);
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}`);
      }
    } else if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${cmd.ref} no such ref`);
      } else if (current !== cmd.oldOid) {
        reportLines.push(`ng ${cmd.ref} old value does not match`);
      } else {
        repo.refs.delete(cmd.ref);
        reportLines.push(`ok ${cmd.ref}`);
      }
    } else {
      // Update.
      if (current === undefined) {
        reportLines.push(`ng ${cmd.ref} no such ref`);
      } else if (current !== cmd.oldOid) {
        reportLines.push(`ng ${cmd.ref} old value does not match`);
      } else if (cmd.oldOid === cmd.newOid || store.isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}`);
      } else {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      }
    }
  }

  // Report-status inside sideband band 1. The report itself is pkt-line
  // framed inside the band, and — exactly as git's own receive-pack does
  // (packet_buf_flush before send_sideband) — it ends with a flush packet
  // INSIDE the band, so the client's packet reader sees a clean flush
  // instead of EOF after the last report line. The outer stream then ends
  // with a second, outer flush.
  const reportBytes = Buffer.concat([
    ...reportLines.map((l) => pktLine(`${l}\n`)),
    PKT_FLUSH,
  ]);
  const parts: Buffer[] = [];
  const CHUNK = PKT_PAYLOAD_MAX - 1;
  for (let off = 0; off < reportBytes.length; off += CHUNK) {
    const slice = reportBytes.subarray(off, Math.min(reportBytes.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// dispatcher

export const handleGit: SurfaceHandler = async (req, res, store) => {
  const path = pathOf(req);
  const segments = path.split('/').filter((s) => s !== '');
  // /{owner}/{repo}.git[/...]
  if (segments.length < 2) return false;
  const repoSeg = segments[1];
  if (!repoSeg.endsWith('.git')) return false;
  const ownerRaw = segments[0];
  const repoName = repoSeg.slice(0, -4);
  let owner: string | null = null;
  try {
    owner = decodeURIComponent(ownerRaw);
  } catch {
    owner = null;
  }
  if (owner === null || !NAME_RE.test(owner) || !NAME_RE.test(repoName) || repoName.endsWith('.git')) {
    sendError(res, store, 404, 'Not Found');
    return true;
  }
  const rest = segments.slice(2);
  const method = req.method ?? 'GET';

  try {
    if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
      const service = parseQuery(req).get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) {
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      if (service === 'git-receive-pack') {
        sendBinary(
          res,
          store,
          200,
          'application/x-git-receive-pack-advertisement',
          v0Advertisement(store, repo, service),
        );
      } else if ((req.headers['git-protocol'] ?? '') === 'version=2') {
        sendBinary(
          res,
          store,
          200,
          'application/x-git-upload-pack-advertisement',
          v2Advertisement(),
        );
      } else {
        sendBinary(
          res,
          store,
          200,
          'application/x-git-upload-pack-advertisement',
          v0Advertisement(store, repo, service),
        );
      }
      return true;
    }

    if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) {
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      const raw = await readRawBody(req);
      if (!raw.ok) {
        sendError(res, store, 400, 'malformed pkt-line');
        return true;
      }
      let body: Buffer;
      try {
        const { packets } = decodePkts(raw.data);
        const lines = pktLines(packets);
        if (lines.length === 0) throw new PktError('pktline-header');
        const first = lines[0];
        if (first.startsWith('command=ls-refs')) {
          // v2 ls-refs: args follow the delim packet.
          const delimIdx = packets.findIndex((p) => p.kind === 'delim');
          const argPackets = delimIdx >= 0 ? packets.slice(delimIdx + 1) : [];
          body = handleLsRefs(store, repo, pktLines(argPackets));
          sendBinary(res, store, 200, 'application/x-git-upload-pack-result', body);
          return true;
        }
        if (first.startsWith('command=fetch')) {
          const delimIdx = packets.findIndex((p) => p.kind === 'delim');
          const argPackets = delimIdx >= 0 ? packets.slice(delimIdx + 1) : packets.slice(1);
          const args = pktLines(argPackets);
          const wants: string[] = [];
          const haves: string[] = [];
          const shallow: string[] = [];
          let depth: number | null = null;
          let deepenRelative = false;
          for (const arg of args) {
            if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
            else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
            else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
            else if (arg.startsWith('deepen ')) {
              const n = Number(arg.slice(7).trim());
              if (Number.isFinite(n)) depth = n;
            } else if (arg === 'deepen-relative') deepenRelative = true;
          }
          if (deepenRelative && depth !== null) {
            depth = relativeToAbsoluteDepth(store, repo, wants, shallow, depth);
          }
          body = buildFetchResponseV2(store, repo, wants, haves, shallow, depth);
          sendBinary(res, store, 200, 'application/x-git-upload-pack-result', body);
          return true;
        }
        // v0 fetch: two sections split by flush packets. Section 1 holds
        // wants (+ caps on the first want line), shallow lines and deepen;
        // section 2 holds haves and `done`. A body with no data packets at
        // all (a bare flush) is a valid empty request: answer 200 empty,
        // as real upload-pack does when there is nothing to fetch.
        const dataPackets = packets.filter((p) => p.kind === 'data');
        if (dataPackets.length === 0) {
          sendBinary(res, store, 200, 'application/x-git-upload-pack-result', Buffer.alloc(0));
          return true;
        }
        const sections: string[][] = [[]];
        for (const p of packets) {
          if (p.kind === 'flush') {
            sections.push([]);
          } else if (p.kind === 'data') {
            let s = p.payload.toString('utf8');
            if (s.endsWith('\n')) s = s.slice(0, -1);
            sections[sections.length - 1].push(s);
          }
        }
        const wants: string[] = [];
        const haves: string[] = [];
        const shallow: string[] = [];
        let depth: number | null = null;
        let deepenRelative = false;
        let multiAck: 0 | 1 | 2 = 0;
        let done = false;
        let section2 = false;
        // A second flush packet means the client opened a second section,
        // even if it carries no lines (real upload-pack still answers NAK).
        if (packets.filter((p) => p.kind === 'flush').length >= 2) section2 = true;
        for (const line of sections[0] ?? []) {
          if (line.startsWith('want ')) {
            const rest = line.slice(5);
            const token = rest.split(' ')[0];
            if (isHex40(token)) wants.push(token);
            // Capabilities ride on the first want line.
            if (wants.length === 1) {
              if (rest.includes('multi_ack_detailed')) multiAck = 2;
              else if (rest.includes('multi_ack')) multiAck = 1;
              // `deepen-relative` is also a want-line capability token
              // in v0 (fetch-pack appends it to the first want line).
              if (rest.includes('deepen-relative')) deepenRelative = true;
            }
          } else if (line.startsWith('shallow ')) {
            shallow.push(line.slice(8).trim());
          } else if (line.startsWith('deepen ')) {
            const n = Number(line.slice(7).trim());
            if (Number.isFinite(n)) depth = n;
          } else if (line === 'deepen-relative') deepenRelative = true;
        }
        for (const section of sections.slice(1)) {
          for (const line of section) {
            if (line.startsWith('have ')) {
              haves.push(line.slice(5).trim());
              section2 = true;
            } else if (line === 'done') {
              done = true;
              section2 = true;
            }
          }
        }
        if (wants.length === 0) throw new PktError('pktline-header');
        if (deepenRelative && depth !== null) {
          depth = relativeToAbsoluteDepth(store, repo, wants, shallow, depth);
        }
        body = buildFetchResponseV0(store, repo, wants, haves, shallow, depth, multiAck, done, section2);
        sendBinary(res, store, 200, 'application/x-git-upload-pack-result', body);
        return true;
      } catch (err) {
        // A malformed POST body must never crash the server.
        sendError(res, store, 400, err instanceof Error ? err.message : 'malformed pkt-line');
        return true;
      }
    }

    if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) {
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      const raw = await readRawBody(req);
      if (!raw.ok) {
        sendError(res, store, 400, 'malformed pkt-line');
        return true;
      }
      try {
        const body = handleReceivePack(store, repo, raw.data);
        sendBinary(res, store, 200, 'application/x-git-receive-pack-result', body);
      } catch (err) {
        sendError(res, store, 400, err instanceof Error ? err.message : 'malformed pkt-line');
      }
      return true;
    }
  } catch (err) {
    try {
      sendError(res, store, 500, err instanceof Error ? err.message : 'Internal Server Error');
    } catch {
      try {
        res.destroy();
      } catch {
        // Nothing left to do for this socket.
      }
    }
    return true;
  }

  return false;
};
