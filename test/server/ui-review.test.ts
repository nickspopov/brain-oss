// The review screens' path over REST with a session (the same calls and headers that
// web/src/api/client.ts sends): the `activity` feed with filters and the attention flag, the proposal
// queue (diff; a stale one is accepted only with expected_rev), export and download by cookie, audit.
// Also checks that response shapes match the types in web/src/api/types.ts.
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildWorld, ALICE_PASSWORD, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
let w: World;

beforeEach(async () => {
  h = await startHarness();
  w = buildWorld(h);
});
afterEach(async () => {
  await h.close();
});

const uiHeaders = () => ({ 'x-brain-client': 'brain-web', origin: h.config.origin, accept: 'application/json' });

async function login(): Promise<string> {
  const res = await fetch(`${h.url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { ...uiHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'alice', password: ALICE_PASSWORD }),
  });
  expect(res.status).toBe(200);
  const m = /brain_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  if (!m) throw new Error('no cookie');
  return `brain_session=${m[1]}`;
}

type Env<T> = { ok: boolean; result: T; error?: { code: string; details?: Record<string, unknown> } };

async function op<T = Record<string, unknown>>(cookie: string, name: string, input: unknown = {}) {
  const res = await fetch(`${h.url}/api/v1/ops/${name}`, {
    method: 'POST',
    headers: { ...uiHeaders(), 'content-type': 'application/json', cookie },
    body: JSON.stringify(input),
  });
  return { status: res.status, body: (await res.json()) as Env<T> };
}

type Item = { rev: number; kind: string; attention: boolean; author: { name: string; trust: string }; doc: { id: string; space: string; path: string; title: string } };
type Proposal = { id: string; status: string; base_rev: number; doc_id?: string; human_required: boolean; result_rev?: number; decided_by?: { name: string } };

const CHANGE_KEYS = ['attention', 'author', 'content_hash', 'created_at', 'doc', 'kind', 'message', 'purged', 'rev', 'size', 'via'];
const PROPOSAL_KEYS = ['author', 'base_rev', 'content_hash', 'created_at', 'doc_id', 'human_required', 'id', 'message', 'path', 'size', 'space', 'status'];

describe('UI feed, proposals, export and audit over REST with a session cookie', () => {
  it('activity: newest first, attention marks non-admin edits in executable spaces, space and author filters, before cursor', async () => {
    w.grant('recipes', { principal: 'alice-helper' }, 'write');
    const hermes = w.client('alice-helper');
    await hermes.call('write', { space: 'recipes', path: 'soup.md', content: '# Soup\n', message: 'recipe' });
    await hermes.call('write', { space: 'shared', path: 'notes.md', content: '# Notes\n', message: 'notes' });
    await w.client('alice-assistant').call('write', { space: 'shared', path: 'curator.md', content: '# C\n', message: 'curator' });
    const cookie = await login();

    const all = await op<{ items: Item[]; next_cursor?: string }>(cookie, 'activity', { limit: 50 });
    expect(all.status).toBe(200);
    const items = all.body.result.items;
    expect(items.map((i) => i.doc.path)).toEqual(['curator.md', 'notes.md', 'soup.md']);
    for (const i of items) expect(Object.keys(i).filter((k) => CHANGE_KEYS.includes(k)).sort()).toEqual(CHANGE_KEYS);
    // "Needs attention" is only an edit by a non-admin in an executable space.
    expect(items.map((i) => i.attention)).toEqual([false, false, true]);

    const bySpace = await op<{ items: Item[] }>(cookie, 'activity', { space: 'recipes', limit: 50 });
    expect(bySpace.body.result.items.map((i) => i.doc.path)).toEqual(['soup.md']);
    const byAuthor = await op<{ items: Item[] }>(cookie, 'activity', { author: 'alice-assistant', limit: 50 });
    expect(byAuthor.body.result.items.map((i) => i.doc.path)).toEqual(['curator.md']);

    const first = await op<{ items: Item[]; next_cursor?: string }>(cookie, 'activity', { limit: 2 });
    expect(first.body.result.next_cursor).toBeTruthy();
    const next = await op<{ items: Item[]; next_cursor?: string }>(cookie, 'activity', { limit: 2, before: first.body.result.next_cursor });
    expect(next.body.result.items.map((i) => i.doc.path)).toEqual(['soup.md']);
    expect(next.body.result.next_cursor).toBeUndefined();
  });

  it('proposal queue: list open → get diff → stale accept refused → accept with the seen expected_rev → accepted with approved_by', async () => {
    const hermes = w.client('alice-helper');
    const created = await hermes.call<{ doc: { rev: number } }>('write', { space: 'shared', path: 'plan.md', content: 'line one\n', message: 'v1' });
    const proposed = await hermes.call<{ proposal: Proposal }>('propose', { space: 'shared', path: 'plan.md', content: 'line one\nline two\n', base_rev: created.doc.rev, message: 'add a line' });
    const id = proposed.proposal.id;
    const cookie = await login();

    const list = await op<{ proposals: Proposal[] }>(cookie, 'proposal_list', { status: 'open', limit: 50 });
    expect(list.body.result.proposals.map((p) => p.id)).toEqual([id]);
    expect(Object.keys(list.body.result.proposals[0]!).filter((k) => PROPOSAL_KEYS.includes(k)).sort()).toEqual(PROPOSAL_KEYS);

    const got = await op<{ proposal: Proposal; content: string; diff: string; stale: boolean }>(cookie, 'proposal_get', { id });
    expect(got.body.result.stale).toBe(false);
    expect(got.body.result.diff).toContain('+line two');
    expect(got.body.result.content).toBe('line one\nline two\n');

    // While the human was reading, the head moved on.
    await w.client('alice-assistant').call('write', { space: 'shared', path: 'plan.md', content: 'line one!\n', expected_rev: created.doc.rev, message: 'v2' });
    const stale = await op<{ proposal: Proposal; diff: string; stale: boolean }>(cookie, 'proposal_get', { id });
    expect(stale.body.result.stale).toBe(true);
    expect(stale.body.result.diff).toContain('-line one!');

    const refused = await op(cookie, 'proposal_decide', { id, decision: 'accept', request_id: 'ui-accept-1-xxxxxxxx' });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.details?.reason).toBe('stale_proposal');
    const current = refused.body.error?.details?.current as { rev: number } | undefined;
    expect(current?.rev).toBe(2);

    const head = await op<{ doc: { rev: number } }>(cookie, 'read', { id: proposed.proposal.doc_id, format: 'meta' });
    expect(head.body.result.doc.rev).toBe(2);
    const accepted = await op<{ proposal: Proposal; doc: { rev: number; author: { name: string }; approved_by?: { name: string } } }>(cookie, 'proposal_decide', {
      id,
      decision: 'accept',
      expected_rev: 2,
      note: 'ok',
      request_id: 'ui-accept-2-xxxxxxxx',
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.result.proposal).toMatchObject({ status: 'accepted', result_rev: 3, decided_by: { name: 'alice' } });
    expect(accepted.body.result.doc).toMatchObject({ rev: 3, author: { name: 'alice-helper' }, approved_by: { name: 'alice' } });
    // Replaying the same intent (the network dropped) does not accept twice.
    const replay = await op<{ proposal: Proposal }>(cookie, 'proposal_decide', { id, decision: 'accept', expected_rev: 2, note: 'ok', request_id: 'ui-accept-2-xxxxxxxx' });
    expect(replay.body.result.proposal.status).toBe('accepted');
    const open = await op<{ proposals: Proposal[] }>(cookie, 'proposal_list', { status: 'open', limit: 50 });
    expect(open.body.result.proposals).toEqual([]);
  });

  it('reject with a note; an executable-space proposal from a non-admin is human_required and a human accepts it', async () => {
    w.grant('recipes', { principal: 'alice-helper' }, 'propose');
    const hermes = w.client('alice-helper');
    const p1 = await hermes.call<{ proposal: Proposal }>('propose', { space: 'shared', path: 'x.md', content: 'x\n', message: 'x' });
    const p2 = await hermes.call<{ proposal: Proposal }>('propose', { space: 'recipes', path: 'r.md', content: 'r\n', message: 'r' });
    expect(p2.proposal.human_required).toBe(true);
    const cookie = await login();
    const rejected = await op<{ proposal: Proposal & { decision_note?: string } }>(cookie, 'proposal_decide', { id: p1.proposal.id, decision: 'reject', note: 'not this', request_id: 'ui-reject-1-xxxxxxx' });
    expect(rejected.body.result.proposal).toMatchObject({ status: 'rejected', decision_note: 'not this' });
    const again = await op(cookie, 'proposal_decide', { id: p1.proposal.id, decision: 'accept', request_id: 'ui-accept-x-xxxxxxx' });
    expect(again.body.error?.details?.reason).toBe('not_open');
    const ok = await op<{ proposal: Proposal }>(cookie, 'proposal_decide', { id: p2.proposal.id, decision: 'accept', request_id: 'ui-accept-r-xxxxxxx' });
    expect(ok.body.result.proposal.status).toBe('accepted');
  });

  it('export: head archive, GET download_path with the session cookie; full for the admin; audit shows the export', async () => {
    await w.client('alice-helper').call('write', { space: 'shared', path: 'a/b.md', content: '# B\n', message: 'b' });
    const cookie = await login();
    const ex = await op<{ export_id: string; download_path: string; size: number; sha256: string; expires_at: string }>(cookie, 'export', { space: 'shared', mode: 'head' });
    expect(ex.status).toBe(200);
    expect(Object.keys(ex.body.result).sort()).toEqual(['download_path', 'expires_at', 'export_id', 'sha256', 'size']);
    // A link from the UI is a plain browser GET: cookie present, no X-Brain-Client.
    const dl = await fetch(`${h.url}${ex.body.result.download_path}`, { headers: { cookie } });
    expect(dl.status).toBe(200);
    const bytes = Buffer.from(await dl.arrayBuffer());
    expect(bytes.length).toBe(ex.body.result.size);
    expect(gunzipSync(bytes).toString('latin1')).toContain('brain-export/tree/a/b.md');
    // Without a session the archive is not served.
    expect((await fetch(`${h.url}${ex.body.result.download_path}`)).status).toBe(401);

    const full = await op(cookie, 'export', { space: 'shared', mode: 'full' });
    expect(full.status).toBe(200);

    const audit = await op<{ entries: { op: string; principal: string | null; via: string; outcome: string; detail: Record<string, unknown> | null }[]; next_cursor?: string }>(cookie, 'admin_audit_query', {
      principal: 'alice',
      op: 'export',
      limit: 100,
    });
    expect(audit.status).toBe(200);
    expect(audit.body.result.entries.length).toBe(2);
    expect(audit.body.result.entries[0]).toMatchObject({ op: 'export', principal: 'alice', outcome: 'ok' });
    const since = await op<{ entries: unknown[] }>(cookie, 'admin_audit_query', { since: new Date(Date.now() + 3_600_000).toISOString(), limit: 100 });
    expect(since.body.result.entries).toEqual([]);
  });
});
