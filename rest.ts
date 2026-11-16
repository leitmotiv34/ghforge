// REST v3 surface: repositories, branches, commits, contents, labels,
// issues, comments and pull requests (with squash merges), all over the
// same store the git surface writes. Contents writes are real git commits
// on the branch they name, so a file committed here is the file a clone
// fetches, and a pull request's merge is a real squash commit on the base.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx } from './app.ts';
import { sendJson } from './app.ts';
import { isoOf, type Issue, type Pull, type Repo } from './store.ts';
import {
  buildCommit,
  buildTree,
  identityLine,
  parseCommit,
  parseTree,
  putObject,
  type TreeEntry,
} from './gitobj.ts';

const FORGE_NAME = 'ghforge';
const FORGE_EMAIL = 'ghforge@example.invalid';

// ------------------------------------------------------------------- helpers

export function repoJson(ctx: Ctx, repo: Repo): Record<string, unknown> {
  const login = ctx.store.loginOr('');
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: { login, id: 1, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: isoOf(repo.createdAt),
    updated_at: isoOf(repo.updatedAt),
    pushed_at: isoOf(repo.updatedAt),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

export function parseJsonBody(body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return {};
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label === undefined ? 0 : [...repo.labels.keys()].indexOf(name) + 1,
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
  };
}

export function issueJson(ctx: Ctx, repo: Repo, issue: Issue): Record<string, unknown> {
  const login = ctx.store.loginOr('');
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login, id: 1, type: 'User' },
    comments: issue.comments.length,
    created_at: isoOf(issue.createdAt),
    updated_at: isoOf(issue.updatedAt),
    closed_at: issue.closedAt === null ? null : isoOf(issue.closedAt),
  };
}

export function pullJson(ctx: Ctx, repo: Repo, pull: Pull): Record<string, unknown> {
  const login = ctx.store.loginOr('');
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt === null ? null : isoOf(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    user: { login, id: 1, type: 'User' },
    head: { ref: pull.headRef, sha: headSha, label: `${login}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${login}:${pull.baseRef}` },
    created_at: isoOf(pull.createdAt),
    updated_at: isoOf(pull.updatedAt),
    closed_at: pull.state === 'closed' ? isoOf(pull.updatedAt) : null,
    draft: false,
  };
}

