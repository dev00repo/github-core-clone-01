// GraphQL v4 surface for the github-core-clone-01 forge.
//
// A small purpose-built parser + executor for the documented subset only:
// fields, arguments (literals and $variables), aliases, inline fragments
// (`... on Repository`), the `node(id:)` query, and `__type` / `__schema`
// introspection probes. Dispatch is by operation shape; there is no general
// GraphQL engine here. Introspection is served from static tables, not a
// real schema. All ids are the store's opaque `gid()` values.
//
// Determinism: no wall clock, no Math.random, no unseeded randomness.
// Node 22 stdlib only.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store, RepoRec, IssueRec, PullRec, CommentRec } from './store.ts';
import { bearerToken, readJsonBody, sendError, sendJson, type SurfaceHandler } from './http.ts';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class GraphQLError extends Error {
  path: (string | number)[] | undefined;
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Tok {
  kind: TokKind;
  value: string;
  line: number;
  col: number;
}

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const push = (kind: TokKind, value: string, l: number, c: number): void => {
    toks.push({ kind, value, line: l, col: c });
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === ',') {
      i += 1;
      col += 1;
      continue;
    }
    if (ch === '\n') {
      i += 1;
      line += 1;
      col = 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') {
        i += 1;
        col += 1;
      }
      continue;
    }
    const l = line;
    const c = col;
    if (ch === '"') {
      // String literal (single-line only in the documented documents).
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < src.length) {
        const sc = src[j];
        if (sc === '"') {
          closed = true;
          break;
        }
        if (sc === '\n') break;
        if (sc === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === 'u' && j + 5 < src.length) {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
          continue;
        }
        out += sc;
        j += 1;
      }
      if (!closed) throw new GraphQLError('Unterminated string in GraphQL document');
      const width = j - i + 1;
      i = j + 1;
      col += width;
      push('string', out, l, c);
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      let isFloat = false;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      const text = src.slice(i, j);
      col += j - i;
      i = j;
      push(isFloat ? 'float' : 'int', text, l, c);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      const text = src.slice(i, j);
      col += j - i;
      i = j;
      push('name', text, l, c);
      continue;
    }
    if (src.startsWith('...', i)) {
      i += 3;
      col += 3;
      push('punct', '...', l, c);
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      i += 1;
      col += 1;
      push('punct', ch, l, c);
      continue;
    }
    throw new GraphQLError(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  toks.push({ kind: 'eof', value: '', line, col });
  return toks;
}

// ---------------------------------------------------------------------------
// Parser (AST)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

type Selection =
  | {
      kind: 'field';
      name: string;
      alias: string | undefined;
      args: { name: string; value: ValueNode }[];
      selections: Selection[];
    }
  | { kind: 'inlineFragment'; typeCondition: string | undefined; selections: Selection[] }
  | { kind: 'fragmentSpread'; name: string };

interface Operation {
  kind: 'query' | 'mutation';
  name: string | undefined;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, Selection[]>;
}

