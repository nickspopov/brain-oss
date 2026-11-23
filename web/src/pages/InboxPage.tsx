// Inbox: two panes.
// Left: conversations (other party, subject, snippet, age, unread dot) under the tabs Inbox · Sent ·
// Done. Right: the conversation — messages in order, replies under the original, the composer at the
// bottom; actions Reply and Done, Decline and Withdraw under ⋯ (at most two buttons in a row).
//
// Receipts: opening a conversation as its recipient marks the messages to you received only after
// their bodies have rendered — never from the list (no preload) and never for someone else's mail
// (a space admin's oversight). "Done" acknowledges the snapshot of open messages to you that is on
// screen (id + revision); a reply that arrives meanwhile stays pending.
//
// Recipient status: a thread row whose latest (or any open) message is mine carries
// a chip with the recipient's state of it — Sent · Seen <time> · Updated, not seen · Done <time> ·
// Declined (note on hover); every message of mine in the conversation shows the same chip and the
// recipient's note. A space admin's oversight shows the chips of every message, read-only. All of it
// is read from the list envelope (status, received_at, resolved_at, note): showing never acks.
//
// The global Inbox shows conversations you take part in; a space's Messages tab (`space`) shows every
// conversation of that space you can read, including the ones you oversee as its admin.
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { HandoffMessage, HandoffRecipient } from '../api/types';
import { Combobox, Menu, MENU_ITEM, Page, Select, type ComboOption } from '../components/controls';
import { BTN, BTN_DANGER, BTN_PRIMARY } from '../components/edit';
import { Markdown } from '../components/Markdown';
import { Badge, ErrorView, Spinner, errorText } from '../components/ui';
import { requestIdFor } from '../lib/edit';
import { formatClock } from '../lib/format';
import {
  bodyOf,
  buildThreads,
  conversationOrder,
  doneSnapshot,
  latestOpenFrom,
  latestOpenTo,
  senderState,
  sentThreads,
  statusMessage,
  toMarkReceived,
  type InboxTab,
  type Thread,
} from '../lib/inbox';
import { useSession } from '../session';
import { tx } from '../i18n';

const t = tx.inboxPage;
const INPUT = 'rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900';
const TABS: InboxTab[] = ['inbox', 'sent', 'done'];

export function InboxPage() {
  return (
    <Page>
      <h1 className="text-xl font-semibold">{t.title}</h1>
      <ThreadView />
    </Page>
  );
}

/** Combobox row: "Display · name · managed by X", External badge. */
function recipientOption(r: HandoffRecipient): ComboOption {
  const manager = r.external ? (r.owner_label ?? r.manager) : r.manager;
  const detail = [r.display_name && r.display_name !== r.name ? r.name : null, manager ? t.managedBy(manager) : null].filter(Boolean).join(' · ');
  return {
    value: r.name,
    label: r.display_name || r.name,
    ...(detail ? { detail: `· ${detail}` } : {}),
    ...(r.external ? { badge: <Badge tone="warn">{t.externalBadge}</Badge> } : {}),
    ...(r.what_i_do ? { hint: r.what_i_do } : {}),
  };
}

