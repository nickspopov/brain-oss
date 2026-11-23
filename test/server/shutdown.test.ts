// Stopping the server does not wait for keep-alive: a response still being sent at the moment of
// close() used to leave the socket open for keepAliveTimeout (72 s) — that is how the afterEach hook
// of an export test failed under load (the client read the export up to content-length before the
// server's 'finish').
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { buildWorld } from '../helpers/fixtures.js';
import { startHarness } from '../helpers/harness.js';

it('close() during a download in flight returns as soon as the response is done', async () => {
  const h = await startHarness();
  const w = buildWorld(h);
  const alice = w.client('alice');
  // Incompressible bodies: the archive is larger than the socket buffers, so the response is still in flight when close() is called.
  const noise = () => randomBytes(60_000).toString('hex').replace(/(.{80})/g, '$1\n');
  for (let i = 0; i < 30; i++) await alice.call('write', { space: 'shared', path: `b${i}.md`, content: noise(), message: 'b' });
  const exp = await alice.call<{ export_id: string }>('export', { space: 'shared' });
  const res = await fetch(`${h.url}/api/v1/exports/${exp.export_id}`, { headers: { authorization: `Bearer ${w.tokens.alice}` } });
  expect(res.status).toBe(200);
  const t0 = performance.now();
  const closed = h.close();
  expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1_000_000);
  await closed;
  // It used to be ~70,000 ms (keepAliveTimeout); the ceiling leaves headroom for load on the Pi.
  expect(performance.now() - t0).toBeLessThan(15_000);
}, 120_000);
