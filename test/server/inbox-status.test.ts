// The web Inbox shows the recipient's state of my messages (Sent · Seen <time> ·
// Updated, not seen · Done <time> · Declined + note) from the list envelope alone. This pins the
// envelope the chips read (the "all" page of handoff_inbox), that an edit after receipt reads
// "updated", that a space Admin's oversight (list + read) never marks anything received, and that a
// third party sees none of it.
import { afterEach, describe, expect, it } from 'vitest';
import { setGrant } from '../../src/core/grants.js';
import { createPrincipal } from '../../src/core/principals.js';
import { issueToken } from '../../src/core/tokens.js';
import { makeClient } from '../helpers/clients/index.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
let w: World;

afterEach(async () => {
  await h?.close();
});

interface Msg {
  id: string;
  rev: number;
  from: string;
  to: string;
  status: string;
  received_rev: number | null;
  received_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  note: string | null;
}
interface Inbox {
  messages: Msg[];
}

function human(name: string, role: 'admin' | 'write') {
  const p = createPrincipal(h.core, { name, kind: 'human', trust: 'trusted' }, w.principals.alice.id);
  setGrant(h.core, { spaceId: w.spaces.handoff.id, scope: 'space', pathPrefix: null, docId: null, role, subjectType: 'principal', subjectId: p.id }, w.principals.alice.id);
  return makeClient('rest', h, issueToken(h.core, p.id, { label: name, createdBy: w.principals.alice.id }).token);
}

describe('recipient status in the list envelope', () => {
  it('sent → seen → updated (edited after receipt) → done with note; oversight never acks; a third party sees nothing', async () => {
    h = await startHarness();
    w = buildWorld(h);
    const hermes = w.client('alice-helper');
    const alphabot = w.client('alphabot');
    const admin = human('spaceadmin', 'admin');
    const bystander = human('bystander', 'write');
    const sent = (await hermes.call<{ message: Msg }>('handoff_send', { to: 'alphabot', title: 'Status probe', body: 'Please look.' })).message;
    const declinedMsg = (await hermes.call<{ message: Msg }>('handoff_send', { to: 'alphabot', title: 'Second probe', body: 'Also this.' })).message;
    const out = async (id: string) => (await hermes.call<Inbox>('handoff_inbox', { box: 'out', include_done: true })).messages.find((m) => m.id === id)!;
    const overseen = async (id: string) => (await admin.call<Inbox>('handoff_inbox', { box: 'all', include_done: true, space: 'handoff' })).messages.find((m) => m.id === id)!;

    expect(await out(sent.id)).toMatchObject({ status: 'new', received_at: null, resolved_at: null, note: null });
    // Oversight: the space Admin lists and reads it; it stays "new" for everyone.
    expect(await overseen(sent.id)).toMatchObject({ from: 'alice-helper', to: 'alphabot', status: 'new' });
    await admin.call('read', { id: sent.id });
    expect((await out(sent.id)).status).toBe('new');
    expect((await overseen(sent.id)).received_at).toBeNull();

    await alphabot.call('handoff_ack', { id: sent.id, expected_rev: 1, status: 'received' });
    const seen = await out(sent.id);
    expect(seen).toMatchObject({ status: 'received', received_rev: 1 });
    expect(seen.received_at).toEqual(expect.any(String));

    // The sender edits after receipt: "updated" (the new content is not seen), received_at kept.
    await hermes.call('edit', { id: sent.id, expected_rev: 1, edits: [{ old_text: 'Please look.', new_text: 'Please look today.' }], message: 'sooner' });
    expect(await out(sent.id)).toMatchObject({ status: 'updated', received_rev: 1, received_at: seen.received_at });
    expect((await overseen(sent.id)).status).toBe('updated');
    await admin.call('read', { id: sent.id });
    expect((await out(sent.id)).status).toBe('updated');

    await alphabot.call('handoff_ack', { id: sent.id, expected_rev: 2, status: 'done', note: 'Looked.' });
    await alphabot.call('handoff_ack', { id: declinedMsg.id, expected_rev: 1, status: 'declined', note: 'Not mine.' });
    expect(await out(sent.id)).toMatchObject({ status: 'done', resolved_by: 'alphabot', note: 'Looked.', resolved_at: expect.any(String) });
    expect(await out(declinedMsg.id)).toMatchObject({ status: 'declined', resolved_by: 'alphabot', note: 'Not mine.' });
    expect(await overseen(declinedMsg.id)).toMatchObject({ status: 'declined', note: 'Not mine.' });

    // A third party (write in handoff, human, agent) sees none of it — no id, no note.
    for (const c of [bystander, w.client('betabot')]) {
      for (const input of [{}, { box: 'out', include_done: true }, { include_done: true }, ...(c === bystander ? [{ box: 'all', include_done: true }] : [])]) {
        const raw = await c.raw('handoff_inbox', input);
        expect(raw.text).not.toContain(sent.id);
        expect(raw.text).not.toContain(declinedMsg.id);
        expect(raw.text).not.toMatch(/Looked\.|Not mine\./);
      }
    }
  });
});
