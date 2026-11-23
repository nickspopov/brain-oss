// Review and proposals: write routing by the table, acceptance (author = proposer, approved_by =
// decider), executable only by a human, stale proposal, visibility, narrowing access after creation,
// replay by request_id.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryResult, ReadResult, WriteResult } from '../helpers/api.js';
import type { Client, RawResponse } from '../helpers/clients/index.js';
import { buildWorld, RANDOM_ID, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

interface Proposal {
  id: string;
  space: string;
  path: string;
  doc_id?: string;
  base_rev: number;
  status: string;
  author: { name: string; trust: string };
  decided_by?: { name: string };
  result_rev?: number;
  human_required: boolean;
}
interface ProposalGet {
  proposal: Proposal;
  content: string;
  diff: string;
  stale: boolean;
}

const shape = (r: RawResponse) => JSON.stringify({ status: r.status, body: r.body });

async function expectCode(p: Promise<unknown>, code: string, details?: Record<string, unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ code, ...(details ? { details } : {}) });
}

describe('review and proposals', () => {
  let h: Harness;
  let w: World;
  let alice: Client;
  let claude: Client;
  let hermes: Client;
  let alphabot: Client;

  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h);
    alice = w.client('alice');
    claude = w.client('alice-assistant');
    hermes = w.client('alice-helper');
    alphabot = w.client('alphabot');
  });
  afterEach(async () => {
    expect(h.doctor().problems).toEqual([]);
    expect(h.auditedCalls()).toBe(h.opCalls());
    await h.close();
  });

  const write = (c: Client, path: string, content: string, extra: Record<string, unknown> = {}) =>
    c.call<WriteResult>('write', { space: 'shared', path, content, message: `write ${path}`, ...extra });
  const space = (settings: Record<string, unknown>) => alice.call('admin_space_update', { slug: 'shared', ...settings });
  const outcome = async (c: Client, path: string): Promise<string> => {
    const r = await c.raw<WriteResult>('write', { space: 'shared', path, content: `# ${path}\n`, message: 'routing' });
    if (r.body.ok) return r.body.result.status;
    return `${r.body.error.code}${r.body.error.details?.reason ? `:${String(r.body.error.details.reason)}` : ''}`;
  };

  describe('routing table', () => {
    // alphabot: trust limited; alice-helper: trusted; alice-assistant: trust admin, role admin in shared (curators).
    const cases: { name: string; settings: Record<string, unknown>; role: 'none' | 'read' | 'propose' | 'write' | 'admin'; who: 'alphabot' | 'alice-helper'; path?: string; expected: string }[] = [
      { name: 'role none → not_found', settings: {}, role: 'none', who: 'alphabot', expected: 'not_found' },
      { name: 'role read → forbidden', settings: {}, role: 'read', who: 'alphabot', expected: 'forbidden' },
      { name: 'protected path, role write → proposal', settings: { protected_paths: ['AGENTS.md'] }, role: 'write', who: 'alice-helper', path: 'agents.md', expected: 'proposed' },
      { name: 'protected path, role admin → write', settings: { protected_paths: ['AGENTS.md'] }, role: 'admin', who: 'alice-helper', path: 'AGENTS.md', expected: 'committed' },
      { name: 'role propose → proposal', settings: {}, role: 'propose', who: 'alice-helper', expected: 'proposed' },
      { name: 'review_mode all, role write → proposal', settings: { review_mode: 'all' }, role: 'write', who: 'alice-helper', expected: 'proposed' },
      { name: 'review_mode all, role admin → write', settings: { review_mode: 'all' }, role: 'admin', who: 'alice-helper', expected: 'committed' },
      { name: 'review_mode limited, trust limited, role write → proposal', settings: { review_mode: 'limited' }, role: 'write', who: 'alphabot', expected: 'proposed' },
      { name: 'review_mode limited, trust trusted, role write → write', settings: { review_mode: 'limited' }, role: 'write', who: 'alice-helper', expected: 'committed' },
      { name: 'review_mode limited, trust limited, role admin → write', settings: { review_mode: 'limited' }, role: 'admin', who: 'alphabot', expected: 'committed' },
      { name: 'review_mode off, role write → write', settings: {}, role: 'write', who: 'alphabot', expected: 'committed' },
    ];
    it.each(cases)('$name', async (c) => {
      if (Object.keys(c.settings).length) await space(c.settings);
      w.grant('shared', { principal: c.who }, c.role);
      expect(await outcome(w.client(c.who), c.path ?? 'doc.md')).toBe(c.expected);
    });

    it('defaults: review off, nothing protected; spaces shows the settings', async () => {
      const s = await hermes.call<{ spaces: { slug: string; review_mode: string; executable: boolean }[] }>('spaces');
      expect(s.spaces.find((x) => x.slug === 'shared')).toMatchObject({ review_mode: 'off', executable: false });
      expect(s.spaces.find((x) => x.slug === 'recipes')).toMatchObject({ executable: true });
      expect(await outcome(hermes, 'AGENTS.md')).toBe('committed');
    });

    it('edit and revert become proposals; delete and move answer forbidden review_required', async () => {
      const doc = await write(hermes, 'n.md', '# N\n\none\n');
      await write(hermes, 'n.md', '# N\n\ntwo\n', { expected_rev: 1 });
      await space({ review_mode: 'all' });
      const e = await hermes.call<WriteResult>('edit', { id: doc.doc!.id, edits: [{ old_text: 'two', new_text: 'three' }], message: 'edit' });
      expect(e).toMatchObject({ status: 'proposed', proposal: { base_rev: 2, doc_id: doc.doc!.id } });
      const r = await hermes.call<WriteResult>('revert', { id: doc.doc!.id, to_rev: 1, message: 'revert' });
      expect(r.status).toBe('proposed');
      const got = await claude.call<ProposalGet>('proposal_get', { id: r.proposal!.id });
      expect(got.content).toBe('# N\n\none\n');
      await expectCode(hermes.call('delete', { id: doc.doc!.id }), 'forbidden', { reason: 'review_required' });
      await expectCode(hermes.call('move', { id: doc.doc!.id, to_path: 'm.md' }), 'forbidden', { reason: 'review_required' });
      // Nothing was written: the head is unchanged.
      expect((await hermes.call<ReadResult>('read', { id: doc.doc!.id })).doc.rev).toBe(2);
    });

    it('a file write that needs review is refused (proposals carry text only)', async () => {
      await space({ review_mode: 'all' });
      await expectCode(
        hermes.call('write', { space: 'shared', path: 'f.bin', content_base64: Buffer.from([0, 1, 2]).toString('base64'), message: 'file' }),
        'forbidden',
        { reason: 'review_required' },
      );
    });
  });

  describe('decide', () => {
    it('accept: revision authored by the proposer, approved_by the decider; proposal records the result', async () => {
      w.grant('shared', { principal: 'alice-helper' }, 'propose');
      const p = (await write(hermes, 'new/idea.md', '# Idea\n')).proposal!;
      expect(p).toMatchObject({ status: 'open', base_rev: 0, author: { name: 'alice-helper', trust: 'trusted' }, human_required: false });
      expect(p.doc_id).toBeUndefined();
      const d = await claude.call<{ proposal: Proposal; doc: { id: string; rev: number; author: { name: string }; approved_by?: { name: string } } }>(
        'proposal_decide',
        { id: p.id, decision: 'accept', note: 'thanks' },
      );
      expect(d.proposal).toMatchObject({ status: 'accepted', decided_by: { name: 'alice-assistant' }, result_rev: 1, doc_id: d.doc.id });
      expect(d.doc).toMatchObject({ rev: 1, author: { name: 'alice-helper' }, approved_by: { name: 'alice-assistant' } });
      const read = await alphabot.call<ReadResult>('read', { id: d.doc.id });
      expect(read.content).toBe('# Idea\n');
      expect(read.revision).toMatchObject({ author: { name: 'alice-helper', trust: 'trusted' }, approved_by: { name: 'alice-assistant' } });
      await expectCode(claude.call('proposal_decide', { id: p.id, decision: 'reject' }), 'conflict', { reason: 'not_open' });
    });

    it('the author cannot accept their own proposal; a non-admin cannot decide', async () => {
      const own = await claude.call<{ proposal: Proposal }>('propose', { space: 'shared', path: 'c.md', content: 'c\n', message: 'mine' });
      await expectCode(claude.call('proposal_decide', { id: own.proposal.id, decision: 'accept' }), 'forbidden', { reason: 'own_proposal' });
      w.grant('shared', { principal: 'alice-helper' }, 'propose');
      const p = (await write(hermes, 'h.md', 'h\n')).proposal!;
      await expectCode(hermes.call('proposal_decide', { id: p.id, decision: 'accept' }), 'forbidden');
      expect((await claude.call<{ proposal: Proposal }>('proposal_decide', { id: p.id, decision: 'reject' })).proposal.status).toBe('rejected');
    });

    it('executable space: an agent curator cannot accept a non-admin proposal, a human can', async () => {
      w.grant('recipes', { principal: 'alice-helper' }, 'propose');
      const p = await hermes.call<{ proposal: Proposal }>('propose', { space: 'recipes', path: 'soup.md', content: '# Soup\n', message: 'recipe' });
      expect(p.proposal.human_required).toBe(true);
      await expectCode(claude.call('proposal_decide', { id: p.proposal.id, decision: 'accept' }), 'forbidden', { reason: 'human_required' });
      // An LLM curator sees the proposal and can reject it, but not accept it.
      expect((await claude.call<ProposalGet>('proposal_get', { id: p.proposal.id })).content).toBe('# Soup\n');
      const ok = await alice.call<{ proposal: Proposal; doc: { id: string } }>('proposal_decide', { id: p.proposal.id, decision: 'accept' });
      expect(ok.proposal.status).toBe('accepted');
      const read = await claude.call<ReadResult>('read', { id: ok.doc.id });
      expect(read.revision).toMatchObject({ author: { name: 'alice-helper' }, approved_by: { name: 'alice' }, attention: true });
    });

    it('stale proposal: conflict with the current text; accept over the head only with the expected_rev the decider saw', async () => {
      const doc = await write(hermes, 's.md', '# S\n\nbase\n');
      w.grant('shared', { principal: 'alphabot' }, 'propose');
      const p = (await write(alphabot, 's.md', '# S\n\nalphabot\n', { expected_rev: 1 })).proposal!;
      await write(hermes, 's.md', '# S\n\nhermes\n', { expected_rev: 1 });
      const g = await claude.call<ProposalGet>('proposal_get', { id: p.id });
      expect(g.stale).toBe(true);
      expect(g.diff).toContain('-hermes');
      expect(g.diff).toContain('+alphabot');
      const stale = await claude.raw('proposal_decide', { id: p.id, decision: 'accept' });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ ok: false, error: { code: 'conflict', details: { reason: 'stale_proposal', current: { rev: 2, content: '# S\n\nhermes\n' } } } });
      await expectCode(claude.call('proposal_decide', { id: p.id, decision: 'accept', expected_rev: 1 }), 'conflict', { reason: 'stale' });
      const ok = await claude.call<{ doc: { rev: number } }>('proposal_decide', { id: p.id, decision: 'accept', expected_rev: 2 });
      expect(ok.doc.rev).toBe(3);
      expect((await hermes.call<ReadResult>('read', { id: doc.doc!.id })).content).toBe('# S\n\nalphabot\n');
      const hist = await hermes.call<HistoryResult>('history', { id: doc.doc!.id });
      expect(hist.revisions.map((r) => r.author.name)).toEqual(['alphabot', 'alice-helper', 'alice-helper']);
    });

    it('a new-document proposal whose path got taken → conflict path_taken', async () => {
      w.grant('shared', { principal: 'alphabot' }, 'propose');
      const p = (await write(alphabot, 'taken.md', 'f\n')).proposal!;
      await write(hermes, 'taken.md', 'h\n');
      await expectCode(claude.call('proposal_decide', { id: p.id, decision: 'accept' }), 'conflict', { reason: 'path_taken' });
    });

    it('withdraw: only the author, only while open', async () => {
      w.grant('shared', { principal: 'alice-helper' }, 'propose');
      const p = (await write(hermes, 'w.md', 'w\n')).proposal!;
      await expectCode(claude.call('proposal_withdraw', { id: p.id }), 'forbidden', { reason: 'not_author' });
      expect((await hermes.call<{ proposal: Proposal }>('proposal_withdraw', { id: p.id })).proposal.status).toBe('withdrawn');
      await expectCode(hermes.call('proposal_withdraw', { id: p.id }), 'conflict', { reason: 'not_open' });
      await expectCode(claude.call('proposal_decide', { id: p.id, decision: 'accept' }), 'conflict', { reason: 'not_open' });
    });
  });

  describe('propose', () => {
    it('base_rev is checked like expected_rev; secrets and size are checked', async () => {
      const doc = await write(hermes, 'b.md', 'b\n');
      w.grant('shared', { principal: 'alphabot' }, 'propose');
      await expectCode(alphabot.call('propose', { space: 'shared', path: 'b.md', content: 'x\n', base_rev: 0, message: 'p' }), 'conflict', { reason: 'already_exists' });
      await expectCode(alphabot.call('propose', { space: 'shared', path: 'nope.md', content: 'x\n', base_rev: 3, message: 'p' }), 'conflict', { reason: 'not_found_at_rev' });
      await write(hermes, 'b.md', 'b2\n', { expected_rev: 1 });
      await expectCode(alphabot.call('propose', { space: 'shared', path: 'b.md', content: 'x\n', base_rev: 1, message: 'p' }), 'conflict', { reason: 'stale' });
      const p = await alphabot.call<{ proposal: Proposal }>('propose', { space: 'shared', path: 'b.md', content: 'x\n', message: 'p' });
      expect(p.proposal).toMatchObject({ base_rev: 2, doc_id: doc.doc!.id });
      await expectCode(alphabot.call('propose', { space: 'shared', path: 'big.md', content: 'x'.repeat(600 * 1024), message: 'p' }), 'too_large');
      // read does not grant the right to propose.
      await expectCode(w.client('betabot').call('propose', { space: 'shared', path: 'b.md', content: 'x\n', message: 'p' }), 'forbidden');
    });

    it('limit of open proposals per author', async () => {
      await h.close();
      h = await startHarness({ env: { BRAIN_MAX_OPEN_PROPOSALS: '2' } });
      w = buildWorld(h);
      alphabot = w.client('alphabot');
      w.grant('shared', { principal: 'alphabot' }, 'propose');
      for (const n of [1, 2]) await alphabot.call('propose', { space: 'shared', path: `p${n}.md`, content: 'x\n', message: 'p' });
      await expectCode(alphabot.call('propose', { space: 'shared', path: 'p3.md', content: 'x\n', message: 'p' }), 'quota_exceeded', { scope: 'open_proposals', limit: 2 });
    });

    it('request_id: the replay returns the same proposal and creates no second one', async () => {
      w.grant('shared', { principal: 'alphabot' }, 'propose');
      const input = { space: 'shared', path: 'r.md', content: 'r\n', message: 'p', request_id: 'proposal-req-1' };
      const a = await alphabot.call<{ proposal: Proposal }>('propose', input);
      const b = await alphabot.call<{ proposal: Proposal }>('propose', input);
      expect(b.proposal.id).toBe(a.proposal.id);
      expect((await alphabot.call<{ proposals: Proposal[] }>('proposal_list', { mine: true })).proposals).toHaveLength(1);
      await expectCode(alphabot.call('propose', { ...input, content: 'other\n' }), 'idempotency_mismatch');
      // A replay after losing access to the target is not_found, not the stored response.
      w.grant('shared', { principal: 'alphabot' }, 'none');
      await expectCode(alphabot.call('propose', input), 'not_found');
    });
  });

  describe('visibility', () => {
    it('the author and admins of the target see a proposal; other readers get not_found identical to a missing one', async () => {
      w.grant('shared', { principal: 'alice-helper' }, 'propose');
      const p = (await write(hermes, 'v.md', 'v\n')).proposal!;
      for (const op of ['proposal_get', 'proposal_withdraw']) {
        expect(shape(await alphabot.raw(op, { id: p.id }))).toBe(shape(await alphabot.raw(op, { id: RANDOM_ID })));
      }
      expect(shape(await alphabot.raw('proposal_decide', { id: p.id, decision: 'accept' }))).toBe(
        shape(await alphabot.raw('proposal_decide', { id: RANDOM_ID, decision: 'accept' })),
      );
      expect((await alphabot.call<{ proposals: Proposal[] }>('proposal_list', {})).proposals).toEqual([]);
      expect((await hermes.call<{ proposals: Proposal[] }>('proposal_list', {})).proposals.map((x) => x.id)).toEqual([p.id]);
      expect((await claude.call<{ proposals: Proposal[] }>('proposal_list', { space: 'shared', status: 'open' })).proposals.map((x) => x.id)).toEqual([p.id]);
      expect((await claude.call<{ proposals: Proposal[] }>('proposal_list', { status: 'accepted' })).proposals).toEqual([]);
    });

    it('narrowing access after the proposal was made hides it, even from its author', async () => {
      w.grant('shared', { principal: 'alice-helper' }, 'propose');
      const p = (await write(hermes, 'secret/plan.md', 'plan\n')).proposal!;
      expect((await hermes.call<ProposalGet>('proposal_get', { id: p.id })).content).toBe('plan\n');
      w.grant('shared', { principal: 'alice-helper' }, 'none', { path: 'secret/' });
      expect(shape(await hermes.raw('proposal_get', { id: p.id }))).toBe(shape(await hermes.raw('proposal_get', { id: RANDOM_ID })));
      expect((await hermes.call<{ proposals: Proposal[] }>('proposal_list', {})).proposals).toEqual([]);
      // A narrow none for the curator hides the proposal too.
      w.grant('shared', { group: 'curators' }, 'none', { path: 'secret/' });
      await expectCode(claude.call('proposal_get', { id: p.id }), 'not_found');
      await expectCode(claude.call('proposal_decide', { id: p.id, decision: 'accept' }), 'not_found');
    });

    it('proposal_list paginates with a cursor bound to the caller', async () => {
      w.grant('shared', { principal: 'alphabot' }, 'propose');
      for (let i = 0; i < 5; i++) await alphabot.call('propose', { space: 'shared', path: `l${i}.md`, content: 'x\n', message: 'p' });
      const first = await alphabot.call<{ proposals: Proposal[]; next_cursor?: string }>('proposal_list', { limit: 3 });
      expect(first.proposals.map((p) => p.path)).toEqual(['l4.md', 'l3.md', 'l2.md']);
      const second = await alphabot.call<{ proposals: Proposal[]; next_cursor?: string }>('proposal_list', { limit: 3, cursor: first.next_cursor });
      expect(second.proposals.map((p) => p.path)).toEqual(['l1.md', 'l0.md']);
      expect(second.next_cursor).toBeUndefined();
      await expectCode(claude.call('proposal_list', { limit: 3, cursor: first.next_cursor }), 'invalid_input');
    });
  });
});
