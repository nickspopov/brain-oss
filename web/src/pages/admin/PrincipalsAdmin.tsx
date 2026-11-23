// People & agents: list, create; an agent / person page with tabs
// Overview (profile, Manager → External, harness, status, last seen) · Access (spaces in plain words,
// "Why?" — this tab is "View as") · Connection (tokens, guide; agents only) · Advanced (trust, limits,
// the one "Brain administrator" checkbox, password). Disable is always in the header.
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { admin } from '../../api/client';
import type { AdminPrincipal, AdminToken, GrantKey, Ladder, Role, Trust } from '../../api/types';
import { AdminFrame, CARD, CopyButton, Done, Field, HARNESS_OPTIONS, HarnessField, harnessChoice, INPUT, useAdminMutation } from '../../components/admin';
import { Select } from '../../components/controls';
import { Notice } from '../../components/DocActions';
import { BTN, BTN_DANGER, BTN_PRIMARY, WriteError } from '../../components/edit';
import { Badge, ErrorView, Spinner } from '../../components/ui';
import { GRANT_ROLE_LABEL, LEVEL_LABEL as GRANT_LEVEL, targetText, tokenStatus, withToken } from '../../lib/admin';
import { formatTime, ROLE_LABEL } from '../../lib/format';
import { accessLine, ENGINE_ROLE, LADDER_LABEL, ladderOptions, requiresApproval } from '../../lib/roles';
import { routes } from '../../lib/routes';
import { useSession } from '../../session';
import { tx } from '../../i18n';

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const NAME_HINT = tx.principals.nameHint;
const TRUSTS: Trust[] = ['admin', 'trusted', 'limited'];
const TRUST_HINT = tx.principals.trustHint;
/** Manager select value for "a person outside Brain": the agent becomes external. */
const OUTSIDE = '__outside';

/** Who manages this agent or person: the managing person in Brain, or the outside person of an external agent. */
export function managerOf(p: AdminPrincipal): string | null {
  return p.external ? (p.external.owner_label ?? p.owner) : p.owner;
}

/** Exceptions only: External and Disabled; administrators on their own page. */
function PrincipalBadges({ p, detail }: { p: AdminPrincipal; detail?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {p.external && <Badge tone="warn">{tx.principals.externalBadge}</Badge>}
      {p.disabled && <Badge tone="danger">{tx.principals.disabled}</Badge>}
      {detail && p.role === 'superadmin' && <Badge tone="ok">{tx.principalPage.superadmin}</Badge>}
      {detail && p.admin && p.role !== 'superadmin' && <Badge>{tx.principals.administrator}</Badge>}
    </span>
  );
}

export type PeopleTab = 'agents' | 'people' | 'groups';

