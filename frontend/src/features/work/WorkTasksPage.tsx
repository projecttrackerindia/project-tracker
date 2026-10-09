import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { projectApi, workApi, workspaceApi, type WorkFilters } from '../../api/endpoints';
import type { WorkTask } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Avatar, EmptyState, ErrorState, PageHead, PageLoader, Pager, PriorityBadge, PriorityOptions } from '../../components/ui';
import { formatDate } from '../../lib/format';
import { useDebounced, useWsQuery } from '../../lib/hooks';
import { WORK_STATUSES } from '../../lib/workLabels';
import { useCan, useModule } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { WorkTaskModal } from './WorkTaskModal';
import { SlaChip } from './Sla';

const NO_PROJECT = '__none';
type View = 'all' | 'open' | 'closed';

export function WorkStatusBadge({ status }: { status: WorkTask['status'] }) {
  const s = WORK_STATUSES.find((x) => x.id === status);
  return <span className={`badge ${s?.badge ?? 'badge-neutral'}`}><span className="dot" />{s?.label ?? status}</span>;
}

/**
 * Operations: operational work (bug fixes, support, analysis, data preparation ...) that is not a project task, everyone's. Search, filter,
 * sort and page; create and edit in a dialog. What is assigned to me, of every kind, is on My work.
 */