class Parser {
  private pos = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok {
    return this.toks[this.pos];
  }
  private next(): Tok {
    const t = this.toks[this.pos];
    if (this.pos < this.toks.length - 1) this.pos += 1;
    return t;
  }
  private expectPunct(value: string): Tok {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) {
      throw new GraphQLError(`Expected "${value}" in GraphQL document, got ${JSON.stringify(t.value)}`);
    }
    return t;
  }
  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      const name = this.next();
      if (name.kind !== 'name') throw new GraphQLError('Expected directive name');
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, Selection[]>();
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        operations.push({ kind: 'query', name: undefined, selections: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        operations.push(this.parseOperation());
        continue;
      }
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const nameTok = this.next();
        if (nameTok.kind !== 'name') throw new GraphQLError('Expected fragment name');
        const onTok = this.next();
        if (onTok.kind !== 'name' || onTok.value !== 'on') {
          throw new GraphQLError('Expected "on" in fragment definition');
        }
        const typeTok = this.next();
        if (typeTok.kind !== 'name') throw new GraphQLError('Expected type name in fragment definition');
        this.skipDirectives();
        fragments.set(nameTok.value, this.parseSelectionSet());
        continue;
      }
      throw new GraphQLError(`Unexpected token ${JSON.stringify(t.value)} in GraphQL document`);
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    const kindTok = this.next();
    const kind = kindTok.value as 'query' | 'mutation';
    let name: string | undefined;
    if (this.peek().kind === 'name') name = this.next().value;
    if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      if (this.peek().kind === 'eof') throw new GraphQLError('Unterminated variable definitions');
      this.expectPunct('$');
      const name = this.next();
      if (name.kind !== 'name') throw new GraphQLError('Expected variable name');
      this.expectPunct(':');
      // Skip the type: names, brackets and '!' until ',' or ')' at depth 0.
      let depth = 0;
      while (true) {
        const t = this.peek();
        if (t.kind === 'eof') throw new GraphQLError('Unterminated variable definition');
        if (depth === 0 && t.kind === 'punct' && (t.value === ',' || t.value === ')')) break;
        if (t.kind === 'punct' && t.value === '[') depth += 1;
        if (t.kind === 'punct' && t.value === ']') depth -= 1;
        this.next();
      }
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        this.parseValue();
      }
      if (this.peek().kind === 'punct' && this.peek().value === ',') this.next();
    }
    this.expectPunct(')');
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const out: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new GraphQLError('Unterminated selection set');
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): Selection {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeTok = this.next();
        if (typeTok.kind !== 'name') throw new GraphQLError('Expected type name after "on"');
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition: typeTok.value, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        this.next();
        this.skipDirectives();
        return { kind: 'fragmentSpread', name: next.value };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: undefined, selections: this.parseSelectionSet() };
    }
    if (t.kind !== 'name') throw new GraphQLError(`Expected field name, got ${JSON.stringify(t.value)}`);
    const first = this.next();
    let name = first.value;
    let alias: string | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      const real = this.next();
      if (real.kind !== 'name') throw new GraphQLError('Expected field name after alias');
      name = real.value;
    }
    let args: { name: string; value: ValueNode }[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selections: Selection[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    this.expectPunct('(');
    const out: { name: string; value: ValueNode }[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      if (this.peek().kind === 'eof') throw new GraphQLError('Unterminated arguments');
      const name = this.next();
      if (name.kind !== 'name') throw new GraphQLError('Expected argument name');
      this.expectPunct(':');
      out.push({ name: name.value, value: this.parseValue() });
      if (this.peek().kind === 'punct' && this.peek().value === ',') this.next();
    }
    this.expectPunct(')');
    return out;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'punct' && t.value === '$') {
      const name = this.next();
      if (name.kind !== 'name') throw new GraphQLError('Expected variable name after $');
      return { kind: 'variable', name: name.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        if (this.peek().kind === 'eof') throw new GraphQLError('Unterminated list value');
        values.push(this.parseValue());
        if (this.peek().kind === 'punct' && this.peek().value === ',') this.next();
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        if (this.peek().kind === 'eof') throw new GraphQLError('Unterminated object value');
        const name = this.next();
        if (name.kind !== 'name') throw new GraphQLError('Expected object field name');
        this.expectPunct(':');
        fields.push({ name: name.value, value: this.parseValue() });
        if (this.peek().kind === 'punct' && this.peek().value === ',') this.next();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new GraphQLError(`Unexpected value token ${JSON.stringify(t.value)}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
      return node.value;
    case 'int':
      return parseInt(node.value, 10);
    case 'float':
      return parseFloat(node.value);
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'variable':
      return variables[node.name] === undefined ? null : variables[node.name];
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Static introspection tables
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
    'pullRequest', 'description', 'private', 'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable',
    'headRefName', 'baseRefName', 'files', 'headRef', 'baseRef', 'createdAt', 'updatedAt',
  ],
  User: ['login', 'id', 'name'],
  Ref: ['name'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changes'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Label: ['name', 'color', 'description'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'],
  __Schema: ['queryType', 'mutationType', 'subscriptionType', 'types', 'directives'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

interface TypeInfo {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR' | 'INPUT_OBJECT';
  fields: string[];
  enumValues: string[];
}

function typeInfo(name: string): TypeInfo | undefined {
  if (TYPE_FIELDS[name] !== undefined) {
    return { kind: 'OBJECT', fields: TYPE_FIELDS[name], enumValues: [] };
  }
  if (TYPE_ENUM_VALUES[name] !== undefined) {
    return { kind: 'ENUM', fields: [], enumValues: TYPE_ENUM_VALUES[name] };
  }
  if (name === 'String' || name === 'Int' || name === 'Float' || name === 'Boolean' || name === 'ID') {
    return { kind: 'SCALAR', fields: [], enumValues: [] };
  }
  if (
    name === 'CreateIssueInput' || name === 'CloseIssueInput' || name === 'CreatePullRequestInput' ||
    name === 'MergePullRequestInput' || name === 'AddCommentInput' || name === 'IssueOrder'
  ) {
    return { kind: 'INPUT_OBJECT', fields: [], enumValues: [] };
  }
  return undefined;
}

// Child type for a field that carries a selection set. `[]` suffix = array.
const FIELD_CHILD: Record<string, string> = {
  'Query.viewer': 'User',
  'Query.repository': 'Repository',
  'Query.node': 'Node',
  'Query.__type': '__Type',
  'Query.__schema': '__Schema',
  'Mutation.createIssue': 'CreateIssuePayload',
  'Mutation.closeIssue': 'CloseIssuePayload',
  'Mutation.createPullRequest': 'CreatePullRequestPayload',
  'Mutation.mergePullRequest': 'MergePullRequestPayload',
  'Mutation.addComment': 'AddCommentPayload',
  'Repository.owner': 'User',
  'Repository.defaultBranchRef': 'Ref',
  'Repository.issue': 'Issue',
  'Repository.issues': 'IssueConnection',
  'Repository.pullRequests': 'PullRequestConnection',
  'Repository.pullRequest': 'PullRequest',
  'Issue.author': 'User',
  'Issue.labels': 'Label[]',
  'PullRequest.files': 'PullRequestChangedFileConnection',
  'IssueConnection.nodes': 'Issue[]',
  'IssueConnection.pageInfo': 'PageInfo',
  'PullRequestConnection.nodes': 'PullRequest[]',
  'PullRequestConnection.pageInfo': 'PageInfo',
  'PullRequestChangedFileConnection.nodes': 'PullRequestChangedFile[]',
  'PullRequestChangedFileConnection.pageInfo': 'PageInfo',
  'CreateIssuePayload.issue': 'Issue',
  'CloseIssuePayload.issue': 'Issue',
  'CreatePullRequestPayload.pullRequest': 'PullRequest',
  'MergePullRequestPayload.pullRequest': 'PullRequest',
  'AddCommentPayload.commentEdge': 'CommentEdge',
  'AddCommentPayload.comment': 'IssueComment',
  'CommentEdge.node': 'IssueComment',
  'IssueComment.author': 'User',
  '__Type.fields': '__Field[]',
  '__Type.enumValues': '__EnumValue[]',
  '__Type.inputFields': '__InputValue[]',
  '__Type.interfaces': '__Type[]',
  '__Type.possibleTypes': '__Type[]',
  '__Schema.queryType': '__Type',
  '__Schema.mutationType': '__Type',
  '__Schema.subscriptionType': '__Type',
  '__Schema.types': '__Type[]',
  '__Schema.directives': '__Directive[]',
  '__Field.args': '__InputValue[]',
  '__Field.type': '__Type',
  '__InputValue.type': '__Type',
};

// ---------------------------------------------------------------------------
// Internal source objects (values the field resolvers hand back)
// ---------------------------------------------------------------------------

type Source = {
  __typename: string;
  [key: string]: unknown;
};

interface Ctx {
  store: Store;
  viewerLogin: string;
}

function repoSource(repo: RepoRec): Source {
  return { __typename: 'Repository', __repo: repo };
}
function issueSource(repo: RepoRec, issue: IssueRec): Source {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}
function pullSource(repo: RepoRec, pull: PullRec): Source {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}
function commentSource(repo: RepoRec, issueNumber: number, comment: CommentRec): Source {
  return { __typename: 'IssueComment', __repo: repo, __issueNumber: issueNumber, __comment: comment };
}
function typeSource(name: string): Source {
  const info = typeInfo(name);
  return {
    __typename: '__Type',
    __typeName: name,
    __kind: info === undefined ? 'OBJECT' : info.kind,
    __fields: info === undefined ? [] : info.fields,
    __enumValues: info === undefined ? [] : info.enumValues,
  };
}

// ---------------------------------------------------------------------------
// Global-id resolution (opaque gid() values, recomputed — never parsed)
// ---------------------------------------------------------------------------

function findRepoByGid(store: Store, id: string): RepoRec | undefined {
  for (const repo of store.repos.values()) {
    if (store.gid('repo', `${repo.owner}/${repo.name}`) === id) return repo;
  }
  return undefined;
}

function findIssueByGid(store: Store, id: string): { repo: RepoRec; issue: IssueRec } | undefined {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) {
      if (store.gid('issue', `${repo.owner}/${repo.name}#${issue.number}`) === id) return { repo, issue };
    }
  }
  return undefined;
}

function findPullByGid(store: Store, id: string): { repo: RepoRec; pull: PullRec } | undefined {
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls.values()) {
      if (store.gid('pull', `${repo.owner}/${repo.name}#${pull.number}`) === id) return { repo, pull };
    }
  }
  return undefined;
}

