// Connect agent: People & agents → Agents → Connect agent.
// Step 1: display name (handle derived, editable), Manager (a person, or someone outside Brain → External),
// Harness. Step 2: spaces and a role each — only what is ticked, never General or all agents on its own.
// Create → one screen shown once: the Brain token and a ready config for that harness (Copy, Download), the
// sentence for the agent; then the live check: "Waiting for X…" → "Connected", what it sees, and the
// negative probe the server makes as the agent. The bundle lives only in this component's state: it is not in
// the query cache, the URL or storage, and leaving the page drops it.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { admin } from '../../api/client';
import type { AdminPrincipal, AdminSpace, AgentConnectOut, ConnectHarness, Ladder, Role, Trust } from '../../api/types';
import { CONNECT_HARNESSES } from '../../api/types';
import { AdminFrame, CARD, CopyButton, Field, INPUT } from '../../components/admin';
import { Select } from '../../components/controls';
import { BTN, BTN_PRIMARY, WriteError } from '../../components/edit';
import { ErrorView, Spinner } from '../../components/ui';
import { invalidateAdmin } from '../../lib/admin';
import { requestIdFor } from '../../lib/edit';
import { formatTime } from '../../lib/format';
import { ENGINE_ROLE, LADDER_LABEL, ladderOptions, requiresApproval } from '../../lib/roles';
import { routes } from '../../lib/routes';
import { useSession } from '../../session';
import { tx } from '../../i18n';
import { PeopleTabs } from './PrincipalsAdmin';

const t = tx.connect;
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const OUTSIDE = '__outside';
const TRUSTS: Trust[] = ['admin', 'trusted', 'limited'];
/** Harnesses that also connect over stdio (brain-mcp); connectome only does, script never. */
const TRANSPORTS: Record<ConnectHarness, ('http' | 'stdio')[]> = {
  'claude-code': ['http', 'stdio'],
  codex: ['http', 'stdio'],
  connectome: ['stdio'],
  hermes: ['http', 'stdio'],
  letta: ['http', 'stdio'],
  generic: ['http', 'stdio'],
  script: ['http'],
};

/** Handle from the display name: "Research bot" with manager alice → alice-research-bot. */
export function deriveHandle(display: string, manager: string | null): string {
  const slug = display
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return '';
  const full = manager && !slug.startsWith(`${manager}-`) ? `${manager}-${slug}` : slug;
  return full.slice(0, 63).replace(/-+$/, '');
}

export function ConnectAgentPage() {
  const [result, setResult] = useState<AgentConnectOut | null>(null);
  return (
    <AdminFrame title={result ? t.onceTitle(result.principal.display_name || result.principal.name) : t.title} tabs={<PeopleTabs active="agents" />}>
      {result ? <OnceScreen r={result} /> : <ConnectForm onCreated={setResult} />}
    </AdminFrame>
  );
}

type Pick = Record<string, Exclude<Ladder, 'none'> | undefined>;

