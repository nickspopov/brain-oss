// New space: Name and Description; the
// address (slug) is derived from the name and editable under Advanced. Then the Members tab.
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { admin } from '../api/client';
import type { SpaceSettingsInput } from '../api/types';
import { Field, INPUT, useAdminMutation } from '../components/admin';
import { Page } from '../components/controls';
import { BTN_PRIMARY, WriteError } from '../components/edit';
import { routes } from '../lib/routes';
import { tx } from '../i18n';

const t = tx.newSpace;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** "Project Alpha" → "project-alpha": lowercase Latin letters, digits and hyphens. */
export function slugOf(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

export function NewSpacePage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const effective = slug ?? slugOf(name);
  const create = useAdminMutation(
    (i: { slug: string } & SpaceSettingsInput & { request_id: string }) => admin.spaceCreate(i),
    (out) => navigate(routes.spaceMembers(out.space.slug), { state: { notice: tx.spacesAdmin.created(out.space.slug) } }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    if (!name.trim()) return setProblem(t.nameRequired);
    if (!SLUG_RE.test(effective)) return setProblem(tx.spacesAdmin.slugHint);
    create.mutate({ slug: effective, name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) });
  };
  return (
    <Page width="doc">
      <h1 className="text-xl font-semibold">{t.title}</h1>
      <form onSubmit={submit} className="space-y-3" aria-label={t.title}>
        <Field id="ns-name" label={t.name}>
          <input id="ns-name" className={INPUT} maxLength={200} placeholder={t.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field id="ns-description" label={t.description}>
          <textarea id="ns-description" className={INPUT} rows={2} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <details className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <summary className="cursor-pointer text-sm font-medium">{tx.spaceSettings.advanced}</summary>
          <div className="mt-2">
            <Field id="ns-slug" label={t.slug} hint={t.slugHint}>
              <input id="ns-slug" className={`${INPUT} font-mono`} value={effective} onChange={(e) => setSlug(e.target.value)} />
            </Field>
          </div>
        </details>
        {problem && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {problem}
          </p>
        )}
        {create.error && <WriteError error={create.error} />}
        <button type="submit" className={BTN_PRIMARY} disabled={create.isPending}>
          {t.create}
        </button>
      </form>
    </Page>
  );
}
