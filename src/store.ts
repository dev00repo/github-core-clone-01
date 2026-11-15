// The shared store: repos, git objects, issues, labels, comments, pull requests.
// One store backs REST, GraphQL, MCP and git — a repo or issue created over one
// surface reads back over the others as the same object.
//
// Determinism: ids come from counters or SHA-1 of stable keys; timestamps come
// only from MAKEFUN_TRIAL_NOW (see trialNow()). No wall clock, no Math.random.

import { sha1Hex } from './util.ts';
import { deriveScenario } from './scenario.ts';

export interface LabelRec {
  name: string;
  color: string;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: LabelRec[];
  createdAt: string;
  updatedAt: string;
}

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitObject {
  type: string;
  data: Buffer;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  comments: Map<number, CommentRec[]>;
  pulls: Map<number, PullRec>;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  nextIssue: number;
  nextPull: number;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'changed';
  additions: number;
  deletions: number;
  changes: number;
}

/** The scenario epoch: 2025-01-01T00:00:00Z, the fallback "now". */
export const SCENARIO_EPOCH_SEC = 1735689600;

/**
 * Parse the trial's "now" (MAKEFUN_TRIAL_NOW, opaque in the kit) into the ISO
 * string the store stamps on records and the epoch seconds git commits carry.
 * Accepts an ISO date string, epoch seconds, or epoch milliseconds; anything
 * else falls back to the scenario epoch.
 */
export function trialNow(raw: string | undefined): { nowIso: string; nowEpoch: number } {
  const fallback = { nowIso: '2025-01-01T00:00:00Z', nowEpoch: SCENARIO_EPOCH_SEC };
  if (raw === undefined || raw === '') return fallback;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && raw.trim() !== '' && /^-?\d+(\.\d+)?$/.test(raw.trim())) {
    const epoch = asNumber > 1e12 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
    return { nowIso: new Date(epoch * 1000).toISOString(), nowEpoch: epoch };
  }
  const ms = Date.parse(raw);
  if (Number.isFinite(ms)) {
    return { nowIso: new Date(ms).toISOString(), nowEpoch: Math.floor(ms / 1000) };
  }
  return fallback;
}

