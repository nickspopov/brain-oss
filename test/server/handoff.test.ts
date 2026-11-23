// Inbox in start_here, recipient name check on write/move, agent cards without TTL.
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAgentsMd } from '../../src/adapters/http/discovery.js';
import { readOpNames } from '../../src/app.js';
import { setGrant } from '../../src/core/grants.js';
import { recipientCheck } from '../../src/core/inbox.js';
import { runJanitor } from '../../src/core/janitor.js';
import { createPrincipal } from '../../src/core/principals.js';
import { loadMigrations } from '../../src/db/migrate.js';
import { READ_INBOX_STEP } from '../../src/ops/agent/start_here.js';
import type { WriteResult } from '../helpers/api.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
let w: World;
const open: SdkClient[] = [];

beforeEach(async () => {
  h = await startHarness();
  w = buildWorld(h, 'rest');
});
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
  expect(h.doctor().problems).toEqual([]);
  await h.close();
});

/** An MCP client that already called start_here (no "not oriented" note in later results). */
async function oriented(token: string): Promise<SdkClient> {
  const c = await mcp(token);
  await c.callTool({ name: 'start_here', arguments: {} });
  return c;
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
const blocks = (r: CallToolResult): string[] => r.content.map((x) => (x.type === 'text' ? x.text : ''));

interface Inbox {
  path: string;
  total: number;
  docs: { path: string; title: string; author: string; created_at: string; new: boolean }[];
}
interface StartHere {
  spaces: { slug: string; inbox?: Inbox }[];
  next_steps: string[];
}
const inboxOf = (r: StartHere): Inbox | undefined => r.spaces.find((s) => s.slug === 'handoff')?.inbox;

const leave = (from: 'alice-helper' | 'betabot' | 'alice', path: string, title: string) =>
  w.client(from).call<WriteResult>('write', { space: 'handoff', path, content: `# ${title}\n\nfor you\n`, expected_rev: 0, message: 'handoff' });

describe('inbox in start_here', () => {
  it('empty inbox: one line, no read step; only the handoff space has an inbox', async () => {
    const r = await w.client('alphabot').call<StartHere>('start_here', {});
    expect(inboxOf(r)).toEqual({ path: 'handoff/alphabot/', total: 0, waiting: 0, docs: [], outbox: { open: 0, answered: 0 } });
    expect(r.spaces.filter((s) => s.inbox !== undefined).map((s) => s.slug)).toEqual(['handoff']);
    expect(r.next_steps).not.toContain(READ_INBOX_STEP);
    const c = await mcp(w.tokens.alphabot);
    const text = blocks((await c.callTool({ name: 'start_here', arguments: {} })) as CallToolResult)[0]!;
    expect(text).toContain('  Inbox: handoff/alphabot/ — empty');
  });

  it('lists up to 5 open messages, waiting first, with sender and status; read step while any waits', async () => {
    for (let i = 1; i <= 6; i++) {
      await leave('alice-helper', `alphabot/task-${i}.md`, `Task ${i}`);
      h.clock.advance(1000);
    }
    await leave('alice-helper', 'betabot/other.md', 'Not yours'); // another inbox
    await leave('alice-helper', 'alphabot-notes.md', 'Root file'); // not in the folder
    const first = await w.client('alphabot').call<StartHere>('start_here', {});
    const ib = inboxOf(first)!;
    expect(ib.total).toBe(6);
    expect(ib.docs.map((d) => d.path)).toEqual(['alphabot/task-6.md', 'alphabot/task-5.md', 'alphabot/task-4.md', 'alphabot/task-3.md', 'alphabot/task-2.md']);
    expect(ib.docs[0]).toMatchObject({ title: 'Task 6', author: 'alice-helper', new: true });
    expect(ib.docs.every((d) => d.new)).toBe(true);
    expect(first.next_steps[0]).toBe(READ_INBOX_STEP);

    // Calling start_here again does not receive anything: still waiting.
    h.clock.advance(1000);
    const again = await w.client('alphabot').call<StartHere>('start_here', {});
    expect(inboxOf(again)!.docs.every((d) => d.new)).toBe(true);
    expect(again.next_steps[0]).toBe(READ_INBOX_STEP);

    h.clock.advance(1000);
    await leave('betabot', 'Alphabot/reply.md', 'Reply'); // folder case does not matter
    const c = await mcp(w.tokens.alphabot);
    const res = (await c.callTool({ name: 'start_here', arguments: {} })) as CallToolResult;
    const s = res.structuredContent as unknown as StartHere;
    expect(inboxOf(s)!.total).toBe(7);
    expect(inboxOf(s)!.docs[0]!.path).toBe('Alphabot/reply.md');
    const text = blocks(res)[0]!;
    expect(text).toContain('  Inbox: handoff/alphabot/ — 7 open messages, 7 waiting');
    expect(text).toMatch(/ {2}- NEW "Reply" from betabot, 0m ago \(id \w{26}, rev 1\)/);
    expect(text).toContain('  More: handoff_inbox.');
    expect(text.indexOf('Inbox:')).toBeLessThan(text.indexOf('## Rules'));
  });

  it('counts only documents the caller can read', async () => {
    await leave('alice', 'alphabot/visible.md', 'Visible');
    await leave('alice', 'alphabot/secret/hidden.md', 'Hidden');
    w.grant('handoff', { principal: 'alphabot' }, 'none', { path: 'alphabot/secret' });
    const r = await w.client('alphabot').call<StartHere>('start_here', {});
    expect(inboxOf(r)!.total).toBe(1);
    expect(inboxOf(r)!.docs.map((d) => d.path)).toEqual(['alphabot/visible.md']);
  });
});

describe('recipient name check', () => {
  it('MCP write under an unknown folder: committed, plus a note with the closest name', async () => {
    const c = await oriented(w.tokens['alice-helper']);
    const r = (await c.callTool({
      name: 'write',
      arguments: { space: 'handoff', path: 'helper/setup.md', content: '# Setup\n', expected_rev: 0, message: 'for helper' },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { status: string }).status).toBe('committed');
    expect(blocks(r).slice(1)).toEqual([
      "Note: 'helper' is not an agent name; recipients find documents only under their exact name (e.g. 'alice-helper').",
    ]);
  });

  it('no note for exact names, _agents, root files, updates; a note without example when nothing is close', async () => {
    const c = await oriented(w.tokens['alice-helper']);
    const write = async (path: string, extra: Record<string, unknown> = {}) =>
      blocks((await c.callTool({ name: 'write', arguments: { space: 'handoff', path, content: '# X\n', message: 'm', ...extra } })) as CallToolResult);
    // Exact names (any case) are messages: no address note, only the registration note.
    expect((await write('betabot/a.md')).slice(1)).toEqual([expect.stringMatching(/^Registered as a message to betabot/)]);
    expect(await write('Betabot/b.md')).toHaveLength(2);
    expect(await write('_agents/alice-helper.md')).toHaveLength(1);
    expect(await write('readme.md')).toHaveLength(1);
    expect((await write('zzz/a.md')).slice(1)).toEqual([
      "Note: 'zzz' is not an agent name; recipients find documents only under their exact name.",
    ]);
    expect(await write('zzz/a.md', { expected_rev: 1, content: '# Y\n' })).toHaveLength(1); // not a creation
    // Other spaces are never checked.
    const other = (await c.callTool({ name: 'write', arguments: { space: 'shared', path: 'zzz/a.md', content: '# X\n', message: 'm' } })) as CallToolResult;
    expect(blocks(other)).toHaveLength(1);
  });

  it('move into an unknown folder gets the note; disabled principals do not count', async () => {
    const c = await oriented(w.tokens['alice-helper']);
    await c.callTool({ name: 'write', arguments: { space: 'handoff', path: 'betabot/x.md', content: '# X\n', message: 'm' } });
    const m = (await c.callTool({ name: 'move', arguments: { space: 'handoff', path: 'betabot/x.md', to_path: 'beta/x.md', expected_rev: 1, message: 'mv' } })) as CallToolResult;
    expect(m.isError).toBeFalsy();
    expect(blocks(m)[1]).toContain("'beta' is not an agent name");
    expect(blocks(m)[1]).toContain("(e.g. 'betabot')");
    const p = createPrincipal(h.core, { name: 'gone-bot', kind: 'agent', trust: 'limited', ownerId: w.principals.alice.id }, w.principals.alice.id);
    const space = w.spaces.handoff;
    // Without read on its folder the principal is not a recipient.
    expect(recipientCheck(h.core, space, 'gone-bot/a.md')).toContain("'gone-bot' is not an agent name");
    setGrant(h.core, { spaceId: space.id, scope: 'space', pathPrefix: null, docId: null, role: 'read', subjectType: 'principal', subjectId: p.id }, w.principals.alice.id);
    expect(recipientCheck(h.core, space, 'gone-bot/a.md')).toBeUndefined();
    h.core.db.prepare('UPDATE principals SET disabled_at = 1 WHERE id = ?').run(p.id);
    expect(recipientCheck(h.core, space, 'gone-bot/a.md')).toContain("'gone-bot' is not an agent name");
  });
});

describe('agent cards do not expire', () => {
  const janitor = () => runJanitor(h.core, { readOps: readOpNames() });
  const expiresAt = (id: string) => (h.core.db.prepare('SELECT expires_at AS e FROM documents WHERE id = ?').get(id) as { e: number | null }).e;

  it('cards have no expires_at (even with ttl_days) and survive the janitor; other handoff docs still expire', async () => {
    const card = await w.client('alphabot').call<WriteResult>('write', { space: 'handoff', path: '_agents/alphabot.md', content: '# Alphabot\n', expected_rev: 0, ttl_days: 3, message: 'card' });
    expect(card.doc!.expires_at).toBeUndefined();
    const task = await leave('alice-helper', 'notes/task.md', 'Task'); // not a message
    expect(task.doc!.expires_at).toBeDefined();
    await w.client('alphabot').call('write', { space: 'handoff', path: '_agents/alphabot.md', content: '# Alphabot 2\n', expected_rev: 1, message: 'upd' });
    expect(expiresAt(card.doc!.id)).toBeNull();
    h.clock.advanceDays(30);
    expect(janitor().expired).toBe(1);
    const read = await w.client('alphabot').call<{ content: string }>('read', { space: 'handoff', path: '_agents/alphabot.md' });
    expect(read.content).toBe('# Alphabot 2\n');
  });

  it('moving into _agents clears the TTL; moving out sets the space TTL', async () => {
    const d = await leave('alice-helper', 'draft.md', 'Draft');
    await w.client('alice-helper').call('move', { id: d.doc!.id, to_path: '_agents/alice-helper.md', expected_rev: 1, message: 'mv' });
    expect(expiresAt(d.doc!.id)).toBeNull();
    await w.client('alice-helper').call('move', { id: d.doc!.id, to_path: 'old/alice-helper.md', expected_rev: 2, message: 'mv' });
    expect(expiresAt(d.doc!.id)! - h.clock.now()).toBeGreaterThan(13 * 86400000);
  });

  it('the janitor clears a stray expires_at on a card instead of expiring it; the migration clears existing ones', async () => {
    const card = await w.client('betabot').call<WriteResult>('write', { space: 'handoff', path: '_agents/betabot.md', content: '# Betabot\n', expected_rev: 0, message: 'card' });
    const set = h.core.db.prepare('UPDATE documents SET expires_at = ? WHERE id = ?');
    set.run(h.clock.now() - 1000, card.doc!.id);
    expect(janitor().expired).toBe(0);
    expect(expiresAt(card.doc!.id)).toBeNull();

    // Migration 0005: the UPDATE part only (the column exists already).
    const sql = loadMigrations().find((m) => m.name === '0005_handoff.sql')!.sql;
    const update = sql.slice(sql.indexOf('UPDATE'));
    set.run(h.clock.now() + 1000, card.doc!.id);
    const task = await leave('alice-helper', 'notes/task.md', 'Task');
    h.core.db.exec(update);
    expect(expiresAt(card.doc!.id)).toBeNull();
    expect(expiresAt(task.doc!.id)).not.toBeNull();
  });
});

describe('docs', () => {
  it('/agents.md, the connect README, the handoff AGENTS.md text and the connect guide explain messages', async () => {
    const md = buildAgentsMd('https://brain.example');
    expect(md).toContain('`handoff_send(to, title, body)`');
    expect(md).toContain('Your own inbox is `handoff/<your name>/`: start_here shows it');
    expect(md).toContain('`handoff_ack(id, expected_rev, status)`');
    const readme = fs.readFileSync(new URL('../../docs/connect/README.md', import.meta.url), 'utf8');
    expect(readme).toContain('`handoff_send(to, title, body, reply_to?)`');
    expect(readme).toContain('[handoff-AGENTS.md](handoff-AGENTS.md)');
    const agents = fs.readFileSync(new URL('../../docs/connect/handoff-AGENTS.md', import.meta.url), 'utf8');
    for (const s of ['handoff_send', 'handoff_inbox', 'handoff_ack', 'reply_to', 'no secrets']) expect(agents).toContain(s);
    const guide = await w.client('alice').call<{ text: string }>('admin_connect_guide', { principal: 'alphabot', harness: 'letta', transport: 'http' });
    expect(guide.text).toContain('Other agents and alice reach alphabot with handoff_send.');
    expect(guide.text).toContain('/api/v1/inbox');
  });
});
