// The space's Settings tab: name and description, Messages on/off,
// Review (Off · Notify me · Require approval), notes for agents, everything else under Advanced, and a
// Danger zone (rename, archive). A Review preset only sets the existing fields (review_mode, executable);
// a combination that is not a preset shows "Custom" with Advanced open and is saved back unchanged.
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { admin, ApiError, api } from '../../api/client';
import type { AdminSpace, SpaceMembersOut, SpaceSettingsInput } from '../../api/types';
import { CARD, Done, Field, INPUT, useAdminMutation } from '../../components/admin';
import { Select } from '../../components/controls';
import { BTN, BTN_DANGER, BTN_PRIMARY, WriteError } from '../../components/edit';
import { ErrorView, Spinner } from '../../components/ui';
import { settingsFromForm, spaceForm, type SpaceForm } from '../../lib/admin';
import { REVIEW_LABEL } from '../../lib/format';
import { approvalScopeOf, presetFields, presetOf, type ApprovalScope, type Preset } from '../../lib/roles';
import { routes } from '../../lib/routes';
import { tx } from '../../i18n';

const t = tx.spaceSettings;
const f = tx.adminUi.spaceForm;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function SpaceSettings({ space }: { space: string }) {
  const q = useQuery({ queryKey: ['admin', 'members', space], queryFn: () => admin.spaceMembers(space) });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorView error={q.error} />;
  const s = q.data.space;
  return (
    <div className="space-y-5">
      <SettingsForm key={s.id} s={s} notify={q.data.notify} />
      <AgentsMd s={s} />
      <section aria-labelledby="sp-danger" className="space-y-3 rounded-lg border border-red-200 p-3 dark:border-red-900">
        <h2 id="sp-danger" className="font-semibold text-red-800 dark:text-red-300">
          {t.danger}
        </h2>
        <RenameForm s={s} />
        <ArchiveBox s={s} />
      </section>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function SettingsForm({ s, notify }: { s: AdminSpace; notify: SpaceMembersOut['notify'] }) {
  const [form, setForm] = useState<SpaceForm>(() => spaceForm(s));
  const initial = presetOf(s);
  const [advanced, setAdvanced] = useState(initial === 'custom');
  const [scope, setScope] = useState<ApprovalScope>(approvalScopeOf(s));
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const update = useAdminMutation(
    (i: { slug: string } & SpaceSettingsInput & { request_id: string }) => admin.spaceUpdate(i),
    () => setSaved(true),
  );
  const set = (p: Partial<SpaceForm>) => {
    setSaved(false);
    setForm((x) => ({ ...x, ...p }));
  };
  const preset = presetOf(form);
  const choose = (p: Exclude<Preset, 'custom'>, sc: ApprovalScope = scope) => set(presetFields(p, sc));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    const r = settingsFromForm(form, s);
    if (!r.ok) return setProblem(r.message);
    if (Object.keys(r.settings).length === 0) return setProblem(tx.common.nothingChanged);
    update.mutate({ slug: s.slug, ...r.settings });
  };
  const protectedPaths = form.protected_paths
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
  const id = (k: string) => `sp-${s.slug}-${k}`;
  return (
    <form onSubmit={submit} className="space-y-5" aria-label={t.title}>
      <Section id={id('general')} title={t.general}>
        <Field id={id('name')} label={f.name}>
          <input id={id('name')} className={`${INPUT} max-w-md`} value={form.name} maxLength={200} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field id={id('description')} label={f.description}>
          <textarea id={id('description')} className={`${INPUT} max-w-xl`} rows={2} maxLength={4000} value={form.description} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={form.inbox} onChange={(e) => set({ inbox: e.target.checked })} />
          <span>
            <span className="font-medium">{f.messagesState(form.inbox)}</span>
            <span className="block text-xs text-zinc-500">{f.inboxHint}</span>
          </span>
        </label>
      </Section>

      <Section id={id('review')} title={t.review}>
        <fieldset className="space-y-2">
          <legend className="sr-only">{t.review}</legend>
          {(['off', 'notify', 'approval'] as const).map((p) => (
            <label key={p} className="flex items-start gap-2 text-sm">
              <input type="radio" name={id('preset')} className="mt-1" checked={preset === p} onChange={() => choose(p)} />
              <span>
                <span className="font-medium">{t.presets[p]}</span>
                <span className="block text-xs text-zinc-500">{t.presetHint[p]}</span>
              </span>
            </label>
          ))}
          {preset === 'custom' && (
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name={id('preset')} className="mt-1" checked readOnly />
              <span>
                <span className="font-medium">{t.presets.custom}</span>
                <span className="block text-xs text-zinc-500">{t.presetHint.custom}</span>
              </span>
            </label>
          )}
        </fieldset>
        {preset === 'approval' && (
          <Field id={id('scope')} label={t.approvalFor}>
            <div>
              <Select
                id={id('scope')}
                value={scope}
                onChange={(e) => {
                  const sc = e.target.value as ApprovalScope;
                  setScope(sc);
                  choose('approval', sc);
                }}
              >
                <option value="limited">{t.approvalLimited}</option>
                <option value="all">{t.approvalAll}</option>
              </Select>
            </div>
          </Field>
        )}
        {(preset === 'notify' || preset === 'custom') && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400" role="note">
            {notify.people.length > 0 ? t.notifyWho(notify.people.join(', ')) : t.notifyNobody}
            {notify.webhooks > 0 && ` ${t.notifyWebhooks(notify.webhooks)}`}
          </p>
        )}
        {preset !== 'approval' && protectedPaths.length > 0 && <p className="text-sm text-zinc-600 dark:text-zinc-400">{t.protectedOff(protectedPaths.join(', '))}</p>}
      </Section>

      <details open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <summary className="cursor-pointer font-medium">{t.advanced}</summary>
        <p className="mt-1 text-xs text-zinc-500">{t.advancedHint}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field id={id('review-mode')} label={f.review} hint={f.reviewHint}>
            <div>
              <Select id={id('review-mode')} value={form.review_mode} onChange={(e) => set({ review_mode: e.target.value as SpaceForm['review_mode'] })}>
                {(['off', 'limited', 'all'] as const).map((m) => (
                  <option key={m} value={m}>
                    {REVIEW_LABEL[m]}
                  </option>
                ))}
              </Select>
            </div>
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={form.executable} onChange={(e) => set({ executable: e.target.checked })} />
            <span>
              <span className="font-medium">{f.flagged}</span>
              <span className="block text-xs text-zinc-500">{f.executableHint}</span>
            </span>
          </label>
          <Field id={id('ttl')} label={f.ttl} hint={f.ttlHint}>
            <input id={id('ttl')} className={INPUT} inputMode="numeric" value={form.ttl_days} onChange={(e) => set({ ttl_days: e.target.value })} />
          </Field>
          <Field id={id('trash')} label={f.trash} hint={f.trashHint}>
            <input id={id('trash')} className={INPUT} inputMode="numeric" value={form.trash_retention_days} onChange={(e) => set({ trash_retention_days: e.target.value })} />
          </Field>
          <Field id={id('quota')} label={f.quota} hint={f.quotaHint}>
            <input id={id('quota')} className={INPUT} inputMode="decimal" value={form.quota_mb} onChange={(e) => set({ quota_mb: e.target.value })} />
          </Field>
          <Field id={id('maxdoc')} label={f.maxDoc} hint={f.maxDocHint}>
            <input id={id('maxdoc')} className={INPUT} inputMode="decimal" value={form.max_doc_mb} onChange={(e) => set({ max_doc_mb: e.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <Field id={id('protected')} label={f.protected} hint={f.protectedHint}>
              <textarea id={id('protected')} className={`${INPUT} font-mono`} rows={2} value={form.protected_paths} onChange={(e) => set({ protected_paths: e.target.value })} placeholder="AGENTS.md" />
            </Field>
          </div>
        </div>
      </details>

      {problem && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {problem}
        </p>
      )}
      {update.error && <WriteError error={update.error} />}
      {saved && <Done>{t.saved}</Done>}
      <button type="submit" className={BTN_PRIMARY} disabled={update.isPending}>
        {t.save}
      </button>
    </form>
  );
}

/** Notes for agents: `AGENTS.md`, a regular document in the root (history and revert for free). */
function AgentsMd({ s }: { s: AdminSpace }) {
  const q = useQuery({
    queryKey: ['read', s.slug, 'AGENTS.md', 'meta'],
    queryFn: async () => {
      try {
        return await api.read({ space: s.slug, path: 'AGENTS.md', format: 'meta' });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'not_found') return null;
        throw err;
      }
    },
    enabled: !s.archived,
  });
  return (
    <section aria-labelledby="sp-agents" className={`${CARD} space-y-2`}>
      <h2 id="sp-agents" className="font-semibold">
        {t.notes}
      </h2>
      <p className="text-xs text-zinc-500">{tx.spacesAdmin.agentsMdHint}</p>
      {s.archived && <p className="text-sm text-zinc-500">{tx.spacesAdmin.archived}</p>}
      {q.isPending && !s.archived && <Spinner />}
      {q.isError && <ErrorView error={q.error} />}
      {q.data === null && (
        <Link className={BTN} to={routes.newAt(s.slug, 'AGENTS.md')}>
          {tx.spacesAdmin.createAgentsMd}
        </Link>
      )}
      {q.data && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{tx.spacesAdmin.revision(q.data.doc.rev)}</span>
          <Link className={BTN} to={routes.edit(s.slug, 'AGENTS.md')}>
            {tx.spacesAdmin.editAgentsMd}
          </Link>
          <Link className={BTN} to={routes.history(s.slug, 'AGENTS.md')}>
            {tx.common.history}
          </Link>
        </div>
      )}
    </section>
  );
}

