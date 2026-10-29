import { coverageText, useCoverage } from '../quality/coverage';
import type { ProjectCoverage } from '../../api/qualityApi';
import { Term } from '../../components/Term';
import { pinItem, useContextMenu, usePins } from '../../components/v2/pins';
import { Face } from '../../components/Face';
import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { projectApi, projectGroupApi, workspaceApi } from '../../api/endpoints';
import type { Project } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { EmptyState, ErrorState, PageLoader, PriorityOptions, Segmented } from '../../components/ui';
import { PROJECT_TYPES } from '../../lib/workLabels';
import { invalidateWorkspace, useDebounced, useWsQuery } from '../../lib/hooks';
import { queryClient, useAuth, useCan, useIsPersonal, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { PortfolioView } from './PortfolioView';
import { duplicateGroups, groupKey, readDismissed, writeDismissed } from './duplicates';
import { usePortfolioBrief } from './PortfolioInsights';
import { ProjectBoard } from './ProjectBoard';
import { ProjectFormModal } from './ProjectFormModal';
import { dayMonth, errText, HEALTH, HealthPill, isFinished, passGradient, passStatus, useAllProjects } from './projectParts';
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
  const portfolio = v === 'portfolio' || v === 'timeline' || v === 'present' || v === 'sheet';
  if (picked && (portfolio || params.has('actions'))) {
    const actions = params.get('actions') === '1';
    return <Navigate to={`/work/projects/${encodeURIComponent(picked)}${actions ? '?tab=work&kind=action' : ''}`} replace />;
  }
  if (!portfolio) return <ProjectsView />;
  const place: Place = 'portfolio';
  const switcher = (
    <Segmented<Place> label="Projects or portfolio" value={place} options={[{ id: 'projects', label: 'Projects' }, { id: 'portfolio', label: 'Portfolio' }]}
      onChange={(t) => setParams(t === 'portfolio' ? { view: 'portfolio' } : {})} />
  );
  return <PortfolioView switcher={switcher} />;
}

// ------------------------------------------------------------------------------------------------------------------ Projects

type View = 'passes' | 'board' | 'list';
const VIEWS: readonly View[] = ['passes', 'board', 'list'];
type StatusChip = 'all' | 'OnTrack' | 'AtRisk' | 'Delayed' | 'Completed';
const CHIPS: { id: StatusChip; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'OnTrack', label: 'On track' }, { id: 'AtRisk', label: 'At risk' }, { id: 'Delayed', label: 'Late' }, { id: 'Completed', label: 'Done' },
];
const VIEW_KEY = 'pm_projects_view';
const SCOPE_KEY = 'pm_projects_scope';
/** Owners, Admins and Managers oversee the whole organization, so they get every project; everyone else gets the ones they belong to. */
const OVERSEES: readonly string[] = ['Owner', 'Admin', 'Manager'];
/** Open work first, the soonest due on top; finished projects after, the latest first. */
const byDue = (a: Project, b: Project) => {
  if (isFinished(a) !== isFinished(b)) return isFinished(a) ? 1 : -1;
  const da = a.dueDate ?? '9999', db = b.dueDate ?? '9999';
  return isFinished(a) ? db.localeCompare(da) : da.localeCompare(db);
};
const needsAttention = (p: Project) => !isFinished(p) && passStatus(p).tone !== 'ok';

/**
 * Projects (Apple design, s-projects): "14 active · 3 need attention" over the large title; search, one Filter button and Passes · Board · List (the choice is remembered).
 * Passes are Wallet-style cards: gradient, key, owner, progress ring, due + one honest line, a tear line, the stage dots (filled = signed
 * off) and one state pill. One violet line proposes merging a likely duplicate. Opening a pass lifts it and carries its key, name and stage
 * dots into the project page (shared elements; none when reduced motion is asked for).
 */
