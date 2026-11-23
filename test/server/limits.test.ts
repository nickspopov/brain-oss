// Limits and quotas: too_large, quota_exceeded, rate_limited.
import { afterEach, describe, expect, it } from 'vitest';
import type { WriteResult } from '../helpers/api.js';
import type { RawResponse } from '../helpers/clients/index.js';
import { buildWorld, ALICE_PASSWORD, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness, type HarnessOptions } from '../helpers/harness.js';

let h: Harness;
let w: World;

async function start(opts: HarnessOptions = {}): Promise<void> {
  h = await startHarness(opts);
  w = buildWorld(h);
}
afterEach(async () => {
  await h.close();
});

const auditRows = (op: string, outcome: string) =>
  h.core.db.prepare('SELECT * FROM audit WHERE op = ? AND outcome = ?').all(op, outcome) as { principal_id: string | null; ip: string | null }[];

function expectError(r: RawResponse, status: number, code: string, details?: Record<string, unknown>): void {
  expect(r.status).toBe(status);
  expect(r.body).toMatchObject({ ok: false, error: { code, ...(details ? { details } : {}) } });
}

describe('too_large', () => {
  it('a text document over the limit (512 KB by default), with the space override', async () => {
    await start();
    const hermes = w.client('alice-helper');
    const big = 'x'.repeat(512 * 1024 + 1);
    const r = await hermes.raw('write', { space: 'shared', path: 'big.md', content: big, message: 'big' });
    expectError(r, 413, 'too_large', { limit: 512 * 1024, actual: 512 * 1024 + 1 });
    expect((await hermes.call<WriteResult>('write', { space: 'shared', path: 'ok.md', content: 'x'.repeat(512 * 1024), message: 'ok' })).status).toBe('committed');
    await w.client('alice').call('admin_space_update', { slug: 'shared', max_doc_bytes: 100 });
    const small = await hermes.raw('write', { space: 'shared', path: 's.md', content: 'y'.repeat(101), message: 's' });
    expectError(small, 413, 'too_large', { limit: 100, actual: 101 });
    // Multi-byte characters are counted in UTF-8 bytes.
    const cyr = await hermes.raw('write', { space: 'shared', path: 'c.md', content: 'ω'.repeat(51), message: 'c' });
    expectError(cyr, 413, 'too_large', { limit: 100, actual: 102 });
  });

  it('a base64 file over 1 MB and a JSON body over the request limit', async () => {
    await start({ env: { BRAIN_MAX_REQUEST_MB: '3' } });
    const hermes = w.client('alice-helper');
    const file = Buffer.alloc(1024 * 1024 + 1, 7).toString('base64');
    const r = await hermes.raw('write', { space: 'shared', path: 'f.bin', content_base64: file, message: 'f' });
    expectError(r, 413, 'too_large', { limit: 1024 * 1024, actual: 1024 * 1024 + 1 });
    const huge = await hermes.raw('write', { space: 'shared', path: 'h.md', content: 'z'.repeat(3 * 1024 * 1024 + 10), message: 'h' });
    expectError(huge, 413, 'too_large', { limit: 3 * 1024 * 1024 });
    expect(huge.body.ok ? '' : huge.body.error.retryable).toBe(false);
  });
});

