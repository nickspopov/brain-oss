// The inbox in any space with the `inbox` setting, scoped per space, and the poll
// endpoint for cron jobs. The owner's case: a project inbox `alpha-handoff` for alpha, an
// external friend agent, alice and alice-assistant, while oak (only in `handoff`) and pine (alpha's agent) never learn of
// each other.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readOpNames } from '../../src/app.js';
import { setGrant } from '../../src/core/grants.js';
import { runJanitor } from '../../src/core/janitor.js';
import { createPrincipal } from '../../src/core/principals.js';
import { createSpace } from '../../src/core/spaces.js';
import { issueToken } from '../../src/core/tokens.js';
import { loadMigrations } from '../../src/db/migrate.js';
import type { SpaceRow } from '../../src/store/types.js';
import { ApiError, makeClient, type Client } from '../helpers/clients/index.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
let w: World;
const open: SdkClient[] = [];

interface Msg {
  id: string;
  space: string;
  path: string;
  title: string;
  from: string;
  to: string;
  status: string;
  rev: number;
  thread_id: string;
  reply_to: string | null;
  created_at: string;
}
interface Inbox {
  messages: Msg[];
}
interface Sent {
  message: Msg;
}
interface Agent {
  name: string;
  id: string;
  token: string;
  rest: Client;
}
interface Poll {
  waiting: number;
  newest: { id: string; space: string; from: string; title: string; sent_at: string } | null;
  answered: number;
}

const DAY = 86_400_000;

function grant(space: SpaceRow, subjectId: string, role: 'read' | 'write' | 'none', pathPrefix: string | null = null): void {
  setGrant(
    h.core,
    { spaceId: space.id, scope: pathPrefix === null ? 'space' : 'path', pathPrefix, docId: null, role, subjectType: 'principal', subjectId },
    w.principals.alice.id,
  );
}

function agent(name: string, spaces: SpaceRow[], trust: 'trusted' | 'limited' = 'trusted'): Agent {
  const alice = w.principals.alice;
  const p = createPrincipal(h.core, { name, kind: 'agent', trust, ownerId: alice.id }, alice.id);
  for (const s of spaces) grant(s, p.id, 'write');
  const token = issueToken(h.core, p.id, { label: name, createdBy: alice.id }).token;
  return { name, id: p.id, token, rest: makeClient('rest', h, token) };
}

async function oriented(token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${h.url}/mcp/v1`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const c = new SdkClient({ name: 'brain-test', version: '0.0.0' });
  await c.connect(transport);
  open.push(c);
  const start = (await c.callTool({ name: 'start_here', arguments: {} })) as CallToolResult;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name, arguments: args })) as CallToolResult;
    return { r, text: r.content.map((x) => (x.type === 'text' ? x.text : '')) };
  };
  return { c, start, startText: (start.content[0] as { text: string }).text, call };
}

const lineOf = (text: string[], lead: string): string | undefined =>
  text.slice(1).join('\n').split('\n').find((l) => l.startsWith(lead));

async function err(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected an error');
}

const send = (from: Client, to: string, title: string, extra: Record<string, unknown> = {}) =>
  from.call<Sent>('handoff_send', { to, title, body: 'Body.', ...extra });
const sendErr = async (from: Client, to: string, extra: Record<string, unknown> = {}) => {
  const e = await err(send(from, to, 'X', extra));
  expect(e.code).toBe('invalid_input');
  return e.message;
};

async function poll(token: string | undefined): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${h.url}/api/v1/inbox`, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() };
}
/** The poll body without `server_time` (checked here), `next_cursor` (opaque) and `newest.external` (false here unless said). */
const polled = async (token: string): Promise<Poll> => {
  const r = await poll(token);
  expect(r.status).toBe(200);
  const { server_time, next_cursor, ...body } = r.body as Poll & { server_time: string; next_cursor: string; newest: (Poll['newest'] & { external?: boolean }) | null };
  expect(next_cursor).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  expect(Math.abs(Date.parse(server_time) - h.clock.now())).toBeLessThan(5000);
  if (body.newest) {
    expect(body.newest.external).toBe(false);
    delete body.newest.external;
  }
  return body;
};

const expiresAt = (id: string) => (h.core.db.prepare('SELECT expires_at AS e FROM documents WHERE id = ?').get(id) as { e: number | null }).e;
const janitor = () => runJanitor(h.core, { readOps: readOpNames() });