/** Tabs of People & agents: Agents (default) | People | Groups. */
export function PeopleTabs({ active }: { active: PeopleTab }) {
  const tabs: [PeopleTab, string, string][] = [
    ['agents', tx.principals.agents, routes.admin.principals()],
    ['people', tx.principals.people, `${routes.admin.principals()}?tab=people`],
    ['groups', tx.access.groupsTitle, routes.admin.groups()],
  ];
  return (
    <nav aria-label={tx.principals.tabs} className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
      {tabs.map(([key, label, to]) => (
        <Link
          key={key}
          to={to}
          aria-current={key === active ? 'page' : undefined}
          className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
            key === active ? 'border-sky-600 font-medium' : 'border-transparent text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
          }`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function PrincipalsAdminPage() {
  const [params, setParams] = useSearchParams();
  const tab: 'agents' | 'people' = params.get('tab') === 'people' ? 'people' : 'agents';
  const showDisabled = params.get('disabled') === '1';
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['admin', 'principals'], queryFn: () => admin.principalList(true) });
  const list = (q.data?.principals ?? []).filter((p) => p.kind === (tab === 'agents' ? 'agent' : 'human'));
  const hidden = list.filter((p) => p.disabled).length;
  const shown = showDisabled ? list : list.filter((p) => !p.disabled);
  const toggleDisabled = (on: boolean) => {
    const next = new URLSearchParams(params);
    if (on) next.set('disabled', '1');
    else next.delete('disabled');
    setParams(next, { replace: true });
  };
  return (
    <AdminFrame
      title={tx.principals.title}
      tabs={<PeopleTabs active={tab} />}
      actions={
        !creating &&
        (tab === 'agents' ? (
          // Connect agent is the way in; "Add agent" stays for an agent without a token yet.
          <div className="flex flex-wrap gap-2">
            <Link to={routes.admin.connectAgent()} className={BTN_PRIMARY}>
              {tx.connect.button}
            </Link>
            <button type="button" className={BTN} onClick={() => setCreating(true)}>
              {tx.principals.addAgent}
            </button>
          </div>
        ) : (
          <button type="button" className={BTN_PRIMARY} onClick={() => setCreating(true)}>
            {tx.principals.addPerson}
          </button>
        ))
      }
    >
      {creating && <CreatePrincipal key={tab} kind={tab === 'agents' ? 'agent' : 'human'} principals={q.data?.principals ?? []} onCancel={() => setCreating(false)} />}
      {q.isPending && <Spinner />}
      {q.isError && <ErrorView error={q.error} />}
      {q.data && (
        <>
          <label className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
            <input type="checkbox" checked={showDisabled} onChange={(e) => toggleDisabled(e.target.checked)} />
            {tx.principals.showDisabled(hidden)}
          </label>
          <PrincipalList title={tab === 'agents' ? tx.principals.agents : tx.principals.people} items={shown} empty={tab === 'agents' ? tx.principals.noAgents : tx.principals.noPeople} />
        </>
      )}
    </AdminFrame>
  );
}

function PrincipalList({ title, items, empty }: { title: string; items: AdminPrincipal[]; empty: string }) {
  return (
    <section aria-label={title}>
      {items.length === 0 && <p className="text-sm text-zinc-500">{empty}</p>}
      <ul className="divide-y divide-zinc-200 border-y border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {items.map((p) => {
          const manager = managerOf(p);
          return (
            <li key={p.id} className="px-1 py-2">
              {/* name · what it does · manager · last seen · status. */}
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <Link to={routes.admin.principal(p.name)} className="font-medium text-sky-700 hover:underline dark:text-sky-400">
                  {p.display_name || p.name}
                </Link>
                {p.display_name !== p.name && <span className="text-sm text-zinc-500">{p.name}</span>}
                {manager && <span className="text-sm text-zinc-500">{tx.principals.managedBy(manager)}</span>}
                {p.last_seen && <span className="text-xs text-zinc-500">{tx.principals.lastSeenShort(formatTime(p.last_seen))}</span>}
                <PrincipalBadges p={p} />
              </div>
              {p.what_i_do && <p className="text-sm text-zinc-600 dark:text-zinc-400">{p.what_i_do}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CreatePrincipal({ kind, principals, onCancel }: { kind: 'agent' | 'human'; principals: AdminPrincipal[]; onCancel: () => void }) {
  const navigate = useNavigate();
  const me = useSession().data;
  const [f, setF] = useState({
    name: '',
    display_name: '',
    trust: 'trusted' as Trust,
    harness: '',
    manager: me?.name ?? '',
    password: '',
    outside: '',
  });
  const [problem, setProblem] = useState<string | null>(null);
  const create = useAdminMutation(
    (i: Parameters<typeof admin.principalCreate>[0] & { request_id: string }) => admin.principalCreate(i),
    (out) =>
      navigate(routes.admin.principal(out.principal.name), {
        state: { notice: out.principal.kind === 'agent' ? tx.principals.agentCreated(out.principal.name) : tx.principals.created(out.principal.name) },
      }),
  );
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const external = kind === 'agent' && f.manager === OUTSIDE;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    const name = f.name.trim();
    if (!NAME_RE.test(name)) return setProblem(NAME_HINT);
    if (external && !f.outside.trim()) return setProblem(tx.principals.outsideRequired);
    create.mutate({
      name,
      kind,
      trust: f.trust,
      ...(f.display_name.trim() ? { display_name: f.display_name.trim() } : {}),
      ...(kind === 'agent' && f.harness.trim() ? { harness: f.harness.trim() } : {}),
      ...(f.manager && !external ? { owner: f.manager } : {}),
      ...(kind === 'human' && f.password ? { password: f.password } : {}),
      ...(external ? { external: true, owner_label: f.outside.trim() } : {}),
    });
  };
  const people = principals.filter((p) => p.kind === 'human' && !p.disabled);
  return (
    <form onSubmit={submit} className={`${CARD} space-y-3`} aria-label={kind === 'agent' ? tx.principals.newAgent : tx.principals.newPerson}>
      <h2 className="font-semibold">{kind === 'agent' ? tx.principals.newAgent : tx.principals.newPerson}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="np-name" label={tx.common.name} hint={NAME_HINT}>
          <input id="np-name" className={`${INPUT} font-mono`} value={f.name} onChange={(e) => set({ name: e.target.value })} autoFocus />
        </Field>
        <Field id="np-display" label={tx.principals.displayName}>
          <input id="np-display" className={INPUT} maxLength={200} value={f.display_name} onChange={(e) => set({ display_name: e.target.value })} />
        </Field>
        <div className="space-y-2">
          <Field id="np-manager" label={tx.principals.managerLabel} hint={kind === 'agent' ? tx.principals.managerHint : tx.principals.managerHintPerson}>
            <div>
              <Select
                id="np-manager"
                value={f.manager}
                onChange={(e) => set({ manager: e.target.value, ...(e.target.value === OUTSIDE ? { trust: 'limited' as Trust } : {}) })}
              >
                <option value="">—</option>
                {people.map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.name}
                  </option>
                ))}
                {kind === 'agent' && <option value={OUTSIDE}>{tx.principals.outsideOption}</option>}
              </Select>
            </div>
          </Field>
          {external && (
            <Field id="np-outside" label={tx.principals.outsideName} hint={tx.principals.externalOwnerHint}>
              <input id="np-outside" className={INPUT} maxLength={100} value={f.outside} onChange={(e) => set({ outside: e.target.value })} />
            </Field>
          )}
        </div>
        {kind === 'agent' ? (
          <HarnessField id="np-harness" value={f.harness} onChange={(harness) => set({ harness })} hint={tx.principals.harnessHint} />
        ) : (
          <Field id="np-password" label={tx.principals.uiPassword} hint={tx.principals.uiPasswordHint}>
            <input id="np-password" type="password" autoComplete="new-password" className={INPUT} value={f.password} onChange={(e) => set({ password: e.target.value })} />
          </Field>
        )}
      </div>
      {external && <p className="text-xs text-zinc-500">{tx.principals.externalHint}</p>}
      {/* Trust only under Advanced (vocabulary lock). */}
      <details>
        <summary className="cursor-pointer text-sm font-medium">{tx.principalPage.tabs.advanced}</summary>
        <div className="mt-2">
          <Field id="np-trust" label={tx.principalPage.trust} hint={TRUST_HINT}>
            <div>
              <Select id="np-trust" value={f.trust} onChange={(e) => set({ trust: e.target.value as Trust })}>
                {TRUSTS.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </Select>
            </div>
          </Field>
        </div>
      </details>
      {problem && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {problem}
        </p>
      )}
      {create.error && <WriteError error={create.error} />}
      <div className="flex gap-2">
        <button type="submit" className={BTN_PRIMARY} disabled={create.isPending}>
          {tx.common.create}
        </button>
        <button type="button" className={BTN} onClick={onCancel}>
          {tx.common.cancel}
        </button>
      </div>
    </form>
  );
}

export type PrincipalTab = 'overview' | 'access' | 'connection' | 'advanced';

export function PrincipalAdminPage() {
  const { name = '', tab: rawTab } = useParams();
  const q = useQuery({ queryKey: ['admin', 'principals'], queryFn: () => admin.principalList(true) });
  const p = q.data?.principals.find((x) => x.name === name);
  const tab: PrincipalTab = rawTab === 'access' || rawTab === 'advanced' || (rawTab === 'connection' && p?.kind !== 'human') ? rawTab : 'overview';
  return (
    <AdminFrame
      title={p ? p.display_name || p.name : tx.principals.agent}
      actions={p && <DisableButton p={p} />}
      tabs={p && p.kind !== 'system' ? <PeopleTabs active={p.kind === 'agent' ? 'agents' : 'people'} /> : undefined}
    >
      {q.isPending && <Spinner />}
      {q.isError && <ErrorView error={q.error} />}
      {q.data && !p && <ErrorView error={{ code: 'not_found' }} />}
      {p && <PrincipalAdmin key={p.id} p={p} all={q.data?.principals ?? []} tab={tab} />}
    </AdminFrame>
  );
}

/** Tabs of an agent / person page: Overview · Access · Connection (agents) · Advanced. */
function PrincipalTabs({ p, active }: { p: AdminPrincipal; active: PrincipalTab }) {
  const t = tx.principalPage.tabs;
  const tabs: [PrincipalTab, string, string][] = [
    ['overview', t.overview, routes.admin.principal(p.name)],
    ['access', t.access, routes.admin.principal(p.name, 'access')],
    ...(p.kind !== 'human' ? ([['connection', t.connection, routes.admin.principal(p.name, 'connection')]] as [PrincipalTab, string, string][]) : []),
    ['advanced', t.advanced, routes.admin.principal(p.name, 'advanced')],
  ];
  return (
    <nav aria-label={tx.principalPage.tabsLabel} className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
      {tabs.map(([key, label, to]) => (
        <Link
          key={key}
          to={to}
          aria-current={key === active ? 'page' : undefined}
          className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
            key === active ? 'border-sky-600 font-medium' : 'border-transparent text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
          }`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

function PrincipalAdmin({ p, all, tab }: { p: AdminPrincipal; all: AdminPrincipal[]; tab: PrincipalTab }) {
  const [issued, setIssued] = useState<{ token: string; info: AdminToken } | null>(null);
  return (
    <div className="space-y-5">
      <Notice />
      <div className="flex flex-wrap items-center gap-2">
        {p.display_name !== p.name && <span className="text-sm text-zinc-500">{p.name}</span>}
        <PrincipalBadges p={p} detail />
      </div>
      <PrincipalTabs p={p} active={tab} />
      {tab === 'overview' && <Overview p={p} all={all} />}
      {tab === 'access' && <AccessTab p={p} />}
      {tab === 'connection' && (
        <div className="space-y-5">
          {p.role !== 'superadmin' && (
            <section aria-labelledby="pr-tokens" className={`${CARD} space-y-3`}>
              <h2 id="pr-tokens" className="font-semibold">
                {tx.principals.tokens}
              </h2>
              {issued && <IssuedToken issued={issued} p={p} onHide={() => setIssued(null)} />}
              <IssueToken p={p} onIssued={setIssued} />
              <TokenList p={p} />
            </section>
          )}
          {p.kind === 'agent' && !issued && <ConnectGuide p={p} />}
        </div>
      )}
      {tab === 'advanced' && <AdvancedTab p={p} />}
    </div>
  );
}

/** The full token, once. It is neither in the query cache nor in the URL; leave the page and it's gone. */
function IssuedToken({ issued, p, onHide }: { issued: { token: string; info: AdminToken }; p: AdminPrincipal; onHide: () => void }) {
  const q = useConnectGuide(p, p.kind === 'agent');
  const guide = q.data ? withToken(q.data.text, issued.token) : null;
  return (
    <div role="status" className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
      <p className="font-medium">{tx.principals.issued(issued.info.label || issued.info.prefix)}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code aria-label={tx.principals.newToken} className="rounded bg-white px-2 py-1 font-mono text-xs break-all dark:bg-zinc-900">
          {issued.token}
        </code>
        <CopyButton text={issued.token} label={tx.principals.copyToken} />
      </div>
      {p.kind === 'agent' && guide !== null && (
        <details>
          <summary className="cursor-pointer">{tx.principals.guideWithToken}</summary>
          <pre className="mt-2 overflow-x-auto rounded bg-white p-2 text-xs whitespace-pre-wrap dark:bg-zinc-900">{guide}</pre>
          <CopyButton text={guide} label={tx.principals.copyGuide} />
        </details>
      )}
      <button type="button" className={BTN} onClick={onHide}>
        {tx.principals.savedHide}
      </button>
    </div>
  );
}

function IssueToken({ p, onIssued }: { p: AdminPrincipal; onIssued: (t: { token: string; info: AdminToken }) => void }) {
  const [label, setLabel] = useState('');
  const [days, setDays] = useState('90');
  const issue = useAdminMutation(
    (i: { principal: string; label?: string; days?: number | null; request_id: string }) => admin.tokenIssue(i),
    (out) => {
      setLabel('');
      onIssued(out);
    },
    { freshId: true },
  );
  if (p.disabled) return <p className="text-sm text-zinc-500">{tx.principals.disabledNoTokens}</p>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    issue.mutate({ principal: p.name, ...(label.trim() ? { label: label.trim() } : {}), days: days === 'never' ? null : Number(days) });
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2" aria-label={tx.principals.issueForm}>
      <Field id={`tok-label-${p.id}`} label={tx.principals.label}>
        <input id={`tok-label-${p.id}`} className={`${INPUT} w-56`} maxLength={200} placeholder={tx.principals.labelPlaceholder} value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <Field id={`tok-days-${p.id}`} label={tx.principals.term}>
        <Select id={`tok-days-${p.id}`} value={days} onChange={(e) => setDays(e.target.value)}>
          <option value="30">{tx.principals.days30}</option>
          <option value="90">{tx.principals.days90}</option>
          <option value="365">{tx.principals.year}</option>
          <option value="never">{tx.principals.never}</option>
        </Select>
      </Field>
      <button type="submit" className={BTN_PRIMARY} disabled={issue.isPending}>
        {tx.principals.issue}
      </button>
      {issue.error && (
        <div className="w-full">
          <WriteError error={issue.error} />
        </div>
      )}
    </form>
  );
}

const STATUS: Record<ReturnType<typeof tokenStatus>, { text: string; tone: 'ok' | 'danger' | 'warn' }> = {
  active: { text: tx.principals.status.active, tone: 'ok' },
  revoked: { text: tx.principals.status.revoked, tone: 'danger' },
  expired: { text: tx.principals.status.expired, tone: 'warn' },
};

function TokenList({ p }: { p: AdminPrincipal }) {
  const q = useQuery({ queryKey: ['admin', 'tokens', p.name], queryFn: () => admin.tokenList(p.name) });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorView error={q.error} />;
  if (q.data.tokens.length === 0) return <p className="text-sm text-zinc-500">{tx.principals.noTokens}</p>;
  return (
    <ul className="divide-y divide-zinc-200 dark:divide-zinc-800" aria-label={tx.principals.tokens}>
      {q.data.tokens.map((t) => (
        <TokenRow key={t.id} t={t} />
      ))}
    </ul>
  );
}

function TokenRow({ t }: { t: AdminToken }) {
  const [confirm, setConfirm] = useState(false);
  const revoke = useAdminMutation((i: { id: string; request_id: string }) => admin.tokenRevoke(i));
  const st = STATUS[tokenStatus(t)];
  return (
    <li className="space-y-1 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-xs">{t.prefix}…</code>
        <span className="font-medium">{t.label || tx.principals.noLabel}</span>
        <Badge tone={st.tone}>{st.text}</Badge>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-zinc-500">
        <span>{tx.principals.issuedAt(formatTime(t.created_at))}</span>
        <span>{t.expires_at ? tx.principals.until(formatTime(t.expires_at)) : tx.principals.noExpiry}</span>
        <span>{t.last_used_at ? tx.principals.lastUsed(formatTime(t.last_used_at), t.last_used_ip) : tx.principals.neverUsed}</span>
        {t.revoked_at && <span>{tx.principals.revokedAt(formatTime(t.revoked_at))}</span>}
      </div>
      {!t.revoked &&
        (confirm ? (
          <div className="flex gap-2">
            <button type="button" className={BTN_DANGER} onClick={() => revoke.mutate({ id: t.id })} disabled={revoke.isPending}>
              {tx.principals.revokePrefix(t.prefix)}
            </button>
            <button type="button" className={BTN} onClick={() => setConfirm(false)}>
              {tx.common.cancel}
            </button>
          </div>
        ) : (
          <button type="button" className={BTN} onClick={() => setConfirm(true)} aria-label={tx.principals.revokeToken(t.label || t.prefix)}>
            {tx.principals.revokeEllipsis}
          </button>
        ))}
      {revoke.isSuccess && <Done>{tx.principals.revoked}</Done>}
      {revoke.error && <WriteError error={revoke.error} />}
    </li>
  );
}

type Limits = NonNullable<AdminPrincipal['external']>['limits'];
const LIMIT_KEYS = ['msgs_per_day', 'body_bytes', 'pending_per_recipient', 'token_days'] as const;
const LIMIT_LABEL: Record<(typeof LIMIT_KEYS)[number], string> = {
  msgs_per_day: tx.principals.externalMsgsPerDay,
  body_bytes: tx.principals.externalBodyBytes,
  pending_per_recipient: tx.principals.externalPending,
  token_days: tx.principals.externalTokenDays,
};

/** External agent: owner label, quota used today, limits (empty = no limit). */
function ExternalBox({ p, external }: { p: AdminPrincipal; external: NonNullable<AdminPrincipal['external']> }) {
  const toText = (l: Limits) => Object.fromEntries(LIMIT_KEYS.map((k) => [k, l[k] === null ? '' : String(l[k])])) as Record<(typeof LIMIT_KEYS)[number], string>;
  const [f, setF] = useState({ owner_label: external.owner_label ?? '', ...toText(external.limits) });
  const [problem, setProblem] = useState<string | null>(null);
  const update = useAdminMutation((i: Parameters<typeof admin.principalUpdate>[0] & { request_id: string }) => admin.principalUpdate(i));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    const limits: Partial<Limits> = {};
    for (const k of LIMIT_KEYS) {
      const v = f[k].trim();
      if (v !== '' && !/^[1-9][0-9]*$/.test(v)) return setProblem(`${LIMIT_LABEL[k]}: a whole number, or empty for no limit.`);
      const n = v === '' ? null : Number(v);
      if (n !== external.limits[k]) limits[k] = n;
    }
    const label = f.owner_label.trim();
    update.mutate({
      name: p.name,
      ...(Object.keys(limits).length ? { limits } : {}),
      ...(label !== (external.owner_label ?? '') ? { owner_label: label || null } : {}),
    });
  };
  return (
    <form onSubmit={submit} className={`${CARD} space-y-3`} aria-labelledby="pr-external">
      <h2 id="pr-external" className="font-semibold">
        {tx.principals.externalTitle}
      </h2>
      <p className="text-sm">{tx.principals.externalSentToday(external.sent_today, external.limits.msgs_per_day)}</p>
      <Field id="ext-owner" label={tx.principals.outsideName} hint={tx.principals.externalOwnerHint}>
        <input id="ext-owner" className={INPUT} maxLength={100} value={f.owner_label} onChange={(e) => setF({ ...f, owner_label: e.target.value })} />
      </Field>
      <p className="text-xs text-zinc-500">{tx.principals.externalLimitsHint}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {LIMIT_KEYS.map((k) => (
          <Field key={k} id={`ext-${k}`} label={LIMIT_LABEL[k]}>
            <input id={`ext-${k}`} inputMode="numeric" className={INPUT} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </Field>
        ))}
      </div>
      <p className="text-xs text-zinc-500">{tx.principals.externalRevokeHint}</p>
      {problem && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {problem}
        </p>
      )}
      {update.error && <WriteError error={update.error} />}
      {update.isSuccess && <Done>{tx.principals.externalSaved}</Done>}
      <button type="submit" className={BTN_PRIMARY} disabled={update.isPending}>
        {tx.principals.externalSave}
      </button>
    </form>
  );
}

/** `admin_connect_guide`: the harness is the one recorded for the agent; the server picks it. */
function useConnectGuide(p: AdminPrincipal, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'connect-guide', p.name, p.harness],
    queryFn: () => admin.connectGuide({ principal: p.name }),
    enabled,
    retry: false,
  });
}