/** The two panes; `space` filters to one space (its Messages tab). */
export function ThreadView({ space }: { space?: string } = {}) {
  const session = useSession();
  const me = session.data?.name ?? '';
  const [tab, setTab] = useState<InboxTab>('inbox');
  const [selected, setSelected] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const q = useQuery({
    queryKey: ['handoff', 'all', true, space ?? null],
    queryFn: () => api.handoffInbox({ box: 'all', include_done: true, ...(space ? { space } : {}) }),
  });
  const threads = useMemo(() => {
    const all = buildThreads(q.data?.messages ?? [], me);
    // The global Inbox: your own conversations; a space tab: everything of that space you can read.
    return space ? all : all.filter((th) => th.mine);
  }, [q.data, me, space]);
  const shown = tab === 'sent' ? sentThreads(threads, me) : threads.filter((th) => th.tab === tab);
  const current = threads.find((th) => th.id === selected);
  const counts = Object.fromEntries(TABS.map((k) => [k, threads.filter((th) => th.tab === k && th.unread).length])) as Record<InboxTab, number>;

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(16rem,22rem)_1fr]">
      <section aria-label={t.threads} className="min-w-0 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div role="tablist" aria-label={t.tabsLabel} className="flex gap-1 text-sm">
            {TABS.map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                className={`rounded-md px-2.5 py-1 ${tab === k ? 'bg-zinc-100 font-medium dark:bg-zinc-800' : 'text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-900'}`}
                onClick={() => setTab(k)}
              >
                {t.tabs[k]}
                {counts[k] > 0 && <span className="ml-1 text-xs text-sky-700 dark:text-sky-400">{counts[k]}</span>}
              </button>
            ))}
          </div>
          {!space && (
            <button
              type="button"
              className={BTN_PRIMARY}
              onClick={() => {
                setComposing(true);
                setSelected(null);
              }}
            >
              {t.newMessage}
            </button>
          )}
        </div>
        {q.isPending && <Spinner />}
        {q.isError && <ErrorView error={q.error} />}
        {q.data && shown.length === 0 && <p className="px-2 py-3 text-sm text-zinc-500">{space && threads.length === 0 ? t.spaceEmpty : t.empty[tab]}</p>}
        {shown.length > 0 && (
          <ul className="divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {shown.map((th) => (
              <li key={th.id}>
                <ThreadRow
                  thread={th}
                  me={me}
                  active={th.id === selected}
                  showSpace={!space}
                  onOpen={() => {
                    setSelected(th.id);
                    setComposing(false);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        {q.data?.more && <p className="text-xs text-zinc-500">{t.more50}</p>}
      </section>
      <section aria-label={current ? current.subject : t.newMessage} className="min-w-0">
        {composing ? (
          <NewMessage
            onDone={() => setComposing(false)}
            onSent={(m) => {
              setComposing(false);
              setTab('sent');
              setSelected(m.thread_id);
            }}
          />
        ) : current ? (
          <Conversation key={current.id} thread={current} me={me} />
        ) : (
          <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">{t.pick}</p>
        )}
      </section>
    </div>
  );
}

/** The recipient's state of one message: display only, never an ack. */
export function StateChip({ m }: { m: HandoffMessage }) {
  const s = senderState(m);
  const when = 'at' in s && s.at ? formatClock(s.at) : '';
  const text = s.kind === 'seen' ? t.state.seen(when) : s.kind === 'done' ? t.state.done(when) : t.state[s.kind];
  const tone = s.kind === 'seen' ? 'info' : s.kind === 'updated' ? 'warn' : s.kind === 'done' ? 'ok' : s.kind === 'declined' ? 'danger' : 'neutral';
  const note = (s.kind === 'done' || s.kind === 'declined') && s.note ? ` — “${s.note}”` : '';
  return (
    <span data-testid={`state-${m.id}`} data-state={s.kind} className="inline-flex">
      <Badge tone={tone} title={`${t.stateHint[s.kind](m.to)}${note}`}>
        <span className="sr-only">{t.stateLabel}: </span>
        {text}
      </Badge>
    </span>
  );
}

function ThreadRow({ thread, me, active, showSpace, onOpen }: { thread: Thread; me: string; active: boolean; showSpace: boolean; onOpen: () => void }) {
  const latest = thread.latest;
  const status = statusMessage(thread, me);
  return (
    <button
      type="button"
      data-testid={`thread-${thread.id}`}
      aria-current={active ? 'true' : undefined}
      onClick={onOpen}
      className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm ${active ? 'bg-sky-50 dark:bg-sky-950/40' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900'}`}
    >
      <span className="flex items-baseline gap-2">
        <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${thread.unread ? 'bg-sky-600' : 'bg-transparent'}`} />
        {thread.unread && <span className="sr-only">{t.unread}</span>}
        <span className={`truncate ${thread.unread ? 'font-semibold' : 'font-medium'}`}>{thread.other}</span>
        {thread.otherExternal && <Badge tone="warn">{t.externalBadge}</Badge>}
        <span className="ml-auto shrink-0 text-xs text-zinc-500">{latest.age}</span>
      </span>
      <span className="flex items-baseline gap-2 pl-4">
        <span className="min-w-0 truncate">{thread.subject}</span>
        {status && (
          <span className="ml-auto shrink-0">
            <StateChip m={status} />
          </span>
        )}
      </span>
      <span className="truncate pl-4 text-xs text-zinc-500">
        {showSpace && thread.space !== 'handoff' ? `${t.inSpace(thread.space)} · ` : ''}
        {latest.snippet ?? ''}
      </span>
    </button>
  );
}

function Conversation({ thread, me }: { thread: Thread; me: string }) {
  const qc = useQueryClient();
  const rid = useMemo(() => requestIdFor(), []);
  const [reply, setReply] = useState('');
  const [declining, setDeclining] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const marked = useRef(new Set<string>());
  const order = conversationOrder(thread);
  const bodies = useQueries({
    queries: thread.messages.map((m) => ({ queryKey: ['message-body', m.id, m.rev], queryFn: () => api.read({ id: m.id }), staleTime: 60_000 })),
  });
  const bodyById = new Map(thread.messages.map((m, i) => [m.id, bodies[i]]));
  const refresh = () => qc.invalidateQueries({ queryKey: ['handoff'] });

  // Received only after the bodies are on screen, only for messages to me (never oversight).
  const due = thread.mine ? toMarkReceived(thread, me) : [];
  const rendered = due.filter((d) => bodyById.get(d.id)?.isSuccess === true);
  const dueKey = rendered.map((d) => `${d.id}:${d.rev}`).join(',');
  useEffect(() => {
    const todo = rendered.filter((d) => !marked.current.has(`${d.id}:${d.rev}`));
    if (todo.length === 0) return;
    for (const d of todo) marked.current.add(`${d.id}:${d.rev}`);
    void Promise.allSettled(todo.map((d) => api.handoffAck({ id: d.id, expected_rev: d.rev, status: 'received' }))).then(() => refresh());
  }, [dueKey]);

  const done = useMutation({
    mutationFn: async (snapshot: { id: string; rev: number }[]) => {
      // Sequential, each with the revision on screen: a message that changed meanwhile stays open.
      for (const s of snapshot) {
        await api.handoffAck({ id: s.id, expected_rev: s.rev, status: 'done' }).catch((e: unknown) => {
          if ((e as { code?: string }).code !== 'conflict') throw e;
        });
      }
    },
    onSuccess: () => void refresh(),
    onError: setError,
  });
  const decline = useMutation({
    mutationFn: (i: { m: HandoffMessage; note: string }) => api.handoffAck({ id: i.m.id, expected_rev: i.m.rev, status: 'declined', note: i.note }),
    onSuccess: () => {
      setDeclining(null);
      void refresh();
    },
    onError: setError,
  });
  const withdraw = useMutation({
    mutationFn: (m: HandoffMessage) => api.delete({ id: m.id, expected_rev: m.rev, message: t.withdrawn }),
    onSuccess: () => void refresh(),
    onError: setError,
  });
  const send = useMutation({
    mutationFn: (body: string) => {
      const input = { to: thread.other, title: `Re: ${thread.subject}`, body, reply_to: thread.latest.id };
      return rid.run(input, (request_id) => api.handoffSend({ ...input, request_id }));
    },
    onSuccess: () => {
      setReply('');
      setError(null);
      void refresh();
    },
    onError: setError,
  });

  const snapshot = thread.mine ? doneSnapshot(thread, me) : [];
  const toDecline = thread.mine ? latestOpenTo(thread, me) : undefined;
  const toWithdraw = thread.mine ? latestOpenFrom(thread, me) : undefined;
  const declined = toDecline && declining !== null ? toDecline : undefined;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reply.trim()) send.mutate(reply);
  };

  return (
    <article className="flex flex-col gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{thread.subject}</h2>
          <p className="text-sm text-zinc-500">
            {thread.other}
            {thread.space !== 'handoff' && ` · ${t.inSpace(thread.space)}`}
          </p>
        </div>
        {thread.mine && (
          <div className="flex items-center gap-2">
            <button type="button" className={BTN} onClick={() => composer.current?.focus()}>
              {t.reply}
            </button>
            {snapshot.length > 0 && (
              <button type="button" className={BTN_PRIMARY} disabled={done.isPending} onClick={() => done.mutate(snapshot)}>
                {t.done}
              </button>
            )}
            {(toDecline || toWithdraw) && (
              <Menu label={t.more} button="⋯">
                {(close) => (
                  <>
                    {toDecline && (
                      <button
                        role="menuitem"
                        type="button"
                        className={MENU_ITEM}
                        onClick={() => {
                          setDeclining('');
                          close();
                        }}
                      >
                        {t.decline}
                      </button>
                    )}
                    {toWithdraw && (
                      <button
                        role="menuitem"
                        type="button"
                        className={MENU_ITEM}
                        onClick={() => {
                          close();
                          if (window.confirm(t.withdrawConfirm)) withdraw.mutate(toWithdraw);
                        }}
                      >
                        {t.withdraw}
                      </button>
                    )}
                  </>
                )}
              </Menu>
            )}
          </div>
        )}
      </header>
      {!thread.mine && <p className="rounded-md bg-zinc-50 p-2 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">{t.oversight}</p>}
      {declined && (
        <div className="flex flex-wrap gap-2">
          <input
            aria-label={t.note}
            className={`${INPUT} min-w-60 flex-1`}
            placeholder={t.notePlaceholder}
            maxLength={500}
            value={declining ?? ''}
            onChange={(e) => setDeclining(e.target.value)}
          />
          <button type="button" className={BTN_DANGER} disabled={!declining?.trim() || decline.isPending} onClick={() => decline.mutate({ m: declined, note: declining!.trim() })}>
            {t.declineSend}
          </button>
          <button type="button" className={BTN} onClick={() => setDeclining(null)}>
            {t.cancel}
          </button>
        </div>
      )}
      <ol className="flex flex-col gap-2" aria-label={thread.subject}>
        {order.map(({ m, depth }) => {
          const b = bodyById.get(m.id);
          const fromMe = m.from === me;
          return (
            <li
              key={m.id}
              data-testid={`msg-${m.id}`}
              style={depth > 0 ? { marginLeft: `${Math.min(depth, 3) * 20}px` } : undefined}
              className={`rounded-md border px-3 py-2 ${fromMe ? 'border-sky-200 bg-sky-50/60 dark:border-sky-900 dark:bg-sky-950/30' : 'border-zinc-200 dark:border-zinc-800'}`}
            >
              <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-zinc-500">
                <span className="font-medium text-zinc-800 dark:text-zinc-200">{m.from}</span>
                {m.from_external && <Badge tone="warn">{t.externalBadge}</Badge>}
                <span aria-hidden>→</span>
                <span>{m.to}</span>
                <span className="ml-auto">{formatClock(m.created_at)}</span>
              </div>
              <div className="mt-1 text-sm">
                {b?.isPending && <span className="text-zinc-500">{t.loadingBody}</span>}
                {b?.isError && <ErrorView error={b.error} />}
                {b?.data && <Markdown source={bodyOf(b.data.content)} env={{ space: m.space, docPath: m.path }} />}
              </div>
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-zinc-500">
                {fromMe || !thread.mine ? (
                  <>
                    <StateChip m={m} />
                    {(m.status === 'done' || m.status === 'declined') && m.note !== null && <span>{t.recipientNote(m.resolved_by ?? m.to, m.note)}</span>}
                  </>
                ) : (
                  (m.status === 'done' || m.status === 'declined') && (
                  <Badge tone={m.status === 'done' ? 'ok' : 'danger'}>
                    {t.statusLabel[m.status]}
                      {m.resolved_by ? ` · ${m.resolved_by}` : ''}
                    </Badge>
                  )
                )}
                {!fromMe && thread.mine && m.note !== null && <span>“{m.note}”</span>}
              </div>
            </li>
          );
        })}
      </ol>
      {error !== null && (
        <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300">
          {errorText(error)}
        </p>
      )}
      {thread.mine && (
        <form onSubmit={submit} aria-label={t.composer} className="flex flex-col gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <textarea
            ref={composer}
            aria-label={t.composer}
            className={`${INPUT} min-h-20`}
            placeholder={t.composerPlaceholder(thread.other)}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
          />
          <div>
            <button type="submit" className={BTN_PRIMARY} disabled={send.isPending || !reply.trim()}>
              {t.send}
            </button>
          </div>
        </form>
      )}
    </article>
  );
}

interface Draft {
  to: string;
  title: string;
  body: string;
  /** Only asked when the recipient is reachable in several spaces. */
  space?: string;
}

/** Default space for a recipient reachable in several: handoff if among them (as the server), else the first. */
const defaultSpace = (spaces: string[]): string => (spaces.includes('handoff') ? 'handoff' : (spaces[0] ?? ''));

function NewMessage({ onDone, onSent }: { onDone: () => void; onSent: (m: HandoffMessage) => void }) {
  const qc = useQueryClient();
  const rid = useMemo(() => requestIdFor(), []);
  const [draft, setDraft] = useState<Draft>({ to: '', title: '', body: '' });
  const recipientsQ = useQuery({ queryKey: ['handoff', 'recipients'], queryFn: api.handoffRecipients });
  const recipients = recipientsQ.data?.recipients ?? [];
  const chosen = recipients.find((r) => r.name === draft.to);
  const send = useMutation({
    mutationFn: (d: Draft) => {
      const input = { to: d.to.trim(), title: d.title, body: d.body, ...(d.space ? { space: d.space } : {}) };
      return rid.run(input, (request_id) => api.handoffSend({ ...input, request_id }));
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['handoff'] });
      onSent(r.message);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (draft.to) send.mutate(draft);
  };
  return (
    <form onSubmit={submit} aria-label={t.newMessage} className="flex flex-col gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <h2 className="text-lg font-semibold">{t.newMessage}</h2>
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="msg-to">{t.toField}</label>
        {recipientsQ.isError ? (
          <ErrorView error={recipientsQ.error} />
        ) : (
          <Combobox
            id="msg-to"
            label={t.toField}
            options={recipients.map(recipientOption)}
            value={draft.to}
            placeholder={recipientsQ.isPending ? tx.common.loading : t.toPlaceholder}
            empty={recipientsQ.isPending ? tx.common.loading : t.noRecipients}
            autoFocus
            onChange={(to) => {
              const r = recipients.find((x) => x.name === to);
              setDraft({ ...draft, to, space: r ? defaultSpace(r.spaces) : '' });
            }}
          />
        )}
      </div>
      {chosen && chosen.spaces.length > 1 && (
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="msg-space">{t.spaceField}</label>
          <div>
            <Select id="msg-space" value={draft.space ?? ''} onChange={(e) => setDraft({ ...draft, space: e.target.value })}>
              {chosen.spaces.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
        </div>
      )}
      <label className="flex flex-col gap-1 text-sm">
        {t.titleField}
        <input className={INPUT} value={draft.title} required maxLength={200} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {t.bodyField}
        <textarea className={`${INPUT} min-h-28`} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
      </label>
      {send.isError && (
        <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300">
          {errorText(send.error)}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className={BTN_PRIMARY} disabled={send.isPending || !draft.to}>
          {t.send}
        </button>
        <button type="button" className={BTN} onClick={onDone}>
          {t.cancel}
        </button>
      </div>
    </form>
  );
}