function commitJson(ctx: Ctx, sha: string): Record<string, unknown> {
  const obj = ctx.store.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return { sha };
  const commit = parseCommit(obj.data);
  const person = (line: string): Record<string, unknown> => {
    const match = /^(.*) <(.*)> (\d+) /.exec(line);
    return {
      name: match?.[1] ?? '',
      email: match?.[2] ?? '',
      date: isoOf(Number(match?.[3] ?? 0)),
    };
  };
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      message: commit.message.replace(/\n$/, ''),
      author: person(commit.author),
      committer: person(commit.committer),
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ------------------------------------------------------------- tree plumbing

/** The flattened path -> blob sha map of a commit's tree (files only). */
function flattenTree(ctx: Ctx, treeSha: string, prefix = ''): Map<string, { sha: string; mode: string }> {
  const out = new Map<string, { sha: string; mode: string }>();
  const tree = ctx.store.objects.get(treeSha);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    if (entry.mode === '40000') {
      for (const [path, value] of flattenTree(ctx, entry.oid, `${prefix}${entry.name}/`)) out.set(path, value);
    } else {
      out.set(`${prefix}${entry.name}`, { sha: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** Write a tree from a flattened file map, rebuilding nested trees. */
function writeTreeFromFiles(ctx: Ctx, files: Map<string, { sha: string; mode: string }>): string {
  interface Node {
    files: Map<string, { sha: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      if (!node.dirs.has(segments[i])) node.dirs.set(segments[i], { files: new Map(), dirs: new Map() });
      node = node.dirs.get(segments[i]) as Node;
    }
    node.files.set(segments[segments.length - 1], value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.sha });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(ctx.store, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The tree sha of a commit, or null. */
function treeOfCommit(ctx: Ctx, commitSha: string | undefined): string | null {
  if (commitSha === undefined) return null;
  const obj = ctx.store.objects.get(commitSha);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** Resolve a ref name (branch short name, full ref, or sha) to a commit sha. */
function resolveRef(ctx: Ctx, repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const byBranch = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
  if (byBranch !== undefined) return byBranch;
  const obj = ctx.store.objects.get(ref);
  return obj !== undefined && obj.type === 'commit' ? ref : null;
}

/** Commit a new tree on a branch and advance the branch ref. */
function commitOnRef(ctx: Ctx, repo: Repo, branch: string, treeSha: string, message: string): string {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const at = ctx.store.tick();
  const identity = identityLine(FORGE_NAME, FORGE_EMAIL, at);
  const data = buildCommit({
    tree: treeSha,
    parents: parent === undefined ? [] : [parent],
    author: identity,
    committer: identity,
    message,
  });
  const sha = putObject(ctx.store, 'commit', data);
  repo.refs.set(ref, sha);
  repo.updatedAt = at;
  return sha;
}

/** Merge-base of two commits: the common ancestor with the shortest path. */
function mergeBase(ctx: Ctx, a: string, b: string): string | null {
  const ancestorsOf = (tip: string): Map<string, number> => {
    const dist = new Map<string, number>();
    const queue: [string, number][] = [[tip, 0]];
    while (queue.length > 0) {
      const [sha, d] = queue.shift() as [string, number];
      if (dist.has(sha)) continue;
      dist.set(sha, d);
      const obj = ctx.store.objects.get(sha);
      if (obj !== undefined && obj.type === 'commit') {
        for (const parent of parseCommit(obj.data).parents) queue.push([parent, d + 1]);
      }
    }
    return dist;
  };
  const fromA = ancestorsOf(a);
  const fromB = ancestorsOf(b);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [sha, d] of fromA) {
    const other = fromB.get(sha);
    if (other !== undefined && d + other < bestScore) {
      bestScore = d + other;
      best = sha;
    }
  }
  return best;
}

// ---------------------------------------------------------------- pagination

interface Page {
  items: unknown[];
  link: string | null;
}

function paginate(req: IncomingMessage, path: string, query: URLSearchParams, all: unknown[]): Page {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < all.length) {
    const host = req.headers.host ?? 'localhost';
    const next = new URLSearchParams(query);
    next.set('page', String(page + 1));
    next.set('per_page', String(perPage));
    const last = new URLSearchParams(query);
    last.set('page', String(Math.ceil(all.length / perPage)));
    last.set('per_page', String(perPage));
    link = `<http://${host}${path}?${next.toString()}>; rel="next", <http://${host}${path}?${last.toString()}>; rel="last"`;
  }
  return { items, link };
}

function sendPage(res: ServerResponse, page: Page): void {
  sendJson(res, 200, page.items, page.link === null ? {} : { link: page.link });
}

// -------------------------------------------------------------------- routes

export async function handleRest(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  query: URLSearchParams,
  body: Buffer,
): Promise<void> {
  const method = req.method ?? 'GET';
  const store = ctx.store;
  const notFound = (): void => sendJson(res, 404, { message: 'Not Found' });
  const badJson = (): void => sendJson(res, 400, { message: 'Problems parsing JSON' });

  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0', github_hostname: 'forge.local', admin_login: store.loginOr('') });
    return;
  }

  // ------------------------------------------------------------ repo create
  if (method === 'POST' && path === '/api/v3/user/repos') {
    const data = parseJsonBody(body);
    if (data === null) return badJson();
    const name = typeof data.name === 'string' ? data.name : '';
    if (name === '') {
      sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] });
      return;
    }
    if (store.repos.has(name)) {
      sendJson(res, 422, {
        message: 'Repository creation failed.',
        errors: [{ resource: 'Repository', field: 'name', code: 'already_exists', message: 'name already exists on this account' }],
      });
      return;
    }
    const repo = store.createRepo(name, {
      description: typeof data.description === 'string' ? data.description : null,
      isPrivate: typeof data.private === 'boolean' ? data.private : false,
      defaultBranch: typeof data.default_branch === 'string' && data.default_branch !== '' ? data.default_branch : 'main',
    });
    sendJson(res, 201, repoJson(ctx, repo));
    return;
  }

  if (method === 'GET' && path === '/api/v3/user/repos') {
    const all = [...store.repos.values()].sort((a, b) => a.seq - b.seq).map((repo) => repoJson(ctx, repo));
    sendPage(res, paginate(req, path, query, all));
    return;
  }

  // ------------------------------------------------------- repo-scoped routes
  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (repoMatch === null) return notFound();
  const owner = decodeURIComponent(repoMatch[1]);
  const repoName = decodeURIComponent(repoMatch[2]);
  const repo = store.repoAt(owner, repoName);
  if (repo === null) return notFound();
  const rest = repoMatch[3] ?? '';

  if (rest === '') {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(ctx, repo));
      return;
    }
    if (method === 'PATCH') {
      const data = parseJsonBody(body);
      if (data === null) return badJson();
      if (typeof data.description === 'string') repo.description = data.description;
      if (typeof data.private === 'boolean') repo.isPrivate = data.private;
      if (typeof data.default_branch === 'string' && data.default_branch !== '') repo.defaultBranch = data.default_branch;
      if (typeof data.name === 'string' && data.name !== '' && data.name !== repo.name && !store.repos.has(data.name)) {
        store.repos.delete(repo.name);
        repo.name = data.name;
        store.repos.set(repo.name, repo);
      }
      repo.updatedAt = store.tick();
      sendJson(res, 200, repoJson(ctx, repo));
      return;
    }
    if (method === 'DELETE') {
      store.repos.delete(repo.name);
      res.writeHead(204);
      res.end();
      return;
    }
    return notFound();
  }

  // -------------------------------------------------------------- branches
  if (rest === '/branches' && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, type: 'commit' }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    sendJson(res, 200, branches);
    return;
  }

  if (rest === '/git/refs' && method === 'POST') {
    const data = parseJsonBody(body);
    if (data === null) return badJson();
    const ref = typeof data.ref === 'string' ? data.ref : '';
    const sha = typeof data.sha === 'string' ? data.sha : '';
    if (!ref.startsWith('refs/') || store.objects.get(sha)?.type !== 'commit') {
      sendJson(res, 422, { message: 'Object is not a commit or ref is invalid' });
      return;
    }
    if (repo.refs.has(ref)) {
      sendJson(res, 422, { message: 'Reference already exists' });
      return;
    }
    repo.refs.set(ref, sha);
    repo.updatedAt = store.tick();
    sendJson(res, 201, { ref, node_id: `REF_${ref}`, object: { sha, type: 'commit' } });
    return;
  }

  // --------------------------------------------------------------- commits
  if (rest === '/commits' && method === 'GET') {
    const tip = resolveRef(ctx, repo, query.get('sha') ?? undefined);
    if (tip === null) {
      sendJson(res, 200, []);
      return;
    }
    const seen = new Map<string, number>();
    const queue: [string, number][] = [[tip, 0]];
    while (queue.length > 0) {
      const [sha, d] = queue.shift() as [string, number];
      if (seen.has(sha)) continue;
      seen.set(sha, d);
      const obj = store.objects.get(sha);
      if (obj !== undefined && obj.type === 'commit') {
        for (const parent of parseCommit(obj.data).parents) queue.push([parent, d + 1]);
      }
    }
    const ordered = [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([sha]) => commitJson(ctx, sha));
    sendPage(res, paginate(req, path, query, ordered));
    return;
  }

  // -------------------------------------------------------------- contents
  if (rest === '/contents' || rest.startsWith('/contents/')) {
    const filePath = rest === '/contents' ? '' : decodeURIComponent(rest.slice('/contents/'.length));
    return contentsRoute(ctx, req, res, repo, filePath, query, body);
  }

  // ---------------------------------------------------------------- labels
  if (rest === '/labels' && method === 'POST') {
    const data = parseJsonBody(body);
    if (data === null) return badJson();
    const name = typeof data.name === 'string' ? data.name : '';
    if (name === '') {
      sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', field: 'name', code: 'missing_field' }] });
      return;
    }
    if (repo.labels.has(name)) {
      sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', field: 'name', code: 'already_exists' }] });
      return;
    }
    repo.labels.set(name, {
      name,
      color: typeof data.color === 'string' ? data.color.replace(/^#/, '') : 'ededed',
      description: typeof data.description === 'string' ? data.description : null,
    });
    sendJson(res, 201, labelJson(repo, name));
    return;
  }
  if (rest === '/labels' && method === 'GET') {
    sendJson(res, 200, [...repo.labels.keys()].map((name) => labelJson(repo, name)));
    return;
  }

  // ---------------------------------------------------------------- issues
  if (rest === '/issues' && method === 'POST') {
    const data = parseJsonBody(body);
    if (data === null) return badJson();
    const labelNames = Array.isArray(data.labels)
      ? data.labels.map((entry) => (typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? String((entry as { name?: unknown }).name ?? '') : '')).filter((name) => name !== '')
      : [];
    for (const name of labelNames) {
      if (!repo.labels.has(name)) {
        sendJson(res, 422, { message: `Label '${name}' does not exist`, errors: [{ resource: 'Issue', field: 'labels', code: 'invalid' }] });
        return;
      }
    }
    const at = store.tick();
    const issue: Issue = {
      number: repo.nextNumber,
      id: store.nextNodeDbId(),
      title: typeof data.title === 'string' ? data.title : '',
      body: typeof data.body === 'string' ? data.body : '',
      state: 'open',
      labels: labelNames,
      comments: [],
      createdAt: at,
      updatedAt: at,
      closedAt: null,
      seq: store.seq(),
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    sendJson(res, 201, issueJson(ctx, repo, issue));
    return;
  }

  if (rest === '/issues' && method === 'GET') {
    const state = query.get('state') ?? 'open';
    const sort = query.get('sort') ?? 'created';
    const direction = query.get('direction') ?? 'desc';
    let list = [...repo.issues.values()];
    if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
    const key = sort === 'updated' ? 'updatedAt' : 'createdAt';
    list.sort((a, b) => (direction === 'asc' ? a[key] - b[key] || a.seq - b.seq : b[key] - a[key] || b.seq - a.seq));
    sendPage(res, paginate(req, path, query, list.map((issue) => issueJson(ctx, repo, issue))));
    return;
  }

  const issueMatch = /^\/issues\/(\d+)$/.exec(rest);
  if (issueMatch !== null) {
    const issue = repo.issues.get(Number(issueMatch[1]));
    if (issue === undefined) return notFound();
    if (method === 'GET') {
      sendJson(res, 200, issueJson(ctx, repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const data = parseJsonBody(body);
      if (data === null) return badJson();
      if (typeof data.title === 'string') issue.title = data.title;
      if (typeof data.body === 'string') issue.body = data.body;
      if (data.state === 'closed' && issue.state !== 'closed') {
        issue.state = 'closed';
        issue.closedAt = store.tick();
      } else if (data.state === 'open' && issue.state !== 'open') {
        issue.state = 'open';
        issue.closedAt = null;
      }
      if (Array.isArray(data.labels)) {
        const names = data.labels.map((entry) => (typeof entry === 'string' ? entry : '')).filter((name) => name !== '');
        for (const name of names) if (!repo.labels.has(name)) {
          sendJson(res, 422, { message: `Label '${name}' does not exist` });
          return;
        }
        issue.labels = names;
      }
      issue.updatedAt = store.tick();
      sendJson(res, 200, issueJson(ctx, repo, issue));
      return;
    }
    return notFound();
  }

  const commentsMatch = /^\/issues\/(\d+)\/comments$/.exec(rest);
  if (commentsMatch !== null) {
    const issue = repo.issues.get(Number(commentsMatch[1]));
    if (issue === undefined) return notFound();
    if (method === 'POST') {
      const data = parseJsonBody(body);
      if (data === null) return badJson();
      const at = store.tick();
      const comment = {
        id: store.nextNodeDbId(),
        body: typeof data.body === 'string' ? data.body : '',
        createdAt: at,
        updatedAt: at,
      };
      issue.comments.push(comment);
      issue.updatedAt = at;
      sendJson(res, 201, {
        id: comment.id,
        node_id: `IC_${comment.id}`,
        body: comment.body,
        user: { login: store.loginOr(''), id: 1, type: 'User' },
        created_at: isoOf(comment.createdAt),
        updated_at: isoOf(comment.updatedAt),
      });
      return;
    }
    if (method === 'GET') {
      sendJson(
        res,
        200,
        issue.comments.map((comment) => ({
          id: comment.id,
          node_id: `IC_${comment.id}`,
          body: comment.body,
          user: { login: store.loginOr(''), id: 1, type: 'User' },
          created_at: isoOf(comment.createdAt),
          updated_at: isoOf(comment.updatedAt),
        })),
      );
      return;
    }
    return notFound();
  }

  // ----------------------------------------------------------------- pulls
  if (rest === '/pulls' && method === 'POST') {
    const data = parseJsonBody(body);
    if (data === null) return badJson();
    const head = typeof data.head === 'string' ? data.head.replace(/^[^:]+:/, '') : '';
    const base = typeof data.base === 'string' ? data.base : '';
    if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
      sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] });
      return;
    }
    const at = store.tick();
    const pull: Pull = {
      number: repo.nextNumber,
      id: store.nextNodeDbId(),
      title: typeof data.title === 'string' ? data.title : '',
      body: typeof data.body === 'string' ? data.body : '',
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
    sendJson(res, 201, pullJson(ctx, repo, pull));
    return;
  }

  if (rest === '/pulls' && method === 'GET') {
    const state = query.get('state') ?? 'open';
    let list = [...repo.pulls.values()];
    if (state === 'open') list = list.filter((pull) => pull.state === 'open');
    else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
    list.sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq);
    sendPage(res, paginate(req, path, query, list.map((pull) => pullJson(ctx, repo, pull))));
    return;
  }

  const pullMatch = /^\/pulls\/(\d+)$/.exec(rest);
  if (pullMatch !== null && method === 'GET') {
    const pull = repo.pulls.get(Number(pullMatch[1]));
    if (pull === undefined) return notFound();
    sendJson(res, 200, pullJson(ctx, repo, pull));
    return;
  }

  const pullFilesMatch = /^\/pulls\/(\d+)\/files$/.exec(rest);
  if (pullFilesMatch !== null && method === 'GET') {
    const pull = repo.pulls.get(Number(pullFilesMatch[1]));
    if (pull === undefined) return notFound();
    sendJson(res, 200, pullFiles(ctx, repo, pull));
    return;
  }

  const pullMergeMatch = /^\/pulls\/(\d+)\/merge$/.exec(rest);
  if (pullMergeMatch !== null && method === 'PUT') {
    const data = parseJsonBody(body);
    if (data === null) return badJson();
    const pull = repo.pulls.get(Number(pullMergeMatch[1]));
    if (pull === undefined) return notFound();
    return mergePullRoute(ctx, res, repo, pull, data);
  }

  return notFound();
}