/** Connection instructions from the server; they contain no token. */
function ConnectGuide({ p }: { p: AdminPrincipal }) {
  const q = useConnectGuide(p);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorView error={q.error} />;
  const text = q.data.text;
  return (
    <section aria-labelledby="pr-connect" className={`${CARD} space-y-2`}>
      <div className="flex items-center gap-2">
        <h2 id="pr-connect" className="font-semibold">
          {tx.principals.guide}
        </h2>
        <CopyButton text={text} />
      </div>
      <pre aria-label={tx.principals.guideText} className="overflow-x-auto rounded bg-zinc-50 p-2 text-xs whitespace-pre-wrap dark:bg-zinc-900">
        {text}
      </pre>
    </section>
  );
}

// ---------------------------------------------------------------- Overview

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** Overview: who it is, what it does, how to reach it, manager, harness, status, last seen; edit; legacy card. */
function Overview({ p, all }: { p: AdminPrincipal; all: AdminPrincipal[] }) {
  const t = tx.principalPage;
  const manager = managerOf(p);
  const harness = p.harness ? (HARNESS_OPTIONS.find((o) => o.value === harnessChoice(p.harness!))?.label ?? p.harness) : null;
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
        <Fact label={t.whatItDoes}>{p.what_i_do ?? <span className="text-zinc-500">{t.notFilled}</span>}</Fact>
        <Fact label={t.contact}>{p.contact ? <span className="whitespace-pre-wrap">{p.contact}</span> : <span className="text-zinc-500">{t.notFilled}</span>}</Fact>
        <Fact label={t.manager}>
          {manager ?? '—'}
          {p.external && (
            <span className="ml-1.5">
              <Badge tone="warn">{tx.principals.externalBadge}</Badge>
            </span>
          )}
        </Fact>
        {p.kind === 'agent' && <Fact label={t.harness}>{harness ?? '—'}</Fact>}
        <Fact label={t.status}>{p.disabled ? t.disabled : t.active}</Fact>
        <Fact label={t.lastSeen}>{p.last_seen ? formatTime(p.last_seen) : t.never}</Fact>
      </dl>
      <LegacyCards p={p} />
      <EditOverview p={p} all={all} />
    </div>
  );
}