function ConnectForm({ onCreated }: { onCreated: (r: AgentConnectOut) => void }) {
  const me = useSession().data;
  const qc = useQueryClient();
  const people = useQuery({ queryKey: ['admin', 'principals'], queryFn: () => admin.principalList(true) });
  const spaces = useQuery({ queryKey: ['admin', 'spaces'], queryFn: () => admin.spaceList(false) });
  const [f, setF] = useState({ display: '', handle: '', handleEdited: false, manager: me?.name ?? '', outside: '', harness: 'claude-code' as ConnectHarness, transport: 'http' as 'http' | 'stdio', trust: '' as Trust | '' });
  const [picked, setPicked] = useState<Pick>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // The same input keeps its request id: a retry after a lost answer does not create twice (it answers conflict).
  const rid = useMemo(() => requestIdFor(), []);
  const external = f.manager === OUTSIDE;
  const managerName = external || !f.manager ? null : f.manager;
  const handle = f.handleEdited ? f.handle : deriveHandle(f.display, managerName);
  const set = (x: Partial<typeof f>) => setF((v) => ({ ...v, ...x }));
  const transports = TRANSPORTS[f.harness];
  const transport = transports.includes(f.transport) ? f.transport : transports[0]!;
  const humans = (people.data?.principals ?? []).filter((p: AdminPrincipal) => p.kind === 'human' && !p.disabled);
  const active = (spaces.data?.spaces ?? []).filter((s) => !s.archived);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    setError(null);
    if (!f.display.trim()) return setProblem(t.displayNameHint);
    if (!NAME_RE.test(handle)) return setProblem(tx.principals.nameHint);
    if (external && !f.outside.trim()) return setProblem(tx.principals.outsideRequired);
    setBusy(true);
    try {
      const input = {
        name: handle,
        display_name: f.display.trim(),
        harness: f.harness,
        transport,
        ...(external ? { outside: f.outside.trim() } : managerName ? { owner: managerName } : {}),
        ...(f.trust ? { trust: f.trust } : {}),
        spaces: Object.entries(picked).flatMap(([space, role]) => (role ? [{ space, role: ENGINE_ROLE[role] as Exclude<Role, 'none'> }] : [])),
      };
      const out = await rid.run(input, (request_id) => admin.agentConnect({ ...input, request_id }));
      await invalidateAdmin(qc);
      onCreated(out);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-5" aria-label={t.title}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{t.intro}</p>
      <section aria-labelledby="ca-step1" className={`${CARD} space-y-3`}>
        <h2 id="ca-step1" className="font-semibold">
          {t.step1}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="ca-display" label={t.displayName} hint={t.displayNameHint}>
            <input id="ca-display" className={INPUT} maxLength={200} value={f.display} onChange={(e) => set({ display: e.target.value })} autoFocus />
          </Field>
          <Field id="ca-handle" label={t.handle} hint={t.handleHint}>
            <input id="ca-handle" className={`${INPUT} font-mono`} maxLength={63} value={handle} onChange={(e) => set({ handle: e.target.value, handleEdited: true })} />
          </Field>
          <div className="space-y-2">
            <Field id="ca-manager" label={tx.principals.managerLabel} hint={tx.principals.managerHint}>
              <div>
                <Select id="ca-manager" value={f.manager} onChange={(e) => set({ manager: e.target.value })}>
                  <option value="">—</option>
                  {humans.map((p) => (
                    <option key={p.id} value={p.name}>
                      {p.display_name || p.name}
                    </option>
                  ))}
                  <option value={OUTSIDE}>{tx.principals.outsideOption}</option>
                </Select>
              </div>
            </Field>
            {external && (
              <Field id="ca-outside" label={tx.principals.outsideName} hint={tx.principals.externalOwnerHint}>
                <input id="ca-outside" className={INPUT} maxLength={100} value={f.outside} onChange={(e) => set({ outside: e.target.value })} />
              </Field>
            )}
          </div>
          <Field id="ca-harness" label={t.harness} hint={t.harnessHint}>
            <div>
              <Select id="ca-harness" value={f.harness} onChange={(e) => set({ harness: e.target.value as ConnectHarness })}>
                {CONNECT_HARNESSES.map((h) => (
                  <option key={h} value={h}>
                    {t.harnessLabels[h] ?? h}
                  </option>
                ))}
              </Select>
            </div>
          </Field>
        </div>
        {external && <p className="text-xs text-zinc-500">{tx.principals.externalHint}</p>}
        <details>
          <summary className="cursor-pointer text-sm font-medium">{tx.principalPage.tabs.advanced}</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {transports.length > 1 && (
              <Field id="ca-transport" label={t.transport}>
                <div>
                  <Select id="ca-transport" value={transport} onChange={(e) => set({ transport: e.target.value as 'http' | 'stdio' })}>
                    {transports.map((x) => (
                      <option key={x} value={x}>
                        {x === 'http' ? t.transportHttp : t.transportStdio}
                      </option>
                    ))}
                  </Select>
                </div>
              </Field>
            )}
            <Field id="ca-trust" label={tx.principalPage.trust} hint={tx.principals.trustHint}>
              <div>
                <Select id="ca-trust" value={f.trust || (external ? 'limited' : 'trusted')} onChange={(e) => set({ trust: e.target.value as Trust })}>
                  {TRUSTS.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </Select>
              </div>
            </Field>
          </div>
        </details>
      </section>

      <section aria-labelledby="ca-step2" className={`${CARD} space-y-3`}>
        <h2 id="ca-step2" className="font-semibold">
          {t.step2}
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{t.spacesHint}</p>
        {spaces.isPending && <Spinner />}
        {spaces.isError && <ErrorView error={spaces.error} />}
        {spaces.data && active.length === 0 && <p className="text-sm text-zinc-500">{t.noSpaces}</p>}
        <ul className="divide-y divide-zinc-200 border-y border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800" aria-label={t.step2}>
          {active.map((s) => (
            <SpaceRow key={s.slug} s={s} role={picked[s.slug]} onChange={(role) => setPicked((p) => ({ ...p, [s.slug]: role }))} />
          ))}
        </ul>
        {spaces.data && active.length > 0 && !Object.values(picked).some(Boolean) && <p className="text-xs text-zinc-500">{t.noneTicked}</p>}
      </section>

      {problem && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {problem}
        </p>
      )}
      {error !== null && <WriteError error={error} />}
      <div className="flex gap-2">
        <button type="submit" className={BTN_PRIMARY} disabled={busy}>
          {busy ? t.creating : t.create}
        </button>
        <Link to={routes.admin.principals()} className={BTN}>
          {tx.common.cancel}
        </Link>
      </div>
    </form>
  );
}

