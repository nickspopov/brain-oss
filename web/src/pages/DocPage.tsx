// Document view: markdown, metadata, author and trust, trust_floor, TTL deadline,
// attachment download. Metadata is read first (`format: "meta"`), the body only for text.
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router';
import { api, rawUrl } from '../api/client';
import type { DocInfo, ReadOut } from '../api/types';
import { DocActions, Notice } from '../components/DocActions';
import { Markdown } from '../components/Markdown';
import { AuthorLine, Badge, ErrorView, Spinner, TrustBadge } from '../components/ui';
import { formatSize, formatTime, formatUntil } from '../lib/format';
import { splitFrontmatter } from '../lib/frontmatter';
import { routes } from '../lib/routes';
import { tx } from '../i18n';

/** How much of the body the UI asks for at a time; beyond that, a download is offered. */
export const UI_MAX_BYTES = 1024 * 1024;

function parseRev(v: string | null): number | undefined {
  if (v === null || !/^\d{1,9}$/.test(v)) return undefined;
  const n = Number(v);
  return n >= 1 ? n : undefined;
}

export function DocPage() {
  const params = useParams();
  const space = params.space ?? '';
  const path = params['*'] ?? '';
  const [search] = useSearchParams();
  const rev = parseRev(search.get('rev'));
  const ref = { space, path, ...(rev !== undefined ? { rev } : {}) };

  const meta = useQuery({ queryKey: ['read', space, path, rev ?? 'head', 'meta'], queryFn: () => api.read({ ...ref, format: 'meta' }) });
  const isText = meta.data?.doc.kind === 'text';
  const body = useQuery({
    queryKey: ['read', space, path, rev ?? 'head', 'full'],
    queryFn: () => api.read({ ...ref, format: 'full', max_bytes: UI_MAX_BYTES }),
    enabled: isText,
  });

  if (meta.isPending) return <Spinner />;
  if (meta.isError) return <ErrorView error={meta.error} />;
  const { doc, revision } = body.data ?? meta.data;

  return (
    <article className="max-w-[720px] px-6 py-6 space-y-4">
      <Notice />
      <DocHeader space={space} doc={doc} data={body.data ?? meta.data} rev={rev} />
      <DocActions space={space} doc={doc} viewedRev={rev} />
      {doc.kind === 'file' ? (
        <FileCard doc={doc} rev={rev} />
      ) : body.isPending ? (
        <Spinner />
      ) : body.isError ? (
        <ErrorView error={body.error} />
      ) : (
        <DocBody space={space} doc={doc} data={body.data} rev={rev} />
      )}
      <footer className="border-t border-zinc-200 pt-2 text-xs text-zinc-500 dark:border-zinc-800">
        id <span className="font-mono">{doc.id}</span>
        {tx.doc.meta(revision.rev, revision.kind, formatTime(revision.created_at), revision.via)}
      </footer>
    </article>
  );
}

function Breadcrumbs({ space, path }: { space: string; path: string }) {
  const segs = path.split('/');
  return (
    <nav aria-label={tx.doc.breadcrumbs} className="flex flex-wrap items-center gap-1 text-sm text-zinc-500">
      <Link to={routes.space(space)} className="hover:underline">
        {space}
      </Link>
      {segs.map((s, i) => (
        <span key={i} className="flex items-center gap-1">
          <span aria-hidden>/</span>
          <span className={i === segs.length - 1 ? 'text-zinc-700 dark:text-zinc-300' : ''}>{s}</span>
        </span>
      ))}
    </nav>
  );
}

