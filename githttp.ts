// Git smart HTTP: the /{owner}/{repo}.git endpoints.
//
// - GET info/refs?service=git-upload-pack answers a protocol v2 capability
//   advertisement when the request carries Git-Protocol: version=2, and a
//   v0 ref advertisement otherwise. git-receive-pack is always v0.
// - POST git-upload-pack serves the v2 commands ls-refs and fetch (plus a
//   v0 fetch fallback), POST git-receive-pack serves v0 pushes with
//   report-status over side-band-64k.
//
// The fetch planner is the subtle part: it computes the exact object set a
// client is missing (wants minus the closure of its haves and shallow
// boundaries), honouring deepen limits, and reports how the shallow
// boundary moved.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx } from './app.ts';
import { sendBody, sendJson } from './app.ts';
import type { Repo, Store } from './store.ts';
import {
  ZERO_SHA,
  closureOf,
  commitClosure,
  isAncestor,
  parseCommit,
  parseTag,
  readPack,
  writePackForShas,
} from './gitobj.ts';
import type { GitObject } from './store.ts';
import { PKT_FLUSH, pktLine, readPkts, sideband } from './pktline.ts';

const AGENT = 'ghforge/1.0';

function headRefOf(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Follow tag objects to the commit they ultimately name (or null). */
function peelToCommit(store: Store, sha: string): string | null {
  let current = sha;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = store.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// ------------------------------------------------------------- advertisement

function v2Advertisement(res: ServerResponse): void {
  const parts = [
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  sendBody(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-advertisement');
}

function v0Advertisement(store: Store, repo: Repo, service: string, res: ServerResponse): void {
  const head = headRefOf(repo);
  const caps =
    service === 'git-receive-pack'
      ? `report-status side-band-64k delete-refs ofs-delta symref=HEAD:${head} agent=${AGENT}`
      : `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress symref=HEAD:${head} agent=${AGENT}`;
  const lines: string[] = [];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_SHA} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${repo.refs.get(head) ?? ZERO_SHA} HEAD\0${caps}\n`);
    for (const [name, sha] of refs) {
      lines.push(`${sha} ${name}\n`);
      const obj = store.objects.get(sha);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelToCommit(store, sha);
        if (peeled !== null) lines.push(`${peeled} ${name}^{}\n`);
      }
    }
  }
  const parts = [pktLine(`# service=${service}\n`), PKT_FLUSH, ...lines.map((line) => pktLine(line)), PKT_FLUSH];
  sendBody(res, 200, Buffer.concat(parts), `application/x-${service}-advertisement`);
}

// ------------------------------------------------------------------ ls-refs

function lsRefs(store: Store, repo: Repo, args: readonly string[], res: ServerResponse): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const head = headRefOf(repo);
  const headSha = repo.refs.get(head);
  if (matches('HEAD')) {
    if (headSha !== undefined) {
      lines.push(symrefs ? `${headSha} HEAD symref-target:${head}\n` : `${headSha} HEAD\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD symref-target:${head}\n`);
    }
  }
  for (const [name, sha] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${sha} ${name}`;
    if (peel) {
      const obj = store.objects.get(sha);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelToCommit(store, sha);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  const parts = [...lines.map((line) => pktLine(line)), PKT_FLUSH];
  sendBody(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

// -------------------------------------------------------------------- fetch

interface FetchPlan {
  objects: GitObject[];
  shas: string[];
  shallow: string[];
  unshallow: string[];
}

interface HeldSets {
  commits: Set<string>;
  objects: Set<string>;
}

/**
 * What the client already holds: the closure of its haves, except that a
 * shallow boundary cuts the walk — the boundary commit itself is held, its
 * parents are not, even though they are ancestors of a have.
 */
function heldSets(store: Store, haves: readonly string[], shallowClient: readonly string[]): HeldSets {
  const shallow = new Set(shallowClient);
  const commits = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (commits.has(sha)) continue;
    const obj = store.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    commits.add(sha);
    if (shallow.has(sha)) continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  for (const sha of shallowClient) {
    const obj = store.objects.get(sha);
    if (obj !== undefined && obj.type === 'commit') commits.add(sha);
  }
  const objects = new Set<string>();
  for (const sha of commits) {
    objects.add(sha);
    const commit = store.objects.get(sha);
    if (commit !== undefined && commit.type === 'commit') {
      for (const oid of closureOf(store, [parseCommit(commit.data).tree])) objects.add(oid);
    }
  }
  for (const have of haves) {
    const obj = store.objects.get(have);
    if (obj !== undefined && obj.type !== 'commit') {
      for (const oid of closureOf(store, [have])) objects.add(oid);
    }
  }
  return { commits, objects };
}

function planFetch(
  store: Store,
  wants: readonly string[],
  haves: readonly string[],
  shallowClient: readonly string[],
  depth: number | null,
): FetchPlan {
  const held = heldSets(store, haves, shallowClient);
  const heldCommits = held.commits;
  const heldObjects = held.objects;
  const shallowSet = new Set(shallowClient);

  // Distance (in commits) from the wants, by parent edges. Traversal stops
  // at fully held commits (their ancestors are held too) but passes through
  // shallow-held ones, whose parents a deepen may now deliver.
  const dist = new Map<string, number>();
  const queue: [string, number][] = [];
  for (const want of wants) {
    const commit = peelToCommit(store, want);
    if (commit !== null) queue.push([commit, 1]);
  }
  while (queue.length > 0) {
    const [sha, d] = queue.shift() as [string, number];
    if (depth !== null && d > depth) continue;
    const known = dist.get(sha);
    if (known !== undefined && known <= d) continue;
    dist.set(sha, d);
    if (heldCommits.has(sha) && !shallowSet.has(sha)) continue;
    const obj = store.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push([parent, d + 1]);
  }

  const sendCommits = new Set<string>();
  for (const sha of dist.keys()) if (!heldCommits.has(sha)) sendCommits.add(sha);

  const send = new Set<string>();
  for (const sha of sendCommits) {
    send.add(sha);
    const commit = store.objects.get(sha);
    if (commit !== undefined && commit.type === 'commit') {
      for (const oid of closureOf(store, [parseCommit(commit.data).tree])) send.add(oid);
    }
  }
  for (const want of wants) {
    const obj = store.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      // The tag chain itself travels; its commit is handled by the walk.
      let current = want;
      for (let hops = 0; hops < 16; hops += 1) {
        const tagObj = store.objects.get(current);
        if (tagObj === undefined || tagObj.type !== 'tag') break;
        send.add(current);
        current = parseTag(tagObj.data).object;
      }
    } else if (obj.type === 'tree' || obj.type === 'blob') {
      for (const oid of closureOf(store, [want])) send.add(oid);
    }
  }
  for (const oid of heldObjects) send.delete(oid);

  const shallow: string[] = [];
  const unshallow: string[] = [];
  const boundaryCandidates = new Set<string>([...sendCommits, ...shallowClient.filter((sha) => dist.has(sha))]);
  for (const sha of boundaryCandidates) {
    const obj = store.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    const covered = parents.every((parent) => sendCommits.has(parent) || heldCommits.has(parent));
    if (parents.length > 0 && !covered) shallow.push(sha);
    else if (shallowSet.has(sha)) unshallow.push(sha);
  }

  const shas = [...send].sort();
  const objects = shas
    .map((sha) => store.objects.get(sha))
    .filter((obj): obj is GitObject => obj !== undefined);
  return { objects, shas, shallow, unshallow };
}

// ------------------------------------------------------------ fetch cache

/**
 * Whole-response memoisation for fetch. A fetch response is a pure
 * function of the repository's ref tips and the request's wants, haves,
 * shallow list and depth: the object graph is append-only and
 * content-addressed, so identical tips plus identical arguments always
 * produce identical bytes. Concurrent identical clones (the common case)
 * therefore share one planned, packed response. The cache is a pure
 * optimisation with a small FIFO cap; correctness never depends on it.
 */
const fetchResponseCache = new Map<string, Buffer>();
const FETCH_CACHE_MAX_ENTRIES = 24;
const FETCH_CACHE_MAX_BYTES = 8 * 1024 * 1024;

function fetchCacheKey(
  repo: Repo,
  variant: string,
  wants: readonly string[],
  haves: readonly string[],
  shallowClient: readonly string[],
  depth: number | null,
): string {
  const tips = [...repo.refs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, sha]) => `${name}=${sha}`)
    .join(',');
  return [repo.name, variant, tips, wants.join(','), haves.join(','), shallowClient.join(','), depth ?? ''].join('|');
}

function fetchCacheGet(key: string): Buffer | undefined {
  return fetchResponseCache.get(key);
}

function fetchCachePut(key: string, body: Buffer): void {
  if (body.length > FETCH_CACHE_MAX_BYTES) return;
  if (fetchResponseCache.size >= FETCH_CACHE_MAX_ENTRIES) {
    const oldest = fetchResponseCache.keys().next().value;
    if (oldest !== undefined) fetchResponseCache.delete(oldest);
  }
  fetchResponseCache.set(key, body);
}

function fetchV2(store: Store, repo: Repo, args: readonly string[], res: ServerResponse): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowClient: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowClient.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7).trim(), 10);
  }
  const cacheKey = fetchCacheKey(repo, 'v2', wants, haves, shallowClient, depth);
  const cached = fetchCacheGet(cacheKey);
  if (cached !== undefined) {
    sendBody(res, 200, cached, 'application/x-git-upload-pack-result');
    return;
  }
  const plan = planFetch(store, wants, haves, shallowClient, depth);
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const wantClosure = commitClosure(store, wants.map((want) => peelToCommit(store, want)).filter((sha): sha is string => sha !== null));
    for (const have of haves) if (wantClosure.has(have)) parts.push(pktLine(`ACK ${have}\n`));
    parts.push(pktLine('ready\n'));
    parts.push(PKT_FLUSH);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
    parts.push(PKT_FLUSH);
  }
  const pack = writePackForShas(store, plan.shas);
  parts.push(pktLine('packfile\n'));
  const CHUNK = 32768;
  for (let at = 0; at < pack.length; at += CHUNK) {
    parts.push(sideband(1, pack.subarray(at, at + CHUNK)));
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  fetchCachePut(cacheKey, body);
  sendBody(res, 200, body, 'application/x-git-upload-pack-result');
}

function fetchV0(store: Store, repo: Repo, lines: readonly string[], res: ServerResponse): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowClient: string[] = [];
  let depth: number | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) shallowClient.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
  }
  const cacheKey = fetchCacheKey(repo, 'v0', wants, haves, shallowClient, depth);
  const cached = fetchCacheGet(cacheKey);
  if (cached !== undefined) {
    sendBody(res, 200, cached, 'application/x-git-upload-pack-result');
    return;
  }
  const plan = planFetch(store, wants, haves, shallowClient, depth);
  const parts: Buffer[] = [];
  for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
  for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
  parts.push(pktLine('NAK\n'));
  const pack = writePackForShas(store, plan.shas);
  const CHUNK = 32768;
  for (let at = 0; at < pack.length; at += CHUNK) {
    parts.push(sideband(1, pack.subarray(at, at + CHUNK)));
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  fetchCachePut(cacheKey, body);
  sendBody(res, 200, body, 'application/x-git-upload-pack-result');
}

function uploadPack(ctx: Ctx, repo: Repo, req: IncomingMessage, body: Buffer, res: ServerResponse): void {
  const store = ctx.store;
  let frames;
  try {
    frames = readPkts(body);
  } catch {
    sendBody(res, 400, Buffer.from('bad pkt-line framing\n'), 'text/plain');
    return;
  }
  const dataLines: string[] = [];
  let command: string | null = null;
  let pastDelim = false;
  const args: string[] = [];
  for (const frame of frames) {
    if (frame.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (frame.kind !== 'data') continue;
    const line = frame.data.toString('utf8');
    dataLines.push(line);
    if (!pastDelim && line.startsWith('command=')) command = line.slice('command='.length).replace(/\n$/, '');
    else if (pastDelim || command !== null) args.push(line.replace(/\n$/, ''));
    else args.push(line.replace(/\n$/, ''));
  }
  const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (isV2 || command !== null) {
    if (command === 'ls-refs') {
      lsRefs(store, repo, args, res);
      return;
    }
    if (command === 'fetch') {
      fetchV2(store, repo, args, res);
      return;
    }
    sendBody(res, 400, Buffer.from('unknown command\n'), 'text/plain');
    return;
  }
  // v0: the body is want/have lines in two flush-terminated sections.
  const v0Lines = dataLines;
  if (v0Lines.some((line) => line.startsWith('want '))) {
    fetchV0(store, repo, v0Lines, res);
    return;
  }
  sendBody(res, 400, Buffer.from('unrecognized upload-pack request\n'), 'text/plain');
}

// -------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(ctx: Ctx, repo: Repo, body: Buffer, res: ServerResponse): void {
  const store = ctx.store;
  // Commands are pkt-lines up to the first flush; the rest is the packfile.
  let at = 0;
  const commandLines: string[] = [];
  let capabilities = '';
  let framingOk = true;
  while (at + 4 <= body.length) {
    const head = body.subarray(at, at + 4).toString('ascii');
    const length = Number.parseInt(head, 16);
    if (Number.isNaN(length) || length < 0 || at + Math.max(length, 4) > body.length) {
      framingOk = false;
      break;
    }
    if (length === 0) {
      at += 4;
      break;
    }
    let payload = body.subarray(at + 4, at + length).toString('utf8');
    if (commandLines.length === 0) {
      const nul = payload.indexOf('\0');
      if (nul >= 0) {
        capabilities = payload.slice(nul + 1).replace(/\n$/, '');
        payload = payload.slice(0, nul);
      }
    }
    commandLines.push(payload.replace(/\n$/, ''));
    at += length;
  }
  const packBytes = framingOk ? body.subarray(at) : Buffer.alloc(0);

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (sha) => store.objects.get(sha));
      read.objects.forEach((obj, index) => {
        const sha = read.shas[index];
        if (!store.objects.has(sha)) store.objects.set(sha, obj);
      });
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  }

  const commands: PushCommand[] = [];
  for (const line of commandLines) {
    const parts = line.split(' ');
    if (parts.length === 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }

  const report: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const command of commands) {
    if (!unpackOk) {
      report.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_SHA;
    if (command.oldOid !== current) {
      report.push(`ng ${command.ref} stale info\n`);
      continue;
    }
    if (command.newOid === ZERO_SHA) {
      if (command.ref === headRefOf(repo)) {
        report.push(`ng ${command.ref} deletion of the current branch prohibited\n`);
        continue;
      }
      if (current === ZERO_SHA) {
        report.push(`ng ${command.ref} not found\n`);
        continue;
      }
      repo.refs.delete(command.ref);
      report.push(`ok ${command.ref}\n`);
      continue;
    }
    const target = store.objects.get(command.newOid);
    if (target === undefined) {
      report.push(`ng ${command.ref} missing object\n`);
      continue;
    }
    if (current !== ZERO_SHA) {
      if (command.ref.startsWith('refs/tags/')) {
        report.push(`ng ${command.ref} would clobber existing tag\n`);
        continue;
      }
      const from = peelToCommit(store, current);
      const to = peelToCommit(store, command.newOid);
      if (from !== null && to !== null && !isAncestor(store, from, to)) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    report.push(`ok ${command.ref}\n`);
  }

  const useSideband = capabilities.split(' ').includes('side-band-64k');
  const parts: Buffer[] = [];
  for (const line of report) {
    parts.push(useSideband ? sideband(1, pktLine(line)) : pktLine(line));
  }
  parts.push(PKT_FLUSH);
  sendBody(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

// ------------------------------------------------------------------- router

export async function handleGit(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  sub: string,
  query: URLSearchParams,
  body: Buffer,
): Promise<void> {
  const repo = ctx.store.repoAt(owner, repoName);
  if (sub === 'info/refs') {
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const service = query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const protocol = req.headers['git-protocol'] ?? '';
      if (protocol.includes('version=2')) v2Advertisement(res);
      else v0Advertisement(ctx.store, repo, service, res);
      return;
    }
    if (service === 'git-receive-pack') {
      v0Advertisement(ctx.store, repo, service, res);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (sub === 'git-upload-pack') {
    uploadPack(ctx, repo, req, body, res);
    return;
  }
  if (sub === 'git-receive-pack') {
    receivePack(ctx, repo, body, res);
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}
