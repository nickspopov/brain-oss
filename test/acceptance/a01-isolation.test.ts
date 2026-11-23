// alphabot receives no proj-beta canary through any operation or any route;
// an addressed request for something hidden is indistinguishable from one for something nonexistent.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listOps, isVisibleTo } from '../../src/ops/registry.js';
import type { ChangesResult, ListResult, ReadResult, SearchResult, WriteResult } from '../helpers/api.js';
import { ADAPTERS, type AdapterName, type Client, type RawResponse } from '../helpers/clients/index.js';
import {
  assertNoMarkers,
  buildWorld,
  hiddenMarkers,
  RANDOM_ID,
  seedBeta,
  type BetaDocs,
  type World,
} from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';
import { requireOp } from '../helpers/pending.js';

/** Response without the encrypted cursor: everything else must match byte for byte. */
function withoutCursor(r: RawResponse): string {
  const body = JSON.parse(r.text) as { ok: boolean; result?: Record<string, unknown> };
  if (body.result) {
    delete body.result.cursor;
    delete body.result.next_cursor;
  }
  return JSON.stringify({ status: r.status, body });
}

/** A proposal in proj-beta with a canary (author alice-helper with the propose role): a target for the registry walk. */
async function seedHiddenProposal(w: World): Promise<string> {
  w.grant('proj-beta', { principal: 'alice-helper' }, 'propose');
  const p = await w.client('alice-helper').call<{ proposal: { id: string } }>('propose', {
    space: 'proj-beta',
    path: `${w.canary.folder}/proposal-${w.canary.path}.md`,
    content: `# Proposal ${w.canary.title}\n\n${w.canary.body}\n`,
    message: `proposal ${w.canary.message}`,
  });
  return p.proposal.id;
}

/** Response to an addressed request: code, message, shape, without the input data. */
function shape(r: RawResponse): string {
  return JSON.stringify({ status: r.status, body: JSON.parse(r.text) as unknown });
}

