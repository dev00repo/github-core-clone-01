// MCP surface: JSON-RPC 2.0 over Streamable HTTP on POST /mcp.
// Modern era 2026-07-28 (server/discover) + legacy eras (initialize).
// Thin layer over the shared Store; no wall clock, no randomness.
// Written from scratch for the github-core-clone-01 bounty.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store, RepoRec, IssueRec, PullRec } from './store.ts';
import {
  bearerToken,
  readRawBody,
  requestId,
  sendError,
  sendJson,
  type SurfaceHandler,
} from './http.ts';
import { sha1Hex } from './util.ts';

const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const SUPPORTED_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

type JsonObj = Record<string, unknown>;

function isObj(v: unknown): v is JsonObj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

/** Normalize a name for suffix/alias matching: lowercase, alphanumerics only. */
function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// Tools table. Built once at module load; the tools/list answer is the same
// serialized array on every call (byte-for-byte idempotence).
// Required properties are ONLY the documented arguments for each tool.
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, JsonObj>;
    required: string[];
  };
  aliases: string[];
}

function tool(
  name: string,
  description: string,
  properties: Record<string, JsonObj>,
  required: string[],
  aliases: string[],
): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required }, aliases };
}

const TOOLS: ToolDef[] = [
  tool(
    'create_repo',
    'Create a new repository owned by the authenticated user.',
    {
      name: { type: 'string', description: 'Name of the repository to create.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
      owner: { type: 'string', description: 'Owner login; ignored unless it is the viewer login.' },
    },
    ['name'],
    ['create_repository', 'repo_create', 'repos_create', 'repository_create'],
  ),
  tool(
    'get_repo',
    'Get a repository by owner and name.',
    {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Name of the repository.' },
    },
    ['owner', 'repo'],
    ['get_repository', 'repo_get', 'repos_get', 'repository_get'],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Name of the repository.' },
      title: { type: 'string', description: 'Title of the issue.' },
      body: { type: 'string', description: 'Body of the issue.' },
    },
    ['owner', 'repo', 'title'],
    ['issue_create', 'issues_create'],
  ),
  tool(
    'list_issues',
    'List issues in a repository, optionally filtered by state.',
    {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Name of the repository.' },
      state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
    },
    ['owner', 'repo'],
    ['issues_list', 'issue_list'],
  ),
  tool(
    'create_pull_request',
    'Create a pull request from a head branch into a base branch.',
    {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Name of the repository.' },
      title: { type: 'string', description: 'Title of the pull request.' },
      head: { type: 'string', description: 'Head branch name.' },
      base: { type: 'string', description: 'Base branch name.' },
      body: { type: 'string', description: 'Body of the pull request.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
    ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create'],
  ),
  tool(
    'merge_pull_request',
    'Merge a pull request with the squash method.',
    {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Name of the repository.' },
      pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
    },
    ['owner', 'repo', 'pull_number'],
    ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge'],
  ),
];

/** Public wire form of a tool (no aliases — those are matching-only). */
const TOOLS_WIRE = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
}));

