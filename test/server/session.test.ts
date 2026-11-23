// Human login and UI sessions: cookie HttpOnly/SameSite=Strict, CSRF (X-Brain-Client + Origin),
// 30/90-day lifetimes; logout and disabling end the session immediately.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildWorld, ALICE_PASSWORD, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
let w: World;

beforeEach(async () => {
  h = await startHarness();
  w = buildWorld(h);
});
afterEach(async () => {
  await h.close();
});

const ui = () => ({ 'x-brain-client': 'web', origin: h.config.origin, 'content-type': 'application/json' });

async function req(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(`${h.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: JSON.parse(text) as { ok: boolean; result?: Record<string, unknown>; error?: { code: string } } };
}

async function login(name = 'alice', password = ALICE_PASSWORD): Promise<string> {
  const r = await req('POST', '/api/v1/auth/login', ui(), { name, password });
  expect(r.status).toBe(200);
  const set = r.headers.get('set-cookie') ?? '';
  const m = /brain_session=([^;]+)/.exec(set);
  if (!m) throw new Error('no session cookie');
  return `brain_session=${m[1]}`;
}

const whoami = (cookie: string, headers: Record<string, string> = ui()) => req('POST', '/api/v1/ops/whoami', { ...headers, cookie }, {});

describe('login and session', () => {
  it('login sets an HttpOnly SameSite=Strict cookie; the session works for operations with via=ui', async () => {
    const r = await req('POST', '/api/v1/auth/login', ui(), { name: 'alice', password: ALICE_PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ principal: { name: 'alice', kind: 'human', role: 'superadmin', admin: true } });
    const set = r.headers.get('set-cookie') ?? '';
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(set).toMatch(/Path=\//);
    const cookie = `brain_session=${/brain_session=([^;]+)/.exec(set)![1]}`;
    const me = await whoami(cookie);
    expect(me.status).toBe(200);
    expect(me.body.result).toMatchObject({ principal: { name: 'alice' } });
    const s = await req('GET', '/api/v1/auth/session', { cookie });
    expect(s.body.result).toMatchObject({ principal: { name: 'alice' } });
    const audit = h.core.db.prepare("SELECT via FROM audit WHERE op = 'whoami' ORDER BY id DESC LIMIT 1").get() as { via: string };
    expect(audit.via).toBe('ui');
    // The DB holds only a hash of the cookie value.
    const value = cookie.split('=')[1]!;
    const rows = h.core.db.prepare('SELECT id_hash FROM sessions').all() as { id_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id_hash).not.toContain(value);
    expect(h.logs.join('')).not.toContain(value);
  });

  it('wrong password, unknown name, agent and disabled human get the same 401', async () => {
    const bodies = new Set<string>();
    for (const [name, password] of [
      ['alice', 'wrong-password-123'],
      ['nobody', ALICE_PASSWORD],
      ['alphabot', ALICE_PASSWORD],
    ] as const) {
      const r = await req('POST', '/api/v1/auth/login', ui(), { name, password });
      expect(r.status).toBe(401);
      expect(r.headers.get('set-cookie')).toBeNull();
      bodies.add(r.text);
    }
    expect(bodies.size).toBe(1);
    expect((h.core.db.prepare("SELECT count(*) AS n FROM audit WHERE op = 'auth_login' AND outcome = 'unauthenticated'").get() as { n: number }).n).toBe(3);
  });

  it('CSRF: login and cookie requests need X-Brain-Client and our Origin', async () => {
    const noClient = await req('POST', '/api/v1/auth/login', { origin: h.config.origin }, { name: 'alice', password: ALICE_PASSWORD });
    expect(noClient.status).toBe(401);
    const foreign = await req('POST', '/api/v1/auth/login', { ...ui(), origin: 'https://evil.example' }, { name: 'alice', password: ALICE_PASSWORD });
    expect(foreign.status).toBe(401);
    const cookie = await login();
    expect((await whoami(cookie, { origin: h.config.origin })).status).toBe(401);
    expect((await whoami(cookie, { 'x-brain-client': 'web' })).status).toBe(401);
    expect((await whoami(cookie, { 'x-brain-client': 'web', origin: 'https://evil.example' })).status).toBe(401);
    expect((await whoami(cookie)).status).toBe(200);
  });

  it('bearer takes precedence over the cookie', async () => {
    const cookie = await login();
    const r = await req('POST', '/api/v1/ops/whoami', { cookie, authorization: `Bearer ${w.tokens.alphabot}` }, {});
    expect(r.body.result).toMatchObject({ principal: { name: 'alphabot' } });
  });

  it('logout ends the session at once', async () => {
    const cookie = await login();
    const out = await req('POST', '/api/v1/auth/logout', { ...ui(), cookie }, {});
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await whoami(cookie)).status).toBe(401);
    expect((await req('GET', '/api/v1/auth/session', { cookie })).status).toBe(401);
  });

  it('disabling the principal ends its sessions at once', async () => {
    await w.client('alice').call('admin_principal_create', { name: 'carol', kind: 'human', trust: 'trusted', password: 'another-long-password' });
    const cookie = await login('carol', 'another-long-password');
    expect((await whoami(cookie)).status).toBe(200);
    await w.client('alice').call('admin_principal_disable', { name: 'carol' });
    expect((await whoami(cookie)).status).toBe(401);
    await w.client('alice').call('admin_principal_enable', { name: 'carol' });
    expect((await whoami(cookie)).status).toBe(401);
  });

  it('a session expires after 30 idle days and after 90 days in total (clock)', async () => {
    const idle = await login();
    h.clock.advanceDays(29);
    expect((await whoami(idle)).status).toBe(200);
    h.clock.advanceDays(29);
    expect((await whoami(idle)).status).toBe(200);
    h.clock.advanceDays(31);
    expect((await whoami(idle)).status).toBe(401);

    const total = await login();
    for (let i = 0; i < 4; i++) {
      h.clock.advanceDays(20);
      expect((await whoami(total)).status).toBe(200);
    }
    h.clock.advanceDays(11);
    expect((await whoami(total)).status).toBe(401);
  });

  it('a human password can be changed by admin_principal_update; the old one stops working', async () => {
    await w.client('alice').call('admin_principal_update', { name: 'alice', password: 'brand-new-password-1' });
    expect((await req('POST', '/api/v1/auth/login', ui(), { name: 'alice', password: ALICE_PASSWORD })).status).toBe(401);
    await login('alice', 'brand-new-password-1');
  });
});