describe.each(ADAPTERS)('a01 isolation via %s', (adapter: AdapterName) => {
  let h: Harness;
  let w: World;
  let alphabot: Client;

  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h, adapter);
    alphabot = w.client('alphabot');
  });
  afterEach(async () => {
    // One audit line per operation call made by the scenario.
    expect(h.auditedCalls()).toBe(h.opCalls());
    await h.close();
  });

  it('whoami of alphabot carries no hidden markers', async () => {
    const r = await alphabot.raw('whoami');
    expect(r.status).toBe(200);
    assertNoMarkers(r.text, hiddenMarkers(w), 'whoami');
  });

  it('whoami and spaces show exactly the visible spaces', async () => {
    requireOp('spaces');
    const me = await alphabot.call<{ spaces: { slug: string; role: string }[] }>('whoami');
    expect(me.spaces.map((s) => s.slug).sort()).toEqual(['handoff', 'proj-alpha', 'recipes', 'shared']);
    expect(me.spaces.find((s) => s.slug === 'shared')?.role).toBe('read');
    const sp = await alphabot.raw('spaces');
    assertNoMarkers(sp.text, hiddenMarkers(w), 'spaces');
    const list = (sp.body.ok ? (sp.body.result as { spaces: { slug: string }[] }).spaces : []).map((s) => s.slug).sort();
    expect(list).toEqual(['handoff', 'proj-alpha', 'recipes', 'shared']);
  });

  it('direct read by id and by path → not_found identical to a random id', async () => {
    const docs = await seedBeta(w);
    const missingById = shape(await alphabot.raw('read', { id: RANDOM_ID }));
    const missingByPath = shape(await alphabot.raw('read', { space: 'proj-alpha', path: 'no/such/doc.md' }));
    expect(JSON.parse(missingById).status).toBe(404);
    for (const d of [docs.secret.doc, docs.plain.doc]) {
      expect(shape(await alphabot.raw('read', { id: d.id }))).toBe(missingById);
      expect(shape(await alphabot.raw('read', { space: 'proj-beta', path: d.path }))).toBe(missingByPath);
      expect(shape(await alphabot.raw('read', { space: 'proj-beta', path: 'no/such/doc.md' }))).toBe(missingByPath);
    }
    // The document is visible to its author: checks that the hidden thing really exists.
    const own = await w.client('betabot').call<ReadResult>('read', { id: docs.secret.doc.id });
    expect(own.content).toContain(w.canary.body);
  });

  it('history, diff, changes, activity, search, list leak nothing', async () => {
    const docs = await seedBeta(w);
    const markers = hiddenMarkers(w, docs);
    for (const id of [docs.secret.doc.id, docs.plain.doc.id]) {
      expect(shape(await alphabot.raw('history', { id }))).toBe(shape(await alphabot.raw('history', { id: RANDOM_ID })));
      expect(shape(await alphabot.raw('diff', { id, from: 1, to: 'head' }))).toBe(
        shape(await alphabot.raw('diff', { id: RANDOM_ID, from: 1, to: 'head' })),
      );
    }
    for (const q of [w.canary.title, w.canary.body, w.canary.tag, w.canary.path, w.canary.message, 'roadmap launch code word']) {
      const r = await alphabot.raw<SearchResult>('search', { query: q });
      expect(r.status).toBe(200);
      assertNoMarkers(r.text, markers, `search "${q.slice(0, 6)}"`);
      const targeted = await alphabot.raw<SearchResult>('search', { query: q, spaces: ['proj-beta'] });
      assertNoMarkers(targeted.text, markers, 'search in proj-beta');
    }
    for (const input of [{}, { include_own: true }, { attention_only: true }, { spaces: ['proj-beta'] }]) {
      assertNoMarkers((await alphabot.raw<ChangesResult>('changes', input)).text, markers, 'changes');
    }
    for (const input of [{}, { space: 'proj-beta' }, { author: 'betabot' }]) {
      assertNoMarkers((await alphabot.raw('activity', input)).text, markers, 'activity');
    }
    const listHidden = await alphabot.raw<ListResult>('list', { space: 'proj-beta' });
    expect(shape(listHidden)).toBe(shape(await alphabot.raw('list', { space: 'no-such-space' })));
    for (const space of ['shared', 'proj-alpha', 'handoff', 'recipes']) {
      assertNoMarkers((await alphabot.raw('list', { space, depth: 5, include_deleted: true })).text, markers, `list ${space}`);
    }
  });

  it('registry walk: every exposed operation, addressed and broad inputs', async () => {
    const docs = await seedBeta(w);
    const markers = hiddenMarkers(w, docs);
    const target = {
      space: 'proj-beta',
      paths: [docs.paths.secret, docs.paths.plain],
      docIds: [docs.secret.doc.id, docs.plain.doc.id],
      proposalIds: [await seedHiddenProposal(w)],
      queries: [w.canary.title, w.canary.body, w.canary.tag],
    };
    markers.push(...target.proposalIds);
    const caller = { principal: { id: w.principals.alphabot.id, name: 'alphabot', kind: 'agent' as const, role: 'member' as const, trust: 'limited' as const }, via: adapter, ip: null };
    // Orient first: otherwise the one-time "not oriented yet" note lands on whichever
    // call comes first and the hidden/missing pair would differ by that note alone.
    expect((await alphabot.raw('start_here', {})).status).toBe(200);
    let checked = 0;
    for (const op of listOps()) {
      if (!isVisibleTo(op, caller)) {
        // An invisible operation (admin_*) is indistinguishable from a nonexistent one for alphabot.
        expect(shape(await alphabot.raw(op.name, {}))).toBe(shape(await alphabot.raw('no_such_operation', {})));
        continue;
      }
      if (op.isolation.kind === 'not_applicable') continue;
      const { addressed, broad } = op.isolation.build(target);
      for (const a of addressed) {
        const hidden = await alphabot.raw(op.name, a.input);
        const missing = await alphabot.raw(op.name, a.missing);
        assertNoMarkers(hidden.text + JSON.stringify(hidden.headers), markers, `${op.name} addressed`);
        // The cursor is random in every response: everything except it is compared.
        expect(withoutCursor(hidden), `${op.name} addressed`).toBe(withoutCursor(missing));
        checked++;
      }
      for (const b of broad) {
        const r = await alphabot.raw(op.name, b);
        assertNoMarkers(r.text + JSON.stringify(r.headers), markers, `${op.name} broad`);
        checked++;
      }
    }
    // The test must actually walk the read operations, not just whoami.
    requireOp('search');
    expect(checked).toBeGreaterThan(10);
  });

  it('changes for alphabot are byte-identical with and without events in the hidden space', async () => {
    const hermes = w.client('alice-helper');
    await hermes.call<WriteResult>('write', { space: 'shared', path: 'visible.md', content: '# Visible\n', message: 'visible' });
    const first = await alphabot.call<ChangesResult>('changes', {});
    const since = first.cursor;
    const before = await alphabot.raw<ChangesResult>('changes', { since });
    const docs = await seedBeta(w);
    const betabot = w.client('betabot');
    await betabot.call('write', {
      space: 'proj-beta',
      path: docs.paths.plain,
      content: `# Notes\n\nupdated ${w.canary.body}\n`,
      expected_rev: 1,
      message: `update ${w.canary.message}`,
    });
    await betabot.call('delete', { id: docs.plain.doc.id });
    const after = await alphabot.raw<ChangesResult>('changes', { since });
    expect(withoutCursor(after)).toBe(withoutCursor(before));
  });

  describe('special cases', () => {
    it('narrow none on a folder hides it inside a readable space', async () => {
      const hermes = w.client('alice-helper');
      const c = w.canary;
      const hidden = await hermes.call<WriteResult>('write', {
        space: 'shared',
        path: `private/${c.path}.md`,
        content: `# ${c.title}\n\n${c.body}\n`,
        message: 'private note',
      });
      await hermes.call('write', { space: 'shared', path: 'public/readme.md', content: '# Readme\n', message: 'public' });
      w.grant('shared', { principal: 'alphabot' }, 'none', { path: 'private/' });
      const markers = [...hiddenMarkers(w), hidden.doc!.id];
      expect(shape(await alphabot.raw('read', { id: hidden.doc!.id }))).toBe(shape(await alphabot.raw('read', { id: RANDOM_ID })));
      const root = await alphabot.call<ListResult>('list', { space: 'shared' });
      expect(root.entries.map((e) => e.path)).not.toContain('private');
      expect(root.entries.map((e) => e.path)).toContain('public');
      assertNoMarkers((await alphabot.raw('list', { space: 'shared', depth: 5 })).text, markers, 'list');
      assertNoMarkers((await alphabot.raw('search', { query: c.body })).text, markers, 'search');
      assertNoMarkers((await alphabot.raw('changes', {})).text, markers, 'changes');
      // A narrower grant widens: write on a folder with read on the space.
      w.grant('shared', { principal: 'alphabot' }, 'write', { path: 'public/' });
      const ok = await alphabot.call<WriteResult>('write', { space: 'shared', path: 'public/alpha.md', content: 'hi\n', message: 'alpha' });
      expect(ok.status).toBe('committed');
    });

    it('a grant on one document shows only that document', async () => {
      const docs = await seedBeta(w);
      w.grant('proj-beta', { principal: 'alphabot' }, 'read', { docId: docs.plain.doc.id });
      const r = await alphabot.call<ReadResult>('read', { id: docs.plain.doc.id });
      expect(r.doc.id).toBe(docs.plain.doc.id);
      expect(shape(await alphabot.raw('read', { id: docs.secret.doc.id }))).toBe(shape(await alphabot.raw('read', { id: RANDOM_ID })));
      const list = await alphabot.call<ListResult>('list', { space: 'proj-beta', depth: 5 });
      expect(list.entries.map((e) => e.path)).toEqual(['notes.md']);
      const secretMarkers = [w.canary.title, w.canary.tag, w.canary.path, w.canary.folder, docs.secret.doc.id];
      assertNoMarkers(JSON.stringify(list), secretMarkers, 'list with doc grant');
      const spaces = await alphabot.call<{ spaces: { slug: string }[] }>('spaces');
      expect(spaces.spaces.map((s) => s.slug)).toContain('proj-beta');
    });

    it('group grant applies, and stops applying on the next call after leaving the group', async () => {
      const docs = await seedBeta(w);
      const alice = w.client('alice');
      await alice.call('admin_group_create', { name: 'beta-readers', description: 'test' });
      await alice.call('admin_group_members_set', { name: 'beta-readers', members: ['alphabot'] });
      await alice.call('admin_grant_set', { space: 'proj-beta', scope: 'doc', doc_id: docs.plain.doc.id, subject: { type: 'group', name: 'beta-readers' }, role: 'read' });
      expect((await alphabot.call<ReadResult>('read', { id: docs.plain.doc.id })).doc.id).toBe(docs.plain.doc.id);
      // A personal grant at the same level beats a group grant.
      await alice.call('admin_grant_set', { space: 'proj-beta', scope: 'doc', doc_id: docs.plain.doc.id, subject: { type: 'principal', name: 'alphabot' }, role: 'none' });
      expect(shape(await alphabot.raw('read', { id: docs.plain.doc.id }))).toBe(shape(await alphabot.raw('read', { id: RANDOM_ID })));
      await alice.call('admin_grant_remove', { space: 'proj-beta', scope: 'doc', doc_id: docs.plain.doc.id, subject: { type: 'principal', name: 'alphabot' } });
      expect((await alphabot.call<ReadResult>('read', { id: docs.plain.doc.id })).doc.id).toBe(docs.plain.doc.id);
      await alice.call('admin_group_members_set', { name: 'beta-readers', members: [] });
      expect(shape(await alphabot.raw('read', { id: docs.plain.doc.id }))).toBe(shape(await alphabot.raw('read', { id: RANDOM_ID })));
    });

    it('moving a document from visible to invisible and back', async () => {
      const hermes = w.client('alice-helper');
      w.grant('shared', { principal: 'alphabot' }, 'none', { path: 'private/' });
      const created = await hermes.call<WriteResult>('write', { space: 'shared', path: 'open/a.md', content: '# A\n', message: 'a' });
      const id = created.doc!.id;
      expect((await alphabot.call<ReadResult>('read', { id })).doc.path).toBe('open/a.md');
      const start = await alphabot.call<ChangesResult>('changes', {});
      await hermes.call('move', { id, to_path: `private/${w.canary.path}.md` });
      expect(shape(await alphabot.raw('read', { id }))).toBe(shape(await alphabot.raw('read', { id: RANDOM_ID })));
      const hiddenNow = await alphabot.raw<ChangesResult>('changes', { since: start.cursor });
      assertNoMarkers(hiddenNow.text, [w.canary.path, id], 'changes after move out');
      await hermes.call('move', { id, to_path: 'open/back.md' });
      const back = await alphabot.call<ReadResult>('read', { id });
      expect(back.doc.path).toBe('open/back.md');
      // A former path in an invisible location is hidden in both history and the feed.
      assertNoMarkers((await alphabot.raw('history', { id })).text, [w.canary.path], 'history after move back');
      assertNoMarkers((await alphabot.raw('changes', { since: start.cursor })).text, [w.canary.path], 'changes after move back');
    });
  });

  it('proposal_* on hidden proposals → not_found identical to a random id', async () => {
    await seedBeta(w);
    w.grant('proj-beta', { principal: 'alice-helper' }, 'propose');
    const p = await w.client('alice-helper').call<{ proposal: { id: string } }>('propose', {
      space: 'proj-beta',
      path: 'notes.md',
      content: `# Notes\n\nproposed ${w.canary.body}\n`,
      base_rev: 1,
      message: 'proposal',
    });
    const id = p.proposal.id;
    for (const op of ['proposal_get', 'proposal_withdraw'] as const) {
      expect(shape(await alphabot.raw(op, { id }))).toBe(shape(await alphabot.raw(op, { id: RANDOM_ID })));
    }
    expect(shape(await alphabot.raw('proposal_decide', { id, decision: 'accept' }))).toBe(
      shape(await alphabot.raw('proposal_decide', { id: RANDOM_ID, decision: 'accept' })),
    );
    for (const input of [{}, { space: 'proj-beta' }, { status: 'open' }]) {
      assertNoMarkers((await alphabot.raw('proposal_list', input)).text, [...hiddenMarkers(w), id], 'proposal_list');
    }
  });

  it('export and /raw of hidden objects → not_found identical to missing ones', async () => {
    const docs: BetaDocs = await seedBeta(w);
    expect(shape(await alphabot.raw('export', { space: 'proj-beta' }))).toBe(shape(await alphabot.raw('export', { space: 'no-such-space' })));
    h.requireRoute('GET', '/api/v1/docs/:id/raw');
    const get = async (url: string) => {
      const res = await fetch(`${h.url}${url}`, { headers: { authorization: `Bearer ${w.tokens.alphabot}` } });
      return { status: res.status, text: await res.text() };
    };
    const hidden = await get(`/api/v1/docs/${docs.secret.doc.id}/raw`);
    const missing = await get(`/api/v1/docs/${RANDOM_ID}/raw`);
    expect(hidden).toEqual(missing);
    const own = await w.client('betabot').call<{ download_path: string }>('export', { space: 'proj-beta' });
    const stolen = await get(own.download_path);
    expect(stolen.status).toBe(404);
    assertNoMarkers(stolen.text, hiddenMarkers(w, docs), 'export download');
  });
});
