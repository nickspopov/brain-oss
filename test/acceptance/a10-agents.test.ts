// a10 (automated part): the "drop off → ready → pick up" scenario in handoff with two agents
// (alice-assistant and alice-helper) using the MCP SDK client, over streamable HTTP (/mcp/v1)
// and over the brain-mcp stdio proxy (a real process, as a harness launches it).
// The manual part (real Claude, Hermes, Letta following the guide) is in docs/connect/acceptance.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, ok, textOf, tool, type Connected } from '../helpers/clients/sdk.js';
import type { ChangesResult, HistoryResult, ReadResult, SearchResult, WriteResult } from '../helpers/api.js';
import { buildWorld, type PrincipalName, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

describe.each(['http', 'stdio'] as const)('a10: handoff by two agents over MCP (%s)', (transport) => {
  let h: Harness;
  let w: World;
  const agents = {} as Record<'claude' | 'hermes', Connected>;
  const PEOPLE: Record<'claude' | 'hermes', PrincipalName> = { claude: 'alice-assistant', hermes: 'alice-helper' };

  beforeAll(async () => {
    h = await startHarness();
    w = buildWorld(h, 'mcp');
    agents.claude = await connectAgent(h, w.tokens['alice-assistant'], transport);
    agents.hermes = await connectAgent(h, w.tokens['alice-helper'], transport);
  });
  afterAll(async () => {
    for (const a of Object.values(agents)) await a.client.close();
    await h?.close();
  });

  it('both agents connect: instructions say call start_here, tools come from the registry', async () => {
    for (const who of ['claude', 'hermes'] as const) {
      const c = agents[who].client;
      expect(c.getServerVersion()?.name).toBe('brain');
      expect(c.getInstructions() ?? '').toMatch(/start_here/);
      const names = (await c.listTools()).tools.map((t) => t.name);
      for (const op of ['start_here', 'whoami', 'spaces', 'changes', 'search', 'read', 'write', 'edit', 'history']) expect(names).toContain(op);
      expect(names.some((n) => n.startsWith('admin_'))).toBe(false);
      const me = await ok<{ principal: { name: string }; spaces: { slug: string; role: string }[] }>(c, 'whoami');
      expect(me.out.principal.name).toBe(PEOPLE[who]);
      expect(me.out.spaces.find((s) => s.slug === 'handoff')?.role).toBe('write');
      expect(me.text).toContain(PEOPLE[who]);
    }
  });

  it('put → ready → take: changes, search, read with the envelope, edits with expected_rev; authors and via=mcp in history', async () => {
    const claude = agents.claude.client;
    const hermes = agents.hermes.client;
    const word = `handoffword${transport}`;
    const docPath = `tasks/${transport}-report.md`;

    // Hermes remembers the feed cursor before starting.
    const start = await ok<ChangesResult>(hermes, 'changes', {});
    const startClaude = await ok<ChangesResult>(claude, 'changes', {});

    // Drop off: Claude writes a draft, then marks it "ready".
    const put = await ok<WriteResult>(claude, 'write', {
      space: 'handoff',
      path: docPath,
      content: `---\nstatus: draft\n---\n# Report for Hermes\n\nSummary ${word}: three findings.\n`,
      expected_rev: 0,
      message: 'put the report',
      request_id: `a10-put-${transport}`,
    });
    expect(put.out.status).toBe('committed');
    const docId = put.out.doc!.id;
    const ready = await ok<WriteResult>(claude, 'edit', {
      id: docId,
      edits: [{ old_text: 'status: draft', new_text: 'status: ready' }],
      expected_rev: 1,
      message: 'ready for Hermes',
    });
    expect(ready.out.doc?.rev).toBe(2);

    // Ready: Hermes sees it in the feed and in search.
    const feed = await ok<ChangesResult>(hermes, 'changes', { since: start.out.cursor });
    const mine = feed.out.changes.filter((ch) => ch.doc.id === docId);
    expect(mine.map((ch) => ch.rev)).toEqual([1, 2]);
    expect(mine.every((ch) => ch.author.name === 'alice-assistant' && ch.doc.space === 'handoff' && ch.doc.path === docPath)).toBe(true);
    const found = await ok<SearchResult>(hermes, 'search', { query: word, spaces: ['handoff'] });
    expect(found.out.results.map((r) => r.doc.id)).toContain(docId);

    // Pick up: Hermes reads (envelope with author and nonce) and changes the status against the revision it read.
    const read = await ok<ReadResult>(hermes, 'read', { id: docId });
    expect(read.out.content).toContain('status: ready');
    expect(read.out.doc.rev).toBe(2);
    expect(read.out.doc.author).toMatchObject({ name: 'alice-assistant', trust: 'admin' });
    const nonce = /BEGIN CONTENT ([A-Za-z0-9_-]{12,})/.exec(read.text)?.[1];
    expect(nonce).toBeDefined();
    expect(read.text.trimEnd().endsWith(`END CONTENT ${nonce}`)).toBe(true);
    expect(read.text).toContain('alice-assistant');
    const take = await ok<WriteResult>(hermes, 'edit', {
      id: docId,
      edits: [{ old_text: 'status: ready', new_text: 'status: taken by alice-helper' }],
      expected_rev: read.out.doc.rev,
      message: 'taken',
      request_id: `a10-take-${transport}`,
    });
    expect(take.out.doc?.rev).toBe(3);

    // Repeating "pick up" with the same request_id (response lost): same response, one revision.
    const again = await ok<WriteResult>(hermes, 'edit', {
      id: docId,
      edits: [{ old_text: 'status: ready', new_text: 'status: taken by alice-helper' }],
      expected_rev: read.out.doc.rev,
      message: 'taken',
      request_id: `a10-take-${transport}`,
    });
    expect(again.out.doc?.rev).toBe(3);

    // Claude sees that it was picked up.
    const back = await ok<ChangesResult>(claude, 'changes', { since: startClaude.out.cursor });
    expect(back.out.changes.filter((ch) => ch.doc.id === docId).map((ch) => [ch.rev, ch.author.name])).toEqual([[3, 'alice-helper']]);
    const final = await ok<ReadResult>(claude, 'read', { space: 'handoff', path: docPath });
    expect(final.out.content).toContain('status: taken by alice-helper');

    const hist = await ok<HistoryResult>(claude, 'history', { id: docId });
    expect(hist.out.revisions.map((r) => [r.rev, r.author.name, r.message])).toEqual([
      [3, 'alice-helper', 'taken'],
      [2, 'alice-assistant', 'ready for Hermes'],
      [1, 'alice-assistant', 'put the report'],
    ]);
    const via = h.core.db.prepare('SELECT DISTINCT via FROM revisions WHERE doc_id = ?').all(docId) as { via: string }[];
    expect(via).toEqual([{ via: 'mcp' }]);
    expect(h.doctor().ok).toBe(true);
  });

  it('a conflicting take is reported as a tool error with the current text', async () => {
    const claude = agents.claude.client;
    const target = { space: 'handoff', path: `tasks/${transport}-race.md` };
    await ok<WriteResult>(claude, 'write', { ...target, content: 'status: ready\n', expected_rev: 0, message: 'put' });
    await ok<WriteResult>(claude, 'write', { ...target, content: 'status: changed\n', expected_rev: 1, message: 'change' });
    const r = await tool(agents.hermes.client, 'write', {
      ...target,
      content: 'status: taken\n',
      expected_rev: 1,
      message: 'take',
    });
    expect(r.isError).toBe(true);
    const text = textOf(r);
    expect(text).toMatch(/^ERROR conflict: /);
    expect(text).toContain('status: changed');
    expect((r.structuredContent as { error: { code: string } }).error.code).toBe('conflict');
  });

  it('the token never shows up in the proxy output', () => {
    for (const who of ['claude', 'hermes'] as const) {
      expect(agents[who].stderr()).not.toContain(w.tokens[PEOPLE[who]]);
    }
  });
});