function commentGid(store: Store, repo: RepoRec, issueNumber: number, comment: CommentRec): string {
  return store.gid('comment', `${repo.owner}/${repo.name}#${issueNumber}:${comment.id}`);
}

// ---------------------------------------------------------------------------
// Cursors: base64 of `cursor:<issue number>`, stable and deterministic
// ---------------------------------------------------------------------------

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | undefined {
  if (typeof cursor !== 'string' || cursor === '') return undefined;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    if (m === null) return undefined;
    return parseInt(m[1], 10);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

function issueConnection(repo: RepoRec, args: Record<string, unknown>): Source {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  let descending = false;
  const orderBy = args.orderBy;
  if (orderBy !== null && typeof orderBy === 'object') {
    const direction = (orderBy as Record<string, unknown>).direction;
    descending = String(direction).toUpperCase() === 'DESC';
  }
  // Creation order is number order; CREATED_AT ties break by number.
  list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  let start = 0;
  const afterNum = decodeCursor(args.after);
  if (afterNum !== undefined) {
    const idx = list.findIndex((i) => i.number === afterNum);
    start = idx === -1 ? 0 : idx + 1;
  }
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, args.first) : list.length - start;
  const page = list.slice(start, start + first);
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  const startCursor = page.length > 0 ? encodeCursor(page[0].number) : null;
  return {
    __typename: 'IssueConnection',
    __nodes: page.map((i) => issueSource(repo, i)),
    __pageInfo: {
      hasNextPage: start + page.length < list.length,
      hasPreviousPage: start > 0,
      endCursor,
      startCursor,
    },
    __totalCount: list.length,
  };
}

