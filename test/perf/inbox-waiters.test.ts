// 1000 parked waits through GET /api/v1/inbox?wait, each superseded by
// the next one of the same principal. The waiter map ends empty and the heap stays flat. Over HTTP
// this takes about a minute on the Pi, so it runs with `npm run test:perf`; npm run ci has the same
// check at the executor level (test/server/inbox-spaces-isolation.test.ts).
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
let w: World;

beforeAll(async () => {
  h = await startHarness();
  w = buildWorld(h, 'rest');
});
afterAll(async () => {
  await h.close();
});

const poll = (token: string, signal?: AbortSignal) =>
  fetch(`${h.url}/api/v1/inbox?wait=50`, { headers: { authorization: `Bearer ${token}` }, ...(signal ? { signal } : {}) }).then(async (r) => ({ status: r.status, body: await r.text() }));

async function parked(n: number): Promise<void> {
  const t0 = Date.now();
  while (h.core.waiters.size !== n) {
    if (Date.now() - t0 > 5000) throw new Error('wait did not park');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('perf/inbox-waiters', () => {
  it('1000 park/supersede cycles over HTTP: heap flat, map empty', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const heap = () => {
      gc();
      gc();
      return process.memoryUsage().heapUsed;
    };
    const token = w.tokens['alice-helper'];
    const cycles = async (n: number) => {
      let prev = poll(token);
      for (let i = 0; i < n; i++) {
        await parked(1);
        const next = poll(token);
        expect((await prev).status).toBe(200);
        prev = next;
      }
      await parked(1);
      const ac = new AbortController();
      const last = poll(token, ac.signal).catch(() => null);
      await prev;
      ac.abort();
      await last;
      const t0 = Date.now();
      while (h.core.waiters.size !== 0 && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 5));
      expect(h.core.waiters.size).toBe(0);
    };
    await cycles(100);
    const base = heap();
    await cycles(1000);
    const grown = heap() - base;
    expect(grown, `heap grew by ${Math.round(grown / 1024)} KB`).toBeLessThan(8 * 1024 * 1024);
  }, 600_000);
});
