import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { projectApi, projectGroupApi, workspaceApi } from '../../api/endpoints';
import type { Project } from '../../api/types';
import { Icon } from '../../components/Icon';
import { activeShare, Avatar, EmptyState, ErrorState, HealthBadge, PageHead, PageLoader, Pager, PriorityBadge, Progress, ProjectStatusBadge, ProjectTypeBadge, PriorityOptions } from '../../components/ui';
import { PROJECT_STATUSES, formatDate, labelize } from '../../lib/format';
import { PROJECT_TYPES } from '../../lib/workLabels';
import { invalidateWorkspace, useDebounced, useWsQuery } from '../../lib/hooks';
import { useAuth, useCan, useIsPersonal, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { ProjectChatButton } from '../chat/ProjectChat';
import { ProjectBoard } from './ProjectBoard';
import { ProjectFormModal } from './ProjectFormModal';
import { Select } from '../../components/Select';

export function ProjectCard({ project: p, onOpen }: { project: Project; onOpen: () => void }) {
  return (
    <div className="project-card" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
      <div className="pc-head">
        <div style={{ minWidth: 0 }}><div className="pc-name">{p.name}</div><div className="pc-code">{p.key}{p.teamName ? ` · ${p.teamName}` : ''}{p.projectGroupName ? ` · ${p.projectGroupName}` : ''}</div></div>
        <div className="row" style={{ gap: 6, flexShrink: 0 }}><HealthBadge health={p.health} /><ProjectChatButton projectId={p.id} name={p.name} /></div>
      </div>
      {p.description && <div className="pc-desc">{p.description}</div>}
      <div className="pc-stats">
        <div className="pc-stat"><b>{p.stats.total}</b><span>Tasks</span></div>
        <div className="pc-stat"><b style={{ color: 'var(--success)' }}>{p.stats.done}</b><span>Done</span></div>
        <div className="pc-stat"><b style={{ color: p.stats.overdue ? 'var(--danger)' : undefined }}>{p.stats.overdue}</b><span>Overdue</span></div>
      </div>
      <div>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 7 }}>
          <span className="muted" style={{ fontSize: 11.5, fontWeight: 600 }}>Progress</span><span style={{ fontSize: 12.5, fontWeight: 700 }}>{p.progress}%</span>
        </div>
        <Progress value={p.progress} active={activeShare(p.stats)} />
      </div>
      <div className="task-meta"><PriorityBadge priority={p.priority} /><ProjectStatusBadge status={p.status} /><ProjectTypeBadge type={p.projectType} /></div>
      <div className="pc-foot">
        <span className="row" style={{ gap: 6 }}><Avatar name={p.owner?.name} size="sm" userId={p.owner?.id} />{p.owner?.name ?? 'Unassigned'}</span>
        <span>{formatDate(p.dueDate)}</span>
      </div>
    </div>
  );
}

