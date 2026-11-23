// Client-held cursor and event selection on
// GET /api/v1/inbox, handoff_wait and scripts/inbox-poll.sh. Level-triggered behaviour stays the default.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readOpNames } from '../../src/app.js';
import { removeGrant, setGrant } from '../../src/core/grants.js';
import { runJanitor } from '../../src/core/janitor.js';
import { recordMailEvent } from '../../src/store/mailevents.js';
import type { SpaceRow } from '../../src/store/types.js';
import type { Client } from '../helpers/clients/index.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
let w: World;

afterEach(async () => {
  await h?.close();
});

interface Ev {
  id: string;
  rev: number;
  kind: 'inbound' | 'updated' | 'answered';
  space: string;
}
interface Poll {
  waiting: number;
  answered: number;
  newest: unknown;
  server_time: string;
  next_cursor: string;
  events?: Ev[];
  more?: true;
  resync?: true;
}
interface Msg {
  id: string;
  path: string;
  rev: number;
  status: string;
}

async function setup(): Promise<void> {
  h = await startHarness();
  w = buildWorld(h);
}

async function pollRaw(token: string, q: Record<string, string> = {}): Promise<{ status: number; body: unknown; text: string }> {
  const qs = new URLSearchParams(q).toString();
  const res = await fetch(`${h.url}/api/v1/inbox${qs ? `?${qs}` : ''}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as unknown, text };
}

async function poll(token: string, q: Record<string, string> = {}): Promise<Poll> {
  const r = await pollRaw(token, q);
  if (r.status !== 200) throw new Error(r.text);
  return r.body as Poll;
}

const send = async (c: Client, to: string, title: string): Promise<Msg> => (await c.call<{ message: Msg }>('handoff_send', { to, title, body: `Body of ${title}.` })).message;
const status = async (c: Client, id: string): Promise<string> => (await c.call<{ handoff?: { status: string } }>('read', { id })).handoff!.status;
const outboxSeen = (name: string): unknown => h.core.db.prepare('SELECT outbox_seen_at FROM principals WHERE name = ?').pluck().get(name);
const legacy = (p: Poll) => ({ waiting: p.waiting, answered: p.answered, newest: p.newest });

describe('GET /api/v1/inbox without since: as before, plus next_cursor', () => {
  it('the same fields and values, a cursor bound to the caller, nothing changes', async () => {
    await setup();
    const m = await send(w.client('alice-helper'), 'alphabot', 'Hello');
    const p = await poll(w.tokens.alphabot);
    expect(Object.keys(p)).toEqual(['waiting', 'newest', 'answered', 'server_time', 'next_cursor']);
    expect(p).toMatchObject({ waiting: 1, answered: 0, newest: { id: m.id, from: 'alice-helper', title: 'Hello' } });
    expect(p.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    // Sealed with a fresh nonce: two answers at the same state differ, and the length does not grow with seq.
    const q = await poll(w.tokens.alphabot);
    expect(q.next_cursor).not.toBe(p.next_cursor);
    expect(q.next_cursor.length).toBe(p.next_cursor.length);
    expect(await status(w.client('alice-helper'), m.id)).toBe('new');
  });

  it('?events must be inbox, answers or both', async () => {
    await setup();
    const r = await pollRaw(w.tokens.alphabot, { events: 'all' });
    expect(r.status).toBe(400);
    expect(r.text).toContain('events');
  });
});

describe('cursor: events after it, replay, independent listeners', () => {
  it('two listeners with their own cursors do not consume each other’s events; a lost response replays; polling marks nothing', async () => {
    await setup();
    const hermes = w.client('alice-helper');
    const a0 = (await poll(w.tokens.alphabot)).next_cursor;
    const b0 = (await poll(w.tokens.alphabot)).next_cursor;
    const m = await send(hermes, 'alphabot', 'One');
    const a1 = await poll(w.tokens.alphabot, { since: a0 });
    expect(a1.events).toEqual([{ id: m.id, rev: 1, kind: 'inbound', space: 'handoff' }]);
    // Lost response: the same old cursor answers the same events.
    const again = await poll(w.tokens.alphabot, { since: a0 });
    expect(again.events).toEqual(a1.events);
    // Listener A moves on: nothing new for it.
    expect((await poll(w.tokens.alphabot, { since: a1.next_cursor })).events).toEqual([]);
    // Listener B still gets the event with its own cursor.
    expect((await poll(w.tokens.alphabot, { since: b0 })).events).toEqual(a1.events);
    // Nothing was marked received.
    expect(await status(hermes, m.id)).toBe('new');
    expect(legacy(await poll(w.tokens.alphabot))).toMatchObject({ waiting: 1 });
    const m2 = await send(hermes, 'alphabot', 'Two');
    expect((await poll(w.tokens.alphabot, { since: a1.next_cursor })).events!.map((e) => e.id)).toEqual([m2.id]);
    expect((await poll(w.tokens.alphabot, { since: b0 })).events!.map((e) => e.id)).toEqual([m.id, m2.id]);
  });

  it('an edit after receipt is `updated`; an answer is `answered`; answers are filtered by events=inbox', async () => {
    await setup();
    const hermes = w.client('alice-helper');
    const alphabot = w.client('alphabot');
    const m = await send(hermes, 'alphabot', 'Plan');
    await alphabot.call('handoff_ack', { id: m.id, expected_rev: 1, status: 'received' });
    const f0 = (await poll(w.tokens.alphabot, { events: 'inbox' })).next_cursor;
    const hAll = (await poll(w.tokens['alice-helper'])).next_cursor;
    const hIn = (await poll(w.tokens['alice-helper'], { events: 'inbox' })).next_cursor;
    const hAns = (await poll(w.tokens['alice-helper'], { events: 'answers' })).next_cursor;
    await hermes.call('write', { space: 'handoff', path: m.path, content: '# Plan\n\nChanged.\n', expected_rev: 1, message: 'edit' });
    expect((await poll(w.tokens.alphabot, { since: f0, events: 'inbox' })).events).toEqual([{ id: m.id, rev: 2, kind: 'updated', space: 'handoff' }]);
    await alphabot.call('handoff_ack', { id: m.id, expected_rev: 2, status: 'done' });
    const all = await poll(w.tokens['alice-helper'], { since: hAll });
    expect(all.events).toEqual([{ id: m.id, rev: 2, kind: 'answered', space: 'handoff' }]);
    expect((await poll(w.tokens['alice-helper'], { since: hIn, events: 'inbox' })).events).toEqual([]);
    expect((await poll(w.tokens['alice-helper'], { since: hAns, events: 'answers' })).events).toEqual(all.events);
    // The level answer count is still 1: polling never marks an answer seen.
    expect(outboxSeen('alice-helper')).toBeNull();
    expect((await poll(w.tokens['alice-helper'])).answered).toBe(1);
  });

  it('pagination: 100 per page, more: true, then the rest; hidden events between pages are skipped', async () => {
    await setup();
    const m = await send(w.client('alice-helper'), 'alphabot', 'Paged');
    const hidden = await send(w.client('alice-helper'), 'betabot', 'Not alphabot’s');
    const c0 = (await poll(w.tokens.alphabot)).next_cursor;
    const db = h.core.db;
    const alphabot = w.principals.alphabot.id;
    const ev = (docId: string, rev: number) => recordMailEvent(db, { tenantId: h.core.tenantId, principalId: alphabot, docId, rev, kind: 'updated', now: h.clock.now() });
    db.transaction(() => {
      for (let i = 0; i < 150; i++) ev(m.id, i + 2);
      // More than one scan batch of events alphabot cannot see (another recipient's message).
      for (let i = 0; i < 700; i++) ev(hidden.id, 1);
      for (let i = 0; i < 100; i++) ev(m.id, i + 200);
    })();
    const p1 = await poll(w.tokens.alphabot, { since: c0 });
    expect(p1.events).toHaveLength(100);
    expect(p1.more).toBe(true);
    const p2 = await poll(w.tokens.alphabot, { since: p1.next_cursor });
    expect(p2.events).toHaveLength(100);
    expect(p2.more).toBe(true);
    expect(p2.events![0]!.rev).toBe(102);
    expect(p2.events![50]!.rev).toBe(200);
    const p3 = await poll(w.tokens.alphabot, { since: p2.next_cursor });
    expect(p3.events!.map((e) => e.rev)).toEqual(Array.from({ length: 50 }, (_, i) => 250 + i));
    expect(p3.more).toBeUndefined();
    expect(JSON.stringify([p1, p2, p3])).not.toContain(hidden.id);
    expect((await poll(w.tokens.alphabot, { since: p3.next_cursor })).events).toEqual([]);
  });
});

describe('resync: an unusable cursor never answers an empty success', () => {
  it('garbage, foreign, another filter, too long and expired cursors → resync: true with the caller’s level snapshot', async () => {
    await setup();
    const m = await send(w.client('alice-helper'), 'alphabot', 'Waiting');
    const own = await send(w.client('alphabot'), 'betabot', 'From alphabot');
    const hermesCursor = (await poll(w.tokens['alice-helper'])).next_cursor;
    const inboxCursor = (await poll(w.tokens.alphabot, { events: 'inbox' })).next_cursor;
    const cases: Record<string, string>[] = [
      { since: 'garbage' },
      { since: '' },
      { since: hermesCursor },
      { since: inboxCursor },
      { since: inboxCursor, events: 'answers' },
      { since: 'A'.repeat(2000) },
    ];
    for (const q of cases) {
      const p = await poll(w.tokens.alphabot, q);
      expect(p.resync, JSON.stringify(q).slice(0, 80)).toBe(true);
      const want = q.events === 'answers' ? [] : [{ id: m.id, rev: 1, kind: 'inbound', space: 'handoff' }];
      expect(p.events).toEqual(want);
      expect(JSON.stringify(p)).not.toContain(own.id);
      // The new cursor is usable.
      expect((await poll(w.tokens.alphabot, { since: p.next_cursor, ...(q.events ? { events: q.events } : {}) })).resync).toBeUndefined();
    }
    // A foreign cursor gives the caller's own state, never the cursor owner's.
    expect(JSON.stringify(await poll(w.tokens['alice-helper'], { since: inboxCursor }))).not.toContain(m.id);
    // Expired: the janitor prunes events older than 30 days and raises the floor.
    const c0 = (await poll(w.tokens.alphabot)).next_cursor;
    await send(w.client('alice-helper'), 'alphabot', 'Old');
    h.clock.advanceDays(31);
    const report = runJanitor(h.core, { readOps: readOpNames() });
    expect(report.mailEvents).toBeGreaterThan(0);
    const expired = await poll(w.tokens.alphabot, { since: c0 });
    expect(expired.resync).toBe(true);
    expect(expired.events!.length).toBe(2);
    // A cursor from beyond the head (a restored, older database) resyncs too.
    h.core.db.prepare('DELETE FROM mail_events').run();
    h.core.db.prepare("UPDATE sqlite_sequence SET seq = 0 WHERE name = 'mail_events'").run();
    h.core.db.prepare('UPDATE mail_events_floor SET seq = 0').run();
    expect((await poll(w.tokens.alphabot, { since: expired.next_cursor })).resync).toBe(true);
  });
});

describe('events never reveal other people’s mail', () => {
  it('a third party with write in the inbox space, a space Admin and a Guest see only their own events', async () => {
    await setup();
    const alice = w.client('alice');
    await alice.call('admin_principal_create', { name: 'guesty', kind: 'agent', trust: 'trusted' });
    await alice.call('admin_grant_set', { space: 'handoff', scope: 'space', subject: { type: 'principal', name: 'guesty' }, role: 'guest' });
    const { token: gt } = await alice.call<{ token: string }>('admin_token_issue', { principal: 'guesty', label: 'g' });
    w.grant('handoff', { principal: 'alice-assistant' }, 'admin');
    const tokens = { betabot: w.tokens.betabot, admin: w.tokens['alice-assistant'], guest: gt };
    const start: Record<string, string> = {};
    for (const [k, t] of Object.entries(tokens)) start[k] = (await poll(t)).next_cursor;
    const priv = await send(w.client('alice-helper'), 'alphabot', 'Private');
    await w.client('alphabot').call('handoff_ack', { id: priv.id, expected_rev: 1, status: 'done' });
    const toGuest = await send(w.client('alphabot'), 'guesty', 'Hi guest');
    for (const k of ['betabot', 'admin'] as const) {
      const p = await poll(tokens[k], { since: start[k]! });
      expect(p.events, k).toEqual([]);
      expect(JSON.stringify(p)).not.toContain(priv.id);
    }
    const g = await poll(gt, { since: start.guest! });
    expect(g.events).toEqual([{ id: toGuest.id, rev: 1, kind: 'inbound', space: 'handoff' }]);
    expect(JSON.stringify(g)).not.toContain(priv.id);
  });

  it('Alpha ↛ Beta: alphabot’s mail in its own inbox space produces no event and no wake for betabot', async () => {
    await setup();
    const core = h.core;
    removeGrant(core, { spaceId: w.spaces.handoff.id, scope: 'space', subjectType: 'principal', subjectId: w.principals.alphabot.id });
    await w.client('alice').call('admin_space_create', { slug: 'alpha-handoff', name: 'Alpha inbox', inbox: true });
    const box = core.db.prepare("SELECT * FROM spaces WHERE slug = 'alpha-handoff'").get() as SpaceRow;
    setGrant(core, { spaceId: box.id, scope: 'space', pathPrefix: null, docId: null, role: 'write', subjectType: 'principal', subjectId: w.principals.alphabot.id }, w.principals.alice.id);
    const s0 = (await poll(w.tokens.betabot)).next_cursor;
    const parked = poll(w.tokens.betabot, { since: s0, wait: '2' });
    const fm = (await w.client('alphabot').call<{ message: Msg }>('handoff_send', { to: 'alice', title: 'Alpha', body: 'b', space: 'alpha-handoff' })).message;
    const p = await parked;
    expect(p.events).toEqual([]);
    expect(JSON.stringify(p)).not.toMatch(new RegExp(`${fm.id}|alpha-handoff`));
  });

  it('revocation before a replay hides the event', async () => {
    await setup();
    const c0 = (await poll(w.tokens.alphabot)).next_cursor;
    const m = await send(w.client('alice-helper'), 'alphabot', 'Soon hidden');
    expect((await poll(w.tokens.alphabot, { since: c0 })).events!.map((e) => e.id)).toEqual([m.id]);
    setGrant(h.core, { spaceId: w.spaces.handoff.id, scope: 'space', pathPrefix: null, docId: null, role: 'none', subjectType: 'principal', subjectId: w.principals.alphabot.id }, w.principals.alice.id);
    const replay = await poll(w.tokens.alphabot, { since: c0 });
    expect(replay.events).toEqual([]);
    expect(JSON.stringify(replay)).not.toContain(m.id);
  });
});

describe('waiting with a cursor', () => {
  it('parks until an event after the cursor; mail already behind the cursor does not wake; two cursor waits park side by side', async () => {
    await setup();
    await send(w.client('alice-helper'), 'alphabot', 'Already here');
    const c0 = (await poll(w.tokens.alphabot)).next_cursor;
    // Level would answer at once (1 waiting); the cursor wait parks.
    const t0 = performance.now();
    const quiet = await poll(w.tokens.alphabot, { since: c0, wait: '1' });
    expect(performance.now() - t0).toBeGreaterThan(800);
    expect(quiet).toMatchObject({ waiting: 1, events: [] });
    const a = poll(w.tokens.alphabot, { since: c0, wait: '20' });
    const b = poll(w.tokens.alphabot, { since: quiet.next_cursor, wait: '20' });
    const until = Date.now() + 5000;
    while (h.core.waiters.size < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(h.core.waiters.size).toBe(2);
    const m = await send(w.client('alice-helper'), 'alphabot', 'New');
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.events!.map((e) => e.id)).toEqual([m.id]);
    expect(rb.events!.map((e) => e.id)).toEqual([m.id]);
  });

  it('a level wait with events=inbox does not return for unseen answers', async () => {
    await setup();
    const m = await send(w.client('alice-helper'), 'alphabot', 'Q');
    await w.client('alphabot').call('handoff_ack', { id: m.id, expected_rev: 1, status: 'done' });
    expect((await poll(w.tokens['alice-helper'])).answered).toBe(1);
    const t0 = performance.now();
    const p = await poll(w.tokens['alice-helper'], { events: 'inbox', wait: '1' });
    expect(performance.now() - t0).toBeGreaterThan(800);
    expect(p).toMatchObject({ waiting: 0, answered: 1 });
  });
});

describe('handoff_wait(since, events)', () => {
  interface WaitOut {
    status: string;
    next_cursor: string;
    next_call: string | null;
    events?: Ev[];
    resync?: true;
    waiting: number;
  }
  it('without since: as before plus next_cursor; with since: events after it, next_call carries the cursor; garbage → resync', async () => {
    await setup();
    const alphabot = w.client('alphabot');
    const m = await send(w.client('alice-helper'), 'alphabot', 'W');
    const past = '2000-01-01T00:00:00Z';
    const lvl = await alphabot.call<WaitOut>('handoff_wait', { until: past });
    expect(lvl).toMatchObject({ status: 'mail', waiting: 1 });
    expect(lvl.events).toBeUndefined();
    expect(lvl.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    // The level cursor already covers m: nothing after it.
    const quiet = await alphabot.call<WaitOut>('handoff_wait', { until: past, since: lvl.next_cursor });
    expect(quiet).toMatchObject({ status: 'over', events: [], waiting: 1 });
    // A cursor is bound to its filter: one for inbox comes from a call with events="inbox".
    const inboxCursor = (await alphabot.call<WaitOut>('handoff_wait', { until: past, events: 'inbox' })).next_cursor;
    expect((await alphabot.call<WaitOut>('handoff_wait', { until: past, since: lvl.next_cursor, events: 'inbox' })).resync).toBe(true);
    const until = new Date(h.clock.now() + 60_000).toISOString();
    const parked = alphabot.call<WaitOut>('handoff_wait', { until, since: inboxCursor, events: 'inbox' });
    const end = Date.now() + 5000;
    while (h.core.waiters.size < 1 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    const m2 = await send(w.client('alice-helper'), 'alphabot', 'W2');
    const got = await parked;
    expect(got.status).toBe('mail');
    expect(got.events).toEqual([{ id: m2.id, rev: 1, kind: 'inbound', space: 'handoff' }]);
    expect(got.next_call).toContain(`since="${got.next_cursor}"`);
    expect(got.next_call).toContain('events="inbox"');
    const bad = await alphabot.call<WaitOut>('handoff_wait', { until: past, since: 'nope' });
    expect(bad.resync).toBe(true);
    expect(bad.events!.map((e) => e.id).sort()).toEqual([m.id, m2.id].sort());
    const text = await w.client('alphabot', 'mcp').raw('handoff_wait', { until: past, since: 'nope' });
    expect(text.text).toContain('could not be used');
  });
});

describe('scripts/inbox-poll.sh with a cursor', () => {
  const script = path.resolve(import.meta.dirname, '../../scripts/inbox-poll.sh');
  const run = (args: string[], token: string) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) => {
      execFile(process.env.POLL_SH ?? 'sh', [script, ...args], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', BRAIN_URL: h.url, BRAIN_TOKEN: token } }, (e, out, errOut) => {
        resolve({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, out, err: errOut });
      });
    });
  const cursorOf = (out: string): string => /^cursor=([A-Za-z0-9_-]+)$/m.exec(out)![1]!;

  it('legacy calls unchanged; --events picks inbox or answers', async () => {
    await setup();
    const m = await send(w.client('alice-helper'), 'alphabot', 'Q');
    await w.client('alphabot').call('handoff_ack', { id: m.id, expected_rev: 1, status: 'done' });
    const t = w.tokens['alice-helper'];
    const plain = await run([], t);
    expect(plain).toEqual({ code: 0, out: 'Brain inbox: 0 waiting, 1 answered\n', err: '' });
    expect(await run(['--events', 'inbox'], t)).toEqual({ code: 1, out: '', err: '' });
    expect((await run(['--events', 'answers'], t)).code).toBe(0);
    expect((await run(['--events', 'both'], t)).out).toBe(plain.out);
    expect((await run(['--events', 'all'], t)).code).toBe(2);
    expect((await run(['--commit'], t)).code).toBe(2);
    expect((await run(['--since', 'x', '--cursor-file', '/tmp/x'], t)).code).toBe(2);
    const json = await run(['--json'], t);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({ waiting: 0, answered: 1 });
  });

  it('--cursor-file: first a level check that prints the cursor; written only with --commit; then wakes only on new events; garbage → resync → 0', async () => {
    await setup();
    const t = w.tokens.alphabot;
    const file = path.join(h.dataDir, 'alphabot.cursor');
    await send(w.client('alice-helper'), 'alphabot', 'Before');
    const first = await run(['--cursor-file', file], t);
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/^Brain inbox: 1 waiting, 0 answered.*\ncursor=[A-Za-z0-9_-]+\n$/);
    expect(fs.existsSync(file)).toBe(false);
    const committed = await run(['--cursor-file', file, '--commit'], t);
    expect(committed.code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${cursorOf(committed.out)}\n`);
    // The waiting message is behind the cursor: no wake, though the level still says 1 waiting.
    const none = await run(['--cursor-file', file], t);
    expect(none.code).toBe(1);
    expect(none.out).toMatch(/^cursor=[A-Za-z0-9_-]+\n$/);
    expect((await run([], t)).code).toBe(0);
    const m = await send(w.client('alice-helper'), 'alphabot', 'After');
    const woke = await run(['--cursor-file', file], t);
    expect(woke.code).toBe(0);
    expect(woke.out).toMatch(/^Brain inbox: 1 new events \(inbound 1, updated 0, answered 0\); 2 waiting, 0 answered/);
    // Not committed: the same events again (replay); --since gives the same.
    expect((await run(['--cursor-file', file], t)).out.split('\n')[0]).toBe(woke.out.split('\n')[0]);
    const inline = await run(['--since', fs.readFileSync(file, 'utf8').trim(), '--json'], t);
    expect(JSON.parse(inline.out).events).toEqual([{ id: m.id, rev: 1, kind: 'inbound', space: 'handoff' }]);
    await run(['--cursor-file', file, '--commit'], t);
    expect((await run(['--cursor-file', file], t)).code).toBe(1);
    fs.writeFileSync(file, 'not a cursor!\n');
    const resync = await run(['--cursor-file', file], t);
    expect(resync.code).toBe(0);
    expect(resync.out).toMatch(/^Brain inbox: resync/);
    // Another principal's cursor: resync too.
    const other = cursorOf((await run(['--cursor-file', path.join(h.dataDir, 'none')], w.tokens.betabot)).out);
    expect((await run(['--since', other], t)).out).toMatch(/^Brain inbox: resync/);
    for (const r of [first, none, woke, resync]) expect(r.out + r.err).not.toContain('brn_');
  });

  it('watch with a cursor parks past old mail and exits 0 the moment a new message arrives', async () => {
    await setup();
    const t = w.tokens.alphabot;
    const file = path.join(h.dataDir, 'watch.cursor');
    await send(w.client('alice-helper'), 'alphabot', 'Old');
    await run(['--cursor-file', file, '--commit', '--events', 'inbox'], t);
    const watching = run(['--cursor-file', file, '--commit', '--events', 'inbox', '--watch-seconds', '30'], t);
    const end = Date.now() + 5000;
    while (h.core.waiters.size < 1 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(h.core.waiters.size).toBe(1);
    const before = fs.readFileSync(file, 'utf8');
    await send(w.client('alice-helper'), 'alphabot', 'New');
    const r = await watching;
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Brain inbox: 1 new events \(inbound 1/);
    expect(fs.readFileSync(file, 'utf8')).not.toBe(before);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${cursorOf(r.out)}\n`);
  });
});

