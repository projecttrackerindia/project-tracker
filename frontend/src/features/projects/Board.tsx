import { useMemo, useState } from 'react';
import { taskApi } from '../../api/endpoints';
import type { Paged, Priority, Stage, Task, WorkflowStatus } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Avatar, EmptyState, LabelChip, PageLoader, PriorityBadge, ErrorState, PriorityOptions } from '../../components/ui';
import { } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { queryClient, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { DueMeta, TaskTable } from '../tasks/parts';
import { reportTaskError, toggleTaskComplete } from '../tasks/actions';
import { Select } from '../../components/Select';

/** Shared, filterable task query for a project (board + list use the same cache entry). */
export function useProjectTasks(projectId: string) {
  return useWsQuery(['project', projectId, 'tasks'], () => taskApi.listForProject(projectId, { sort: 'position' }));
}

function useTaskFilters(tasks: Task[], stages: Stage[] = []) {
  const [q, setQ] = useState('');
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState('');
  const [stage, setStage] = useState('');
  const filtered = useMemo(() => tasks.filter((t) =>
    (!q || t.title.toLowerCase().includes(q.toLowerCase()) || t.key.toLowerCase().includes(q.toLowerCase()))
    && (!assignee || (assignee === 'none' ? !t.assignee : t.assignee?.id === assignee))
    && (!priority || t.priority === (priority as Priority))
    && (!stage || (stage === 'none' ? !t.stageId : t.stageId === stage))), [tasks, q, assignee, priority, stage]);
  const assignees = useMemo(() => {
    const map = new Map<string, string>();
    tasks.forEach((t) => t.assignee && map.set(t.assignee.id, t.assignee.name));
    return [...map.entries()];
  }, [tasks]);
  const active = !!(q || assignee || priority || stage);
  const bar = (
    <div className="toolbar" style={{ border: 0, padding: '0 0 14px' }}>
      <div className="search-field"><Icon name="search" /><input className="input" placeholder="Filter tasks…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter tasks" /></div>
      <Select className="select filter-input" value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assignee">
        <option value="">Everyone</option><option value="none">Unassigned</option>{assignees.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </Select>
      <Select className="select filter-input" value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority">
        <option value="">All priorities</option><PriorityOptions />
      </Select>
      {stages.length > 0 && (
        <Select className="select filter-input" value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Phase">
          <option value="">All phases</option>{stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}<option value="none">No phase</option>
        </Select>
      )}
      {active && <button className="btn btn-ghost btn-sm" onClick={() => { setQ(''); setAssignee(''); setPriority(''); setStage(''); }}><Icon name="close" /> Clear</button>}
    </div>
  );
  return { filtered, bar };
}

// ------------------------------------------------------------------ Kanban
export function Board({ projectId, statuses, stages, archived, canCreate, onOpenTask, onAddTask }: {
  projectId: string; statuses: WorkflowStatus[]; stages: Stage[]; archived?: boolean; canCreate: boolean; onOpenTask: (id: string) => void; onAddTask: (statusId: string) => void;
}) {
  const wid = useWorkspaceId();
  const q = useProjectTasks(projectId);
  const { filtered, bar } = useTaskFilters(q.data?.items ?? [], stages);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [overCard, setOverCard] = useState<string | null>(null);
  const cacheKey = [wid, 'project', projectId, 'tasks'];

  const columns = useMemo(() => [...statuses].sort((a, b) => a.order - b.order).map((s) => ({
    status: s, tasks: filtered.filter((t) => t.statusId === s.id).sort((a, b) => a.position - b.position),
  })), [statuses, filtered]);

  const drop = async (statusId: string, beforeId?: string) => {
    const task = q.data?.items.find((t) => t.id === dragId);
    setDragId(null); setOverCol(null); setOverCard(null);
    if (!task) return;
    const col = (q.data?.items ?? []).filter((t) => t.statusId === statusId && t.id !== task.id).sort((a, b) => a.position - b.position);
    let position: number;
    if (beforeId) {
      const idx = col.findIndex((t) => t.id === beforeId);
      const next = col[idx]; const prev = col[idx - 1];
      position = !next ? (col.at(-1)?.position ?? 0) + 1024 : prev ? (prev.position + next.position) / 2 : next.position - 512;
    } else position = (col.at(-1)?.position ?? 0) + 1024;
    if (task.statusId === statusId && task.position === position) return;

    // optimistic update, roll back on failure
    const previous = queryClient.getQueryData<Paged<Task>>(cacheKey);
    const target = statuses.find((s) => s.id === statusId)!;
    queryClient.setQueryData<Paged<Task>>(cacheKey, (old) => old && ({
      ...old, items: old.items.map((t) => t.id === task.id ? { ...t, statusId, statusName: target.name, statusCategory: target.category, statusColor: target.color, position } : t),
    }));
    try {
      await taskApi.move(task.id, { statusId, position });
      if (task.statusId !== statusId) toast(`Moved to “${target.name}”.`);
      invalidateWorkspace(wid);
    } catch (e) {
      queryClient.setQueryData(cacheKey, previous);
      reportTaskError(e, 'Could not move the task.');
    }
  };

  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;

  return (
    <>
      {bar}
      <div className="kanban" role="list">
        {columns.map(({ status, tasks }) => (
          <div key={status.id} role="listitem" className={`kb-col ${overCol === status.id ? 'drag-over' : ''}`}>
            <div className="kb-head">
              <div className="kb-head-left"><span className="kb-dot" style={{ background: status.color, color: status.color }} /><span className="kb-title">{status.name}</span></div>
              <span className="kb-count">{tasks.length}</span>
            </div>
            <div className="kb-body"
              onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverCol(status.id); } }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverCol(null); }}
              onDrop={(e) => { e.preventDefault(); drop(status.id, overCard ?? undefined); }}>
              {tasks.length === 0 && <div className="kb-empty">{canCreate ? 'Drop tasks here' : 'No tasks'}</div>}
              {tasks.map((t) => (
                <div key={t.id} className={`kb-card ${dragId === t.id ? 'dragging' : ''} ${overCard === t.id && dragId !== t.id ? 'drop-before' : ''}`}
                  draggable={t.canEdit && !archived} tabIndex={0} role="button"
                  onDragStart={(e) => { setDragId(t.id); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', t.id); } catch { /* ignore */ } }}
                  onDragEnd={() => { setDragId(null); setOverCol(null); setOverCard(null); }}
                  onDragOver={(e) => { if (dragId && dragId !== t.id) { e.preventDefault(); e.stopPropagation(); setOverCol(status.id); setOverCard(t.id); } }}
                  onClick={() => onOpenTask(t.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpenTask(t.id); }}>
                  <div className="task-key">{t.key}</div>
                  <div className="kb-card-title">{t.title}</div>
                  {t.stageName && <div className="kb-phase" title="Timeline phase"><Icon name="flag" size={11} />{t.stageName}</div>}
                  {t.labels.length > 0 && <div className="task-meta" style={{ marginBottom: 7 }}>{t.labels.map((l) => <LabelChip key={l.id} name={l.name} color={l.color} />)}</div>}
                  <div className="kb-card-meta">
                    <PriorityBadge priority={t.priority} />
                    <div className="row" style={{ gap: 7 }}>
                      {t.isBlocked && <span className="meta-line blocked-flag" title="Waiting on another task"><Icon name="lock" /></span>}
                      {t.dependsOnCount + t.blocksCount > 0 && !t.isBlocked && <span className="meta-line" title="Linked to other tasks"><Icon name="git" /> {t.dependsOnCount + t.blocksCount}</span>}
                      {t.subtaskTotal > 0 && <span className="meta-line"><Icon name="list" /> {t.subtaskDone}/{t.subtaskTotal}</span>}
                      {t.checklistTotal > 0 && <span className="meta-line" title="Checklist"><Icon name="check" /> {t.checklistDone}/{t.checklistTotal}</span>}
                      {t.milestoneName && <span className="meta-line" title={`Milestone: ${t.milestoneName}`}><Icon name="flag" /></span>}
                      {t.assignee && <Avatar name={t.assignee.name} size="sm" userId={t.assignee.id} />}
                    </div>
                  </div>
                  <div className="kb-card-meta" style={{ marginTop: 8 }}><DueMeta task={t} /></div>
                </div>
              ))}
            </div>
            {canCreate && <button className="btn btn-ghost btn-sm kb-add" onClick={() => onAddTask(status.id)}><Icon name="plus" /> Add task</button>}
          </div>
        ))}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ List
export function ListView({ projectId, stages, archived, onOpenTask, onAddTask, canCreate }: {
  projectId: string; stages: Stage[]; archived?: boolean; canCreate: boolean; onOpenTask: (id: string) => void; onAddTask: () => void;
}) {
  const q = useProjectTasks(projectId);
  const { filtered, bar } = useTaskFilters(q.data?.items ?? [], stages);
  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  return (
    <>
      {bar}
      {filtered.length === 0
        ? <EmptyState icon="check" title="No tasks yet" text="Add the first task for this project." action={canCreate ? <button className="btn btn-primary" onClick={onAddTask}><Icon name="plus" /> Add task</button> : undefined} />
        : <div className="card"><TaskTable tasks={filtered} showProject={false} showPhase archived={archived} onOpen={(t) => onOpenTask(t.id)} onToggle={toggleTaskComplete} /></div>}
    </>
  );
}