describe('quota_exceeded', () => {
  it('space quota counts live heads; delete frees space; moves and deletes always pass', async () => {
    await start();
    const hermes = w.client('alice-helper');
    await w.client('alice').call('admin_space_update', { slug: 'shared', quota_bytes: 1000 });
    const a = await hermes.call<WriteResult>('write', { space: 'shared', path: 'a.md', content: 'a'.repeat(600), message: 'a' });
    const r = await hermes.raw('write', { space: 'shared', path: 'b.md', content: 'b'.repeat(600), message: 'b' });
    expectError(r, 413, 'quota_exceeded', { limit: 1000, scope: 'space' });
    expect(r.body.ok ? '' : r.body.error.retryable).toBe(false);
    // Space usage (including folders hidden from the writer) is shown to an admin only.
    expect(r.body.ok ? undefined : r.body.error.details).not.toHaveProperty('used');
    const asAdmin = await w.client('alice-assistant').raw('write', { space: 'shared', path: 'c.md', content: 'c'.repeat(600), message: 'c' });
    expectError(asAdmin, 413, 'quota_exceeded', { limit: 1000, used: 600, scope: 'space' });
    // Shrinking a body goes through; growing past the quota does not.
    const shrink = await hermes.call<WriteResult>('write', { space: 'shared', path: 'a.md', content: 'a'.repeat(300), expected_rev: 1, message: 's' });
    expect(shrink.doc!.rev).toBe(2);
    const grow = await hermes.raw('write', { space: 'shared', path: 'a.md', content: 'a'.repeat(1001), expected_rev: 2, message: 'g' });
    expectError(grow, 413, 'quota_exceeded', { scope: 'space' });
    await hermes.call('move', { id: a.doc!.id, to_path: 'moved.md', message: 'mv' });
    await hermes.call('delete', { id: a.doc!.id, message: 'del' });
    expect((await hermes.call<WriteResult>('write', { space: 'shared', path: 'b.md', content: 'b'.repeat(900), message: 'b' })).status).toBe('committed');
    // Restoring the deleted document would bring back bytes over the quota.
    const restore = await hermes.raw('restore', { id: a.doc!.id, message: 'r' });
    expectError(restore, 413, 'quota_exceeded', { scope: 'space' });
    expect(h.doctor().problems).toEqual([]);
  });

  it('history quota: the sum of body revisions in a space is capped (10× the space quota)', async () => {
    await start();
    const hermes = w.client('alice-helper');
    await w.client('alice').call('admin_space_update', { slug: 'shared', quota_bytes: 1000 });
    let rev = 0;
    let refused: RawResponse | undefined;
    for (let i = 0; i < 20 && !refused; i++) {
      const r = await hermes.raw<WriteResult>('write', {
        space: 'shared',
        path: 'h.md',
        content: String(i).padEnd(900, '.'),
        message: 'h',
        ...(rev ? { expected_rev: rev } : {}),
      });
      if (r.body.ok) rev = r.body.result.doc!.rev;
      else refused = r;
    }
    expect(refused).toBeDefined();
    expectError(refused!, 413, 'quota_exceeded', { limit: 10_000, scope: 'history' });
    expect(rev).toBe(11);
  });

  it('the server-wide data limit and the free-disk floor refuse new bodies, but not deletes', async () => {
    await start({ env: { BRAIN_MAX_DATA_BYTES: '1' } });
    const hermes = w.client('alice-helper');
    const r = await hermes.raw('write', { space: 'shared', path: 'x.md', content: 'x\n', message: 'x' });
    expectError(r, 413, 'quota_exceeded', { limit: 1, scope: 'server' });
    expect(r.body.ok ? {} : r.body.error.details).toEqual({ limit: 1, scope: 'server' });
    await h.close();

    await start({ env: { BRAIN_MIN_FREE_MB: String(1024 * 1024 * 1024) } });
    const d = await w.client('alice-helper').raw('write', { space: 'shared', path: 'x.md', content: 'x\n', message: 'x' });
    expectError(d, 413, 'quota_exceeded', { scope: 'disk' });
    // The size of the whole DB and the free disk space are never exposed.
    expect(d.body.ok ? {} : d.body.error.details).toEqual({ scope: 'disk' });
  });
});

