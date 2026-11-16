// GraphQL v4 surface: a small executor for the query and mutation shapes
// gh-style clients use, over the same store as REST and git. Global ids
// are opaque base64 encodings of (kind, repository id, number) so they
// round-trip through node(id:) and stay stable across reads; introspection
// answers from the same field tables the executor validates against, so
// the schema the suite probes is the schema that actually runs.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx } from './app.ts';
import { sendJson } from './app.ts';
import { isoOf, type Comment, type Issue, type Pull, type Repo } from './store.ts';
import { performMerge, pullFiles, pullMergeable } from './rest.ts';

// ------------------------------------------------------------ global ids

function encodeId(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64');
}

function decodeId(id: string): string | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

const repoGlobalId = (repo: Repo): string => encodeId(`R:${repo.id}`);
const issueGlobalId = (repo: Repo, issue: Issue): string => encodeId(`I:${repo.id}:${issue.number}`);
const pullGlobalId = (repo: Repo, pull: Pull): string => encodeId(`P:${repo.id}:${pull.number}`);
const commentGlobalId = (comment: Comment): string => encodeId(`C:${comment.id}`);
const userGlobalId = (login: string): string => encodeId(`U:${login}`);

// ---------------------------------------------------------------- parser

type GqlValue =
  | { k: 'var'; name: string }
  | { k: 'lit'; value: unknown }
  | { k: 'list'; items: GqlValue[] }
  | { k: 'obj'; fields: [string, GqlValue][] };

type GqlSel =
  | { kind: 'field'; alias: string | null; name: string; args: [string, GqlValue][]; selection: GqlSel[] | null }
  | { kind: 'fragment'; typeCondition: string | null; selection: GqlSel[] }
  | { kind: 'spread'; name: string };

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: GqlSel[];
}

interface GqlDoc {
  operations: GqlOperation[];
  fragments: Map<string, GqlSel[]>;
}

interface Tok {
  t: 'name' | 'str' | 'num' | 'punct' | 'spread' | 'eof';
  v: string;
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (src.startsWith('...', i)) {
      toks.push({ t: 'spread', v: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:=!$@|&'.includes(c)) {
      toks.push({ t: 'punct', v: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        toks.push({ t: 'str', v: src.slice(i + 3, end < 0 ? src.length : end) });
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const e = src[j + 1] as string;
          if (e === 'u') {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === 'b' ? '\b' : e === 'f' ? '\f' : e;
            j += 2;
          }
        } else {
          out += src[j];
          j += 1;
        }
      }
      toks.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j] as string)) j += 1;
      if (j === i || src.slice(i, j) === '-') throw new Error('bad number literal');
      toks.push({ t: 'num', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j] as string)) j += 1;
      toks.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  toks.push({ t: 'eof', v: '' });
  return toks;
}

class Parser {
  private toks: Tok[];
  private pos = 0;

  constructor(src: string) {
    this.toks = tokenize(src);
  }

  private peek(): Tok {
    return this.toks[this.pos] as Tok;
  }

  private next(): Tok {
    const tok = this.toks[this.pos] as Tok;
    this.pos += 1;
    return tok;
  }

  private atPunct(v: string): boolean {
    const tok = this.peek();
    return tok.t === 'punct' && tok.v === v;
  }

  private expectPunct(v: string): void {
    if (!this.atPunct(v)) throw new Error(`expected '${v}', got '${this.peek().v}'`);
    this.pos += 1;
  }

  private expectName(): string {
    const tok = this.next();
    if (tok.t !== 'name') throw new Error(`expected a name, got '${tok.v}'`);
    return tok.v;
  }

  /** Skip a balanced bracket group whose opening token is next. */
  private skipGroup(): void {
    const open = this.next();
    const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
    const close = pairs[open.v];
    if (close === undefined) throw new Error(`expected a group, got '${open.v}'`);
    let depth = 1;
    while (depth > 0) {
      const tok = this.next();
      if (tok.t === 'eof') throw new Error('unterminated group');
      if (tok.t === 'punct' && tok.v === open.v) depth += 1;
      if (tok.t === 'punct' && tok.v === close) depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.pos += 1;
      this.expectName();
      if (this.atPunct('(')) this.skipGroup();
    }
  }