function RenameForm({ s }: { s: AdminSpace }) {
  const navigate = useNavigate();
  const [slug, setSlug] = useState(s.slug);
  const [problem, setProblem] = useState<string | null>(null);
  const rename = useAdminMutation(
    (i: { slug: string; new_slug: string; request_id: string }) => admin.spaceUpdate(i),
    (out) => navigate(routes.spaceSettings(out.space.slug), { replace: true, state: { notice: tx.spacesAdmin.renamed(out.space.slug) } }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    const next = slug.trim();
    if (!SLUG_RE.test(next)) return setProblem(tx.spacesAdmin.slugHint);
    if (next === s.slug) return setProblem(tx.spacesAdmin.sameSlug);
    rename.mutate({ slug: s.slug, new_slug: next });
  };
  return (
    <form onSubmit={submit} className="space-y-2" aria-labelledby="sp-rename">
      <h3 id="sp-rename" className="text-sm font-semibold">
        {tx.spacesAdmin.rename}
      </h3>
      <p className="text-xs text-zinc-500">{tx.spacesAdmin.renameHint}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field id={`rename-${s.id}`} label={tx.spacesAdmin.newSlug}>
          <input id={`rename-${s.id}`} className={`${INPUT} w-64 font-mono`} value={slug} onChange={(e) => setSlug(e.target.value)} />
        </Field>
        <button type="submit" className={BTN} disabled={rename.isPending}>
          {tx.spacesAdmin.rename}
        </button>
      </div>
      {problem && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {problem}
        </p>
      )}
      {rename.error && <WriteError error={rename.error} />}
    </form>
  );
}

