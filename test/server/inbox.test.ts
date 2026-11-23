// Inbox acceptance: handoff messages with acknowledgement,
// end to end over MCP (hint lines, notes) and REST (`handoff` field), the Letta → bob-agent scenario.
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readOpNames } from '../../src/app.js';
import { setGrant } from '../../src/core/grants.js';
import { runJanitor } from '../../src/core/janitor.js';
import { createPrincipal } from '../../src/core/principals.js';
import { issueToken } from '../../src/core/tokens.js';
import { loadMigrations } from '../../src/db/migrate.js';
import { READ_INBOX_STEP } from '../../src/ops/agent/start_here.js';
import type { WriteResult } from '../helpers/api.js';
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
  received_rev: number | null;
  resolution: string | null;
  resolved_by: string | null;
  note: string | null;
}
interface Inbox {
  box: string;
  counts: Record<string, number>;
  messages: Msg[];
  more: boolean;
}
interface Sent {
  message: Msg;
  doc: { id: string; path: string; rev: number };
  recipient_last_seen: string | null;
}
interface Agent {
  name: string;
  token: string;
  rest: Client;
}

/** A fresh agent with write on handoff. */
function agent(name: string, role: 'write' | 'none' = 'write'): Agent {
  const alice = w.principals.alice;
  const p = createPrincipal(h.core, { name, kind: 'agent', trust: 'trusted', ownerId: alice.id }, alice.id);
  if (role !== 'none') {
    setGrant(h.core, { spaceId: w.spaces.handoff.id, scope: 'space', pathPrefix: null, docId: null, role, subjectType: 'principal', subjectId: p.id }, alice.id);
  }
  const token = issueToken(h.core, p.id, { label: name, createdBy: alice.id }).token;
  return { name, token, rest: makeClient('rest', h, token) };
}

async function mcp(token: string): Promise<SdkClient> {
  const transport = new StreamableHTTPClientTransport(new URL(`${h.url}/mcp/v1`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new SdkClient({ name: 'brain-test', version: '0.0.0' });
  await client.connect(transport);
  open.push(client);
  return client;
}

/** MCP client after start_here; `call` returns all text blocks and the structured result. */
async function oriented(token: string) {
  const c = await mcp(token);
  const first = (await c.callTool({ name: 'start_here', arguments: {} })) as CallToolResult;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name, arguments: args })) as CallToolResult;
    return { r, text: r.content.map((x) => (x.type === 'text' ? x.text : '')), out: r.structuredContent as Record<string, unknown> };
  };
  return { c, call, start: first };
}

const hintOf = (text: string[]): string | undefined => text.slice(1).find((t) => t.startsWith('Inbox:') || t.includes('\nInbox:'))?.split('\n').find((l) => l.startsWith('Inbox:'));
const outboxHintOf = (text: string[]): string | undefined =>
  text.slice(1).join('\n').split('\n').find((l) => l.startsWith('Outbox:'));

const send = (from: Client, to: string, title: string, body: string, extra: Record<string, unknown> = {}) =>
  from.call<Sent>('handoff_send', { to, title, body, ...extra });

async function err(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected an error');
}

const janitor = () => runJanitor(h.core, { readOps: readOpNames() });
const expiresAt = (id: string) => (h.core.db.prepare('SELECT expires_at AS e FROM documents WHERE id = ?').get(id) as { e: number | null }).e;
const DAY = 86_400_000;

let letta: Agent;
let bobAgent: Agent;

beforeEach(async () => {
  h = await startHarness();
  w = buildWorld(h, 'rest');
  letta = agent('alice-coder');
  bobAgent = agent('bob-agent');
});
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
  expect(h.doctor().problems).toEqual([]);
  await h.close();
});

