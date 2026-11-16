// Entry point: the harness lifecycle. This process is a server, not a script:
// bind an ephemeral port, tell the env where it is, then stay alive until the
// env says the trial is over.
//
//   1. MAKEFUN_ENV_URL must name the env; without it there is nothing to
//      register with, so exit 1 at once.
//   2. Listen on port 0 (the kernel picks a free port). Never bind 8080: the
//      env owns it.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register, retrying while the env
//      is still starting. 200 (or 409, someone registered first) ends this.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}.
//   5. Close the server and exit 0.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set\n');
  process.exit(1);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff between retries: 200ms doubling, capped at 2s. */
function delay(attempt: number): number {
  return Math.min(2_000, 200 * 2 ** Math.min(attempt, 6));
}

async function postRegister(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused with HTTP ${res.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    await sleep(delay(attempt));
  }
}

async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answered yet: keep polling.
    }
    await sleep(delay(attempt));
  }
}

const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, () => resolve());
});
const address = server.address();
if (address === null || typeof address === 'string') {
  process.stderr.write('[forge] server did not bind a TCP port\n');
  process.exit(1);
}
process.stdout.write(`[forge] listening on ${address.port}\n`);
await postRegister(address.port);
process.stdout.write('[forge] registered; waiting for done\n');
await waitUntilDone();
server.close();
process.stdout.write('[forge] done\n');
process.exit(0);