function ArchiveBox({ s }: { s: AdminSpace }) {
  const [confirm, setConfirm] = useState(false);
  const archive = useAdminMutation((i: { slug: string; request_id: string }) => admin.spaceArchive(i), () => setConfirm(false));
  const unarchive = useAdminMutation((i: { slug: string; request_id: string }) => admin.spaceUnarchive(i));
  return (
    <div className="space-y-2" aria-labelledby="sp-archive" role="group">
      <h3 id="sp-archive" className="text-sm font-semibold">
        {tx.spacesAdmin.archive}
      </h3>
      {s.archived ? (
        <>
          <p className="text-sm">{tx.spacesAdmin.archivedHint}</p>
          <button type="button" className={BTN} onClick={() => unarchive.mutate({ slug: s.slug })} disabled={unarchive.isPending}>
            {tx.spacesAdmin.unarchive}
          </button>
        </>
      ) : (
        <>
          <p className="text-xs text-zinc-500">{tx.spacesAdmin.archiveHint}</p>
          {confirm ? (
            <div className="flex gap-2">
              <button type="button" className={BTN_DANGER} onClick={() => archive.mutate({ slug: s.slug })} disabled={archive.isPending}>
                {tx.spacesAdmin.archiveConfirm}
              </button>
              <button type="button" className={BTN} onClick={() => setConfirm(false)}>
                {tx.common.cancel}
              </button>
            </div>
          ) : (
            <button type="button" className={BTN} onClick={() => setConfirm(true)}>
              {tx.spacesAdmin.archiveEllipsis}
            </button>
          )}
        </>
      )}
      {(archive.error || unarchive.error) && <WriteError error={archive.error ?? unarchive.error} />}
    </div>
  );
}
