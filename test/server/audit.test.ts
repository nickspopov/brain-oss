// Audit and admin_audit_query: a row for every call, including reads and denials; filters,
// cursor; access only with the admin capability; neither content nor secrets.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WriteResult } from '../helpers/api.js';
import type { Client } from '../helpers/clients/index.js';
import { buildWorld, ALICE_PASSWORD, RANDOM_ID, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';
import { secretSamples } from '../helpers/secrets.js';

interface Entry {
  id: number;
  ts: string;
  principal: string | null;
  via: string;
  op: string;
  outcome: string;
  space: string | null;
  doc_id: string | null;
  rev: number | null;
  request_id: string | null;
  ip: string | null;
  detail: Record<string, unknown> | null;
}
interface AuditResult {
  entries: Entry[];
  next_cursor?: string;
}

describe('audit', () => {
  let h: Harness;
  let w: World;
  let alice: Client;
  let hermes: Client;
  let alphabot: Client;

  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h);
    alice = w.client('alice');
    hermes = w.client('alice-helper');
    alphabot = w.client('alphabot');
  });
  afterEach(async () => {
    await h.close();
  });

  const query = (input: Record<string, unknown> = {}) => alice.call<AuditResult>('admin_audit_query', input);

  it('one row per call, in call order, with the outcome of each — reads, writes, refusals, replays', async () => {
    const before = h.opCalls();
    const calls: [Client, string, Record<string, unknown>, string][] = [
      [hermes, 'write', { space: 'shared', path: 'a.md', content: '# A\n', message: 'c', request_id: 'audit-req-0001' }, 'ok'],
      [hermes, 'write', { space: 'shared', path: 'a.md', content: '# A\n', message: 'c', request_id: 'audit-req-0001' }, 'ok'],
      [hermes, 'read', { space: 'shared', path: 'a.md' }, 'ok'],
      [hermes, 'edit', { space: 'shared', path: 'a.md', edits: [{ old_text: '# A', new_text: '# B' }], message: 'e' }, 'ok'],
      [hermes, 'edit', { space: 'shared', path: 'a.md', edits: [{ old_text: 'nope', new_text: 'x' }], message: 'e' }, 'edit_failed'],
      [alphabot, 'write', { space: 'shared', path: 'a.md', content: 'x\n', expected_rev: 2, message: 'f' }, 'forbidden'],
      [alphabot, 'read', { space: 'proj-beta', path: 'nothing.md' }, 'not_found'],
      [alphabot, 'read', { id: RANDOM_ID }, 'not_found'],
      [hermes, 'write', { space: 'shared', path: 'a.md', content: 'x\n', message: 'blind' }, 'conflict'],
      [hermes, 'write', { space: 'shared', path: 'a.md' }, 'invalid_input'],
      [hermes, 'no_such_op', {}, 'not_found'],
      [hermes, 'admin_audit_query', {}, 'not_found'],
      [hermes, 'search', { query: 'B' }, 'ok'],
      [hermes, 'delete', { space: 'shared', path: 'a.md', message: 'd' }, 'ok'],
      [hermes, 'history', { space: 'shared', path: 'a.md' }, 'not_found'],
    ];
    for (const [c, op, input] of calls) await c.raw(op, input);
    expect(h.opCalls() - before).toBe(calls.length);
    const rows = h.core.db.prepare("SELECT op, outcome, principal_id FROM audit WHERE via = 'rest' ORDER BY id").all() as { op: string; outcome: string }[];
    expect(rows.map((r) => [r.op, r.outcome])).toEqual(calls.map(([, op, , outcome]) => [op, outcome]));
    const replay = (await query({ op: 'write', outcome: 'ok' })).entries.find((e) => e.detail?.replay === true);
    expect(replay).toMatchObject({ principal: 'alice-helper', request_id: 'audit-req-0001' });
  });

  it('entries carry principal, space, doc, rev, via, ip; read rows name the document; search rows the query', async () => {
    const created = await hermes.call<WriteResult>('write', { space: 'shared', path: 'doc.md', content: '# Doc\nplanning\n', message: 'c' });
    await hermes.call('read', { id: created.doc!.id });
    await hermes.call('search', { query: 'planning' });
    const { entries } = await query({ principal: 'alice-helper' });
    expect(entries.map((e) => e.op)).toEqual(['search', 'read', 'write']);
    const [search, read, write] = entries;
    expect(write).toMatchObject({ principal: 'alice-helper', via: 'rest', op: 'write', outcome: 'ok', space: 'shared', doc_id: created.doc!.id, rev: 1 });
    expect(write!.ip).toBeTruthy();
    expect(new Date(write!.ts).toISOString()).toBe(write!.ts);
    expect(read).toMatchObject({ op: 'read', doc_id: created.doc!.id, rev: 1 });
    expect(search!.detail).toEqual({ query: 'planning', results: 1 });
    expect(JSON.stringify(entries)).not.toContain('# Doc');
  });

  it('filters by op, outcome, space, doc_id, time; paginates newest first with a cursor', async () => {
    for (let i = 0; i < 7; i++) await hermes.call('write', { space: 'shared', path: `p${i}.md`, content: `${i}\n`, message: 'p' });
    const doc = await hermes.call<WriteResult>('write', { space: 'handoff', path: 'h.md', content: 'h\n', message: 'h' });
    await alphabot.raw('read', { space: 'proj-beta', path: 'x.md' });
    expect((await query({ space: 'handoff' })).entries.map((e) => e.doc_id)).toEqual([doc.doc!.id]);
    expect((await query({ doc_id: doc.doc!.id })).entries).toHaveLength(1);
    expect((await query({ outcome: 'not_found' })).entries.map((e) => e.principal)).toEqual(['alphabot']);
    expect((await query({ principal: 'no-such-agent' })).entries).toEqual([]);
    expect((await query({ space: 'no-such-space' })).entries).toEqual([]);
    const future = new Date(h.clock.now() + 60_000).toISOString();
    expect((await query({ since: future })).entries).toEqual([]);
    expect((await query({ until: future, op: 'write' })).entries).toHaveLength(8);
    const pages: number[][] = [];
    let cursor: string | undefined;
    do {
      const r = await query({ op: 'write', limit: 3, ...(cursor ? { cursor } : {}) });
      pages.push(r.entries.map((e) => e.id));
      cursor = r.next_cursor;
    } while (cursor);
    expect(pages.map((p) => p.length)).toEqual([3, 3, 2]);
    const ids = pages.flat();
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    // The cursor is bound to the parameters and to the caller.
    const first = await query({ op: 'write', limit: 3 });
    const wrong = await alice.raw('admin_audit_query', { op: 'read', limit: 3, cursor: first.next_cursor });
    expect(wrong.status).toBe(400);
    expect((await alice.raw('admin_audit_query', { since: 'yesterday' })).status).toBe(400);
  });

  it('only callers with the admin capability see the operation; an agent granted the capability does', async () => {
    const r = await alphabot.raw('admin_audit_query', {});
    const missing = await alphabot.raw('no_such_admin_op', {});
    expect(r.status).toBe(404);
    expect(r.text).toBe(missing.text);
    expect(r.text).not.toContain('audit');
    h.core.db.prepare('UPDATE principals SET can_admin = 1 WHERE name = ?').run('alice-assistant');
    const claude = w.client('alice-assistant');
    expect((await claude.call<AuditResult>('admin_audit_query', { limit: 1 })).entries).toHaveLength(1);
  });

  it('a rejected secret leaves only the rule names, never the value; a superadmin override from the UI is recorded', async () => {
    const secret = secretSamples().github_pat_classic!;
    const r = await hermes.raw('write', { space: 'shared', path: 's.md', content: `key ${secret}\n`, message: 'k' });
    expect(r.status).toBe(422);
    const rows = JSON.stringify(h.core.db.prepare('SELECT * FROM audit').all());
    expect(rows).toContain('secret_detected');
    expect(rows).not.toContain(secret.slice(4));
    // The bypass flag is not available to an agent, nor to a superadmin using a token (not the UI).
    const agent = await hermes.raw('write', { space: 'shared', path: 's.md', content: `key ${secret}\n`, message: 'k', allow_secret: true });
    expect(agent.body).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    const viaToken = await alice.raw('write', { space: 'shared', path: 's.md', content: `key ${secret}\n`, message: 'k', allow_secret: true });
    expect(viaToken.body).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it('the superadmin override from a UI session commits and is audited with the rule names', async () => {
    const ui = { 'x-brain-client': 'web', origin: h.config.origin, 'content-type': 'application/json' };
    const login = await fetch(`${h.url}/api/v1/auth/login`, { method: 'POST', headers: ui, body: JSON.stringify({ name: 'alice', password: ALICE_PASSWORD }) });
    const cookie = `brain_session=${/brain_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')![1]}`;
    const secret = secretSamples().stripe_secret!;
    const call = (body: Record<string, unknown>) =>
      fetch(`${h.url}/api/v1/ops/write`, { method: 'POST', headers: { ...ui, cookie }, body: JSON.stringify(body) }).then((x) => x.json() as Promise<{ ok: boolean; error?: { code: string } }>);
    expect((await call({ space: 'shared', path: 'ui.md', content: `k ${secret}\n`, message: 'ui' })).error?.code).toBe('secret_detected');
    expect((await call({ space: 'shared', path: 'ui.md', content: `k ${secret}\n`, message: 'ui', allow_secret: true })).ok).toBe(true);
    const row = (await query({ op: 'write', outcome: 'ok' })).entries[0]!;
    expect(row).toMatchObject({ principal: 'alice', via: 'ui', detail: { secret_override: ['stripe_live_key'] } });
  });
});