function pullConnection(repo: RepoRec, args: Record<string, unknown>): Source {
  const list = store_listPulls(repo, args);
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, args.first) : list.length;
  const page = list.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    __nodes: page.map((p) => pullSource(repo, p)),
    __pageInfo: {
      hasNextPage: page.length < list.length,
      hasPreviousPage: false,
      endCursor: page.length > 0 ? encodeCursor(page[page.length - 1].number) : null,
      startCursor: page.length > 0 ? encodeCursor(page[0].number) : null,
    },
    __totalCount: list.length,
  };
}

function store_listPulls(repo: RepoRec, args: Record<string, unknown>): PullRec[] {
  // GitHub's pullRequests connection defaults to open PRs.
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    return [...repo.pulls.values()].filter((p) => {
      const st = p.state === 'open' ? 'OPEN' : p.merged ? 'MERGED' : 'CLOSED';
      return wanted.has(st);
    });
  }
  return [...repo.pulls.values()].filter((p) => p.state === 'open');
}

function pullFilesConnection(ctx: Ctx, repo: RepoRec, pull: PullRec, args: Record<string, unknown>): Source {
  const files = ctx.store.pullFiles(repo, pull);
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, args.first) : files.length;
  const page = files.slice(0, first);
  return {
    __typename: 'PullRequestChangedFileConnection',
    __nodes: page.map((f) => ({ __typename: 'PullRequestChangedFile', __file: f })),
    __pageInfo: { hasNextPage: page.length < files.length, hasPreviousPage: false, endCursor: null, startCursor: null },
    __totalCount: files.length,
  };
}

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

function issueState(issue: IssueRec): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRec): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function argMap(args: { name: string; value: ValueNode }[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) out[a.name] = resolveValue(a.value, variables);
  return out;
}

