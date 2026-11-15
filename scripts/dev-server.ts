// Dev launcher for local testing (not entry code): starts the app on a fixed
// port so sdk/run.ts can drive it. Env: PORT (default 18080), TOKEN (default
// test-token), TRIAL_NOW (default 2025-01-01T00:00:00Z), TRIAL_SEED.

import { createApp } from '../app.ts';
import { Store, trialNow } from '../src/store.ts';

const port = Number(process.env.PORT ?? '18080');
const token = process.env.TOKEN ?? 'test-token';
const { nowIso, nowEpoch } = trialNow(process.env.TRIAL_NOW ?? '2025-01-01T00:00:00Z');
const store = new Store({ token, nowIso, nowEpoch });
const server = createApp(store);
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[dev] listening on http://127.0.0.1:${port} token=${token}\n`);
});
