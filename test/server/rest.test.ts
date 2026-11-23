// REST adapter: whoami by token, 401 without details, the error envelope, 503 before the first superadmin.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPrincipal, createSuperadmin } from '../../src/core/principals.js';
import { issueToken } from '../../src/core/tokens.js';
import { CONTRACT_VERSION } from '../../src/version.js';
import { RestClient } from '../helpers/clients/rest.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

function setup() {
  const alice = createSuperadmin(h.core, 'alice', 'correct-horse-battery-staple');
  const agent = createPrincipal(h.core, { name: 'alice-helper', kind: 'agent', trust: 'trusted', ownerId: alice.id }, alice.id);
  const t = issueToken(h.core, agent.id, { label: 'test' });
  return { alice, agent, token: t.token };
}

async function post(path: string, init: RequestInit = {}) {
  const res = await fetch(`${h.url}${path}`, { method: 'POST', ...init });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> };
}

describe('REST /api/v1/ops/{name}', () => {
  it('whoami answers by token', async () => {
    const { agent, token } = setup();
    const r = await new RestClient(h.url, token).raw<Record<string, unknown>>('whoami');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    if (!r.body.ok) return;
    expect(r.body.result).toMatchObject({
      contract_version: CONTRACT_VERSION,
      principal: { id: agent.id, name: 'alice-helper', kind: 'agent', trust: 'trusted' },
      tenant: { slug: 'default' },
      spaces: [],
      limits: { max_doc_bytes: 524288 },
    });
    expect(typeof (r.body.result as { guide: string }).guide).toBe('string');
  });

  it('accepts the documented curl form (-d with form content type)', async () => {
    const { token } = setup();
    const r = await post('/api/v1/ops/whoami', {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: '{}',
    });
    expect(r.status).toBe(200);
  });

  it('a wrong, missing or malformed token → 401 unauthenticated without details', async () => {
    const { token } = setup();
    const variants: Record<string, string>[] = [
      {},
      { authorization: 'Bearer brn_' + 'A'.repeat(43) },
      { authorization: `Bearer ${token.slice(0, -1)}x` },
      { authorization: token },
      { authorization: `Basic ${token}` },
    ];
    const bodies = new Set<string>();
    for (const headers of variants) {
      const r = await post('/api/v1/ops/whoami', { headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toBe('Bearer');
      expect(r.body).toEqual({
        ok: false,
        error: { code: 'unauthenticated', message: 'Authentication required.', retryable: false },
      });
      bodies.add(JSON.stringify(r.body));
    }
    expect(bodies.size).toBe(1);
  });

  it('a token in the query string is refused even with a valid header and is not logged', async () => {
    const { token } = setup();
    const r = await post(`/api/v1/ops/whoami?token=${token}`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(401);
    expect(h.logs.join('\n')).not.toContain(token);
  });

  it('never writes the token to the log', async () => {
    const { token } = setup();
    await new RestClient(h.url, token).call('whoami');
    await new RestClient(h.url, token).raw('no_such_op');
    expect(h.logs.length).toBeGreaterThan(0);
    expect(h.logs.join('\n')).not.toContain(token);
    expect(h.logs.join('\n')).not.toContain(token.slice(4));
  });

  it('unknown operation → not_found, same body as any not_found, without echoing the name', async () => {
    const { token } = setup();
    const c = new RestClient(h.url, token);
    const a = await c.raw('no_such_operation');
    const b = await c.raw('no_such_admin_token_issue');
    expect(a.status).toBe(404);
    expect(a.body).toEqual({ ok: false, error: { code: 'not_found', message: 'Not found.', retryable: false } });
    expect(b.text).toBe(a.text);
    expect(a.text).not.toContain('no_such_operation');
  });

  it('invalid input → 400 invalid_input with field paths', async () => {
    const { token } = setup();
    const c = new RestClient(h.url, token);
    const r = await c.raw('whoami', { unexpected: 1 });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, error: { code: 'invalid_input', retryable: false } });
    const bad = await post('/api/v1/ops/whoami', {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it('a body above the request limit → 413 too_large', async () => {
    await h.close();
    h = await startHarness({ env: { BRAIN_MAX_REQUEST_MB: '1' } });
    const { token } = setup();
    const r = await post('/api/v1/ops/whoami', {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 10) }),
    });
    expect(r.status).toBe(413);
    expect(r.body).toMatchObject({ ok: false, error: { code: 'too_large', details: { limit: 1024 * 1024 } } });
  });

  it('every call is audited, including refusals', async () => {
    const { agent, token } = setup();
    const c = new RestClient(h.url, token);
    await c.call('whoami');
    await c.raw('no_such_nope');
    await c.raw('whoami', { bad: true });
    const rows = h.core.db.prepare('SELECT op, outcome, via, principal_id FROM audit ORDER BY id').all();
    expect(rows).toEqual([
      { op: 'whoami', outcome: 'ok', via: 'rest', principal_id: agent.id },
      { op: 'no_such_nope', outcome: 'not_found', via: 'rest', principal_id: agent.id },
      { op: 'whoami', outcome: 'invalid_input', via: 'rest', principal_id: agent.id },
    ]);
  });
});

describe('server without a superadmin', () => {
  it('answers 503 on everything except /healthz', async () => {
    const health = await fetch(`${h.url}/healthz`);
    expect(health.status).toBe(200);
    const r = await post('/api/v1/ops/whoami', { body: '{}' });
    expect(r.status).toBe(503);
    createSuperadmin(h.core, 'alice', 'correct-horse-battery-staple');
    const after = await post('/api/v1/ops/whoami', { body: '{}' });
    expect(after.status).toBe(401);
  });

  it('unknown routes → not_found envelope', async () => {
    setup();
    const res = await fetch(`${h.url}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: { code: 'not_found', message: 'Not found.', retryable: false } });
  });
});
