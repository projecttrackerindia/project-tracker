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
import { DocumentOverview } from './DocumentOverview';
import { DocumentWizard } from './DocumentWizard';

/** Every document the person may open, wherever it lives: in a project, a team, or the whole organization. */
export function DocumentsPage() {
  const nav = useNavigate();
  const canCreate = useModule('documents') >= 2;
  const [creating, setCreating] = useState(false);
  const [flows, setFlows] = useState(false);
  const [security, setSecurity] = useState(false);
  const isAdmin = useAuth((s) => s.ctx?.current?.role === 'Owner' || s.ctx?.current?.role === 'Admin');
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'inbox' ? 'inbox' : 'all';
  const inbox = useWsQuery(['documents', 'inbox'], documentApi.inbox);
  const waiting = inbox.data?.waiting ?? 0;
  const setView = (v: 'all' | 'inbox') => setParams(v === 'inbox' ? { view: 'inbox' } : {}, { replace: true });
  return (
    <>
      <PageHead title="Documents" sub="Requirements, API documentation, test plans and more, linked to the projects and tasks that deliver them.">
        {isAdmin && <button className="btn btn-ghost" onClick={() => setSecurity(true)}><Icon name="shield" size={15} /> Security</button>}
        <button className="btn btn-ghost" onClick={() => setFlows(true)}><Icon name="checks" size={15} /> Approval workflows</button>
        {canCreate && <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" /> New document</button>}
      </PageHead>
      <div className="seg doc-views" role="tablist" aria-label="Documents view">
        <button role="tab" aria-selected={view === 'all'} className={view === 'all' ? 'on' : ''} onClick={() => setView('all')}>All documents</button>
        <button role="tab" aria-selected={view === 'inbox'} className={view === 'inbox' ? 'on' : ''} onClick={() => setView('inbox')}>Waiting for me{waiting > 0 && <span className="doc-count">{waiting}</span>}</button>
      </div>
      {view === 'all' && <DocumentOverview />}
      {view === 'inbox' ? <InboxView /> : <DocumentList canCreate={canCreate} onNew={() => setCreating(true)} />}
      {flows && <WorkflowsModal onClose={() => setFlows(false)} />}
      {security && <DocumentSecurityModal onClose={() => setSecurity(false)} />}
      {creating && <DocumentWizard onClose={() => setCreating(false)} onCreated={(id) => nav(`/documents/${id}`)} />}
    </>
  );
}
