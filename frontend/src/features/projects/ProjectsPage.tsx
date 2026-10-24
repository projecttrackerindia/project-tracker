import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { projectApi, projectGroupApi, workspaceApi } from '../../api/endpoints';
import type { Project, ProjectHealth } from '../../api/types';
import { Icon } from '../../components/Icon';
import { activeShare, EmptyState, ErrorState, HealthBadge, PageHead, PageLoader, Pager, PriorityBadge, Progress, ProjectStatusBadge, ProjectTypeBadge, PriorityOptions, Segmented } from '../../components/ui';
import './projects.css';
import { PROJECT_STATUSES, formatDate, labelize } from '../../lib/format';
import { PROJECT_TYPES } from '../../lib/workLabels';
import { invalidateWorkspace, useDebounced, useWsQuery } from '../../lib/hooks';
import { useAuth, useCan, useIsPersonal, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { ProjectChatButton } from '../chat/ProjectChat';
import { ProjectBoard } from './ProjectBoard';
import { ProjectFormModal } from './ProjectFormModal';
import { Select } from '../../components/Select';

/** One progress bar, coloured by the project's status: colour means status, never how far along it is. */
const HEALTH_TONE: Record<ProjectHealth, '' | 'green' | 'amber' | 'red'> = { OnTrack: 'green', AtRisk: 'amber', Delayed: 'red', Completed: '', Cancelled: '', Archived: '' };

/**
 * A project at a glance (design p20), never more than five facts: the name with its key and team, the status pill, two lines of
 * description, how many tasks are done with one bar coloured by status, and the owner with the due date. Chat sits quietly in the corner.
 */
export function ProjectCard({ project: p, onOpen }: { project: Project; onOpen: () => void }) {
  const live = p.stats.total - p.stats.cancelled;
  return (
    <div className="project-card clickable" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }} aria-label={`${p.name}, ${p.progress}% done`}>
      <div className="pc-head">
        <div style={{ minWidth: 0 }}><div className="pc-name" title={p.name}>{p.name}</div><div className="pc-code" title={[p.key, p.teamName, p.projectGroupName].filter(Boolean).join(' · ')}>{p.key}{p.teamName ? ` · ${p.teamName}` : p.projectGroupName ? ` · ${p.projectGroupName}` : ''}</div></div>
        <div className="pc-badge"><HealthBadge health={p.health} /></div>
      </div>
      <div className="pc-desc" title={p.description ?? undefined}>{p.description || <span className="pc-desc-empty">No description yet.</span>}</div>
      <div className="pc-progress">
        <div className="pc-progress-line"><span>{p.stats.done} of {live} task{live === 1 ? '' : 's'}</span><b>{p.progress}%</b></div>
        <Progress value={p.progress} active={activeShare(p.stats)} tone={HEALTH_TONE[p.health]} />
      </div>
      <div className="pc-foot">
        <span>{p.owner?.name ?? 'Unassigned'}</span>
        <span className="pc-foot-end">{p.dueDate ? formatDate(p.dueDate) : '—'}<span className="pc-chat" onClick={(e) => e.stopPropagation()}><ProjectChatButton projectId={p.id} name={p.name} /></span></span>
      </div>
    </div>
  );
}

type View = 'cards' | 'list' | 'board';
type HealthChip = '' | 'OnTrack' | 'AtRisk' | 'Delayed' | 'Completed';
const HEALTH_CHIPS: { id: HealthChip; label: string }[] = [
  { id: '', label: 'All' }, { id: 'OnTrack', label: 'On track' }, { id: 'AtRisk', label: 'At risk' }, { id: 'Delayed', label: 'Delayed' }, { id: 'Completed', label: 'Completed' },
];
/** Health is worked out, not stored, so On track / At risk / Delayed look through this many projects at once. */
const HEALTH_WINDOW = 100;
const VIEW_KEY = 'pm_projects_view';
const SCOPE_KEY = 'pm_projects_scope';