/** Count the lines of a blob's text (a trailing newline ends the last line). */
export function lineCount(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

export class Store {
  readonly viewerLogin: string;
  readonly strangerLogin: string;
  readonly orgLogin: string;
  readonly token: string;
  readonly nowIso: string;
  readonly nowEpoch: number;
  readonly repos = new Map<string, RepoRec>();
  nextRepoId = 5000;
  nextIssueId = 1;
  nextCommentId = 1;
  nextPullId = 1;
  reqCounter = 0;

  constructor(opts: { token: string; nowIso: string; nowEpoch: number }) {
    const identity = deriveScenario();
    this.viewerLogin = identity.viewer;
    this.strangerLogin = identity.stranger;
    this.orgLogin = identity.org;
    this.token = opts.token;
    this.nowIso = opts.nowIso;
    this.nowEpoch = opts.nowEpoch;
  }

  /** The login a bearer token names: null = no token, viewer = the env token, else a foreign login. */
  ownerForToken(tok: string | null): string | null {
    if (tok === null) return null;
    if (this.token !== '' && tok === this.token) return this.viewerLogin;
    return `foreign-${sha1Hex(tok).slice(0, 12)}`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(
    owner: string,
    name: string,
    opts: { description?: string; private?: boolean; defaultBranch?: string } = {},
  ): RepoRec | null {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const repo: RepoRec = {
      id: this.nextRepoId,
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
      labels: new Map(),
      issues: new Map(),
      comments: new Map(),
      pulls: new Map(),
      refs: new Map(),
      objects: new Map(),
      nextIssue: 1,
      nextPull: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  reposOf(owner: string): RepoRec[] {
    const out: RepoRec[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out;
  }

  /** Opaque, stable global id. Never the plain databaseId/number. */
  gid(kind: 'repo' | 'issue' | 'pull' | 'comment', key: string): string {
    return `${kind}_${sha1Hex(`${kind}:${key}`).slice(0, 24)}`;
  }

  // ------------------------------------------------------------ git objects

  /** The object id for `type` + `data`: sha1("<type> <size>\0" + data). */
  oidFor(type: string, data: Buffer): string {
    const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
    return sha1Hex(Buffer.concat([header, data]));
  }

  putObject(repo: RepoRec, type: string, data: Buffer): string {
    const oid = this.oidFor(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: RepoRec, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** The identity entry-created commits carry: the viewer, as a GitHub author. */
  authorLine(epoch: number): string {
    return `${this.viewerLogin} <${this.viewerLogin}@example.invalid> ${epoch} +0000`;
  }

  putCommit(
    repo: RepoRec,
    c: {
      tree: string;
      parents: string[];
      authorName: string;
      authorEmail: string;
      committerName: string;
      committerEmail: string;
      epoch: number;
      message: string;
    },
  ): string {
    const lines: string[] = [`tree ${c.tree}`];
    for (const p of c.parents) lines.push(`parent ${p}`);
    lines.push(`author ${c.authorName} <${c.authorEmail}> ${c.epoch} +0000`);
    lines.push(`committer ${c.committerName} <${c.committerEmail}> ${c.epoch} +0000`);
    const data = Buffer.from(`${lines.join('\n')}\n\n${c.message}`, 'utf8');
    return this.putObject(repo, 'commit', data);
  }

  /** A commit the entry itself authors (contents writes, squash merges). */
  putEntryCommit(repo: RepoRec, tree: string, parents: string[], message: string): string {
    return this.putCommit(repo, {
      tree,
      parents,
      authorName: this.viewerLogin,
      authorEmail: `${this.viewerLogin}@example.invalid`,
      committerName: this.viewerLogin,
      committerEmail: `${this.viewerLogin}@example.invalid`,
      epoch: this.nowEpoch,
      message,
    });
  }

  parseCommit(data: Buffer): ParsedCommit {
    const text = data.toString('utf8');
    const head = text.split('\n\n', 1)[0];
    const message = text.includes('\n\n') ? text.slice(text.indexOf('\n\n') + 2) : '';
    let tree = '';
    const parents: string[] = [];
    let author = '';
    let committer = '';
    for (const line of head.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
      else if (line.startsWith('author ')) author = line.slice(7);
      else if (line.startsWith('committer ')) committer = line.slice(10);
    }
    return { tree, parents, author, committer, message };
  }

  /** Build a tree object from entries, sorted in git byte order. */
  putTree(repo: RepoRec, entries: TreeEntry[]): string {
    const sorted = [...entries].sort((a, b) => {
      const ka = Buffer.from(a.name + (a.mode === '40000' ? '/' : ''), 'utf8');
      const kb = Buffer.from(b.name + (b.mode === '40000' ? '/' : ''), 'utf8');
      const n = Math.min(ka.length, kb.length);
      for (let i = 0; i < n; i += 1) {
        if (ka[i] !== kb[i]) return ka[i] - kb[i];
      }
      return ka.length - kb.length;
    });
    const parts: Buffer[] = [];
    for (const e of sorted) {
      parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
      parts.push(Buffer.from(e.oid, 'hex'));
    }
    return this.putObject(repo, 'tree', Buffer.concat(parts));
  }

  parseTree(data: Buffer): TreeEntry[] {
    const out: TreeEntry[] = [];
    let i = 0;
    while (i < data.length) {
      const space = data.indexOf(0x20, i);
      const nul = data.indexOf(0x00, space + 1);
      if (space < 0 || nul < 0 || nul + 21 > data.length) break;
      const mode = data.subarray(i, space).toString('utf8');
      const name = data.subarray(space + 1, nul).toString('utf8');
      const oid = data.subarray(nul + 1, nul + 21).toString('hex');
      out.push({ mode, name, oid });
      i = nul + 21;
    }
    return out;
  }

  /** All blobs under a tree, keyed by path (recursive). */
  flattenTree(repo: RepoRec, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const seen = new Set<string>();
    const walk = (oid: string, pre: string): void => {
      if (seen.has(oid)) return;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const e of this.parseTree(obj.data)) {
        const path = pre === '' ? e.name : `${pre}/${e.name}`;
        if (e.mode === '40000') walk(e.oid, path);
        else out.set(path, { oid: e.oid, mode: e.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build the nested trees for a flat path -> blob map; returns the root tree oid. */
  buildTreeFromPaths(repo: RepoRec, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, file] of files) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        let child = node.dirs.get(parts[i]);
        if (child === undefined) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(parts[i], child);
        }
        node = child;
      }
      node.files.set(parts[parts.length - 1], file);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putTree(repo, entries);
    };
    return build(root);
  }

  /** A refname's tip commit oid, or undefined when the ref does not exist. */
  refTip(repo: RepoRec, refname: string): string | undefined {
    return repo.refs.get(refname);
  }

  /** The tree oid at a ref, or undefined when the ref (or its commit) is missing. */
  treeAtRef(repo: RepoRec, refname: string): string | undefined {
    const tip = repo.refs.get(refname);
    if (tip === undefined) return undefined;
    const obj = repo.objects.get(tip);
    if (obj === undefined || obj.type !== 'commit') return undefined;
    return this.parseCommit(obj.data).tree;
  }

  /** True when `anc` is reachable from `desc` (anc === desc counts). */
  isAncestor(repo: RepoRec, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    const seen = new Set<string>([desc]);
    const stack = [desc];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const p of this.parseCommit(obj.data).parents) {
        if (p === anc) return true;
        if (!seen.has(p)) {
          seen.add(p);
          stack.push(p);
        }
      }
    }
    return false;
  }

  /** Every object (commit/tree/blob/tag) reachable from the tip commits. */
  reachableObjects(repo: RepoRec, tips: string[]): Set<string> {
    const out = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      out.add(oid);
      if (obj.type === 'commit') {
        const c = this.parseCommit(obj.data);
        stack.push(c.tree, ...c.parents);
      } else if (obj.type === 'tree') {
        for (const e of this.parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (m !== null) stack.push(m[1]);
      }
    }
    return out;
  }

  /** First common ancestor of two commits (BFS from `b` over `a`'s ancestors). */
  mergeBase(repo: RepoRec, a: string, b: string): string | undefined {
    const ancestorsA = new Set<string>([a]);
    const stack = [a];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const p of this.parseCommit(obj.data).parents) {
        if (!ancestorsA.has(p)) {
          ancestorsA.add(p);
          stack.push(p);
        }
      }
    }
    const queue = [b];
    const seen = new Set<string>([b]);
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (ancestorsA.has(oid)) return oid;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const p of this.parseCommit(obj.data).parents) {
        if (!seen.has(p)) {
          seen.add(p);
          queue.push(p);
        }
      }
    }
    return undefined;
  }

  // ------------------------------------------------------------ contents

  /**
   * Resolve a `ref` query value to a commit oid: a branch name, a full refname,
   * or a raw commit oid. Defaults to the default branch.
   */
  resolveRef(repo: RepoRec, ref: string | undefined): string | undefined {
    const name = ref === undefined || ref === '' ? repo.defaultBranch : ref;
    if (/^[0-9a-f]{40}$/i.test(name)) {
      const obj = repo.objects.get(name.toLowerCase());
      return obj !== undefined && obj.type === 'commit' ? name.toLowerCase() : undefined;
    }
    if (name.startsWith('refs/')) return repo.refs.get(name);
    return repo.refs.get(`refs/heads/${name}`);
  }

  readContents(
    repo: RepoRec,
    ref: string | undefined,
    path: string,
  ):
    | { kind: 'file'; oid: string; data: Buffer }
    | { kind: 'dir'; entries: { name: string; path: string; oid: string; type: 'file' | 'dir' }[] }
    | undefined {
    const tip = this.resolveRef(repo, ref);
    if (tip === undefined) return undefined;
    const obj = repo.objects.get(tip);
    if (obj === undefined || obj.type !== 'commit') return undefined;
    const treeOid = this.parseCommit(obj.data).tree;
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (clean === '') {
      const root = repo.objects.get(treeOid);
      if (root === undefined) return undefined;
      const entries = this.parseTree(root.data).map((e) => ({
        name: e.name,
        path: e.name,
        oid: e.oid,
        type: (e.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
      }));
      return { kind: 'dir', entries };
    }
    const parts = clean.split('/');
    let current = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const node = repo.objects.get(current);
      if (node === undefined || node.type !== 'tree') return undefined;
      const entry = this.parseTree(node.data).find((e) => e.name === parts[i]);
      if (entry === undefined) return undefined;
      if (i === parts.length - 1) {
        if (entry.mode === '40000') {
          const sub = repo.objects.get(entry.oid);
          if (sub === undefined) return undefined;
          const entries = this.parseTree(sub.data).map((e) => ({
            name: e.name,
            path: `${clean}/${e.name}`,
            oid: e.oid,
            type: (e.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
          }));
          return { kind: 'dir', entries };
        }
        const blob = repo.objects.get(entry.oid);
        if (blob === undefined) return undefined;
        return { kind: 'file', oid: entry.oid, data: blob.data };
      }
      if (entry.mode !== '40000') return undefined;
      current = entry.oid;
    }
    return undefined;
  }

  /**
   * Write a file at `path` on `branch`, committing on top of the branch tip
   * (or a root commit when the branch is unborn). `expectedSha`, when given,
   * must equal the blob currently at `path` or the write is refused.
   */
  writeContents(
    repo: RepoRec,
    o: { branch: string; path: string; content: Buffer; message: string; expectedSha?: string },
  ): { commit: string } | { error: 'stale-sha' | 'no-such-branch' } {
    const refname = `refs/heads/${o.branch}`;
    const tip = repo.refs.get(refname);
    // A branch that does not exist cannot be written — unless the repo is
    // unborn (no refs at all), where any branch takes the root commit.
    if (tip === undefined && repo.refs.size > 0) return { error: 'no-such-branch' };
    let files = new Map<string, { oid: string; mode: string }>();
    const parents: string[] = [];
    if (tip !== undefined) {
      const obj = repo.objects.get(tip);
      if (obj === undefined || obj.type !== 'commit') return { error: 'no-such-branch' };
      files = this.flattenTree(repo, this.parseCommit(obj.data).tree);
      parents.push(tip);
    }
    if (o.expectedSha !== undefined) {
      const current = files.get(o.path);
      if (current === undefined || current.oid.toLowerCase() !== o.expectedSha.toLowerCase()) {
        return { error: 'stale-sha' };
      }
    }
    const blobOid = this.putObject(repo, 'blob', o.content);
    files.set(o.path, { oid: blobOid, mode: '100644' });
    const tree = this.buildTreeFromPaths(repo, files);
    const commit = this.putEntryCommit(repo, tree, parents, o.message);
    repo.refs.set(refname, commit);
    return { commit };
  }

  deleteContents(
    repo: RepoRec,
    o: { branch: string; path: string; message: string; sha: string },
  ): { commit: string } | { error: 'stale-sha' | 'no-such-file' | 'no-such-branch' } {
    const refname = `refs/heads/${o.branch}`;
    const tip = repo.refs.get(refname);
    if (tip === undefined) return { error: 'no-such-branch' };
    const obj = repo.objects.get(tip);
    if (obj === undefined || obj.type !== 'commit') return { error: 'no-such-branch' };
    const files = this.flattenTree(repo, this.parseCommit(obj.data).tree);
    const current = files.get(o.path);
    if (current === undefined) return { error: 'no-such-file' };
    if (current.oid.toLowerCase() !== o.sha.toLowerCase()) return { error: 'stale-sha' };
    files.delete(o.path);
    const tree = this.buildTreeFromPaths(repo, files);
    const commit = this.putEntryCommit(repo, tree, [tip], o.message);
    repo.refs.set(refname, commit);
    return { commit };
  }

  // ------------------------------------------------------------ labels / issues / comments

  createLabel(repo: RepoRec, name: string, color: string): LabelRec {
    const label: LabelRec = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  getLabel(repo: RepoRec, name: string): LabelRec | undefined {
    return repo.labels.get(name);
  }

  createIssue(
    repo: RepoRec,
    o: { title: string; body: string; labels: string[] },
  ): IssueRec | null {
    const labels: LabelRec[] = [];
    for (const name of o.labels) {
      const label = repo.labels.get(name);
      if (label === undefined) return null;
      labels.push(label);
    }
    const issue: IssueRec = {
      id: this.nextIssueId,
      number: repo.nextIssue,
      title: o.title,
      body: o.body,
      state: 'open',
      labels,
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
    };
    this.nextIssueId += 1;
    repo.nextIssue += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  getIssue(repo: RepoRec, n: number): IssueRec | undefined {
    return repo.issues.get(n);
  }

  listIssues(
    repo: RepoRec,
    o: { state?: string; sort?: string; direction?: string },
  ): IssueRec[] {
    const state = o.state ?? 'open';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    if ((o.direction ?? 'desc') === 'desc') list.reverse();
    return list;
  }

  patchIssue(
    repo: RepoRec,
    n: number,
    patch: { state?: string; title?: string; body?: string },
  ): IssueRec | undefined {
    const issue = repo.issues.get(n);
    if (issue === undefined) return undefined;
    if (patch.state === 'open' || patch.state === 'closed') issue.state = patch.state;
    if (typeof patch.title === 'string') issue.title = patch.title;
    if (typeof patch.body === 'string') issue.body = patch.body;
    issue.updatedAt = this.nowIso;
    return issue;
  }

  addComment(repo: RepoRec, issueNumber: number, body: string): CommentRec | undefined {
    if (!repo.issues.has(issueNumber)) return undefined;
    const comment: CommentRec = { id: this.nextCommentId, body, createdAt: this.nowIso };
    this.nextCommentId += 1;
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  listComments(repo: RepoRec, issueNumber: number): CommentRec[] {
    return repo.comments.get(issueNumber) ?? [];
  }

  // ------------------------------------------------------------ pull requests

  createPull(
    repo: RepoRec,
    o: { title: string; body: string; headRef: string; baseRef: string },
  ): PullRec | null {
    const headSha = repo.refs.get(`refs/heads/${o.headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${o.baseRef}`);
    if (headSha === undefined || baseSha === undefined) return null;
    const pull: PullRec = {
      id: this.nextPullId,
      number: repo.nextPull,
      title: o.title,
      body: o.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: o.headRef,
      headSha,
      baseRef: o.baseRef,
      baseSha,
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
    };
    this.nextPullId += 1;
    repo.nextPull += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  getPull(repo: RepoRec, n: number): PullRec | undefined {
    return repo.pulls.get(n);
  }

  listPulls(repo: RepoRec, state: string): PullRec[] {
    const list = [...repo.pulls.values()];
    if (state === 'all') return list;
    return list.filter((p) => p.state === state);
  }

  /** Line-level diff of two blobs: trim common prefix/suffix lines, count the rest. */
  diffBlobs(oldData: Buffer | undefined, newData: Buffer | undefined): { additions: number; deletions: number } {
    const oldLines = oldData === undefined ? [] : oldData.toString('utf8').split('\n');
    const newLines = newData === undefined ? [] : newData.toString('utf8').split('\n');
    const trim = (lines: string[]): string[] => {
      if (lines.length > 0 && lines[lines.length - 1] === '') return lines.slice(0, -1);
      return lines;
    };
    const a = trim(oldLines);
    const b = trim(newLines);
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < a.length - prefix &&
      suffix < b.length - prefix &&
      a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    return { additions: b.length - prefix - suffix, deletions: a.length - prefix - suffix };
  }

  /** Diff two trees (by oid) into per-file changes. */
  diffTrees(repo: RepoRec, baseTree: string | undefined, headTree: string | undefined): FileChange[] {
    const base = baseTree === undefined ? new Map() : this.flattenTree(repo, baseTree);
    const head = headTree === undefined ? new Map() : this.flattenTree(repo, headTree);
    const out: FileChange[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      if (b === undefined && h !== undefined) {
        const data = repo.objects.get(h.oid)?.data;
        const additions = data === undefined ? 0 : lineCount(data.toString('utf8'));
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b !== undefined && h === undefined) {
        const data = repo.objects.get(b.oid)?.data;
        const deletions = data === undefined ? 0 : lineCount(data.toString('utf8'));
        out.push({ filename: path, status: 'changed', additions: 0, deletions, changes: deletions });
      } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
        const d = this.diffBlobs(repo.objects.get(b.oid)?.data, repo.objects.get(h.oid)?.data);
        out.push({
          filename: path,
          status: 'modified',
          additions: d.additions,
          deletions: d.deletions,
          changes: d.additions + d.deletions,
        });
      }
    }
    out.sort((x, y) => (x.filename < y.filename ? -1 : x.filename > y.filename ? 1 : 0));
    return out;
  }

  /** The files of a pull: baseSha tree vs headSha tree. */
  pullFiles(repo: RepoRec, pull: PullRec): FileChange[] {
    const baseTree = this.treeOfCommit(repo, pull.baseSha);
    const headTree = this.treeOfCommit(repo, pull.headSha);
    return this.diffTrees(repo, baseTree, headTree);
  }

  treeOfCommit(repo: RepoRec, oid: string): string | undefined {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return undefined;
    return this.parseCommit(obj.data).tree;
  }

  /**
   * Squash-merge a pull onto its base branch. Conflict rule: for each path the
   * head changed against the merge-base, if the base tip's blob also differs
   * from the merge-base's blob and from the head's blob, the merge conflicts.
   */
  mergePullSquash(repo: RepoRec, pull: PullRec): { sha: string } | { conflict: true } | { error: 'not-open' } {
    if (pull.state !== 'open') return { error: 'not-open' };
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const base = this.mergeBase(repo, headTip, baseTip) ?? pull.baseSha;
    const baseTree = this.treeOfCommit(repo, base);
    const headTree = this.treeOfCommit(repo, headTip);
    const baseTipTree = this.treeOfCommit(repo, baseTip);
    if (headTree === undefined || baseTipTree === undefined) return { error: 'not-open' };
    const headChanges = this.diffTrees(repo, baseTree, headTree);
    const baseFiles = this.flattenTree(repo, baseTipTree);
    const mergeBaseFiles = baseTree === undefined ? new Map() : this.flattenTree(repo, baseTree);
    const headFiles = this.flattenTree(repo, headTree);
    for (const change of headChanges) {
      const fromBase = mergeBaseFiles.get(change.filename)?.oid;
      const atTip = baseFiles.get(change.filename)?.oid;
      const atHead = headFiles.get(change.filename)?.oid;
      if (fromBase !== atTip && atTip !== atHead) return { conflict: true };
    }
    const merged = new Map(baseFiles);
    for (const change of headChanges) {
      const atHead = headFiles.get(change.filename);
      if (atHead === undefined) merged.delete(change.filename);
      else merged.set(change.filename, atHead);
    }
    const tree = this.buildTreeFromPaths(repo, merged);
    const sha = this.putEntryCommit(repo, tree, [baseTip], pull.title);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso;
    pull.mergeCommitSha = sha;
    pull.updatedAt = this.nowIso;
    return { sha };
  }
}
