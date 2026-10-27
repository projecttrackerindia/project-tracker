import { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { projectApi } from '../../api/endpoints';
import type { WorkKind } from '../../api/workItemsApi';
import { Icon } from '../../components/Icon';
import { ErrorState, PageLoader, Segmented } from '../../components/ui';
import { openNew } from '../../components/v2/state';
import { useWsQuery } from '../../lib/hooks';
import { useAuth, useCan, useModule } from '../../stores/auth';
import { Board } from '../projects/Board';
import { Timeline } from '../projects/Timeline';
import { PlanPanel } from '../planning/PlanPanel';
import { QuickAdd } from '../tasks/QuickAdd';
import { WorkItemPanel } from './WorkItemPanel';
import { WorkList } from './WorkList';
import { KINDS, panelHosts, useWorkKinds } from './workUi';
import './work.css';

type View = 'list' | 'board' | 'timeline';
const VIEWS: { id: View; label: string; icon: 'list' | 'kanban' | 'calendar' }[] = [
  { id: 'list', label: 'List', icon: 'list' }, { id: 'board', label: 'Board', icon: 'kanban' }, { id: 'timeline', label: 'Timeline', icon: 'calendar' },
];
/** Older names for a view (the project's former Plan, Sprints and Milestones tabs are its Timeline now). */
const VIEW_ALIAS: Record<string, View> = { plan: 'timeline', sprints: 'timeline', milestones: 'timeline', stages: 'timeline', kanban: 'board' };

/**
 * A project's Work tab (V2-SPEC §3.5): the project's tasks, issues, action items and related tickets as one list, with a List / Board /
 * Timeline switch. List is the Work list narrowed to the project (?kind= picks a kind: the old Issues and Action items tabs); Board is the
 * project's board; Timeline is its stages and its plan (milestones or sprints). Quick add sits over List and Board as before. Every item
 * opens in the same side panel as on Work, kept in the address (?item=), and the switch too (?view=).
 */
export function ProjectWorkTab({ projectId }: { projectId: string }) {
  const [params, setParams] = useSearchParams();
  const asked = params.get('view') ?? '';
  const view: View = VIEWS.some((v) => v.id === asked) ? (asked as View) : VIEW_ALIAS[asked] ?? 'list';
  const askedKind = params.get('kind') as WorkKind | null;
  const kind = askedKind && KINDS.includes(askedKind) ? askedKind : null;
  const item = params.get('item');
  const kinds = useWorkKinds();
  const canCreateTasks = useCan('tasks.create'), seeTasks = useModule('tasks') > 0;
  const canCreate = canCreateTasks && seeTasks;
  const canEditPerm = useCan('projects.edit');
  const canPlan = useCan('tasks.edit');
  const canReport = useCan('tasks.comment');
  const me = useAuth((s) => s.ctx?.user.id);
  useEffect(() => { const k = `project:${projectId}`; panelHosts.add(k); return () => { panelHosts.delete(k); }; }, [projectId]);
  const q = useWsQuery(['project', projectId], () => projectApi.get(projectId), { staleTime: 30_000 });

  const set = (next: Record<string, string | null>) => setParams((p) => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(next)) { if (v === null) n.delete(k); else n.set(k, v); }
    return n;
  }, { replace: true });
  const open = useCallback((id: string) => set({ item: id, full: null }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const close = useCallback(() => set({ item: null, full: null }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const detail = q.data;
  const p = detail?.project;
  const archived = p?.status === 'Archived';
  const finished = p ? ['Completed', 'Cancelled', 'Archived'].includes(p.status) : false;
  const canEdit = canEditPerm || (!!p && p.owner?.id === me);
  const method = p?.deliveryMethod ?? 'Hybrid';
  const here = (k?: 'task' | 'issue' | 'action') => ({ id: projectId, name: p?.name ?? 'this project', kind: k });
  const add = () => openNew('task', '', here(kind === 'issue' || kind === 'action' ? kind : 'task'));

  return (
    <div className="wk-project" data-testid="project-work">
      <div className="wk-project-bar">
        <Segmented label="Show work as" value={view} onChange={(v) => set({ view: v === 'list' ? null : v })} options={VIEWS.map((v) => ({ id: v.id, label: v.label, icon: v.icon }))} />
      </div>
      {(view === 'list' || view === 'board') && canCreate && !archived && <div className="wk-quick"><QuickAdd projectId={projectId} /></div>}
      {view === 'list' && (
        <WorkList viewKey={`project:${projectId}`} filters={{ projectId }} kinds={kinds} selectedId={item} onOpen={open} defaults={{ group: 'status', sort: 'priority' }}
          kind={kind} onKind={(k) => set({ kind: k })}
          empty={{ title: kind ? `No open ${kind === 'action' ? 'action items' : `${kind}s`} on this project` : 'No open work on this project', text: 'Tasks, issues, action items and tickets about this project show up here.',
            action: canCreate && !archived ? <button type="button" className="btn btn-primary" onClick={add}><Icon name="plus" size={15} /> Add work</button> : undefined }} />
      )}
      {view !== 'list' && (q.isLoading ? <PageLoader /> : q.isError || !detail || !p ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : view === 'board' ? (
        <section className="wk-card wk-board" aria-label="Board">
          <Board projectId={projectId} statuses={detail.statuses} stages={detail.stages} archived={archived} canCreate={canCreate && !archived} onOpenTask={open} onAddTask={() => openNew('task', '', here('task'))} />
        </section>
      ) : (
        <div className="wk-timeline">
          {method !== 'Agile' && (
            <Timeline projectId={projectId} projectName={p.name} project={p} stages={detail.stages} canEdit={canEdit && !archived} canReportIssue={canReport && !archived}
              taskProgress={p.progress} finished={finished} onShowIssues={() => set({ view: null, kind: 'issue' })} onReportIssue={() => openNew('task', '', here('issue'))} />
          )}
          <PlanPanel projectId={projectId} method={method} stages={detail.stages} canEdit={canEdit && !archived} canPlan={canPlan && !archived} onOpenTask={open} />
        </div>
      ))}
      {item && <WorkItemPanel id={item} onClose={close} />}
    </div>
  );
}