function ProjectsView() {
  const nav = useNavigate();
  const wid = useWorkspaceId();
  const still = useReducedMotion();
  const [params, setParams] = useSearchParams();
  const canEdit = useCan('projects.edit'), canDelete = useCan('projects.delete');
  const meId = useAuth((s) => s.ctx!.user.id);
  const role = useAuth((s) => s.ctx?.current?.role);
  const personal = useIsPersonal();
  const oversees = !!role && OVERSEES.includes(role) && !personal;
  const [scope, setScopeState] = useState<'all' | 'mine'>(() => { try { return localStorage.getItem(SCOPE_KEY) === 'mine' ? 'mine' : 'all'; } catch { return 'all'; } });
  const setScope = (s: 'all' | 'mine') => { setScopeState(s); try { localStorage.setItem(SCOPE_KEY, s); } catch { /* storage unavailable */ } };
  const mineOnly = !oversees || scope === 'mine';
  const [view, setViewState] = useState<View>(() => { try { const v = localStorage.getItem(VIEW_KEY) as View | null; return v && VIEWS.includes(v) ? v : 'passes'; } catch { return 'passes'; } });
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
  const [opening, setOpening] = useState<string | null>(null);
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
  const brief = usePortfolioBrief();
  const coverage = useCoverage();
  const items = useMemo(() => [...(all.data?.items ?? [])].sort(byDue), [all.data]);
  const pins = usePins();
  const passMenu = useContextMenu();
  const dupes = useMemo(() => new Set(duplicateGroups(items.filter((p) => p.status !== 'Archived')).flat().map((p) => p.id)), [items]);
  const activeFilters = [ownerId, groupId, type, priority].filter(Boolean).length + (status !== 'all' ? 1 : 0) + (archived ? 1 : 0) + (showCompleted ? 0 : 1);
  const narrowed = !!dq || activeFilters > 0;
  const members = useWsQuery(['members'], workspaceApi.members, { enabled: filterOpen });
  const groups = useWsQuery(['project-groups'], () => projectGroupApi.list(), { enabled: filterOpen });
  const shown = items.filter((p) => (status === 'all' || p.health === status) && (showCompleted || status === 'Completed' || !isFinished(p))
    && (!dq || `${p.name} ${p.key} ${p.projectGroupName ?? ''} ${p.owner?.name ?? ''}`.toLowerCase().includes(dq))
    && (!ownerId || p.owner?.id === ownerId) && (!groupId || p.projectGroupId === groupId) && (!type || p.projectType === type) && (!priority || p.priority === priority));
  const clear = () => { setQ(''); setOwnerId(''); setGroupId(''); setType(''); setPriority(''); setStatus('all'); setArchived(false); setShowCompleted(true); };
  const active = items.filter((p) => !isFinished(p)).length;
  const attention = items.filter(needsAttention).length;
  const open = (id: string) => nav(`/work/projects/${id}`);
  // Opening a pass: it lifts (spring), the project's page is fetched meanwhile, then the key, name and dots fly into its header.
  const openPass = (id: string) => {
    if (still) { open(id); return; }
    setOpening(id);
    const ready = Promise.all([
      wid ? queryClient.prefetchQuery({ queryKey: [wid, 'project', id], queryFn: () => projectApi.get(id) }) : null,
      import('./ProjectPage'),
      new Promise((r) => setTimeout(r, 240)),
    ]);
    void Promise.race([ready, new Promise((r) => setTimeout(r, 900))]).finally(() => open(id));
  };
  const remove = async (p: Project) => {
    if (!(await confirmDialog({ title: 'Delete project?', message: `Deleting “${p.name}” will also remove all of its tasks.` }))) return;
    try { await projectApi.remove(p.id); toast('Project deleted.', 'warning'); void invalidateWorkspace(wid, 'projects'); }
    catch (e) { toast(errText(e, 'Could not delete the project.'), 'error'); }
  };

  return (
    <div className="pj2 pa">
      <header className="pa-head">
        <div>
          <div className="pa-eyebrow" data-testid="projects-count">{all.data ? `${active} active · ${attention} need${attention === 1 ? 's' : ''} attention` : ' '}</div>
          <h1 className="pa-title">Projects</h1>
        </div>
        <div className="pa-tools" role="group" aria-label="Search and filter">
          <label className="pa-search"><Icon name="search" size={14} /><input type="search" placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search projects" /></label>
          <div className="pj2-filter" ref={filterRef}>
            <button type="button" className={`pa-btn pj2-filter-chip ${activeFilters ? 'on' : ''}`} aria-haspopup="dialog" aria-expanded={filterOpen} onClick={() => setFilterOpen((o) => !o)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
              Filter{activeFilters ? ` · ${activeFilters}` : ''}
            </button>
            {filterOpen && (
              <div className="pj2-filter-pop card" role="dialog" aria-label="Filter projects">
                {oversees && (
                  <label className="pj2-filter-row"><span>Projects</span>
                    <Select className="select" value={mineOnly ? 'mine' : 'all'} onChange={(e) => setScope(e.target.value as 'all' | 'mine')}>
                      <option value="all">All projects</option><option value="mine">Mine</option>
                    </Select>
                  </label>
                )}
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
                {narrowed && <button type="button" className="link-btn pj-clear" onClick={clear}>Clear filters</button>}
              </div>
            )}
          </div>
          <Segmented<View> label="Show as" className="pa-seg" value={view} onChange={setView} options={[{ id: 'passes', label: 'Passes' }, { id: 'board', label: 'Board' }, { id: 'list', label: 'List' }]} />
        </div>
      </header>

      <DuplicateLine projects={items} />

      {all.isLoading ? <PageLoader />
        : all.isError ? <ErrorState error={all.error} retry={() => all.refetch()} />
        : shown.length === 0 ? (
          <div className="pj2-empty card"><EmptyState icon="folder" title={narrowed ? 'No projects match' : 'No projects yet'} text={narrowed ? 'Try another status, or clear the filters.' : 'Create your first project to organise its work, dates and people.'}
            action={narrowed ? <button type="button" className="btn btn-ghost" onClick={clear}>Show all</button> : <button type="button" className="btn btn-primary" onClick={() => setModal({})}><Icon name="plus" /> New project</button>} /></div>
        ) : view === 'board' ? (
          <ProjectBoard projects={shown} cacheKey={[wid, 'projects', 'list', 'all', filters]} canEditAll={canEdit} meId={meId} onOpen={open} />
        ) : view === 'list' ? (
          <ProjectRows projects={shown} coverage={coverage} onOpen={open} canEdit={canEdit} canDelete={canDelete} meId={meId} onEdit={(p) => setModal({ project: p })} onDelete={(p) => void remove(p)} />
        ) : (
          <div className={`pa-grid ${opening ? 'opening' : ''}`}>
            {shown.map((p) => <Pass key={p.id} p={p} cov={coverage.get(p.id)} still={!!still} opening={opening} duplicate={dupes.has(p.id)}
              risk={brief.data?.ranked?.find((r) => r.projectId === p.id)} onOpen={openPass}
              onMenu={(e) => passMenu.open(e, [{ label: 'Open', icon: 'arrowRight', onSelect: () => openPass(p.id) }, pinItem(pins, p.id)])} />)}
            {passMenu.menu}
          </div>
        )}
      {(all.data?.total ?? 0) > items.length && <p className="muted pj-note">Showing the first {items.length} of {all.data!.total} projects. Search or filter to find the others.</p>}

      {modal && <ProjectFormModal project={modal.project} onClose={() => setModal(null)} onSaved={(id) => { if (!modal.project) nav(`/work/projects/${id}`); }} />}
    </div>
  );
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
/** The pass's eyebrow and its one honest line, from the project's own numbers (and the portfolio forecast when there is one). */
function passLine(p: Project, r?: { projectedFinish: string | null; projectedSlipDays: number | null }, duplicate = false): { label: string; value: string } {
  const pending = p.pendingSignOffs ?? 0, live = p.stats.total - p.stats.cancelled;
  const finished = isFinished(p);
  const label = finished ? (p.status === 'Completed' ? `Live ${dayMonth(p.dueDate)}` : p.status) : p.dueDate ? `Due ${dayMonth(p.dueDate)}` : 'No due date';
  const value = pending > 0 && (p.progress >= 100 || p.status === 'Completed') ? `${plural(pending, 'sign-off')} pending`
    : finished ? (p.status === 'Completed' ? 'All stages signed off' : `${p.progress}% done`)
    : duplicate ? 'Possible duplicate'
    : r?.projectedFinish && (r.projectedSlipDays ?? 0) > 0 ? `Forecast ${dayMonth(r.projectedFinish)}`
    : p.stats.overdue > 0 ? `${plural(p.stats.overdue, 'overdue item')}`
    : live === 0 ? 'No work yet' : `${p.stats.done} of ${live} done`;
  return { label, value };
}

const R = 26, C = 2 * Math.PI * R;
/** One project as a Wallet pass. */
function Pass({ p, cov, still, opening, duplicate, risk, onOpen, onMenu }: {
  p: Project; cov?: ProjectCoverage; still: boolean; opening: string | null; duplicate: boolean; risk?: { projectedFinish: string | null; projectedSlipDays: number | null }; onOpen: (id: string) => void;
  onMenu?: (e: React.MouseEvent) => void;
}) {
  const [from, to] = passGradient(p);
  const st = passStatus(p);
  const line = passLine(p, risk, duplicate);
  const stages = p.stageCount ?? 0;
  const signed = Math.max(0, stages - (p.pendingSignOffs ?? 0));
  const me = opening === p.id, other = !!opening && !me;
  const pct = Math.max(0, Math.min(100, p.progress));
  // Stage names under the dots: read from the project (fetched on hover or when the pass lifts; the same query the project page uses).
  const [peek, setPeek] = useState(false);
  const detail = useWsQuery(['project', p.id], () => projectApi.get(p.id), { enabled: (peek || me) && stages > 0, staleTime: 60_000 });
  const names = (detail.data?.stages ?? []).slice().sort((a, b) => a.order - b.order).map((x) => x.name);
  const named = names.length === stages && stages > 0 && stages <= 10;
  return (
    <motion.a href={`/work/projects/${p.id}`} className={`pa-pass ${me ? 'lifted' : ''}`} data-project={p.name} data-testid="project-pass"
      style={{ background: `linear-gradient(150deg, ${from}, ${to})`, ['--c' as string]: to }}
      aria-label={`${p.name}, ${st.label}, ${p.progress}% done${p.dueDate ? `, due ${dayMonth(p.dueDate)}` : ''}, ${signed} of ${stages} stages signed off`}
      animate={still ? undefined : me ? { scale: 1.04, y: -8, opacity: 1 } : { scale: 1, y: 0, opacity: other ? 0.6 : 1 }}
      transition={{ type: 'spring', duration: 0.45, bounce: 0.15 }}
      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); onOpen(p.id); }}
      onContextMenu={onMenu} onMouseEnter={() => setPeek(true)} onFocus={() => setPeek(true)}>
      <span className="pa-top">
        <motion.span className="pa-key" layoutId={still ? undefined : `pkey-${p.id}`}>{p.key}</motion.span>
        {p.owner ? <Face className="pa-owner-av" userId={p.owner.id} name={p.owner.name} title={p.owner.name} /> : <span className="pa-owner-av" title="No owner">–</span>}
      </span>
      <motion.b className="pa-name" layoutId={still ? undefined : `pname-${p.id}`} title={p.name}>{p.name}</motion.b>
      <span className="pa-own">{p.owner?.name ?? 'No owner'}{coverageText(cov) && <> · <span className="pa-cov" title={coverageText(cov)!.title} data-testid="pass-coverage">{coverageText(cov)!.label}</span></>}</span>
      <span className="pa-mid">
        <span className="pa-arc" role="img" aria-label={`${pct}% of the work done`}>
          <svg width="62" height="62" viewBox="0 0 62 62" aria-hidden="true">
            <circle cx="31" cy="31" r={R} fill="none" stroke="rgba(255,255,255,.28)" strokeWidth="5" />
            {pct > 0 && <circle cx="31" cy="31" r={R} fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - pct / 100)} transform="rotate(-90 31 31)" />}
          </svg>
          <b>{pct}%</b>
        </span>
        <span className="pa-when"><span className="pa-lbl">{line.label}</span><span className="pa-val">{line.value}</span></span>
      </span>
      <span className="pa-perf" aria-hidden="true" />
      <span className="pa-foot">
        <span>
          <motion.span className="pa-dots" layoutId={still ? undefined : `pdots-${p.id}`} aria-hidden="true">
            {Array.from({ length: Math.max(stages, 0) }, (_, i) => <i key={i} className={i < signed ? 'f' : ''} />)}
          </motion.span>
          {named && <span className="pa-gn" data-testid="pass-stage-names" style={{ ['--n' as string]: stages }}>{signed >= stages ? <span>{names.join(' › ')}</span> : names.map((n, i) => <span key={i} className={i < signed ? 'f' : i === signed ? 'cur' : ''} title={n}>{i === signed ? `Next: ${n}` : `› ${n}`}</span>)}</span>}
          <span className="pa-stg">{stages ? `${signed} of ${stages} signed off` : 'No stages yet'}</span>
        </span>
        <span className={`pa-state ${st.tone}`} data-testid="pass-state">{st.label}</span>
      </span>
    </motion.a>
  );
}