let alphaBox: SpaceRow;
let alpha: Agent;
let friend: Agent;
let sg: Agent;
let claude: Client;

beforeEach(async () => {
  h = await startHarness();
  w = buildWorld(h, 'rest');
  const created = await w.client('alice').call<{ space: { slug: string; inbox: boolean } }>('admin_space_create', {
    slug: 'alpha-handoff',
    name: 'Alpha inbox',
    inbox: true,
  });
  expect(created.space.inbox).toBe(true);
  alphaBox = h.core.db.prepare("SELECT * FROM spaces WHERE slug = 'alpha-handoff'").get() as SpaceRow;
  alpha = agent('pine', [alphaBox]);
  friend = agent('friend', [alphaBox], 'limited');
  sg = agent('oak', [w.spaces.handoff]);
  grant(alphaBox, w.principals['alice-assistant'].id, 'write');
  claude = w.client('alice-assistant');
});
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
  expect(h.doctor().problems).toEqual([]);
  await h.close();
});

describe('the inbox setting', () => {
  it('admin_space_create/update set it; handoff has it by default, other spaces not; spaces() shows it', async () => {
    const alice = w.client('alice');
    const list = await alice.call<{ spaces: { slug: string; inbox: boolean }[] }>('admin_space_list');
    expect(Object.fromEntries(list.spaces.map((s) => [s.slug, s.inbox]))).toEqual({
      'alpha-handoff': true,
      handoff: true,
      'proj-alpha': false,
      'proj-beta': false,
      recipes: false,
      shared: false,
    });
    expect((await alice.call<{ space: { inbox: boolean } }>('admin_space_update', { slug: 'shared', inbox: true })).space.inbox).toBe(true);
    expect((await alice.call<{ space: { inbox: boolean } }>('admin_space_update', { slug: 'shared', inbox: false })).space.inbox).toBe(false);
    // A space created by code without the setting: only the slug handoff is an inbox.
    expect(createSpace(h.core, { slug: 'other' }, null).inbox).toBe(0);
    const mine = await friend.rest.call<{ spaces: { slug: string; inbox: boolean }[] }>('spaces');
    expect(mine.spaces.map((x) => [x.slug, x.inbox])).toEqual([
      ['alpha-handoff', true],
      ['recipes', false],
    ]);
  });

  it('migration 0007 turns it on for slug handoff only', () => {
    h.core.db.exec('UPDATE spaces SET inbox = 0');
    const sql = loadMigrations().find((m) => m.name === '0007_inbox_spaces.sql')!.sql;
    const update = sql.split('\n').find((l) => l.startsWith('UPDATE spaces'))!;
    h.core.db.exec(update);
    expect(h.core.db.prepare('SELECT slug FROM spaces WHERE inbox = 1').pluck().all()).toEqual(['handoff']);
  });

  it('turned off: refused while messages are open; then no listing, hints, acks or new messages there; turned on again: back', async () => {
    const s = await send(friend.rest, 'pine', 'Hello');
    // An open message keeps the setting on.
    const refused = await err(w.client('alice').call('admin_space_update', { slug: 'alpha-handoff', inbox: false }));
    expect(refused.code).toBe('conflict');
    expect(refused.message).toContain('1 open message in this space; close them (done or declined) before turning inbox off.');
    expect((await w.client('alice').call<{ spaces: { slug: string; inbox: boolean }[] }>('admin_space_list')).spaces.find((x) => x.slug === 'alpha-handoff')!.inbox).toBe(true);
    await alpha.rest.call('handoff_ack', { id: s.message.id, expected_rev: 1, status: 'done' });
    await w.client('alice').call('admin_space_update', { slug: 'alpha-handoff', inbox: false });
    expect((await alpha.rest.call<Inbox>('handoff_inbox', { include_done: true })).messages).toEqual([]);
    expect(await polled(alpha.token)).toEqual({ waiting: 0, newest: null, answered: 0 });
    expect((await err(alpha.rest.call('handoff_ack', { id: s.message.id, expected_rev: 1, status: 'received' }))).code).toBe('invalid_input');
    const plain = await friend.rest.call<{ doc: { id: string } }>('write', { space: 'alpha-handoff', path: 'pine/plain.md', content: '# P\n', message: 'm' });
    expect(h.core.db.prepare('SELECT COUNT(*) FROM handoff_messages WHERE doc_id = ?').pluck().get(plain.doc.id)).toBe(0);
    // Without any inbox space the handoff tools are not advertised.
    const f = await oriented(friend.token);
    expect((await f.c.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith('handoff_'))).toEqual([]);
    await w.client('alice').call('admin_space_update', { slug: 'alpha-handoff', inbox: true });
    expect((await alpha.rest.call<Inbox>('handoff_inbox', { include_done: true })).messages.map((m) => m.id)).toEqual([s.message.id]);
  });

  it('export → import keeps the setting', async () => {
    const alice = w.client('alice');
    await send(friend.rest, 'pine', 'Kept');
    for (const [from, to] of [
      ['alpha-handoff', 'alpha-copy'],
      ['shared', 'shared-copy'],
    ] as const) {
      const exp = await alice.call<{ download_path: string }>('export', { space: from, mode: 'full' });
      const res = await fetch(`${h.url}${exp.download_path}`, { headers: { authorization: `Bearer ${w.tokens.alice}` } });
      const imp = await fetch(`${h.url}/api/v1/import?space=${to}&mode=as-new`, {
        method: 'POST',
        headers: { authorization: `Bearer ${w.tokens.alice}`, 'content-type': 'application/gzip' },
        body: new Uint8Array(await res.arrayBuffer()),
      });
      expect(imp.status).toBe(200);
    }
    const list = await alice.call<{ spaces: { slug: string; inbox: boolean }[] }>('admin_space_list');
    const flag = Object.fromEntries(list.spaces.map((x) => [x.slug, x.inbox]));
    expect([flag['alpha-copy'], flag['shared-copy']]).toEqual([true, false]);
  });
});

