# ghforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/leitmotiv34/ghforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/leitmotiv34/ghforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in TypeScript (Node 22, standard
library only): one process, its own in-memory store, no git binary, no
outside service. It serves four surfaces over one shared store, so an
object written through any of them reads back identically through the
others:

- **git smart HTTP** at `/{owner}/{repo}.git` — `info/refs`, upload-pack
  protocol v2 (ls-refs, fetch with shallow/deepen) and a v0 fallback,
  receive-pack with fast-forward, tag-clobber and stale-info protection.
  The git object model (loose objects, packfiles with ofs/ref deltas,
  tree/commit/tag codecs) is implemented from scratch.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents
  (writes are real git commits), labels, issues, comments and pull
  requests with three-way merges (squash or merge commit).
- **GraphQL v4** at `/api/graphql` — a small executor covering viewer,
  repository, issue and pull-request queries, the create/close/merge
  mutations, introspection, Relay `node(id:)` and cursor pagination,
  including operation batching.
- **MCP** at `/mcp` — JSON-RPC 2.0 (2026-07-28 `server/discover`, legacy
  `initialize` answered too) with `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request` and
  `merge_pull_request` tools.

Determinism is a design rule: timestamps come from a tick clock seeded by
the trial's opening time, never the wall clock, so a replayed trial
reproduces the live run byte for byte.

## Run it

```sh
MAKEFUN_ENV_URL=<contest env url> MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

The forge binds an ephemeral port, registers it with the contest env,
serves until the env reports the trial done, and exits 0.

---
<sub>Entered on [make.fun](https://make.fun/?ref=0jtgc9vt&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