function getField(
  ctx: Ctx,
  typeName: string,
  field: string,
  source: Source,
  args: Record<string, unknown>,
): unknown {
  const store = ctx.store;
  switch (typeName) {
    case 'Query': {
      if (field === 'viewer') return { __typename: 'User', __login: ctx.viewerLogin };
      if (field === 'repository') {
        const owner = args.owner;
        const name = args.name;
        if (typeof owner !== 'string' || typeof name !== 'string') {
          throw new GraphQLError('repository requires owner and name arguments');
        }
        const repo = store.getRepo(owner, name);
        if (repo === undefined) return null;
        // A repo owned by someone else is not visible to this token.
        if (repo.owner !== ctx.viewerLogin) return null;
        return repoSource(repo);
      }
      if (field === 'node') {
        const id = args.id;
        if (typeof id !== 'string') throw new GraphQLError('node requires an id argument');
        const repo = findRepoByGid(store, id);
        if (repo !== undefined) return repoSource(repo);
        const issue = findIssueByGid(store, id);
        if (issue !== undefined) return issueSource(issue.repo, issue.issue);
        const pull = findPullByGid(store, id);
        if (pull !== undefined) return pullSource(pull.repo, pull.pull);
        return null;
      }
      if (field === '__type') {
        const name = args.name;
        if (typeof name !== 'string') throw new GraphQLError('__type requires a name argument');
        if (typeInfo(name) === undefined) return null;
        return typeSource(name);
      }
      if (field === '__schema') return { __typename: '__Schema' };
      break;
    }
    case 'Mutation': {
      if (field === 'createIssue') return mutateCreateIssue(ctx, args);
      if (field === 'closeIssue') return mutateCloseIssue(ctx, args);
      if (field === 'createPullRequest') return mutateCreatePullRequest(ctx, args);
      if (field === 'mergePullRequest') return mutateMergePullRequest(ctx, args);
      if (field === 'addComment') return mutateAddComment(ctx, args);
      break;
    }
    case 'User': {
      if (field === 'login') return (source.__login as string) ?? ctx.viewerLogin;
      if (field === 'id') return store.gid('repo', `user:${(source.__login as string) ?? ctx.viewerLogin}`);
      if (field === 'name') return (source.__login as string) ?? ctx.viewerLogin;
      break;
    }
    case 'Repository': {
      const repo = source.__repo as RepoRec;
      if (field === 'id') return store.gid('repo', `${repo.owner}/${repo.name}`);
      if (field === 'databaseId') return repo.id;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field === 'description') return repo.description;
      if (field === 'private') return repo.private;
      if (field === 'createdAt') return repo.createdAt;
      if (field === 'updatedAt') return repo.updatedAt;
      if (field === 'owner') return { __typename: 'User', __login: repo.owner };
      if (field === 'defaultBranchRef') return { __typename: 'Ref', __name: repo.defaultBranch };
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'issue') {
        const n = args.number;
        if (typeof n !== 'number') throw new GraphQLError('issue requires a number argument');
        const issue = store.getIssue(repo, n);
        return issue === undefined ? null : issueSource(repo, issue);
      }
      if (field === 'issues') return issueConnection(repo, args);
      if (field === 'pullRequests') return pullConnection(repo, args);
      if (field === 'pullRequest') {
        const n = args.number;
        if (typeof n !== 'number') throw new GraphQLError('pullRequest requires a number argument');
        const pull = store.getPull(repo, n);
        return pull === undefined ? null : pullSource(repo, pull);
      }
      break;
    }
    case 'Issue': {
      const repo = source.__repo as RepoRec;
      const issue = source.__issue as IssueRec;
      if (field === 'id') return store.gid('issue', `${repo.owner}/${repo.name}#${issue.number}`);
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'state') return issueState(issue);
      if (field === 'body') return issue.body;
      if (field === 'createdAt') return issue.createdAt;
      if (field === 'updatedAt') return issue.updatedAt;
      if (field === 'author') return { __typename: 'User', __login: ctx.viewerLogin };
      if (field === 'labels') return issue.labels.map((l) => ({ __typename: 'Label', __label: l }));
      break;
    }
    case 'PullRequest': {
      const repo = source.__repo as RepoRec;
      const pull = source.__pull as PullRec;
      if (field === 'id') return store.gid('pull', `${repo.owner}/${repo.name}#${pull.number}`);
      if (field === 'number') return pull.number;
      if (field === 'title') return pull.title;
      if (field === 'body') return pull.body;
      if (field === 'state') return pullState(pull);
      if (field === 'merged') return pull.merged;
      if (field === 'mergeable') return pull.state === 'open' ? 'MERGEABLE' : 'UNKNOWN';
      if (field === 'headRefName') return pull.headRef;
      if (field === 'baseRefName') return pull.baseRef;
      if (field === 'headRef') return { __typename: 'Ref', __name: pull.headRef };
      if (field === 'baseRef') return { __typename: 'Ref', __name: pull.baseRef };
      if (field === 'createdAt') return pull.createdAt;
      if (field === 'updatedAt') return pull.updatedAt;
      if (field === 'files') return pullFilesConnection(ctx, repo, pull, args);
      break;
    }
    case 'Ref': {
      if (field === 'name') return source.__name as string;
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      if (field === 'nodes') return source.__nodes as Source[];
      if (field === 'pageInfo') return { __typename: 'PageInfo', ...(source.__pageInfo as Record<string, unknown>) };
      if (field === 'totalCount') return source.__totalCount as number;
      break;
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return source.hasNextPage as boolean;
      if (field === 'hasPreviousPage') return source.hasPreviousPage as boolean;
      if (field === 'endCursor') return (source.endCursor as string | null) ?? null;
      if (field === 'startCursor') return (source.startCursor as string | null) ?? null;
      break;
    }
    case 'PullRequestChangedFile': {
      const f = source.__file as { filename: string; status: string; additions: number; deletions: number; changes: number };
      if (field === 'path') return f.filename;
      if (field === 'filename') return f.filename;
      if (field === 'additions') return f.additions;
      if (field === 'deletions') return f.deletions;
      if (field === 'changes') return f.changes;
      break;
    }
    case 'Label': {
      const l = source.__label as { name: string; color: string };
      if (field === 'name') return l.name;
      if (field === 'color') return l.color;
      if (field === 'description') return l.name;
      break;
    }
    case 'IssueComment': {
      const comment = source.__comment as CommentRec;
      const repo = source.__repo as RepoRec;
      const issueNumber = source.__issueNumber as number;
      if (field === 'id') return commentGid(store, repo, issueNumber, comment);
      if (field === 'body') return comment.body;
      if (field === 'createdAt') return comment.createdAt;
      if (field === 'author') return { __typename: 'User', __login: ctx.viewerLogin };
      break;
    }
    case 'CommentEdge': {
      if (field === 'node') return source.__node as Source;
      if (field === 'cursor') return (source.__cursor as string | undefined) ?? null;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field === 'issue') return source.__issue as Source | null;
      if (field === 'clientMutationId') return null;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return source.__pull as Source | null;
      if (field === 'clientMutationId') return null;
      break;
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return source.__edge as Source | null;
      if (field === 'comment') return source.__commentSrc as Source | null;
      if (field === 'clientMutationId') return null;
      break;
    }
    case '__Type': {
      if (field === 'name') return source.__typeName as string;
      if (field === 'kind') return source.__kind as string;
      if (field === 'description') return null;
      if (field === 'fields') {
        const names = source.__fields as string[];
        return names.map((n) => ({ __typename: '__Field', __name: n }));
      }
      if (field === 'enumValues') {
        const names = source.__enumValues as string[];
        return names.map((n) => ({ __typename: '__EnumValue', __name: n }));
      }
      if (field === 'inputFields') return [];
      if (field === 'interfaces') return [];
      if (field === 'possibleTypes') return [];
      break;
    }
    case '__Schema': {
      if (field === 'queryType') return typeSource('Query');
      if (field === 'mutationType') return typeSource('Mutation');
      if (field === 'subscriptionType') return null;
      if (field === 'types') {
        const names = [...Object.keys(TYPE_FIELDS), ...Object.keys(TYPE_ENUM_VALUES), 'String', 'Int', 'Float', 'Boolean', 'ID'];
        return names.map((n) => typeSource(n));
      }
      if (field === 'directives') return [];
      break;
    }
    case '__Field': {
      if (field === 'name') return source.__name as string;
      if (field === 'description') return null;
      if (field === 'args') return [];
      if (field === 'type') return typeSource('String');
      break;
    }
    case '__EnumValue': {
      if (field === 'name') return source.__name as string;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      break;
    }
    case '__InputValue': {
      if (field === 'name') return source.__name as string;
      if (field === 'description') return null;
      if (field === 'type') return typeSource('String');
      if (field === 'defaultValue') return null;
      break;
    }
  }
  throw new GraphQLError(`Cannot query field "${field}" on type "${typeName}".`);
}

