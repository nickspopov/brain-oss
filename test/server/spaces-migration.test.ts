// `brain migrate-spaces` re-homes an inbox
// space into its project space. A real-like pair on the test world: proj-alpha (alphabot writes; alice-assistant
// is its Admin) and proj-alpha-inbox (alphabot, alice-helper — inbox only —, the external friend-bot and alice
// as members) with a thread, receipts, a done, a declined, a pending message, a request id and an agent
// card. Preview first (counts, mapping, blocks, no writes), then apply: ids, revisions, envelopes,
// receipts, request-id rows and cursors identical; old slug/paths resolve as aliases with authorization
// at the destination; collisions roll every pair back; old MCP clients keep sending, reading, acking
// and waiting across it; the new Guest sees only its own mail; Alpha↛Beta still holds.
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { setGrant } from '../../src/core/grants.js';
import { applySpacesMigration, parsePair, previewSpacesMigration, renderSpacesMigration, type SpacePair } from '../../src/core/spacesmigrate.js';
import type { SpaceRow } from '../../src/store/types.js';
import type { ChangesResult, SearchResult } from '../helpers/api.js';
import { ApiError, makeClient, type Client } from '../helpers/clients/index.js';
import { buildWorld, seedBeta, type World } from '../helpers/fixtures.js';
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
  canonical_space: string;
  path: string;
  title: string;
  from: string;
  to: string;
  status: string;
  rev: number;
  thread_id: string;
  reply_to: string | null;
  received_at: string | null;
}
interface Sent {
  message: Msg;
}
interface Inbox {
  messages: Msg[];
  counts: Record<string, number>;
  canonical_space?: string | null;
}

const PAIR: SpacePair = { project: 'proj-alpha', inbox: 'proj-alpha-inbox' };

async function err(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected an error');
}

const space = (slug: string): SpaceRow => h.core.db.prepare('SELECT * FROM spaces WHERE slug = ?').get(slug) as SpaceRow;

function grant(slug: string, subjectId: string, role: 'guest' | 'read' | 'propose' | 'write' | 'admin' | 'none', pathPrefix: string | null = null): void {
  setGrant(
    h.core,
    { spaceId: space(slug).id, scope: pathPrefix === null ? 'space' : 'path', pathPrefix, docId: null, role, subjectType: 'principal', subjectId },
    w.principals.alice.id,
  );
}