/** Fields found in its old `_agents/<name>.md` cards: shown only here, used only when a human says so. */
function LegacyCards({ p }: { p: AdminPrincipal }) {
  const t = tx.principalPage;
  const q = useQuery({ queryKey: ['admin', 'profile', p.name], queryFn: () => admin.profileGet(p.name), enabled: p.kind !== 'system' });
  const use = useAdminMutation((i: Parameters<typeof admin.principalUpdate>[0] & { request_id: string }) => admin.principalUpdate(i));
  if (!q.data || q.data.cards.length === 0) return null;
  const cards = q.data.cards.filter((c) => c.what_i_do || c.contact || c.response_times);
  if (cards.length === 0) return null;
  return (
    <section aria-labelledby="pr-card" className={`${CARD} space-y-2`}>
      <h2 id="pr-card" className="font-semibold">
        {t.cardTitle}
      </h2>
      {q.data.conflict && <p className="text-sm text-amber-800 dark:text-amber-300">{t.cardConflict}</p>}
      {cards.map((c) => {
        const contact = [c.contact, c.response_times].filter(Boolean).join(' ');
        return (
          <div key={c.doc_id} className="space-y-1 text-sm">
            <p className="text-xs text-zinc-500">
              {t.cardHint(`${c.space}/${c.path}`)}{' '}
              <Link className="text-sky-700 hover:underline dark:text-sky-400" to={routes.doc(c.space, c.path)}>
                {tx.common.open}
              </Link>
            </p>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
              {c.what_i_do && <Fact label={t.whatItDoes}>{c.what_i_do}</Fact>}
              {c.contact && <Fact label={t.contact}>{c.contact}</Fact>}
              {c.response_times && <Fact label={t.responseTimes}>{c.response_times}</Fact>}
            </dl>
            <button
              type="button"
              className={BTN}
              disabled={use.isPending}
              onClick={() => use.mutate({ name: p.name, ...(c.what_i_do ? { what_i_do: c.what_i_do } : {}), ...(contact ? { contact } : {}) })}
            >
              {t.useCard}
            </button>
          </div>
        );
      })}
      {use.isSuccess && <Done>{t.cardUsed}</Done>}
      {use.error && <WriteError error={use.error} />}
    </section>
  );
}