// ---------------------------------------------------------------------------
// Mutations (all act on the shared store, so REST reads them back)
// ---------------------------------------------------------------------------

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new GraphQLError('Mutation requires an input object');
  }
  return input as Record<string, unknown>;
}

function mutateCreateIssue(ctx: Ctx, args: Record<string, unknown>): Source {
  const input = inputOf(args);
  const repoId = input.repositoryId;
  if (typeof repoId !== 'string') throw new GraphQLError('createIssue requires input.repositoryId');
  const repo = findRepoByGid(ctx.store, repoId);
  if (repo === undefined) throw new GraphQLError(`Repository not found for id "${repoId}"`);
  const title = input.title;
  if (typeof title !== 'string' || title === '') throw new GraphQLError('createIssue requires input.title');
  const body = typeof input.body === 'string' ? input.body : '';
  const issue = ctx.store.createIssue(repo, { title, body, labels: [] });
  if (issue === null) throw new GraphQLError('createIssue failed: unknown label');
  return { __typename: 'CreateIssuePayload', __issue: issueSource(repo, issue) };
}

function mutateCloseIssue(ctx: Ctx, args: Record<string, unknown>): Source {
  const input = inputOf(args);
  const issueId = input.issueId;
  if (typeof issueId !== 'string') throw new GraphQLError('closeIssue requires input.issueId');
  const found = findIssueByGid(ctx.store, issueId);
  if (found === undefined) throw new GraphQLError(`Issue not found for id "${issueId}"`);
  const issue = ctx.store.patchIssue(found.repo, found.issue.number, { state: 'closed' });
  if (issue === undefined) throw new GraphQLError(`Issue not found for id "${issueId}"`);
  return { __typename: 'CloseIssuePayload', __issue: issueSource(found.repo, issue) };
}

