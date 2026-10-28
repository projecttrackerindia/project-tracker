import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { opsApi, projectApi, workApi, workspaceApi, type WorkFilters } from '../../api/endpoints';
import type { WorkTask } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { Menu } from '../../components/Menu';
import { Select } from '../../components/Select';
import { Avatar, EmptyState, ErrorState, PageHead, PageLoader, Pager, PriorityBadge, PriorityOptions } from '../../components/ui';
import { formatDate } from '../../lib/format';
import { useDebounced, useDetailsDismiss, useWsQuery } from '../../lib/hooks';
import { WORK_STATUSES } from '../../lib/workLabels';
import { useCan, useModule } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { WorkTaskModal } from './WorkTaskModal';
import { SlaChip } from './Sla';
import { BulkBar, OpsBoard, OpsInsights, OpsSettingsPanel } from './Ops';
import { VoiceAgentPanel } from './VoiceAgent';
import { WhatsAppSupportPanel } from './WhatsAppSupport';
import { get, put } from '../../api/client';

export type OpsView = 'queue' | 'board' | 'insights' | 'whatsapp' | 'voice' | 'settings';
type Tab = OpsView;
/** The page's three places (the queue and board are one place shown two ways; WhatsApp and the voice agent are the channels tickets come from). */
type Place = 'tickets' | 'insights' | 'channels' | 'settings';
const placeOf = (t: Tab): Place => (t === 'queue' || t === 'board' ? 'tickets' : t === 'whatsapp' || t === 'voice' ? 'channels' : t);
interface SavedView { name: string; f: Record<string, string | boolean> }
type ViewIcon = 'bolt' | 'user' | 'users' | 'alert' | 'timer' | 'calendar' | 'list' | 'checkCircle';
const VIEWS: { id: string; label: string; icon: ViewIcon; f: Record<string, string | boolean> }[] = [
  { id: 'open', label: 'Open', icon: 'bolt', f: { view: 'open' } },
  { id: 'mine', label: 'My queue', icon: 'user', f: { view: 'open', mine: true } },
  { id: 'unassigned', label: 'Unassigned', icon: 'users', f: { view: 'open', unassigned: true } },
  { id: 'late', label: 'SLA breached', icon: 'alert', f: { sla: 'breached' } },
  { id: 'risk', label: 'At risk', icon: 'timer', f: { sla: 'atRisk' } },
  { id: 'overdue', label: 'Overdue', icon: 'calendar', f: { overdue: true } },
  { id: 'all', label: 'All tickets', icon: 'list', f: {} },
  { id: 'closed', label: 'Closed', icon: 'checkCircle', f: { view: 'closed' } },
];

const NO_PROJECT = '__none';
type View = 'all' | 'open' | 'closed';

export function WorkStatusBadge({ status }: { status: WorkTask['status'] }) {
  const s = WORK_STATUSES.find((x) => x.id === status);
  return <span className={`badge ${s?.badge ?? 'badge-neutral'}`}><span className="dot" />{s?.label ?? status}</span>;
}

/**
 * The ticket desk: operational work (bug fixes, support, analysis, data preparation ...) that is not a project task, everyone's, with its
 * queue (SLA views, saved views, bulk edit), board, insights, channels and settings. In v2 it is Work › Tickets › ··· (`embedded`): its
 * view is always in the address (?view=) and a ticket opens in the Work side panel (`onOpenItem`) instead of a pop-up.
 */