function SpaceRow({ s, role, onChange }: { s: AdminSpace; role: Exclude<Ladder, 'none'> | undefined; onChange: (r: Exclude<Ladder, 'none'> | undefined) => void }) {
  const options = ladderOptions({ messages: s.inbox, approval: requiresApproval(s) });
  const fallback: Exclude<Ladder, 'none'> = s.inbox && options.includes('guest') ? 'guest' : 'viewer';
  const id = `ca-space-${s.slug}`;
  return (
    <li className="flex flex-wrap items-center gap-3 px-1 py-2 text-sm">
      <label className="flex min-w-48 flex-1 items-center gap-2">
        <input type="checkbox" checked={role !== undefined} onChange={(e) => onChange(e.target.checked ? fallback : undefined)} />
        <span className="font-medium">{s.name || s.slug}</span>
        {s.inbox && <span className="text-xs text-zinc-500">{t.messagesOn}</span>}
      </label>
      <Select id={id} aria-label={`${t.role}: ${s.name || s.slug}`} value={role ?? ''} disabled={role === undefined} onChange={(e) => onChange(e.target.value as Exclude<Ladder, 'none'>)}>
        {role === undefined && <option value="">—</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {LADDER_LABEL[o]}
          </option>
        ))}
      </Select>
    </li>
  );
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** The one screen shown once, then the live check. */
function OnceScreen({ r }: { r: AgentConnectOut }) {
  const navigate = useNavigate();
  const name = r.principal.display_name || r.principal.name;
  const b = r.bundle;
  return (
    <div className="space-y-5">
      <div role="status" className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
        <p className="font-medium">{t.onceWarning}</p>
        <div className="space-y-1">
          <p className="font-medium">{t.token}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code aria-label={t.token} className="rounded bg-white px-2 py-1 font-mono text-xs break-all dark:bg-zinc-900">
              {r.token}
            </code>
            <CopyButton text={r.token} label={t.copyToken} />
          </div>
        </div>
      </div>
      <section aria-labelledby="ca-config" className={`${CARD} space-y-2`}>
        <h2 id="ca-config" className="font-semibold">
          {t.configFor(t.harnessLabels[b.harness] ?? b.harness)}
        </h2>
        <p className="text-sm">{b.where}</p>
        <pre tabIndex={0} aria-label={t.configFor(b.harness)} className="overflow-x-auto rounded bg-zinc-50 p-2 font-mono text-xs break-all whitespace-pre-wrap dark:bg-zinc-900">
          {b.config}
        </pre>
        <p className="text-xs text-zinc-500">{t.containsToken}</p>
        <div className="flex flex-wrap gap-2">
          <CopyButton text={b.config} label={t.copyConfig} />
          <button type="button" className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800" onClick={() => download(b.filename, b.config)}>
            {t.download} {b.filename}
          </button>
        </div>
        <details>
          <summary className="cursor-pointer text-sm">{t.fullGuide}</summary>
          <pre tabIndex={0} aria-label={t.fullGuide} className="mt-2 overflow-x-auto rounded bg-zinc-50 p-2 text-xs break-all whitespace-pre-wrap dark:bg-zinc-900">
            {b.text}
          </pre>
          <div className="flex flex-wrap gap-2">
            <CopyButton text={b.text} label={t.copyGuide} />
            <button type="button" className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800" onClick={() => download(`brain-${r.principal.name}-guide.md`, b.text)}>
              {t.download} brain-{r.principal.name}-guide.md
            </button>
          </div>
        </details>
      </section>
      <section aria-labelledby="ca-sentence" className={`${CARD} space-y-2`}>
        <h2 id="ca-sentence" className="font-semibold">
          {t.sentence}
        </h2>
        <blockquote className="border-l-2 border-sky-600 pl-3 text-sm">{b.sentence}</blockquote>
        <CopyButton text={b.sentence} label={t.copySentence} />
      </section>
      <LiveCheck name={r.principal.name} display={name} tokenId={r.info.id} />
      <button type="button" className={BTN_PRIMARY} onClick={() => navigate(routes.admin.principal(r.principal.name))}>
        {t.done}
      </button>
    </div>
  );
}