describe('a project inbox space', () => {
  it('friend → alpha lands in alpha-handoff; start_here, hints and the inbox name the space; the reply stays there', async () => {
    const day = new Date(h.clock.now()).toISOString().slice(0, 10);
    // friend can write only to alpha-handoff: that is the default.
    const s = await send(friend.rest, 'pine', 'Hello');
    expect(s.message).toMatchObject({ space: 'alpha-handoff', path: `pine/${day}-hello.md`, from: 'friend', to: 'pine', status: 'new' });

    const f = await oriented(alpha.token);
    const sh = f.start.structuredContent as { spaces: { slug: string; inbox?: { path: string; waiting: number; docs: { id: string }[] } }[] };
    expect(sh.spaces.map((x) => x.slug)).toEqual(['alpha-handoff', 'recipes']);
    expect(sh.spaces[0]!.inbox).toMatchObject({ path: 'alpha-handoff/pine/', waiting: 1, docs: [{ id: s.message.id }] });
    expect(f.startText).toContain('  Inbox: alpha-handoff/pine/ — 1 open message, 1 waiting');
    expect(lineOf((await f.call('whoami')).text, 'Inbox:')).toBe('Inbox: 1 waiting — "Hello" from friend in alpha-handoff. Call handoff_inbox.');
    const ib = await f.call('handoff_inbox');
    expect(ib.text[0]).toContain('- NEW "Hello" from friend in alpha-handoff, sent 0m ago');

    await alpha.rest.call('handoff_ack', { id: s.message.id, expected_rev: 1, status: 'done' });
    // The reply goes to the space of reply_to without naming it.
    const r = await send(alpha.rest, 'friend', 'Re: Hello', { reply_to: s.message.id });
    expect(r.message).toMatchObject({ space: 'alpha-handoff', path: `friend/${day}-re-hello.md`, thread_id: s.message.id, reply_to: s.message.id });
    const fr = await oriented(friend.token);
    expect(lineOf((await fr.call('whoami')).text, 'Outbox:')).toBe('Outbox: 1 answered — "Hello" done by pine in alpha-handoff. Call handoff_inbox(box="out").');
  });

  it('alice-assistant in both: default handoff, space picks the other; reply_to must be in the same space; lists aggregate', async () => {
    const a = await send(claude, 'oak', 'To sg');
    expect(a.message.space).toBe('handoff');
    const b = await send(claude, 'pine', 'To alpha', { space: 'alpha-handoff' });
    expect(b.message.space).toBe('alpha-handoff');
    const back = await send(alpha.rest, 'alice-assistant', 'Back');
    const crossed = await err(send(claude, 'pine', 'Cross', { reply_to: back.message.id, space: 'handoff' }));
    expect(crossed.message).toContain('space: A reply stays in the space of reply_to (alpha-handoff); omit space.');
    // Without space: the only inbox space where pine is a recipient.
    expect((await send(claude, 'pine', 'By recipient')).message.space).toBe('alpha-handoff');
    await send(sg.rest, 'alice-assistant', 'From sg');
    const inbox = await claude.call<Inbox>('handoff_inbox');
    expect(inbox.messages.map((m) => [m.title, m.space]).sort()).toEqual([
      ['Back', 'alpha-handoff'],
      ['From sg', 'handoff'],
    ]);
    expect((await claude.call<Inbox>('handoff_inbox', { space: 'handoff' })).messages.map((m) => m.title)).toEqual(['From sg']);
    const p = await polled(w.tokens['alice-assistant']);
    expect(p.waiting).toBe(2);
    // start_here: one Inbox line per inbox space, each with its slug.
    const c = await oriented(w.tokens['alice-assistant']);
    expect(c.startText).toContain('  Inbox: alpha-handoff/alice-assistant/ — 1 open message, 1 waiting');
    expect(c.startText).toContain('  Inbox: handoff/alice-assistant/ — 1 open message, 1 waiting');
  });

  it('several writable inbox spaces without handoff: specify space; none: say so', async () => {
    const other = await w.client('alice').call<{ space: { id: string } }>('admin_space_create', { slug: 'other-box', inbox: true });
    const otherBox = h.core.db.prepare('SELECT * FROM spaces WHERE id = ?').get(other.space.id) as SpaceRow;
    const two = agent('two', [alphaBox, otherBox]);
    // pine is a recipient only in alpha-handoff: that space, no question asked.
    expect((await send(two.rest, 'pine', 'Unique')).message.space).toBe('alpha-handoff');
    grant(otherBox, alpha.id, 'write');
    expect(await sendErr(two.rest, 'pine')).toContain('space: Specify space: one of alpha-handoff, other-box.');
    expect((await send(two.rest, 'pine', 'Picked', { space: 'alpha-handoff' })).message.space).toBe('alpha-handoff');
    const none = agent('none-bot', [w.spaces.shared]);
    expect(await sendErr(none.rest, 'pine')).toContain('space: No inbox space you can write to.');
  });

  it('plain write registers; legacy agent cards there never expire; onboarding asks for the profile; TTL rules as in handoff', async () => {
    const f = await oriented(friend.token);
    const sh = f.start.structuredContent as { onboarding: { pending: boolean; op?: string } };
    expect(sh.onboarding).toEqual({ pending: true, op: 'profile_update' });
    const card = await friend.rest.call<{ doc: { id: string } }>('write', { space: 'alpha-handoff', path: '_agents/friend.md', content: '# Friend\n', message: 'card', ttl_days: 2 });
    expect(expiresAt(card.doc.id)).toBeNull();
    const plain = await friend.rest.call<{ doc: { id: string } }>('write', { space: 'alpha-handoff', path: 'pine/plain.md', content: '# Plain\n', message: 'm' });
    expect((await alpha.rest.call<Inbox>('handoff_inbox')).messages.map((m) => m.id)).toEqual([plain.doc.id]);
    expect(expiresAt(plain.doc.id)).toBeNull();
    h.clock.advanceDays(15);
    expect(janitor().expired).toBe(0);
    await alpha.rest.call('handoff_ack', { id: plain.doc.id, expected_rev: 1, status: 'done' });
    expect(Math.abs(expiresAt(plain.doc.id)! - (h.clock.now() + 14 * DAY))).toBeLessThan(5000);
    h.clock.advanceDays(15);
    expect(janitor().expired).toBe(1);
    expect(expiresAt(card.doc.id)).toBeNull();
    // A folder-shaped write in a space that is not an inbox is just a document.
    const other = await w.client('alphabot').call<{ doc: { id: string } }>('write', { space: 'proj-alpha', path: 'pine/x.md', content: '# X\n', message: 'm' });
    expect(h.core.db.prepare('SELECT COUNT(*) FROM handoff_messages WHERE doc_id = ?').pluck().get(other.doc.id)).toBe(0);
  });
});

