import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { projectApi, workItemApi } from '../../api/endpoints';
import type { WorkItem, WorkItemKind } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { EmptyState, ErrorState, PageHead, PageLoader, StatCard } from '../../components/ui';
import { todayISO, dateOffset } from '../../lib/format';
import { useDebounced, useWsQuery } from '../../lib/hooks';
import { useAuth, useCan, useModule } from '../../stores/auth';
import { TaskModal } from '../tasks/TaskModal';
import { WorkTaskModal } from '../work/WorkTaskModal';
import { KIND_META, WorkItemRow, useVisibleKinds, workItemLink, type WorkRowItem } from './workItems';
import { saveOfflineSnapshot } from '../offline/storage';

type View = 'open' | 'all';

/** Which part of the open list an item falls in: late first, then today, this week, later, and undated last. */
function bucketOf(w: WorkItem, today: string, weekEnd: string): string {
  if (w.isOverdue) return 'Overdue';
  if (!w.dueDate) return 'No due date';
  if (w.dueDate === today) return 'Due today';
  if (w.dueDate <= weekEnd) return 'Next 7 days';
  return 'Later';
}
const BUCKETS = ['Overdue', 'Due today', 'Next 7 days', 'Later', 'No due date'];

/**
 * My work: everything assigned to me in one list, whatever kind it is (project tasks, test issues, action items, operational work),
 * grouped by when it is due. Project tasks and operational work open in place; issues and action items open on their project.
 */