/**
 * Edit the profile and Manager. The Manager decides External: a person in Brain, or
 * "Someone outside Brain…" — a human changes it here (the server refuses agents).
 */
function EditOverview({ p, all }: { p: AdminPrincipal; all: AdminPrincipal[] }) {
  const t = tx.principalPage;
  const [f, setF] = useState({
    display_name: p.display_name,
    what_i_do: p.what_i_do ?? '',
    contact: p.contact ?? '',
    harness: p.harness ?? '',
    manager: p.external ? OUTSIDE : (p.owner ?? ''),
    outside: p.external?.owner_label ?? '',
  });
  const [problem, setProblem] = useState<string | null>(null);
  const update = useAdminMutation((i: Parameters<typeof admin.principalUpdate>[0] & { request_id: string }) => admin.principalUpdate(i));
  const set = (x: Partial<typeof f>) => setF((v) => ({ ...v, ...x }));
  const external = f.manager === OUTSIDE;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    const patch: Parameters<typeof admin.principalUpdate>[0] = { name: p.name };
    if (f.display_name.trim() && f.display_name.trim() !== p.display_name) patch.display_name = f.display_name.trim();
    if (f.what_i_do.trim() !== (p.what_i_do ?? '')) patch.what_i_do = f.what_i_do.trim() || null;
    if (f.contact.trim() !== (p.contact ?? '')) patch.contact = f.contact.trim() || null;
    if (p.kind === 'agent' && f.harness.trim() !== (p.harness ?? '')) patch.harness = f.harness.trim() || null;
    if (external) {
      if (!f.outside.trim()) return setProblem(tx.principals.outsideRequired);
      if (!p.external) patch.external = true;
      if (f.outside.trim() !== (p.external?.owner_label ?? '')) patch.owner_label = f.outside.trim();
    } else {
      if (p.external) patch.external = false;
      if (f.manager !== (p.owner ?? '')) patch.owner = f.manager || null;
    }
    if (Object.keys(patch).length === 1) return setProblem(tx.common.nothingChanged);
    update.mutate(patch);
  };
  const people = all.filter((x) => x.kind === 'human' && x.id !== p.id && (!x.disabled || x.name === p.owner));
  return (
    <form onSubmit={submit} className={`${CARD} space-y-3`} aria-labelledby="pr-edit">
      <h2 id="pr-edit" className="font-semibold">
        {t.edit}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`pe-display-${p.id}`} label={tx.principals.displayName}>
          <input id={`pe-display-${p.id}`} className={INPUT} maxLength={200} value={f.display_name} onChange={(e) => set({ display_name: e.target.value })} />
        </Field>
        {p.kind === 'agent' && <HarnessField id={`pe-harness-${p.id}`} value={f.harness} onChange={(harness) => set({ harness })} />}
        <div className="sm:col-span-2">
          <Field id={`pe-what-${p.id}`} label={t.whatItDoes} hint={t.whatItDoesHint}>
            <input id={`pe-what-${p.id}`} className={INPUT} maxLength={200} value={f.what_i_do} onChange={(e) => set({ what_i_do: e.target.value })} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field id={`pe-contact-${p.id}`} label={t.contact} hint={t.contactHint}>
            <textarea id={`pe-contact-${p.id}`} className={INPUT} rows={2} maxLength={1000} value={f.contact} onChange={(e) => set({ contact: e.target.value })} />
          </Field>
        </div>
        <div className="space-y-2">
          <Field id={`pe-owner-${p.id}`} label={tx.principals.managerLabel} hint={p.kind === 'agent' ? tx.principals.managerHint : tx.principals.managerHintPerson}>
            <div>
              <Select id={`pe-owner-${p.id}`} value={f.manager} onChange={(e) => set({ manager: e.target.value })}>
                <option value="">—</option>
                {people.map((x) => (
                  <option key={x.id} value={x.name}>
                    {x.display_name || x.name}
                  </option>
                ))}
                {p.kind === 'agent' && <option value={OUTSIDE}>{tx.principals.outsideOption}</option>}
              </Select>
            </div>
          </Field>
          {external && (
            <Field id={`pe-outside-${p.id}`} label={tx.principals.outsideName} hint={tx.principals.externalOwnerHint}>
              <input id={`pe-outside-${p.id}`} className={INPUT} maxLength={100} value={f.outside} onChange={(e) => set({ outside: e.target.value })} />
            </Field>
          )}
        </div>
      </div>
      {external && !p.external && <p className="text-xs text-zinc-500">{tx.principals.externalHint}</p>}
      {problem && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {problem}
        </p>
      )}
      {update.error && <WriteError error={update.error} />}
      {update.isSuccess && <Done>{tx.common.saved}</Done>}
      <button type="submit" className={BTN_PRIMARY} disabled={update.isPending}>
        {tx.common.save}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------- Access ("View as")