describe('cross-space isolation', () => {
  it('a principal only in another inbox space is exactly an unknown name; never suggested; hidden spaces are unknown', async () => {
    // friend (alpha-handoff) about sg (handoff only), and sg about friend and alpha.
    expect(await sendErr(friend.rest, 'oak')).toBe((await sendErr(friend.rest, 'zz')).replace('"zz"', '"oak"'));
    expect(await sendErr(friend.rest, 'oak')).toBe('handoff_send failed: invalid_input: Input is invalid: to: No agent "oak". See alpha-handoff/_agents/.');
    expect(await sendErr(friend.rest, 'oa')).not.toContain('Did you mean');
    expect(await sendErr(sg.rest, 'pine')).toBe((await sendErr(sg.rest, 'zzzz')).replace('"zzzz"', '"pine"'));
    expect(await sendErr(sg.rest, 'pin')).not.toContain('Did you mean');
    expect(await sendErr(sg.rest, 'frien')).not.toContain('Did you mean');
    // In its own space the suggestion works.
    expect(await sendErr(friend.rest, 'pin')).toContain('Did you mean pine?');
    // Naming a space you cannot see is the same as naming one that does not exist.
    expect(await sendErr(friend.rest, 'oak', { space: 'handoff' })).toBe(await sendErr(friend.rest, 'oak', { space: 'no-such-space' }));
    expect(await sendErr(sg.rest, 'pine', { space: 'alpha-handoff' })).toBe(await sendErr(sg.rest, 'pine', { space: 'no-such-space' }));
    // A space that exists and is visible but is not an inbox: the same text.
    expect(await sendErr(w.client('alphabot'), 'pine', { space: 'proj-alpha' })).toContain('space: No such inbox space.');
    expect(h.core.db.prepare('SELECT COUNT(*) FROM handoff_messages').pluck().get()).toBe(0);
  });

  it('no hint, count, list or start_here line leaks across spaces', async () => {
    await send(claude, 'oak', 'Only handoff');
    await send(sg.rest, 'alice-assistant', 'From sg');
    const fromFriend = await send(friend.rest, 'pine', 'Only alpha-handoff');

    // friend and alpha: nothing of handoff.
    for (const a of [friend, alpha]) {
      const c = await oriented(a.token);
      expect(c.startText).not.toMatch(/(^|[^-])handoff\//m);
      expect(c.startText).not.toMatch(/\boak\b|Only handoff|From sg/);
      const hint = (await c.call('whoami')).text.join('\n');
      expect(hint).not.toMatch(/Only handoff|From sg/);
      for (const box of ['in', 'out'] as const) {
        const list = await a.rest.call<Inbox>('handoff_inbox', { box, include_done: true });
        expect(list.messages.every((m) => m.space === 'alpha-handoff')).toBe(true);
      }
      expect(await a.rest.call<Inbox>('handoff_inbox', { space: 'handoff' })).toEqual(await a.rest.call<Inbox>('handoff_inbox', { space: 'no-such-space' }));
    }
    expect(await polled(friend.token)).toEqual({ waiting: 0, newest: null, answered: 0 });
    expect((await polled(alpha.token)).waiting).toBe(1);

    // sg: nothing of alpha-handoff.
    const s = await oriented(sg.token);
    expect(s.startText).not.toMatch(/alpha|pine|friend/);
    expect(lineOf((await s.call('whoami')).text, 'Inbox:')).toBe('Inbox: 1 waiting — "Only handoff" from alice-assistant. Call handoff_inbox.');
    await alpha.rest.call('handoff_ack', { id: fromFriend.message.id, expected_rev: 1, status: 'done' });
    expect(await polled(sg.token)).toMatchObject({ waiting: 1, answered: 0, newest: { space: 'handoff', from: 'alice-assistant' } });
    const sgRaw = JSON.parse((await sg.rest.raw('whoami')).text) as { handoff?: { inbox_waiting: number; outbox_answered: number } };
    expect(sgRaw.handoff).toMatchObject({ inbox_waiting: 1, outbox_answered: 0 });
    expect((await sg.rest.call<Inbox>('handoff_inbox', { box: 'out', include_done: true })).messages.map((m) => m.space)).toEqual(['handoff']);
  });
});

describe('GET /api/v1/inbox', () => {
  it('counts waiting and answered, the newest without a body; changes nothing; writes no audit row', async () => {
    expect((await poll(undefined)).status).toBe(401);
    expect(await poll('brn_' + 'x'.repeat(40))).toMatchObject({ status: 401, body: { ok: false, error: { code: 'unauthenticated' } } });
    expect(await polled(alpha.token)).toEqual({ waiting: 0, newest: null, answered: 0 });

    const s = await send(friend.rest, 'pine', 'Weekly numbers');
    const audit = () => h.core.db.prepare('SELECT COUNT(*) FROM audit').pluck().get() as number;
    const outboxSeen = () => h.core.db.prepare('SELECT outbox_seen_at FROM principals WHERE id = ?').pluck().get(friend.id);
    const before = { audit: audit(), seen: outboxSeen() };
    const p = await polled(alpha.token);
    expect(p).toEqual({
      waiting: 1,
      newest: { id: s.message.id, space: 'alpha-handoff', from: 'friend', title: 'Weekly numbers', sent_at: s.message.created_at },
      answered: 0,
    });
    await polled(alpha.token);
    await polled(friend.token);
    expect({ audit: audit(), seen: outboxSeen() }).toEqual(before);
    expect(h.core.db.prepare("SELECT COUNT(*) FROM audit WHERE op = 'inbox_poll' AND outcome = 'ok'").pluck().get()).toBe(0);
    expect((await alpha.rest.call<Inbox>('handoff_inbox')).messages[0]!.status).toBe('new');

    // received: no longer waiting; done: answered for the sender until they look at their outbox.
    await alpha.rest.call('handoff_ack', { id: s.message.id, expected_rev: 1, status: 'received' });
    expect((await polled(alpha.token)).waiting).toBe(0);
    await alpha.rest.call('handoff_ack', { id: s.message.id, expected_rev: 1, status: 'done' });
    expect(await polled(friend.token)).toEqual({ waiting: 0, newest: null, answered: 1 });
    expect(await polled(friend.token)).toEqual({ waiting: 0, newest: null, answered: 1 });
    await friend.rest.call('handoff_inbox', { box: 'out' });
    expect(await polled(friend.token)).toEqual({ waiting: 0, newest: null, answered: 0 });
    // An edit after receipt makes it wait again.
    await friend.rest.call('edit', { id: s.message.id, expected_rev: 1, edits: [{ old_text: 'Body.', new_text: 'Body 2.' }], message: 'more' });
    expect((await polled(alpha.token)).waiting).toBe(1);
  });

  it('is in openapi, /agents.md and /llms.txt', async () => {
    const api = (await (await fetch(`${h.url}/api/v1/openapi.json`, { headers: { authorization: `Bearer ${friend.token}` } })).json()) as { paths: Record<string, { get?: { operationId: string } }> };
    expect(api.paths['/api/v1/inbox']?.get?.operationId).toBe('inbox_poll');
    expect(await (await fetch(`${h.url}/agents.md`)).text()).toMatch(/GET \S+\/api\/v1\/inbox/);
    expect(await (await fetch(`${h.url}/llms.txt`)).text()).toContain('/api/v1/inbox');
  });
});

describe('GET /api/v1/inbox rate limit', () => {
  it('answers at once within the poll limit (BRAIN_RATE_POLL): over it → rate_limited, audited thinned', async () => {
    await h.close();
    h = await startHarness({ env: { BRAIN_RATE_POLL: '2' } });
    w = buildWorld(h, 'rest');
    const t = w.tokens.alphabot;
    expect((await poll(t)).status).toBe(200);
    expect((await poll(t)).status).toBe(200);
    const third = await poll(t);
    expect(third).toMatchObject({ status: 429, body: { ok: false, error: { code: 'rate_limited' } } });
    expect(h.core.db.prepare("SELECT COUNT(*) FROM audit WHERE op = 'inbox_poll' AND outcome = 'rate_limited'").pluck().get()).toBe(1);
  });
});

describe('scripts/inbox-poll.sh', () => {
  const script = path.resolve(__dirname, '../../scripts/inbox-poll.sh');
  const run = (env: Record<string, string>) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) => {
      execFile('sh', [script], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } }, (e, out, errOut) => {
        resolve({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, out, err: errOut });
      });
    });

  it('exit 1 when nothing, 0 with one line when mail, 2 on error', async () => {
    const env = { BRAIN_URL: `${h.url}/`, BRAIN_TOKEN: alpha.token };
    expect(await run(env)).toEqual({ code: 1, out: '', err: '' });
    await send(friend.rest, 'pine', 'Wake up');
    const mail = await run(env);
    expect(mail.code).toBe(0);
    expect(mail.out.trim().split('\n')).toHaveLength(1);
    expect(mail.out).toMatch(/^Brain inbox: 1 waiting, 0 answered/);
    expect((await run({ BRAIN_URL: h.url, BRAIN_TOKEN: 'brn_' + 'x'.repeat(40) })).code).toBe(2);
    expect((await run({ BRAIN_URL: h.url })).code).toBe(2);
    expect((await run({ BRAIN_URL: 'http://127.0.0.1:9', BRAIN_TOKEN: alpha.token })).code).toBe(2);
  });
});
