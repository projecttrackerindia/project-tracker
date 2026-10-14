import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { PageHead } from '../../components/ui';
import { documentApi } from '../../api/endpoints';
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
  const waiting = inbox.data?.waiting ?? 0;
  const setView = (v: DocumentsView) => setParams(v === 'all' ? {} : { view: v }, { replace: true });
  const setProject = (id: string | null) => setParams(id === null ? {} : { project: id }, { replace: true });
  return (
    <div className="doc-scope">
      <PageHead title="Documents" sub="Requirements, API documentation, test plans and more, linked to the projects and tasks that deliver them.">
        {isAdmin && <button className="btn btn-ghost" onClick={() => setSecurity(true)}><Icon name="shield" size={15} /> Security</button>}
        <button className="btn btn-ghost" onClick={() => setFlows(true)}><Icon name="checks" size={15} /> Approval workflows</button>
        {canCreate && <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" /> New document</button>}
      </PageHead>
      <div className="doc-shell">
        <DocumentsSidebar view={view} onSelectView={(v) => setView(v)} waiting={waiting} activeProject={project} onSelectProject={setProject} />
        <div className="doc-shell-main">
          {view === 'all' && !inProject && <DocumentsControlCenter />}
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
