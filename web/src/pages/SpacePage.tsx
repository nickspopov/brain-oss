import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, NavLink, useParams } from 'react-router';
import { api } from '../api/client';
import { Notice } from '../components/DocActions';
import { Menu, MENU_ITEM, Page } from '../components/controls';
import { BTN, BTN_PRIMARY } from '../components/edit';
import { Markdown } from '../components/Markdown';
import { SpaceBadges } from '../components/SpaceBadges';
import { Tree } from '../components/Tree';
import { UploadForm } from '../components/UploadForm';
import { ErrorView, Spinner } from '../components/ui';
import { splitFrontmatter } from '../lib/frontmatter';
import { routes } from '../lib/routes';
import { tx } from '../i18n';
import { useSession } from '../session';
import { ThreadView } from './InboxPage';
import { SpaceMembers } from './space/SpaceMembers';
import { SpaceSettings } from './space/SpaceSettings';

export type SpaceTab = 'documents' | 'messages' | 'members' | 'settings';

const TAB = ({ isActive }: { isActive: boolean }) =>
  `-mb-px border-b-2 px-3 py-1.5 text-sm ${isActive ? 'border-sky-700 font-medium text-zinc-900 dark:border-sky-400 dark:text-zinc-100' : 'border-transparent text-zinc-600 hover:text-zinc-900 dark:text-zinc-400'}`;

/**
 * A space: Documents · Messages (when messages are on) · Members · Settings (Brain
 * administrators; there is no separate /admin/spaces page).
 */
export function SpacePage({ tab = 'documents' }: { tab?: SpaceTab } = {}) {
  const { space = '' } = useParams();
  const [upload, setUpload] = useState(false);
  const isAdmin = useSession().data?.admin === true;
  const q = useQuery({ queryKey: ['spaces'], queryFn: api.spaces });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorView error={q.error} />;
  const info = q.data.spaces.find((s) => s.slug === space);
  if (!info) return <ErrorView error={{ code: 'not_found' }} />;
  return (
    <Page>
      <Notice />
      <header className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h1 className="text-xl font-semibold">{info.name}</h1>
          {/* One primary action; the rest in ⋯. */}
          <div className="flex items-center gap-2">
            <Link className={BTN_PRIMARY} to={routes.newDoc(space)}>
              {tx.spacePage.newDocument}
            </Link>
            <Menu label={tx.spacePage.more} button="⋯">
              {(close) => (
                <>
                  <button
                    role="menuitem"
                    type="button"
                    className={MENU_ITEM}
                    onClick={() => {
                      setUpload(true);
                      close();
                    }}
                  >
                    {tx.spacePage.uploadFile}
                  </button>
                  <Link role="menuitem" className={MENU_ITEM} to={routes.feed({ space })}>
                    {tx.spacePage.feed}
                  </Link>
                  <Link role="menuitem" className={MENU_ITEM} to={routes.trash(space)}>
                    {tx.spacePage.trash}
                  </Link>
                  <Link role="menuitem" className={MENU_ITEM} to={routes.exportSpace(space)}>
                    {tx.spacePage.export}
                  </Link>
                </>
              )}
            </Menu>
          </div>
        </div>
        {info.description && <p className="text-zinc-600 dark:text-zinc-400">{info.description}</p>}
        <SpaceBadges space={info} />
      </header>
      {(info.inbox || isAdmin) && (
        <nav aria-label={tx.spacePage.tabsLabel} className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
          <NavLink to={routes.space(space)} end className={TAB}>
            {tx.spacePage.tabs.documents}
          </NavLink>
          {info.inbox && (
            <NavLink to={routes.spaceMessages(space)} className={TAB}>
              {tx.spacePage.tabs.messages}
            </NavLink>
          )}
          {isAdmin && (
            <>
              <NavLink to={routes.spaceMembers(space)} className={TAB}>
                {tx.spacePage.tabs.members}
              </NavLink>
              <NavLink to={routes.spaceSettings(space)} className={TAB}>
                {tx.spacePage.tabs.settings}
              </NavLink>
            </>
          )}
        </nav>
      )}
      {tab === 'messages' && info.inbox ? (
        <ThreadView key={space} space={space} />
      ) : tab === 'members' && isAdmin ? (
        <SpaceMembers key={space} space={space} />
      ) : tab === 'settings' && isAdmin ? (
        <SpaceSettings key={space} space={space} />
      ) : (
        <SpaceDocuments space={space} info={info} upload={upload} setUpload={setUpload} />
      )}
    </Page>
  );
}

function SpaceDocuments({
  space,
  info,
  upload,
  setUpload,
}: {
  space: string;
  info: { agents_md?: { rev: number; content: string; truncated: boolean } | null };
  upload: boolean;
  setUpload: (v: boolean) => void;
}) {
  return (
    <>
      {/* On the phone the tree is in a slide-out panel; here, the same root content, large. */}
      <section aria-labelledby="space-tree" className="rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
        <h2 id="space-tree" className="px-2 pb-1 text-sm font-semibold text-zinc-500">
          {tx.spacePage.contents}
        </h2>
        <Tree space={space} />
      </section>
      {upload && (
        <section aria-labelledby="space-upload" className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="flex items-center justify-between gap-2">
            <h2 id="space-upload" className="text-sm font-semibold text-zinc-500">
              {tx.spacePage.uploadFile}
            </h2>
            <button type="button" className={BTN} onClick={() => setUpload(false)}>
              {tx.common.close}
            </button>
          </div>
          <UploadForm space={space} />
        </section>
      )}
      {info.agents_md && (
        <section aria-labelledby="agents-md" className="space-y-2">
          <h2 id="agents-md" className="text-sm font-semibold text-zinc-500">
            AGENTS.md <span className="font-normal">{tx.spacePage.revision(info.agents_md.rev)}</span>
          </h2>
          <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <Markdown source={splitFrontmatter(info.agents_md.content).body} env={{ space, docPath: 'AGENTS.md' }} />
            {info.agents_md.truncated && <p className="mt-3 text-sm text-zinc-500">{tx.spacePage.truncated}</p>}
          </div>
        </section>
      )}
    </>
  );
}