export function MyWorkPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const visible = useVisibleKinds();
  const kindParam = params.get('kind') as WorkItemKind | null;
  const [kinds, setKinds] = useState<WorkItemKind[]>(kindParam && visible.includes(kindParam) ? [kindParam] : []);
  const [view, setView] = useState<View>('open');
  const [overdue, setOverdue] = useState(params.get('overdue') === '1');
  const [projectId, setProjectId] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const permWork = useCan('work.create'), modWork = useModule('work');
  const canCreateWork = permWork && modWork >= 2;
  const [creating, setCreating] = useState(false);

  const list = useWsQuery(['my-work', view, overdue, projectId, dq], () => workItemApi.mine({ open: view === 'open', overdue: overdue || undefined, projectId: projectId || undefined, q: dq || undefined }));
  // The unfiltered open list is kept on this device for the installed app's offline view.
  const who = useAuth((s) => s.ctx);
  useEffect(() => {
    if (list.data && view === 'open' && !overdue && !projectId && !dq && who?.current) saveOfflineSnapshot(list.data, who.user.displayName, who.current.name);
  }, [list.data, view, overdue, projectId, dq, who]);
  const projects = useWsQuery(['projects', 'work-picker'], () => projectApi.list({ pageSize: 200, includeArchived: true, sort: 'name' }), { enabled: visible.some((k) => k !== 'Operational') });

  const all = useMemo(() => list.data ?? [], [list.data]);
  const counts = useMemo(() => Object.fromEntries(visible.map((k) => [k, all.filter((w) => w.kind === k).length])) as Record<WorkItemKind, number>, [all, visible]);
  const items = kinds.length ? all.filter((w) => kinds.includes(w.kind)) : all;
  const today = todayISO();
  const weekEnd = dateOffset(7, new Date(today + 'T00:00:00'));
  const groups = useMemo(() => {
    if (view !== 'open') return [{ title: '', items }];
    const by = new Map<string, WorkItem[]>();
    for (const w of items) { const b = bucketOf(w, today, weekEnd); by.set(b, [...(by.get(b) ?? []), w]); }
    return BUCKETS.filter((b) => by.has(b)).map((b) => ({ title: b, items: by.get(b)! }));
  }, [items, view, today, weekEnd]);

  const openTasks = all.filter((w) => w.category !== 'Done' && w.category !== 'Cancelled');
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [openWork, setOpenWork] = useState<string | null>(null);
  const open = (i: WorkRowItem) => {
    if (i.kind === 'Task') setOpenTask(i.id);
    else if (i.kind === 'Operational') setOpenWork(i.id);
    else nav(workItemLink(i));
  };
  const toggleKind = (k: WorkItemKind) => {
    setKinds((x) => (x.includes(k) ? x.filter((y) => y !== k) : [...x, k]));
    if (params.has('kind')) { const n = new URLSearchParams(params); n.delete('kind'); setParams(n, { replace: true }); }
  };
  const filtered = kinds.length > 0 || overdue || !!projectId || !!dq || view !== 'open';
  const reset = () => { setKinds([]); setOverdue(false); setProjectId(''); setQ(''); setView('open'); };

  return (
    <>
      <PageHead title="My work" sub="Everything assigned to you, whatever kind of work it is, in the order it is due.">
        {canCreateWork && <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" /> New work task</button>}
      </PageHead>

      {view === 'open' && !list.isLoading && (
        <div className="stat-grid">
          <StatCard icon="inbox" tone="blue" value={openTasks.length} label="Open" foot="Assigned to you" />
          <StatCard icon="alert" tone="red" value={openTasks.filter((w) => w.isOverdue).length} label="Overdue" foot="Past the due date" />
          <StatCard icon="calendar" tone="amber" value={openTasks.filter((w) => w.dueDate === today).length} label="Due today" />
          <StatCard icon="clock" tone="purple" value={openTasks.filter((w) => w.dueDate && w.dueDate > today && w.dueDate <= weekEnd).length} label="Next 7 days" />
        </div>
      )}

      <div className="card">
        <div className="toolbar" style={{ flexWrap: 'wrap' }}>
          <div className="kind-chips" role="group" aria-label="Kinds of work">
            {visible.map((k) => (
              <button key={k} type="button" className={`kind-chip ${kinds.includes(k) ? 'on' : ''}`} aria-pressed={kinds.includes(k)} onClick={() => toggleKind(k)} title={KIND_META[k].hint}>
                <Icon name={KIND_META[k].icon} />{KIND_META[k].plural}<b>{counts[k] ?? 0}</b>
              </button>
            ))}
          </div>
          <div className="toolbar-spacer" />
          <div className="seg" role="group" aria-label="Show">
            {([['open', 'Open'], ['all', 'All, including done']] as const).map(([id, label]) => (
              <button key={id} type="button" className={view === id ? 'active' : ''} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="toolbar" style={{ paddingTop: 0, flexWrap: 'wrap' }}>
          <div className="search-field"><Icon name="search" /><input className="input" placeholder="Search by title or key…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search my work" /></div>
          {(projects.data?.items.length ?? 0) > 0 && (
            <Select className="select filter-input" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
              <option value="">All projects</option>{projects.data!.items.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
            </Select>
          )}
          <button type="button" className={`btn btn-sm ${overdue ? 'btn-soft' : 'btn-ghost'}`} aria-pressed={overdue} onClick={() => setOverdue((v) => !v)}><Icon name="alert" /> Overdue only</button>
          {filtered && <button type="button" className="btn btn-ghost btn-sm" onClick={reset}>Clear filters</button>}
        </div>

        {list.isLoading ? <PageLoader /> : list.isError ? <ErrorState error={list.error} retry={() => void list.refetch()} /> : items.length === 0 ? (
          <div className="card-body">
            <EmptyState icon="checkCircle" title={filtered ? 'Nothing matches these filters' : 'Nothing is assigned to you'}
              text={filtered ? undefined : 'When someone assigns you a task, a test issue, an action item or operational work, it shows up here.'}
              action={filtered ? <button type="button" className="btn btn-ghost" onClick={reset}>Clear filters</button> : undefined} />
          </div>
        ) : (
          <div className="wi-list">
            {groups.map((g) => (
              <div key={g.title || 'all'}>
                {g.title && <div className={`wi-group-title ${g.title === 'Overdue' ? 'late' : ''}`}><span>{g.title}</span><span>{g.items.length}</span></div>}
                {g.items.map((w) => <WorkItemRow key={`${w.kind}:${w.id}`} item={w} onOpen={open} />)}
              </div>
            ))}
          </div>
        )}
      </div>
      {all.length >= 200 && <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>Showing the first 200 items. Narrow the list with the filters to see the rest.</p>}

      {openTask && <TaskModal taskId={openTask} onClose={() => { setOpenTask(null); void list.refetch(); }} />}
      {openWork && <WorkTaskModal taskId={openWork} onClose={() => { setOpenWork(null); void list.refetch(); }} />}
      {creating && <WorkTaskModal onClose={() => { setCreating(false); void list.refetch(); }} />}
    </>
  );
}