/** Resolve a requested tool name (canonical, alias, or server-prefixed suffix). */
function resolveTool(name: string): ToolDef | undefined {
  const n = normName(name);
  for (const t of TOOLS) {
    if (normName(t.name) === n) return t;
    for (const a of t.aliases) if (normName(a) === n) return t;
  }
  for (const t of TOOLS) {
    const canon = normName(t.name);
    if (n.length > canon.length && n.endsWith(canon)) return t;
    for (const a of t.aliases) {
      const an = normName(a);
      if (n.length > an.length && n.endsWith(an)) return t;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Argument synonyms (suite ARGUMENT_SYNONYMS). First present synonym wins.
// ---------------------------------------------------------------------------

const SYNONYMS: Record<string, string[]> = {
  owner: ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'],
  repo: ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'],
  name: ['name', 'repo', 'repository', 'repository_name', 'repo_name'],
  title: ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'],
  body: ['body', 'issue_body', 'description', 'content', 'text', 'comment'],
  description: ['description', 'about', 'summary', 'body'],
  private: ['private', 'is_private'],
  state: ['state', 'status'],
  head: ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'],
  base: ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'],
  pull_number: ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
};

/** Canonical argument list per tool, in documented order. */
const TOOL_ARGS: Record<string, string[]> = {
  create_repo: ['name', 'description', 'private', 'owner'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title', 'body'],
  list_issues: ['owner', 'repo', 'state'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base', 'body'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

/**
 * Normalize raw arguments onto a tool's canonical names. Synonyms are tried
 * in suite order; a `full_name` of "owner/repo" fills owner/repo when they
 * are otherwise absent, and owner/repo are synthesized into full_name.
 */
function normalizeArgs(raw: unknown, toolName: string): JsonObj {
  const src: JsonObj = isObj(raw) ? raw : {};
  const out: JsonObj = {};
  for (const canon of TOOL_ARGS[toolName] ?? []) {
    const syns = SYNONYMS[canon] ?? [canon];
    for (const s of syns) {
      if (src[s] !== undefined && src[s] !== null) {
        out[canon] = src[s];
        break;
      }
    }
  }
  // full_name fallback: "owner/repo" fills owner/repo when absent.
  if ((out.owner === undefined || out.repo === undefined) && typeof src.full_name === 'string') {
    const parts = src.full_name.split('/');
    if (parts.length === 2) {
      if (out.owner === undefined) out.owner = parts[0];
      if (out.repo === undefined) out.repo = parts[1];
    }
  }
  if (typeof out.owner === 'string' && typeof out.repo === 'string') {
    out.full_name = `${out.owner}/${out.repo}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Result shapes (shared with REST: same ids, same numbers).
// ---------------------------------------------------------------------------

function repoJson(store: Store, repo: RepoRec): JsonObj {
  return {
    id: store.gid('repo', `${repo.owner}/${repo.name}`),
    databaseId: repo.id,
    name: repo.name,
    owner: { login: repo.owner },
    owner_login: repo.owner,
    full_name: `${repo.owner}/${repo.name}`,
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    defaultBranch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueJson(store: Store, repo: RepoRec, issue: IssueRec): JsonObj {
  return {
    id: store.gid('issue', `${repo.owner}/${repo.name}#${issue.number}`),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => l.name),
    owner: repo.owner,
    repo: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullJson(store: Store, repo: RepoRec, pull: PullRec): JsonObj {
  return {
    id: store.gid('pull', `${repo.owner}/${repo.name}#${pull.number}`),
    databaseId: pull.id,
    number: pull.number,
    pull_number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    head_ref: pull.headRef,
    base_ref: pull.baseRef,
    head_sha: pull.headSha,
    base_sha: pull.baseSha,
    owner: repo.owner,
    repo: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

/** A successful tool result: text JSON + structuredContent of the same object. */
function toolOk(result: JsonObj): JsonObj {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

/** A failed tool result: isError with a plain-text message. */
function toolErr(message: string): JsonObj {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

function sessionId(store: Store): string {
  return `sess-${sha1Hex(`${store.token}:mcp`).slice(0, 16)}`;
}

function rpcHeaders(store: Store, version: string, req: IncomingMessage): Record<string, string> {
  const extra: Record<string, string> = {
    'mcp-protocol-version': version,
    'mcp-session-id': sessionId(store),
  };
  return extra;
}

function sendRpc(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  status: number,
  id: unknown,
  payload: { result: unknown } | { error: { code: number; message: string; data?: unknown } },
  version: string,
): void {
  const body: JsonObj = { jsonrpc: '2.0', id: id === undefined ? null : id, ...payload };
  sendJson(res, store, status, body, rpcHeaders(store, version, req));
}

function sendEmpty(req: IncomingMessage, res: ServerResponse, store: Store, version: string): void {
  res.writeHead(200, {
    'x-github-request-id': requestId(store),
    'mcp-protocol-version': version,
    'mcp-session-id': sessionId(store),
  });
  res.end();
}

/** Best-effort id extraction from a malformed body (for the -32700 answer). */
function sniffId(text: string): unknown {
  const m = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(text);
  if (m === null) return null;
  const raw = m[1];
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return Number(raw);
}

/** Negotiated version declared by the request's _meta (modern) or params. */
function metaVersion(body: JsonObj): string | undefined {
  const meta = body._meta;
  if (isObj(meta)) {
    const v = meta['io.modelcontextprotocol/protocolVersion'];
    if (typeof v === 'string') return v;
    if (typeof meta.protocolVersion === 'string') return meta.protocolVersion;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

function missingRequired(def: ToolDef, args: JsonObj): string[] {
  const missing: string[] = [];
  for (const req of def.inputSchema.required) {
    const v = args[req];
    if (v === undefined || v === null || (typeof v === 'string' && v === '')) missing.push(req);
  }
  return missing;
}

function callTool(store: Store, viewer: string, name: string, rawArgs: unknown): JsonObj {
  const def = resolveTool(name);
  if (def === undefined) {
    // Unknown tool is reported by the caller as a JSON-RPC -32602 error.
    return { __unknownTool: true };
  }
  const args = normalizeArgs(rawArgs, def.name);
  const missing = missingRequired(def, args);
  if (missing.length > 0) {
    return toolErr(`Missing required argument(s): ${missing.join(', ')}`);
  }

  switch (def.name) {
    case 'create_repo': {
      const repoName = asStr(args.name) ?? '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName) || repoName.endsWith('.git')) {
        return toolErr(`Invalid repository name: ${repoName}`);
      }
      // The owner argument is accepted and ignored: repos are created under
      // the viewer login (or under the given owner only when it is the viewer).
      const repo = store.createRepo(viewer, repoName, {
        description: asStr(args.description) ?? '',
        private: args.private === true,
      });
      if (repo === null) return toolErr(`Repository already exists: ${viewer}/${repoName}`);
      return toolOk(repoJson(store, repo));
    }
    case 'get_repo': {
      const owner = asStr(args.owner) ?? '';
      const repoName = asStr(args.repo) ?? '';
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`Repository not found: ${owner}/${repoName}`);
      return toolOk(repoJson(store, repo));
    }
    case 'create_issue': {
      const owner = asStr(args.owner) ?? '';
      const repoName = asStr(args.repo) ?? '';
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`Repository not found: ${owner}/${repoName}`);
      const issue = store.createIssue(repo, {
        title: asStr(args.title) ?? '',
        body: asStr(args.body) ?? '',
        labels: [],
      });
      if (issue === null) return toolErr('Could not create issue: unknown label');
      return toolOk(issueJson(store, repo, issue));
    }
    case 'list_issues': {
      const owner = asStr(args.owner) ?? '';
      const repoName = asStr(args.repo) ?? '';
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`Repository not found: ${owner}/${repoName}`);
      const state = asStr(args.state) ?? 'open';
      const issues = store.listIssues(repo, { state });
      const result: JsonObj = {
        issues: issues.map((i) => issueJson(store, repo, i)),
        total_count: issues.length,
        state,
        owner,
        repo: repoName,
        full_name: `${owner}/${repoName}`,
      };
      return toolOk(result);
    }
    case 'create_pull_request': {
      const owner = asStr(args.owner) ?? '';
      const repoName = asStr(args.repo) ?? '';
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`Repository not found: ${owner}/${repoName}`);
      const pull = store.createPull(repo, {
        title: asStr(args.title) ?? '',
        body: asStr(args.body) ?? '',
        headRef: asStr(args.head) ?? '',
        baseRef: asStr(args.base) ?? '',
      });
      if (pull === null) {
        return toolErr(
          `Could not create pull request: head or base branch not found: ${asStr(args.head) ?? ''} -> ${asStr(args.base) ?? ''}`,
        );
      }
      return toolOk(pullJson(store, repo, pull));
    }
    case 'merge_pull_request': {
      const owner = asStr(args.owner) ?? '';
      const repoName = asStr(args.repo) ?? '';
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`Repository not found: ${owner}/${repoName}`);
      const n = asNum(args.pull_number);
      if (n === undefined) return toolErr('Missing required argument(s): pull_number');
      const pull = store.getPull(repo, n);
      if (pull === undefined) return toolErr(`Pull request not found: ${owner}/${repoName}#${n}`);
      const merged = store.mergePullSquash(repo, pull);
      if ('error' in merged) return toolErr(`Pull request is not open: ${owner}/${repoName}#${n}`);
      if ('conflict' in merged) return toolErr(`Merge conflict: ${owner}/${repoName}#${n}`);
      const out = pullJson(store, repo, pull);
      out.merge_commit_sha = merged.sha;
      out.sha = merged.sha;
      return toolOk(out);
    }
    default:
      return toolErr(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handleMcp: SurfaceHandler = async (req, res, store) => {
  if (req.method !== 'POST') return false;
  try {
    // Auth first: no Authorization header -> 401, before any tool exists.
    const token = bearerToken(req);
    if (token === null) {
      sendError(res, store, 401, 'Authorization required');
      return true;
    }
    const viewer = store.ownerForToken(token) ?? store.viewerLogin;

    const raw = await readRawBody(req);
    if (!raw.ok) {
      sendRpc(req, res, store, 400, null, {
        error: { code: -32700, message: 'Parse error: request body too large or unreadable' },
      }, MODERN_REVISION);
      return true;
    }
    const text = raw.data.toString('utf8').trim();
    if (text === '') {
      sendRpc(req, res, store, 400, null, {
        error: { code: -32700, message: 'Parse error: empty request body' },
      }, MODERN_REVISION);
      return true;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      sendRpc(req, res, store, 400, sniffId(text), {
        error: { code: -32700, message: 'Parse error: malformed JSON' },
      }, MODERN_REVISION);
      return true;
    }
    if (!isObj(body)) {
      sendRpc(req, res, store, 200, null, {
        error: { code: -32600, message: 'Invalid Request: expected a JSON-RPC object' },
      }, MODERN_REVISION);
      return true;
    }

    const id: unknown = 'id' in body ? body.id : undefined;
    const method = typeof body.method === 'string' ? body.method : '';
    const params: JsonObj = isObj(body.params) ? body.params : {};
    const version = metaVersion(body) ?? MODERN_REVISION;

    // Notifications never get a JSON-RPC response (HTTP 200, empty body).
    if (method.startsWith('notifications/') || id === undefined) {
      sendEmpty(req, res, store, version);
      return true;
    }

    if (method === '') {
      sendRpc(req, res, store, 200, id, {
        error: { code: -32600, message: 'Invalid Request: missing method' },
      }, version);
      return true;
    }

    // --- server/discover (modern era, mandatory RPC) ---
    if (method === 'server/discover') {
      const requested = metaVersion(body);
      if (requested !== undefined && !(SUPPORTED_VERSIONS as readonly string[]).includes(requested)) {
        sendRpc(req, res, store, 200, id, {
          error: {
            code: -32022,
            message: 'UnsupportedProtocolVersionError',
            data: { supported: [...SUPPORTED_VERSIONS] },
          },
        }, MODERN_REVISION);
        return true;
      }
      const negotiated = requested ?? MODERN_REVISION;
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      sendRpc(req, res, store, 200, id, {
        result: {
          protocolVersion: negotiated,
          serverInfo,
          capabilities: { tools: {} },
          supportedVersions: [...SUPPORTED_VERSIONS],
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        },
      }, negotiated);
      return true;
    }

    // --- initialize (legacy eras) ---
    if (method === 'initialize') {
      const offered = asStr(params.protocolVersion);
      if (offered === undefined || !(SUPPORTED_VERSIONS as readonly string[]).includes(offered)) {
        sendRpc(req, res, store, 200, id, {
          error: { code: -32602, message: `Unsupported protocol version: ${offered ?? ''}` },
        }, version);
        return true;
      }
      sendRpc(req, res, store, 200, id, {
        result: {
          protocolVersion: offered,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      }, offered);
      return true;
    }

    // --- tools/list ---
    if (method === 'tools/list') {
      sendRpc(req, res, store, 200, id, {
        result: { tools: TOOLS_WIRE },
      }, version);
      return true;
    }

    // --- tools/call ---
    if (method === 'tools/call') {
      const toolName = asStr(params.name);
      if (toolName === undefined || toolName === '') {
        sendRpc(req, res, store, 200, id, {
          error: { code: -32602, message: 'Invalid params: tools/call requires a tool name' },
        }, version);
        return true;
      }
      if (resolveTool(toolName) === undefined) {
        sendRpc(req, res, store, 200, id, {
          error: { code: -32602, message: `Unknown tool: ${toolName}` },
        }, version);
        return true;
      }
      const result = callTool(store, viewer, toolName, params.arguments);
      sendRpc(req, res, store, 200, id, { result }, version);
      return true;
    }

    // --- unknown method ---
    sendRpc(req, res, store, 200, id, {
      error: { code: -32601, message: `Method not found: ${method}` },
    }, version);
    return true;
  } catch (err) {
    try {
      sendJson(res, store, 500, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' },
      });
    } catch {
      try {
        res.destroy();
      } catch {
        // Nothing left to do for this socket.
      }
    }
    return true;
  }
};