  parseDocument(): GqlDoc {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlSel[]>();
    while (this.peek().t !== 'eof') {
      if (this.atPunct('{')) {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | null = null;
        if (this.peek().t === 'name') name = this.next().v;
        if (this.atPunct('(')) this.skipGroup();
        this.skipDirectives();
        operations.push({
          type: keyword === 'mutation' ? 'mutation' : 'query',
          name,
          selection: this.parseSelectionSet(),
        });
        continue;
      }
      if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error(`expected 'on' in fragment definition`);
        this.expectName();
        this.skipDirectives();
        fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected definition '${keyword}'`);
    }
    return { operations, fragments };
  }

  private parseSelectionSet(): GqlSel[] {
    this.expectPunct('{');
    const out: GqlSel[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().t === 'eof') throw new Error('unterminated selection set');
      out.push(this.parseSelection());
    }
    this.pos += 1;
    return out;
  }

  private parseSelection(): GqlSel {
    if (this.peek().t === 'spread') {
      this.pos += 1;
      if (this.peek().t === 'name' && this.peek().v === 'on') {
        this.pos += 1;
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'fragment', typeCondition, selection: this.parseSelectionSet() };
      }
      if (this.atPunct('{')) {
        return { kind: 'fragment', typeCondition: null, selection: this.parseSelectionSet() };
      }
      return { kind: 'spread', name: this.expectName() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.atPunct(':')) {
      this.pos += 1;
      alias = name;
      name = this.expectName();
    }
    const args: [string, GqlValue][] = [];
    if (this.atPunct('(')) {
      this.pos += 1;
      while (!this.atPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push([argName, this.parseValue()]);
      }
      this.pos += 1;
    }
    this.skipDirectives();
    const selection = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): GqlValue {
    const tok = this.peek();
    if (tok.t === 'punct' && tok.v === '$') {
      this.pos += 1;
      return { k: 'var', name: this.expectName() };
    }
    if (tok.t === 'str') {
      this.pos += 1;
      return { k: 'lit', value: tok.v };
    }
    if (tok.t === 'num') {
      this.pos += 1;
      return { k: 'lit', value: Number(tok.v) };
    }
    if (tok.t === 'punct' && tok.v === '[') {
      this.pos += 1;
      const items: GqlValue[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.pos += 1;
      return { k: 'list', items };
    }
    if (tok.t === 'punct' && tok.v === '{') {
      this.pos += 1;
      const fields: [string, GqlValue][] = [];
      while (!this.atPunct('}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push([fieldName, this.parseValue()]);
      }
      this.pos += 1;
      return { k: 'obj', fields };
    }
    if (tok.t === 'name') {
      this.pos += 1;
      if (tok.v === 'true') return { k: 'lit', value: true };
      if (tok.v === 'false') return { k: 'lit', value: false };
      if (tok.v === 'null') return { k: 'lit', value: null };
      return { k: 'lit', value: tok.v };
    }
    throw new Error(`unexpected value token '${tok.v}'`);
  }
}

function parseGraphql(src: string): GqlDoc {
  return new Parser(src).parseDocument();
}

// ---------------------------------------------------------------- schema

/** The fields each type answers. Introspection reports exactly these, and
 * the executor rejects anything else with a GraphQL error naming it. */
const TYPE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate',
    'viewerPermission', 'hasIssuesEnabled', 'hasProjectsEnabled', 'owner',
    'defaultBranchRef', 'issue', 'issues', 'pullRequest', 'pullRequests',
    'createdAt', 'updatedAt',
  ],
  Ref: ['name', 'prefix'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'repository', 'createdAt', 'updatedAt', 'closedAt'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'author',
    'repository', 'files', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt',
  ],
  PullRequestFile: ['path', 'additions', 'deletions'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  Connection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Edge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'directives'],
};

const ENUM_TYPES: Record<string, readonly string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
};

const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI']);

// ------------------------------------------------------------- execution

interface GObj {
  __t: string;
  [key: string]: unknown;
}

interface Exe {
  ctx: Ctx;
  variables: Record<string, unknown>;
  fragments: Map<string, GqlSel[]>;
  errors: { message: string }[];
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0) || 0);

function userObj(exe: Exe): GObj {
  return { __t: 'User', login: exe.ctx.store.loginOr('') };
}

function repoObj(repo: Repo): GObj {
  return { __t: 'Repository', repo };
}

function issueObj(repo: Repo, issue: Issue): GObj {
  return { __t: 'Issue', repo, issue };
}

function pullObj(repo: Repo, pull: Pull): GObj {
  return { __t: 'PullRequest', repo, pull };
}

function commentObj(repo: Repo, issue: Issue, comment: Comment): GObj {
  return { __t: 'IssueComment', repo, issue, comment };
}

function repoByDbId(exe: Exe, dbId: number): Repo | null {
  for (const repo of exe.ctx.store.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

function decodeNode(exe: Exe, id: string): GObj | null {
  const text = decodeId(id);
  if (text === null) return null;
  const parts = text.split(':');
  const kind = parts[0];
  if (kind === 'R') {
    const repo = repoByDbId(exe, Number(parts[1]));
    return repo === null ? null : repoObj(repo);
  }
  if (kind === 'I' || kind === 'P') {
    const repo = repoByDbId(exe, Number(parts[1]));
    if (repo === null) return null;
    const number = Number(parts[2]);
    if (kind === 'I') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueObj(repo, issue);
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : pullObj(repo, pull);
  }
  if (kind === 'C') {
    const dbId = Number(parts[1]);
    for (const repo of exe.ctx.store.repos.values()) {
      for (const issue of repo.issues.values()) {
        const comment = issue.comments.find((entry) => entry.id === dbId);
        if (comment !== undefined) return commentObj(repo, issue, comment);
      }
    }
    return null;
  }
  if (kind === 'U') return userObj(exe);
  return null;
}

function typeObj(name: string): GObj | null {
  if (Object.hasOwn(TYPE_FIELDS, name)) {
    return {
      __t: '__Type',
      name,
      kind: 'OBJECT',
      fields: (TYPE_FIELDS[name] as readonly string[]).map((field) => ({ __t: '__Field', name: field })),
      enumValues: null,
    };
  }
  if (Object.hasOwn(ENUM_TYPES, name)) {
    return {
      __t: '__Type',
      name,
      kind: 'ENUM',
      fields: null,
      enumValues: (ENUM_TYPES[name] as readonly string[]).map((value) => ({ __t: '__EnumValue', name: value })),
    };
  }
  if (SCALAR_TYPES.has(name)) return { __t: '__Type', name, kind: 'SCALAR', fields: null, enumValues: null };
  return null;
}

const cursorOf = (key: string): string => encodeId(`cur:${key}`);

function decodeCursor(cursor: string): string | null {
  const text = decodeId(cursor);
  if (text === null || !text.startsWith('cur:')) return null;
  return text.slice(4);
}

/** Slice a connection's items by (first, after) and wrap them with pageInfo. */
function connection(items: GObj[], keys: string[], args: Record<string, unknown>): GObj {
  let start = 0;
  if (typeof args.after === 'string') {
    const key = decodeCursor(args.after);
    const index = key === null ? -1 : keys.indexOf(key);
    if (index >= 0) start = index + 1;
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : items.length;
  const nodes = items.slice(start, start + first);
  const pageKeys = keys.slice(start, start + nodes.length);
  return {
    __t: 'Connection',
    nodes,
    pageKeys,
    totalCount: items.length,
    pageInfo: {
      __t: 'PageInfo',
      hasNextPage: start + nodes.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: pageKeys.length > 0 ? cursorOf(pageKeys[0] as string) : null,
      endCursor: pageKeys.length > 0 ? cursorOf(pageKeys[pageKeys.length - 1] as string) : null,
    },
  };
}

function issuesConnection(exe: Exe, repo: Repo, args: Record<string, unknown>): GObj {
  let list = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? args.states.map((entry) => String(entry)) : null;
  if (states !== null) list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
  const orderBy = (typeof args.orderBy === 'object' && args.orderBy !== null ? args.orderBy : {}) as Record<string, unknown>;
  if (orderBy.field !== undefined || orderBy.direction !== undefined) {
    const key = orderBy.field === 'UPDATED_AT' ? 'updatedAt' : 'createdAt';
    const sign = orderBy.direction === 'ASC' ? 1 : -1;
    list.sort((a, b) => sign * (a[key] - b[key]) || sign * (a.seq - b.seq));
  } else {
    list.sort((a, b) => a.seq - b.seq);
  }
  return connection(
    list.map((issue) => issueObj(repo, issue)),
    list.map((issue) => String(issue.number)),
    args,
  );
}

function pullsConnection(exe: Exe, repo: Repo, args: Record<string, unknown>): GObj {
  let list = [...repo.pulls.values()];
  const states = Array.isArray(args.states) ? args.states.map((entry) => String(entry)) : ['OPEN'];
  list = list.filter((pull) => {
    const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
    return states.includes(state) || (pull.state === 'closed' && states.includes('CLOSED'));
  });
  list.sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq);
  return connection(
    list.map((pull) => pullObj(repo, pull)),
    list.map((pull) => String(pull.number)),
    args,
  );
}

function filesConnection(exe: Exe, repo: Repo, pull: Pull, args: Record<string, unknown>): GObj {
  const files = pullFiles(exe.ctx, repo, pull);
  const items: GObj[] = files.map((file) => ({
    __t: 'PullRequestFile',
    path: file.filename,
    additions: file.additions,
    deletions: file.deletions,
  }));
  return connection(items, files.map((_, index) => String(index)), args);
}

// -------------------------------------------------------------- resolvers

function resolveValue(value: GqlValue, exe: Exe): unknown {
  switch (value.k) {
    case 'var':
      return exe.variables[value.name];
    case 'lit':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, exe));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const [key, fieldValue] of value.fields) out[key] = resolveValue(fieldValue, exe);
      return out;
    }
  }
}

function resolveArgs(field: Extract<GqlSel, { kind: 'field' }>, exe: Exe): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) {
    const resolved = resolveValue(value, exe);
    if (resolved !== undefined) out[key] = resolved;
  }
  return out;
}

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

function repoFromGlobalId(exe: Exe, id: unknown): Repo | null {
  const text = typeof id === 'string' ? decodeId(id) : null;
  if (text === null || !text.startsWith('R:')) return null;
  return repoByDbId(exe, Number(text.slice(2)));
}

function issueFromGlobalId(exe: Exe, id: unknown): { repo: Repo; issue: Issue } | null {
  const text = typeof id === 'string' ? decodeId(id) : null;
  if (text === null || !text.startsWith('I:')) return null;
  const parts = text.split(':');
  const repo = repoByDbId(exe, Number(parts[1]));
  if (repo === null) return null;
  const issue = repo.issues.get(Number(parts[2]));
  return issue === undefined ? null : { repo, issue };
}

function pullFromGlobalId(exe: Exe, id: unknown): { repo: Repo; pull: Pull } | null {
  const text = typeof id === 'string' ? decodeId(id) : null;
  if (text === null || !text.startsWith('P:')) return null;
  const parts = text.split(':');
  const repo = repoByDbId(exe, Number(parts[1]));
  if (repo === null) return null;
  const pull = repo.pulls.get(Number(parts[2]));
  return pull === undefined ? null : { repo, pull };
}

function runMutation(exe: Exe, name: string, args: Record<string, unknown>): unknown {
  const store = exe.ctx.store;
  const input = inputOf(args);
  switch (name) {
    case 'createIssue': {
      const repo = repoFromGlobalId(exe, input.repositoryId);
      if (repo === null) {
        exe.errors.push({ message: 'Could not resolve the repository for createIssue' });
        return { __t: 'CreateIssuePayload', issue: null };
      }
      const at = store.tick();
      const issue: Issue = {
        number: repo.nextNumber,
        id: store.nextNodeDbId(),
        title: str(input.title),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: at,
        updatedAt: at,
        closedAt: null,
        seq: store.seq(),
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return { __t: 'CreateIssuePayload', issue: issueObj(repo, issue) };
    }
    case 'closeIssue': {
      const found = issueFromGlobalId(exe, input.issueId);
      if (found === null) {
        exe.errors.push({ message: 'Could not resolve the issue for closeIssue' });
        return { __t: 'CloseIssuePayload', issue: null };
      }
      const { repo, issue } = found;
      if (issue.state !== 'closed') {
        issue.state = 'closed';
        issue.closedAt = store.tick();
      }
      issue.updatedAt = store.tick();
      return { __t: 'CloseIssuePayload', issue: issueObj(repo, issue) };
    }
    case 'createPullRequest': {
      const repo = repoFromGlobalId(exe, input.repositoryId);
      if (repo === null) {
        exe.errors.push({ message: 'Could not resolve the repository for createPullRequest' });
        return { __t: 'CreatePullRequestPayload', pullRequest: null };
      }
      const head = str(input.headRefName).replace(/^[^:]+:/, '');
      const base = str(input.baseRefName);
      if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
        exe.errors.push({ message: 'The head or base branch does not exist' });
        return { __t: 'CreatePullRequestPayload', pullRequest: null };
      }
      const at = store.tick();
      const pull: Pull = {
        number: repo.nextNumber,
        id: store.nextNodeDbId(),
        title: str(input.title),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: at,
        updatedAt: at,
        seq: store.seq(),
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return { __t: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull) };
    }
    case 'mergePullRequest': {
      const found = pullFromGlobalId(exe, input.pullRequestId);
      if (found === null) {
        exe.errors.push({ message: 'Could not resolve the pull request for mergePullRequest' });
        return { __t: 'MergePullRequestPayload', pullRequest: null };
      }
      const { repo, pull } = found;
      const method = str(input.mergeMethod).toLowerCase() || 'merge';
      const result = performMerge(exe.ctx, repo, pull, method);
      if (result === null) {
        exe.errors.push({ message: 'Pull Request is not mergeable' });
        return { __t: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull) };
      }
      return { __t: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull) };
    }
    case 'addComment': {
      const found = issueFromGlobalId(exe, input.subjectId);
      if (found === null) {
        exe.errors.push({ message: 'Could not resolve the subject for addComment' });
        return { __t: 'AddCommentPayload', commentEdge: null };
      }
      const { repo, issue } = found;
      const at = store.tick();
      const comment: Comment = {
        id: store.nextNodeDbId(),
        body: str(input.body),
        createdAt: at,
        updatedAt: at,
      };
      issue.comments.push(comment);
      issue.updatedAt = at;
      return {
        __t: 'AddCommentPayload',
        commentEdge: { __t: 'CommentEdge', node: commentObj(repo, issue, comment), cursor: null },
      };
    }
    default:
      return null;
  }
}

function resolveField(exe: Exe, typeName: string, source: GObj, name: string, args: Record<string, unknown>): unknown {
  const store = exe.ctx.store;
  switch (typeName) {
    case 'Query':
      switch (name) {
        case 'viewer':
          return userObj(exe);
        case 'repository': {
          const repo = store.repoAt(str(args.owner), str(args.name));
          return repo === null ? null : repoObj(repo);
        }
        case 'node':
          return decodeNode(exe, str(args.id));
        case '__type':
          return typeObj(str(args.name));
        case '__schema':
          return { __t: '__Schema' };
        default:
          return null;
      }
    case 'Mutation':
      return runMutation(exe, name, args);
    case 'User':
      switch (name) {
        case 'id':
          return userGlobalId(store.loginOr(''));
        case 'login':
          return store.loginOr('');
        case 'name':
          return store.loginOr('');
        default:
          return null;
      }
    case 'Repository': {
      const repo = source.repo as Repo;
      switch (name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${store.loginOr('')}/${repo.name}`;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'hasProjectsEnabled':
          return false;
        case 'owner':
          return userObj(exe);
        case 'defaultBranchRef':
          return repo.refs.has(`refs/heads/${repo.defaultBranch}`)
            ? { __t: 'Ref', repo, name: repo.defaultBranch }
            : null;
        case 'issue': {
          const issue = repo.issues.get(num(args.number));
          return issue === undefined ? null : issueObj(repo, issue);
        }
        case 'issues':
          return issuesConnection(exe, repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.get(num(args.number));
          return pull === undefined ? null : pullObj(repo, pull);
        }
        case 'pullRequests':
          return pullsConnection(exe, repo, args);
        case 'createdAt':
          return isoOf(repo.createdAt);
        case 'updatedAt':
          return isoOf(repo.updatedAt);
        default:
          return null;
      }
    }
    case 'Ref':
      return name === 'name' ? source.name : name === 'prefix' ? 'refs/heads/' : null;
    case 'Issue': {
      const repo = source.repo as Repo;
      const issue = source.issue as Issue;
      switch (name) {
        case 'id':
          return issueGlobalId(repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state.toUpperCase();
        case 'author':
          return userObj(exe);
        case 'repository':
          return repoObj(repo);
        case 'createdAt':
          return isoOf(issue.createdAt);
        case 'updatedAt':
          return isoOf(issue.updatedAt);
        case 'closedAt':
          return issue.closedAt === null ? null : isoOf(issue.closedAt);
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const repo = source.repo as Repo;
      const pull = source.pull as Pull;
      switch (name) {
        case 'id':
          return pullGlobalId(repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'mergeable':
          if (pull.state !== 'open') return 'UNKNOWN';
          return pullMergeable(exe.ctx, repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'headRef':
          return { __t: 'Ref', repo, name: pull.headRef };
        case 'baseRef':
          return { __t: 'Ref', repo, name: pull.baseRef };
        case 'author':
          return userObj(exe);
        case 'repository':
          return repoObj(repo);
        case 'files':
          return filesConnection(exe, repo, pull, args);
        case 'createdAt':
          return isoOf(pull.createdAt);
        case 'updatedAt':
          return isoOf(pull.updatedAt);
        case 'closedAt':
          return pull.state === 'closed' ? isoOf(pull.updatedAt) : null;
        case 'mergedAt':
          return pull.mergedAt === null ? null : isoOf(pull.mergedAt);
        default:
          return null;
      }
    }
    case 'PullRequestFile':
      return name === 'path' ? source.path : name === 'additions' ? source.additions : name === 'deletions' ? source.deletions : null;
    case 'IssueComment': {
      const comment = source.comment as Comment;
      switch (name) {
        case 'id':
          return commentGlobalId(comment);
        case 'body':
          return comment.body;
        case 'author':
          return userObj(exe);
        case 'createdAt':
          return isoOf(comment.createdAt);
        case 'updatedAt':
          return isoOf(comment.updatedAt);
        default:
          return null;
      }
    }
    case 'Connection':
      switch (name) {
        case 'nodes':
          return source.nodes;
        case 'edges':
          return (source.nodes as GObj[]).map((node, index) => ({
            __t: 'Edge',
            node,
            cursor: cursorOf((source.pageKeys as string[])[index] as string),
          }));
        case 'pageInfo':
          return source.pageInfo;
        case 'totalCount':
          return source.totalCount;
        default:
          return null;
      }
    case 'Edge':
      return name === 'node' ? source.node : name === 'cursor' ? source.cursor : null;
    case 'PageInfo':
      return source[name] ?? null;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      return name === 'issue' ? source.issue : null;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      return name === 'pullRequest' ? source.pullRequest : null;
    case 'AddCommentPayload':
      return name === 'commentEdge' ? source.commentEdge : null;
    case 'CommentEdge':
      return name === 'node' ? source.node : name === 'cursor' ? source.cursor : null;
    case '__Type':
      switch (name) {
        case 'name':
          return source.name;
        case 'kind':
          return source.kind;
        case 'description':
          return null;
        case 'fields':
          return source.fields;
        case 'enumValues':
          return source.enumValues;
        default:
          return null;
      }
    case '__Field':
    case '__EnumValue':
      return name === 'name' ? source.name : name === 'isDeprecated' ? false : null;
    case '__Schema':
      switch (name) {
        case 'types':
          return Object.keys(TYPE_FIELDS).map((typeName) => typeObj(typeName)).filter((entry) => entry !== null);
        case 'queryType':
          return typeObj('Query');
        case 'mutationType':
          return typeObj('Mutation');
        case 'directives':
          return [];
        default:
          return null;
      }
    default:
      return null;
  }
}

// --------------------------------------------------------------- executor

function runtimeType(source: unknown, fallback: string): string {
  if (typeof source === 'object' && source !== null && typeof (source as GObj).__t === 'string') {
    return (source as GObj).__t;
  }
  return fallback;
}

function completeValue(exe: Exe, value: unknown, selection: GqlSel[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(exe, entry, selection));
  if (selection !== null && typeof value === 'object') {
    return executeSelectionSet(exe, runtimeType(value, ''), value as GObj, selection);
  }
  return value;
}

function executeSelectionSet(exe: Exe, typeName: string, source: GObj, selections: GqlSel[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const apply = (list: GqlSel[], type: string): void => {
    for (const sel of list) {
      if (sel.kind === 'fragment') {
        if (sel.typeCondition === null || sel.typeCondition === runtimeType(source, type)) {
          apply(sel.selection, sel.typeCondition ?? type);
        }
        continue;
      }
      if (sel.kind === 'spread') {
        const fragment = exe.fragments.get(sel.name);
        if (fragment !== undefined) apply(fragment, type);
        continue;
      }
      const key = sel.alias ?? sel.name;
      if (sel.name === '__typename') {
        out[key] = runtimeType(source, type);
        continue;
      }
      const fields = TYPE_FIELDS[type];
      if (fields === undefined || !fields.includes(sel.name)) {
        exe.errors.push({ message: `Field '${sel.name}' doesn't exist on type '${type}'` });
        out[key] = null;
        continue;
      }
      const raw = resolveField(exe, type, source, sel.name, resolveArgs(sel, exe));
      out[key] = completeValue(exe, raw, sel.selection);
    }
  };
  apply(selections, typeName);
  return out;
}

function runOperation(ctx: Ctx, entry: unknown): Record<string, unknown> {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { errors: [{ message: 'The request body is not a GraphQL operation' }] };
  }
  const request = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof request.query !== 'string') return { errors: [{ message: 'A query string is required' }] };
  let doc: GqlDoc;
  try {
    doc = parseGraphql(request.query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'could not parse the query' }] };
  }
  const operation =
    typeof request.operationName === 'string'
      ? doc.operations.find((candidate) => candidate.name === request.operationName)
      : doc.operations[0];
  if (operation === undefined) return { errors: [{ message: 'The operation was not found' }] };
  const exe: Exe = {
    ctx,
    variables:
      typeof request.variables === 'object' && request.variables !== null
        ? (request.variables as Record<string, unknown>)
        : {},
    fragments: doc.fragments,
    errors: [],
  };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(exe, rootType, { __t: rootType }, operation.selection);
  const out: Record<string, unknown> = { data };
  if (exe.errors.length > 0) out.errors = exe.errors;
  return out;
}

export async function handleGraphql(ctx: Ctx, _req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((entry) => runOperation(ctx, entry)));
    return;
  }
  sendJson(res, 200, runOperation(ctx, parsed));
}
