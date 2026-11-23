// Search over REST: word forms, phrases, prefix, filters, the index inside the write transaction,
// pagination, isolation (the access filter in SQL before limit and ranking).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextFor, filterDocs, readableDocsFilter } from '../../src/core/guard.js';
import { ensureSearchIndex } from '../../src/core/search/index.js';
import { toAuthenticated } from '../../src/core/tokens.js';
import type { SearchResult, WriteResult } from '../helpers/api.js';
import type { Client } from '../helpers/clients/index.js';
import { buildWorld, type PrincipalName, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

describe('search', () => {
  let h: Harness;
  let w: World;
  let hermes: Client;
  let alphabot: Client;

  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h);
    hermes = w.client('alice-helper');
    alphabot = w.client('alphabot');
  });
  afterEach(async () => {
    expect(h.doctor().problems).toEqual([]);
    await h.close();
  });

  const write = (c: Client, path: string, content: string, extra: Record<string, unknown> = {}) =>
    c.call<WriteResult>('write', { space: 'shared', path, content, message: `write ${path}`, ...extra });
  const search = (c: Client, input: Record<string, unknown>) => c.call<SearchResult>('search', input);
  const paths = (r: SearchResult) => r.results.map((x) => x.doc.path);

  /** Write without HTTP: for hundreds of documents. */
  async function directWrite(who: PrincipalName, space: string, path: string, content: string): Promise<void> {
    const r = await h.app.executor.execute(
      'write',
      { space, path, content, message: 'seed' },
      { principal: toAuthenticated(w.principals[who]), via: 'rest', ip: null },
    );
    if (!r.ok) throw new Error(`seed write failed: ${JSON.stringify(r.error)}`);
  }

  it('finds Russian and English word forms, phrases and prefixes', async () => {
    await write(hermes, 'kitchen/borscht.md', '# Рецепты борща\n\nСвёкла, капуста, картофель.\n');
    await write(hermes, 'ops/deploy.md', '# Deployment notes\n\nWe deployed the server with harness-open and gmail.py.\n');
    await write(hermes, 'ops/other.md', '# Other\n\nThe open harness is not here; py and gmail live apart.\n');
    expect(paths(await search(hermes, { query: 'рецепт' }))).toEqual(['kitchen/borscht.md']);
    expect(paths(await search(hermes, { query: 'свекла' }))).toEqual(['kitchen/borscht.md']);
    expect(paths(await search(hermes, { query: 'deploying' }))).toEqual(['ops/deploy.md']);
    expect(paths(await search(hermes, { query: 'deplo' }))).toEqual(['ops/deploy.md']);
    // A fragment with inner punctuation is a phrase: "gmail py" in a row appears only in deploy.md.
    expect(paths(await search(hermes, { query: 'gmail.py' }))).toEqual(['ops/deploy.md']);
    expect(paths(await search(hermes, { query: 'harness-open' }))).toEqual(['ops/deploy.md']);
    expect(paths(await search(hermes, { query: '"open harness"' }))).toEqual(['ops/other.md']);
  });

  it('documents with all words come first, then any word; snippet and matched_in; no score', async () => {
    await write(hermes, 'a.md', '# Alpha\n\nalpha only here\n');
    await write(hermes, 'ab.md', '# Notes\n\nalpha and bravo together\n');
    const r = await search(hermes, { query: 'alpha bravo' });
    expect(paths(r)).toEqual(['ab.md', 'a.md']);
    const top = r.results[0]!;
    expect(top.matched_in).toEqual(['body']);
    expect(top.snippet.highlights.map(([a, b]) => top.snippet.text.slice(a, b))).toEqual(['alpha', 'bravo']);
    expect(r.results[1]!.matched_in).toEqual(['title', 'headings', 'body']);
    expect(Object.keys(top).sort()).toEqual(['doc', 'matched_in', 'snippet']);
  });

  it('title, tags and path weigh more than the body', async () => {
    await write(hermes, 'body.md', '# Misc\n\nsomething about kubernetes clusters and kubernetes upgrades\n');
    await write(hermes, 'title.md', '# Kubernetes\n\nnotes\n');
    await write(hermes, 'kubernetes/readme.md', '# Readme\n\nnotes\n');
    await write(hermes, 'tagged.md', '---\ntags: [kubernetes]\n---\n# Tagged\n');
    const order = paths(await search(hermes, { query: 'kubernetes' }));
    expect(order.at(-1)).toBe('body.md');
    expect(order[0]).toBe('title.md');
  });

  it('filters: spaces, path_prefix, tags', async () => {
    await write(hermes, 'team/x.md', '---\ntags: [ops, Night]\n---\nzulu text\n');
    await write(hermes, 'team/y.md', '---\ntags: ops\n---\nzulu text\n');
    await write(hermes, 'other/z.md', 'zulu text\n');
    await hermes.call('write', { space: 'handoff', path: 'h.md', content: 'zulu text\n', message: 'h' });
    expect(paths(await search(hermes, { query: 'zulu' })).sort()).toEqual(['h.md', 'other/z.md', 'team/x.md', 'team/y.md']);
    expect(paths(await search(hermes, { query: 'zulu', spaces: ['handoff'] }))).toEqual(['h.md']);
    expect(paths(await search(hermes, { query: 'zulu', path_prefix: 'Team/' })).sort()).toEqual(['team/x.md', 'team/y.md']);
    expect(paths(await search(hermes, { query: 'zulu', tags: ['ops'] })).sort()).toEqual(['team/x.md', 'team/y.md']);
    expect(paths(await search(hermes, { query: 'zulu', tags: ['ops', 'night'] }))).toEqual(['team/x.md']);
    // An invisible and a nonexistent space in the filter give the same empty result.
    const hidden = await hermes.raw('search', { query: 'zulu', spaces: ['proj-beta'] });
    const missing = await hermes.raw('search', { query: 'zulu', spaces: ['no-such-space'] });
    expect(hidden.text).toBe(missing.text);
    expect(hidden.body).toEqual({ ok: true, result: { results: [] } });
  });

  it('the index follows every write in the same transaction: update, move, delete, restore, revert', async () => {
    const created = await write(hermes, 'doc.md', '# Doc\n\nyankee\n');
    const id = created.doc!.id;
    expect(paths(await search(hermes, { query: 'yankee' }))).toEqual(['doc.md']);
    await write(hermes, 'doc.md', '# Doc\n\nxray\n', { expected_rev: 1 });
    expect(paths(await search(hermes, { query: 'yankee' }))).toEqual([]);
    expect(paths(await search(hermes, { query: 'xray' }))).toEqual(['doc.md']);
    await hermes.call('move', { id, to_path: 'moved/whiskey.md' });
    expect(paths(await search(hermes, { query: 'whiskey' }))).toEqual(['moved/whiskey.md']);
    await hermes.call('delete', { id });
    expect(paths(await search(hermes, { query: 'xray' }))).toEqual([]);
    await hermes.call('restore', { id });
    expect(paths(await search(hermes, { query: 'xray' }))).toEqual(['moved/whiskey.md']);
    await hermes.call('revert', { id, to_rev: 1, message: 'back' });
    expect(paths(await search(hermes, { query: 'yankee' }))).toEqual(['moved/whiskey.md']);
  });

  it('files are indexed by title and path only', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    await write(hermes, 'img/diagram-victor.png', '', { content: undefined, content_base64: png.toString('base64') });
    const r = await search(hermes, { query: 'victor' });
    expect(paths(r)).toEqual(['img/diagram-victor.png']);
    expect(r.results[0]!.snippet).toEqual({ text: '', highlights: [] });
  });

  it('pagination: cursor walks the whole list without repeats; cursor is bound to the query and the caller', async () => {
    for (let i = 0; i < 23; i++) await write(hermes, `p/${String(i).padStart(2, '0')}.md`, `tango ${'tango '.repeat(i % 5)}\n`);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await search(hermes, { query: 'tango', limit: 10, ...(cursor ? { cursor } : {}) });
      seen.push(...paths(r));
      cursor = r.next_cursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(23);
    const first = await search(hermes, { query: 'tango', limit: 10 });
    await expect(search(hermes, { query: 'other', limit: 10, cursor: first.next_cursor })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(search(w.client('alice-assistant'), { query: 'tango', limit: 10, cursor: first.next_cursor })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('hostile query syntax is just text', async () => {
    await write(hermes, 'q.md', 'see title: near column\n');
    for (const query of ['NEAR(a b)', 'title:near', '"', '*', 'a OR', ')(', '^column', '{title body}: x', 'NOT near', '\\']) {
      const r = await hermes.raw('search', { query });
      expect(r.status, query).toBe(200);
    }
    expect(paths(await search(hermes, { query: 'title:near' }))).toEqual(['q.md']);
  });

  it('the query string goes to the audit log', async () => {
    await search(hermes, { query: 'audit me please' });
    const row = h.core.db.prepare("SELECT detail FROM audit WHERE op = 'search' ORDER BY id DESC LIMIT 1").get() as { detail: string };
    expect(JSON.parse(row.detail)).toEqual({ query: 'audit me please', results: 0 });
  });

  describe('isolation', () => {
    it('500 hidden matches change neither the visible results nor their order', async () => {
      // Visible documents with different frequencies of two words: the order depends on their idf.
      await write(hermes, 'v/a.md', 'alpha alpha alpha bravo\n');
      await write(hermes, 'v/b.md', 'alpha bravo bravo bravo\n');
      await write(hermes, 'v/c.md', 'alpha charlie\n');
      await write(hermes, 'v/d.md', 'bravo charlie delta\n');
      const queries = ['alpha bravo', 'alpha', 'bravo charlie', 'charlie alpha', 'alp'];
      // The cursor is random in every response: compare its presence, not its value.
      const text = async (query: string) => (await alphabot.raw('search', { query, limit: 3 })).text.replace(/"next_cursor":"[^"]+"/, '"next_cursor":"<cursor>"');
      const before = await Promise.all(queries.map(text));
      // proj-beta has 500 documents where alpha occurs everywhere (alpha's idf drops) and bravo nowhere.
      for (let i = 0; i < 500; i++) await directWrite('betabot', 'proj-beta', `bulk/${i}.md`, `alpha alpha charlie ${i}\n`);
      const after = await Promise.all(queries.map(text));
      expect(after).toEqual(before);
      expect(paths(JSON.parse(before[0]!).result as SearchResult)).toHaveLength(3);
      // betabot sees its own documents: the hidden matches really exist.
      expect((await search(w.client('betabot'), { query: 'alpha', limit: 50 })).results.length).toBe(50);
    }, 120_000);

    it('narrow none on a folder and a grant on one document apply inside the search', async () => {
      await write(hermes, 'private/p.md', 'sierra private\n');
      await write(hermes, 'public/q.md', 'sierra public\n');
      w.grant('shared', { principal: 'alphabot' }, 'none', { path: 'private/' });
      expect(paths(await search(alphabot, { query: 'sierra' }))).toEqual(['public/q.md']);
      const betabot = w.client('betabot');
      const one = await betabot.call<WriteResult>('write', { space: 'proj-beta', path: 'one.md', content: 'sierra one\n', message: 'one' });
      await betabot.call('write', { space: 'proj-beta', path: 'two.md', content: 'sierra two\n', message: 'two' });
      w.grant('proj-beta', { principal: 'alphabot' }, 'read', { docId: one.doc!.id });
      expect(paths(await search(alphabot, { query: 'sierra' })).sort()).toEqual(['one.md', 'public/q.md']);
    });

    it('the SQL access filter agrees with guard.filterDocs for every principal', async () => {
      await write(hermes, 'private/a.md', 'x\n');
      await write(hermes, 'private/deep/b.md', 'x\n');
      await write(hermes, 'public/c.md', 'x\n');
      const betabot = w.client('betabot');
      const s1 = await betabot.call<WriteResult>('write', { space: 'proj-beta', path: 'f/one.md', content: 'x\n', message: 'x' });
      await betabot.call('write', { space: 'proj-beta', path: 'f/two.md', content: 'x\n', message: 'x' });
      await w.client('alphabot').call('write', { space: 'proj-alpha', path: 'mine.md', content: 'x\n', message: 'x' });
      w.grant('shared', { principal: 'alphabot' }, 'none', { path: 'private/' });
      w.grant('shared', { principal: 'alphabot' }, 'read', { path: 'private/deep/' });
      w.grant('proj-beta', { principal: 'alphabot' }, 'read', { docId: s1.doc!.id });
      w.grant('proj-beta', { group: 'all-agents' }, 'read', { path: 'f/' });
      w.grant('proj-beta', { principal: 'alice-helper' }, 'none', { docId: s1.doc!.id });
      w.grant('shared', { group: 'curators' }, 'none', { path: 'public/' });
      const all = h.core.db.prepare('SELECT id AS doc_id, space_id, path_key FROM documents').all() as {
        doc_id: string;
        space_id: string;
        path_key: string;
      }[];
      for (const name of ['alice', 'alice-assistant', 'alice-helper', 'alphabot', 'betabot'] as const) {
        const ctx = contextFor(h.core, toAuthenticated(w.principals[name]));
        const f = readableDocsFilter(ctx);
        const bySql = (h.core.db.prepare(`SELECT d.id FROM documents d WHERE ${f.sql}`).all(...f.params) as { id: string }[])
          .map((r) => r.id)
          .sort();
        const byGuard = filterDocs(ctx, all).map((r) => r.doc_id).sort();
        expect(bySql, name).toEqual(byGuard);
      }
    });
  });

  it('index is rebuilt on start when the tokenizer version changes; doctor notices a broken index', async () => {
    await write(hermes, 'r.md', '# Romeo\n\nromeo juliet\n');
    h.core.db.prepare('DELETE FROM fts_docs').run();
    h.core.db.prepare("UPDATE meta SET value = 'old' WHERE key = 'search.tokenizer'").run();
    expect(h.doctor().problems.join('\n')).toMatch(/search index: 1 live document/);
    expect(ensureSearchIndex(h.core)).toBe(true);
    expect(ensureSearchIndex(h.core)).toBe(false);
    expect(paths(await search(hermes, { query: 'juliet' }))).toEqual(['r.md']);
  });
});
