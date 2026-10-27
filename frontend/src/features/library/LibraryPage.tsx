import { Navigate, useLocation, useParams } from 'react-router-dom';
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
  if (section === 'docs' && id) return <DocumentPage />;
  return <DocsHub />;
}