export function WorkTasksPage() {
  const mine = false;
  const [params, setParams] = useSearchParams();
  const permWork = useCan('work.create'), modWork = useModule('work');
  const canCreate = permWork && modWork >= 2;
  const permReports = useCan('reports.view'), modReports = useModule('reports');
  const canReports = permReports && modReports > 0;
  const [q, setQ] = useState('');
  const [typeId, setTypeId] = useState(params.get('type') ?? '');
  const [projectId, setProjectId] = useState(params.get('project') ?? '');
  const [assigneeId, setAssigneeId] = useState('');
  const [priority, setPriority] = useState('');
  const [status, setStatus] = useState('');
  const [view, setView] = useState<View>(mine || params.get('open') === '1' ? 'open' : 'all');
  const [dueFrom, setDueFrom] = useState('');
  const [dueTo, setDueTo] = useState('');
  const [overdue, setOverdue] = useState(params.get('overdue') === '1');
  const [sla, setSla] = useState(params.get('sla') ?? '');
  const [sort, setSort] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);

  const filters: WorkFilters = {
    q: dq || undefined, workTypeId: typeId || undefined, relatedProjectId: projectId && projectId !== NO_PROJECT ? projectId : undefined, noProject: projectId === NO_PROJECT || undefined,
    assigneeId: !mine ? assigneeId || undefined : undefined, mine: mine || undefined, priority: priority || undefined, status: status || undefined,
    open: !status && view !== 'all' ? view === 'open' : undefined, dueFrom: dueFrom || undefined, dueTo: dueTo || undefined, overdue: overdue || undefined, sort: sort || undefined, page,
    sla: sla || undefined,
  };
  const list = useWsQuery(['work', 'list', filters], () => workApi.list(filters));
  const types = useWsQuery(['work', 'types', 'all'], () => workApi.types(true));
  const projects = useWsQuery(['projects', 'work-picker'], () => projectApi.list({ pageSize: 200, includeArchived: true, sort: 'name' }));
  const members = useWsQuery(['members'], () => workspaceApi.members(), { enabled: !mine });

  const openId = params.get('task');
  const [creating, setCreating] = useState(false);
  // "?new=1" (from the command palette) opens the new work task form, then leaves the address clean.
  useEffect(() => {
    if (params.get('new') !== '1') return;
    setCreating(true);
    const n = new URLSearchParams(params); n.delete('new'); setParams(n, { replace: true });
  }, [params, setParams]);
  const openTask = (id: string | null) => { const n = new URLSearchParams(params); if (id) n.set('task', id); else n.delete('task'); setParams(n, { replace: true }); };

  const on = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  const hasFilters = !!(q || typeId || projectId || assigneeId || priority || status || dueFrom || dueTo || overdue || sla || (view !== (mine ? 'open' : 'all')));
  const reset = () => { setQ(''); setTypeId(''); setProjectId(''); setAssigneeId(''); setPriority(''); setStatus(''); setDueFrom(''); setDueTo(''); setOverdue(false); setSla(''); setView(mine ? 'open' : 'all'); setPage(1); };
  const sortBy = (key: string) => { setSort((s) => (s === key ? `-${key}` : key)); setPage(1); };
  const th = (key: string, label: string) => (
    <th aria-sort={sort === key ? 'ascending' : sort === `-${key}` ? 'descending' : 'none'}>
      <button type="button" className="th-sort" onClick={() => sortBy(key)}>{label}{sort === key ? ' ↑' : sort === `-${key}` ? ' ↓' : ''}</button>
    </th>
  );
  const exportCsv = () => void workApi.exportCsv(filters).catch((e) => toast(e instanceof ApiError ? e.message : 'Could not export the list.', 'error'));

  const items = list.data?.items ?? [];
  return (
    <>
      <PageHead title="Operations" sub="Operational work that is not a project task: bug fixes, support, analysis, data preparation and more.">
        <Link className="btn btn-ghost" to="/reports/operations" title="Charts of open, late and finished operational work"><Icon name="chart" /> Analytics</Link>
        <button type="button" className="btn btn-ghost" onClick={exportCsv} title="Download the filtered list as a CSV file now"><Icon name="download" /> Export CSV</button>
        {canReports && <Link className="btn btn-ghost" to="/reports?kind=WorkTasks" title="Excel or PDF, built in the background"><Icon name="download" /> Excel / PDF</Link>}
        {canCreate && <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" /> New work task</button>}
      </PageHead>

      <div className="card">
        <div className="toolbar">
          <div className="search-field"><Icon name="search" /><input className="input" placeholder="Search work tasks…" value={q} onChange={(e) => on(setQ)(e.target.value)} aria-label="Search work tasks" /></div>
          <Select className="select filter-input" value={typeId} onChange={(e) => on(setTypeId)(e.target.value)} aria-label="Work type">
            <option value="">All work types</option>{types.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <Select className="select filter-input" value={projectId} onChange={(e) => on(setProjectId)(e.target.value)} aria-label="Related project">
            <option value="">All projects</option><option value={NO_PROJECT}>No related project</option>
            {projects.data?.items.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
          </Select>
          {!mine && (
            <Select className="select filter-input" value={assigneeId} onChange={(e) => on(setAssigneeId)(e.target.value)} aria-label="Assigned to">
              <option value="">Anyone</option>{members.data?.filter((m) => m.role !== 'Guest').map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
            </Select>
          )}
          <Select className="select filter-input" value={priority} onChange={(e) => on(setPriority)(e.target.value)} aria-label="Priority"><option value="">All priorities</option><PriorityOptions /></Select>
          <Select className="select filter-input" value={status} onChange={(e) => on(setStatus)(e.target.value)} aria-label="Status">
            <option value="">Any status</option>{WORK_STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </Select>
        </div>
        <div className="toolbar" style={{ paddingTop: 0 }}>
          <div className="seg" role="group" aria-label="Show work tasks">
            {([['all', 'All'], ['open', 'Open'], ['closed', 'Closed']] as const).map(([id, label]) => (
              <button key={id} type="button" className={view === id ? 'active' : ''} aria-pressed={view === id} onClick={() => on(setView)(id)} disabled={!!status}>{label}</button>
            ))}
          </div>
          <label className="row" style={{ gap: 6, fontSize: 12.5 }}>Due from <input className="input filter-input" type="date" value={dueFrom} onChange={(e) => on(setDueFrom)(e.target.value)} aria-label="Due from" /></label>
          <label className="row" style={{ gap: 6, fontSize: 12.5 }}>to <input className="input filter-input" type="date" value={dueTo} onChange={(e) => on(setDueTo)(e.target.value)} aria-label="Due to" /></label>
          <button type="button" className={`btn btn-sm ${overdue ? 'btn-soft' : 'btn-ghost'}`} aria-pressed={overdue} onClick={() => on(setOverdue)(!overdue)}><Icon name="alert" /> Overdue only</button>
          <Select className="select filter-input" value={sla} onChange={(e) => on(setSla)(e.target.value)} aria-label="Service level">
            <option value="">Any SLA</option><option value="atRisk">SLA at risk</option><option value="breached">SLA breached</option><option value="tracked">With SLA targets</option>
          </Select>
          {hasFilters && <button type="button" className="btn btn-ghost btn-sm" onClick={reset}>Clear filters</button>}
        </div>

        {list.isLoading ? <PageLoader /> : list.isError ? <ErrorState error={list.error} retry={() => void list.refetch()} /> : items.length === 0 ? (
          <EmptyState icon="bolt" title={hasFilters ? 'No work tasks match these filters' : mine ? 'Nothing is assigned to you' : 'No work tasks yet'}
            text={hasFilters ? undefined : 'Work tasks are for bug fixes, support, analysis and other operational work that does not need a project.'}
            action={hasFilters ? <button type="button" className="btn btn-ghost" onClick={reset}>Clear filters</button> : canCreate ? <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" /> New work task</button> : undefined} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="work-table">
                <thead><tr>{th('title', 'Work task')}{th('type', 'Work type')}{th('project', 'Related project')}{th('assignee', 'Assigned to')}{th('priority', 'Priority')}{th('due', 'Due date')}{th('sla', 'SLA')}{th('status', 'Status')}</tr></thead>
                <tbody>
                  {items.map((t) => (
                    <tr key={t.id} className="clickable" tabIndex={0} onClick={() => openTask(t.id)} onKeyDown={(e) => { if (e.key === 'Enter') openTask(t.id); }} aria-label={`Open ${t.key} ${t.title}`}>
                      <td><div className="td-title"><span className="task-key">{t.key}</span> {t.title}</div>{(t.commentCount > 0 || t.attachmentCount > 0) && <div className="td-sub">{t.commentCount > 0 ? `${t.commentCount} comment${t.commentCount === 1 ? '' : 's'}` : ''}{t.commentCount > 0 && t.attachmentCount > 0 ? ' · ' : ''}{t.attachmentCount > 0 ? `${t.attachmentCount} file${t.attachmentCount === 1 ? '' : 's'}` : ''}</div>}</td>
                      <td className="cell-muted">{t.workType}</td>
                      <td className="cell-muted">{t.relatedProject ? <span title={`${t.relatedProject.name} (${t.relatedProject.status})`}>{t.relatedProject.name}</span> : '—'}</td>
                      <td>{t.assignee ? <span className="row" style={{ gap: 6 }}><Avatar name={t.assignee.name} size="sm" userId={t.assignee.id} />{t.assignee.name}</span> : <span className="muted">Unassigned</span>}</td>
                      <td><PriorityBadge priority={t.priority} /></td>
                      <td className={t.isOverdue ? 'work-late' : 'cell-muted'}>{t.dueDate ? formatDate(t.dueDate) : '—'}{t.isOverdue ? ' · overdue' : ''}</td>
                      <td><SlaChip sla={t.sla} /></td>
                      <td><WorkStatusBadge status={t.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={list.data!.page} totalPages={list.data!.totalPages} totalItems={list.data!.totalItems} onPage={setPage} />
          </>
        )}
      </div>

      {creating && <WorkTaskModal defaults={{ relatedProjectId: projectId && projectId !== NO_PROJECT ? projectId : undefined }} onClose={() => setCreating(false)} />}
      {openId && <WorkTaskModal taskId={openId} onClose={() => openTask(null)} />}
    </>
  );
}
