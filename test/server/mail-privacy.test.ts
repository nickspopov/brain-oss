// The mail read predicate. A message is readable only by its sender, its recipient and an Admin of its space (+ the
// instance superadmin). The world: handoff with alice (superadmin, admin), alice-helper, alphabot, betabot and
// alice-assistant (write each). alice-helper → alphabot is private; betabot is the unrelated member with write
// there; alice-assistant becomes the space Admin. One test per surface, then Guest, the Alpha↛Beta canary,
// revocation mid-wait and the migration preview.
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { removeGrant, setGrant } from '../../src/core/grants.js';
import { MAIL_PRIVACY } from '../../src/ops/agent/start_here.js';
import type { SpaceRow } from '../../src/store/types.js';
import type { ActivityResult, ChangesResult, ExportResult, ListResult, SearchResult } from '../helpers/api.js';
import { untar } from '../helpers/archive.js';
import { ApiError, makeClient, type Client, type RawResponse } from '../helpers/clients/index.js';
import { buildWorld, RANDOM_ID, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
let w: World;
const open: SdkClient[] = [];

afterEach(async () => {
  for (const c of open.splice(0)) await c.close().catch(() => undefined);
  await h?.close();
});

interface Msg {
  id: string;
  space: string;
  path: string;
  title: string;
  from: string;
  to: string;
  status: string;
  rev: number;
}
interface Sent {
  message: Msg;
}
interface Inbox {
  messages: Msg[];
  counts: Record<string, number>;
}

async function err(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected an error');
}

function assertNone(text: string, markers: readonly string[], where: string): void {
  const lower = text.toLowerCase();
  for (const m of markers) if (lower.includes(m.toLowerCase())) throw new Error(`leak in ${where}: ${m}`);
}

/** Status and error body (request-specific fields aside): a hidden id answers exactly like a missing one. */
const errShape = (r: RawResponse): string => {
  const body = JSON.parse(r.text) as { error?: Record<string, unknown> };
  return JSON.stringify({ status: r.status, error: body.error });
};

interface Setup {
  alice: Client;
  hermes: Client;
  alphabot: Client;
  betabot: Client;
  admin: Client;
  /** The private message alice-helper → alphabot and alphabot's reply. */
  m: Msg;
  reply: Msg;
  /** betabot's own message to alice. */
  own: Msg;
  word: string;
  markers: string[];
}

async function setup(): Promise<Setup> {
  h = await startHarness();
  w = buildWorld(h);
  const word = `zqmail${randomBytes(4).toString('hex')}`;
  const hermes = w.client('alice-helper');
  const alphabot = w.client('alphabot');
  const betabot = w.client('betabot');
  const m = (await hermes.call<Sent>('handoff_send', { to: 'alphabot', title: `Plan ${word}`, body: `The code is ${word}x.` })).message;
  const reply = (await alphabot.call<Sent>('handoff_send', { to: 'alice-helper', title: `Re ${word}`, body: `Ok ${word}y.`, reply_to: m.id })).message;
  const own = (await betabot.call<Sent>('handoff_send', { to: 'alice', title: 'Betabot note', body: 'Mine.' })).message;
  // alice-assistant: Admin of handoff (a personal space-level admin grant; not a superadmin).
  w.grant('handoff', { principal: 'alice-assistant' }, 'admin');
  return {
    alice: w.client('alice'),
    hermes,
    alphabot,
    betabot,
    admin: w.client('alice-assistant'),
    m,
    reply,
    own,
    word,
    markers: [word, m.id, reply.id, m.path.split('/').pop()!.replace('.md', '')],
  };
}

async function sameAsMissing(c: Client, op: string, hidden: Record<string, unknown>, missing: Record<string, unknown>): Promise<void> {
  const a = await c.raw(op, hidden);
  const b = await c.raw(op, missing);
  expect(a.status, op).toBe(404);
  expect(errShape(a), op).toBe(errShape(b));
}

async function download(token: string, path: string): Promise<Response> {
  return fetch(`${h.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

describe('mail read predicate: an unrelated member with write sees no one else’s mail (one test per surface)', () => {
  it('read: by id and by path → not_found, byte-identical to a missing id; sender, recipient and space Admin read it', async () => {
    const s = await setup();
    await sameAsMissing(s.betabot, 'read', { id: s.m.id }, { id: RANDOM_ID });
    await sameAsMissing(s.betabot, 'read', { space: 'handoff', path: s.m.path }, { space: 'handoff', path: 'alphabot/no-such-message.md' });
    for (const c of [s.hermes, s.alphabot, s.admin, s.alice]) {
      const r = await c.call<{ content: string }>('read', { id: s.m.id });
      expect(r.content).toContain(s.word);
    }
    // betabot reads its own message.
    expect((await s.betabot.call<{ content: string }>('read', { id: s.own.id })).content).toContain('Mine.');
  });

  it('list / tree: no message, no folder that holds only other people’s mail', async () => {
    const s = await setup();
    const raw = await s.betabot.raw<ListResult>('list', { space: 'handoff', depth: 5, include_deleted: true });
    expect(raw.status).toBe(200);
    assertNone(raw.text, s.markers, 'list');
    const paths = (raw.body as { result: ListResult }).result.entries.map((e) => e.path);
    expect(paths.some((p) => p.toLowerCase().startsWith('alphabot'))).toBe(false);
    expect(paths.some((p) => p.toLowerCase().startsWith('alice-helper'))).toBe(false);
    expect(paths).toContain('alice'); // its own message to alice
    await sameAsMissing(s.betabot, 'list', { space: 'handoff', path: 'alphabot' }, { space: 'handoff', path: 'nobody-here' });
    const adminList = await s.admin.call<ListResult>('list', { space: 'handoff', depth: 5 });
    expect(adminList.entries.map((e) => e.path)).toContain(s.m.path);
  });

  it('search: no results, snippets, counts or ranking influence from other people’s mail', async () => {
    const s = await setup();
    for (const input of [{ query: s.word }, { query: s.word, spaces: ['handoff'] }, { query: s.word, path_prefix: 'alphabot/' }, { query: 'plan' }]) {
      const raw = await s.betabot.raw<SearchResult>('search', { ...input });
      if (raw.status !== 200) throw new Error(raw.text);
      assertNone(raw.text, s.markers, `search ${JSON.stringify(input)}`);
    }
    expect((await s.betabot.call<SearchResult>('search', { query: s.word })).results).toEqual([]);
    // Ranking/count statistics come only from readable documents: the SQL filter excludes the messages.
    const { readableDocsFilter, contextForRow } = await import('../../src/core/guard.js');
    const { countRows } = await import('../../src/store/search.js');
    const ctx = contextForRow(h.core, w.principals.betabot);
    expect(countRows(h.core.db, readableDocsFilter(ctx), s.word)).toBe(0);
    expect(countRows(h.core.db, readableDocsFilter(contextForRow(h.core, w.principals['alice-assistant'])), s.word)).toBe(2);
    expect((await s.admin.call<SearchResult>('search', { query: s.word })).results.length).toBe(2);
    expect((await s.alphabot.call<SearchResult>('search', { query: s.word })).results.length).toBe(2);
  });

  it('activity / feed: no revision of other people’s messages (also filtered by author)', async () => {
    const s = await setup();
    for (const base of [{}, { space: 'handoff' }, { author: 'alice-helper' }, { author: 'alphabot', space: 'handoff' }]) {
      for (const input of [base, { ...base, include_messages: true }]) {
        const raw = await s.betabot.raw<ActivityResult>('activity', input);
        expect(raw.status).toBe(200);
        assertNone(raw.text, s.markers, `activity ${JSON.stringify(input)}`);
      }
    }
    // Messages live in the Inbox; the feed lists them only when asked.
    expect((await s.betabot.call<ActivityResult>('activity', { space: 'handoff', include_messages: true })).items.map((i) => i.doc.id)).toEqual([s.own.id]);
    expect((await s.betabot.call<ActivityResult>('activity', { space: 'handoff' })).items.map((i) => i.doc.id)).toEqual([]);
    expect((await s.admin.call<ActivityResult>('activity', { space: 'handoff', include_messages: true })).items.map((i) => i.doc.id)).toContain(s.m.id);
    expect((await s.admin.call<ActivityResult>('activity', { space: 'handoff' })).items.map((i) => i.doc.id)).not.toContain(s.m.id);
  });

  it('changes: no change of other people’s messages, with or without own changes', async () => {
    const s = await setup();
    for (const input of [{}, { include_own: true }, { spaces: ['handoff'], include_own: true }]) {
      const raw = await s.betabot.raw<ChangesResult>('changes', input);
      expect(raw.status).toBe(200);
      assertNone(raw.text, s.markers, `changes ${JSON.stringify(input)}`);
    }
    expect((await s.admin.call<ChangesResult>('changes', { include_own: true })).changes.map((c) => c.doc.id)).toContain(s.m.id);
  });

  it('history and diff: not_found like a missing id', async () => {
    const s = await setup();
    await sameAsMissing(s.betabot, 'history', { id: s.m.id }, { id: RANDOM_ID });
    await sameAsMissing(s.betabot, 'diff', { id: s.m.id, from: 1 }, { id: RANDOM_ID, from: 1 });
    await sameAsMissing(s.betabot, 'history', { space: 'handoff', path: s.m.path }, { space: 'handoff', path: 'alphabot/none.md' });
    expect((await s.admin.call<{ revisions: unknown[] }>('history', { id: s.m.id })).revisions.length).toBe(1);
  });

  it('export (head) by a non-admin excludes other people’s mail; full needs Admin; a later download re-checks', async () => {
    const s = await setup();
    const mine = await s.betabot.call<ExportResult>('export', { space: 'handoff', mode: 'head' });
    const res = await download(w.tokens.betabot, mine.download_path);
    expect(res.status).toBe(200);
    const files = await untar(new Uint8Array(await res.arrayBuffer()));
    const all = Object.entries(files).map(([k, v]) => `${k}\n${v}`).join('\n');
    assertNone(all, s.markers, 'export head');
    expect(all).toContain('Mine.');
    expect((await err(s.betabot.call('export', { space: 'handoff', mode: 'full' }))).code).toBe('forbidden');
    // The space Admin's export holds the messages; after the Admin role is gone the download is refused.
    const adm = await s.admin.call<ExportResult>('export', { space: 'handoff', mode: 'head' });
    w.grant('handoff', { principal: 'alice-assistant' }, 'write');
    const later = await download(w.tokens['alice-assistant'], adm.download_path);
    expect(later.status).not.toBe(200);
    assertNone(await later.text(), s.markers, 'export download after demotion');
    w.grant('handoff', { principal: 'alice-assistant' }, 'admin');
    const full = await s.admin.call<ExportResult>('export', { space: 'handoff', mode: 'full' });
    const fres = await download(w.tokens['alice-assistant'], full.download_path);
    expect(fres.status).toBe(200);
    expect(Object.values(await untar(new Uint8Array(await fres.arrayBuffer()))).join('\n')).toContain(s.word);
  });

  it('explain / view as: a message is "none" by the mail rule for the unrelated member, by id and by path', async () => {
    const s = await setup();
    type Explain = { spaces: { space: string; role: string; target?: { role: string; level: string } }[] };
    const byId = await s.alice.call<Explain>('admin_access_explain', { principal: 'betabot', space: 'handoff', doc_id: s.m.id });
    expect(byId.spaces[0]).toMatchObject({ role: 'write', target: { role: 'none', level: 'mail' } });
    const byPath = await s.alice.call<Explain>('admin_access_explain', { principal: 'betabot', space: 'handoff', path: s.m.path });
    expect(byPath.spaces[0]!.target).toMatchObject({ role: 'none', level: 'mail' });
    const asAdmin = await s.alice.call<Explain>('admin_access_explain', { principal: 'alice-assistant', space: 'handoff', doc_id: s.m.id });
    expect(asAdmin.spaces[0]!.target!.role).toBe('admin');
    const asRecipient = await s.alice.call<Explain>('admin_access_explain', { principal: 'alphabot', space: 'handoff', doc_id: s.m.id });
    expect(asRecipient.spaces[0]!.target!.role).toBe('write');
    // Explaining changes nothing: the message is still new for alphabot.
    expect((await s.alphabot.call<Inbox>('handoff_inbox')).messages.find((x) => x.id === s.m.id)?.status).toBe('new');
  });

  it('start_here: inbox counts and newest cover only own mail; the privacy line is there', async () => {
    const s = await setup();
    const raw = await s.betabot.raw('start_here', {});
    assertNone(raw.text, s.markers, 'start_here');
    type Start = { spaces: { slug: string; inbox?: { total: number; waiting?: number; outbox?: { open: number } } }[]; mail?: string[] };
    const st = (raw.body as { result: Start }).result;
    const hb = st.spaces.find((x) => x.slug === 'handoff')!;
    expect(hb.inbox).toMatchObject({ total: 0, waiting: 0, outbox: { open: 1 } });
    expect(st.mail).toContain(MAIL_PRIVACY);
    const mcpText = await (w.client('betabot', 'mcp')).raw('start_here', {});
    assertNone(mcpText.text, s.markers, 'start_here mcp');
    expect(mcpText.text).toContain(MAIL_PRIVACY);
  });

  it('hints / subscriptions: no hint, summary or poll count about other people’s mail (REST, MCP, GET /inbox)', async () => {
    const s = await setup();
    for (const adapter of ['rest', 'mcp'] as const) {
      const r = await w.client('betabot', adapter).raw('whoami', {});
      assertNone(r.text, s.markers, `hint ${adapter}`);
      expect(r.text).not.toContain('Inbox:');
    }
    const res = await fetch(`${h.url}/api/v1/inbox`, { headers: { authorization: `Bearer ${w.tokens.betabot}` } });
    const body = (await res.json()) as { waiting: number; newest: unknown; answered: number };
    expect(body).toMatchObject({ waiting: 0, newest: null, answered: 0 });
    // Positive control: the recipient gets the hint.
    expect((await w.client('alphabot', 'mcp').raw('whoami', {})).text).toContain('Inbox: 1 waiting');
  });

  it('handoff_inbox / outbox: only own mail; a human non-admin member’s "all" page is only own mail too', async () => {
    const s = await setup();
    for (const input of [{}, { box: 'out' }, { include_done: true }, { box: 'out', include_done: true }, { space: 'handoff', include_done: true }]) {
      const raw = await s.betabot.raw('handoff_inbox', input);
      expect(raw.status).toBe(200);
      assertNone(raw.text, s.markers, `handoff_inbox ${JSON.stringify(input)}`);
    }
    // A human with write in handoff (the screenshot-74 case): "all" no longer shows others' mail.
    const { createPrincipal } = await import('../../src/core/principals.js');
    const { issueToken } = await import('../../src/core/tokens.js');
    const ol = createPrincipal(h.core, { name: 'bob', kind: 'human', trust: 'trusted' }, w.principals.alice.id);
    setGrant(h.core, { spaceId: w.spaces.handoff.id, scope: 'space', pathPrefix: null, docId: null, role: 'write', subjectType: 'principal', subjectId: ol.id }, w.principals.alice.id);
    const olc = makeClient('rest', h, issueToken(h.core, ol.id, { label: 'o', createdBy: w.principals.alice.id }).token);
    const allRaw = await olc.raw<Inbox>('handoff_inbox', { box: 'all', include_done: true });
    assertNone(allRaw.text, s.markers, 'bob all');
    expect((allRaw.body as { result: Inbox }).result.messages).toEqual([]);
    // The superadmin and the space Admin see every message.
    expect((await s.alice.call<Inbox>('handoff_inbox', { box: 'all', include_done: true })).messages.map((x) => x.id)).toEqual(expect.arrayContaining([s.m.id, s.reply.id, s.own.id]));
  });

  it('handoff_wait: other people’s mail wakes no one else; the parked member answers no_mail without data', async () => {
    const s = await setup();
    const untilIso = new Date(h.clock.now() + 1500).toISOString();
    const t0 = performance.now();
    const parked = s.betabot.raw('handoff_wait', { until: untilIso });
    await new Promise((r) => setTimeout(r, 150));
    expect(h.core.waiters.size).toBe(1);
    await s.hermes.call('handoff_send', { to: 'alphabot', title: `Again ${s.word}`, body: 'b' });
    const r = await parked;
    expect(performance.now() - t0).toBeGreaterThan(1000); // not woken by others' mail
    assertNone(r.text, s.markers, 'handoff_wait');
    expect((r.body as { result: { status: string; newest: unknown } }).result).toMatchObject({ newest: null });
  });

  it('thread counts: participants and the Admin see the thread; the unrelated member gets not_found on every message of it', async () => {
    const s = await setup();
    type Read = { handoff: { thread: { id: string }[] } };
    expect((await s.alphabot.call<Read>('read', { id: s.m.id })).handoff.thread.map((t) => t.id)).toEqual([s.reply.id]);
    expect((await s.admin.call<Read>('read', { id: s.reply.id })).handoff.thread.map((t) => t.id)).toEqual([s.m.id]);
    await sameAsMissing(s.betabot, 'read', { id: s.reply.id }, { id: RANDOM_ID });
    // betabot's own message's thread does not count others' messages.
    expect((await s.betabot.call<Read>('read', { id: s.own.id })).handoff.thread).toEqual([]);
  });

  it('errors: every write/ack/reply on another person’s message is not_found, never forbidden', async () => {
    const s = await setup();
    const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ['handoff_ack', { id: s.m.id, expected_rev: 1, status: 'received' }, { id: RANDOM_ID, expected_rev: 1, status: 'received' }],
      ['handoff_send', { to: 'alphabot', title: 't', body: 'b', reply_to: s.m.id }, { to: 'alphabot', title: 't', body: 'b', reply_to: RANDOM_ID }],
      ['edit', { id: s.m.id, expected_rev: 1, edits: [{ old_text: 'The', new_text: 'A' }], message: 'm' }, { id: RANDOM_ID, expected_rev: 1, edits: [{ old_text: 'The', new_text: 'A' }], message: 'm' }],
      ['delete', { id: s.m.id, expected_rev: 1 }, { id: RANDOM_ID, expected_rev: 1 }],
      ['move', { id: s.m.id, to_path: 'x/y.md', expected_rev: 1 }, { id: RANDOM_ID, to_path: 'x/y.md', expected_rev: 1 }],
      ['revert', { id: s.m.id, to_rev: 1, expected_rev: 1, message: 'm' }, { id: RANDOM_ID, to_rev: 1, expected_rev: 1, message: 'm' }],
    ];
    for (const [op, hidden, missing] of cases) await sameAsMissing(s.betabot, op, hidden, missing);
    // Overwriting it by path is not_found too (no "exists" leak), and the message is unchanged.
    const ow = await s.betabot.raw('write', { space: 'handoff', path: s.m.path, content: 'x', expected_rev: 1, message: 'm' });
    expect(ow.status).toBe(404);
    expect((await s.alphabot.call<{ content: string }>('read', { id: s.m.id })).content).toContain(s.word);
  });

  it('idempotency replay: a stored response is not replayed once the caller can no longer read the message', async () => {
    const s = await setup();
    const input = { space: 'handoff', path: s.m.path, content: `# Plan ${s.word}\n\nEdited by the admin.\n`, expected_rev: 1, message: 'm', request_id: 'rq-mail-1' };
    const first = await s.admin.raw('write', input);
    expect(first.status).toBe(200);
    expect((await s.admin.raw('write', input)).status).toBe(200); // replay while still Admin
    w.grant('handoff', { principal: 'alice-assistant' }, 'write');
    const again = await s.admin.raw('write', input);
    expect(again.status).toBe(404);
    assertNone(again.text, s.markers, 'replay');
  });
});