function mutateCreatePullRequest(ctx: Ctx, args: Record<string, unknown>): Source {
  const input = inputOf(args);
  const repoId = input.repositoryId;
  if (typeof repoId !== 'string') throw new GraphQLError('createPullRequest requires input.repositoryId');
  const repo = findRepoByGid(ctx.store, repoId);
  if (repo === undefined) throw new GraphQLError(`Repository not found for id "${repoId}"`);
  const headRef = input.headRefName;
  const baseRef = input.baseRefName;
  if (typeof headRef !== 'string' || typeof baseRef !== 'string') {
    throw new GraphQLError('createPullRequest requires input.headRefName and input.baseRefName');
  }
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const pull = ctx.store.createPull(repo, { title, body, headRef, baseRef });
  if (pull === null) {
    throw new GraphQLError(`createPullRequest failed: head ref "${headRef}" or base ref "${baseRef}" does not exist`);
  }
  return { __typename: 'CreatePullRequestPayload', __pull: pullSource(repo, pull) };
}

function mutateMergePullRequest(ctx: Ctx, args: Record<string, unknown>): Source {
  const input = inputOf(args);
  const pullId = input.pullRequestId;
  if (typeof pullId !== 'string') throw new GraphQLError('mergePullRequest requires input.pullRequestId');
  const found = findPullByGid(ctx.store, pullId);
  if (found === undefined) throw new GraphQLError(`Pull request not found for id "${pullId}"`);
  const result = ctx.store.mergePullSquash(found.repo, found.pull);
  if ('error' in result && result.error === 'not-open' && !found.pull.merged) {
    throw new GraphQLError('mergePullRequest failed: pull request is not open');
  }
  if ('conflict' in result) {
    return { __typename: 'MergePullRequestPayload', __pull: pullSource(found.repo, found.pull) };
  }
  return { __typename: 'MergePullRequestPayload', __pull: pullSource(found.repo, found.pull) };
}

function mutateAddComment(ctx: Ctx, args: Record<string, unknown>): Source {
  const input = inputOf(args);
  const subjectId = input.subjectId;
  if (typeof subjectId !== 'string') throw new GraphQLError('addComment requires input.subjectId');
  const body = input.body;
  if (typeof body !== 'string') throw new GraphQLError('addComment requires input.body');
  const found = findIssueByGid(ctx.store, subjectId);
  if (found === undefined) throw new GraphQLError(`Subject not found for id "${subjectId}"`);
  const comment = ctx.store.addComment(found.repo, found.issue.number, body);
  if (comment === undefined) throw new GraphQLError(`Subject not found for id "${subjectId}"`);
  const node = commentSource(found.repo, found.issue.number, comment);
  return {
    __typename: 'AddCommentPayload',
    __edge: { __typename: 'CommentEdge', __node: node, __cursor: encodeCursor(comment.id) },
    __commentSrc: node,
  };
}

// ---------------------------------------------------------------------------
// Selection execution
// ---------------------------------------------------------------------------

function allowedFields(typeName: string): string[] | undefined {
  if (typeName === 'Node') {
    // `node` is an interface: only `id` is common; fragments narrow the type.
    return ['id'];
  }
  return TYPE_FIELDS[typeName];
}