describe('send', () => {
  it('Letta → bob-agent: server path, sender from the token, status new; unknown recipient suggests a name and creates nothing', async () => {
    const day = new Date(h.clock.now()).toISOString().slice(0, 10);
    const s = await send(letta.rest, 'bob-agent', 'Shop weekly numbers', 'Post the numbers to the sheet.');
    expect(s.message).toMatchObject({ from: 'alice-coder', to: 'bob-agent', status: 'new', rev: 1, space: 'handoff', path: `bob-agent/${day}-shop-weekly-numbers.md`, reply_to: null });
    expect(s.message.thread_id).toBe(s.message.id);
    expect(s.recipient_last_seen).toBeNull();
    const read = await bobAgent.rest.call<{ content: string; doc: { author: { name: string } } }>('read', { id: s.message.id });
    expect(read.content).toBe('# Shop weekly numbers\n\nPost the numbers to the sheet.\n');
    expect(read.doc.author.name).toBe('alice-coder');
    // A second message with the same title gets its own path.
    const again = await send(letta.rest, 'bob-agent', 'Shop weekly numbers', 'Again.');
    expect(again.message.path).toBe(`bob-agent/${day}-shop-weekly-numbers-2.md`);

    const bad = await err(send(letta.rest, 'bob', 'X', 'y'));
    expect(bad.code).toBe('invalid_input');
    expect(bad.message).toContain('No agent "bob". Did you mean bob-agent? See handoff/_agents/.');
    const none = await err(send(letta.rest, 'zzz', 'X', 'y'));
    expect(none.message).not.toContain('Did you mean');
    const out = await letta.rest.call<Inbox>('handoff_inbox', { box: 'out' });
    expect(out.messages).toHaveLength(2);
  });

  it('request_id makes a retry safe; secrets are refused; a sender without write cannot send', async () => {
    const a = await send(letta.rest, 'bob-agent', 'Once', 'body', { request_id: 'req-inbox-0001' });
    const b = await send(letta.rest, 'bob-agent', 'Once', 'body', { request_id: 'req-inbox-0001' });
    expect(b.message.id).toBe(a.message.id);
    expect((await bobAgent.rest.call<Inbox>('handoff_inbox')).messages).toHaveLength(1);
    const secret = await err(send(letta.rest, 'bob-agent', 'Key', 'token ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'));
    expect(secret.code).toBe('secret_detected');
    const reader = agent('alice-reader', 'none');
    setGrant(h.core, { spaceId: w.spaces.handoff.id, scope: 'space', pathPrefix: null, docId: null, role: 'read', subjectType: 'principal', subjectId: h.core.db.prepare("SELECT id FROM principals WHERE name = 'alice-reader'").pluck().get() as string }, w.principals.alice.id);
    expect((await err(send(reader.rest, 'bob-agent', 'X', 'y'))).code).toBe('forbidden');
  });
});