// --- Guest ---------------------------------------------------------------------------------------------

async function mcpTools(token: string): Promise<string[]> {
  const transport = new StreamableHTTPClientTransport(new URL(`${h.url}/mcp/v1`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const c = new SdkClient({ name: 'brain-test', version: '0.0.0' });
  await c.connect(transport);
  open.push(c);
  return (await c.listTools()).tools.map((t) => t.name).sort();
}

async function guest(s: Setup): Promise<{ g: Client; token: string }> {
  await s.alice.call('admin_principal_create', { name: 'guesty', kind: 'agent', trust: 'trusted' });
  await s.alice.call('admin_grant_set', { space: 'handoff', scope: 'space', subject: { type: 'principal', name: 'guesty' }, role: 'guest' });
  const { token } = await s.alice.call<{ token: string }>('admin_token_issue', { principal: 'guesty', label: 'g' });
  return { g: makeClient('rest', h, token), token };
}

describe('Guest: messaging membership only', () => {
  it('sends to and receives from members, reads only its own mail, sees no documents, tree, cards or other mail', async () => {
    const s = await setup();
    await s.alice.call('write', { space: 'handoff', path: 'AGENTS.md', content: '# Rules\n', expected_rev: 0, message: 'm' });
    const card = await s.betabot.call<{ doc: { id: string } }>('write', { space: 'handoff', path: '_agents/betabot.md', content: '# betabot\n', expected_rev: 0, message: 'm' });
    // A pure Guest: the fixture's ambient all-agents read on recipes (another space) is removed.
    const allAgents = h.core.db.prepare("SELECT id FROM groups WHERE name = 'all-agents'").pluck().get() as string;
    removeGrant(h.core, { spaceId: w.spaces.recipes.id, scope: 'space', subjectType: 'group', subjectId: allAgents });
    const { g, token } = await guest(s);
    const out = (await g.call<Sent>('handoff_send', { to: 'alphabot', title: 'Hello from guest', body: 'Hi.' })).message;
    expect(out).toMatchObject({ from: 'guesty', to: 'alphabot', space: 'handoff' });
    const back = (await s.alphabot.call<Sent>('handoff_send', { to: 'guesty', title: 'Hi guest', body: 'Back.', reply_to: out.id })).message;
    expect((await g.call<{ content: string }>('read', { id: back.id })).content).toContain('Back.');
    expect((await g.call<{ content: string }>('read', { id: out.id })).content).toContain('Hi.');
    expect((await g.call<Inbox>('handoff_inbox', {})).messages.map((x) => x.id)).toEqual([back.id]);
    await g.call('handoff_ack', { id: back.id, expected_rev: 1, status: 'done' });
    // Nothing else.
    for (const [op, hidden, missing] of [
      ['read', { id: s.m.id }, { id: RANDOM_ID }],
      ['read', { id: card.doc.id }, { id: RANDOM_ID }],
      ['read', { space: 'handoff', path: 'AGENTS.md' }, { space: 'no-such-space', path: 'AGENTS.md' }],
      ['list', { space: 'handoff' }, { space: 'no-such-space' }],
    ] as [string, Record<string, unknown>, Record<string, unknown>][]) {
      await sameAsMissing(g, op, hidden, missing);
    }
    expect((await g.call<SearchResult>('search', { query: s.word })).results).toEqual([]);
    expect((await g.call<SearchResult>('search', { query: 'rules' })).results).toEqual([]);
    expect((await g.call<{ spaces: unknown[] }>('list', {})).spaces).toEqual([]);
    expect((await err(g.call('write', { space: 'handoff', path: 'notes/x.md', content: 'x', message: 'm' }))).code).toBe('not_found');
    for (const input of [{}, { space: 'handoff' }, { author: 'alice-helper' }]) assertNone((await g.raw('activity', input)).text, s.markers, 'guest activity');
    assertNone((await g.raw('changes', { include_own: true })).text, s.markers, 'guest changes');
    // start_here: the space as guest, no documents step, no card onboarding (the profile step), the privacy line.
    type Start = { spaces: { slug: string; role: string; instructions: string | null; inbox?: unknown }[]; next_steps: string[]; onboarding: { pending: boolean }; mail?: string[]; capabilities: string[] };
    const st = await g.call<Start>('start_here', {});
    expect(st.spaces.map((x) => [x.slug, x.role, x.instructions])).toEqual([['handoff', 'guest', null]]);
    expect(st.next_steps.join(' ')).not.toContain('search and list');
    // No card onboarding; a Guest is asked for its profile like everyone.
    expect(st.onboarding).toEqual({ pending: true, op: 'profile_update' });
    expect(st.next_steps.join(' ')).not.toContain('_agents/');
    expect(st.capabilities).toEqual([]);
    expect(st.mail).toContain(MAIL_PRIVACY);
    // Tool list: the handoff tools, read, start_here, whoami.
    expect(await mcpTools(token)).toEqual(['handoff_ack', 'handoff_inbox', 'handoff_send', 'handoff_wait', 'profile_get', 'profile_update', 'read', 'start_here', 'whoami']);
  });

  it('sees only the minimal identity of whom it can message (handoff_recipients); members can message it', async () => {
    const s = await setup();
    const { g } = await guest(s);
    type R = { recipients: { name: string; manager: string | null; owner_label: string | null; spaces: string[] }[] };
    const r = await g.call<R>('handoff_recipients', {});
    expect(r.recipients.map((x) => x.name)).toEqual(['alice', 'alice-assistant', 'alice-helper', 'alphabot', 'betabot']);
    for (const x of r.recipients) expect(x).toMatchObject({ manager: null, owner_label: null, spaces: ['handoff'] });
    // A member sees the guest as a recipient (with its manager when it has one).
    expect((await s.betabot.call<R>('handoff_recipients', {})).recipients.map((x) => x.name)).toContain('guesty');
  });

  it('is a personal membership of a whole inbox space: path, group and non-inbox grants are refused; explain shows guest', async () => {
    const s = await setup();
    await s.alice.call('admin_principal_create', { name: 'guesty', kind: 'agent', trust: 'trusted' });
    const bad = [
      { space: 'handoff', scope: 'path', path_prefix: 'x/', subject: { type: 'principal', name: 'guesty' }, role: 'guest' },
      { space: 'handoff', scope: 'space', subject: { type: 'group', name: 'curators' }, role: 'guest' },
      { space: 'shared', scope: 'space', subject: { type: 'principal', name: 'guesty' }, role: 'guest' },
    ];
    for (const b of bad) expect((await err(s.alice.call('admin_grant_set', b))).code).toBe('invalid_input');
    await s.alice.call('admin_grant_set', { space: 'handoff', scope: 'space', subject: { type: 'principal', name: 'guesty' }, role: 'guest' });
    type Explain = { spaces: { space: string; visible: boolean; role: string }[] };
    const e = await s.alice.call<Explain>('admin_access_explain', { principal: 'guesty', space: 'handoff' });
    expect(e.spaces[0]).toMatchObject({ visible: false, role: 'none' });
    // The database refuses a path guest too (migration 0009 CHECK).
    expect(() =>
      h.core.db
        .prepare("INSERT INTO grants (id, space_id, scope, path_prefix, subject_type, subject_id, role, granted_at) VALUES ('g1', ?, 'path', 'x/', 'principal', ?, 'guest', 1)")
        .run(w.spaces.handoff.id, w.principals.betabot.id),
    ).toThrow(/CHECK/);
  });

  it('an external in an inbox space is message-only, whatever its grant there', async () => {
    const s = await setup();
    await s.alice.call('admin_principal_create', { name: 'friend-bot', kind: 'agent', trust: 'limited', external: true, owner_label: 'Erin' });
    await s.alice.call('admin_grant_set', { space: 'handoff', scope: 'space', subject: { type: 'principal', name: 'friend-bot' }, role: 'write' });
    const { token } = await s.alice.call<{ token: string }>('admin_token_issue', { principal: 'friend-bot', label: 'f' });
    const f = makeClient('rest', h, token);
    const sent = (await f.call<Sent>('handoff_send', { to: 'alphabot', title: 'Hi', body: 'x' })).message;
    expect(sent.from).toBe('friend-bot');
    await sameAsMissing(f, 'read', { id: s.m.id }, { id: RANDOM_ID });
    expect((await f.call<{ spaces: { slug: string; role: string }[] }>('start_here', {})).spaces).toEqual([expect.objectContaining({ slug: 'handoff', role: 'read' })]);
  });
});

// --- Alpha ↛ Beta canary -----------------------------------------------------------------------------

describe('Alpha ↛ Beta canary (names, recipient suggestions, counts, errors)', () => {
  it('betabot learns nothing of alphabot’s mail: not in a shared space, and not across spaces', async () => {
    const s = await setup();
    const core = h.core;
    // The owner's isolation setup: alphabot leaves handoff, works in its own inbox space alpha-handoff.
    removeGrant(core, { spaceId: w.spaces.handoff.id, scope: 'space', subjectType: 'principal', subjectId: w.principals.alphabot.id });
    await s.alice.call('admin_space_create', { slug: 'alpha-handoff', name: 'Alpha inbox', inbox: true });
    const alphaBox = core.db.prepare("SELECT * FROM spaces WHERE slug = 'alpha-handoff'").get() as SpaceRow;
    setGrant(core, { spaceId: alphaBox.id, scope: 'space', pathPrefix: null, docId: null, role: 'write', subjectType: 'principal', subjectId: w.principals.alphabot.id }, w.principals.alice.id);
    const pollBefore = await (await fetch(`${h.url}/api/v1/inbox`, { headers: { authorization: `Bearer ${w.tokens.betabot}` } })).json();
    const fm = (await s.alphabot.call<Sent>('handoff_send', { to: 'alice', title: `Alpha ${s.word}`, body: `zqalpha ${s.word}`, space: 'alpha-handoff' })).message;
    const tf = (await s.alice.call<Sent>('handoff_send', { to: 'alphabot', title: `To alpha ${s.word}`, body: 'b', space: 'alpha-handoff' })).message;
    const markers = [...s.markers, fm.id, tf.id, 'alpha-handoff', alphaBox.id, w.principals.alphabot.id];
    const betabot = s.betabot;
    const texts: [string, RawResponse][] = [
      ['recipients', await betabot.raw('handoff_recipients', {})],
      ['start_here', await betabot.raw('start_here', {})],
      ['spaces', await betabot.raw('spaces', {})],
      ['list', await betabot.raw('list', {})],
      ['search', await betabot.raw('search', { query: s.word })],
      ['inbox', await betabot.raw('handoff_inbox', { include_done: true })],
      ['outbox', await betabot.raw('handoff_inbox', { box: 'out', include_done: true })],
      ['activity', await betabot.raw('activity', {})],
      ['changes', await betabot.raw('changes', { include_own: true })],
      ['mcp start_here', await w.client('betabot', 'mcp').raw('start_here', {})],
      ['mcp whoami', await w.client('betabot', 'mcp').raw('whoami', {})],
    ];
    for (const [where, r] of texts) assertNone(r.text, markers, where);
    // Names: alphabot is in no space of betabot's now; recipient suggestions never name it.
    type R = { recipients: { name: string }[] };
    expect((await betabot.call<R>('handoff_recipients', {})).recipients.map((x) => x.name)).not.toContain('alphabot');
    const e1 = await err(betabot.call('handoff_send', { to: 'alphabotr', title: 't', body: 'b' }));
    expect(e1.message).not.toMatch(/Did you mean/);
    const e2 = await err(betabot.call('handoff_send', { to: 'alphabot', title: 't', body: 'b' }));
    const e3 = await err(betabot.call('handoff_send', { to: 'qqqqqq', title: 't', body: 'b' }));
    expect(e2.message).toBe(e3.message.replace('qqqqqq', 'alphabot'));
    // Errors on alpha ids and the alpha space: identical to missing ones.
    await sameAsMissing(betabot, 'read', { id: fm.id }, { id: RANDOM_ID });
    await sameAsMissing(betabot, 'handoff_ack', { id: tf.id, expected_rev: 1, status: 'received' }, { id: RANDOM_ID, expected_rev: 1, status: 'received' });
    const sp1 = await betabot.raw('handoff_send', { to: 'alice', title: 't', body: 'b', space: 'alpha-handoff' });
    const sp2 = await betabot.raw('handoff_send', { to: 'alice', title: 't', body: 'b', space: 'no-such-space' });
    expect(errShape(sp1)).toBe(errShape(sp2));
    // Counts: betabot's poll is unchanged by alpha mail.
    const pollAfter = (await (await fetch(`${h.url}/api/v1/inbox`, { headers: { authorization: `Bearer ${w.tokens.betabot}` } })).json()) as Record<string, unknown>;
    // server_time moves; next_cursor is sealed with a fresh nonce on every answer (it reveals nothing).
    for (const k of ['server_time', 'next_cursor']) {
      delete pollAfter[k];
      delete (pollBefore as Record<string, unknown>)[k];
    }
    expect(pollAfter).toEqual(pollBefore);
    // And the old hermes → alphabot message in handoff stays invisible to betabot after alphabot left.
    await sameAsMissing(betabot, 'read', { id: s.m.id }, { id: RANDOM_ID });
  });
});

// --- Revocation mid-wait ------------------------------------------------------------------------------

describe('revocation mid-handoff_wait', () => {
  it('a member removed while parked is woken by its old message changing but gets no data of it', async () => {
    const s = await setup();
    await s.alphabot.call('handoff_ack', { id: s.m.id, expected_rev: 1, status: 'received' });
    await s.hermes.call('handoff_ack', { id: s.reply.id, expected_rev: 1, status: 'received' });
    const untilIso = new Date(h.clock.now() + 1500).toISOString();
    const parked = s.alphabot.raw('handoff_wait', { until: untilIso });
    await new Promise((r) => setTimeout(r, 150));
    expect(h.core.waiters.size).toBe(1);
    // Revoke alphabot's membership, then the sender changes the message (this wakes the recipient id).
    setGrant(h.core, { spaceId: w.spaces.handoff.id, scope: 'space', pathPrefix: null, docId: null, role: 'none', subjectType: 'principal', subjectId: w.principals.alphabot.id }, w.principals.alice.id);
    await s.hermes.call('write', { space: 'handoff', path: s.m.path, content: `# Plan ${s.word}\n\nChanged ${s.word}z.\n`, expected_rev: 1, message: 'm' });
    const r = await parked;
    expect(r.status).toBe(200);
    assertNone(r.text, s.markers, 'wait after revocation');
    expect((r.body as { result: { waiting: number; newest: unknown } }).result).toMatchObject({ waiting: 0, newest: null });
    // The poll too.
    const p = (await (await fetch(`${h.url}/api/v1/inbox`, { headers: { authorization: `Bearer ${w.tokens.alphabot}` } })).json()) as { waiting: number; newest: unknown };
    expect(p).toMatchObject({ waiting: 0, newest: null });
  });
});
