import { Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router';
import { Layout } from './components/Layout';
import { ErrorView, Spinner } from './components/ui';
import { AccountPage } from './pages/AccountPage';
import { DocPage } from './pages/DocPage';
import { EditPage, NewDocPage } from './pages/EditPage';
import { ExportPage } from './pages/ExportPage';
import { FeedPage } from './pages/FeedPage';
import { InboxPage } from './pages/InboxPage';
import { HistoryPage } from './pages/HistoryPage';
import { LoginPage } from './pages/LoginPage';
import { ProposalPage, ProposalsPage } from './pages/ProposalsPage';
import { SearchPage } from './pages/SearchPage';
import { SpacePage } from './pages/SpacePage';
import { SpacesPage } from './pages/SpacesPage';
import { TrashPage } from './pages/TrashPage';
import { AuditAdminPage } from './pages/admin/AuditAdmin';
import { SettingsAdminPage } from './pages/admin/SettingsAdmin';
import { ExplainRedirect, GroupsAdminPage } from './pages/admin/AccessAdmin';
import { PrincipalAdminPage, PrincipalsAdminPage } from './pages/admin/PrincipalsAdmin';
import { ConnectAgentPage } from './pages/admin/ConnectAgent';
import { NewSpacePage } from './pages/NewSpacePage';
import { routes } from './lib/routes';
import { useSession } from './session';

export function App() {
  const session = useSession();
  const location = useLocation();
  if (session.isPending) return <Spinner />;
  if (session.isError) return <ErrorView error={session.error} />;
  const principal = session.data;
  if (!principal) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to={`${routes.login()}?next=${encodeURIComponent(location.pathname + location.search)}`} replace />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<Layout principal={principal} />}>
        <Route index element={<SpacesPage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="feed" element={<FeedPage />} />
        <Route path="proposals" element={<ProposalsPage />} />
        <Route path="proposals/:id" element={<ProposalPage />} />
        <Route path="inbox" element={<InboxPage />} />
        {/* The Messages page became the Inbox. */}
        <Route path="handoff" element={<Navigate to="/inbox" replace />} />
        <Route path="export" element={<ExportPage />} />
        <Route path="account" element={<AccountPage principal={principal} />} />
        <Route path="s/:space" element={<SpacePage />} />
        <Route path="s/:space/messages" element={<SpacePage tab="messages" />} />
        <Route path="s/:space/members" element={<SpacePage tab="members" />} />
        <Route path="s/:space/settings" element={<SpacePage tab="settings" />} />
        <Route path="new-space" element={principal.admin ? <NewSpacePage /> : <ErrorView error={{ code: 'not_found' }} />} />
        <Route path="s/:space/d/*" element={<DocPage />} />
        <Route path="s/:space/edit/*" element={<EditPage />} />
        <Route path="s/:space/history/*" element={<HistoryPage />} />
        <Route path="s/:space/new" element={<NewDocPage />} />
        <Route path="s/:space/trash" element={<TrashPage />} />
        {/* Administration: without the `admin` capability the section doesn't exist — no screens, no requests. */}
        <Route path="admin" element={principal.admin ? <Outlet /> : <ErrorView error={{ code: 'not_found' }} />}>
          <Route index element={<Navigate to="/admin/agents" replace />} />
          {/* No /admin/spaces list, no Access matrix; old links land on their replacements. */}
          <Route path="spaces" element={<Navigate to="/" replace />} />
          <Route path="spaces/:slug" element={<SpaceSettingsRedirect />} />
          <Route path="agents" element={<PrincipalsAdminPage />} />
          <Route path="connect-agent" element={<ConnectAgentPage />} />
          <Route path="agents/:name" element={<PrincipalAdminPage />} />
          <Route path="agents/:name/:tab" element={<PrincipalAdminPage />} />
          <Route path="groups" element={<GroupsAdminPage />} />
          <Route path="access" element={<Navigate to="/admin/agents" replace />} />
          <Route path="explain" element={<ExplainRedirect />} />
          <Route path="audit" element={<AuditAdminPage />} />
          <Route path="settings" element={<SettingsAdminPage />} />
        </Route>
        <Route path="*" element={<ErrorView error={{ code: 'not_found' }} />} />
      </Route>
    </Routes>
  );
}

/** The former `/admin/spaces/:slug` → the space's Settings tab. */
function SpaceSettingsRedirect() {
  const { slug = '' } = useParams();
  return <Navigate to={routes.spaceSettings(slug)} replace />;
}
