// REST v3 surface for github-core-clone-01.
// Implements GET/POST /user, /user/repos, repo CRUD, git refs / branches /
// commits, contents, labels, issues (+comments) and pulls (+merge) over the
// shared Store. Every reply is JSON with a non-empty X-GitHub-Request-Id
// (sendJson/sendError set it). No wall clock, no randomness, Node stdlib only.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store, RepoRec, IssueRec, CommentRec, PullRec } from './store.ts';
import {
  sendJson,
  sendError,
  readJsonBody,
  bearerToken,
  parseQuery,
  decodeSeg,
  splitPath,
  pathOf,
  requestId,
  type SurfaceHandler,
} from './http.ts';
import { b64decode, isHex40 } from './util.ts';

// ---------------------------------------------------------------- shapes

function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
  };
}

function issueJson(issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function commentJson(comment: CommentRec): Record<string, unknown> {
  return { id: comment.id, body: comment.body, created_at: comment.createdAt };
}

function pullJson(pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

// ---------------------------------------------------------------- helpers

function bodyObj(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parsePage(q: URLSearchParams): { perPage: number; page: number } {
  const perRaw = Number(q.get('per_page') ?? '');
  const pageRaw = Number(q.get('page') ?? '');
  const perPage = Number.isFinite(perRaw) && perRaw >= 1 ? Math.floor(perRaw) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
  return { perPage, page };
}

function pageSlice<T>(items: T[], perPage: number, page: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

function nextLink(req: IncomingMessage, basePath: string, perPage: number, page: number, total: number): string | null {
  if (page * perPage >= total) return null;
  const host = req.headers.host ?? '127.0.0.1';
  const sep = basePath.includes('?') ? '&' : '?';
  return `http://${host}${basePath}${sep}per_page=${perPage}&page=${page + 1}`;
}

function parseNumber(seg: string | undefined): number | null {
  if (seg === undefined || !/^\d+$/.test(seg)) return null;
  const n = Number(seg);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** Walk a commit's ancestry, newest first (first-parent order via DFS). */
function commitHistory(store: Store, repo: RepoRec, tip: string): { sha: string; message: string }[] {
  const out: { sha: string; message: string }[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parsed = store.parseCommit(obj.data);
    out.push({ sha: oid, message: parsed.message });
    for (let i = parsed.parents.length - 1; i >= 0; i -= 1) stack.push(parsed.parents[i]);
  }
  return out;
}

function sendNoContent(res: ServerResponse, store: Store): void {
  res.writeHead(204, { 'x-github-request-id': requestId(store) });
  res.end();
}

// ---------------------------------------------------------------- handler

export const handleRest: SurfaceHandler = async (
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
): Promise<boolean> => {
  const path = pathOf(req);
  if (!path.startsWith('/api/v3/') && path !== '/api/v3') return false;
  const method = req.method ?? 'GET';

  // Auth: every REST route needs a bearer token. A wrong token names a
  // foreign owner (ownerForToken), so repos under other owners 404 below.
  const token = bearerToken(req);
  if (token === null) {
    sendError(res, store, 401, 'Requires authentication');
    return true;
  }
  const owner = store.ownerForToken(token) as string;

  // Read (and validate) a JSON body for the methods that carry one.
  let body: unknown = {};
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      sendError(res, store, 400, 'Malformed JSON body');
      return true;
    }
    body = parsed.value;
  }
  const b = bodyObj(body);
  const q = parseQuery(req);
  const segs = splitPath(path).slice(2); // drop 'api', 'v3'

  // ---- /api/v3/user ------------------------------------------------------
  if (segs.length === 1 && segs[0] === 'user') {
    if (method !== 'GET') {
      sendError(res, store, 404, 'Not Found');
      return true;
    }
    sendJson(res, store, 200, { login: owner, id: 1000, type: 'User' });
    return true;
  }

  // ---- /api/v3/user/repos -------------------------------------------------
  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'GET') {
      const { perPage, page } = parsePage(q);
      const all = store.reposOf(owner);
      const items = pageSlice(all, perPage, page).map(repoJson);
      const extra: Record<string, string> = {};
      const next = nextLink(req, '/api/v3/user/repos', perPage, page, all.length);
      if (next !== null) extra.link = `<${next}>; rel="next"`;
      sendJson(res, store, 200, items, extra);
      return true;
    }
    if (method === 'POST') {
      const name = str(b.name);
      if (name === undefined || name === '') {
        sendError(res, store, 422, 'Repository name is required');
        return true;
      }
      const created = store.createRepo(owner, name, {
        description: str(b.description),
        private: typeof b.private === 'boolean' ? b.private : undefined,
        defaultBranch: str(b.default_branch),
      });
      if (created === null) {
        sendError(res, store, 422, 'Repository already exists');
        return true;
      }
      sendJson(res, store, 201, repoJson(created));
      return true;
    }
    sendError(res, store, 404, 'Not Found');
    return true;
  }

  // ---- /api/v3/meta -------------------------------------------------------
  if (segs.length === 1 && segs[0] === 'meta') {
    if (method !== 'GET') {
      sendError(res, store, 404, 'Not Found');
      return true;
    }
    sendJson(res, store, 200, { installed_version: '1.0.0' });
    return true;
  }

  // ---- /api/v3/repos/{owner}/{name}[/...] --------------------------------
  if (segs.length >= 3 && segs[0] === 'repos') {
    const repoOwner = decodeSeg(segs[1]);
    const repoName = decodeSeg(segs[2]);
    // Same name under another owner -> 404, never 403. A foreign token also
    // names a foreign owner, so its view of anyone else's repos is empty.
    if (repoOwner === null || repoName === null || repoOwner !== owner) {
      sendError(res, store, 404, 'Not Found');
      return true;
    }
    const repo = store.getRepo(repoOwner, repoName);
    if (repo === undefined) {
      sendError(res, store, 404, 'Not Found');
      return true;
    }
    const rest = segs.slice(3);

    // -- repo itself --
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, store, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        const desc = str(b.description);
        if (desc !== undefined) repo.description = desc;
        if (typeof b.private === 'boolean') repo.private = b.private;
        repo.updatedAt = store.nowIso;
        sendJson(res, store, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(repoOwner, repoName);
        sendNoContent(res, store);
        return true;
      }
      sendError(res, store, 404, 'Not Found');
      return true;
    }

    // -- git refs: POST create branch; GET one ref / list --
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = str(b.ref);
        const sha = str(b.sha);
        if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || !isHex40(sha)) {
          sendError(res, store, 422, 'Invalid ref or sha');
          return true;
        }
        repo.refs.set(ref, sha.toLowerCase());
        sendJson(res, store, 201, { ref, object: { sha: sha.toLowerCase() } });
        return true;
      }
      if (method === 'GET') {
        if (rest.length === 2) {
          const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha } }));
          sendJson(res, store, 200, all);
          return true;
        }
        const refname = `refs/${rest.slice(2).map((s) => decodeSeg(s) ?? '').join('/')}`;
        const sha = repo.refs.get(refname);
        if (sha === undefined) {
          sendError(res, store, 404, 'Not Found');
          return true;
        }
        sendJson(res, store, 200, { ref: refname, object: { sha } });
        return true;
      }
      sendError(res, store, 404, 'Not Found');
      return true;
    }

    // -- branches --
    if (rest.length === 1 && rest[0] === 'branches') {
      if (method !== 'GET') {
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      const branches: { name: string; commit: { sha: string } }[] = [];
      for (const [ref, sha] of repo.refs) {
        if (ref.startsWith('refs/heads/')) {
          branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
        }
      }
      sendJson(res, store, 200, branches);
      return true;
    }

    // -- commits --
    if (rest.length === 1 && rest[0] === 'commits') {
      if (method !== 'GET') {
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      const refParam = q.get('sha') ?? undefined;
      const tip = store.resolveRef(repo, refParam);
      if (tip === undefined) {
        if (refParam !== undefined && refParam !== '') {
          sendError(res, store, 404, 'Not Found');
          return true;
        }
        sendJson(res, store, 200, []);
        return true;
      }
      const history = commitHistory(store, repo, tip).map((c) => ({
        sha: c.sha,
        commit: {
          message: c.message,
          author: { name: store.viewerLogin, email: `${store.viewerLogin}@example.invalid`, date: store.nowIso },
          committer: { name: store.viewerLogin, email: `${store.viewerLogin}@example.invalid`, date: store.nowIso },
        },
      }));
      sendJson(res, store, 200, history);
      return true;
    }

    // -- contents --
    if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).map((s) => decodeSeg(s) ?? '').join('/');
      if (method === 'PUT') {
        const contentB64 = str(b.content);
        const message = str(b.message) ?? '';
        const branch = str(b.branch) ?? repo.defaultBranch;
        if (contentB64 === undefined) {
          sendError(res, store, 400, 'Content is required');
          return true;
        }
        const content = b64decode(contentB64);
        if (content === null) {
          sendError(res, store, 400, 'Content is not valid base64');
          return true;
        }
        const existed = store.readContents(repo, branch, contentPath);
        const result = store.writeContents(repo, {
          branch,
          path: contentPath,
          content,
          message,
          expectedSha: str(b.sha),
        });
        if ('error' in result) {
          if (result.error === 'stale-sha') sendError(res, store, 409, 'Stale sha: file has changed');
          else sendError(res, store, 404, 'Not Found');
          return true;
        }
        const blobSha = store.oidFor('blob', content);
        const name = contentPath.split('/').pop() ?? contentPath;
        sendJson(res, store, existed !== undefined && existed.kind === 'file' ? 200 : 201, {
          content: {
            name,
            path: contentPath,
            sha: blobSha,
            size: content.length,
            type: 'file',
            encoding: 'base64',
            content: content.toString('base64'),
          },
          commit: { sha: result.commit },
        });
        return true;
      }
      if (method === 'GET') {
        const refParam = q.get('ref') ?? undefined;
        const found = store.readContents(repo, refParam, contentPath);
        if (found === undefined) {
          sendError(res, store, 404, 'Not Found');
          return true;
        }
        if (found.kind === 'file') {
          const name = contentPath.split('/').pop() ?? contentPath;
          sendJson(res, store, 200, {
            type: 'file',
            name,
            path: contentPath,
            encoding: 'base64',
            content: found.data.toString('base64'),
            sha: found.oid,
            size: found.data.length,
          });
          return true;
        }
        sendJson(
          res,
          store,
          200,
          found.entries.map((e) => ({ type: e.type, name: e.name, path: e.path, sha: e.oid })),
        );
        return true;
      }
      if (method === 'DELETE') {
        const message = str(b.message) ?? '';
        const sha = str(b.sha);
        const branch = str(b.branch) ?? repo.defaultBranch;
        if (sha === undefined) {
          sendError(res, store, 400, 'Sha is required');
          return true;
        }
        const result = store.deleteContents(repo, { branch, path: contentPath, message, sha });
        if ('error' in result) {
          if (result.error === 'stale-sha') sendError(res, store, 409, 'Stale sha: file has changed');
          else sendError(res, store, 404, 'Not Found');
          return true;
        }
        sendJson(res, store, 200, { commit: { sha: result.commit } });
        return true;
      }
      sendError(res, store, 404, 'Not Found');
      return true;
    }

    // -- labels --
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'POST') {
        const name = str(b.name);
        if (name === undefined || name === '') {
          sendError(res, store, 422, 'Label name is required');
          return true;
        }
        const label = store.createLabel(repo, name, str(b.color) ?? 'ededed');
        sendJson(res, store, 201, { name: label.name, color: label.color });
        return true;
      }
      if (method === 'GET') {
        sendJson(
          res,
          store,
          200,
          [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })),
        );
        return true;
      }
      sendError(res, store, 404, 'Not Found');
      return true;
    }

    // -- issues --
    if (rest[0] === 'issues') {
      // /issues
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = str(b.title) ?? '';
          const issueBody = str(b.body) ?? '';
          const rawLabels = Array.isArray(b.labels) ? b.labels : [];
          const labels: string[] = [];
          for (const item of rawLabels) {
            if (typeof item === 'string') labels.push(item);
            else if (item !== null && typeof item === 'object') {
              const n = str((item as Record<string, unknown>).name);
              if (n !== undefined) labels.push(n);
            }
          }
          const issue = store.createIssue(repo, { title, body: issueBody, labels });
          if (issue === null) {
            sendError(res, store, 422, 'Unknown label');
            return true;
          }
          sendJson(res, store, 201, issueJson(issue));
          return true;
        }
        if (method === 'GET') {
          const { perPage, page } = parsePage(q);
          const list = store.listIssues(repo, {
            state: q.get('state') ?? undefined,
            sort: q.get('sort') ?? undefined,
            direction: q.get('direction') ?? undefined,
          });
          sendJson(res, store, 200, pageSlice(list, perPage, page).map(issueJson));
          return true;
        }
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      // /issues/{n}[/comments]
      const n = parseNumber(rest[1]);
      if (n === null) {
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          const issue = store.getIssue(repo, n);
          if (issue === undefined) {
            sendError(res, store, 404, 'Not Found');
            return true;
          }
          sendJson(res, store, 200, issueJson(issue));
          return true;
        }
        if (method === 'PATCH') {
          const patched = store.patchIssue(repo, n, {
            state: str(b.state),
            title: str(b.title),
            body: str(b.body),
          });
          if (patched === undefined) {
            sendError(res, store, 404, 'Not Found');
            return true;
          }
          sendJson(res, store, 200, issueJson(patched));
          return true;
        }
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'POST') {
          const commentBody = str(b.body) ?? '';
          const comment = store.addComment(repo, n, commentBody);
          if (comment === undefined) {
            sendError(res, store, 404, 'Not Found');
            return true;
          }
          sendJson(res, store, 201, commentJson(comment));
          return true;
        }
        if (method === 'GET') {
          if (store.getIssue(repo, n) === undefined) {
            sendError(res, store, 404, 'Not Found');
            return true;
          }
          sendJson(res, store, 200, store.listComments(repo, n).map(commentJson));
          return true;
        }
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      sendError(res, store, 404, 'Not Found');
      return true;
    }

    // -- pulls --
    if (rest[0] === 'pulls') {
      // /pulls
      if (rest.length === 1) {
        if (method === 'POST') {
          const head = str(b.head);
          const base = str(b.base);
          if (head === undefined || base === undefined) {
            sendError(res, store, 422, 'Head and base branches are required');
            return true;
          }
          const pull = store.createPull(repo, {
            title: str(b.title) ?? '',
            body: str(b.body) ?? '',
            headRef: head,
            baseRef: base,
          });
          if (pull === null) {
            sendError(res, store, 422, 'Unknown head or base branch');
            return true;
          }
          sendJson(res, store, 201, pullJson(pull));
          return true;
        }
        if (method === 'GET') {
          const { perPage, page } = parsePage(q);
          const list = store.listPulls(repo, q.get('state') ?? 'open');
          sendJson(res, store, 200, pageSlice(list, perPage, page).map(pullJson));
          return true;
        }
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      // /pulls/{n}[/files | /merge]
      const n = parseNumber(rest[1]);
      if (n === null) {
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          const pull = store.getPull(repo, n);
          if (pull === undefined) {
            sendError(res, store, 404, 'Not Found');
            return true;
          }
          sendJson(res, store, 200, pullJson(pull));
          return true;
        }
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method !== 'GET') {
          sendError(res, store, 404, 'Not Found');
          return true;
        }
        const pull = store.getPull(repo, n);
        if (pull === undefined) {
          sendError(res, store, 404, 'Not Found');
          return true;
        }
        sendJson(res, store, 200, store.pullFiles(repo, pull));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') {
          sendError(res, store, 404, 'Not Found');
          return true;
        }
        const pull = store.getPull(repo, n);
        if (pull === undefined) {
          sendError(res, store, 404, 'Not Found');
          return true;
        }
        const result = store.mergePullSquash(repo, pull);
        if ('conflict' in result) {
          sendError(res, store, 405, 'Merge conflict');
          return true;
        }
        if ('error' in result) {
          sendError(res, store, 405, 'Pull request is not open');
          return true;
        }
        sendJson(res, store, 200, {
          merged: true,
          sha: result.sha,
          message: `Merged pull request #${pull.number}`,
        });
        return true;
      }
      sendError(res, store, 404, 'Not Found');
      return true;
    }

    // Unknown sub-route under a known repo.
    sendError(res, store, 404, 'Not Found');
    return true;
  }

  // Unknown route under /api/v3.
  sendError(res, store, 404, 'Not Found');
  return true;
};
