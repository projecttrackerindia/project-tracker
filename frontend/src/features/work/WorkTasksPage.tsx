import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { opsApi, projectApi, workApi, workspaceApi, type WorkFilters } from '../../api/endpoints';
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
import { useIsMobile } from '../../lib/mobile';
import { BulkBar, OpsBoard, OpsInsights, OpsSettingsPanel } from './Ops';
import { VoiceAgentPanel } from './VoiceAgent';
import { WhatsAppSupportPanel } from './WhatsAppSupport';
import { get, put } from '../../api/client';

type Tab = 'queue' | 'board' | 'insights' | 'whatsapp' | 'voice' | 'settings';
interface SavedView { name: string; f: Record<string, string | boolean> }
const VIEWS: { id: string; label: string; icon: 'bolt' | 'user' | 'users' | 'alert' | 'timer' | 'calendar'; f: Record<string, string | boolean> }[] = [
  { id: 'open', label: 'Open', icon: 'bolt', f: { view: 'open' } },
  { id: 'mine', label: 'My queue', icon: 'user', f: { view: 'open', mine: true } },
  { id: 'unassigned', label: 'Unassigned', icon: 'users', f: { view: 'open', unassigned: true } },
  { id: 'late', label: 'SLA breached', icon: 'alert', f: { sla: 'breached' } },
  { id: 'risk', label: 'At risk', icon: 'timer', f: { sla: 'atRisk' } },
  { id: 'overdue', label: 'Overdue', icon: 'calendar', f: { overdue: true } },
];

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
  const [mineOnly, setMineOnly] = useState(false);
  const [unassigned, setUnassigned] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [tab, setTabState] = useState<Tab>((params.get('view') as Tab) ?? 'queue');
  const setTab = (t: Tab) => { setTabState(t); const n = new URLSearchParams(params); if (t === 'queue') n.delete('view'); else n.set('view', t); setParams(n, { replace: true }); };
  const [naming, setNaming] = useState<string | null>(null);
  const mobile = useIsMobile();
  const [showFilters, setShowFilters] = useState(false);
  const saved = useWsQuery(['ui', 'operations'], async () => ((await get<{ value: { views?: SavedView[] } | null }>('/me/ui/operations')).value?.views ?? []), { staleTime: 300_000 });
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);

  const filters: WorkFilters = {
    q: dq || undefined, workTypeId: typeId || undefined, relatedProjectId: projectId && projectId !== NO_PROJECT ? projectId : undefined, noProject: projectId === NO_PROJECT || undefined,
    assigneeId: !mine && !mineOnly && !unassigned ? assigneeId || undefined : undefined, mine: mine || mineOnly || undefined, unassigned: unassigned || undefined, priority: priority || undefined, status: status || undefined,
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
  const hasFilters = !!(mineOnly || unassigned || q || typeId || projectId || assigneeId || priority || status || dueFrom || dueTo || overdue || sla || (view !== (mine ? 'open' : 'all')));
  const reset = () => { setMineOnly(false); setUnassigned(false); setQ(''); setTypeId(''); setProjectId(''); setAssigneeId(''); setPriority(''); setStatus(''); setDueFrom(''); setDueTo(''); setOverdue(false); setSla(''); setView(mine ? 'open' : 'all'); setPage(1); };
  const sortBy = (key: string) => { setSort((s) => (s === key ? `-${key}` : key)); setPage(1); };
  const th = (key: string, label: string) => (
    <th aria-sort={sort === key ? 'ascending' : sort === `-${key}` ? 'descending' : 'none'}>
      <button type="button" className="th-sort" onClick={() => sortBy(key)}>{label}{sort === key ? ' ↑' : sort === `-${key}` ? ' ↓' : ''}</button>
    </th>
  );
  const exportCsv = () => void workApi.exportCsv(filters).catch((e) => toast(e instanceof ApiError ? e.message : 'Could not export the list.', 'error'));

  const items = list.data?.items ?? [];
  const applyView = (f: Record<string, string | boolean>) => {
    reset();
    if (f.view) setView(f.view as View); if (f.mine) setMineOnly(true); if (f.unassigned) setUnassigned(true); if (f.sla) setSla(String(f.sla)); if (f.overdue) setOverdue(true);
    if (f.typeId) setTypeId(String(f.typeId)); if (f.priority) setPriority(String(f.priority)); if (f.status) setStatus(String(f.status)); if (f.assigneeId) setAssigneeId(String(f.assigneeId)); if (f.q) setQ(String(f.q));
  };
  const current: Record<string, string | boolean> = Object.fromEntries(Object.entries({ view, mine: mineOnly, unassigned, sla, overdue, typeId, priority, status, assigneeId, q }).filter(([k, v]) => v && !(k === 'view' && v === 'all')));
  const sameAs = (f: Record<string, string | boolean>) => JSON.stringify(Object.entries(f).sort()) === JSON.stringify(Object.entries(current).sort());
  const saveView = async (name: string) => {
    setNaming(null);
    if (!name.trim()) return;
    const views = [...(saved.data ?? []).filter((v) => v.name !== name.trim()), { name: name.trim().slice(0, 40), f: current }].slice(-12);
    try { await put('/me/ui/operations', { value: { views } }); void saved.refetch(); toast('View saved.'); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save the view.', 'error'); }
  };
  const dropView = async (name: string) => { const views = (saved.data ?? []).filter((v) => v.name !== name); await put('/me/ui/operations', { value: views.length ? { views } : null }).catch(() => undefined); void saved.refetch(); };
  const togglePick = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const settingsQ = useWsQuery(['ops', 'settings'], opsApi.settings, { staleTime: 300_000 });
  return (
    <>
      <PageHead title="Operations" sub="Your support desk and operational work: tickets, bug fixes, analysis and requests, with SLA tracking, resolution notes and analytics.">
        <button type="button" className="btn btn-ghost" onClick={exportCsv} title="Download the filtered list as a CSV file now"><Icon name="download" /> Export CSV</button>
        {canReports && <Link className="btn btn-ghost" to="/reports?kind=WorkTasks" title="Excel or PDF, built in the background"><Icon name="download" /> Excel / PDF</Link>}
        {canCreate && <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" /> New work task</button>}
      </PageHead>

      <nav className="tabs route-tabs ops-tabs" aria-label="Operations">
        {([['queue', 'Queue', 'list'], ['board', 'Board', 'kanban'], ['insights', 'Insights', 'chart'], ['whatsapp', 'WhatsApp', 'message'], ...(settingsQ.data?.canManage ? [['voice', 'Voice agent', 'phone'], ['settings', 'Settings', 'settings']] : [])] as [Tab, string, 'list'][]).map(([id, label, icon]) => (
          <button key={id} type="button" className={`tab ${tab === id ? 'active' : ''}`} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}><Icon name={icon} />{label}</button>
        ))}
      </nav>
      {tab === 'insights' ? <OpsInsights /> : tab === 'whatsapp' ? <WhatsAppSupportPanel canManage={!!settingsQ.data?.canManage} /> : tab === 'voice' ? <VoiceAgentPanel /> : tab === 'settings' ? <OpsSettingsPanel /> : (
      <div className="card">
        <div className="ops-views" role="group" aria-label="Views">
          {VIEWS.map((v) => <button key={v.id} type="button" className={`ops-view ${sameAs(v.f) ? 'on' : ''}`} onClick={() => applyView(v.f)}><Icon name={v.icon} size={13} />{v.label}</button>)}
          {(saved.data ?? []).map((v) => (
            <span key={v.name} className={`ops-view saved ${sameAs(v.f) ? 'on' : ''}`}><button type="button" onClick={() => applyView(v.f)}><Icon name="star" size={12} />{v.name}</button>
              <button type="button" className="ops-view-x" aria-label={`Remove the ${v.name} view`} onClick={() => void dropView(v.name)}><Icon name="close" size={10} /></button></span>
          ))}
          {hasFilters && naming === null && <button type="button" className="ops-view add" onClick={() => setNaming('')}><Icon name="plus" size={12} />Save view</button>}
          {naming !== null && (
            <form className="ops-view-name" onSubmit={(e) => { e.preventDefault(); void saveView(naming); }}>
              <input className="input" autoFocus maxLength={40} placeholder="Name this view" value={naming} onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setNaming(null); }} aria-label="View name" />
              <button type="submit" className="btn btn-primary btn-sm" disabled={!naming.trim()}>Save</button>
            </form>
          )}
        </div>
        {mobile && (
          <div className="ops-mobile-search">
            <div className="search-field"><Icon name="search" /><input className="input" placeholder="Search…" value={q} onChange={(e) => on(setQ)(e.target.value)} aria-label="Search work tasks" /></div>
            <button type="button" className={`btn btn-ghost btn-sm ${showFilters ? 'btn-soft' : ''}`} aria-expanded={showFilters} onClick={() => setShowFilters((v) => !v)}><Icon name="settings" size={14} />Filters</button>
          </div>
        )}
        {(!mobile || showFilters) && <>
        <div className="toolbar">
          {!mobile && <div className="search-field"><Icon name="search" /><input className="input" placeholder="Search work tasks…" value={q} onChange={(e) => on(setQ)(e.target.value)} aria-label="Search work tasks" /></div>}
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
        </>}

        {tab === 'board' ? <div className="card-body"><OpsBoard filters={filters} onOpen={openTask} /></div> : <>
        <BulkBar ids={picked} onDone={() => setPicked([])} />
        {list.isLoading ? <PageLoader /> : list.isError ? <ErrorState error={list.error} retry={() => void list.refetch()} /> : items.length === 0 ? (
          <EmptyState icon="bolt" title={hasFilters ? 'No work tasks match these filters' : mine ? 'Nothing is assigned to you' : 'No work tasks yet'}
            text={hasFilters ? undefined : 'Operations is the support desk: log tickets, bug fixes, analysis and other operational work that does not need a project.'}
            action={hasFilters ? <button type="button" className="btn btn-ghost" onClick={reset}>Clear filters</button> : canCreate ? <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" /> New work task</button> : undefined} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="work-table">
                <thead><tr><th className="ops-pick"><input type="checkbox" aria-label="Select all on this page" checked={items.length > 0 && items.every((t) => picked.includes(t.id))}
                  onChange={(e) => setPicked(e.target.checked ? [...new Set([...picked, ...items.filter((t) => t.can.edit).map((t) => t.id)])] : picked.filter((id) => !items.some((t) => t.id === id)))} /></th>{th('title', 'Work task')}{th('type', 'Work type')}{th('project', 'Related project')}{th('assignee', 'Assigned to')}{th('priority', 'Priority')}{th('due', 'Due date')}{th('sla', 'SLA')}{th('status', 'Status')}</tr></thead>
                <tbody>
                  {items.map((t) => (
                    <tr key={t.id} className="clickable" tabIndex={0} onClick={() => openTask(t.id)} onKeyDown={(e) => { if (e.key === 'Enter') openTask(t.id); }} aria-label={`Open ${t.key} ${t.title}`}>
                      <td className="ops-pick" onClick={(e) => e.stopPropagation()}>{t.can.edit && <input type="checkbox" aria-label={`Select ${t.key}`} checked={picked.includes(t.id)} onChange={() => togglePick(t.id)} />}</td>
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
        </>}
      </div>)}

      {creating && <WorkTaskModal defaults={{ relatedProjectId: projectId && projectId !== NO_PROJECT ? projectId : undefined }} onClose={() => setCreating(false)} />}
      {openId && <WorkTaskModal taskId={openId} onClose={() => openTask(null)} />}
    </>
  );
}