async function mcp(token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${h.url}/mcp/v1`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const c = new SdkClient({ name: 'brain-old-client', version: '0.0.0' });
  await c.connect(transport);
  open.push(c);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name, arguments: args })) as CallToolResult;
    return { r, text: r.content.map((x) => (x.type === 'text' ? x.text : '')).join('\n'), data: r.structuredContent as Record<string, unknown> | undefined };
  };
}

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
};

interface Setup {
  alice: Client;
  alphabot: Client;
  hermes: Client;
  claude: Client;
  betabot: Client;
  friend: Client;
  friendToken: string;
  /** hermes → alphabot (received by alphabot; sent with request id rid-a). */
  a: Msg;
  /** alphabot → hermes, reply to a, done by hermes. */
  b: Msg;
  /** friend → alphabot, pending. */
  c: Msg;
  /** alphabot → friend, declined by friend. */
  d: Msg;
  /** alice → alphabot, pending. */
  e: Msg;
  card: string;
  readme: string;
  word: string;
  /** alphabot's changes cursor after everything above. */
  cursor: string;
}

async function setup(): Promise<Setup> {
  h = await startHarness();
  w = buildWorld(h);
  const alice = makeClient('rest', h, w.tokens.alice);
  await alice.call('admin_space_create', { slug: 'proj-alpha-inbox', name: 'Alpha inbox', inbox: true, ttl_days: 30 });
  const created = await alice.call<{ principal: { id: string } }>('admin_principal_create', { name: 'friend-bot', kind: 'agent', trust: 'limited', external: true, owner_label: 'Erin' });
  const friendToken = (await alice.call<{ token: string }>('admin_token_issue', { principal: 'friend-bot', label: 'friend' })).token;
  grant('proj-alpha-inbox', w.principals.alphabot.id, 'write');
  grant('proj-alpha-inbox', w.principals['alice-helper'].id, 'write');
  grant('proj-alpha-inbox', created.principal.id, 'write');
  grant('proj-alpha-inbox', w.principals.alice.id, 'admin');
  grant('proj-alpha', w.principals['alice-assistant'].id, 'admin');
  const alphabot = w.client('alphabot');
  const hermes = w.client('alice-helper');
  const friend = makeClient('rest', h, friendToken);
  const word = 'zebraalphaword';
  const readme = (await alphabot.call<{ doc: { id: string } }>('write', { space: 'proj-alpha', path: 'README.md', content: `# Alpha\n\nProject ${word}.\n`, expected_rev: 0, message: 'readme' })).doc.id;
  const card = (await alphabot.call<{ doc: { id: string } }>('write', { space: 'proj-alpha-inbox', path: '_agents/alphabot.md', content: '# alphabot\n\nAlpha agent.\n', expected_rev: 0, message: 'card' })).doc.id;
  const a = (await hermes.call<Sent>('handoff_send', { to: 'alphabot', title: 'Spec review', body: `Please review ${word}.`, space: 'proj-alpha-inbox', request_id: 'rid-a-spec-review' })).message;
  await alphabot.call('handoff_ack', { id: a.id, expected_rev: a.rev, status: 'received' });
  const b = (await alphabot.call<Sent>('handoff_send', { to: 'alice-helper', title: 'Re: Spec review', body: 'Done, two comments.', reply_to: a.id })).message;
  await hermes.call('handoff_ack', { id: b.id, expected_rev: b.rev, status: 'done', note: 'thanks' });
  const c = (await friend.call<Sent>('handoff_send', { to: 'alphabot', title: 'Customer refund', body: 'Refund policy?', space: 'proj-alpha-inbox' })).message;
  const d = (await alphabot.call<Sent>('handoff_send', { to: 'friend-bot', title: 'Invoice question', body: 'Which invoice?', space: 'proj-alpha-inbox' })).message;
  await friend.call('handoff_ack', { id: d.id, expected_rev: d.rev, status: 'declined', note: 'not mine' });
  const e = (await alice.call<Sent>('handoff_send', { to: 'alphabot', title: 'Payout keys', body: 'Use test keys.', space: 'proj-alpha-inbox' })).message;
  const cursor = (await alphabot.call<ChangesResult>('changes', { include_own: true, limit: 500 })).cursor;
  return { alice, alphabot, hermes, claude: w.client('alice-assistant'), betabot: w.client('betabot'), friend, friendToken, a, b, c, d, e, card, readme, word, cursor };
}

/** Everything the migration must not change (besides documents.space_id), as rows. */
function frozen(s: Setup): Record<string, unknown> {
  const ids = [s.a.id, s.b.id, s.c.id, s.d.id, s.e.id, s.card];
  const inIds = `(${ids.map(() => '?').join(', ')})`;
  const db = h.core.db;
  return {
    documents: db
      .prepare(`SELECT num, id, path, path_key, title, head_rev, head_seq, content_hash, size, created_at, created_by, updated_at, updated_by, deleted_at, expires_at FROM documents WHERE id IN ${inIds} ORDER BY id`)
      .all(...ids),
    revisions: db.prepare(`SELECT * FROM revisions WHERE doc_id IN ${inIds} ORDER BY seq`).all(...ids),
    envelopes: db.prepare('SELECT * FROM handoff_messages ORDER BY doc_id').all(),
    idempotency: db.prepare('SELECT * FROM idempotency ORDER BY principal_id, request_id').all(),
    cursors: db.prepare('SELECT * FROM cursors ORDER BY principal_id').all(),
    principals: db.prepare('SELECT id, outbox_seen_at, last_start_here_at FROM principals ORDER BY id').all(),
    maxSeq: db.prepare('SELECT max(seq) AS s FROM revisions').get(),
  };
}

