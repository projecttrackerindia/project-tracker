import { Navigate, useLocation, useParams } from 'react-router-dom';
import { documentApi } from '../../api/endpoints';
import { PageLoader } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { DocumentPage } from '../documents/DocumentPage';
import { DocsHub } from './docs/DocsHub';
import { legacyTarget } from './docs/nav';
import { ProjectDocs } from './docs/ProjectDocs';
import { SecurityCenter } from './docs/SecurityCenter';
import { LibraryVault } from './LibraryVault';
import './library.css';

export type LibraryTab = 'docs' | 'vault';

/**
 * Library. The documentation hub (/library), a project's documentation (/library/p/{project}/…), a document on its own
 * (/library/docs/{id}), Security Center (/library/security) and the Vault (/library/vault). Old DocTracker addresses (?view=, ?p=, ?t=,
 * ?ep=, /library/docs, /doctracker) are sent to their new place.
 */
export function LibraryPage({ tab }: { tab?: LibraryTab } = {}) {
  const { section, id } = useParams();
  const loc = useLocation();
  const moved = legacyTarget(loc.pathname, loc.search);
  if (moved) return <Navigate to={`${moved}${loc.hash}`} replace state={loc.state} />;
  if (tab === 'vault' || section === 'vault' || new URLSearchParams(loc.search).get('tab') === 'vault') return <LibraryVault />;
  if (loc.pathname.startsWith('/library/p/')) return <ProjectDocs />;
  if (section === 'security') return <SecurityCenter />;
  if (section === 'docs' && id) return <DocInSpace id={id} />;
  return <DocsHub />;
}

/**
 * /library/docs/{id}: every document opens inside its project's documentation (General when it has no project), so the navigator, the
 * breadcrumb and Back always belong to the space it lives in. A document that cannot be loaded shows its own error page.
 */
function DocInSpace({ id }: { id: string }) {
  const loc = useLocation();
  const q = useWsQuery(['documents', id], () => documentApi.get(id), { retry: false });
  if (q.isLoading) return <PageLoader />;
  if (!q.data) return <DocumentPage />;
  return <Navigate replace state={loc.state} to={`/library/p/${q.data.item.projectId ?? 'general'}/d/${id}${loc.search}${loc.hash}`} />;
}