/** Owners, Admins and Managers oversee the whole organization, so they get every project; everyone else gets the ones they belong to. */
const OVERSEES: readonly string[] = ['Owner', 'Admin', 'Manager'];

export function ProjectsPage() {
  const nav = useNavigate();
  const wid = useWorkspaceId();
  const canCreate = useCan('projects.create');
  const canEdit = useCan('projects.edit');
  const canDelete = useCan('projects.delete');
  const meId = useAuth((s) => s.ctx!.user.id);
  const role = useAuth((s) => s.ctx?.current?.role);
  const personal = useIsPersonal();
  const oversees = !!role && OVERSEES.includes(role) && !personal;
  // Those who oversee start with every project and can narrow to their own; Members and Guests only ever list the ones they belong to.
  const [scope, setScopeState] = useState<'all' | 'mine'>(() => {
    try { return localStorage.getItem(SCOPE_KEY) === 'mine' ? 'mine' : 'all'; } catch { return 'all'; }
  });
  const setScope = (s: 'all' | 'mine') => { setScopeState(s); setPage(1); try { localStorage.setItem(SCOPE_KEY, s); } catch { /* storage unavailable */ } };
  const mineOnly = !oversees || scope === 'mine';
  const [view, setViewState] = useState<View>(() => {
    try { const v = localStorage.getItem(VIEW_KEY); return v === 'list' || v === 'board' || v === 'cards' ? v : 'cards'; } catch { return 'cards'; }
  });
  const setView = (v: View) => { setViewState(v); setPage(1); try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage unavailable */ } };
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [projectType, setProjectType] = useState('');
  const [archived, setArchived] = useState(false);
  const [health, setHealth] = useState<HealthChip>('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<{ project?: Project } | null>(null);
  // "?new=1" (from the command palette) opens the new-project form, then leaves the address clean.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.get('new') !== '1') return;
    setModal({});
    const n = new URLSearchParams(params); n.delete('new'); setParams(n, { replace: true });
  }, [params, setParams]);
  const dq = useDebounced(q, 300);

  const board = view === 'board';
  // "Completed" is a status the server can filter by; On track / At risk / Delayed are worked out, so they look through a wider window here.
  const byHealth = health === 'OnTrack' || health === 'AtRisk' || health === 'Delayed';
  const filters = {
    q: dq || undefined, status: health === 'Completed' ? 'Completed' : status || undefined, priority: priority || undefined, ownerId: ownerId || undefined, projectGroupId: groupId || undefined, projectType: projectType || undefined, includeArchived: archived,
    sort: board ? 'position' : 'due', page: board || byHealth ? 1 : page, pageSize: board || byHealth ? HEALTH_WINDOW : 24, mineOnly,
  };
  const cacheKey = [wid, 'projects', 'list', filters];
  const projects = useWsQuery(['projects', 'list', filters], () => projectApi.list(filters), { placeholderData: (p) => p });
  const members = useWsQuery(['members'], workspaceApi.members);
  const groups = useWsQuery(['project-groups'], () => projectGroupApi.list());
  const raw = projects.data;
  const data = raw && byHealth ? { ...raw, items: raw.items.filter((p) => p.health === health), totalItems: raw.items.filter((p) => p.health === health).length, page: 1, totalPages: 1 } : raw;
  const beyondWindow = !!raw && byHealth && raw.totalItems > raw.items.length;
  const moreCount = [status, priority, ownerId, groupId, projectType].filter(Boolean).length + (archived ? 1 : 0);
  const hasFilters = !!(q || status || priority || ownerId || groupId || projectType || archived || health);
  // Only asked for when a filter narrows the list, so the subtitle can say "N of M" instead of implying N is the whole organization.
  const total = useWsQuery(['projects', 'list', 'total', mineOnly], () => projectApi.list({ mineOnly, pageSize: 1, page: 1 }), { enabled: hasFilters });
  const reset = () => { setQ(''); setStatus(''); setPriority(''); setOwnerId(''); setGroupId(''); setProjectType(''); setArchived(false); setHealth(''); setPage(1); };
  const on = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(1); };

  const remove = async (p: Project) => {
    if (!(await confirmDialog({ title: 'Delete project?', message: `Deleting “${p.name}” will also remove all of its tasks.` }))) return;
    try { await projectApi.remove(p.id); toast('Project deleted.', 'warning'); invalidateWorkspace(wid); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete the project.', 'error'); }
  };

  return (
    <div className="pj">
      <PageHead title="Projects" sub={data ? (
        hasFilters && total.data && total.data.totalItems !== data.totalItems
          ? `${data.totalItems} of ${total.data.totalItems} project${total.data.totalItems === 1 ? '' : 's'}${oversees ? (mineOnly ? ' you belong to' : '') : ''}`
          : `${data.totalItems} project${data.totalItems === 1 ? '' : 's'}${oversees ? (mineOnly ? ' you belong to' : ' in the organization') : ''}`
      ) : ' '}>
        <Segmented<View> label="Projects view" value={view} onChange={setView} options={[
          { id: 'cards', label: 'Cards', title: 'Cards view' }, { id: 'list', label: 'List', title: 'List view' }, { id: 'board', label: 'Board', title: 'Board view' },
        ]} />
        {canCreate && <button className="btn btn-primary" onClick={() => setModal({})}><Icon name="plus" /> New project</button>}
      </PageHead>

      {/* One search pill, the status chips, and the rest of the filters folded behind "More filters". */}
      <div className="pj-toolbar">
        <div className="search-field pj-search"><Icon name="search" /><input className="input" placeholder="Search projects" value={q} onChange={(e) => on(setQ)(e.target.value)} aria-label="Search projects" /></div>
        <div className="ds-chips" role="group" aria-label="Status">
          {HEALTH_CHIPS.map((c) => (
            <button key={c.id || 'all'} type="button" className={`ds-chip ${health === c.id ? 'on' : ''}`} aria-pressed={health === c.id} onClick={() => on(setHealth)(c.id)}>{c.label}</button>
          ))}
        </div>
        <button type="button" className="link-btn pj-more" aria-expanded={moreOpen || moreCount > 0} aria-controls="pj-more" onClick={() => setMoreOpen((v) => !v)}>
          More filters{moreCount > 0 ? ` · ${moreCount}` : ''}
        </button>
        {hasFilters && <button type="button" className="link-btn pj-clear" onClick={reset}>Clear</button>}
      </div>
      {(moreOpen || moreCount > 0) && (
        <div className="pj-filters" id="pj-more" role="group" aria-label="More filters">
          <Select className="select filter-input" value={status} onChange={(e) => { on(setStatus)(e.target.value); if (health === 'Completed') setHealth(''); }} aria-label="Status">
            <option value="">All statuses</option>{PROJECT_STATUSES.map((s) => <option key={s} value={s}>{labelize(s)}</option>)}
          </Select>
          <Select className="select filter-input" value={priority} onChange={(e) => on(setPriority)(e.target.value)} aria-label="Priority">
            <option value="">All priorities</option><PriorityOptions />
          </Select>
          <Select className="select filter-input" value={projectType} onChange={(e) => on(setProjectType)(e.target.value)} aria-label="Project type">
            <option value="">All types</option>{PROJECT_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </Select>
          {(groups.data?.length ?? 0) > 1 && (
            <Select className="select filter-input" value={groupId} onChange={(e) => on(setGroupId)(e.target.value)} aria-label="Project group">
              <option value="">All groups</option>{groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </Select>
          )}
          {(members.data?.length ?? 0) > 1 && (
            <Select className="select filter-input" value={ownerId} onChange={(e) => on(setOwnerId)(e.target.value)} aria-label="Owner">
              <option value="">All owners</option>{members.data?.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
            </Select>
          )}
          <label className="pj-check"><input type="checkbox" checked={archived} onChange={(e) => on(setArchived)(e.target.checked)} /> Show archived</label>
          {oversees && (
            <div className="seg" role="group" aria-label="Which projects">
              <button type="button" className={!mineOnly ? 'active' : ''} aria-pressed={!mineOnly} title="Every project in the organization" onClick={() => setScope('all')}>All projects</button>
              <button type="button" className={mineOnly ? 'active' : ''} aria-pressed={mineOnly} title="Only the projects you belong to" onClick={() => setScope('mine')}>My projects</button>
            </div>
          )}
        </div>
      )}

      {projects.isLoading ? <PageLoader />
        : projects.isError ? <ErrorState error={projects.error} retry={() => projects.refetch()} />
        : !data?.items.length ? (
          <div className="card"><EmptyState icon="folder" title={hasFilters ? 'No projects match' : 'No projects yet'} text={hasFilters ? 'Try another status or clear the filters.' : 'Create your first project to organise its tasks, dates and people.'}
            action={hasFilters ? <button className="btn btn-ghost" onClick={reset}>Clear filters</button> : canCreate ? <button className="btn btn-primary" onClick={() => setModal({})}><Icon name="plus" /> New project</button> : undefined} /></div>
        ) : view === 'board' ? (
          <div className="pj-board">
            <ProjectBoard projects={data.items} cacheKey={cacheKey} includeArchived={archived || status === 'Archived'} canEditAll={canEdit} meId={meId} onOpen={(id) => nav(`/projects/${id}`)} />
            {(raw?.totalItems ?? 0) > (raw?.items.length ?? 0) && <p className="muted pj-note">Showing the first {raw!.items.length} of {raw!.totalItems} projects. Use the filters to narrow the board.</p>}
          </div>
        ) : view === 'cards' ? (
          <div className="project-grid">{data.items.map((p) => <ProjectCard key={p.id} project={p} onOpen={() => nav(`/projects/${p.id}`)} />)}</div>
        ) : (
          <div className="card pj-list">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Project</th><th>Type</th><th>Owner</th><th>Timeline</th><th>Priority</th><th>Status</th><th>Health</th><th>Progress</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
                <tbody>
                  {data.items.map((p) => (
                    <tr key={p.id} className="clickable" onClick={() => nav(`/projects/${p.id}`)}>
                      <td><div className="td-title">{p.name}</div><div className="td-sub mono">{p.key}{p.teamName ? ` · ${p.teamName}` : ''}</div></td>
                      <td><ProjectTypeBadge type={p.projectType} /></td>
                      <td className="cell-muted">{p.owner?.name ?? '—'}</td>
                      <td className="cell-muted">{formatDate(p.startDate)} → {formatDate(p.dueDate)}</td>
                      <td><PriorityBadge priority={p.priority} /></td>
                      <td><ProjectStatusBadge status={p.status} /></td>
                      <td><HealthBadge health={p.health} /></td>
                      <td style={{ minWidth: 150 }}><div className="row"><div style={{ flex: 1 }}><Progress value={p.progress} active={activeShare(p.stats)} tone={HEALTH_TONE[p.health]} /></div><b style={{ fontSize: 12.5 }}>{p.progress}%</b></div></td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="td-actions">
                          <ProjectChatButton projectId={p.id} name={p.name} />
                          {canEdit && <button className="btn-icon" title="Edit" aria-label={`Edit ${p.name}`} onClick={() => setModal({ project: p })}><Icon name="edit" /></button>}
                          {canDelete && <button className="btn-icon danger" title="Delete" aria-label={`Delete ${p.name}`} onClick={() => remove(p)}><Icon name="trash" /></button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      {beyondWindow && view !== 'board' && <p className="muted pj-note">Looked through the first {raw!.items.length} of {raw!.totalItems} projects for this status. Search or use More filters to narrow it.</p>}
      {data && !board && !byHealth && <Pager page={data.page} totalPages={data.totalPages} totalItems={data.totalItems} onPage={setPage} />}

      {modal && <ProjectFormModal project={modal.project} onClose={() => setModal(null)} onSaved={(id) => { if (!modal.project) nav(`/projects/${id}`); }} />}
    </div>
  );
}