// --------------------------------------------------------------- contents

function contentsRoute(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  filePath: string,
  query: URLSearchParams,
  body: Buffer,
): void {
  const method = req.method ?? 'GET';
  const store = ctx.store;

  if (method === 'GET') {
    const tip = resolveRef(ctx, repo, query.get('ref') ?? undefined);
    if (tip === null) {
      if (filePath === '') {
        sendJson(res, 200, []);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const treeSha = treeOfCommit(ctx, tip) as string;
    // Walk to the addressed tree or blob.
    let currentTree = treeSha;
    let found: { sha: string; mode: string } | null = null;
    let isDir = filePath === '';
    if (filePath !== '') {
      const segments = filePath.split('/');
      for (let i = 0; i < segments.length; i += 1) {
        const tree = store.objects.get(currentTree);
        if (tree === undefined || tree.type !== 'tree') {
          found = null;
          isDir = false;
          break;
        }
        const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
        if (entry === undefined) {
          found = null;
          isDir = false;
          break;
        }
        if (i === segments.length - 1) {
          found = { sha: entry.oid, mode: entry.mode };
          isDir = entry.mode === '40000';
          if (isDir) currentTree = entry.oid;
        } else if (entry.mode === '40000') {
          currentTree = entry.oid;
        } else {
          found = null;
          isDir = false;
          break;
        }
      }
    }
    if (isDir) {
      const tree = store.objects.get(currentTree);
      if (tree === undefined || tree.type !== 'tree') {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const entries = parseTree(tree.data)
        .map((entry) => {
          const blob = store.objects.get(entry.oid);
          return {
            name: entry.name,
            path: filePath === '' ? entry.name : `${filePath}/${entry.name}`,
            sha: entry.oid,
            size: entry.mode === '40000' ? 0 : (blob?.data.length ?? 0),
            type: entry.mode === '40000' ? 'dir' : 'file',
          };
        })
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, 200, entries);
      return;
    }
    if (found === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const blob = store.objects.get(found.sha);
    if (blob === undefined || blob.type !== 'blob') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 200, {
      name: filePath.split('/').pop(),
      path: filePath,
      sha: found.sha,
      size: blob.data.length,
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
    });
    return;
  }

  if (method === 'PUT') {
    const data = parseJsonBody(body);
    if (data === null) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const branch = typeof data.branch === 'string' && data.branch !== '' ? data.branch : repo.defaultBranch;
    const message = typeof data.message === 'string' ? data.message : 'Update file';
    const content = Buffer.from(typeof data.content === 'string' ? data.content : '', 'base64');
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const files = tip === undefined ? new Map<string, { sha: string; mode: string }>() : flattenTree(ctx, treeOfCommit(ctx, tip) as string);
    const existing = files.get(filePath);
    const givenSha = typeof data.sha === 'string' ? data.sha : undefined;
    if (existing !== undefined) {
      if (givenSha === undefined) {
        sendJson(res, 422, { message: '"sha" wasn\'t supplied' });
        return;
      }
      if (givenSha !== existing.sha) {
        sendJson(res, 409, { message: `${filePath} does not match ${givenSha}` });
        return;
      }
    } else if (givenSha !== undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const blobSha = putObject(store, 'blob', content);
    files.set(filePath, { sha: blobSha, mode: existing?.mode ?? '100644' });
    const treeSha = writeTreeFromFiles(ctx, files);
    const commitSha = commitOnRef(ctx, repo, branch, treeSha, message);
    sendJson(res, existing !== undefined ? 200 : 201, {
      content: {
        name: filePath.split('/').pop(),
        path: filePath,
        sha: blobSha,
        size: content.length,
        type: 'file',
        encoding: 'base64',
      },
      commit: { sha: commitSha, message },
    });
    return;
  }

  if (method === 'DELETE') {
    const data = parseJsonBody(body);
    if (data === null) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const branch = typeof data.branch === 'string' && data.branch !== '' ? data.branch : repo.defaultBranch;
    const message = typeof data.message === 'string' ? data.message : 'Delete file';
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const files = flattenTree(ctx, treeOfCommit(ctx, tip) as string);
    const existing = files.get(filePath);
    if (existing === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const givenSha = typeof data.sha === 'string' ? data.sha : undefined;
    if (givenSha !== undefined && givenSha !== existing.sha) {
      sendJson(res, 409, { message: `${filePath} does not match ${givenSha}` });
      return;
    }
    files.delete(filePath);
    const treeSha = writeTreeFromFiles(ctx, files);
    const commitSha = commitOnRef(ctx, repo, branch, treeSha, message);
    sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

// ------------------------------------------------------------------- pulls

/** Line counts for a changed file: additions, deletions, changes. */
function lineCounts(before: string | null, after: string | null): { additions: number; deletions: number; changes: number } {
  const countLines = (text: string): number => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
  if (before === null && after !== null) {
    const additions = countLines(after);
    return { additions, deletions: 0, changes: additions };
  }
  if (after === null && before !== null) {
    const deletions = countLines(before);
    return { additions: 0, deletions, changes: deletions };
  }
  if (before === null || after === null) return { additions: 0, deletions: 0, changes: 0 };
  const beforeLines = new Map<string, number>();
  for (const line of before.split('\n')) beforeLines.set(line, (beforeLines.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of after.split('\n')) {
    const held = beforeLines.get(line) ?? 0;
    if (held > 0) beforeLines.set(line, held - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const count of beforeLines.values()) deletions += count;
  return { additions, deletions, changes: additions + deletions };
}

export function pullFiles(ctx: Ctx, repo: Repo, pull: Pull): Record<string, unknown>[] {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return [];
  const base = mergeBase(ctx, headTip, baseTip) ?? baseTip;
  const baseFiles = flattenTree(ctx, treeOfCommit(ctx, base) as string);
  const headFiles = flattenTree(ctx, treeOfCommit(ctx, headTip) as string);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const out: Record<string, unknown>[] = [];
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before?.sha === after?.sha) continue;
    const beforeText = before === undefined ? null : (ctx.store.objects.get(before.sha)?.data.toString('utf8') ?? null);
    const afterText = after === undefined ? null : (ctx.store.objects.get(after.sha)?.data.toString('utf8') ?? null);
    const counts = lineCounts(beforeText, afterText);
    out.push({
      sha: after?.sha ?? before?.sha ?? '',
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.changes,
    });
  }
  return out;
}

/**
 * The three-way merge plan for a pull request: the merged tree and the two
 * tips, or null when a branch is missing or a path changed on both sides
 * since the merge base with different results (a conflict).
 */
function planMerge(ctx: Ctx, repo: Repo, pull: Pull): { treeSha: string; baseTip: string; headTip: string } | null {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return null;
  const base = mergeBase(ctx, headTip, baseTip) ?? baseTip;
  const baseFiles = flattenTree(ctx, treeOfCommit(ctx, base) as string);
  const headFiles = flattenTree(ctx, treeOfCommit(ctx, headTip) as string);
  const currentFiles = flattenTree(ctx, treeOfCommit(ctx, baseTip) as string);

  // Three-way, per path: a path changed on both sides since the merge base
  // with different results is a conflict; otherwise the head's change (if
  // any) is applied onto the current base tree.
  const result = new Map(currentFiles);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...currentFiles.keys()]);
  for (const path of paths) {
    const atBase = baseFiles.get(path)?.sha;
    const atHead = headFiles.get(path)?.sha;
    const atCurrent = currentFiles.get(path)?.sha;
    if (atHead === atBase) continue;
    if (atCurrent !== atBase && atCurrent !== atHead) return null;
    if (atHead === undefined) result.delete(path);
    else result.set(path, headFiles.get(path) as { sha: string; mode: string });
  }
  return { treeSha: writeTreeFromFiles(ctx, result), baseTip, headTip };
}

/** Whether the pull request's branches still merge without a conflict. */
export function pullMergeable(ctx: Ctx, repo: Repo, pull: Pull): boolean {
  if (pull.merged || pull.state === 'closed') return false;
  return planMerge(ctx, repo, pull) !== null;
}

/**
 * Merge an open pull request onto its base branch: a squash merge writes a
 * single-parent commit carrying the pull's title, any other method a
 * two-parent merge commit. Answers the merge commit's sha, or null when
 * the merge is not possible. Shared by the REST and GraphQL surfaces so a
 * merge reads the same from both.
 */
export function performMerge(ctx: Ctx, repo: Repo, pull: Pull, method: string): { sha: string } | null {
  const store = ctx.store;
  if (pull.merged || pull.state === 'closed') return null;
  const plan = planMerge(ctx, repo, pull);
  if (plan === null) return null;
  let mergeSha: string;
  if (method === 'squash') {
    const at = store.tick();
    const identity = identityLine(FORGE_NAME, FORGE_EMAIL, at);
    mergeSha = putObject(
      store,
      'commit',
      buildCommit({
        tree: plan.treeSha,
        parents: [plan.baseTip],
        author: identity,
        committer: identity,
        message: `${pull.title} (#${pull.number})\n`,
      }),
    );
  } else {
    const at = store.tick();
    const identity = identityLine(FORGE_NAME, FORGE_EMAIL, at);
    mergeSha = putObject(
      store,
      'commit',
      buildCommit({
        tree: plan.treeSha,
        parents: [plan.baseTip, plan.headTip],
        author: identity,
        committer: identity,
        message: `Merge pull request #${pull.number}\n`,
      }),
    );
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  repo.updatedAt = store.tick();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.tick();
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = pull.mergedAt;
  return { sha: mergeSha };
}

function mergePullRoute(ctx: Ctx, res: ServerResponse, repo: Repo, pull: Pull, data: Record<string, unknown>): void {
  if (pull.merged || pull.state === 'closed') {
    sendJson(res, 405, { message: 'Pull Request is not mergeable' });
    return;
  }
  const method = typeof data.merge_method === 'string' ? data.merge_method : 'merge';
  const result = performMerge(ctx, repo, pull, method);
  if (result === null) {
    sendJson(res, 405, { message: 'Pull Request is not mergeable' });
    return;
  }
  sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
}
