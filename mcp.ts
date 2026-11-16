// MCP surface (Model Context Protocol, Streamable HTTP): JSON-RPC 2.0 at
// /mcp speaking the 2026-07-28 revision — server/discover answers the
// server's identity, capabilities and supported versions in one request,
// no handshake or session — with the legacy initialize handshake answered
// too. The six tools act on the same store as REST, git and GraphQL, and
// their results are the REST JSON shapes, so an object created here reads
// back identically there.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx } from './app.ts';
import { sendBody, sendJson } from './app.ts';
import type { Issue, Pull, Repo } from './store.ts';
import { issueJson, performMerge, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'ghforge', version: '1.0.0' };
const CAPABILITIES: Record<string, unknown> = { tools: {} };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The tool catalogue: one frozen literal, so two tools/list answers are
 * byte-for-byte identical by construction. */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List a repository’s issues, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all (default open).' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch to merge from.' },
        base: { type: 'string', description: 'The base branch to merge into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ------------------------------------------------------------- tool calls

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoFor(ctx: Ctx, args: Record<string, unknown>): Repo | null {
  return ctx.store.repoAt(str(args.owner), str(args.repo));
}

function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const store = ctx.store;
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      const existing = store.repos.get(repoName);
      if (existing !== undefined) return toolResult(repoJson(ctx, existing));
      const repo = store.createRepo(repoName, {
        description: typeof args.description === 'string' && args.description !== '' ? args.description : null,
        isPrivate: args.private === true,
        defaultBranch: 'main',
      });
      return toolResult(repoJson(ctx, repo));
    }
    case 'get_repo': {
      const repo = repoFor(ctx, args);
      if (repo === null) return toolError(`Repository ${str(args.owner)}/${str(args.repo)} not found`);
      return toolResult(repoJson(ctx, repo));
    }
    case 'create_issue': {
      const repo = repoFor(ctx, args);
      if (repo === null) return toolError(`Repository ${str(args.owner)}/${str(args.repo)} not found`);
      const at = store.tick();
      const issue: Issue = {
        number: repo.nextNumber,
        id: store.nextNodeDbId(),
        title: str(args.title),
        body: typeof args.body === 'string' ? args.body : '',
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
      return toolResult(issueJson(ctx, repo, issue));
    }
    case 'list_issues': {
      const repo = repoFor(ctx, args);
      if (repo === null) return toolError(`Repository ${str(args.owner)}/${str(args.repo)} not found`);
      const state = str(args.state) || 'open';
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq);
      return toolResult(list.map((issue) => issueJson(ctx, repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoFor(ctx, args);
      if (repo === null) return toolError(`Repository ${str(args.owner)}/${str(args.repo)} not found`);
      const head = str(args.head).replace(/^[^:]+:/, '');
      const base = str(args.base);
      if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
        return toolError(`The head branch ${head} or base branch ${base} does not exist`);
      }
      const at = store.tick();
      const pull: Pull = {
        number: repo.nextNumber,
        id: store.nextNodeDbId(),
        title: str(args.title),
        body: typeof args.body === 'string' ? args.body : '',
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
      return toolResult(pullJson(ctx, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoFor(ctx, args);
      if (repo === null) return toolError(`Repository ${str(args.owner)}/${str(args.repo)} not found`);
      const pull = repo.pulls.get(typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number) || 0);
      if (pull === undefined) return toolError(`Pull request not found`);
      const result = performMerge(ctx, repo, pull, 'merge');
      if (result === null) return toolError('Pull Request is not mergeable');
      return toolResult(pullJson(ctx, repo, pull));
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

// -------------------------------------------------------------- JSON-RPC

type RpcId = string | number | null;

function rpcResult(id: RpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: RpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Answer one JSON-RPC message; null when the message is a notification
 * and so takes no answer. */
function handleRpc(ctx: Ctx, message: unknown): Record<string, unknown> | null {
  if (!isRecord(message)) return rpcError(null, -32600, 'Invalid Request');
  const id: RpcId = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = isRecord(message.params) ? message.params : {};
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
      });
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[0],
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === toolName);
      if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      const args = isRecord(params.arguments) ? params.arguments : {};
      const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === '');
      if (missing.length > 0) return rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
      return rpcResult(id, callTool(ctx, toolName, args));
    }
    default:
      if (!('id' in message)) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(ctx: Ctx, req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  if (req.method !== 'POST') {
    sendBody(res, 202, Buffer.alloc(0), 'application/json');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) => handleRpc(ctx, entry)).filter((entry) => entry !== null);
    sendJson(res, 200, answers);
    return;
  }
  const answer = handleRpc(ctx, parsed);
  if (answer === null) {
    sendBody(res, 202, Buffer.alloc(0), 'application/json');
    return;
  }
  sendJson(res, 200, answer);
}
