// Entry <-> env lifecycle: bind an ephemeral port, tell the env the port, then
// poll until the env says the trial is over and exit 0. The server itself lives
// in app.ts; this file is only the harness handshake.
//
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing to
//      talk to, so the program exits 1 at once.
//   2. The server listens on port 0 and the kernel picks a free one. Port 8080
//      is never used — the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address
//      the request came from plus N as this entry's base URL. 200 registers;
//      409 means a first register already won and this process just waits.
//      400/405 are contract errors and end the program; anything else is
//      retried, since the env may still be starting.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env
//      answers at once, so this is a poll, never a long-held request.
//   5. Close the server and exit 0.

import { createApp } from './app.ts';
import { Store, trialNow } from './src/store.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** One register or done request may take this long before it is abandoned. */
const REQUEST_TIMEOUT_MS = 30_000;
/** First wait between retries, and the longest wait. */
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential wait after `attempt` failed requests, capped at RETRY_MAX_MS. */
function backoffMs(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/** POST the bound port until the env accepts it (200) or reports 409. */
async function register(envUrl: string, port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response | null = null;
    try {
      response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      response = null;
    }
    if (response !== null) {
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register refused: HTTP ${response.status}`);
      }
    }
    await sleep(backoffMs(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitUntilDone(envUrl: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet, or the poll timed out: not done, poll again.
    }
    await sleep(backoffMs(attempt));
  }
}

async function main(): Promise<void> {
  if (ENV_URL === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
    process.exit(1);
  }
  const { nowIso, nowEpoch } = trialNow(process.env.MAKEFUN_TRIAL_NOW);
  const store = new Store({
    token: process.env.MAKEFUN_SHOP_TOKEN ?? '',
    nowIso,
    nowEpoch,
  });
  const server = createApp(store);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(ENV_URL, address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone(ENV_URL);
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
