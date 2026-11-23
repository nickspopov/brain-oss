// Retrying a write with the same request_id does not create a second revision.
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryResult, WriteResult } from '../helpers/api.js';
import { ADAPTERS, type AdapterName, type Client } from '../helpers/clients/index.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';
import { requireOp } from '../helpers/pending.js';

/** Send the whole request (as the adapter sends it) and drop the connection without reading the response ("response lost"). */
function sendAndDrop(client: Client, op: string, input: unknown): Promise<void> {
  return new Promise((resolve) => {
    const { url, headers, body } = client.request(op, input);
    const req = http.request(url, {
      method: 'POST',
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
    });
    req.on('error', () => resolve());
    req.on('finish', () => {
      req.destroy();
      resolve();
    });
    req.end(body);
  });
}

describe.each(ADAPTERS)('a04 retry via %s', (adapter: AdapterName) => {
  let h: Harness;
  let w: World;
  let hermes: Client;

  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h, adapter);
    hermes = w.client('alice-helper');
  });
  afterEach(async () => {
    // One audit line per operation call made by the scenario.
    expect(h.auditedCalls()).toBe(h.opCalls());
    await h.close();
  });

  it('same request_id and same input → same response, one revision', async () => {
    const input = { space: 'shared', path: 'retry.md', content: '# Retry\n', message: 'create', request_id: 'req-retry-0001' };
    const first = await hermes.call<WriteResult>('write', input);
    const second = await hermes.call<WriteResult>('write', input);
    expect(second).toEqual(first);
    const update = { space: 'shared', path: 'retry.md', content: '# Retry 2\n', expected_rev: 1, message: 'update', request_id: 'req-retry-0002' };
    const u1 = await hermes.call<WriteResult>('write', update);
    const u2 = await hermes.call<WriteResult>('write', update);
    expect(u2).toEqual(u1);
    const history = await hermes.call<HistoryResult>('history', { space: 'shared', path: 'retry.md' });
    expect(history.revisions.map((r) => r.rev)).toEqual([2, 1]);
  });

  it('same request_id with a different input → idempotency_mismatch, nothing written', async () => {
    await hermes.call('write', { space: 'shared', path: 'mm.md', content: 'a\n', message: 'create', request_id: 'req-mismatch-1' });
    const r = await hermes.raw('write', { space: 'shared', path: 'mm.md', content: 'b\n', expected_rev: 1, message: 'other', request_id: 'req-mismatch-1' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, error: { code: 'idempotency_mismatch', retryable: false } });
    const history = await hermes.call<HistoryResult>('history', { space: 'shared', path: 'mm.md' });
    expect(history.revisions).toHaveLength(1);
  });

  it('request_id is per principal: another agent with the same id is not affected', async () => {
    await hermes.call('write', { space: 'handoff', path: 'a.md', content: 'a\n', message: 'a', request_id: 'shared-request-id' });
    const other = await w.client('alphabot').call<WriteResult>('write', { space: 'handoff', path: 'b.md', content: 'b\n', message: 'b', request_id: 'shared-request-id' });
    expect(other.status).toBe('committed');
    expect(other.doc!.path).toBe('b.md');
  });

  it('response lost: the client drops the connection after sending, the retry yields one revision', async () => {
    requireOp('write');
    const input = { space: 'shared', path: 'lost.md', content: '# Lost\n', message: 'create', request_id: 'req-lost-00001' };
    await sendAndDrop(hermes, 'write', input);
    // The server may or may not have written by then; either way the retry yields exactly one revision.
    const retry = await hermes.call<WriteResult>('write', input);
    expect(retry.status).toBe('committed');
    expect(retry.doc!.rev).toBe(1);
    const again = await hermes.call<WriteResult>('write', input);
    expect(again).toEqual(retry);
    const history = await hermes.call<HistoryResult>('history', { space: 'shared', path: 'lost.md' });
    expect(history.revisions).toHaveLength(1);
  });

  it('a retry after a conflict is executed anew (only successes are stored)', async () => {
    await hermes.call('write', { space: 'shared', path: 'c.md', content: 'a\n', message: 'create' });
    const stale = { space: 'shared', path: 'c.md', content: 'b\n', expected_rev: 7, message: 'stale', request_id: 'req-conflict-1' };
    expect((await hermes.raw('write', stale)).status).toBe(409);
    const fixed = await hermes.call<WriteResult>('write', { ...stale, expected_rev: 1 });
    expect(fixed.status).toBe('committed');
  });
});
