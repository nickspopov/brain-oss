// Inbox on a fake server: two panes (thread list: other party, subject, snippet, age,
// unread dot; conversation with replies under the original and the composer at the bottom), tabs
// Inbox · Sent · Done, Reply / Done / ⋯ Decline · Withdraw, "Seen · time" for the sender, received only
// after render (never on preload, never for oversight), Done acks the on-screen snapshot, the space
// Messages tab, the To combobox of allowed recipients only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetch } from '../src/api/client';
import type { HandoffMessage, HandoffRecipient } from '../src/api/types';
import { App } from '../src/App';
import { bodyOf, buildThreads, conversationOrder, doneSnapshot, senderState, sentThreads, statusMessage, tabOf, toMarkReceived } from '../src/lib/inbox';

const ALICE = { name: 'alice', kind: 'human', trust: 'admin', role: 'superadmin', admin: true };
const NOW = Date.now();
const iso = (ago: number) => new Date(NOW - ago).toISOString();

function msg(id: string, over: Partial<HandoffMessage> = {}): HandoffMessage {
  return {
    id,
    space: 'handoff',
    canonical_space: 'handoff',
    path: `alice/${id}.md`,
    title: `Message ${id}`,
    from: 'alice-coder',
    to: 'alice',
    status: 'new',
    rev: 1,
    content_rev: 1,
    thread_id: id,
    reply_to: null,
    created_at: iso(60_000),
    changed_at: iso(60_000),
    age: '1m',
    received_rev: null,
    received_at: null,
    resolution: null,
    resolved_at: null,
    resolved_by: null,
    note: null,
    snippet: `Snippet of ${id}`,
    ...over,
  };
}

const rcp = (name: string, over: Partial<HandoffRecipient> = {}): HandoffRecipient => ({
  name,
  display_name: name,
  external: false,
  manager: 'alice',
  owner_label: null,
  spaces: ['handoff'],
  ...over,
});
const RECIPIENTS = [rcp('alice-coder', { display_name: 'Letta' }), rcp('friend-bot', { display_name: 'Friend', external: true, manager: null, owner_label: 'Erin' })];

interface Opts {
  spaces?: { slug: string; name?: string; inbox: boolean }[];
  recipients?: HandoffRecipient[];
  /** Hold `read` answers until released (to see what happens before the body renders). */
  holdReads?: boolean;
}

