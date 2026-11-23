// Two agents write on top of the same revision at once: exactly one wins, the other gets
// a conflict with the current text; nothing is lost and nothing is merged together.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConflictDetails, HistoryResult, ReadResult, WriteResult } from '../helpers/api.js';
import { ADAPTERS, ApiError, type AdapterName, type Client } from '../helpers/clients/index.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

type Outcome = { ok: true; value: WriteResult } | { ok: false; error: ApiError };

async function attempt(p: Promise<WriteResult>): Promise<Outcome> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, error };
    throw error;
  }
}

describe.each(ADAPTERS)('a03 race via %s', (adapter: AdapterName) => {
  let h: Harness;
  let w: World;
  let claude: Client;
  let hermes: Client;

  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h, adapter);
    claude = w.client('alice-assistant');
    hermes = w.client('alice-helper');
  });
  afterEach(async () => {
    // One audit line per operation call made by the scenario.
    expect(h.auditedCalls()).toBe(h.opCalls());
    await h.close();
  });

  it('two concurrent writes on the same rev: exactly one commits, the other gets conflict with the winner text (50 rounds)',
    async () => {
      const created = await claude.call<WriteResult>('write', { space: 'shared', path: 'race.md', content: 'v0\n', message: 'create' });
      let rev = created.doc!.rev;
      for (let i = 0; i < 50; i++) {
        const base = await claude.call<ReadResult>('read', { space: 'shared', path: 'race.md' });
        expect(base.doc.rev).toBe(rev);
        const mine = `round ${i} by claude\n`;
        const theirs = `round ${i} by hermes\n`;
        const [a, b] = await Promise.all([
          attempt(claude.call<WriteResult>('write', { space: 'shared', path: 'race.md', content: mine, expected_rev: rev, message: `c${i}` })),
          attempt(hermes.call<WriteResult>('write', { space: 'shared', path: 'race.md', content: theirs, expected_rev: rev, message: `h${i}` })),
        ]);
        const wins = [a, b].filter((o) => o.ok);
        const losses = [a, b].filter((o): o is { ok: false; error: ApiError } => !o.ok);
        expect(wins).toHaveLength(1);
        expect(losses).toHaveLength(1);
        const loss = losses[0]!.error;
        expect(loss.code).toBe('conflict');
        expect(loss.status).toBe(409);
        const details = loss.details as unknown as ConflictDetails;
        expect(details.reason).toBe('stale');
        const winnerText = a.ok ? mine : theirs;
        const loserText = a.ok ? theirs : mine;
        expect(details.current?.content).toBe(winnerText);
        expect(details.current?.rev).toBe(rev + 1);
        expect(typeof details.diff).toBe('string');
        const head = await hermes.call<ReadResult>('read', { space: 'shared', path: 'race.md' });
        expect(head.content).toBe(winnerText);
        expect(head.doc.rev).toBe(rev + 1);
        // The loser has not lost its text: it writes again on top of the current revision.
        const loserClient = a.ok ? hermes : claude;
        const retry = await loserClient.call<WriteResult>('write', {
          space: 'shared',
          path: 'race.md',
          content: winnerText + loserText,
          expected_rev: details.current!.rev,
          message: `retry ${i}`,
        });
        expect(retry.status).toBe('committed');
        rev = retry.doc!.rev;
        expect(rev).toBe(base.doc.rev + 2);
      }
      const history = await claude.call<HistoryResult>('history', { space: 'shared', path: 'race.md', limit: 200 });
      // Exactly one revision for the winner and one for the loser's retry in each round, plus the creation.
      expect(history.revisions).toHaveLength(101);
      expect(history.revisions.map((r) => r.rev)).toEqual(Array.from({ length: 101 }, (_, i) => 101 - i));
    },
    120_000,
  );

  it('a blind overwrite is impossible: expected_rev is required for an existing document', async () => {
    await claude.call('write', { space: 'shared', path: 'blind.md', content: 'a\n', message: 'create' });
    const r = await hermes.raw('write', { space: 'shared', path: 'blind.md', content: 'b\n', message: 'blind' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, error: { code: 'conflict', details: { reason: 'expected_rev_required' } } });
    const dup = await hermes.raw('write', { space: 'shared', path: 'blind.md', content: 'b\n', expected_rev: 0, message: 'dup' });
    expect(dup.body).toMatchObject({ ok: false, error: { code: 'conflict', details: { reason: 'already_exists' } } });
    const ghost = await hermes.raw('write', { space: 'shared', path: 'ghost.md', content: 'b\n', expected_rev: 3, message: 'ghost' });
    expect(ghost.body).toMatchObject({ ok: false, error: { code: 'conflict', details: { reason: 'not_found_at_rev' } } });
  });

  it('edits on two unrelated anchors by two agents both apply without conflict', async () => {
    const created = await claude.call<WriteResult>('write', {
      space: 'shared',
      path: 'anchors.md',
      content: '# Doc\n\n## Alpha\n\nalpha text\n\n## Beta\n\nbeta text\n',
      message: 'create',
    });
    expect(created.doc!.rev).toBe(1);
    const [a, b] = await Promise.all([
      claude.call<WriteResult>('edit', { space: 'shared', path: 'anchors.md', edits: [{ old_text: 'alpha text', new_text: 'alpha by claude' }], message: 'alpha' }),
      hermes.call<WriteResult>('edit', { space: 'shared', path: 'anchors.md', edits: [{ old_text: 'beta text', new_text: 'beta by hermes' }], message: 'beta' }),
    ]);
    expect(a.status).toBe('committed');
    expect(b.status).toBe('committed');
    const head = await claude.call<ReadResult>('read', { space: 'shared', path: 'anchors.md' });
    expect(head.content).toBe('# Doc\n\n## Alpha\n\nalpha by claude\n\n## Beta\n\nbeta by hermes\n');
    expect(head.doc.rev).toBe(3);
  });
});