function DocHeader({ space, doc, data, rev }: { space: string; doc: DocInfo; data: ReadOut; rev: number | undefined }) {
  const r = data.revision;
  const old = rev !== undefined && rev !== doc.rev;
  return (
    <header className="space-y-3">
      <Breadcrumbs space={space} path={doc.path} />
      <h1 className="text-2xl font-semibold break-words">{doc.title || doc.path}</h1>
      {old && (
        <p role="note" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {tx.doc.oldRevision(r.rev, doc.rev)}{' '}
          <Link to={routes.doc(space, doc.path)} className="underline">
            {tx.doc.openCurrent}
          </Link>
        </p>
      )}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-zinc-500">{old ? tx.doc.revisionAuthor : tx.doc.lastEdit}</dt>
        <dd>
          <AuthorLine author={old ? r.author : doc.author} />
          <span className="ml-2 text-zinc-500">{formatTime(old ? r.created_at : doc.updated_at)}</span>
        </dd>
        {(old ? r.approved_by : doc.approved_by) && (
          <>
            <dt className="text-zinc-500">{tx.doc.approvedBy}</dt>
            <dd>
              <AuthorLine author={(old ? r.approved_by : doc.approved_by)!} />
            </dd>
          </>
        )}
        {r.message && (
          <>
            <dt className="text-zinc-500">{tx.doc.message}</dt>
            <dd className="break-words">{r.message}</dd>
          </>
        )}
        <dt className="text-zinc-500">{tx.doc.revision}</dt>
        <dd>
          {r.rev}
          {!old && doc.rev > 1 && <span className="text-zinc-500">{tx.doc.total(doc.rev)}</span>}
        </dd>
        {doc.expires_at && (
          <>
            <dt className="text-zinc-500">{tx.doc.ttl}</dt>
            <dd>
              <Badge tone="warn" title={doc.expires_at}>
                {tx.doc.deletes(formatUntil(doc.expires_at))}
              </Badge>{' '}
              <span className="text-zinc-500">{formatTime(doc.expires_at)}</span>
            </dd>
          </>
        )}
        <dt className="text-zinc-500">{tx.doc.size}</dt>
        <dd>
          {formatSize(doc.size)} <span className="text-zinc-500">· {doc.mime}</span>
        </dd>
        {doc.tags && doc.tags.length > 0 && (
          <>
            <dt className="text-zinc-500">{tx.doc.tags}</dt>
            <dd className="flex flex-wrap gap-1">
              {doc.tags.map((t) => (
                <Badge key={t}>#{t}</Badge>
              ))}
            </dd>
          </>
        )}
        {doc.deleted && (
          <>
            <dt className="text-zinc-500">{tx.doc.state}</dt>
            <dd>
              <Badge tone="danger">{tx.doc.inTrash}</Badge>
            </dd>
          </>
        )}
      </dl>
      {/* Trust stays out of the header: under Details, for whoever needs it. */}
      <details className="text-sm">
        <summary className="cursor-pointer text-zinc-500">{tx.doc.details}</summary>
        <p className="mt-1">
          <span className="text-zinc-500" title={tx.doc.trustFloorTitle}>
            {tx.doc.trustFloor}:
          </span>{' '}
          <TrustBadge trust={doc.trust_floor} />
        </p>
      </details>
    </header>
  );
}

function DownloadLink({ doc, rev, children }: { doc: DocInfo; rev: number | undefined; children: string }) {
  return (
    <a
      href={rawUrl(doc.id, rev)}
      download
      className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
    >
      ⬇ {children}
    </a>
  );
}

function FileCard({ doc, rev }: { doc: DocInfo; rev: number | undefined }) {
  return (
    <section className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <span className="text-sm text-zinc-600 dark:text-zinc-400">
        {tx.doc.attachment(doc.mime, formatSize(doc.size))}
      </span>
      <DownloadLink doc={doc} rev={rev}>
        {tx.common.download}
      </DownloadLink>
    </section>
  );
}

function DocBody({ space, doc, data, rev }: { space: string; doc: DocInfo; data: ReadOut; rev: number | undefined }) {
  const content = data.content ?? '';
  const markdown = doc.mime === 'text/markdown';
  const { frontmatter, body } = markdown ? splitFrontmatter(content) : { frontmatter: null, body: content };
  return (
    <section className="space-y-3">
      {data.truncated && (
        <p role="note" className="rounded-md border border-zinc-300 p-2 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
          {tx.doc.truncated(formatSize(UI_MAX_BYTES))}
        </p>
      )}
      {frontmatter !== null && (
        <details className="rounded-md border border-zinc-200 text-sm dark:border-zinc-800">
          <summary className="cursor-pointer px-3 py-1.5 text-zinc-500">Frontmatter</summary>
          <pre className="overflow-x-auto px-3 pb-2 font-mono text-xs whitespace-pre-wrap">{frontmatter}</pre>
        </details>
      )}
      {markdown ? (
        <Markdown source={body} env={{ space, docPath: doc.path }} />
      ) : (
        <pre className="overflow-x-auto rounded-md bg-zinc-50 p-3 font-mono text-sm whitespace-pre-wrap dark:bg-zinc-900">{body}</pre>
      )}
      <div>
        <DownloadLink doc={doc} rev={rev}>
          {tx.common.download}
        </DownloadLink>
      </div>
    </section>
  );
}
