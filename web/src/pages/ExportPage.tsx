// Space export: a tar.gz archive with a plain markdown tree and a
// manifest. The link is valid for an hour and only for whoever built the archive; if access to something inside
// has changed, the server answers "not found" and the archive has to be built again.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api/client';
import type { ExportOut } from '../api/types';
import { BTN_PRIMARY, WriteError } from '../components/edit';
import { ErrorView, Spinner } from '../components/ui';
import { formatSize, formatTime } from '../lib/format';
import { routes } from '../lib/routes';
import { Select } from '../components/controls';
import { tx } from '../i18n';

export function ExportPage() {
  const [params, setParams] = useSearchParams();
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: api.spaces });
  // The selection is also kept locally: address changes go through React Router navigation (see FeedPage).
  const [space, setSpace] = useState(params.get('space') ?? '');
  const [mode, setMode] = useState<'head' | 'full'>('head');
  const [result, setResult] = useState<(ExportOut & { space: string; mode: 'head' | 'full' }) | null>(null);
  const run = useMutation({
    mutationFn: (input: { space: string; mode: 'head' | 'full' }) => api.export(input).then((r) => ({ ...r, ...input })),
    onSuccess: setResult,
  });

  if (spaces.isPending) return <Spinner />;
  if (spaces.isError) return <ErrorView error={spaces.error} />;
  const info = spaces.data.spaces.find((s) => s.slug === space);
  const canFull = info?.role === 'admin';
  const choose = (slug: string) => {
    setResult(null);
    run.reset();
    setMode('head');
    setSpace(slug);
    setParams(slug ? { space: slug } : {}, { replace: true });
  };

  return (
    <div className="max-w-[720px] px-6 py-6 space-y-4">
      <h1 className="text-xl font-semibold">{tx.exportPage.title}</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {tx.exportPage.introTree}
        <span className="font-mono">tree/</span>
        {tx.exportPage.introTreeRest}
        <span className="font-mono">manifest.json</span>
        {tx.exportPage.introManifest}
      </p>
      <form
        className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
        onSubmit={(e) => {
          e.preventDefault();
          if (space) run.mutate({ space, mode: canFull ? mode : 'head' });
        }}
      >
        <div className="space-y-1">
          <label htmlFor="export-space" className="block text-sm font-medium">
            {tx.common.space}
          </label>
          <Select
            id="export-space"
            value={space}
            onChange={(e) => choose(e.target.value)}
        >
            <option value="">{tx.common.choose}</option>
            {spaces.data.spaces.filter((s) => !s.archived || s.slug === space).map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.name} ({s.slug})
              </option>
            ))}
          </Select>
        </div>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">{tx.exportPage.what}</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="export-mode" className="mt-1" checked={mode === 'head' || !canFull} onChange={() => setMode('head')} />
            <span>
              {tx.exportPage.head}
              <span className="block text-xs text-zinc-500">{tx.exportPage.headHint}</span>
            </span>
          </label>
          <label className={`flex items-start gap-2 text-sm ${canFull ? '' : 'opacity-60'}`}>
            <input type="radio" name="export-mode" className="mt-1" disabled={!canFull} checked={mode === 'full' && canFull} onChange={() => setMode('full')} />
            <span>
              {tx.exportPage.full}
              <span className="block text-xs text-zinc-500">
                {tx.exportPage.fullHint} {canFull ? '' : tx.exportPage.needsAdmin}
              </span>
            </span>
          </label>
        </fieldset>
        <button type="submit" className={BTN_PRIMARY} disabled={!space || run.isPending}>
          {run.isPending ? tx.exportPage.building : tx.exportPage.build}
        </button>
      </form>
      {run.isError && <WriteError error={run.error} />}
      {result && result.space === space && (
        <section aria-label={tx.exportPage.ready} className="space-y-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-800 dark:bg-emerald-950">
          <p className="font-medium">{tx.exportPage.readySize(formatSize(result.size))}</p>
          <a href={result.download_path} download className={`${BTN_PRIMARY} inline-block`}>
            {tx.exportPage.downloadArchive}
          </a>
          <p>{tx.exportPage.validUntil(formatTime(result.expires_at))}</p>
          <p className="break-all">
            SHA-256: <span className="font-mono text-xs">{result.sha256}</span>
          </p>
        </section>
      )}
      {info && (
        <p className="text-sm">
          <Link to={routes.space(info.slug)} className="text-sky-700 hover:underline dark:text-sky-400">
            ← {info.name}
          </Link>
        </p>
      )}
    </div>
  );
}
