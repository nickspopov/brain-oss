// Change feed over REST: changes with a server-side cursor, and activity.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityResult, ChangesResult, WriteResult } from '../helpers/api.js';
import type { Client } from '../helpers/clients/index.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

describe('changes and activity', () => {
  let h: Harness;
  let w: World;
  let hermes: Client;
  let claude: Client;
  let alphabot: Client;

  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h);
    hermes = w.client('alice-helper');
    claude = w.client('alice-assistant');
    alphabot = w.client('alphabot');
  });
  afterEach(async () => {
    await h.close();
  });

  const write = (c: Client, path: string, content: string, extra: Record<string, unknown> = {}) =>
    c.call<WriteResult>('write', { space: 'shared', path, content, message: `write ${path}`, ...extra });
  const changes = (c: Client, input: Record<string, unknown> = {}) => c.call<ChangesResult>('changes', input);
  const summary = (r: ChangesResult) => r.changes.map((c) => `${c.doc.path}#${c.rev}:${c.kind}`);

  it('agent loop: changes() → since(cursor); a lost response is fetched again; own changes skipped', async () => {
    await write(hermes, 'a.md', 'a\n');
    await write(claude, 'mine.md', 'mine\n');
    const r1 = await changes(claude);
    expect(summary(r1)).toEqual(['a.md#1:create']);
    expect(r1.has_more).toBe(false);
    expect(r1.changes[0]).toMatchObject({ doc: { space: 'shared', path: 'a.md', title: 'a' }, author: { name: 'alice-helper', trust: 'trusted' }, message: 'write a.md' });
    // Without since the cursor does not move: "response lost" → the same response.
    expect(summary(await changes(claude))).toEqual(['a.md#1:create']);
    await write(hermes, 'a.md', 'a2\n', { expected_rev: 1 });
    // since commits the cursor and returns what comes after it.
    const r2 = await changes(claude, { since: r1.cursor });
    expect(summary(r2)).toEqual(['a.md#2:update']);
    expect(summary(await changes(claude))).toEqual(['a.md#2:update']);
    const r3 = await changes(claude, { since: r2.cursor });
    expect(r3.changes).toEqual([]);
    expect(summary(await changes(claude, { include_own: true, since: r1.cursor }))).toEqual(['a.md#2:update']);
  });

  it('include_own, spaces and attention_only filters', async () => {
    await write(hermes, 's.md', 's\n');
    await hermes.call('write', { space: 'handoff', path: 'h.md', content: 'h\n', message: 'h' });
    await w.client('alphabot').call('write', { space: 'handoff', path: 'f.md', content: 'f\n', message: 'f' });
    // recipes is executable: an edit by a non-admin is marked attention.
    w.grant('recipes', { principal: 'alice-helper' }, 'write');
    await hermes.call('write', { space: 'recipes', path: 'r.md', content: 'r\n', message: 'r' });
    expect(summary(await changes(hermes)).sort()).toEqual(['f.md#1:create']);
    expect(summary(await changes(hermes, { include_own: true })).length).toBe(4);
    expect(summary(await changes(claude, { spaces: ['handoff'] })).sort()).toEqual(['f.md#1:create', 'h.md#1:create']);
    const att = await changes(claude, { attention_only: true });
    expect(summary(att)).toEqual(['r.md#1:create']);
    expect(att.changes[0]!.attention).toBe(true);
  });

  it('has_more pages through a long feed; cursor of another principal is rejected', async () => {
    for (let i = 0; i < 7; i++) await write(hermes, `n${i}.md`, `${i}\n`);
    const seen: string[] = [];
    let since: string | undefined;
    for (;;) {
      const r = await changes(claude, { limit: 3, ...(since ? { since } : {}) });
      seen.push(...summary(r));
      since = r.cursor;
      if (!r.has_more) break;
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => `n${i}.md#1:create`));
    await expect(changes(alphabot, { since })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(changes(claude, { since: 'not-a-cursor' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('a document that became invisible leaves the feed with its past events', async () => {
    const d = await write(hermes, 'open/x.md', 'x\n');
    expect(summary(await changes(alphabot))).toEqual(['open/x.md#1:create']);
    await hermes.call('move', { id: d.doc!.id, to_path: 'closed/x.md' });
    w.grant('shared', { principal: 'alphabot' }, 'none', { path: 'closed/' });
    expect((await changes(alphabot)).changes).toEqual([]);
    expect((await alphabot.call<ActivityResult>('activity', {})).items).toEqual([]);
  });

  it('activity: newest first, filters, pagination, does not move the changes cursor', async () => {
    await write(hermes, 'a.md', 'a\n');
    await write(claude, 'b.md', 'b\n');
    await hermes.call('write', { space: 'handoff', path: 'c.md', content: 'c\n', message: 'c' });
    const all = await claude.call<ActivityResult>('activity', {});
    expect(all.items.map((i) => i.doc.path)).toEqual(['c.md', 'b.md', 'a.md']);
    expect((await claude.call<ActivityResult>('activity', { space: 'shared' })).items.map((i) => i.doc.path)).toEqual(['b.md', 'a.md']);
    expect((await claude.call<ActivityResult>('activity', { author: 'alice-helper' })).items.map((i) => i.doc.path)).toEqual(['c.md', 'a.md']);
    expect((await claude.call<ActivityResult>('activity', { author: 'nobody' })).items).toEqual([]);
    const p1 = await claude.call<ActivityResult>('activity', { limit: 2 });
    expect(p1.items.map((i) => i.doc.path)).toEqual(['c.md', 'b.md']);
    const p2 = await claude.call<ActivityResult>('activity', { limit: 2, before: p1.next_cursor });
    expect(p2.items.map((i) => i.doc.path)).toEqual(['a.md']);
    expect(p2.next_cursor).toBeUndefined();
    await expect(claude.call('activity', { limit: 2, space: 'shared', before: p1.next_cursor })).rejects.toMatchObject({ code: 'invalid_input' });
    // changes still starts from the beginning.
    expect(summary(await changes(claude))).toEqual(['a.md#1:create', 'c.md#1:create']);
  });

  it('a hidden or unknown space in the filter gives the same empty answer', async () => {
    await w.client('betabot').call('write', { space: 'proj-beta', path: 's.md', content: 's\n', message: 's' });
    const hidden = await alphabot.raw('changes', { spaces: ['proj-beta'] });
    const missing = await alphabot.raw('changes', { spaces: ['no-such-space'] });
    // The cursor is random in every response: everything else matches byte for byte.
    const noCursor = (t: string) => t.replace(/"cursor":"[^"]+"/, '"cursor":"<cursor>"');
    expect(noCursor(hidden.text)).toBe(noCursor(missing.text));
    const ah = await alphabot.raw('activity', { space: 'proj-beta' });
    const am = await alphabot.raw('activity', { space: 'no-such-space' });
    expect(ah.text).toBe(am.text);
  });
});