const POLL_MS = 3000;
const POLL_FOR_MS = 15 * 60 * 1000;

/** "Waiting for X…" → "Connected" (authenticated first contact, from the server), then Sees / Does not see. */
export function LiveCheck({ name, display, tokenId }: { name: string; display: string; tokenId: string }) {
  const [started] = useState(() => Date.now());
  const [stopped, setStopped] = useState(false);
  const q = useQuery({
    queryKey: ['admin', 'connection', name, tokenId],
    queryFn: () => admin.agentConnection({ name, token_id: tokenId }),
    refetchInterval: (query) => (stopped || query.state.data?.connected || Date.now() - started > POLL_FOR_MS ? false : POLL_MS),
    retry: false,
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorView error={q.error} />;
  const s = q.data;
  const gone = s.token.revoked || s.token.expired;
  return (
    <section aria-labelledby="ca-live" className={`${CARD} space-y-3`} aria-live="polite">
      <h2 id="ca-live" className="font-semibold">
        {s.connected ? t.connected(display) : t.waiting(display)}
        {s.connected && s.last_contact_at && <span className="ml-2 text-sm font-normal text-zinc-500">{t.lastContact(formatTime(s.last_contact_at))}</span>}
      </h2>
      {gone && <p className="text-sm text-red-700 dark:text-red-400">{t.tokenGone}</p>}
      {!s.connected && !gone && (
        <>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{t.waitingHint}</p>
          <div className="flex gap-2">
            {!stopped && Date.now() - started <= POLL_FOR_MS ? (
              <button type="button" className={BTN} onClick={() => setStopped(true)}>
                {t.stopWaiting}
              </button>
            ) : (
              <button
                type="button"
                className={BTN}
                onClick={() => {
                  setStopped(false);
                  void q.refetch();
                }}
              >
                {t.checkAgain}
              </button>
            )}
          </div>
        </>
      )}
      {s.connected && (
        <>
          <div>
            <h3 className="text-sm font-semibold">{t.sees}</h3>
            {s.sees.length === 0 ? (
              <p className="text-sm text-zinc-500">{t.seesNone}</p>
            ) : (
              <ul className="text-sm" aria-label={t.sees}>
                {s.sees.map((x) => (
                  <li key={x.space}>
                    {x.name || x.space} — {LADDER_LABEL[x.role]}
                    {x.messages_only && <span className="text-zinc-500">: {t.messagesOnly}</span>}
                    {x.via.length > 0 && <span className="text-zinc-500"> ({t.via(x.via.join(', '))})</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {s.not_sees && (
            <div>
              <h3 className="text-sm font-semibold">{t.notSees(s.not_sees.count)}</h3>
              {s.not_sees.count > 0 && <p className="text-xs text-zinc-500">{t.probeHint}</p>}
              <ul className="text-sm" aria-label={t.notSees(s.not_sees.count)}>
                {s.not_sees.probes.map((p) => (
                  <li key={p.space}>
                    {p.name || p.space} —{' '}
                    {p.confirmed ? <span className="text-emerald-700 dark:text-emerald-400">{t.probeOk}</span> : <span className="text-red-700 dark:text-red-400">{t.probeBad(p.list, p.read)}</span>}
                  </li>
                ))}
              </ul>
              {s.not_sees.count > 0 && (
                <p className={`mt-1 text-sm ${s.not_sees.all_confirmed ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}>
                  {s.not_sees.all_confirmed ? t.probeAllOk : t.probeProblem}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
