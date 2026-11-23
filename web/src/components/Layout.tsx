// The shell: a header with search, spaces and the tree on the left, content on the right. On a narrow
// screen the left column moves into a slide-out panel.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate } from 'react-router';
import { api } from '../api/client';
import type { SessionPrincipal } from '../api/types';
import { routes } from '../lib/routes';
import { loadTheme, nextTheme, saveTheme, type ThemeChoice } from '../lib/theme';
import { SESSION_KEY } from '../session';
import { Tree } from './Tree';
import { Menu, MENU_ITEM } from './controls';
import { ErrorView, Spinner } from './ui';
import { tx } from '../i18n';

const THEME_LABEL: Record<ThemeChoice, string> = tx.layout.theme;

export function Layout({ principal }: { principal: SessionPrincipal }) {
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();
  const spaceMatch = useMatch('/s/:space/*');
  const docMatch = useMatch('/s/:space/d/*');
  const editMatch = useMatch('/s/:space/edit/*');
  const historyMatch = useMatch('/s/:space/history/*');
  const space = spaceMatch?.params.space;
  const activePath = (docMatch ?? editMatch ?? historyMatch)?.params['*'];

  // Navigating closes the panel on the phone.
  useEffect(() => setDrawer(false), [location.pathname]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  return (
    <div className="flex h-dvh flex-col">
      <Header principal={principal} onMenu={() => setDrawer((v) => !v)} drawerOpen={drawer} />
      <div className="relative flex min-h-0 flex-1">
        {drawer && <div className="fixed inset-0 top-12 z-20 bg-black/30 md:hidden" aria-hidden onClick={() => setDrawer(false)} />}
        <aside
          id="sidebar"
          aria-label={tx.layout.navigation}
          className={`fixed top-12 bottom-0 left-0 z-30 w-80 max-w-[85vw] overflow-y-auto border-r border-zinc-200 bg-white p-2 transition-transform dark:border-zinc-800 dark:bg-zinc-950 md:static md:z-auto md:w-72 md:translate-x-0 ${
            drawer ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <Sidebar space={space} activePath={activePath} admin={principal.admin} />
        </aside>
        <main id="main" className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Header({ principal, onMenu, drawerOpen }: { principal: SessionPrincipal; onMenu: () => void; drawerOpen: boolean }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const query = q.trim();
    if (query) navigate(routes.search(query));
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-200 px-2 dark:border-zinc-800">
      <button
        type="button"
        className="rounded p-2 hover:bg-zinc-100 md:hidden dark:hover:bg-zinc-800"
        aria-label={tx.layout.menu}
        aria-controls="sidebar"
        aria-expanded={drawerOpen}
        onClick={onMenu}
      >
        ☰
      </button>
      <Link to={routes.home()} className="px-1 font-semibold tracking-tight">
        Brain
      </Link>
      <form role="search" onSubmit={submit} className="mx-2 min-w-0 flex-1 md:max-w-md">
        <label htmlFor="global-search" className="sr-only">
          {tx.layout.search}
        </label>
        <input
          id="global-search"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={tx.layout.searchPlaceholder}
          maxLength={256}
          className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-sm outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </form>
      {/* The spacer pins the avatar menu to the right edge. */}
      <div className="hidden flex-1 md:block" aria-hidden />
      <AvatarMenu principal={principal} />
    </header>
  );
}

/** Avatar menu: name, Account, Theme, Log out (no role badge; the theme toggle lives here). */
function AvatarMenu({ principal }: { principal: SessionPrincipal }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [theme, setTheme] = useState<ThemeChoice>(loadTheme);
  const logout = async () => {
    try {
      await api.logout();
    } finally {
      qc.clear();
      qc.setQueryData(SESSION_KEY, null);
      navigate(routes.login());
    }
  };
  const toggleTheme = () => {
    const t = nextTheme(theme);
    saveTheme(t);
    setTheme(t);
  };
  const initial = principal.name.slice(0, 1).toUpperCase();
  return (
    <Menu
      label={tx.layout.accountMenu}
      named
      buttonClass="flex items-center gap-2 rounded-full p-0.5 pr-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
      button={
        <>
          <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-full bg-sky-600 text-xs font-semibold text-white">
            {initial}
          </span>
          <span className="sr-only">{tx.layout.accountMenu}: </span>
          <span className="hidden sm:inline">{principal.name}</span>
        </>
      }
    >
      {(close) => (
        <>
          <div className="px-3 py-1.5 text-sm">
            <div className="font-medium">{principal.name}</div>
          </div>
          <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
          <Link role="menuitem" to={routes.account()} className={MENU_ITEM} onClick={close}>
            {tx.layout.account}
          </Link>
          <button role="menuitem" type="button" className={MENU_ITEM} onClick={toggleTheme}>
            {THEME_LABEL[theme]}
          </button>
          <button role="menuitem" type="button" className={MENU_ITEM} onClick={() => void logout()}>
            {tx.layout.logout}
          </button>
        </>
      )}
    </Menu>
  );
}

/** The one administration menu: the page tab bar is gone; Groups is a tab of People & agents. */
const ADMIN_LINKS: [string, string][] = [
  [routes.admin.principals(), tx.layout.adminLinks.principals],
  [routes.admin.audit(), tx.layout.adminLinks.audit],
  [routes.admin.settings(), tx.layout.adminLinks.settings],
];

const navClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center justify-between gap-2 truncate rounded px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${isActive ? 'bg-zinc-100 font-medium dark:bg-zinc-800' : ''}`;

/** The number of open proposals the human sees (their own and those they decide on). */
function OpenProposals() {
  const q = useQuery({ queryKey: ['proposals', 'open', null, false, 'count'], queryFn: () => api.proposalList({ status: 'open', limit: 50 }) });
  const n = q.data?.proposals.length ?? 0;
  if (n === 0) return null;
  return (
    <span className="rounded-full bg-amber-100 px-1.5 text-xs font-medium text-amber-900 dark:bg-amber-900/50 dark:text-amber-300" aria-label={tx.layout.openCount(n)}>
      {n}
      {q.data?.next_cursor ? '+' : ''}
    </span>
  );
}

/** Badge: messages to the signed-in human not received yet. */
function WaitingMessages() {
  const q = useQuery({ queryKey: ['handoff', 'in', false], queryFn: () => api.handoffInbox({ box: 'in' }) });
  const n = (q.data?.counts.new ?? 0) + (q.data?.counts.updated ?? 0);
  if (n === 0) return null;
  return (
    <span className="rounded-full bg-sky-100 px-1.5 text-xs font-medium text-sky-900 dark:bg-sky-900/50 dark:text-sky-300" aria-label={tx.layout.waitingCount(n)}>
      {n}
    </span>
  );
}

function Sidebar({ space, activePath, admin }: { space: string | undefined; activePath: string | undefined; admin: boolean }) {
  const { pathname } = useLocation();
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: api.spaces });
  return (
    <nav className="flex flex-col gap-3">
      <ul className="text-sm">
        <li>
          <NavLink to="/inbox" className={navClass}>
            <span>{tx.layout.handoff}</span>
            <WaitingMessages />
          </NavLink>
        </li>
        <li>
          <NavLink to="/feed" className={navClass}>
            {tx.layout.feed}
          </NavLink>
        </li>
        <li>
          <NavLink to="/proposals" className={navClass}>
            <span>{tx.layout.proposals}</span>
            <OpenProposals />
          </NavLink>
        </li>
      </ul>
      {admin && (
        <div>
          <h2 className="px-2 pb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{tx.layout.administration}</h2>
          <ul className="text-sm">
            {ADMIN_LINKS.map(([to, label]) => (
              <li key={to}>
                <NavLink
                  to={to}
                  className={({ isActive }) =>
                    `block truncate rounded px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                      isActive || (to === routes.admin.principals() && pathname.startsWith(routes.admin.groups())) ? 'bg-zinc-100 font-medium dark:bg-zinc-800' : ''
                    }`
                  }
                >
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h2 className="px-2 pb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{tx.layout.spaces}</h2>
        {spaces.isPending && <Spinner />}
        {spaces.isError && <ErrorView error={spaces.error} />}
        {spaces.data && (
          <ul className="text-sm">
            {/* Active spaces only; archived ones are under Settings → Archived spaces. */}
            {spaces.data.spaces
              .filter((s) => !s.archived || s.slug === space)
              .map((s) => (
              <li key={s.slug}>
                <NavLink
                  to={routes.space(s.slug)}
                  end
                  className={() =>
                    `block truncate rounded px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                      s.slug === space ? 'bg-zinc-100 font-medium dark:bg-zinc-800' : ''
                    }`
                  }
                >
                  {s.name}
                </NavLink>
              </li>
            ))}
            {spaces.data.spaces.filter((s) => !s.archived).length === 0 && <li className="px-2 py-1 text-zinc-500">{tx.layout.noSpaces}</li>}
            {admin && (
              <li>
                <NavLink to={routes.newSpace()} className={navClass}>
                  {tx.layout.newSpace}
                </NavLink>
              </li>
            )}
          </ul>
        )}
      </div>
      {space && (
        <div>
          <h2 className="px-2 pb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{tx.layout.tree}</h2>
          <Tree key={space} space={space} activePath={activePath} />
        </div>
      )}
    </nav>
  );
}