function resolveSelections(
  selections: Selection[],
  typeName: string,
  source: Source | null,
  variables: Record<string, unknown>,
  ctx: Ctx,
  fragments: Map<string, Selection[]>,
  path: (string | number)[],
): Record<string, unknown> | null {
  if (source === null) return null;
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition !== undefined && sel.typeCondition !== typeName && sel.typeCondition !== 'Node') {
        continue;
      }
      const inner = resolveSelections(sel.selections, typeName, source, variables, ctx, fragments, path);
      if (inner !== null) Object.assign(out, inner);
      continue;
    }
    if (sel.kind === 'fragmentSpread') {
      const frag = fragments.get(sel.name);
      if (frag === undefined) throw new GraphQLError(`Unknown fragment "${sel.name}".`);
      const inner = resolveSelections(frag, typeName, source, variables, ctx, fragments, path);
      if (inner !== null) Object.assign(out, inner);
      continue;
    }
    const key = sel.alias ?? sel.name;
    const fieldPath = [...path, key];
    try {
      if (sel.name === '__typename') {
        out[key] = typeName;
        continue;
      }
      const allowed = allowedFields(typeName);
      if (allowed === undefined || !allowed.includes(sel.name)) {
        throw new GraphQLError(`Cannot query field "${sel.name}" on type "${typeName}".`);
      }
      const args = argMap(sel.args, variables);
      const value = getField(ctx, typeName, sel.name, source, args);
      if (sel.selections.length === 0) {
        out[key] = value;
        continue;
      }
      if (value === null || value === undefined) {
        out[key] = null;
        continue;
      }
      const child = FIELD_CHILD[`${typeName}.${sel.name}`];
      if (child === undefined) {
        // A selection set on a scalar-ish field: return the value as-is.
        out[key] = value;
        continue;
      }
      if (child.endsWith('[]')) {
        const elemType = child.slice(0, -2);
        const arr = value as Source[];
        out[key] = arr.map((item, idx) =>
          resolveSelections(sel.selections, elemType, item, variables, ctx, fragments, [...fieldPath, idx]),
        );
        continue;
      }
      // `node` is an interface: the value's own __typename is the real type,
      // so inline fragments (`... on Repository`) match and `id` resolves.
      const effectiveChild = child === 'Node' ? (value as Source).__typename : child;
      out[key] = resolveSelections(sel.selections, effectiveChild, value as Source, variables, ctx, fragments, fieldPath);
    } catch (err) {
      if (err instanceof GraphQLError) {
        err.path = fieldPath;
        throw err;
      }
      throw err;
    }
  }
  return out;
}

function executeOperation(
  doc: Document,
  query: string,
  variables: Record<string, unknown>,
  operationName: string | undefined,
  ctx: Ctx,
): { data: unknown; errors?: { message: string; path?: (string | number)[] }[] } {
  let parsed: Document;
  try {
    parsed = new Parser(lex(query)).parseDocument();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to parse GraphQL document';
    return { data: null, errors: [{ message }] };
  }
  void doc;
  let op: Operation | undefined;
  if (operationName !== undefined) {
    op = parsed.operations.find((o) => o.name === operationName);
    if (op === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else {
    op = parsed.operations[0];
  }
  if (op === undefined) {
    return { data: null, errors: [{ message: 'No operation in GraphQL document' }] };
  }
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: Source = { __typename: rootType };
  try {
    const data = resolveSelections(op.selections, rootType, root, variables, ctx, parsed.fragments, []);
    return { data };
  } catch (err) {
    if (err instanceof GraphQLError) {
      return { data: null, errors: [{ message: err.message, path: err.path }] };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export const handleGraphql: SurfaceHandler = async (
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
): Promise<boolean> => {
  if (req.method !== 'POST') return false;
  const token = bearerToken(req);
  if (token === null) {
    sendError(res, store, 401, 'Requires authentication');
    return true;
  }
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendError(res, store, 400, 'Malformed JSON body');
    return true;
  }
  const viewerLogin = store.ownerForToken(token) ?? store.viewerLogin;
  const ctx: Ctx = { store, viewerLogin };
  try {
    const value = body.value;
    if (Array.isArray(value)) {
      const results = value.map((entry) => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          return { data: null, errors: [{ message: 'Each batched operation must be an object with a query string' }] };
        }
        const op = entry as Record<string, unknown>;
        if (typeof op.query !== 'string') {
          return { data: null, errors: [{ message: 'Batched operation requires a query string' }] };
        }
        const variables =
          op.variables !== null && typeof op.variables === 'object' && !Array.isArray(op.variables)
            ? (op.variables as Record<string, unknown>)
            : {};
        return executeOperation(
          { operations: [], fragments: new Map() },
          op.query,
          variables,
          typeof op.operationName === 'string' ? op.operationName : undefined,
          ctx,
        );
      });
      sendJson(res, store, 200, results);
      return true;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      sendError(res, store, 400, 'GraphQL request body must be an object');
      return true;
    }
    const op = value as Record<string, unknown>;
    if (typeof op.query !== 'string') {
      sendError(res, store, 400, 'GraphQL request requires a query string');
      return true;
    }
    const variables =
      op.variables !== null && typeof op.variables === 'object' && !Array.isArray(op.variables)
        ? (op.variables as Record<string, unknown>)
        : {};
    const result = executeOperation(
      { operations: [], fragments: new Map() },
      op.query,
      variables,
      typeof op.operationName === 'string' ? op.operationName : undefined,
      ctx,
    );
    sendJson(res, store, 200, result);
    return true;
  } catch (err) {
    sendJson(res, store, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
    return true;
  }
};