function server(messages: HandoffMessage[], o: Opts = {}) {
  const calls: { op: string; input: Record<string, unknown> }[] = [];
  const held: (() => void)[] = [];
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  const spaces = (o.spaces ?? [{ slug: 'handoff', name: 'General', inbox: true }]).map((s) => ({
    name: s.slug,
    description: '',
    role: 'admin',
    review_mode: 'off',
    executable: false,
    protected_paths: [],
    archived: false,
    ...s,
  }));
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/v1/auth/session') return ok({ principal: ALICE });
    const input = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const op = url.replace('/api/v1/ops/', '');
    calls.push({ op, input });
    switch (op) {
      case 'spaces':
        return ok({ spaces });
      case 'proposal_list':
        return ok({ proposals: [] });
      case 'list':
        return ok({ entries: [] });
      case 'handoff_inbox': {
        const xs = messages.filter(
          (m) => (input.box === 'in' ? m.to === 'alice' : true) && (input.space === undefined || m.space === input.space) && (input.include_done || (m.status !== 'done' && m.status !== 'declined')),
        );
        const counts = { new: 0, updated: 0, received: 0, done: 0, declined: 0 };
        for (const m of xs) counts[m.status]++;
        return ok({ box: input.box ?? 'in', principal: 'alice', counts, messages: xs.map((m) => ({ ...m })), more: false });
      }
      case 'read': {
        const m = messages.find((x) => x.id === input.id)!;
        const answer = () => ok({ doc: { id: m.id, space: m.space, path: m.path }, revision: { rev: m.rev }, content: `# ${m.title}\n\nBody of ${m.id}.\n`, encoding: 'utf8', truncated: false });
        if (!o.holdReads) return answer();
        return new Promise<Response>((resolve) => held.push(() => resolve(answer())));
      }
      case 'handoff_ack': {
        const m = messages.find((x) => x.id === input.id)!;
        if (input.expected_rev !== m.rev) return new Response(JSON.stringify({ ok: false, error: { code: 'conflict', message: 'changed', retryable: false } }), { status: 409 });
        m.status = input.status as HandoffMessage['status'];
        if (input.status === 'received') m.received_at = new Date(NOW).toISOString();
        return ok({ message: m, already: false });
      }
      case 'delete': {
        const i = messages.findIndex((x) => x.id === input.id);
        const [m] = messages.splice(i, 1);
        return ok({ doc: { id: m!.id } });
      }
      case 'handoff_recipients':
        return ok({ recipients: o.recipients ?? RECIPIENTS });
      case 'handoff_send': {
        const id = `S${messages.length}`;
        const parent = messages.find((x) => x.id === input.reply_to);
        const m = msg(id, { from: 'alice', to: String(input.to), title: String(input.title), thread_id: parent?.thread_id ?? id, reply_to: parent?.id ?? null, created_at: new Date(NOW).toISOString() });
        messages.push(m);
        return ok({ message: m, doc: {} });
      }
      default:
        return new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'not_found', retryable: false } }), { status: 404 });
    }
  });
  setFetch(f as unknown as typeof fetch);
  return {
    of: (op: string) => calls.filter((c) => c.op === op).map((c) => c.input),
    release: () => {
      for (const r of held.splice(0)) r();
    },
  };
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const THREAD = () => [
  msg('A', { from: 'alice-coder', to: 'alice', title: 'Budget?', created_at: iso(300_000), status: 'received', received_at: iso(250_000) }),
  msg('R1', { from: 'alice', to: 'alice-coder', title: 'Re: Budget?', thread_id: 'A', reply_to: 'A', status: 'received', received_at: iso(150_000), created_at: iso(200_000) }),
  msg('R2', { from: 'alice-coder', to: 'alice', title: 'Re: Budget?', thread_id: 'A', reply_to: 'R1', created_at: iso(10_000), changed_at: iso(10_000), age: '0m', snippet: 'Here are the numbers' }),
];

