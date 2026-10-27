import { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { projectApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { ErrorState, PageLoader, Segmented } from '../../components/ui';
import { openNew } from '../../components/v2/state';
import { useWsQuery } from '../../lib/hooks';
import { useCan, useModule } from '../../stores/auth';
import { Board } from '../projects/Board';
import { Timeline } from '../projects/Timeline';
import { PlanPanel } from '../planning/PlanPanel';
import { WorkItemPanel } from './WorkItemPanel';
import { WorkList } from './WorkList';
import { panelHosts, useWorkKinds } from './workUi';
import './work.css';

type Show = 'list' | 'board' | 'timeline';
const SHOWS: { id: Show; label: string; icon: 'list' | 'kanban' | 'calendar' }[] = [
  { id: 'list', label: 'List', icon: 'list' }, { id: 'board', label: 'Board', icon: 'kanban' }, { id: 'timeline', label: 'Timeline', icon: 'calendar' },
];

/**
 * A project's Work tab (V2-SPEC §3.5): the project's tasks, issues, action items and related tickets as one list, with a List / Board /
 * Timeline switch. List is the Work list narrowed to the project; Board is the project's board; Timeline is its stages and its plan
 * (milestones or sprints). Every item opens in the same side panel as on Work, kept in the address (?item=), and the switch too (?show=).
 */
export function ProjectWorkTab({ projectId }: { projectId: string }) {
  const [params, setParams] = useSearchParams();
  const asked = params.get('show') as Show | null;
  const show: Show = asked && SHOWS.some((s) => s.id === asked) ? asked : 'list';
  const item = params.get('item');
  const kinds = useWorkKinds();
  const canCreateTasks = useCan('tasks.create'), seeTasks = useModule('tasks') > 0;
  const canCreate = canCreateTasks && seeTasks;
  const canEditProjects = useCan('projects.edit');
  const canPlan = useCan('tasks.edit');
  const canReport = useCan('tasks.comment');
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
  const method = p?.deliveryMethod ?? 'Hybrid';
  const add = () => openNew('task', '', { projectId });

  return (
    <div className="wk-project">
      <div className="wk-project-bar">
        <Segmented label="Show work as" value={show} onChange={(s) => set({ show: s === 'list' ? null : s })} options={SHOWS.map((s) => ({ id: s.id, label: s.label, icon: s.icon }))} />
      </div>
      {show === 'list' && (
        <WorkList viewKey={`project:${projectId}`} filters={{ projectId }} kinds={kinds} selectedId={item} onOpen={open} defaults={{ group: 'status', sort: 'priority' }}
          empty={{ title: 'No open work on this project', text: 'Tasks, issues, action items and tickets about this project show up here.', action: canCreate && !archived ? <button type="button" className="btn btn-primary" onClick={add}><Icon name="plus" size={15} /> Add work</button> : undefined }} />
      )}
      {show !== 'list' && (q.isLoading ? <PageLoader /> : q.isError || !detail || !p ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : show === 'board' ? (
        <section className="wk-card wk-board" aria-label="Board">
          <Board projectId={projectId} statuses={detail.statuses} stages={detail.stages} archived={archived} canCreate={canCreate && !archived} onOpenTask={open} onAddTask={add} />
        </section>
      ) : (
        <div className="wk-timeline">
          {method !== 'Agile' && (
            <Timeline projectId={projectId} projectName={p.name} project={p} stages={detail.stages} canEdit={canEditProjects && !archived} canReportIssue={canReport && !archived}
              taskProgress={p.progress} finished={finished} onShowIssues={() => set({ show: null })} onReportIssue={() => openNew('task', '', { projectId, kind: 'issue' })} />
          )}
          <PlanPanel projectId={projectId} method={method} stages={detail.stages} canEdit={canEditProjects && !archived} canPlan={canPlan && !archived} onOpenTask={open} />
        </div>
      ))}
      {item && <WorkItemPanel id={item} onClose={close} />}
    </div>
  );
}