type ExplainSpaceOut = Awaited<ReturnType<typeof admin.accessExplain>>['spaces'][number];

/**
 * Access: one row per space in plain words — "Alpha project — Editor", "General —
 * Guest: its own messages only" — with "Why?" for the rules behind it. This tab is "View as": it is what
 * the engine resolves for this principal (admin_access_explain), nothing is impersonated.
 */
function AccessTab({ p }: { p: AdminPrincipal }) {
  const t = tx.principalPage;
  const q = useQuery({ queryKey: ['admin', 'explain', p.name, '', ''], queryFn: () => admin.accessExplain({ principal: p.name }) });
  const spaces = useQuery({ queryKey: ['admin', 'spaces'], queryFn: () => admin.spaceList(true) });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorView error={q.error} />;
  const names = new Map((spaces.data?.spaces ?? []).map((s) => [s.slug, s.name]));
  const isMember = (s: ExplainSpaceOut) => (s.member ? s.member.member : s.visible);
  const member = q.data.spaces.filter((s) => isMember(s) && !s.archived);
  const other = q.data.spaces.filter((s) => !isMember(s) && !s.archived);
  return (
    <div className="space-y-5">
      <section aria-labelledby="ac-spaces" className="space-y-2">
        <h2 id="ac-spaces" className="font-semibold">
          {t.spaces(member.length)}
        </h2>
        {member.length === 0 && <p className="text-sm text-zinc-500">{t.noSpaces}</p>}
        <ul className="divide-y divide-zinc-200 border-y border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800" aria-label={t.spaces(member.length)}>
          {member.map((s) => (
            <AccessRow key={s.space} s={s} name={names.get(s.space) ?? s.space} />
          ))}
        </ul>
      </section>
      {p.role !== 'superadmin' && <AddToSpace p={p} spaces={other.map((s) => ({ slug: s.space, name: names.get(s.space) ?? s.space }))} />}
      {other.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-semibold">{t.notSees(other.length)}</summary>
          <ul className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
            {other.map((s) => (
              <li key={s.space}>{names.get(s.space) ?? s.space}</li>
            ))}
          </ul>
        </details>
      )}
      <PathCheck p={p} spaces={member.map((s) => ({ slug: s.space, name: names.get(s.space) ?? s.space }))} />
    </div>
  );
}