describe('Inbox', () => {
  it('two panes: list rows show the other party, subject, snippet, age and an unread dot; tabs sort threads', async () => {
    server([
      ...THREAD(),
      msg('S', { from: 'alice', to: 'bob-agent', title: 'Groceries', snippet: 'Milk and bread' }),
      msg('D', { from: 'alice-helper', to: 'alice', title: 'Digest', status: 'done', snippet: 'Five papers' }),
      // Someone else's conversation: not in the global Inbox.
      msg('O', { from: 'alice-coder', to: 'bob-agent', title: 'Not mine' }),
    ]);
    renderAt('/inbox');
    const row = await screen.findByTestId('thread-A');
    expect(row.textContent).toContain('alice-coder');
    expect(row.textContent).toContain('Budget?');
    expect(row.textContent).toContain('Here are the numbers');
    expect(row.textContent).toContain('0m');
    expect(within(row).getByText('unread')).toBeTruthy();
    expect(screen.queryByTestId('thread-S')).toBeNull();
    expect(screen.queryByTestId('thread-O')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Sent' }));
    expect((await screen.findByTestId('thread-S')).textContent).toContain('bob-agent');
    fireEvent.click(screen.getByRole('tab', { name: 'Done' }));
    expect((await screen.findByTestId('thread-D')).textContent).toContain('Five papers');
    expect(screen.queryByText('unread')).toBeNull();
    // The old Messages address leads here.
    cleanup();
    server([]);
    renderAt('/handoff');
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeTruthy();
  });

  it('opening a thread marks messages to me received only after their bodies render — never from the list (preload)', async () => {
    const s = server(THREAD(), { holdReads: true });
    renderAt('/inbox');
    await screen.findByTestId('thread-A');
    // The list alone reads nothing and acks nothing.
    await new Promise((r) => setTimeout(r, 30));
    expect(s.of('read')).toEqual([]);
    expect(s.of('handoff_ack')).toEqual([]);
    fireEvent.click(screen.getByTestId('thread-A'));
    await waitFor(() => expect(s.of('read').length).toBe(3));
    // Bodies not rendered yet: still no receipt.
    await new Promise((r) => setTimeout(r, 30));
    expect(s.of('handoff_ack')).toEqual([]);
    s.release();
    expect(await screen.findByText('Body of R2.')).toBeTruthy();
    await waitFor(() => expect(s.of('handoff_ack')).toEqual([{ id: 'R2', expected_rev: 1, status: 'received' }]));
    // Replies under the original, oldest first.
    const order = screen.getAllByTestId(/^msg-/).map((e) => e.dataset.testid);
    expect(order).toEqual(['msg-A', 'msg-R1', 'msg-R2']);
    expect(screen.getByTestId('msg-R1').style.marginLeft).toBe('20px');
    expect(screen.getByTestId('msg-R2').style.marginLeft).toBe('40px');
  });

  it('the sender sees the recipient state of each message: Sent before receipt, “Seen <time>” after', async () => {
    server([msg('M', { from: 'alice', to: 'alice-coder', title: 'Ping', received_at: new Date(NOW).toISOString(), received_rev: 1, status: 'received' }), msg('N', { from: 'alice', to: 'bob-agent', title: 'Pong' })]);
    renderAt('/inbox');
    fireEvent.click(await screen.findByRole('tab', { name: 'Sent' }));
    fireEvent.click(await screen.findByTestId('thread-M'));
    expect(within(await screen.findByTestId('msg-M')).getByTestId('state-M').textContent).toMatch(/Seen \d/);
    fireEvent.click(screen.getByTestId('thread-N'));
    expect(within(await screen.findByTestId('msg-N')).getByTestId('state-N').textContent).toContain('Sent');
  });

  it('thread rows carry a chip for each recipient state; Sent lists open first, then done; never an ack', async () => {
    const at = (ago: number) => ({ created_at: iso(ago), changed_at: iso(ago) });
    const s = server([
      msg('S1', { from: 'alice', to: 'alice-coder', title: 'Fresh ask', ...at(10_000) }),
      msg('S2', { from: 'alice', to: 'alice-coder', title: 'Seen ask', status: 'received', received_rev: 1, received_at: iso(5_000), ...at(50_000) }),
      msg('S3', { from: 'alice', to: 'bob-agent', title: 'Edited ask', status: 'updated', rev: 2, content_rev: 2, received_rev: 1, received_at: iso(40_000), ...at(30_000) }),
      msg('S4', { from: 'alice', to: 'alice-assistant', title: 'Finished ask', status: 'done', resolution: 'done', resolved_at: iso(2_000), resolved_by: 'alice-assistant', note: 'All set.', ...at(1_000) }),
      msg('S5', { from: 'alice', to: 'alice-project-agent', title: 'Refused ask', status: 'declined', resolution: 'declined', resolved_at: iso(3_000), resolved_by: 'alice-project-agent', note: 'Not my area.', ...at(2_000) }),
      // The other party spoke last and nothing of mine is open: no chip.
      msg('T1', { from: 'alice', to: 'alice-helper', title: 'Old', status: 'done', resolution: 'done', resolved_at: iso(9_000), ...at(90_000) }),
      msg('T2', { from: 'alice-helper', to: 'alice', title: 'Re: Old', thread_id: 'T1', reply_to: 'T1', status: 'done', resolution: 'done', ...at(80_000) }),
    ]);
    renderAt('/inbox');
    fireEvent.click(await screen.findByRole('tab', { name: 'Sent' }));
    await screen.findByTestId('thread-S1');
    const rows = screen.getAllByTestId(/^thread-/).map((r) => r.dataset.testid);
    // Open (newest change first), then finished whose last word was mine.
    expect(rows).toEqual(['thread-S1', 'thread-S3', 'thread-S2', 'thread-S4', 'thread-S5']);
    const chip = (id: string) => screen.getByTestId(`thread-${id}`).querySelector(`[data-testid="state-${id}"]`)!;
    expect(chip('S1').getAttribute('data-state')).toBe('sent');
    expect(chip('S1').textContent).toContain('Sent');
    expect(chip('S2').getAttribute('data-state')).toBe('seen');
    expect(chip('S2').textContent).toMatch(/Seen \d/);
    expect(chip('S3').getAttribute('data-state')).toBe('updated');
    expect(chip('S3').textContent).toContain('Updated, not seen');
    expect(chip('S4').textContent).toMatch(/Done \d/);
    expect(chip('S5').textContent).toContain('Declined');
    expect(chip('S5').querySelector('[title]')!.getAttribute('title')).toBe('alice-project-agent declined it — “Not my area.”');
    // Done tab: the finished ones carry their chip; the thread answered last by hermes has none.
    fireEvent.click(screen.getByRole('tab', { name: 'Done' }));
    await screen.findByTestId('thread-T1');
    expect(screen.getByTestId('thread-T1').querySelector('[data-testid^="state-"]')).toBeNull();
    expect(chip('S4').getAttribute('data-state')).toBe('done');
    // In the conversation: the recipient note of a done / declined message.
    fireEvent.click(screen.getByTestId('thread-S5'));
    const m = within(await screen.findByTestId('msg-S5'));
    expect(m.getByTestId('state-S5').textContent).toContain('Declined');
    expect(m.getByText('alice-project-agent: “Not my area.”')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30));
    expect(s.of('handoff_ack')).toEqual([]);
  });

  it('every message of mine in a conversation shows its own state; edited after receipt reads “Updated, not seen”', async () => {
    server([
      msg('A', { from: 'alice', to: 'alice-coder', title: 'Re-index', status: 'updated', rev: 2, content_rev: 2, received_rev: 1, received_at: iso(50_000), created_at: iso(60_000) }),
      msg('B', { from: 'alice-coder', to: 'alice', title: 'Re: Re-index', thread_id: 'A', reply_to: 'A', status: 'received', received_rev: 1, received_at: iso(30_000), created_at: iso(40_000) }),
      msg('C', { from: 'alice', to: 'alice-coder', title: 'Re: Re-index', thread_id: 'A', reply_to: 'B', status: 'done', resolution: 'done', resolved_at: iso(10_000), resolved_by: 'alice-coder', note: 'Re-indexed.', created_at: iso(20_000) }),
    ]);
    renderAt('/inbox');
    // B (to me) is open: the thread is in Inbox; the row still shows my latest open message (A).
    const row = await screen.findByTestId('thread-A');
    expect(row.querySelector('[data-testid="state-A"]')!.textContent).toContain('Updated, not seen');
    fireEvent.click(row);
    expect(within(await screen.findByTestId('msg-A')).getByTestId('state-A').textContent).toContain('Updated, not seen');
    expect(within(screen.getByTestId('msg-C')).getByTestId('state-C').textContent).toMatch(/Done \d/);
    expect(within(screen.getByTestId('msg-C')).getByText('alice-coder: “Re-indexed.”')).toBeTruthy();
    // Not on the message to me: that one is mine to answer.
    expect(within(screen.getByTestId('msg-B')).queryByTestId('state-B')).toBeNull();
  });

  it('“Done” acks the snapshot on screen; a reply that arrived meanwhile stays pending', async () => {
    const messages = [msg('A', { title: 'Budget?', status: 'received', received_at: iso(1000) })];
    const s = server(messages);
    renderAt('/inbox');
    fireEvent.click(await screen.findByTestId('thread-A'));
    await screen.findByText('Body of A.');
    // A concurrent reply reaches the server; the screen has not refetched yet.
    messages.push(msg('B', { title: 'Re: Budget?', thread_id: 'A', reply_to: 'A', created_at: new Date(NOW).toISOString() }));
    const header = within(screen.getByRole('article'));
    // At most two buttons in a row (plus the ⋯ menu).
    expect(header.getAllByRole('button', { name: /^(Reply|Done)$/ })).toHaveLength(2);
    fireEvent.click(header.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(s.of('handoff_ack').filter((a) => a.status === 'done')).toEqual([{ id: 'A', expected_rev: 1, status: 'done' }]));
    expect(messages.find((m) => m.id === 'B')!.status).toBe('new');
  });

  it('Reply sends from the composer at the bottom with reply_to the latest message; ⋯ Decline needs a note; ⋯ Withdraw deletes my open message', async () => {
    const s = server(THREAD());
    renderAt('/inbox');
    fireEvent.click(await screen.findByTestId('thread-A'));
    const form = await screen.findByRole('form', { name: 'Reply' });
    fireEvent.change(within(form).getByLabelText('Reply'), { target: { value: '100 EUR' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(s.of('handoff_send')[0]).toMatchObject({ to: 'alice-coder', title: 'Re: Budget?', body: '100 EUR', reply_to: 'R2' }));
    // Decline.
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Decline…' }));
    const confirm = screen.getByRole('button', { name: 'Decline' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'not now' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(s.of('handoff_ack').find((a) => a.status === 'declined')).toMatchObject({ id: 'R2', note: 'not now' }));
    // Withdraw my open message (R1 is open: received, not done).
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Withdraw' }));
    await waitFor(() => expect(s.of('delete')[0]).toMatchObject({ id: expect.stringMatching(/^(R1|S\d+)$/), message: 'Withdrawn by sender' }));
  });

  it('space Messages tab: the same view filtered to the space; oversight of others’ mail marks nothing received', async () => {
    const s = server(
      [msg('F', { space: 'proj-alpha', from: 'alice-project-agent', to: 'bob', title: 'Release notes' }), msg('G', { space: 'proj-alpha', from: 'bob', to: 'alice', title: 'For you' })],
      { spaces: [{ slug: 'proj-alpha', name: 'Alpha', inbox: true }] },
    );
    renderAt('/s/proj-alpha/messages');
    expect(await screen.findByRole('link', { name: 'Messages' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Documents' }).getAttribute('href')).toBe('/s/proj-alpha');
    const row = await screen.findByTestId('thread-F');
    expect(row.textContent).toContain('alice-project-agent ↔ bob');
    await waitFor(() => expect(s.of('handoff_inbox').some((i) => i.space === 'proj-alpha' && i.box === 'all')).toBe(true));
    fireEvent.click(row);
    expect(await screen.findByText('Body of F.')).toBeTruthy();
    expect(screen.getByText(/as a space admin/)).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Reply' })).toBeNull();
    // Oversight shows the same chips, read-only (F is new: still “Sent”).
    expect(row.querySelector('[data-testid="state-F"]')!.getAttribute('data-state')).toBe('sent');
    expect(within(screen.getByTestId('msg-F')).getByTestId('state-F').textContent).toContain('Sent');
    await new Promise((r) => setTimeout(r, 30));
    expect(s.of('handoff_ack')).toEqual([]);
    // My own thread in the same tab: received after render.
    fireEvent.click(screen.getByTestId('thread-G'));
    await screen.findByText('Body of G.');
    await waitFor(() => expect(s.of('handoff_ack')).toEqual([{ id: 'G', expected_rev: 1, status: 'received' }]));
  });

  it('New message: To is a combobox of allowed recipients only; the Space field only for a recipient in several spaces', async () => {
    const s = server([msg('A', { from: 'betabot', title: 'Other project' })], {
      recipients: [rcp('alice-coder', { display_name: 'Letta' }), rcp('friend-bot', { display_name: 'Friend', external: true, manager: null, owner_label: 'Erin' }), rcp('alice-project-agent', { display_name: 'Alphabot', manager: 'bob', spaces: ['handoff', 'proj-alpha'] })],
    });
    renderAt('/inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'New message' }));
    const form = within(screen.getByRole('form', { name: 'New message' }));
    const to = form.getByRole('combobox', { name: 'To' });
    fireEvent.focus(to);
    const list = within(await screen.findByRole('listbox', { name: 'To' }));
    await waitFor(() => expect(list.getAllByRole('option')).toHaveLength(3));
    const opts = list.getAllByRole('option').map((o) => o.textContent);
    expect(opts).toContain('Friend· friend-bot · managed by ErinEXTERNAL');
    expect(opts.join(' ')).not.toContain('betabot');
    fireEvent.change(to, { target: { value: 'betabot' } });
    expect(await screen.findByText(/Nobody matches/)).toBeTruthy();
    fireEvent.change(to, { target: { value: 'alp' } });
    fireEvent.click(await form.findByRole('option', { name: /Alphabot/ }));
    const pick = form.getByLabelText('Space') as HTMLSelectElement;
    expect(pick.value).toBe('handoff');
    fireEvent.change(pick, { target: { value: 'proj-alpha' } });
    fireEvent.change(form.getByLabelText('Subject'), { target: { value: 'Hi' } });
    fireEvent.click(form.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(s.of('handoff_send')[0]).toMatchObject({ to: 'alice-project-agent', title: 'Hi', space: 'proj-alpha' }));
  });
});

describe('inbox threads (lib)', () => {
  it('senderState per status, statusMessage per thread, sentThreads order', () => {
    expect(senderState(msg('a'))).toEqual({ kind: 'sent' });
    expect(senderState(msg('a', { status: 'received', received_at: 'T' }))).toEqual({ kind: 'seen', at: 'T' });
    expect(senderState(msg('a', { status: 'updated', received_rev: 1, content_rev: 2 }))).toEqual({ kind: 'updated' });
    expect(senderState(msg('a', { status: 'done', resolved_at: 'T', resolved_by: 'x', note: 'ok' }))).toEqual({ kind: 'done', at: 'T', by: 'x', note: 'ok' });
    expect(senderState(msg('a', { status: 'declined', resolved_at: 'T', resolved_by: 'x', note: 'no' }))).toEqual({ kind: 'declined', at: 'T', by: 'x', note: 'no' });
    const ths = buildThreads(
      [
        msg('O', { from: 'alice', to: 'x', changed_at: iso(1) }),
        msg('D', { from: 'alice', to: 'x', status: 'done', changed_at: iso(0) }),
        msg('Q', { from: 'x', to: 'alice', status: 'done', changed_at: iso(2) }),
        msg('Z', { from: 'a', to: 'b', status: 'received', changed_at: iso(3) }),
      ],
      'alice',
    );
    expect(sentThreads(ths, 'alice').map((t) => t.id)).toEqual(['O', 'D']);
    const by = (id: string) => ths.find((t) => t.id === id)!;
    expect(statusMessage(by('O'), 'alice')?.id).toBe('O');
    expect(statusMessage(by('D'), 'alice')?.id).toBe('D');
    expect(statusMessage(by('Q'), 'alice')).toBeUndefined();
    // Oversight (not a party): the latest open message.
    expect(statusMessage(by('Z'), 'alice')?.id).toBe('Z');
  });

  it('tabs, other party, unread; Done snapshot and receipts only for messages to me', () => {
    const th = buildThreads(THREAD(), 'alice');
    expect(th).toHaveLength(1);
    const t = th[0]!;
    expect(t).toMatchObject({ id: 'A', subject: 'Budget?', other: 'alice-coder', unread: true, tab: 'inbox', mine: true });
    expect(doneSnapshot(t, 'alice')).toEqual([
      { id: 'A', rev: 1 },
      { id: 'R2', rev: 1 },
    ]);
    expect(toMarkReceived(t, 'alice')).toEqual([{ id: 'R2', rev: 1 }]);
    // For a third party (oversight) nothing is theirs to mark.
    expect(toMarkReceived(buildThreads(THREAD(), 'bob')[0]!, 'bob')).toEqual([]);
    expect(buildThreads(THREAD(), 'bob')[0]!.other).toBe('alice-coder ↔ alice');
    expect(tabOf([msg('X', { from: 'alice', to: 'a' })], 'alice')).toBe('sent');
    expect(tabOf([msg('X', { status: 'done' })], 'alice')).toBe('done');
    expect(conversationOrder(t).map((x) => [x.m.id, x.depth])).toEqual([
      ['A', 0],
      ['R1', 1],
      ['R2', 2],
    ]);
    expect(bodyOf('# Title\n\nHello\n')).toBe('Hello\n');
  });
});
