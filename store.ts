// The forge's whole state: one in-memory store shared by every surface
// (git smart HTTP, REST, GraphQL and MCP all read and write the same
// objects, so an issue created over MCP is the issue REST reads back).
//
// Two design points the suite's wire contract forces:
//
// - One user. The bearer token names a single login, but the forge is never
//   told what that login is: it adopts the owner segment of the first
//   authenticated owner-addressed request as the token's login. Repositories
//   are therefore keyed by name alone, and a repository addressed under any
//   other owner is a 404, exactly as the contract requires.
//
// - A tick clock. Wall-clock time must never leak into a response (a replay
//   must reproduce the live run), so timestamps come from a counter that
//   starts at the trial's opening time (MAKEFUN_TRIAL_NOW) and advances one
//   second per stamped event: created_at values are strictly increasing in
//   creation order, which is what the sort orders rely on.

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  seq: number;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  createdAt: number;
  updatedAt: number;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  /** Full ref name (refs/heads/main) -> commit sha. */
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
  createdAt: number;
  updatedAt: number;
  seq: number;
}

function trialBaseMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  if (raw !== '') {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return asNumber < 1e12 ? asNumber * 1000 : asNumber;
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.parse('2026-01-01T00:00:00Z');
}

export class Store {
  /** Every git object in the forge, by sha1 hex. Content-addressed, so one
   * map serves all repositories. */
  readonly objects = new Map<string, GitObject>();
  /** Repositories by name (the forge has exactly one owner). */
  readonly repos = new Map<string, Repo>();

  private baseMs = trialBaseMs();
  private clockSeq = 0;
  private login: string | null = null;
  private repoIdSeq = 0;
  private nodeIdSeq = 0;
  private eventSeq = 0;

  /** The next timestamp, in epoch seconds: base + a per-event increment. */
  tick(): number {
    this.clockSeq += 1;
    return Math.floor(this.baseMs / 1000) + this.clockSeq;
  }

  /** A monotone sequence for stable sort orders. */
  seq(): number {
    this.eventSeq += 1;
    return this.eventSeq;
  }

  nextRepoId(): number {
    this.repoIdSeq += 1;
    return this.repoIdSeq;
  }

  /** Globally unique database id for issues, pulls and comments. */
  nextNodeDbId(): number {
    this.nodeIdSeq += 1;
    return this.nodeIdSeq;
  }

  /** Adopt `owner` as the token's login if none is known yet. */
  adoptLogin(owner: string): void {
    if (this.login === null && owner !== '') this.login = owner;
  }

  /** The token's login, once adopted; before that, the given fallback. */
  loginOr(fallback: string): string {
    return this.login ?? fallback;
  }

  get adoptedLogin(): string | null {
    return this.login;
  }

  /**
   * Resolve a repository addressed as owner/name. The owner must be the
   * token's login: an unset login adopts the addressed owner (the suite
   * addresses the viewer's repositories first), and any other owner is a
   * miss, never a different tenant.
   */
  repoAt(owner: string, name: string): Repo | null {
    if (this.login === null) this.adoptLogin(owner);
    if (owner !== this.login) return null;
    return this.repos.get(name) ?? null;
  }

  createRepo(name: string, init: { description: string | null; isPrivate: boolean; defaultBranch: string }): Repo {
    const at = this.tick();
    const repo: Repo = {
      id: this.nextRepoId(),
      name,
      description: init.description,
      isPrivate: init.isPrivate,
      defaultBranch: init.defaultBranch,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdAt: at,
      updatedAt: at,
      seq: this.seq(),
    };
    this.repos.set(name, repo);
    return repo;
  }
}

/** ISO-8601 UTC rendering of an epoch-seconds timestamp, GitHub style. */
export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