export function WorkTasksPage({ embedded = false, onOpenItem }: { embedded?: boolean; onOpenItem?: (id: string) => void } = {}) {
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
  const wantedView = params.get('view') as Tab | null;
  useEffect(() => { if (embedded && wantedView && wantedView !== tab) setTabState(wantedView); }, [embedded, wantedView]); // eslint-disable-line react-hooks/exhaustive-deps
  const setTab = (t: Tab) => { setTabState(t); const n = new URLSearchParams(params); if (t === 'queue' && !embedded) n.delete('view'); else n.set('view', t); setParams(n, { replace: true }); };
  const [naming, setNaming] = useState<string | null>(null);
  const navigate = useNavigate();
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
  const openTask = (id: string | null) => { if (id && onOpenItem) { onOpenItem(id); return; } const n = new URLSearchParams(params); if (id) n.set('task', id); else n.delete('task'); setParams(n, { replace: true }); };

  const on = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  const hasFilters = !!(mineOnly || unassigned || q || typeId || projectId || assigneeId || priority || status || dueFrom || dueTo || overdue || sla || (view !== (mine ? 'open' : 'all')));
  const reset = () => { setMineOnly(false); setUnassigned(false); setQ(''); setTypeId(''); setProjectId(''); setAssigneeId(''); setPriority(''); setStatus(''); setDueFrom(''); setDueTo(''); setOverdue(false); setSla(''); setView(mine ? 'open' : 'all'); setPage(1); };
  const nameOf = <T extends { id?: string; userId?: string }>(list: T[] | undefined, id: string, label: (x: T) => string) => { const x = list?.find((i) => (i.id ?? i.userId) === id); return x ? label(x) : 'selected'; };
  /** The filters in use, each as a small chip that removes itself. */
  const chips: { label: string; clear: () => void }[] = [
    ...(typeId ? [{ label: `Type: ${nameOf(types.data, typeId, (t) => t.name)}`, clear: () => on(setTypeId)('') }] : []),
    ...(projectId ? [{ label: projectId === NO_PROJECT ? 'No related project' : `Project: ${nameOf(projects.data?.items, projectId, (x) => x.key)}`, clear: () => on(setProjectId)('') }] : []),
    ...(assigneeId && !mine ? [{ label: `Assigned: ${nameOf(members.data, assigneeId, (m) => m.displayName)}`, clear: () => on(setAssigneeId)('') }] : []),
    ...(priority ? [{ label: `Priority: ${priority}`, clear: () => on(setPriority)('') }] : []),
    ...(status ? [{ label: `Status: ${WORK_STATUSES.find((x) => x.id === status)?.label ?? status}`, clear: () => on(setStatus)('') }] : []),
    ...(sla ? [{ label: sla === 'atRisk' ? 'SLA at risk' : sla === 'breached' ? 'SLA breached' : 'With SLA targets', clear: () => on(setSla)('') }] : []),
    ...(dueFrom ? [{ label: `Due from ${dueFrom}`, clear: () => on(setDueFrom)('') }] : []),
    ...(dueTo ? [{ label: `Due to ${dueTo}`, clear: () => on(setDueTo)('') }] : []),
    ...(overdue ? [{ label: 'Overdue only', clear: () => on(setOverdue)(false) }] : []),
  ];
  const activeCount = chips.length;
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
  const canManage = !!settingsQ.data?.canManage;
  const place = placeOf(tab);
  // Live counts for the strip over the list (the same numbers Insights shows); hidden when they cannot be read.
  const counts = useWsQuery(['ops', 'insights', 30], () => opsApi.insights(30), { staleTime: 30_000, retry: false });
  const activeView = VIEWS.find((v) => sameAs(v.f)) ?? (saved.data ?? []).map((v) => ({ id: `saved:${v.name}`, label: v.name, icon: 'bolt' as ViewIcon, f: v.f })).find((v) => sameAs(v.f));
  const viewLabel = activeView?.label ?? 'Custom view';
  const strip: { id: string; label: string; value: number; tone?: 'danger' | 'warning'; f: Record<string, string | boolean> }[] = counts.data ? [
    { id: 'open', label: 'Open', value: counts.data.open, f: VIEWS[0].f },
    { id: 'unassigned', label: 'Unassigned', value: counts.data.unassigned, tone: counts.data.unassigned ? 'warning' : undefined, f: VIEWS[2].f },
    { id: 'late', label: 'SLA breached', value: counts.data.breached, tone: counts.data.breached ? 'danger' : undefined, f: VIEWS[3].f },
    { id: 'risk', label: 'At risk', value: counts.data.atRisk, tone: counts.data.atRisk ? 'warning' : undefined, f: VIEWS[4].f },
  ] : [];
  const showDue = items.some((t) => t.dueDate);
  return (
    <div className="ops-page">
      <PageHead title={embedded ? 'Ticket desk' : 'Operations'} sub="Tickets, bug fixes and requests, with service levels.">
        <Menu label="Export" icon="download" items={[
          { label: 'CSV (this list, now)', icon: 'download', onSelect: exportCsv },
          { label: 'Excel or PDF report', icon: 'download', onSelect: () => navigate('/reports?kind=WorkTasks'), hidden: !canReports },
        ]} />
        {canManage && <button type="button" className={`btn ${place === 'settings' ? 'btn-soft' : ''}`} onClick={() => setTab(place === 'settings' ? 'queue' : 'settings')} aria-pressed={place === 'settings'}><Icon name="settings" /> Settings</button>}
        {canCreate && <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" /> New ticket</button>}
      </PageHead>

      <nav className="tabs ops-tabs" aria-label="Operations">
        {([['tickets', 'Tickets', 'list', 'queue'], ['insights', 'Insights', 'chart', 'insights'], ['channels', 'Channels', 'message', 'whatsapp']] as [Place, string, IconName, Tab][]).map(([id, label, icon, to]) => (
          <button key={id} type="button" className={`tab ${place === id ? 'active' : ''}`} aria-current={place === id ? 'page' : undefined} onClick={() => setTab(id === 'tickets' && tab === 'board' ? 'board' : to)}><Icon name={icon} />{label}</button>
        ))}
      </nav>

      {place === 'insights' ? <OpsInsights /> : place === 'settings' ? <OpsSettingsPanel /> : place === 'channels' ? (
        <div className="ops-channels">
          <div className="seg ops-channel-seg" role="group" aria-label="Channel">
            <button type="button" className={tab === 'whatsapp' ? 'active' : ''} aria-pressed={tab === 'whatsapp'} onClick={() => setTab('whatsapp')}><Icon name="message" size={14} /> WhatsApp</button>
            {canManage && <button type="button" className={tab === 'voice' ? 'active' : ''} aria-pressed={tab === 'voice'} onClick={() => setTab('voice')}><Icon name="phone" size={14} /> Voice agent</button>}
          </div>
          {tab === 'voice' ? <VoiceAgentPanel /> : <WhatsAppSupportPanel canManage={canManage} />}
        </div>
      ) : (
      <>
        {strip.length > 0 && (
          <div className="ops-strip" role="group" aria-label="Queue at a glance">
            {strip.map((x) => (
              <button key={x.id} type="button" className={`ops-stat${x.tone ? ` ${x.tone}` : ''}${sameAs(x.f) ? ' on' : ''}`} aria-pressed={sameAs(x.f)} onClick={() => applyView(x.f)}>
                <b>{x.value}</b><span>{x.label}</span>
              </button>
            ))}
          </div>
        )}
        <div className="card ops-list">
          {/* One row: which tickets (a view), search, filters, and list or board. */}
          <div className="ops-toolbar">
            <ViewMenu label={viewLabel} views={VIEWS} saved={saved.data ?? []} isOn={sameAs} onPick={applyView} onDrop={(n) => void dropView(n)}
              canSave={hasFilters && !activeView} onSave={() => setNaming('')} />
            {naming !== null && (
              <form className="ops-view-name" onSubmit={(e) => { e.preventDefault(); void saveView(naming); }}>
                <input className="input" autoFocus maxLength={40} placeholder="Name this view" value={naming} onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setNaming(null); }} aria-label="View name" />
                <button type="submit" className="btn btn-primary btn-sm" disabled={!naming.trim()}>Save</button>
              </form>
            )}
            <div className="search-field ops-search"><Icon name="search" /><input className="input" placeholder="Search tickets…" value={q} onChange={(e) => on(setQ)(e.target.value)} aria-label="Search work tasks" /></div>
            <button type="button" className={`btn btn-sm ops-filter-btn ${showFilters ? 'btn-soft' : 'btn-ghost'}`} aria-expanded={showFilters} onClick={() => setShowFilters((v) => !v)}>
              <Icon name="settings" size={14} />Filters{activeCount > 0 && <em className="ops-count">{activeCount}</em>}
            </button>
            {(activeCount > 0 || q) && <button type="button" className="btn btn-ghost btn-sm" onClick={reset}>Clear</button>}
            <div className="seg ops-display" role="group" aria-label="Show as">
              <button type="button" className={tab === 'queue' ? 'active' : ''} aria-pressed={tab === 'queue'} onClick={() => setTab('queue')} title="List"><Icon name="list" size={14} /><span>List</span></button>
              <button type="button" className={tab === 'board' ? 'active' : ''} aria-pressed={tab === 'board'} onClick={() => setTab('board')} title="Board"><Icon name="kanban" size={14} /><span>Board</span></button>
            </div>
          </div>
          {showFilters && (
            <div className="ops-filters" role="group" aria-label="Filters">
              <label className="ops-f"><span>Show</span><Select className="select" value={status ? '' : view} disabled={!!status} onChange={(e) => on(setView)(e.target.value as View)} aria-label="Open or closed">
                <option value="all">Open and closed</option><option value="open">Open</option><option value="closed">Closed</option></Select></label>
              <label className="ops-f"><span>Work type</span><Select className="select" value={typeId} onChange={(e) => on(setTypeId)(e.target.value)} aria-label="Work type">
                <option value="">All work types</option>{types.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></label>
              <label className="ops-f"><span>Related project</span><Select className="select" value={projectId} onChange={(e) => on(setProjectId)(e.target.value)} aria-label="Related project">
                <option value="">All projects</option><option value={NO_PROJECT}>No related project</option>
                {projects.data?.items.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}</Select></label>
              {!mine && <label className="ops-f"><span>Assigned to</span><Select className="select" value={assigneeId} onChange={(e) => on(setAssigneeId)(e.target.value)} aria-label="Assigned to">
                <option value="">Anyone</option>{members.data?.filter((m) => m.role !== 'Guest' && m.isActive !== false).map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}</Select></label>}
              <label className="ops-f"><span>Priority</span><Select className="select" value={priority} onChange={(e) => on(setPriority)(e.target.value)} aria-label="Priority"><option value="">All priorities</option><PriorityOptions /></Select></label>
              <label className="ops-f"><span>Status</span><Select className="select" value={status} onChange={(e) => on(setStatus)(e.target.value)} aria-label="Status">
                <option value="">Any status</option>{WORK_STATUSES.map((st) => <option key={st.id} value={st.id}>{st.label}</option>)}</Select></label>
              <label className="ops-f"><span>Service level</span><Select className="select" value={sla} onChange={(e) => on(setSla)(e.target.value)} aria-label="Service level">
                <option value="">Any SLA</option><option value="atRisk">SLA at risk</option><option value="breached">SLA breached</option><option value="tracked">With SLA targets</option></Select></label>
              <label className="ops-f"><span>Due from</span><input className="input" type="date" value={dueFrom} onChange={(e) => on(setDueFrom)(e.target.value)} aria-label="Due from" /></label>
              <label className="ops-f"><span>Due to</span><input className="input" type="date" value={dueTo} onChange={(e) => on(setDueTo)(e.target.value)} aria-label="Due to" /></label>
              <label className="ops-f ops-f-check"><input type="checkbox" checked={overdue} onChange={(e) => on(setOverdue)(e.target.checked)} /><span>Overdue only</span></label>
            </div>
          )}
          {!showFilters && chips.length > 0 && (
            <div className="ops-chips" aria-label="Active filters">
              {chips.map((c) => <button key={c.label} type="button" className="ops-chip" onClick={c.clear} aria-label={`Remove filter ${c.label}`}>{c.label}<Icon name="close" size={11} /></button>)}
            </div>
          )}

          {tab === 'board' ? <div className="card-body"><OpsBoard filters={filters} onOpen={openTask} /></div> : <>
          {list.isLoading ? <PageLoader /> : list.isError ? <ErrorState error={list.error} retry={() => void list.refetch()} /> : items.length === 0 ? (
            <EmptyState icon="bolt" title={hasFilters ? 'No tickets match this view' : mine ? 'Nothing is assigned to you' : 'No tickets yet'}
              text={hasFilters ? undefined : 'Operations is the support desk: log tickets, bug fixes, analysis and other operational work that does not need a project.'}
              action={hasFilters ? <button type="button" className="btn btn-ghost" onClick={reset}>Clear filters</button> : canCreate ? <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" /> New ticket</button> : undefined} />
          ) : (
            <>
              <div className="table-wrap">
                <table className="work-table ops-table">
                  <thead><tr><th className="ops-pick"><input type="checkbox" aria-label="Select all on this page" checked={items.length > 0 && items.every((t) => picked.includes(t.id))}
                    onChange={(e) => setPicked(e.target.checked ? [...new Set([...picked, ...items.filter((t) => t.can.edit).map((t) => t.id)])] : picked.filter((id) => !items.some((t) => t.id === id)))} /></th>{th('title', 'Ticket')}{th('assignee', 'Assigned to')}{th('priority', 'Priority')}{th('sla', 'SLA')}{th('status', 'Status')}{showDue && th('due', 'Due')}</tr></thead>
                  <tbody>
                    {items.map((t) => (
                      <tr key={t.id} className={`clickable${picked.includes(t.id) ? ' picked' : ''}`} tabIndex={0} onClick={() => openTask(t.id)} onKeyDown={(e) => { if (e.key === 'Enter') openTask(t.id); }} aria-label={`Open ${t.key} ${t.title}`}>
                        <td className="ops-pick" onClick={(e) => e.stopPropagation()}>{t.can.edit && <input type="checkbox" aria-label={`Select ${t.key}`} checked={picked.includes(t.id)} onChange={() => togglePick(t.id)} />}</td>
                        <td className="ops-ticket">
                          <div className="td-title"><span className="task-key">{t.key}</span> {t.title}</div>
                          <div className="td-sub">{[t.workType, t.relatedProject?.name, t.commentCount > 0 ? `${t.commentCount} comment${t.commentCount === 1 ? '' : 's'}` : '', t.attachmentCount > 0 ? `${t.attachmentCount} file${t.attachmentCount === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}</div>
                        </td>
                        <td>{t.assignee ? <span className="row ops-person"><Avatar name={t.assignee.name} size="sm" userId={t.assignee.id} />{t.assignee.name}</span> : <span className="muted">Unassigned</span>}</td>
                        <td><PriorityBadge priority={t.priority} /></td>
                        <td><SlaChip sla={t.sla} /></td>
                        <td><WorkStatusBadge status={t.status} /></td>
                        {showDue && <td className={t.isOverdue ? 'work-late' : 'cell-muted'}>{t.dueDate ? formatDate(t.dueDate) : '—'}{t.isOverdue ? ' · overdue' : ''}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={list.data!.page} totalPages={list.data!.totalPages} totalItems={list.data!.totalItems} onPage={setPage} />
            </>
          )}
          </>}
        </div>
        <BulkBar ids={picked} onDone={() => setPicked([])} />
      </>)}

      {creating && <WorkTaskModal defaults={{ relatedProjectId: projectId && projectId !== NO_PROJECT ? projectId : undefined }} onClose={() => setCreating(false)} />}
      {openId && <WorkTaskModal taskId={openId} onClose={() => openTask(null)} />}
    </div>
  );
}

/** Which tickets: the built-in views, then the person's saved ones (each removable), then "Save this view" when the filters are new. */
function ViewMenu({ label, views, saved, isOn, onPick, onDrop, canSave, onSave }: {
  label: string; views: typeof VIEWS; saved: SavedView[]; isOn: (f: Record<string, string | boolean>) => boolean;
  onPick: (f: Record<string, string | boolean>) => void; onDrop: (name: string) => void; canSave: boolean; onSave: () => void;
}) {
  const control = useRef<HTMLDetailsElement>(null);
  useDetailsDismiss(control);
  const close = () => { if (control.current) control.current.open = false; };
  return (
    <details ref={control} className="ops-dd">
      <summary className="btn btn-sm ops-dd-btn" aria-label={`View: ${label}`}><Icon name="layers" size={14} /><span>{label}</span><Icon name="chevronD" size={12} /></summary>
      <div className="ops-dd-panel" role="menu" aria-label="Views">
        {views.map((v) => (
          <button key={v.id} type="button" role="menuitemradio" aria-checked={isOn(v.f)} className={`ops-dd-item${isOn(v.f) ? ' on' : ''}`} onClick={() => { onPick(v.f); close(); }}>
            <Icon name={v.icon} size={14} /><span>{v.label}</span>{isOn(v.f) && <Icon name="check" size={13} />}
          </button>
        ))}
        {saved.length > 0 && <div className="ops-dd-label">Saved views</div>}
        {saved.map((v) => (
          <div key={v.name} className={`ops-dd-item saved${isOn(v.f) ? ' on' : ''}`}>
            <button type="button" role="menuitemradio" aria-checked={isOn(v.f)} onClick={() => { onPick(v.f); close(); }}><Icon name="star" size={13} /><span>{v.name}</span></button>
            <button type="button" className="ops-dd-x" aria-label={`Remove the ${v.name} view`} onClick={() => onDrop(v.name)}><Icon name="close" size={11} /></button>
          </div>
        ))}
        {canSave && <button type="button" className="ops-dd-item add" onClick={() => { close(); onSave(); }}><Icon name="plus" size={14} /><span>Save this view</span></button>}
      </div>
    </details>
  );
}
