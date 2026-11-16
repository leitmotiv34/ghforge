// Git's object model and packfiles, implemented on node:crypto (sha1) and
// node:zlib only: there is no git binary in the trial pod, so clone, fetch
// and push all speak to this code.
//
// Objects are stored by their raw content (the bytes after the
// "<type> <len>\0" header); the header is rebuilt whenever a hash or a pack
// entry is needed, which keeps stored commits byte-exact by construction.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType, Store } from './store.ts';

export const ZERO_SHA = '0000000000000000000000000000000000000000';

const TYPE_IDS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function putObject(store: Store, type: GitObjectType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!store.objects.has(sha)) store.objects.set(sha, { type, data });
  return sha;
}

// ------------------------------------------------------------------ commits

export interface CommitParts {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(parts: CommitParts): Buffer {
  const lines = [`tree ${parts.tree}`];
  for (const parent of parts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${parts.author}`);
  lines.push(`committer ${parts.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${parts.message}`, 'utf8');
}

/** "Name <email> ts +0000" identity line for a given epoch second. */
export function identityLine(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

// -------------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const mode = data.subarray(at, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, with directories sorting as if suffixed '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------- tags

export interface TagParts {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const out: TagParts = { object: '', type: '', tag: '', tagger: '', message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

// -------------------------------------------------------------------- packs

/**
 * Inflate the zlib stream starting at `offset`, reporting how many input
 * bytes it consumed. inflateSync tolerates trailing bytes but does not say
 * where the stream ended, so the end is found by search: a proper prefix of
 * a zlib stream never inflates, the whole stream always does.
 */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  const rest = buf.subarray(offset);
  // The whole remainder must inflate (trailing bytes are the pack's later
  // entries, which inflateSync tolerates); if it does not, the stream is
  // corrupt. The stream's exact end is then the shortest prefix that
  // inflates: a proper prefix never does, and any longer one does.
  try {
    inflateSync(rest);
  } catch {
    throw new Error('pack entry does not inflate');
  }
  let lo = 0;
  let hi = rest.length;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(rest.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  return { data: inflateSync(rest.subarray(0, hi)), consumed: hi };
}

/** Apply a git delta (copy/insert instructions) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at];
      at += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const op = delta[at];
    at += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          offset |= delta[at] << (8 * i);
          at += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          size |= delta[at] << (8 * i);
          at += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(at, at + op));
      produced += op;
      at += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const joined = Buffer.concat(out);
  if (produced !== targetSize || joined.length !== targetSize) throw new Error('delta target size mismatch');
  return joined;
}

export interface PackRead {
  objects: GitObject[];
  shas: string[];
}

/**
 * Parse a whole packfile into objects. Delta entries (ofs-delta and
 * ref-delta) are resolved against bases inside the pack or, for ref-delta,
 * against `external` (objects the store already holds, for thin packs).
 */
export function readPack(buf: Buffer, external?: (sha: string) => GitObject | undefined): PackRead {
  if (buf.length < 12 || buf.subarray(0, 4).toString('utf8') !== 'PACK') throw new Error('not a packfile');
  const count = buf.readUInt32BE(8);
  let at = 12;
  const raw: { type: GitObjectType | 'ofs' | 'ref'; data: Buffer; baseOffset?: number; baseSha?: string; start: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = at;
    let byte = buf[at];
    at += 1;
    const typeId = (byte >> 4) & 7;
    while (byte & 0x80) {
      byte = buf[at];
      at += 1;
    }
    let baseOffset: number | undefined;
    let baseSha: string | undefined;
    let kind: GitObjectType | 'ofs' | 'ref';
    if (typeId === 6) {
      let b = buf[at];
      at += 1;
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = buf[at];
        at += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - offset;
      kind = 'ofs';
    } else if (typeId === 7) {
      baseSha = buf.subarray(at, at + 20).toString('hex');
      at += 20;
      kind = 'ref';
    } else {
      const t = ID_TYPES[typeId];
      if (t === undefined) throw new Error(`unknown pack object type ${typeId}`);
      kind = t;
    }
    const { data, consumed } = inflateAt(buf, at);
    at += consumed;
    raw.push({ type: kind, data, baseOffset, baseSha, start });
  }
  const byOffset = new Map<number, number>();
  raw.forEach((entry, index) => byOffset.set(entry.start, index));
  const resolved: (GitObject | null)[] = raw.map(() => null);
  const resolve = (index: number): GitObject => {
    const memo = resolved[index];
    if (memo !== null) return memo;
    const entry = raw[index];
    let obj: GitObject;
    if (entry.type === 'ofs' || entry.type === 'ref') {
      let base: GitObject;
      if (entry.type === 'ofs') {
        const baseIndex = byOffset.get(entry.baseOffset as number);
        if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
        base = resolve(baseIndex);
      } else {
        const inPack = raw.findIndex((candidate, candidateIndex) => {
          if (candidate.type === 'ofs' || candidate.type === 'ref') return false;
          return hashObject(candidate.type, candidate.data) === entry.baseSha;
        });
        if (inPack >= 0) base = resolve(inPack);
        else {
          const ext = external?.(entry.baseSha as string);
          if (ext === undefined) throw new Error('ref-delta base not available');
          base = ext;
        }
      }
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      obj = { type: entry.type, data: entry.data };
    }
    resolved[index] = obj;
    return obj;
  };
  const objects: GitObject[] = [];
  const shas: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const obj = resolve(i);
    objects.push(obj);
    shas.push(hashObject(obj.type, obj.data));
  }
  return { objects, shas };
}

/** Serialize objects into a packfile: full objects only, no deltas. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of objects) {
    const size = obj.data.length;
    const bytes: number[] = [];
    let first = (TYPE_IDS[obj.type] << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    bytes.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ------------------------------------------------------------------ closure

/**
 * The set of object shas reachable from `tips`, walking commits to their
 * trees and parents, trees to their entries and tags to their targets.
 * `stopAt` objects are included but not descended past (have boundaries).
 */
export function closureOf(store: Store, tips: readonly string[], stopAt?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    const obj = store.objects.get(sha);
    if (obj === undefined) continue;
    seen.add(sha);
    if (stopAt !== undefined && stopAt.has(sha)) continue;
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** Ancestor closure of commit shas only (commits, via parents). */
export function commitClosure(store: Store, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    const obj = store.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(sha);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return seen;
}

/** Is `ancestor` reachable from `descendant` through commit parents? */
export function isAncestor(store: Store, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return commitClosure(store, [descendant]).has(ancestor);
}