describe('rate_limited', () => {
  it('writes, reads and searches have separate buckets per principal; Retry-After; refill over time', async () => {
    await start({ env: { BRAIN_RATE_WRITE: '3', BRAIN_RATE_READ: '5', BRAIN_RATE_SEARCH: '2' } });
    const hermes = w.client('alice-helper');
    for (let i = 0; i < 3; i++) await hermes.call('write', { space: 'shared', path: `w${i}.md`, content: 'x\n', message: 'w' });
    const limited = await hermes.raw('write', { space: 'shared', path: 'w9.md', content: 'x\n', message: 'w' });
    expectError(limited, 429, 'rate_limited');
    expect(limited.body.ok ? '' : limited.body.error.retryable).toBe(true);
    const wait = limited.body.ok ? 0 : (limited.body.error.details!.retry_after_ms as number);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(20_000);
    expect(Number(limited.headers['retry-after'])).toBe(Math.ceil(wait / 1000));
    // Reads and search have their own buckets; another principal has its own.
    await hermes.call('read', { space: 'shared', path: 'w0.md' });
    await hermes.call('search', { query: 'x' });
    await hermes.call('search', { query: 'x' });
    expectError(await hermes.raw('search', { query: 'x' }), 429, 'rate_limited');
    await hermes.call('list', { space: 'shared' });
    await w.client('alice-assistant').call('write', { space: 'shared', path: 'c.md', content: 'x\n', message: 'c' });
    for (let i = 0; i < 3; i++) await hermes.call('whoami');
    expectError(await hermes.raw('whoami'), 429, 'rate_limited');
    // The bucket refills over time (the clock is faked).
    h.clock.advance(wait);
    expect((await hermes.call<WriteResult>('write', { space: 'shared', path: 'w9.md', content: 'x\n', message: 'w' })).status).toBe('committed');
    expectError(await hermes.raw('write', { space: 'shared', path: 'w10.md', content: 'x\n', message: 'w' }), 429, 'rate_limited');
    // Limit denials are in the audit; nothing was written.
    expect(auditRows('write', 'rate_limited')).toHaveLength(2);
    expect(auditRows('search', 'rate_limited')).toHaveLength(1);
  });

  it('failed authentications are limited per IP; a valid token still works; failed logins are limited per IP and name', async () => {
    await start({ env: { BRAIN_RATE_AUTH_FAIL: '3' } });
    const bad = async () =>
      fetch(`${h.url}/api/v1/ops/whoami`, { method: 'POST', headers: { authorization: `Bearer brn_${'A'.repeat(43)}` }, body: '{}' });
    for (let i = 0; i < 3; i++) expect((await bad()).status).toBe(401);
    const limited = await bad();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
    expect(await limited.json()).toMatchObject({ ok: false, error: { code: 'rate_limited', retryable: true } });
    // A valid token from the same address is not blocked.
    expect((await w.client('alice-helper').call<{ principal: { name: string } }>('whoami')).principal.name).toBe('alice-helper');
    // Garbage tokens do not lock out a human's login from the same address: login has its own
    // bucket per (IP, name).
    const login = (password: string) =>
      fetch(`${h.url}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'x-brain-client': 'web', origin: h.config.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'alice', password }),
      });
    expect((await login(ALICE_PASSWORD)).status).toBe(200);
    // Failed logins under this name drain its bucket: after that the password is not checked.
    for (let i = 0; i < 3; i++) expect((await login('wrong-password-000')).status).toBe(401);
    expect((await login(ALICE_PASSWORD)).status).toBe(429);
    // A request without credentials spends no limit and leaves no audit row.
    h.clock.advance(60_000);
    for (let i = 0; i < 5; i++) {
      expect((await fetch(`${h.url}/api/v1/ops/whoami`, { method: 'POST', body: '{}' })).status).toBe(401);
    }
    expect((await bad()).status).toBe(401);
    const rows = [...auditRows('whoami', 'unauthenticated'), ...auditRows('whoami', 'rate_limited')];
    expect(rows.length).toBe(3 + 1 + 1);
    expect(rows.every((r) => r.principal_id === null && r.ip !== null)).toBe(true);
    expect(auditRows('auth_login', 'rate_limited')).toHaveLength(1);
  });
});
