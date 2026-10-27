import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { projectApi, projectGroupApi, workspaceApi } from '../../api/endpoints';
import type { Project } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { EmptyState, ErrorState, PageHead, PageLoader, PriorityOptions, Segmented } from '../../components/ui';
import { PROJECT_TYPES } from '../../lib/workLabels';
import { invalidateWorkspace, useDebounced, useWsQuery } from '../../lib/hooks';
import { useAuth, useCan, useIsPersonal, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { DotsMenu } from '../talk/DotsMenu';
import { PortfolioView } from './PortfolioView';
import { ProjectBoard } from './ProjectBoard';
import { ProjectFormModal } from './ProjectFormModal';
import { BackLink, dayMonth, DuplicateFlags, errText, HEALTH, HealthPill, isFinished, useAllProjects } from './projectParts';
import './projects.css';
import './projectsHome.css';

type Place = 'projects' | 'portfolio';

/**
 * Projects (v2 §3.4): one page with a Projects / Portfolio switch. Projects is the status counts (which are also the filter) over simple cards;
 * Portfolio is the AI summary and the decisions to take (old date → new date, Accept). A likely duplicate is flagged on both.
 * Addresses: /work/projects, /work/projects?view=portfolio (the portfolio's roadmap is view=timeline). An old portfolio link to one project
 * (?project=) opens that project's page: there is one project page.
 */
export function ProjectsHome() {
  const [params, setParams] = useSearchParams();
  const v = params.get('view');
  const picked = params.get('project');
  const portfolio = v === 'portfolio' || v === 'timeline';
  if (picked && (portfolio || params.has('actions'))) {
    const actions = params.get('actions') === '1';
    return <Navigate to={`/work/projects/${encodeURIComponent(picked)}${actions ? '?tab=work&kind=action' : ''}`} replace />;
  }
  const place: Place = portfolio ? 'portfolio' : 'projects';
  const switcher = (
    <Segmented<Place> label="Projects or portfolio" value={place} options={[{ id: 'projects', label: 'Projects' }, { id: 'portfolio', label: 'Portfolio' }]}
      onChange={(t) => setParams(t === 'portfolio' ? { view: 'portfolio' } : {})} />
  );
  return place === 'portfolio' ? <PortfolioView switcher={switcher} /> : <ProjectsView switcher={switcher} />;
}

// ------------------------------------------------------------------------------------------------------------------ Projects

type View = 'cards' | 'list' | 'board';
type StatusChip = 'all' | 'OnTrack' | 'AtRisk' | 'Delayed' | 'Completed';
const CHIPS: { id: StatusChip; label: string; tone: string }[] = [
  { id: 'all', label: 'All', tone: '' }, { id: 'OnTrack', label: 'On track', tone: 'ok' }, { id: 'AtRisk', label: 'At risk', tone: 'risk' },
  { id: 'Delayed', label: 'Delayed', tone: 'late' }, { id: 'Completed', label: 'Completed', tone: 'done' },
];
const VIEW_KEY = 'pm_projects_view';
const SCOPE_KEY = 'pm_projects_scope';
/** Filters appear only past this many projects (v2: "filters only when needed"). */
const FILTERS_FROM = 10;
/** Owners, Admins and Managers oversee the whole organization, so they get every project; everyone else gets the ones they belong to. */
const OVERSEES: readonly string[] = ['Owner', 'Admin', 'Manager'];
/** Open work first, the soonest due on top; finished projects after, the latest first. */
const byDue = (a: Project, b: Project) => {
  if (isFinished(a) !== isFinished(b)) return isFinished(a) ? 1 : -1;
  const da = a.dueDate ?? '9999', db = b.dueDate ?? '9999';
  return isFinished(a) ? db.localeCompare(da) : da.localeCompare(db);
};

function ProjectsView({ switcher }: { switcher: ReactNode }) {
  const nav = useNavigate();
  const wid = useWorkspaceId();
  const [params, setParams] = useSearchParams();
  const canCreate = useCan('projects.create'), canEdit = useCan('projects.edit'), canDelete = useCan('projects.delete');
  const meId = useAuth((s) => s.ctx!.user.id);
  const role = useAuth((s) => s.ctx?.current?.role);
  const personal = useIsPersonal();
  const oversees = !!role && OVERSEES.includes(role) && !personal;
  const [scope, setScopeState] = useState<'all' | 'mine'>(() => { try { return localStorage.getItem(SCOPE_KEY) === 'mine' ? 'mine' : 'all'; } catch { return 'all'; } });
  const setScope = (s: 'all' | 'mine') => { setScopeState(s); try { localStorage.setItem(SCOPE_KEY, s); } catch { /* storage unavailable */ } };
  const mineOnly = !oversees || scope === 'mine';
  const [view, setViewState] = useState<View>(() => { try { const x = localStorage.getItem(VIEW_KEY); return x === 'list' || x === 'board' ? x : 'cards'; } catch { return 'cards'; } });
  const setView = (x: View) => { setViewState(x); try { localStorage.setItem(VIEW_KEY, x); } catch { /* storage unavailable */ } };
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200).trim().toLowerCase();
  const [ownerId, setOwnerId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [type, setType] = useState('');
  const [priority, setPriority] = useState('');
  const [showCompleted, setShowCompleted] = useState(true);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!filterOpen) return;
    const close = (e: MouseEvent) => { if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setFilterOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [filterOpen]);
  const [modal, setModal] = useState<{ project?: Project } | null>(null);
  const rawStatus = params.get('status');
  const status: StatusChip = CHIPS.some((c) => c.id === rawStatus) ? rawStatus as StatusChip : 'all';
  const setStatus = (s: StatusChip) => setParams((p) => { const n = new URLSearchParams(p); if (s === 'all') n.delete('status'); else n.set('status', s); return n; }, { replace: true });

  // "?new=1" (the command palette, an old link) opens the new-project form, then leaves the address clean.
  useEffect(() => {
    if (params.get('new') !== '1') return;
    setModal({});
    const n = new URLSearchParams(params); n.delete('new'); setParams(n, { replace: true });
  }, [params, setParams]);

  const filters = { mineOnly, includeArchived: archived };
  const all = useAllProjects(filters);
  const items = useMemo(() => [...(all.data?.items ?? [])].sort(byDue), [all.data]);
  const count = (s: StatusChip) => (s === 'all' ? items.length : items.filter((p) => p.health === s).length);
  // How many settings inside the Filter popover differ from their defaults (shown on the chip).
  const activeFilters = [ownerId, groupId, type, priority].filter(Boolean).length + (status !== 'all' ? 1 : 0) + (archived ? 1 : 0) + (showCompleted ? 0 : 1);
  const narrowed = !!dq || activeFilters > 0;
  // Search is always there; the single Filter chip appears past 10 projects, and while any of its filters is set so it can be cleared.
  const filtersOn = items.length > FILTERS_FROM || activeFilters > 0;
  const members = useWsQuery(['members'], workspaceApi.members, { enabled: filtersOn });
  const groups = useWsQuery(['project-groups'], () => projectGroupApi.list(), { enabled: filtersOn });
  const shown = items.filter((p) => (status === 'all' || p.health === status) && (showCompleted || status === 'Completed' || !isFinished(p))
    && (!dq || `${p.name} ${p.key} ${p.projectGroupName ?? ''} ${p.owner?.name ?? ''}`.toLowerCase().includes(dq))
    && (!ownerId || p.owner?.id === ownerId) && (!groupId || p.projectGroupId === groupId) && (!type || p.projectType === type) && (!priority || p.priority === priority));
  const clear = () => { setQ(''); setOwnerId(''); setGroupId(''); setType(''); setPriority(''); setStatus('all'); setArchived(false); setShowCompleted(true); };
  const open = (id: string) => nav(`/work/projects/${id}`);
  const remove = async (p: Project) => {
    if (!(await confirmDialog({ title: 'Delete project?', message: `Deleting “${p.name}” will also remove all of its tasks.` }))) return;
    try { await projectApi.remove(p.id); toast('Project deleted.', 'warning'); void invalidateWorkspace(wid, 'projects'); }
    catch (e) { toast(errText(e, 'Could not delete the project.'), 'error'); }
  };

  return (
    <div className="pj2">
      <PageHead eyebrow={<BackLink to="/work" label="Work" />} title="Projects">
        <div className="pj2-heads">
          {switcher}
          <DotsMenu label="More on Projects" items={[
            { label: 'New project', icon: 'plus', hint: 'Or + New, from anywhere', onSelect: () => setModal({}), hidden: !canCreate },
            { label: 'Show as cards', icon: 'grid', hint: view === 'cards' ? 'Showing now' : undefined, onSelect: () => setView('cards') },
            { label: 'Show as a list', icon: 'list', hint: view === 'list' ? 'Showing now' : 'Owner, dates and status in columns', onSelect: () => setView('list') },
            { label: 'Show as a board', icon: 'kanban', hint: view === 'board' ? 'Showing now' : 'Drag a project to change its status', onSelect: () => setView('board') },
          ]} />
        </div>
      </PageHead>

      <div className="pj2-stats" role="group" aria-label="Status">
        {CHIPS.map((c) => (
          <button key={c.id} type="button" className={`pj2-stat ${status === c.id ? 'on' : ''}`} aria-pressed={status === c.id} onClick={() => setStatus(c.id)}>
            <b className={c.tone}>{all.data ? count(c.id) : '–'}</b><span>{c.label}</span>
          </button>
        ))}
      </div>

      <div className="pj2-filters" role="group" aria-label="Search and filter">
        <div className="search-field pj-search"><Icon name="search" /><input className="input" type="search" placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search projects" /></div>
        {filtersOn && (
          <div className="pj2-filter" ref={filterRef}>
            <button type="button" className={`pj2-filter-chip ${activeFilters ? 'on' : ''}`} aria-haspopup="dialog" aria-expanded={filterOpen} onClick={() => setFilterOpen((o) => !o)}>
              <Icon name="filter" size={14} /> Filter{activeFilters ? ` · ${activeFilters}` : ''}
            </button>
            {filterOpen && (
              <div className="pj2-filter-pop card" role="dialog" aria-label="Filter projects">
                {(groups.data?.length ?? 0) > 1 && (
                  <label className="pj2-filter-row"><span>Group</span>
                    <Select className="select" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                      <option value="">All groups</option>{groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </Select>
                  </label>
                )}
                {(members.data?.length ?? 0) > 1 && (
                  <label className="pj2-filter-row"><span>Owner</span>
                    <Select className="select" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                      <option value="">All owners</option>{members.data?.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
                    </Select>
                  </label>
                )}
                <label className="pj2-filter-row"><span>Status</span>
                  <Select className="select" value={status} onChange={(e) => setStatus(e.target.value as StatusChip)}>
                    {CHIPS.map((c) => <option key={c.id} value={c.id}>{c.id === 'all' ? 'Any status' : c.label}</option>)}
                  </Select>
                </label>
                <label className="pj2-filter-row"><span>Type</span>
                  <Select className="select" value={type} onChange={(e) => setType(e.target.value)}>
                    <option value="">All types</option>{PROJECT_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </Select>
                </label>
                <label className="pj2-filter-row"><span>Priority</span>
                  <Select className="select" value={priority} onChange={(e) => setPriority(e.target.value)}>
                    <option value="">All priorities</option><PriorityOptions />
                  </Select>
                </label>
                <label className="pj-check"><input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} /> Show completed</label>
                <label className="pj-check"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived</label>
                {activeFilters > 0 && <button type="button" className="link-btn pj-clear" onClick={clear}>Clear filters</button>}
              </div>
            )}
          </div>
        )}
        {oversees && <Segmented label="Which projects" value={mineOnly ? 'mine' : 'all'} onChange={(s) => setScope(s)} options={[{ id: 'all', label: 'All projects' }, { id: 'mine', label: 'Mine' }]} />}
        {narrowed && <button type="button" className="link-btn pj-clear" onClick={clear}>Clear</button>}
      </div>

      <DuplicateFlags projects={items} />

      {all.isLoading ? <PageLoader />
        : all.isError ? <ErrorState error={all.error} retry={() => all.refetch()} />
        : shown.length === 0 ? (
          <div className="pj2-empty card"><EmptyState icon="folder" title={narrowed ? 'No projects match' : 'No projects yet'} text={narrowed ? 'Try another status, or clear the filters.' : 'Create your first project to organise its work, dates and people.'}
            action={narrowed ? <button type="button" className="btn btn-ghost" onClick={clear}>Show all</button> : canCreate ? <button type="button" className="btn btn-primary" onClick={() => setModal({})}><Icon name="plus" /> New project</button> : undefined} /></div>
        ) : view === 'board' ? (
          <div className="pj-board"><ProjectBoard projects={shown} cacheKey={[wid, 'projects', 'list', 'all', filters]} includeArchived={archived} canEditAll={canEdit} meId={meId} onOpen={open} /></div>
        ) : view === 'list' ? (
          <ProjectRows projects={shown} onOpen={open} canEdit={canEdit} canDelete={canDelete} meId={meId} onEdit={(p) => setModal({ project: p })} onDelete={(p) => void remove(p)} />
        ) : (
          <div className="pj2-grid">{shown.map((p) => <ProjectTile key={p.id} p={p} />)}</div>
        )}
      {(all.data?.total ?? 0) > items.length && <p className="muted pj-note">Showing the first {items.length} of {all.data!.total} projects. Search or filter to find the others.</p>}

      {modal && <ProjectFormModal project={modal.project} onClose={() => setModal(null)} onSaved={(id) => { if (!modal.project) nav(`/work/projects/${id}`); }} />}
    </div>
  );
}

/** A project at a glance: name and status, group · owner, one bar coloured by status, then % and due. Nothing else (Talk has the chat). */
function ProjectTile({ p }: { p: Project }) {
  const h = HEALTH[p.health];
  const group = p.projectGroupName ?? p.teamName;
  const late = !isFinished(p) && !!p.dueDate && p.dueDate.slice(0, 10) < new Date().toISOString().slice(0, 10) && p.progress < 100;
  return (
    <Link className="pj2-card" to={`/work/projects/${p.id}`} data-project={p.name} aria-label={`${p.name}, ${h.label}, ${p.progress}% done${p.dueDate ? `, due ${dayMonth(p.dueDate)}` : ''}`}>
      <span className="pj2-card-head"><b className="pj2-name" title={p.name}>{p.name}</b><HealthPill health={p.health} pendingSignOffs={p.pendingSignOffs} /></span>
      <span className="pj2-sub">{[group, p.owner?.name ?? 'No owner'].filter(Boolean).join(' · ')}</span>
      <span className={`pj2-bar ${h.tone}`} aria-hidden="true"><i style={{ width: p.progress > 0 ? `max(8px, ${p.progress}%)` : '8px' }} /></span>
      <span className="pj2-foot">{p.progress}%{p.dueDate ? <> · <span className={late ? 'late' : ''}>due {dayMonth(p.dueDate)}</span></> : ' · no due date'}</span>
    </Link>
  );
}

/** The list view: the same projects in columns, with edit and delete where allowed. */
function ProjectRows({ projects, onOpen, canEdit, canDelete, meId, onEdit, onDelete }: {
  projects: Project[]; onOpen: (id: string) => void; canEdit: boolean; canDelete: boolean; meId: string; onEdit: (p: Project) => void; onDelete: (p: Project) => void;
}) {
  return (
    <div className="card pj-list pj2-list">
      <div className="table-wrap">
        <table>
          <thead><tr><th>Project</th><th>Owner</th><th>Dates</th><th>Status</th><th>Progress</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id} className="clickable" onClick={() => onOpen(p.id)}>
                <td><div className="td-title">{p.name}</div><div className="td-sub mono">{p.key}{p.projectGroupName ? ` · ${p.projectGroupName}` : ''}</div></td>
                <td className="cell-muted">{p.owner?.name ?? '—'}</td>
                <td className="cell-muted">{dayMonth(p.startDate)} → {dayMonth(p.dueDate)}</td>
                <td><HealthPill health={p.health} pendingSignOffs={p.pendingSignOffs} /></td>
                <td style={{ minWidth: 150 }}><div className="pj2-rowbar"><span className={`pj2-bar ${HEALTH[p.health].tone}`}><i style={{ width: p.progress > 0 ? `max(8px, ${p.progress}%)` : '8px' }} /></span><b>{p.progress}%</b></div></td>
                <td onClick={(e) => e.stopPropagation()}>
                  <div className="td-actions">
                    {(canEdit || p.owner?.id === meId) && <button type="button" className="btn-icon" title="Edit" aria-label={`Edit ${p.name}`} onClick={() => onEdit(p)}><Icon name="edit" /></button>}
                    {canDelete && <button type="button" className="btn-icon danger" title="Delete" aria-label={`Delete ${p.name}`} onClick={() => onDelete(p)}><Icon name="trash" /></button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