/** What each party sees in its boxes (ids and statuses). */
async function boxes(s: Setup): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [name, c] of Object.entries({ alphabot: s.alphabot, hermes: s.hermes, friend: s.friend, alice: s.alice })) {
    for (const box of ['in', 'out'] as const) {
      const r = await c.call<Inbox>('handoff_inbox', { box, include_done: true });
      out[`${name}:${box}`] = r.messages.map((m) => `${m.id}:${m.status}:${m.rev}:${m.received_at ?? '-'}`).sort();
    }
  }
  return out;
}

describe('migrate-spaces preview', () => {
  it('counts, effective permissions per member, gains oversight blocks until accepted; writes nothing', async () => {
    const s = await setup();
    const before = frozen(s);
    const spacesBefore = h.core.db.prepare('SELECT * FROM spaces ORDER BY id').all();
    const grantsBefore = h.core.db.prepare('SELECT * FROM grants ORDER BY id').all();
    const p = previewSpacesMigration(h.core, [PAIR]);
    expect(p.dry_run).toBe(true);
    const pair = p.pairs[0]!;
    expect(pair.counts).toMatchObject({ messages: 5, pending: 2, received: 1, done: 1, declined: 1, agent_cards: 1, live_documents: 6, documents: 6 });
    expect(pair.mail_folders).toEqual(['alice', 'alice-assistant', 'alice-helper', 'alphabot', 'friend-bot']);
    const m = Object.fromEntries(pair.members.map((x) => [x.name, x]));
    // Inbox-only member → Guest of the project (never Editor).
    expect(m['alice-helper']).toMatchObject({ inbox_role: 'editor', project_before: 'none', project_after: 'guest', grant_added: 'guest', own_mail: 2, mail_after: 2 });
    expect(m['alice-helper']!.flags).toContain('becomes_guest');
    // The external → Guest; alphabot keeps Editor (its own membership).
    expect(m['friend-bot']).toMatchObject({ external: true, project_after: 'guest', grant_added: 'guest', own_mail: 2 });
    expect(m.alphabot).toMatchObject({ inbox_role: 'editor', project_before: 'editor', project_after: 'editor', grant_added: null, own_mail: 5, mail_after: 5 });
    // The project Admin gains oversight of historic mail: listed and blocking until accepted.
    expect(m['alice-assistant']).toMatchObject({ project_before: 'admin', project_after: 'admin', mail_before: 0, mail_after: 5 });
    expect(m['alice-assistant']!.flags).toEqual(['becomes_recipient', 'gains_oversight']);
    expect(m['alice-assistant']!.blocks).toEqual(['oversight_not_accepted']);
    expect(pair.ok).toBe(false);
    expect(pair.blocked.join(' ')).toContain('alice-assistant: project Admin would gain oversight of historic mail');
    // The superadmin: admin everywhere; its inbox membership becomes explicit in the project.
    expect(m.alice).toMatchObject({ project_after: 'admin', grant_added: 'admin' });
    // Unrelated: betabot is not listed.
    expect(m.betabot).toBeUndefined();
    const accepted = previewSpacesMigration(h.core, [PAIR], { acceptOversight: true });
    expect(accepted.ok).toBe(true);
    const text = renderSpacesMigration(accepted);
    expect(text).toContain('Space migration preview (dry run: nothing was changed).');
    expect(text).toContain('proj-alpha-inbox → proj-alpha: ready');
    expect(text).toContain('gains oversight');
    // Nothing was written.
    expect(frozen(s)).toEqual(before);
    expect(h.core.db.prepare('SELECT * FROM spaces ORDER BY id').all()).toEqual(spacesBefore);
    expect(h.core.db.prepare('SELECT * FROM grants ORDER BY id').all()).toEqual(grantsBefore);
    // Apply refuses while blocked and changes nothing.
    expect(() => applySpacesMigration(h.core, [PAIR], { actorId: w.principals.alice.id, via: 'cli' })).toThrow(/Migration blocked \(nothing changed\)/);
    expect(frozen(s)).toEqual(before);
    expect(h.core.db.prepare('SELECT * FROM spaces ORDER BY id').all()).toEqual(spacesBefore);
  });

  it('ambiguous grants block the pair; pairs are explicit (never guessed), each space once', async () => {
    const s = await setup();
    void s;
    // A folder grant in the inbox space: no simple mapping.
    grant('proj-alpha-inbox', w.principals.betabot.id, 'read', 'alphabot/');
    let p = previewSpacesMigration(h.core, [PAIR], { acceptOversight: true }).pairs[0]!;
    expect(p.ok).toBe(false);
    expect(p.blocked.join(' ')).toMatch(/Folder, document, group, propose or none grants in proj-alpha-inbox \(betabot\)/);
    h.core.db.prepare("DELETE FROM grants WHERE path_prefix = 'alphabot/'").run();
    h.core.acl.version++;
    // A Viewer of the project who could send in the inbox would lose sending: blocks.
    grant('proj-alpha', w.principals['alice-helper'].id, 'read');
    p = previewSpacesMigration(h.core, [PAIR], { acceptOversight: true }).pairs[0]!;
    expect(p.members.find((x) => x.name === 'alice-helper')!.blocks).toEqual(['loses_send']);
    expect(p.ok).toBe(false);
    // Review on in the project: messages would need review.
    grant('proj-alpha', w.principals['alice-helper'].id, 'none');
    await s.alice.call('admin_space_update', { slug: 'proj-alpha', review_mode: 'all' });
    p = previewSpacesMigration(h.core, [PAIR], { acceptOversight: true }).pairs[0]!;
    expect(p.blocked.join(' ')).toContain('has review on (all)');
    expect(p.members.find((x) => x.name === 'alice-helper')!.blocks).toEqual(['project_deny']);
    expect(() => parsePair('proj-alpha')).toThrow(/Expected <project>=<inbox>/);
    expect(() => previewSpacesMigration(h.core, [PAIR, { project: 'proj-beta', inbox: 'proj-alpha-inbox' }])).toThrow(/more than one pair/);
    expect(() => previewSpacesMigration(h.core, [{ project: 'proj-alpha', inbox: 'proj-alpha' }])).toThrow(/two different spaces/);
    expect(previewSpacesMigration(h.core, [{ project: 'proj-beta', inbox: 'shared' }]).pairs[0]!.blocked[0]).toContain('shared is not a space with messages');
  });

  it('admin_spaces_preview: the same dry run for admins; invisible to others', async () => {
    const s = await setup();
    const r = await s.alice.call<{ dry_run: boolean; ok: boolean; pairs: { counts: { messages: number }; members: { name: string; flags: string[] }[] }[] }>('admin_spaces_preview', {
      pairs: [PAIR],
      accept_oversight: true,
    });
    expect(r).toMatchObject({ dry_run: true, ok: true });
    expect(r.pairs[0]!.counts.messages).toBe(5);
    expect(r.pairs[0]!.members.find((m) => m.name === 'alice-assistant')!.flags).toContain('gains_oversight');
    expect((await err(s.alphabot.call('admin_spaces_preview', { pairs: [PAIR] }))).code).toBe('not_found');
    expect(space('proj-alpha-inbox').alias_of).toBeNull();
  });
});

