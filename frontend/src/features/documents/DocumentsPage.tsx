import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { documentApi, projectApi } from '../../api/endpoints';
import { useWsQuery } from '../../lib/hooks';
import { useAuth, useModule } from '../../stores/auth';
import { DocumentList } from './DocumentList';
import { InboxView } from './DocumentInbox';
import { WorkflowsModal } from './DocumentWorkflows';
import { DocumentSecurityModal } from './DocumentSecurity';
import { DocumentsControlCenter } from './DocumentsControlCenter';
import { DocumentWizard } from './DocumentWizard';
import { DocumentsSidebar, type DocumentsView } from './DocumentsSidebar';

const VIEWS: DocumentsView[] = ['all', 'mine', 'shared', 'inbox', 'recent', 'restricted', 'trash'];

/** Every document the person may open, wherever it lives: in a project, a team, or the whole organization. */
export function DocumentsPage() {
  const nav = useNavigate();
  const canCreate = useModule('documents') >= 2;
  const [creating, setCreating] = useState(false);
  const [flows, setFlows] = useState(false);
  const [security, setSecurity] = useState(false);
  const isAdmin = useAuth((s) => s.ctx?.current?.role === 'Owner' || s.ctx?.current?.role === 'Admin');
  const userId = useAuth((s) => s.ctx?.user?.id);
  const [params, setParams] = useSearchParams();
  const viewParam = params.get('view') as DocumentsView | null;
  const view: DocumentsView = viewParam && VIEWS.includes(viewParam) ? viewParam : 'all';
  // A project selected in the sidebar's tree is a filter orthogonal to the 7 pinned views above — not a new view
  // of its own, so it lives in its own query param. Picking one replaces the whole query string (same pattern
  // setView already used), which naturally clears whichever of the two was previously set.
  const project = params.get('project');
  const inProject = project !== null;
  const inbox = useWsQuery(['documents', 'inbox'], documentApi.inbox);
  const projects = useWsQuery(['projects', 'options'], () => projectApi.list({ pageSize: 100 }));
  const waiting = inbox.data?.waiting ?? 0;
  const setView = (v: DocumentsView) => setParams(v === 'all' ? {} : { view: v }, { replace: true });
  const setProject = (id: string | null) => setParams(id === null ? {} : { project: id }, { replace: true });
  const VIEW_LABEL: Record<DocumentsView, string> = { all: 'All documents', mine: 'My documents', shared: 'Shared with me', inbox: 'Waiting for me', recent: 'Recently viewed', restricted: 'Restricted', trash: 'Trash' };
  const projectName = inProject ? (project === 'general' ? 'General' : projects.data?.items.find((p) => p.id === project)?.name ?? 'Project') : null;
  const here = projectName ?? VIEW_LABEL[view];
  return (
    <div className="doc-scope ds-page">
      <header className="ds-head">
        <div className="ds-head-main">
          <nav className="ds-crumb" aria-label="Breadcrumb"><span>documents</span><i>/</i><b>{here}</b>{waiting > 0 && <button type="button" className="ds-pill warn" onClick={() => setView('inbox')}><i />{waiting} waiting for you</button>}</nav>
          <h1>Documents</h1>
          <p>Requirements, API documentation, test plans and runbooks - linked to the projects and tasks that deliver them.</p>
        </div>
        <div className="ds-head-actions">
          {isAdmin && <button className="btn btn-ghost btn-sm" onClick={() => setSecurity(true)}><Icon name="shield" size={14} /> Security</button>}
          <button className="btn btn-ghost btn-sm" onClick={() => setFlows(true)}><Icon name="checks" size={14} /> Approval workflows</button>
          {canCreate && <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" /> New document</button>}
        </div>
      </header>
      <div className="doc-shell">
        <DocumentsSidebar view={view} onSelectView={(v) => setView(v)} waiting={waiting} activeProject={project} onSelectProject={setProject} />
        <div className="doc-shell-main">
          {view === 'all' && !inProject && <DocumentsControlCenter onView={setView} />}
          <div className="ds-section-title ds-list-title">{here}<span>{view === 'inbox' && !inProject ? '— reviews and access requests that need you' : inProject ? '— documents in this project' : view === 'all' ? '— every document you can open' : ''}</span></div>
          {view === 'inbox' && !inProject ? <InboxView /> : (
            <DocumentList canCreate={canCreate} onNew={() => setCreating(true)}
              fixedScope={!inProject && (view === 'recent' || view === 'shared' || view === 'trash') ? view : undefined}
              mine={!inProject && view === 'mine' ? userId : undefined} restricted={!inProject && view === 'restricted'}
              projectId={inProject && project !== 'general' ? project : undefined} general={inProject && project === 'general'} />
          )}
        </div>
      </div>
      {flows && <WorkflowsModal onClose={() => setFlows(false)} />}
      {security && <DocumentSecurityModal onClose={() => setSecurity(false)} />}
      {creating && <DocumentWizard onClose={() => setCreating(false)} onCreated={(id) => nav(`/documents/${id}`)} />}
    </div>
  );
}