/**
 * ✦ The likely-duplicate line: "A and B look like the same project". Merge… shows the choices (there is no merge on the server, so keep
 * one and close the other: it is archived, its work stays and it can be restored) and "Not a duplicate" (remembered for the workspace).
 */
function DuplicateLine({ projects }: { projects: Project[] }) {
  const wid = useWorkspaceId();
  const canEdit = useCan('projects.edit');
  const meId = useAuth((s) => s.ctx?.user.id);
  const [dismissed, setDismissed] = useState<string[]>(() => readDismissed(wid));
  const [choosing, setChoosing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => duplicateGroups(projects.filter((p) => p.status !== 'Archived')).filter((g) => !dismissed.includes(groupKey(g))), [projects, dismissed]);
  if (groups.length === 0) return null;
  const g = groups[0], key = groupKey(g);
  const closable = g.filter((p) => canEdit || p.owner?.id === meId);
  const owners = new Set(g.map((p) => p.owner?.id ?? '')).size === 1 && g[0].owner;
  const notDuplicate = () => { const next = [...dismissed, key]; setDismissed(next); writeDismissed(wid, next); setChoosing(null); toast('Got it. They will not be flagged again.', 'info'); };
  const close = async (p: Project) => {
    if (!(await confirmDialog({ title: `Close “${p.name}”?`, message: 'It is archived: its work and history stay, and it can be restored from Edit details. The other project carries on.', confirmText: 'Close it' }))) return;
    setBusy(true);
    try { await projectApi.move(p.id, { status: 'Archived' }); toast(`“${p.name}” closed.`); setChoosing(null); void invalidateWorkspace(wid, 'projects'); void invalidateWorkspace(wid, 'portfolio'); }
    catch (e) { toast(errText(e, 'Could not close the project.'), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="pa-ai" role="note" aria-label="Likely duplicate" data-testid="duplicate-line">
      <span className="pa-orb" aria-hidden="true" />
      <span className="pa-ai-text">
        {g.slice(0, -1).map((p, i) => <span key={p.id}>{i > 0 ? ', ' : ''}<b>{p.name}</b></span>)} and <b>{g[g.length - 1].name}</b> look like the same project — {owners ? 'same owner, ' : ''}same name apart from case and spacing.
      </span>
      <span className="pa-ai-acts" data-testid="duplicate-actions">
        {choosing === key ? (
          <>
            {closable.map((p) => <button key={p.id} type="button" className="pa-btn sm" disabled={busy} onClick={() => void close(p)}>Close “{p.name}”</button>)}
            <button type="button" className="pa-btn sm" onClick={notDuplicate}>Not a duplicate</button>
          </>
        ) : <button type="button" className="pa-btn sm" onClick={() => setChoosing(key)}>Merge…</button>}
      </span>
    </div>
  );
}

/** The list view: the same projects in columns, with edit and delete where allowed. */
function ProjectRows({ projects, coverage, onOpen, canEdit, canDelete, meId, onEdit, onDelete }: {
  projects: Project[]; coverage: Map<string, ProjectCoverage>; onOpen: (id: string) => void; canEdit: boolean; canDelete: boolean; meId: string; onEdit: (p: Project) => void; onDelete: (p: Project) => void;
}) {
  return (
    <div className="card pj-list pj2-list">
      <div className="table-wrap">
        <table>
          <thead><tr><th>Project</th><th>Owner</th><th>Dates</th><th>Status</th><th>Progress</th><th><Term k="coverage">Tests</Term></th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id} className="clickable" onClick={() => onOpen(p.id)}>
                <td><div className="td-title">{p.name}</div><div className="td-sub mono">{p.key}{p.projectGroupName ? ` · ${p.projectGroupName}` : ''}</div></td>
                <td className="cell-muted">{p.owner?.name ?? '—'}</td>
                <td className="cell-muted">{dayMonth(p.startDate)} → {dayMonth(p.dueDate)}</td>
                <td><HealthPill health={p.health} pendingSignOffs={p.pendingSignOffs} /></td>
                <td style={{ minWidth: 150 }}><div className="pj2-rowbar"><span className={`pj2-bar ${HEALTH[p.health].tone}`}><i style={{ width: p.progress > 0 ? `max(8px, ${p.progress}%)` : '8px' }} /></span><b>{p.progress}%</b></div></td>
                <td className="cell-muted" data-testid="row-coverage">{(() => { const t = coverageText(coverage.get(p.id)); return t ? <span className={`pj2-cov t-${t.tone}`} title={t.title}>{t.label.replace('Tests ', '')}</span> : '—'; })()}</td>
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
