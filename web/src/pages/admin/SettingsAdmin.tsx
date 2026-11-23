// Settings: the "What this is" text that start_here shows to every agent, and
// Archived spaces (they left the sidebar and the old /admin/spaces list). Brain
// administrators only (the route checks it in App).
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { admin } from '../../api/client';
import { routes } from '../../lib/routes';
import type { AdminSettings } from '../../api/types';
import { AdminFrame, Field, INPUT, useAdminMutation } from '../../components/admin';
import { BTN, BTN_PRIMARY } from '../../components/edit';
import { ErrorView, Spinner } from '../../components/ui';
import { tx } from '../../i18n';

export function SettingsAdminPage() {
  const q = useQuery({ queryKey: ['admin', 'settings'], queryFn: admin.settingsGet });
  // Lives here: the form remounts with the saved text, the "Saved." line stays.
  const [saved, setSaved] = useState(false);
  return (
    <AdminFrame title={tx.guideSettings.title}>
      {q.isPending && <Spinner />}
      {q.isError && <ErrorView error={q.error} />}
      {q.data && <GuideForm key={q.data.settings.guide_text} settings={q.data.settings} saved={saved} setSaved={setSaved} />}
      <ArchivedSpaces />
    </AdminFrame>
  );
}

/** Archived spaces: hidden everywhere else; each opens its Settings (restore from the archive there). */
function ArchivedSpaces() {
  const q = useQuery({ queryKey: ['admin', 'spaces'], queryFn: () => admin.spaceList(true) });
  const archived = (q.data?.spaces ?? []).filter((s) => s.archived);
  return (
    <section aria-labelledby="settings-archived" className="space-y-2">
      <h2 id="settings-archived" className="font-semibold">
        {tx.guideSettings.archived}
      </h2>
      {q.isError && <ErrorView error={q.error} />}
      {q.data && archived.length === 0 && <p className="text-sm text-zinc-500">{tx.guideSettings.noArchived}</p>}
      {archived.length > 0 && (
        <ul className="divide-y divide-zinc-200 border-y border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {archived.map((s) => (
            <li key={s.id} className="px-1 py-2 text-sm">
              <Link to={routes.spaceSettings(s.slug)} className="font-medium text-sky-700 hover:underline dark:text-sky-400">
                {s.name}
              </Link>
              {s.description && <span className="ml-2 text-zinc-500">{s.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GuideForm({ settings, saved, setSaved }: { settings: AdminSettings; saved: boolean; setSaved: (v: boolean) => void }) {
  const [text, setText] = useState(settings.guide_text);
  const save = useAdminMutation(admin.settingsUpdate, () => setSaved(true));
  const max = settings.guide_text_max;
  const tooLong = text.length > max;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (tooLong) return;
    setSaved(false);
    save.mutate({ guide_text: text });
  };
  return (
    <form onSubmit={submit} className="space-y-3" aria-label={tx.guideSettings.title}>
      <Field id="guide-text" label={tx.guideSettings.guideLabel} hint={tx.guideSettings.guideHint(text.length, max)}>
        <textarea
          id="guide-text"
          className={`${INPUT} min-h-40 font-mono`}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSaved(false);
          }}
        />
      </Field>
      {settings.guide_text_is_default && <p className="text-xs text-zinc-500">{tx.guideSettings.isDefault}</p>}
      {tooLong && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{tx.guideSettings.tooLong(max)}</p>}
      {save.isError && <ErrorView error={save.error} />}
      {saved && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{tx.guideSettings.saved}</p>}
      <div className="flex gap-2">
        <button type="submit" className={BTN_PRIMARY} disabled={save.isPending || tooLong}>
          {tx.guideSettings.save}
        </button>
        {!settings.guide_text_is_default && (
          <button
            type="button"
            className={BTN}
            disabled={save.isPending}
            onClick={() => {
              setSaved(false);
              save.mutate({ guide_text: null });
            }}
          >
            {tx.guideSettings.reset}
          </button>
        )}
      </div>
    </form>
  );
}
