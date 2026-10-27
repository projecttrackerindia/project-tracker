import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { projectApi } from '../../api/endpoints';
import { ErrorState, PageLoader, Segmented } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { useAuth, useCan } from '../../stores/auth';
import { Board, ListView } from '../projects/Board';
import { ActionItemsTab } from '../projects/ActionItemsPanel';
import { PlanPanel } from '../planning/PlanPanel';
import { IssuesPanel } from '../issues/IssuesPanel';
import { ReportIssueModal } from '../issues/IssueModals';
import { QuickAdd } from '../tasks/QuickAdd';
import { TaskModal } from '../tasks/TaskModal';

type View = 'list' | 'board' | 'timeline' | 'issues' | 'actions';

/**
 * STUB (Projects worker, so the project page can be built and tested): a project's Work tab with today's views. The Work worker's version
 * (one list on /api/v1/work-items with a List / Board / Timeline switch and the side panel) replaces this file at merge.
 * Contract: `ProjectWorkTab({ projectId })`; `?view=list|board|timeline` and `?kind=issue|action` pick what it opens on, `?task=` and `?issue=`
 * open an item (the project page handles those).
 */
export function ProjectWorkTab({ projectId }: { projectId: string }) {
  const [params, setParams] = useSearchParams();
  const q = useWsQuery(['project', projectId], () => projectApi.get(projectId));
  const canCreate = useCan('tasks.create'), canPlan = useCan('tasks.edit'), canEditPerm = useCan('projects.edit'), canReport = useCan('tasks.comment');
  const me = useAuth((s) => s.ctx?.user.id);
  const kind = params.get('kind'), asked = params.get('view');
  const view: View = kind === 'issue' ? 'issues' : kind === 'action' ? 'actions' : asked === 'board' || asked === 'timeline' ? asked : 'list';
  const [stage, setStage] = useState('');
  const [newTask, setNewTask] = useState<{ statusId?: string } | null>(null);
  const [reporting, setReporting] = useState<{ stageId?: string } | null>(null);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const { project: p, statuses, stages, members } = q.data;
  const archived = p.status === 'Archived';
  const canEdit = canEditPerm || p.owner?.id === me;
  const set = (v: View) => {
    const n = new URLSearchParams(params); n.delete('kind'); n.delete('view');
    if (v === 'issues') n.set('kind', 'issue'); else if (v === 'actions') n.set('kind', 'action'); else if (v !== 'list') n.set('view', v);
    setParams(n, { replace: true });
  };
  const open = (key: string, id: string) => { const n = new URLSearchParams(params); n.set(key, id); setParams(n, { replace: true }); };
  return (
    <div className="pw-stub" data-testid="project-work">
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16, overflowX: 'auto' }}>
        <Segmented<View> label="Work view" value={view} onChange={set} options={[
          { id: 'list', label: 'List' }, { id: 'board', label: 'Board' }, { id: 'timeline', label: 'Timeline' }, { id: 'issues', label: 'Issues' }, { id: 'actions', label: 'Action items' },
        ]} />
      </div>
      {(view === 'list' || view === 'board') && canCreate && !archived && <QuickAdd projectId={p.id} />}
      {view === 'list' && <ListView projectId={p.id} stages={stages} archived={archived} canCreate={canCreate && !archived} onOpenTask={(id) => open('task', id)} onAddTask={() => setNewTask({})} />}
      {view === 'board' && <Board projectId={p.id} statuses={statuses} stages={stages} archived={archived} canCreate={canCreate && !archived} onOpenTask={(id) => open('task', id)} onAddTask={(statusId) => setNewTask({ statusId })} />}
      {view === 'timeline' && <PlanPanel projectId={p.id} method={p.deliveryMethod ?? 'Hybrid'} stages={stages} canEdit={canEdit && !archived} canPlan={canPlan && !archived} onOpenTask={(id) => open('task', id)} />}
      {view === 'issues' && <IssuesPanel projectId={p.id} stages={stages} canReport={canReport && !archived} stageFilter={stage} onStageFilter={setStage} onOpen={(id) => open('issue', id)} onReport={(stageId) => setReporting({ stageId })} />}
      {view === 'actions' && <ActionItemsTab projectId={p.id} highlightId={params.get('action')} />}
      {newTask && <TaskModal projectId={p.id} statusId={newTask.statusId} onClose={() => setNewTask(null)} />}
      {reporting && <ReportIssueModal projectId={p.id} stages={stages} members={members} defaultStageId={reporting.stageId} onClose={() => setReporting(null)} onCreated={(id) => { setReporting(null); open('issue', id); }} />}
    </div>
  );
}
