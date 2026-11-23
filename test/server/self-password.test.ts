// A human changes their own password (POST /api/v1/auth/password, audit op
// account_password_change). Cookie session only; never a bearer token, never an MCP tool.
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrincipal } from '../../src/core/principals.js';
import { listOps } from '../../src/ops/registry.js';
import { buildWorld, ALICE_PASSWORD, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
let w: World;
afterEach(async () => {
  await h.close();
});

const OLD = 'member-password-0001';
const NEW = 'member-password-0002';

async function setup(env: Record<string, string> = {}) {
  h = await startHarness({ env });
  w = buildWorld(h);
  createPrincipal(h.core, { name: 'mila', kind: 'human', trust: 'trusted', password: OLD }, w.principals.alice.id);
}

const ui = () => ({ 'x-brain-client': 'web', origin: h.config.origin, 'content-type': 'application/json' });

async function req(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(`${h.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as { ok: boolean; result?: Record<string, unknown>; error?: { code: string; details?: unknown } } };
}

async function login(name: string, password: string): Promise<string> {
  const res = await fetch(`${h.url}/api/v1/auth/login`, { method: 'POST', headers: ui(), body: JSON.stringify({ name, password }) });
  expect(res.status).toBe(200);
  const m = /brain_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  return `brain_session=${m![1]}`;
}

const change = (cookie: string, current_password: string, new_password: string) =>
  req('POST', '/api/v1/auth/password', { ...ui(), cookie }, { current_password, new_password });
const session = (cookie: string) => req('GET', '/api/v1/auth/session', { cookie });
const auditRows = () =>
  h.core.db.prepare("SELECT outcome, detail FROM audit WHERE op = 'account_password_change' ORDER BY id").all() as { outcome: string; detail: string | null }[];

describe('account_password_change', () => {
  it('a non-admin human changes their own password; other sessions are revoked, the current one continues', async () => {
    await setup();
    const a = await login('mila', OLD);
    const b = await login('mila', OLD);
    const alice = await login('alice', ALICE_PASSWORD);
    const r = await change(a, OLD, NEW);
    expect(r.status).toBe(200);
    expect(r.body.result).toEqual({ changed: true, revoked_sessions: 1 });
    expect((await session(a)).status).toBe(200);
    expect((await session(b)).status).toBe(401);
    expect((await session(alice)).status).toBe(200); // other principals are untouched
    expect((await req('POST', '/api/v1/auth/login', ui(), { name: 'mila', password: OLD })).status).toBe(401);
    await login('mila', NEW);
    expect(auditRows().map((x) => x.outcome)).toEqual(['ok']);
    const all = JSON.stringify(h.core.db.prepare('SELECT * FROM audit').all());
    expect(all).not.toContain(OLD);
    expect(all).not.toContain(NEW);
    expect(h.logs.join('')).not.toContain(NEW);
  });

  it('a superadmin can use it too', async () => {
    await setup();
    const c = await login('alice', ALICE_PASSWORD);
    expect((await change(c, ALICE_PASSWORD, 'a-brand-new-password')).status).toBe(200);
    await login('alice', 'a-brand-new-password');
  });

  it('wrong current password → invalid_input, audited without the password; policy and new == current are rejected', async () => {
    await setup();
    const c = await login('mila', OLD);
    const wrong = await change(c, 'not-the-password', NEW);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error?.code).toBe('invalid_input');
    expect(wrong.text).toContain('current_password');
    const short = await change(c, OLD, 'short');
    expect(short.body.error?.code).toBe('invalid_input');
    expect(short.text).toContain('new_password');
    const same = await change(c, OLD, OLD);
    expect(same.body.error?.code).toBe('invalid_input');
    expect(same.text).toContain('must differ');
    expect(auditRows().map((x) => x.outcome)).toEqual(['wrong_password', 'invalid_input', 'invalid_input']);
    expect(JSON.stringify(h.core.db.prepare('SELECT * FROM audit').all())).not.toContain('not-the-password');
    await login('mila', OLD); // nothing changed
  });

  it('failures share the login failure bucket and get rate_limited', async () => {
    await setup({ BRAIN_RATE_AUTH_FAIL: '3' });
    const c = await login('mila', OLD);
    for (let i = 0; i < 3; i++) expect((await change(c, `wrong-${i}-password`, NEW)).status).toBe(400);
    const limited = await change(c, OLD, NEW); // even the right password is not checked now
    expect(limited.status).toBe(429);
    expect(limited.body.error?.code).toBe('rate_limited');
    expect((await req('POST', '/api/v1/auth/login', ui(), { name: 'mila', password: OLD })).status).toBe(429);
    expect(auditRows().at(-1)?.outcome).toBe('rate_limited');
    h.clock.advance(61_000);
    expect((await change(c, OLD, NEW)).status).toBe(200);
  });

  it('needs a cookie session with CSRF headers; a bearer token cannot call it', async () => {
    await setup();
    const c = await login('mila', OLD);
    const bearer = { 'content-type': 'application/json', authorization: `Bearer ${w.tokens.alphabot}` };
    const body = { current_password: OLD, new_password: NEW };
    expect((await req('POST', '/api/v1/auth/password', bearer, body)).status).toBe(401);
    // Bearer next to a valid cookie is refused too.
    expect((await req('POST', '/api/v1/auth/password', { ...ui(), cookie: c, authorization: `Bearer ${w.tokens.alice}` }, body)).status).toBe(401);
    expect((await req('POST', '/api/v1/auth/password', { 'content-type': 'application/json', cookie: c }, body)).status).toBe(401);
    expect((await req('POST', '/api/v1/auth/password', ui(), body)).status).toBe(401);
    // Not a registry operation: no REST op route either.
    const op = await req('POST', '/api/v1/ops/account_password_change', bearer, body);
    expect(op.status).toBe(404);
    await login('mila', OLD);
  });

  it('is not an MCP tool, not even for an admin', async () => {
    await setup();
    expect(listOps().map((o) => o.name)).not.toContain('account_password_change');
    const transport = new StreamableHTTPClientTransport(new URL(`${h.url}/mcp/v1`), {
      requestInit: { headers: { authorization: `Bearer ${w.tokens.alice}` } },
    });
    const client = new SdkClient({ name: 'brain-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(20);
      expect(tools.map((t) => t.name).filter((n) => /password|account/.test(n))).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('admin_principal_update with a password still works and revokes that principal’s sessions', async () => {
    await setup();
    const m = await login('mila', OLD);
    const alice = await login('alice', ALICE_PASSWORD);
    const r = await req('POST', '/api/v1/ops/admin_principal_update', { ...ui(), cookie: alice }, { name: 'mila', password: NEW });
    expect(r.status).toBe(200);
    expect((await session(m)).status).toBe(401);
    await login('mila', NEW);
  });
});
