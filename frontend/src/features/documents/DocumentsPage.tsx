import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { PageHead } from '../../components/ui';
import { useModule } from '../../stores/auth';
import { DocumentList } from './DocumentList';
import { DocumentWizard } from './DocumentWizard';

/** Every document the person may open, wherever it lives: in a project, a team, or the whole organization. */
export function DocumentsPage() {
  const nav = useNavigate();
  const canCreate = useModule('documents') >= 2;
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHead title="Documents" sub="Requirements, API documentation, test plans and more, linked to the projects and tasks that deliver them.">
        {canCreate && <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" /> New document</button>}
      </PageHead>
      <DocumentList canCreate={canCreate} onNew={() => setCreating(true)} />
      {creating && <DocumentWizard onClose={() => setCreating(false)} onCreated={(id) => nav(`/documents/${id}`)} />}
    </>
  );
}