describe('the Letta → bob-agent scenario', () => {
  it('hint until received; a lost read does not clear it; an edit reopens with a diff; stale ack conflicts; done reaches the sender', async () => {
    const s = await send(letta.rest, 'bob-agent', 'Shop weekly numbers', 'Post the numbers.\n');
    const id = s.message.id;
    const b = await oriented(bobAgent.token);

    // start_here lists it, waiting, with the read step first.
    const sh = b.start.structuredContent as { next_steps: string[]; spaces: { slug: string; inbox?: { waiting: number; docs: { id: string; status: string }[] } }[] };
    expect(sh.next_steps[0]).toBe(READ_INBOX_STEP);
    expect(sh.spaces.find((x) => x.slug === 'handoff')!.inbox).toMatchObject({ waiting: 1, docs: [{ id, status: 'new' }] });

    // Every unrelated call carries the hint; handoff_* results do not.
    const hint = 'Inbox: 1 waiting — "Shop weekly numbers" from alice-coder. Call handoff_inbox.';
    expect(hintOf((await b.call('search', { query: 'anything' })).text)).toBe(hint);
    expect(hintOf((await b.call('whoami')).text)).toBe(hint);
    const ib = await b.call('handoff_inbox');
    expect(ib.text).toHaveLength(1);
    expect(ib.text[0]).toContain(`- NEW "Shop weekly numbers" from alice-coder, sent 0m ago, not received yet (id ${id}, rev 1)`);
    // REST carries the same as a field.
    const rest = await bobAgent.rest.raw('whoami');
    expect((JSON.parse(rest.text) as { handoff?: unknown }).handoff).toEqual({ inbox_waiting: 1, newest: { id, space: 'handoff', title: 'Shop weekly numbers', from: 'alice-coder' }, outbox_answered: 0 });

    // read shows the header and how to ack, and changes nothing: a lost response keeps the reminder.
    const rd = await b.call('read', { id });
    expect(rd.text[0]).toMatch(/^Message from alice-coder to you\. Status: NEW\./);
    expect(rd.text[0]).toContain(`Ack: handoff_ack(id="${id}", expected_rev=1, status="received"|"done"|"declined", note).`);
    expect(rd.text[0]).toContain(`Answer: handoff_send(to="alice-coder", reply_to="${id}", ...).`);
    expect(hintOf(rd.text)).toBe(hint);
    expect(hintOf((await b.call('list', { space: 'handoff' })).text)).toBe(hint);

    // received stops the reminders; a second received says so.
    const ack = await b.call('handoff_ack', { id, expected_rev: 1, status: 'received' });
    expect(ack.r.isError).toBeFalsy();
    expect(ack.text[0]).toContain('reminders stop');
    expect(hintOf((await b.call('whoami')).text)).toBeUndefined();
    h.clock.advance(5 * 60_000);
    const twice = await b.call('handoff_ack', { id, expected_rev: 1, status: 'received' });
    expect(twice.out.already).toBe(true);
    expect(twice.text[0]).toBe(`Already received 5m ago: "Shop weekly numbers" (id ${id}, rev 1).`);
    expect((await letta.rest.call<Inbox>('handoff_inbox', { box: 'out' })).messages[0]!.status).toBe('received');

    // Letta edits the same document (the live bug): her result says it reopens it.
    const l = await oriented(letta.token);
    const ed = await l.call('edit', { id, expected_rev: 1, edits: [{ old_text: 'Post the numbers.', new_text: 'Post the numbers.\nAlso add last week.' }], message: 'more' });
    expect(ed.r.isError).toBeFalsy();
    expect(ed.text.slice(1).join('\n')).toContain('Note: bob-agent already received rev 1; this reopens it. For a new request use handoff_send with reply_to.');
    expect(hintOf((await b.call('whoami')).text)).toBe(hint);
    const inbox = await bobAgent.rest.call<Inbox>('handoff_inbox');
    expect(inbox.messages[0]).toMatchObject({ id, status: 'updated', received_rev: 1, rev: 2 });
    const rd2 = await b.call('read', { id });
    expect(rd2.text[0]).toContain('Status: UPDATED (you received rev 1, now rev 2).');
    expect(rd2.text[0]).toMatch(/BEGIN DIFF \S+\n[\s\S]*\+Also add last week\.[\s\S]*END DIFF/);
    expect(rd2.text[0]!.indexOf('BEGIN DIFF')).toBeLessThan(rd2.text[0]!.indexOf('BEGIN CONTENT'));
    expect((rd2.out.handoff as { changes: { from_rev: number; to_rev: number } }).changes).toMatchObject({ from_rev: 1, to_rev: 2 });

    // Stale ack → conflict; with the new rev → done; Letta gets one outbox hint until she looks.
    const stale = await b.call('handoff_ack', { id, expected_rev: 1, status: 'done', note: 'posted' });
    expect(stale.r.isError).toBe(true);
    expect(stale.text[0]).toContain('ERROR conflict: Message changed: you passed rev 1, now rev 2.');
    const done = await b.call('handoff_ack', { id, expected_rev: 2, status: 'done', note: 'Posted to the sheet.' });
    expect(done.text[0]).toBe('Marked "Shop weekly numbers" as done. alice-coder sees it in their outbox.');
    expect(hintOf((await b.call('whoami')).text)).toBeUndefined();
    const ohint = 'Outbox: 1 answered — "Shop weekly numbers" done by bob-agent. Call handoff_inbox(box="out").';
    expect(outboxHintOf((await l.call('whoami')).text)).toBe(ohint);
    expect(outboxHintOf((await l.call('spaces')).text)).toBe(ohint);
    const out = await l.call('handoff_inbox', { box: 'out' });
    expect(out.text[0]).toContain('- DONE "Shop weekly numbers" to bob-agent, done by bob-agent: "Posted to the sheet."');
    expect(outboxHintOf((await l.call('whoami')).text)).toBeUndefined();
    // Done is hidden by default now that it was seen; include_done shows it.
    expect((await letta.rest.call<Inbox>('handoff_inbox', { box: 'out' })).messages).toHaveLength(0);
    expect((await letta.rest.call<Inbox>('handoff_inbox', { box: 'out', include_done: true })).messages[0]!.status).toBe('done');

    // Monotonic: received after done changes nothing; declined after done conflicts; a later edit reopens.
    expect((await bobAgent.rest.call<{ already: boolean }>('handoff_ack', { id, expected_rev: 2, status: 'received' })).already).toBe(true);
    expect((await err(bobAgent.rest.call('handoff_ack', { id, expected_rev: 2, status: 'declined', note: 'no' }))).code).toBe('conflict');
    await letta.rest.call('edit', { id, expected_rev: 2, edits: [{ old_text: 'last week', new_text: 'last two weeks' }], message: 'typo' });
    expect((await bobAgent.rest.call<Inbox>('handoff_inbox')).messages[0]!.status).toBe('updated');
  });

  it('a plain write into handoff/<name>/ is a message too; the recipient own edit reopens it as well', async () => {
    const l = await oriented(letta.token);
    const wr = await l.call('write', { space: 'handoff', path: 'bob-agent/setup-recipes.md', content: '# Setup recipes\n\nPlease.\n', message: 'for bobAgent' });
    const id = (wr.out as unknown as WriteResult).doc!.id;
    expect(wr.text.slice(1)).toEqual([`Registered as a message to bob-agent (id ${id}). Next time use handoff_send.`]);
    const inbox = await bobAgent.rest.call<Inbox>('handoff_inbox');
    expect(inbox.messages[0]).toMatchObject({ id, from: 'alice-coder', status: 'new' });
    await bobAgent.rest.call('handoff_ack', { id, expected_rev: 1, status: 'received' });
    await bobAgent.rest.call('edit', { id, expected_rev: 1, edits: [{ old_text: 'Please.', new_text: 'Please. (noted)' }], message: 'note' });
    expect((await bobAgent.rest.call<Inbox>('handoff_inbox')).messages[0]!.status).toBe('updated');
    // Moving or renaming does not change the body: no reopen.
    await bobAgent.rest.call('handoff_ack', { id, expected_rev: 2, status: 'received' });
    await bobAgent.rest.call('move', { id, to_path: 'bob-agent/old/setup-recipes.md', expected_rev: 2, message: 'file' });
    expect((await bobAgent.rest.call<Inbox>('handoff_inbox')).messages[0]!.status).toBe('received');
  });
});