describe('migrate-spaces apply', () => {
  it('re-homes envelopes and documents: ids, revisions, receipts, request ids, cursors identical; no synthetic mail', async () => {
    const s = await setup();
    const seen = await boxes(s);
    const startBefore = await s.alphabot.call<{ spaces: { slug: string }[] }>('start_here');
    expect(startBefore.spaces.map((x) => x.slug)).toContain('proj-alpha-inbox');
    const before = frozen(s);
    const out = applySpacesMigration(h.core, [PAIR], { acceptOversight: true, actorId: w.principals.alice.id, via: 'cli' });
    expect(out).toMatchObject({ dry_run: false, ok: true });
    // The same rows: only the space of the documents changed.
    expect(frozen(s)).toEqual(before);
    const alpha = space('proj-alpha');
    const old = space('proj-alpha-inbox');
    for (const id of [s.a.id, s.b.id, s.c.id, s.d.id, s.e.id, s.card]) {
      expect((h.core.db.prepare('SELECT space_id FROM documents WHERE id = ?').get(id) as { space_id: string }).space_id).toBe(alpha.id);
    }
    expect(alpha.inbox).toBe(1);
    expect(old).toMatchObject({ alias_of: alpha.id, bytes_used: 0 });
    expect(old.archived_at).not.toBeNull();
    expect(h.core.db.prepare("SELECT count(*) AS n FROM documents WHERE space_id = ?").get(old.id)).toEqual({ n: 0 });
    // Every party sees exactly the same boxes: no new mail, no lost receipt.
    expect(await boxes(s)).toEqual(seen);
    const inbox = await s.alphabot.call<Inbox>('handoff_inbox', {});
    expect(inbox.counts).toMatchObject({ new: 2, received: 1 });
    expect(inbox.messages.every((m) => m.space === 'proj-alpha' && m.canonical_space === 'proj-alpha')).toBe(true);
    // Thread links intact.
    const thread = await s.alphabot.call<{ handoff?: { thread_id: string; reply_to: string | null; thread: { id: string }[] } }>('read', { id: s.b.id });
    expect(thread.handoff).toMatchObject({ thread_id: s.a.id, reply_to: s.a.id });
    expect(thread.handoff!.thread.map((t) => t.id)).toEqual([s.a.id]);
    // The changes cursor continues: nothing re-reported.
    const next = await s.alphabot.call<ChangesResult>('changes', { since: s.cursor, include_own: true });
    expect(next.changes).toEqual([]);
    // Request-id dedup survives: the retry of the pre-migration send returns the same message, no copy.
    const retry = await s.hermes.call<Sent>('handoff_send', { to: 'alphabot', title: 'Spec review', body: `Please review ${s.word}.`, space: 'proj-alpha-inbox', request_id: 'rid-a-spec-review' });
    expect(retry.message.id).toBe(s.a.id);
    expect(h.core.db.prepare('SELECT count(*) AS n FROM handoff_messages').get()).toEqual({ n: (before.envelopes as unknown[]).length });
    // start_here lists one canonical space; the alias is hidden everywhere.
    const start = await s.alphabot.call<{ spaces: { slug: string; inbox?: boolean }[] }>('start_here');
    expect(start.spaces.map((x) => x.slug)).toContain('proj-alpha');
    expect(start.spaces.map((x) => x.slug)).not.toContain('proj-alpha-inbox');
    const list = await s.alice.call<{ spaces: { slug: string }[] }>('admin_space_list', { include_archived: true });
    expect(list.spaces.map((x) => x.slug)).not.toContain('proj-alpha-inbox');
    // TTL: resolved messages keep their expiry; pending ones never expire.
    const exp = (id: string) => (h.core.db.prepare('SELECT expires_at FROM documents WHERE id = ?').get(id) as { expires_at: number | null }).expires_at;
    expect(exp(s.c.id)).toBeNull();
    expect(exp(s.b.id)).not.toBeNull();
    // Audited; the doctor is clean; a second apply refuses (already an alias).
    expect(h.core.db.prepare("SELECT count(*) AS n FROM audit WHERE op = 'migrate_spaces'").get()).toEqual({ n: 1 });
    expect(h.doctor().problems).toEqual([]);
    expect(() => applySpacesMigration(h.core, [PAIR], { acceptOversight: true, actorId: null, via: 'cli' })).toThrow(/already an alias/);
  });

  it('old slug and paths resolve to the canonical records; authorization is the destination’s', async () => {
    const s = await setup();
    applySpacesMigration(h.core, [PAIR], { acceptOversight: true, actorId: w.principals.alice.id, via: 'cli' });
    // Old locator (space + path) → the same document.
    const byOld = await s.alphabot.call<{ doc: { id: string; space: string } }>('read', { space: 'proj-alpha-inbox', path: s.c.path });
    expect(byOld.doc).toMatchObject({ id: s.c.id, space: 'proj-alpha' });
    // handoff_inbox(space=old) lists the same messages and names the canonical space.
    const filtered = await s.alphabot.call<Inbox>('handoff_inbox', { space: 'proj-alpha-inbox', include_done: true });
    expect(filtered.canonical_space).toBe('proj-alpha');
    expect(filtered.messages.map((m) => m.id).sort()).toEqual([s.a.id, s.c.id, s.e.id].sort());
    // A send with the old space value lands in the canonical space.
    const sent = await s.alphabot.call<Sent>('handoff_send', { to: 'alice-helper', title: 'After', body: 'New mail.', space: 'proj-alpha-inbox' });
    expect(sent.message).toMatchObject({ space: 'proj-alpha', canonical_space: 'proj-alpha' });
    // Recipients name canonical spaces only.
    const rec = await s.alphabot.call<{ recipients: { name: string; spaces: string[] }[] }>('handoff_recipients');
    expect(rec.recipients.find((r) => r.name === 'friend-bot')!.spaces).toEqual(['proj-alpha']);
    // Authorization at the destination: alice-assistant is a project Admin now overseeing (accepted), betabot sees nothing.
    expect((await s.claude.call<{ doc: { id: string } }>('read', { space: 'proj-alpha-inbox', path: s.c.path })).doc.id).toBe(s.c.id);
    for (const ref of [{ id: s.c.id }, { space: 'proj-alpha-inbox', path: s.c.path }, { space: 'proj-alpha', path: s.c.path }]) {
      expect((await err(s.betabot.call('read', ref))).code).toBe('not_found');
    }
    expect((await err(s.betabot.call('list', { space: 'proj-alpha-inbox' }))).code).toBe('not_found');
    // The alias cannot be recreated, renamed onto or used as a fresh slug.
    expect((await err(s.alice.call('admin_space_create', { slug: 'proj-alpha-inbox' }))).code).toBe('conflict');
  });

  it('collision: the preview names it, apply rolls every declared pair back', async () => {
    const s = await setup();
    // A second, clean pair and a collision in the first.
    await s.alice.call('admin_space_create', { slug: 'proj-beta-inbox', inbox: true });
    grant('proj-beta-inbox', w.principals.betabot.id, 'write');
    await s.alice.call('handoff_send', { to: 'betabot', title: 'Beta note', body: 'x', space: 'proj-beta-inbox' });
    await s.alice.call('write', { space: 'proj-alpha', path: '_agents/alphabot.md', content: '# clash\n', expected_rev: 0, message: 'clash' });
    const before = frozen(s);
    const spacesBefore = h.core.db.prepare('SELECT * FROM spaces ORDER BY id').all();
    const docsBefore = h.core.db.prepare('SELECT id, space_id FROM documents ORDER BY id').all();
    const pairs: SpacePair[] = [{ project: 'proj-beta', inbox: 'proj-beta-inbox' }, PAIR];
    const p = previewSpacesMigration(h.core, pairs, { acceptOversight: true });
    expect(p.pairs[0]!.ok).toBe(true);
    expect(p.pairs[1]!.blocked.join(' ')).toContain('Path collision with proj-alpha: _agents/alphabot.md');
    expect(() => applySpacesMigration(h.core, pairs, { acceptOversight: true, actorId: null, via: 'cli' })).toThrow(/Migration blocked/);
    expect(frozen(s)).toEqual(before);
    expect(h.core.db.prepare('SELECT * FROM spaces ORDER BY id').all()).toEqual(spacesBefore);
    expect(h.core.db.prepare('SELECT id, space_id FROM documents ORDER BY id').all()).toEqual(docsBefore);
    // Even past the preview, the database refuses a live-path collision inside the transaction.
    expect(() =>
      h.core.db.transaction(() => {
        h.core.db.prepare('UPDATE documents SET space_id = ? WHERE space_id = ?').run(space('proj-alpha').id, space('proj-alpha-inbox').id);
      })(),
    ).toThrow(/UNIQUE/);
    expect(h.core.db.prepare('SELECT id, space_id FROM documents ORDER BY id').all()).toEqual(docsBefore);
  });
});