type View = 'cards' | 'list' | 'board';
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
  const filters = {
    q: dq || undefined, status: status || undefined, priority: priority || undefined, ownerId: ownerId || undefined, projectGroupId: groupId || undefined, projectType: projectType || undefined, includeArchived: archived,
    sort: board ? 'position' : 'due', page: board ? 1 : page, pageSize: board ? 100 : 24, mineOnly,
  };
  const cacheKey = [wid, 'projects', 'list', filters];
  const projects = useWsQuery(['projects', 'list', filters], () => projectApi.list(filters), { placeholderData: (p) => p });
  const members = useWsQuery(['members'], workspaceApi.members);
  const groups = useWsQuery(['project-groups'], () => projectGroupApi.list());
  const data = projects.data;
  const hasFilters = !!(q || status || priority || ownerId || groupId || projectType || archived);
  // Only asked for when a filter narrows the list, so the subtitle can say "N of M" instead of implying N is the whole organization.
  const total = useWsQuery(['projects', 'list', 'total', mineOnly], () => projectApi.list({ mineOnly, pageSize: 1, page: 1 }), { enabled: hasFilters });
  const reset = () => { setQ(''); setStatus(''); setPriority(''); setOwnerId(''); setGroupId(''); setArchived(false); setPage(1); };
  const on = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(1); };

  const remove = async (p: Project) => {
    if (!(await confirmDialog({ title: 'Delete project?', message: `Deleting “${p.name}” will also remove all of its tasks.` }))) return;
    try { await projectApi.remove(p.id); toast('Project deleted.', 'warning'); invalidateWorkspace(wid); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete the project.', 'error'); }
  };

  return (
    <>
      <PageHead title="Projects" sub={data ? (
        hasFilters && total.data && total.data.totalItems !== data.totalItems
          ? `${data.totalItems} of ${total.data.totalItems} project${total.data.totalItems === 1 ? '' : 's'}${oversees ? (mineOnly ? ' you belong to' : '') : ''}`
          : `${data.totalItems} project${data.totalItems === 1 ? '' : 's'}${oversees ? (mineOnly ? ' you belong to' : ' in the organization') : ''}`
      ) : ' '}>
        <div className="seg" role="group" aria-label="Projects view">
          {([['cards', 'grid', 'Cards'], ['list', 'list', 'List'], ['board', 'kanban', 'Board']] as const).map(([id, icon, label]) => (
            <button key={id} type="button" className={view === id ? 'active' : ''} aria-pressed={view === id} title={`${label} view`} onClick={() => setView(id)}><Icon name={icon} /><span>{label}</span></button>
          ))}
        </div>
        {canCreate && <button className="btn btn-primary" onClick={() => setModal({})}><Icon name="plus" /> New project</button>}
      </PageHead>

      <div className="card mb-22">
        <div className="toolbar">
          <div className="search-field"><Icon name="search" /><input className="input" placeholder="Search projects…" value={q} onChange={(e) => on(setQ)(e.target.value)} aria-label="Search projects" /></div>
          <Select className="select filter-input" value={status} onChange={(e) => on(setStatus)(e.target.value)} aria-label="Status">
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
          <label className="row" style={{ fontSize: 12.5, color: 'var(--text-2)', gap: 6 }}><input type="checkbox" checked={archived} onChange={(e) => on(setArchived)(e.target.checked)} /> Show archived</label>
          {oversees && (
            <div className="seg" role="group" aria-label="Which projects">
              <button type="button" className={!mineOnly ? 'active' : ''} aria-pressed={!mineOnly} title="Every project in the organization" onClick={() => setScope('all')}><Icon name="folder" /><span>All projects</span></button>
              <button type="button" className={mineOnly ? 'active' : ''} aria-pressed={mineOnly} title="Only the projects you belong to" onClick={() => setScope('mine')}><Icon name="user" /><span>My projects</span></button>
            </div>
          )}
          <div className="toolbar-spacer" />
          {hasFilters && <button className="btn btn-ghost btn-sm" onClick={reset}><Icon name="close" /> Clear</button>}
        </div>

        {projects.isLoading ? <PageLoader />
          : projects.isError ? <ErrorState error={projects.error} retry={() => projects.refetch()} />
          : !data?.items.length ? (
            <div className="card-body"><EmptyState icon="folder" title="No projects found" text={hasFilters ? 'Try adjusting your filters.' : 'Create your first project to organise tasks.'}
              action={hasFilters ? <button className="btn btn-ghost" onClick={reset}>Clear filters</button> : canCreate ? <button className="btn btn-primary" onClick={() => setModal({})}><Icon name="plus" /> New project</button> : undefined} /></div>
          ) : view === 'board' ? (
            <div className="card-body">
              <ProjectBoard projects={data.items} cacheKey={cacheKey} includeArchived={archived || status === 'Archived'} canEditAll={canEdit} meId={meId} onOpen={(id) => nav(`/projects/${id}`)} />
              {data.totalItems > data.items.length && <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>Showing the first {data.items.length} of {data.totalItems} projects — use the filters to narrow the board.</p>}
            </div>
          ) : view === 'cards' ? (
            <div className="card-body"><div className="project-grid">{data.items.map((p) => <ProjectCard key={p.id} project={p} onOpen={() => nav(`/projects/${p.id}`)} />)}</div></div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Project</th><th>Type</th><th>Owner</th><th>Timeline</th><th>Priority</th><th>Status</th><th>Health</th><th>Progress</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
                <tbody>
                  {data.items.map((p) => (
                    <tr key={p.id} className="clickable" onClick={() => nav(`/projects/${p.id}`)}>
                      <td><div className="td-title">{p.name}</div><div className="td-sub">{p.key}{p.teamName ? ` · ${p.teamName}` : ''}</div></td>
                      <td><ProjectTypeBadge type={p.projectType} /></td>
                      <td className="cell-muted">{p.owner?.name ?? '—'}</td>
                      <td className="cell-muted">{formatDate(p.startDate)} → {formatDate(p.dueDate)}</td>
                      <td><PriorityBadge priority={p.priority} /></td>
                      <td><ProjectStatusBadge status={p.status} /></td>
                      <td><HealthBadge health={p.health} /></td>
                      <td style={{ minWidth: 150 }}><div className="row"><div style={{ flex: 1 }}><Progress value={p.progress} active={activeShare(p.stats)} /></div><b style={{ fontSize: 12 }}>{p.progress}%</b></div></td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="td-actions">
                          <ProjectChatButton projectId={p.id} name={p.name} />
                          {canEdit && <button className="btn-icon" title="Edit" onClick={() => setModal({ project: p })}><Icon name="edit" /></button>}
                          {canDelete && <button className="btn-icon danger" title="Delete" onClick={() => remove(p)}><Icon name="trash" /></button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        {data && !board && <Pager page={data.page} totalPages={data.totalPages} totalItems={data.totalItems} onPage={setPage} />}
      </div>

      {modal && <ProjectFormModal project={modal.project} onClose={() => setModal(null)} onSaved={(id) => { if (!modal.project) nav(`/projects/${id}`); }} />}
    </>
  );
}