function AccessRow({ s, name }: { s: ExplainSpaceOut; name: string }) {
  const t = tx.principalPage;
  const line = s.member ? accessLine(name, s.member) : `${name} — ${ROLE_LABEL[s.role]}`;
  const rules = [...s.grants];
  return (
    <li className="space-y-1 px-1 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={routes.spaceMembers(s.space)} className="font-medium hover:underline">
          {line}
        </Link>
      </div>
      <details>
        <summary className="cursor-pointer text-xs text-zinc-500">{t.why}</summary>
        {s.member?.superadmin ? (
          <p className="mt-1 text-xs text-zinc-500">{GRANT_LEVEL.superadmin}</p>
        ) : rules.length === 0 ? (
          <p className="mt-1 text-xs text-zinc-500">{t.whyNone}</p>
        ) : (
          <ul className="mt-1 list-disc pl-5 text-xs text-zinc-600 dark:text-zinc-400">
            {rules.map((g) => (
              <li key={g.id}>{t.whyLine(targetText(g), g.subject.type === 'group' ? tx.grants.group(g.subject.name) : g.subject.name, GRANT_ROLE_LABEL[g.role])}</li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-xs text-zinc-500">{t.changeIn(name)}</p>
      </details>
    </li>
  );
}

/** Add it to a space it is not a member of, with a role on the ladder. */
function AddToSpace({ p, spaces }: { p: AdminPrincipal; spaces: { slug: string; name: string }[] }) {
  const t = tx.principalPage;
  const [space, setSpace] = useState('');
  const [role, setRole] = useState<Exclude<Ladder, 'none'>>('viewer');
  const all = useQuery({ queryKey: ['admin', 'spaces'], queryFn: () => admin.spaceList(true) });
  const info = all.data?.spaces.find((s) => s.slug === space);
  const options = ladderOptions({ messages: info?.inbox ?? false, approval: info ? requiresApproval(info) : false });
  const add = useAdminMutation(
    (i: GrantKey & { role: Role; request_id: string }) => admin.grantSet(i),
    () => setSpace(''),
  );
  if (spaces.length === 0) return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!space) return;
    const r = options.includes(role) ? role : 'viewer';
    add.mutate({ space, scope: 'space', subject: { type: 'principal', name: p.name }, role: ENGINE_ROLE[r] });
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2" aria-label={t.addToSpace}>
      <Field id={`ats-space-${p.id}`} label={t.addSpace}>
        <Select id={`ats-space-${p.id}`} value={space} onChange={(e) => setSpace(e.target.value)}>
          <option value="">{tx.common.choose}</option>
          {spaces.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field id={`ats-role-${p.id}`} label={t.addRole}>
        <Select id={`ats-role-${p.id}`} value={role} onChange={(e) => setRole(e.target.value as Exclude<Ladder, 'none'>)}>
          {options.map((o) => (
            <option key={o} value={o}>
              {LADDER_LABEL[o]}
            </option>
          ))}
        </Select>
      </Field>
      <button type="submit" className={BTN} disabled={!space || add.isPending}>
        {t.addToSpace}
      </button>
      {add.isSuccess && (
        <p role="status" className="w-full text-sm text-emerald-700 dark:text-emerald-400">
          {t.added(add.variables?.space ?? '')}
        </p>
      )}
      {add.error && (
        <div className="w-full">
          <WriteError error={add.error} />
        </div>
      )}
    </form>
  );
}

/** Advanced: what it can do with one document or folder, and which rule decides (the old path check). */
function PathCheck({ p, spaces }: { p: AdminPrincipal; spaces: { slug: string; name: string }[] }) {
  const t = tx.principalPage;
  const [form, setForm] = useState({ space: spaces[0]?.slug ?? '', path: '' });
  const [asked, setAsked] = useState<{ space: string; path: string } | null>(null);
  const q = useQuery({
    queryKey: ['admin', 'explain', p.name, asked?.space ?? '', asked?.path ?? ''],
    queryFn: () => admin.accessExplain({ principal: p.name, space: asked!.space, path: asked!.path }),
    enabled: asked !== null,
  });
  const target = q.data?.spaces[0]?.target;
  return (
    <details className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <summary className="cursor-pointer font-medium">{t.pathCheck}</summary>
      <p className="mt-1 text-xs text-zinc-500">{t.pathCheckHint}</p>
      <form
        className="mt-2 flex flex-wrap items-end gap-2"
        aria-label={t.pathCheck}
        onSubmit={(e) => {
          e.preventDefault();
          if (form.space && form.path.trim()) setAsked({ space: form.space, path: form.path.trim() });
        }}
      >
        <Field id={`pc-space-${p.id}`} label={t.addSpace}>
          <Select id={`pc-space-${p.id}`} value={form.space} onChange={(e) => setForm((f) => ({ ...f, space: e.target.value }))}>
            {spaces.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={`pc-path-${p.id}`} label={tx.grants.folderLabel}>
          <input id={`pc-path-${p.id}`} className={`${INPUT} w-56 font-mono`} placeholder="drafts/plan.md" value={form.path} onChange={(e) => setForm((f) => ({ ...f, path: e.target.value }))} />
        </Field>
        <button type="submit" className={BTN} disabled={!form.space || !form.path.trim()}>
          {tx.common.show}
        </button>
      </form>
      {q.isError && <ErrorView error={q.error} />}
      {target && (
        <p role="status" className="mt-2 text-sm">
          {t.pathRole(target.path ?? target.doc_id ?? '', GRANT_ROLE_LABEL[target.role], GRANT_LEVEL[target.level])}
        </p>
      )}
    </details>
  );
}

// ---------------------------------------------------------------- Advanced

/** Advanced: trust, external limits, the one "Brain administrator" checkbox, a person's password. */
function AdvancedTab({ p }: { p: AdminPrincipal }) {
  const t = tx.principalPage;
  const me = useSession().data;
  const superadmin = me?.role === 'superadmin';
  const [f, setF] = useState({ trust: p.trust, admin: p.admin, password: '' });
  const [problem, setProblem] = useState<string | null>(null);
  const update = useAdminMutation((i: Parameters<typeof admin.principalUpdate>[0] & { request_id: string }) => admin.principalUpdate(i));
  const set = (x: Partial<typeof f>) => setF((v) => ({ ...v, ...x }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    const patch: Parameters<typeof admin.principalUpdate>[0] = { name: p.name };
    if (f.trust !== p.trust) patch.trust = f.trust;
    if (superadmin && p.role !== 'superadmin' && f.admin !== p.admin) patch.admin = f.admin;
    if (p.kind === 'human' && f.password) patch.password = f.password;
    if (Object.keys(patch).length === 1) return setProblem(tx.common.nothingChanged);
    update.mutate(patch, { onSuccess: () => set({ password: '' }) });
  };
  return (
    <div className="space-y-5">
      <form onSubmit={submit} className={`${CARD} space-y-3`} aria-label={tx.principalPage.tabs.advanced}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`pa-trust-${p.id}`} label={t.trust} hint={TRUST_HINT}>
            <div>
              <Select id={`pa-trust-${p.id}`} value={f.trust} onChange={(e) => set({ trust: e.target.value as Trust })}>
                {TRUSTS.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </Select>
            </div>
          </Field>
          {p.kind === 'human' && superadmin && (
            <Field id={`pa-password-${p.id}`} label={tx.principals.newPassword} hint={tx.principals.newPasswordHint}>
              <input id={`pa-password-${p.id}`} type="password" autoComplete="new-password" className={INPUT} value={f.password} onChange={(e) => set({ password: e.target.value })} />
            </Field>
          )}
        </div>
        {/* One administrator concept: this checkbox; the superadmin is shown on its own account only. */}
        {p.role === 'superadmin' ? (
          <p className="text-sm text-zinc-500">{tx.account.superadmin}</p>
        ) : superadmin ? (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={f.admin} onChange={(e) => set({ admin: e.target.checked })} />
            <span>
              <span className="font-medium">{t.administrator}</span>
              <span className="block text-xs text-zinc-500">{tx.principals.adminHint}</span>
            </span>
          </label>
        ) : (
          <p className="text-sm text-zinc-500">{t.administratorReadonly(p.admin)}</p>
        )}
        {problem && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {problem}
          </p>
        )}
        {update.error && <WriteError error={update.error} />}
        {update.isSuccess && <Done>{tx.common.saved}</Done>}
        <button type="submit" className={BTN_PRIMARY} disabled={update.isPending}>
          {tx.common.save}
        </button>
      </form>
      {p.external && <ExternalBox p={p} external={p.external} />}
    </div>
  );
}

/** Disable / Enable, always in the page header (an emergency action, confirm once). */
function DisableButton({ p }: { p: AdminPrincipal }) {
  const [confirm, setConfirm] = useState(false);
  const disable = useAdminMutation((i: { name: string; request_id: string }) => admin.principalDisable(i), () => setConfirm(false));
  const enable = useAdminMutation((i: { name: string; request_id: string }) => admin.principalEnable(i));
  const me = useSession().data;
  if (me?.name === p.name || p.kind === 'system') return null;
  const error = disable.error ?? enable.error;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {p.disabled ? (
        <button type="button" className={BTN} onClick={() => enable.mutate({ name: p.name })} disabled={enable.isPending}>
          {tx.principalPage.enable}
        </button>
      ) : confirm ? (
        <>
          <button type="button" className={BTN_DANGER} onClick={() => disable.mutate({ name: p.name })} disabled={disable.isPending}>
            {tx.principals.disableConfirm(p.name)}
          </button>
          <button type="button" className={BTN} onClick={() => setConfirm(false)}>
            {tx.common.cancel}
          </button>
        </>
      ) : (
        <button type="button" className={BTN} onClick={() => setConfirm(true)} title={tx.principals.disableHint}>
          {tx.principalPage.disableAgent(p.kind === 'agent')}
        </button>
      )}
      {error && <WriteError error={error} />}
    </div>
  );
}