describe('threads', () => {
  it('reply_to puts the answer in the other folder, same thread; only between the same two', async () => {
    const q = await send(letta.rest, 'bob-agent', 'Question', 'Which sheet?');
    const a = await send(bobAgent.rest, 'alice-coder', 'Re: Question', 'The Shop one.', { reply_to: q.message.id });
    expect(a.message).toMatchObject({ path: expect.stringMatching(/^alice-coder\//), thread_id: q.message.id, reply_to: q.message.id, status: 'new' });
    const b2 = await send(letta.rest, 'bob-agent', 'Re: Re: Question', 'Thanks.', { reply_to: a.message.id });
    expect(b2.message.thread_id).toBe(q.message.id);
    const rd = await bobAgent.rest.call<{ handoff: { thread: { id: string }[]; thread_id: string } }>('read', { id: b2.message.id });
    expect(rd.handoff.thread.map((t) => t.id)).toEqual([q.message.id, a.message.id]);
    // Closing the parent does not close the reply.
    await bobAgent.rest.call('handoff_ack', { id: q.message.id, expected_rev: 1, status: 'done' });
    expect((await letta.rest.call<Inbox>('handoff_inbox')).messages.map((m) => m.id)).toEqual([a.message.id]);
    // A third party cannot reply into the thread; reply_to must be a message. The
    // third party cannot read the message at all (mail read predicate), so it is "not found".
    const third = await err(send(w.client('betabot'), 'alice-coder', 'X', 'y', { reply_to: q.message.id }));
    expect(third.code).toBe('not_found');
    const plain = await w.client('betabot').call<WriteResult>('write', { space: 'handoff', path: 'notes/n.md', content: '# N\n', message: 'n' });
    expect((await err(send(w.client('betabot'), 'alice-coder', 'X', 'y', { reply_to: plain.doc!.id }))).message).toContain('Not a handoff message');
  });
});

describe('TTL', () => {
  it('pending survives day 15 (even after a reopening edit); done expires 14 days after resolution', async () => {
    const s = await send(letta.rest, 'bob-agent', 'Long task', 'Whenever.');
    const id = s.message.id;
    expect(expiresAt(id)).toBeNull();
    h.clock.advanceDays(15);
    expect(janitor().expired).toBe(0);
    await bobAgent.rest.call('handoff_ack', { id, expected_rev: 1, status: 'received' });
    expect(expiresAt(id)).toBeNull();
    h.clock.advanceDays(15);
    expect(janitor().expired).toBe(0);
    expect((await bobAgent.rest.call<Inbox>('handoff_inbox')).messages[0]!.status).toBe('received');
    await bobAgent.rest.call('handoff_ack', { id, expected_rev: 1, status: 'done' });
    expect(Math.abs(expiresAt(id)! - (h.clock.now() + 14 * DAY))).toBeLessThan(5000);
    // A reopening edit clears the expiry again.
    await letta.rest.call('edit', { id, expected_rev: 1, edits: [{ old_text: 'Whenever.', new_text: 'Now.' }], message: 'again' });
    expect(expiresAt(id)).toBeNull();
    await bobAgent.rest.call('handoff_ack', { id, expected_rev: 2, status: 'done' });
    h.clock.advanceDays(13);
    expect(janitor().expired).toBe(0);
    h.clock.advanceDays(2);
    expect(janitor().expired).toBe(1);
    expect((await bobAgent.rest.call<Inbox>('handoff_inbox', { include_done: true })).messages).toHaveLength(0);
  });

  it('the janitor never expires a pending message even with a stray expires_at; purge drops the envelope', async () => {
    const s = await send(letta.rest, 'bob-agent', 'Stray', 'x');
    h.core.db.prepare('UPDATE documents SET expires_at = ? WHERE id = ?').run(h.clock.now() - 1, s.message.id);
    expect(janitor().expired).toBe(0);
    expect(expiresAt(s.message.id)).toBeNull();
    await w.client('alice').call('admin_purge', { id: s.message.id, reason: 'test' });
    expect(h.core.db.prepare('SELECT count(*) FROM handoff_messages').pluck().get()).toBe(0);
  });
});

describe('Alice ↔ agent', () => {
  it('Alice sends and acks like an agent; he can close any message as declined (audited); nobody else acks', async () => {
    const alice = w.client('alice');
    const toBobAgent = await send(alice, 'bob-agent', 'From Alice', 'Do it.');
    expect(toBobAgent.message.from).toBe('alice');
    await bobAgent.rest.call('handoff_ack', { id: toBobAgent.message.id, expected_rev: 1, status: 'done', note: 'ok' });
    const toAlice = await send(bobAgent.rest, 'alice', 'Question for Alice', 'Budget?');
    const raw = await alice.raw('whoami');
    expect((JSON.parse(raw.text) as { handoff: { inbox_waiting: number; outbox_answered: number } }).handoff).toMatchObject({ inbox_waiting: 1, outbox_answered: 1 });
    expect((await alice.call<Inbox>('handoff_inbox')).messages.map((m) => m.id)).toEqual([toAlice.message.id]);
    await alice.call('handoff_ack', { id: toAlice.message.id, expected_rev: 1, status: 'done', note: '100' });

    // Owner close: a message to an agent that never comes back.
    const stuck = await send(letta.rest, 'alphabot', 'For alphabot', 'x');
    expect((await err(alice.call('handoff_ack', { id: stuck.message.id, expected_rev: 1, status: 'declined' }))).message).toContain('note: Required for declined');
    expect((await err(alice.call('handoff_ack', { id: stuck.message.id, expected_rev: 1, status: 'done' }))).code).toBe('forbidden');
    const closed = await alice.call<{ message: Msg }>('handoff_ack', { id: stuck.message.id, expected_rev: 1, status: 'declined', note: 'alphabot is retired' });
    expect(closed.message).toMatchObject({ status: 'declined', resolved_by: 'alice', note: 'alphabot is retired' });
    const audit = h.core.db.prepare("SELECT detail FROM audit WHERE op = 'handoff_ack' AND doc_id = ? AND outcome = 'ok'").pluck().get(stuck.message.id) as string;
    expect(JSON.parse(audit)).toMatchObject({ status: 'declined', owner_close: true });
    // An agent who is not the recipient cannot ack. A third party does not even see the message
    // (not_found); the sender is told who the recipient is.
    const other = await send(letta.rest, 'bob-agent', 'Only bob-agent', 'x');
    const f = await err(w.client('betabot').call('handoff_ack', { id: other.message.id, expected_rev: 1, status: 'received' }));
    expect(f.code).toBe('not_found');
    const g = await err(letta.rest.call('handoff_ack', { id: other.message.id, expected_rev: 1, status: 'received' }));
    expect(g.message).toContain('Only the recipient (bob-agent) can ack this message.');
    expect((await err(letta.rest.call('handoff_ack', { id: other.message.id, expected_rev: 1, status: 'done' }))).code).toBe('forbidden');
    // The owner's page sees every message; agents cannot list "all".
    expect((await alice.call<Inbox>('handoff_inbox', { box: 'all', include_done: true })).messages.length).toBe(4);
    expect((await err(letta.rest.call('handoff_inbox', { box: 'all' }))).code).toBe('forbidden');
  });
});

describe('isolation', () => {
  it('no handoff read: no handoff tools, no hints, nothing listed; hints never count other agents messages', async () => {
    const outsider = agent('alice-outsider', 'none');
    await w.client('alice').call('write', { space: 'handoff', path: 'alice-outsider/hello.md', content: '# Hello\n', message: 'm' });
    const c = await oriented(outsider.token);
    const { tools } = await c.c.listTools();
    expect(tools.map((t) => t.name).filter((n) => n.startsWith('handoff_'))).toEqual([]);
    expect(hintOf((await c.call('whoami')).text)).toBeUndefined();
    expect((await outsider.rest.call<Inbox>('handoff_inbox')).messages).toEqual([]);
    const raw = await outsider.rest.raw('whoami');
    expect((JSON.parse(raw.text) as { handoff?: unknown }).handoff).toBeUndefined();

    // alphabot can read the whole handoff space, but bob-agent's messages are not alphabot's hints.
    await send(letta.rest, 'bob-agent', 'Private-ish', 'x');
    const f = await oriented(w.tokens.alphabot);
    expect(hintOf((await f.call('whoami')).text)).toBeUndefined();
    expect((await w.client('alphabot').call<Inbox>('handoff_inbox')).messages).toEqual([]);
    // A message the recipient cannot read (path grant none) is not hinted to them.
    const hidden = await send(letta.rest, 'bob-agent', 'Hidden', 'x');
    setGrant(h.core, { spaceId: w.spaces.handoff.id, scope: 'path', pathPrefix: 'bob-agent/secret/', docId: null, role: 'none', subjectType: 'principal', subjectId: h.core.db.prepare("SELECT id FROM principals WHERE name = 'bob-agent'").pluck().get() as string }, w.principals.alice.id);
    await letta.rest.call('move', { id: hidden.message.id, to_path: 'bob-agent/secret/hidden.md', expected_rev: 1, message: 'hide' });
    expect((await bobAgent.rest.call<Inbox>('handoff_inbox')).messages.map((m) => m.title)).toEqual(['Private-ish']);
  });
});

describe('recipient enumeration', () => {
  const docs = () => h.core.db.prepare("SELECT COUNT(*) FROM documents d JOIN spaces s ON s.id = d.space_id WHERE s.slug = 'handoff'").pluck().get() as number;
  const messages = () => h.core.db.prepare('SELECT COUNT(*) FROM handoff_messages').pluck().get() as number;
  const sendErr = async (to: string) => {
    const e = await err(send(letta.rest, to, 'X', 'y'));
    expect(e.code).toBe('invalid_input');
    return e.message;
  };

  it('a principal without read on its handoff folder is indistinguishable from an unknown name and never suggested', async () => {
    agent('test-fz', 'none'); // enabled, but no grant on handoff
    const before = { docs: docs(), messages: messages() };
    expect(await sendErr('test-fz')).toBe(await sendErr('test-zz').then((m) => m.replace('test-zz', 'test-fz')));
    expect(await sendErr('test-fz')).toBe('handoff_send failed: invalid_input: Input is invalid: to: No agent "test-fz". See handoff/_agents/.');
    expect(await sendErr('test-f')).not.toContain('Did you mean');
    expect({ docs: docs(), messages: messages() }).toEqual(before);
    // A path grant `none` on the own folder also makes the principal invalid, despite write on the space.
    const shy = agent('test-shy');
    setGrant(h.core, { spaceId: w.spaces.handoff.id, scope: 'path', pathPrefix: 'test-shy/', docId: null, role: 'none', subjectType: 'principal', subjectId: h.core.db.prepare("SELECT id FROM principals WHERE name = 'test-shy'").pluck().get() as string }, w.principals.alice.id);
    expect(await sendErr(shy.name)).toBe('handoff_send failed: invalid_input: Input is invalid: to: No agent "test-shy". See handoff/_agents/.');
    // Once granted read, the same principal becomes a valid recipient and a suggestion.
    setGrant(h.core, { spaceId: w.spaces.handoff.id, scope: 'space', pathPrefix: null, docId: null, role: 'read', subjectType: 'principal', subjectId: h.core.db.prepare("SELECT id FROM principals WHERE name = 'test-fz'").pluck().get() as string }, w.principals.alice.id);
    expect(await sendErr('test-f')).toContain('Did you mean test-fz?');
    expect((await send(letta.rest, 'test-fz', 'Now', 'ok')).message.to).toBe('test-fz');
  });

  it('disabled principals are invalid and never suggested; the human owner is a valid recipient', async () => {
    agent('test-gone');
    expect(await sendErr('test-g')).toContain('Did you mean test-gone?');
    h.core.db.prepare("UPDATE principals SET disabled_at = 1 WHERE name = 'test-gone'").run();
    expect(await sendErr('test-gone')).toBe('handoff_send failed: invalid_input: Input is invalid: to: No agent "test-gone". See handoff/_agents/.');
    expect(await sendErr('test-g')).not.toContain('Did you mean');
    expect((await send(letta.rest, 'alice', 'Owner', 'hi')).message.to).toBe('alice');
  });

  it('a plain write into the folder of an invalid recipient is kept but not registered; the note suggests only valid names', async () => {
    agent('test-fz', 'none');
    const c = await oriented(letta.token);
    const r = await c.call('write', { space: 'handoff', path: 'test-fz/a.md', content: '# A\n', expected_rev: 0, message: 'm' });
    expect(r.r.isError).toBeFalsy();
    expect(r.text.slice(1)).toContain("Note: 'test-fz' is not an agent name; recipients find documents only under their exact name.");
    expect(r.text.join('\n')).not.toContain('Registered as a message');
    const id = (r.out.doc as { id: string }).id;
    expect(h.core.db.prepare('SELECT COUNT(*) FROM handoff_messages WHERE doc_id = ?').pluck().get(id)).toBe(0);
    const near = await c.call('write', { space: 'handoff', path: 'test-f/a.md', content: '# A\n', expected_rev: 0, message: 'm' });
    expect(near.text.join('\n')).not.toContain('test-fz');
    // A valid recipient's folder still registers.
    const ok = await c.call('write', { space: 'handoff', path: 'bob-agent/a.md', content: '# A\n', expected_rev: 0, message: 'm' });
    expect(ok.text.join('\n')).toContain('Registered as a message to bob-agent');
  });
});

describe('export / import and migration', () => {
  it('export full → import as-new keeps envelopes, statuses and threads (ids remapped)', async () => {
    const q = await send(letta.rest, 'bob-agent', 'Q', 'q');
    const a = await send(bobAgent.rest, 'alice-coder', 'A', 'a', { reply_to: q.message.id });
    await bobAgent.rest.call('handoff_ack', { id: q.message.id, expected_rev: 1, status: 'done', note: 'answered' });
    const alice = w.client('alice');
    const exp = await alice.call<{ download_path: string }>('export', { space: 'handoff', mode: 'full' });
    const res = await fetch(`${h.url}${exp.download_path}`, { headers: { authorization: `Bearer ${w.tokens.alice}` } });
    const archive = new Uint8Array(await res.arrayBuffer());
    const imp = await fetch(`${h.url}/api/v1/import?space=handoff-copy&mode=as-new`, {
      method: 'POST',
      headers: { authorization: `Bearer ${w.tokens.alice}`, 'content-type': 'application/gzip' },
      body: archive,
    });
    expect(imp.status).toBe(200);
    const all = await alice.call<Inbox>('handoff_inbox', { box: 'all', include_done: true });
    const copies = all.messages.filter((m) => m.space === 'handoff-copy');
    expect(copies).toHaveLength(2);
    const cq = copies.find((m) => m.title === 'Q')!;
    const ca = copies.find((m) => m.title === 'A')!;
    expect(cq).toMatchObject({ from: 'alice-coder', to: 'bob-agent', status: 'done', note: 'answered', resolved_by: 'bob-agent' });
    expect(cq.id).not.toBe(q.message.id);
    expect(ca).toMatchObject({ status: 'new', thread_id: cq.id, reply_to: cq.id });
    expect(expiresAt(ca.id)).toBeNull();
    expect(expiresAt(cq.id)).not.toBeNull();
    expect(a.message.id).not.toBe(ca.id);
  });

  it('migration 0006 registers existing documents under handoff/<principal>/ as not received, sender = author of rev 1', async () => {
    const d = await letta.rest.call<WriteResult>('write', { space: 'handoff', path: 'bob-agent/old.md', content: '# Old\n', message: 'm', ttl_days: 3 });
    await bobAgent.rest.call('write', { space: 'handoff', path: 'bob-agent/old.md', content: '# Old 2\n', expected_rev: 1, message: 'm' });
    await letta.rest.call('write', { space: 'handoff', path: '_agents/alice-coder.md', content: '# Letta\n', message: 'card' });
    await letta.rest.call('write', { space: 'handoff', path: 'bobagent/misaddressed.md', content: '# Mis\n', message: 'm' });
    h.core.db.exec('DELETE FROM handoff_messages');
    h.core.db.prepare('UPDATE documents SET expires_at = 1 WHERE id = ?').run(d.doc!.id);
    const sql = loadMigrations().find((m) => m.name === '0006_inbox.sql')!.sql;
    h.core.db.exec(sql.slice(sql.indexOf('INSERT INTO handoff_messages')));
    const rows = h.core.db.prepare('SELECT * FROM handoff_messages').all() as { doc_id: string; content_rev: number; received_rev: number | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ doc_id: d.doc!.id, content_rev: 2, received_rev: null });
    expect(expiresAt(d.doc!.id)).toBeNull();
    expect((await bobAgent.rest.call<Inbox>('handoff_inbox')).messages[0]).toMatchObject({ from: 'alice-coder', status: 'new' });
  });
});

describe('guided only by start_here', () => {
  it('bob-agent follows the text: start_here → read the listed id → the ack line from read → no more hints', async () => {
    await send(letta.rest, 'bob-agent', 'Shop weekly numbers', 'Post them.');
    const b = await oriented(bobAgent.token);
    const text = (b.start.content[0] as { text: string }).text;
    expect(text).toContain(READ_INBOX_STEP);
    const id = /- NEW "Shop weekly numbers" from alice-coder, .* \(id (\w{26}), rev 1\)/.exec(text)![1]!;
    const rd = await b.call('read', { id });
    const line = /handoff_ack\(id="(\w+)", expected_rev=(\d+), status=/.exec(rd.text[0]!)!;
    await b.call('handoff_ack', { id: line[1], expected_rev: Number(line[2]), status: 'done', note: 'Posted.' });
    expect(hintOf((await b.call('whoami')).text)).toBeUndefined();
    const reply = /Answer: handoff_send\(to="([\w-]+)", reply_to="(\w+)"/.exec(rd.text[0]!)!;
    const sent = await b.call('handoff_send', { to: reply[1], reply_to: reply[2], title: 'Re: Shop weekly numbers', body: 'Done.' });
    expect(sent.text[0]).toMatch(/^Sent to alice-coder: "Re: Shop weekly numbers"/);
    const l = await oriented(letta.token);
    const lt = (l.start.content[0] as { text: string }).text;
    expect(lt).toContain('- NEW "Re: Shop weekly numbers" from bob-agent');
    expect(lt).toContain('Outbox: 0 open, 1 answered since you last looked.');
  });
});