describe('across the migration', () => {
  it('an old MCP client mid-send/read/ack/wait keeps working: same names, args, ids, deadlines', async () => {
    const s = await setup();
    const fz = await mcp(w.tokens.alphabot);
    const fr = await mcp(s.friendToken);
    // Read before (rev), ack after with that expected_rev.
    const read = await fz('read', { id: s.e.id });
    expect(read.text).toContain('Use test keys.');
    // Clear the waiting mail so the wait parks.
    await fz('handoff_ack', { id: s.c.id, expected_rev: s.c.rev, status: 'received' });
    // A watch started before the migration (deadline in `until`).
    const first = await fz('handoff_wait', { minutes: 5 });
    expect(first.data).toMatchObject({ status: 'mail' });
    await fz('handoff_ack', { id: s.e.id, expected_rev: s.e.rev, status: 'received' });
    // Answers seen (b done, d declined), so nothing is pending for the watch.
    await fz('handoff_inbox', { box: 'out' });
    const until0 = (first.data as { until: string }).until;
    const parked = fz('handoff_wait', { until: until0 });
    await until(() => h.core.waiters.size === 1);
    applySpacesMigration(h.core, [PAIR], { acceptOversight: true, actorId: w.principals.alice.id, via: 'cli' });
    // The wake is transient: no receipt, no synthetic mail — the wait parks again.
    await until(() => h.core.waiters.size === 1);
    expect(h.core.db.prepare('SELECT received_rev FROM handoff_messages WHERE doc_id = ?').get(s.d.id)).toEqual({ received_rev: s.d.rev });
    // The external's old client still names the old inbox slug.
    const sent = await fr('handoff_send', { to: 'alphabot', title: 'After the move', body: 'Still here?', space: 'proj-alpha-inbox', request_id: 'rid-after-move' });
    expect(sent.r.isError).toBeFalsy();
    const woke = await parked;
    expect(woke.data).toMatchObject({ status: 'mail', until: until0, newest: { from: 'friend-bot', space: 'proj-alpha', canonical_space: 'proj-alpha' } });
    // Retry of the lost response: same id.
    const again = await fr('handoff_send', { to: 'alphabot', title: 'After the move', body: 'Still here?', space: 'proj-alpha-inbox', request_id: 'rid-after-move' });
    expect((again.data as { message: { id: string } }).message.id).toBe((sent.data as { message: { id: string } }).message.id);
    // Ack with the rev read before the migration.
    const acked = await fz('handoff_ack', { id: s.e.id, expected_rev: s.e.rev, status: 'done' });
    expect(acked.r.isError).toBeFalsy();
    expect(acked.data).toMatchObject({ message: { id: s.e.id, status: 'done', canonical_space: 'proj-alpha' } });
    // handoff_inbox with the old space value.
    const box = await fz('handoff_inbox', { space: 'proj-alpha-inbox' });
    expect(box.data).toMatchObject({ canonical_space: 'proj-alpha' });
    expect(box.text).toContain('After the move');
  });

  it('the new Guest (an inbox-only member) sees only its own mail; no project documents', async () => {
    const s = await setup();
    applySpacesMigration(h.core, [PAIR], { acceptOversight: true, actorId: w.principals.alice.id, via: 'cli' });
    const g = s.hermes;
    const inb = await g.call<Inbox>('handoff_inbox', { include_done: true });
    const out = await g.call<Inbox>('handoff_inbox', { box: 'out', include_done: true });
    const ids = [...inb.messages, ...out.messages].filter((m) => m.space === 'proj-alpha').map((m) => m.id).sort();
    expect(ids).toEqual([s.a.id, s.b.id].sort());
    expect((await g.call<{ doc: { id: string } }>('read', { id: s.a.id })).doc.id).toBe(s.a.id);
    for (const id of [s.c.id, s.d.id, s.e.id, s.readme, s.card]) expect((await err(g.call('read', { id }))).code).toBe('not_found');
    expect((await err(g.call('list', { space: 'proj-alpha' }))).code).toBe('not_found');
    expect((await g.call<SearchResult>('search', { query: s.word })).results.map((r) => r.doc.id)).not.toContain(s.readme);
    const start = await g.call<{ spaces: { slug: string; role: string }[] }>('start_here');
    expect(start.spaces.find((x) => x.slug === 'proj-alpha')).toMatchObject({ role: 'guest' });
    // It can still answer in the project.
    const r = await g.call<Sent>('handoff_send', { to: 'alphabot', title: 'Re: more', body: 'ok', reply_to: s.b.id });
    expect(r.message.space).toBe('proj-alpha');
    // And its grant is a Guest membership, not Editor.
    const role = h.core.db
      .prepare("SELECT role FROM grants WHERE space_id = ? AND subject_id = ? AND scope = 'space'")
      .get(space('proj-alpha').id, w.principals['alice-helper'].id) as { role: string };
    expect(role.role).toBe('guest');
  });

  it('Alpha↛Beta canary after the migration: names, recipients, search, counts and errors', async () => {
    const s = await setup();
    const beta = await seedBeta(w);
    applySpacesMigration(h.core, [PAIR], { acceptOversight: true, actorId: w.principals.alice.id, via: 'cli' });
    // alphabot: nothing of proj-beta.
    const fRec = await s.alphabot.call<{ recipients: { name: string; spaces: string[] }[] }>('handoff_recipients');
    expect(JSON.stringify(fRec)).not.toContain('proj-beta');
    expect(fRec.recipients.find((r) => r.name === 'betabot')?.spaces ?? []).not.toContain('proj-alpha');
    expect((await err(s.alphabot.call('read', { id: beta.secret.doc.id }))).code).toBe('not_found');
    const fStart = JSON.stringify(await s.alphabot.call('start_here'));
    expect(fStart).not.toContain('proj-beta');
    expect(fStart).not.toContain(w.canary.prefix);
    // betabot: nothing of proj-alpha or its mail, by id, old path, search, counts or recipients.
    const sStart = JSON.stringify(await s.betabot.call('start_here'));
    for (const marker of ['proj-alpha', 'friend-bot', 'Spec review', s.word]) expect(sStart).not.toContain(marker);
    const sRec = JSON.stringify(await s.betabot.call('handoff_recipients'));
    for (const marker of ['proj-alpha', 'friend-bot']) expect(sRec).not.toContain(marker);
    expect((await s.betabot.call<SearchResult>('search', { query: s.word })).results).toEqual([]);
    const sInbox = await s.betabot.call<Inbox>('handoff_inbox', { space: 'proj-alpha-inbox', include_done: true });
    expect(sInbox).toMatchObject({ messages: [], canonical_space: null });
    for (const id of [s.a.id, s.c.id]) {
      const a = await err(s.betabot.call('read', { id }));
      const b = await err(s.betabot.call('read', { id: '01JZZZZZZZZZZZZZZZZZZZZZZZ' }));
      expect(a.code).toBe('not_found');
      expect(a.message).toBe(b.message);
    }
    expect((await err(s.betabot.call('handoff_send', { to: 'alphabot', title: 'x', body: 'x', space: 'proj-alpha-inbox' }))).message).toBe(
      (await err(s.betabot.call('handoff_send', { to: 'alphabot', title: 'x', body: 'x', space: 'no-such-space' }))).message,
    );
  });

  it('“Done” acks a snapshot of message ids: a concurrent reply stays pending', async () => {
    const s = await setup();
    applySpacesMigration(h.core, [PAIR], { acceptOversight: true, actorId: w.principals.alice.id, via: 'cli' });
    // The thread of a/b as seen by hermes: b is to hermes. Snapshot taken when hermes opens it.
    const snapshot = (await s.hermes.call<Inbox>('handoff_inbox', { include_done: true })).messages.filter((m) => m.thread_id === s.a.id && m.to === 'alice-helper');
    // A reply arrives while hermes is looking.
    const late = (await s.alphabot.call<Sent>('handoff_send', { to: 'alice-helper', title: 'Re: one more', body: 'Also…', reply_to: s.b.id })).message;
    for (const m of snapshot) {
      if (m.status === 'done' || m.status === 'declined') continue;
      await s.hermes.call('handoff_ack', { id: m.id, expected_rev: m.rev, status: 'done' });
    }
    const after = await s.hermes.call<Inbox>('handoff_inbox', {});
    expect(after.messages.map((m) => m.id)).toEqual([late.id]);
    expect(after.messages[0]!.status).toBe('new');
  });
});
