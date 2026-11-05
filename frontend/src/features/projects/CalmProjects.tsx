import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { projectApi } from '../../api/endpoints';
import type { Project } from '../../api/types';
import { CalmAv, CalmCard, CalmDayRibbon, CalmDot, CalmGo, CalmLink, CalmPills, CalmSection, CalmSplit, type CalmSeg } from '../../components/calm';
import { Icon } from '../../components/Icon';
import { usePins } from '../../components/v2/pins';
import { projectColor } from '../../lib/calm';
import { todayISO } from '../../lib/format';
import { useDebounced, useWsQuery } from '../../lib/hooks';
import { shiftIsoDate } from '../../lib/zone';
import { useAuth, useCan, useIsPersonal } from '../../stores/auth';
import { DotsMenu } from '../talk/DotsMenu';
import { openCalmNew, ProjectSheet, shortDay } from '../calm/createSheets';
import { isFinished, useAllProjects } from './projectParts';
import '../calm/calm-pages.css';

type Scope = 'all' | 'mine' | 'pinned' | 'archived';
type Mode = 'list' | 'folders';
const OVERSEES: readonly string[] = ['Owner', 'Admin', 'Manager'];

/** Health in words and tone (the project's own status, or Done). */
export function healthOf(p: Project): { label: string; tone: 'good' | 'warn' | 'bad' | 'quiet' } {
  if (p.status === 'Completed') return { label: 'Done', tone: 'quiet' };
  if (p.status === 'Archived') return { label: 'Archived', tone: 'quiet' };
  if (p.status === 'OnHold') return { label: 'On hold', tone: 'quiet' };
  if (p.health === 'Delayed') return { label: 'Late', tone: 'bad' };
  if (p.health === 'AtRisk') return { label: 'At risk', tone: 'bad' };
  if (p.stats.overdue > 0) return { label: 'Watch', tone: 'warn' };
  return { label: 'On track', tone: 'good' };
}
const open = (p: Project) => Math.max(0, p.stats.total - p.stats.done - p.stats.cancelled);
const byNeed = (a: Project, b: Project) => Number(isFinished(a)) - Number(isFinished(b)) || rank(a) - rank(b) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999');
const rank = (p: Project) => ({ bad: 0, warn: 1, good: 2, quiet: 3 })[healthOf(p).tone];

/**
 * Projects (calm, shots 08, 08b, 08c, 42): "N projects. / <one> needs you this week." over All · Mine · Pinned · Archived, search, List or
 * Folders, and + New project. List is one table (dot, name, key, owner, progress ribbon, next milestone, health); Folders are frosted
 * folder cards with an Info panel for the one selected (double-click opens it). This week's milestones sit at the foot.
 */
export function CalmProjects() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const role = useAuth((s) => s.ctx?.current?.role);
  const meId = useAuth((s) => s.ctx!.user.id);
  const personal = useIsPersonal();
  const canCreate = useCan('projects.create');
  const oversees = !!role && OVERSEES.includes(role) && !personal;
  const pins = usePins();
  const scope = (['all', 'mine', 'pinned', 'archived'].includes(params.get('scope') ?? '') ? params.get('scope') : 'all') as Scope;
  const mode: Mode = params.get('browse') === 'folders' ? 'folders' : 'list';
  const set = (k: string, v: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (v === null) n.delete(k); else n.set(k, v); return n; }, { replace: true });
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'recent' | 'name'>('recent');
  const dq = useDebounced(q, 150).trim().toLowerCase();
  const all = useAllProjects({ mineOnly: !oversees, includeArchived: scope === 'archived' });
  const items = useMemo(() => [...(all.data?.items ?? [])].sort(byNeed), [all.data]);
  const live = items.filter((p) => p.status !== 'Archived');
  const mine = live.filter((p) => p.owner?.id === meId);
  const pinned = live.filter((p) => pins.isPinned(p.id));
  const scoped = scope === 'mine' ? mine : scope === 'pinned' ? pinned : scope === 'archived' ? items.filter((p) => p.status === 'Archived') : live;
  const found = scoped.filter((p) => !dq || `${p.name} ${p.key} ${p.owner?.name ?? ''}`.toLowerCase().includes(dq));
  const shown = mode === 'folders' ? [...found].sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))) : found;
  const needs = live.find((p) => healthOf(p).tone === 'bad') ?? live.find((p) => healthOf(p).tone === 'warn');
  const [sel, setSel] = useState<string | null>(null);
  const selected = shown.find((p) => p.id === sel) ?? (mode === 'folders' ? shown[0] : undefined);
  const [editing, setEditing] = useState<Project | null>(null);
  // "?new=1" (the command palette, an old link) opens the new-project sheet, then leaves the address clean.
  useEffect(() => { if (params.get('new') !== '1') return; set('new', null); requestAnimationFrame(() => openCalmNew({ type: 'project' })); }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const dots = (
    <DotsMenu label="More on Projects" items={[
      { label: 'Portfolio', hint: 'Summary, decisions, timeline and Plan sheet', icon: 'chart', onSelect: () => nav('/work/projects?view=portfolio') },
      { label: 'Plan sheet', icon: 'list', onSelect: () => nav('/work/projects?view=portfolio&mode=sheet') },
      { label: 'Project groups', icon: 'folder', onSelect: () => nav('/settings/timelines/project-groups') },
    ]} />
  );
  const tools = (
    <div className="cp-tools">
      {mode === 'list' ? (
        <CalmPills label="Projects" value={scope} onChange={(v) => set('scope', v === 'all' ? null : v)} options={[
          { value: 'all', label: `All ${live.length}` }, { value: 'mine', label: `Mine ${mine.length}` }, { value: 'pinned', label: `Pinned ${pinned.length}` }, { value: 'archived', label: 'Archived' }]} />
      ) : (
        <>
          <button type="button" className="pd-pill" onClick={() => set('scope', ({ all: 'mine', mine: 'pinned', pinned: 'archived', archived: null } as Record<Scope, string | null>)[scope])}><Icon name="filter" size={12} /> {scope === 'all' ? 'Filter' : scope[0].toUpperCase() + scope.slice(1)}</button>
          <button type="button" className="pd-pill" onClick={() => setSort(sort === 'recent' ? 'name' : 'recent')}>Sort: {sort === 'recent' ? 'Recent' : 'Name'}</button>
        </>
      )}
      <span className="cp-sp" />
      <label className="cp-search"><Icon name="search" size={13} /><input type="search" placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search projects" /></label>
      <CalmPills label="Show as" value={mode} onChange={(v) => set('browse', v === 'folders' ? 'folders' : null)} options={[{ value: 'list', label: <><Icon name="list" size={13} /> List</> }, { value: 'folders', label: <><Icon name="folder" size={13} /> Folders</> }]} />
      {canCreate && <button type="button" className="cp-go-sm" onClick={() => openCalmNew({ type: 'project' })}><Icon name="plus" size={13} /> New project</button>}
    </div>
  );
  const crumb = <><span>{mode === 'folders' ? <><Link to="/work/projects">Projects</Link> › Browse</> : 'Projects'}</span><span style={{ flex: 1 }} />
    <button type="button" className="cp-lk" onClick={() => set('browse', mode === 'folders' ? null : 'folders')}>{mode === 'folders' ? '‹ List' : 'Browse ›'}</button>{dots}</>;

  return (
    <CalmSplit className="cp-page" crumb={crumb} label="Projects">
      <header className={`cp-hero${mode === 'folders' ? ' sm' : ''}`}>
        {mode === 'folders' ? <h1>Browse projects.<em>Double-click a folder to open it.</em></h1>
          : <h1>{all.data ? `${live.length} project${live.length === 1 ? '' : 's'}.` : 'Projects.'}<em>{needs ? `${needs.name} needs you this week.` : live.length ? 'Everything is on track.' : 'Start your first one.'}</em></h1>}
      </header>
      {tools}
      {mode === 'list' ? (
        <>
          <CalmCard variant="flush" className="pj3-table" aria-label="Projects">
            <div className="pj3-head" aria-hidden="true"><span>Project</span><span>Owner</span><span>Progress</span><span>Next milestone</span><span>Health</span><span /></div>
            {all.isLoading ? <p className="mw2-empty">Loading projects…</p> : shown.length === 0 ? (
              <div className="mw2-empty">{dq || scope !== 'all' ? 'No projects match.' : 'No projects yet.'}{canCreate && !dq && <div style={{ marginTop: 14 }}><CalmGo onClick={() => openCalmNew({ type: 'project' })}>New project</CalmGo></div>}</div>
            ) : shown.map((p) => <ProjectRow key={p.id} p={p} pinned={pins.isPinned(p.id)} />)}
            {(all.data?.total ?? 0) > items.length && <p className="calm-week-note" style={{ padding: '6px 10px' }}>Showing the first {items.length} of {all.data!.total}. Search to find the others.</p>}
          </CalmCard>
          <Milestones projects={live} />
        </>
      ) : (
        <div className={`pj3-split${selected ? '' : ' solo'}`}>
          <div className="pj3-folders" role="listbox" aria-label="Project folders">
            {shown.map((p) => <Folder key={p.id} p={p} on={selected?.id === p.id} onPick={() => setSel(p.id)} onOpen={() => nav(`/work/projects/${p.id}`)} />)}
            {canCreate && <button type="button" className="pj3-folder add" onClick={() => openCalmNew({ type: 'project' })}><span className="fr"><b>+ New project</b><span>Blank or from a template</span></span></button>}
          </div>
          {selected && <InfoPanel p={selected} onClose={() => set('browse', null)} onEdit={() => setEditing(selected)} />}
        </div>
      )}
      <ProjectSheet open={!!editing} project={editing} onClose={() => setEditing(null)} />
    </CalmSplit>
  );
}

function ProjectRow({ p, pinned }: { p: Project; pinned: boolean }) {
  const h = healthOf(p);
  const c = projectColor(p.id);
  return (
    <Link to={`/work/projects/${p.id}`} className="pj3-row" data-testid="project-row" aria-label={`${p.name}, ${h.label}, ${p.progress}% done`}>
      <span className="pj3-name"><CalmDot color={c} /><b>{p.name}</b><small>{p.key}{pinned ? ' · Pinned' : ''}</small></span>
      <span className="pj3-own">{p.owner ? <><CalmAv name={p.owner.name} size={22} /><span>{p.owner.name}</span></> : <span className="calm-week-note">No owner</span>}</span>
      <span className="pj3-prog"><span className="calm-bar" style={{ '--calm-dot': c } as CSSProperties} role="progressbar" aria-valuenow={p.progress} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${p.progress}%` }} /></span>{p.progress}%</span>
      <span className="pj3-next">{p.dueDate ? <>{isFinished(p) ? 'Finished' : 'Due'} <small>· {shortDay(p.dueDate)}</small></> : <small>No date</small>}</span>
      <span className={`pj3-health ${h.tone}`}>{h.label}</span>
      <span className="pj3-chev" aria-hidden="true"><Icon name="chevronR" size={14} /></span>
    </Link>
  );
}

/** This week's milestones: each project due this week as a band on the Monday–Friday ribbon. */
function Milestones({ projects }: { projects: Project[] }) {
  const nav = useNavigate();
  const today = todayISO();
  const d = new Date(`${today}T00:00:00Z`);
  const monday = shiftIsoDate(today, -((d.getUTCDay() + 6) % 7));
  const days = Array.from({ length: 5 }, (_, i) => shiftIsoDate(monday, i));
  const due = projects.filter((p) => p.dueDate && p.dueDate >= monday && p.dueDate <= days[4]);
  if (!due.length) return null;
  const idx = (iso: string) => days.indexOf(iso);
  const segs: CalmSeg[] = due.map((p) => ({ key: p.id, start: idx(p.dueDate!), end: idx(p.dueDate!) + 1, label: p.name, color: `color-mix(in srgb, ${projectColor(p.id)} 28%, var(--calm-solid))`, onClick: () => nav(`/work/projects/${p.id}`) }));
  const nowIdx = idx(today) + Math.min(0.99, Math.max(0, (new Date().getHours() - 9) / 9));
  return (
    <div className="pj3-mile">
      <CalmSection aside={<Link className="cp-lk" to="/work/projects?view=portfolio&mode=timeline">Timeline ›</Link>}>This week’s milestones</CalmSection>
      <CalmDayRibbon segs={segs} from={0} to={5} now={idx(today) >= 0 ? nowIdx : null} label="This week’s milestones" />
      <div className="calm-day-hrs" aria-hidden="true" style={{ marginTop: -8 }}>{['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((l, i) => <span key={l} style={{ left: `${(i / 5) * 100}%`, transform: 'none' }}>{l}</span>)}</div>
    </div>
  );
}

function Folder({ p, on, onPick, onOpen }: { p: Project; on: boolean; onPick: () => void; onOpen: () => void }) {
  const c = projectColor(p.id);
  return (
    <button type="button" role="option" aria-selected={on} className={`pj3-folder${on ? ' on' : ''}`} style={{ '--pc': c } as CSSProperties} onClick={onPick} onDoubleClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onOpen(); } }} aria-label={`${p.name}, ${open(p)} open tasks. Enter opens it.`}>
      <i className="pp" aria-hidden="true" /><i className="pp p2" aria-hidden="true" />
      <span className="fr"><b><i className="dt" />{p.name}</b><span>{open(p)} open task{open(p) === 1 ? '' : 's'}</span><small>{p.progress}% done{p.dueDate ? ` · due ${shortDay(p.dueDate)}` : ''}</small></span>
    </button>
  );
}

function InfoPanel({ p, onClose, onEdit }: { p: Project; onClose: () => void; onEdit: () => void }) {
  const nav = useNavigate();
  const canEdit = useCan('projects.edit');
  const act = useWsQuery(['project', p.id, 'activity'], () => projectApi.activity(p.id), { staleTime: 60_000, retry: false });
  const h = healthOf(p);
  const c = projectColor(p.id);
  return (
    <CalmCard className="pj3-info" aria-label="Info">
      <h3>Info <button type="button" className="cp-lk" onClick={onClose} aria-label="Back to the list">»</button></h3>
      <div className="calm-card tile"><small>Tasks done</small><b>{p.progress}%</b><div className="calm-bar thin" style={{ '--calm-dot': c } as CSSProperties}><i style={{ width: `${p.progress}%` }} /></div></div>
      <h4>Properties</h4>
      <div className="pj3-props">
        <span>Owner</span><span>{p.owner?.name ?? '—'}</span>
        <span>Open tasks</span><span>{open(p)}</span>
        <span>Due</span><span>{p.dueDate ? shortDay(p.dueDate) : '—'}</span>
        <span>Health</span><span>{h.label}</span>
      </div>
      <h4>Activity</h4>
      {(act.data?.items ?? []).slice(0, 3).map((x) => <div key={x.id} className="calm-rr"><CalmAv name={x.actor?.name ?? 'System'} size={22} /><span className="calm-rr-t"><b style={{ fontWeight: 400 }}>{x.summary}</b></span></div>)}
      {act.data?.items?.length === 0 && <p className="calm-week-note">Nothing yet.</p>}
      <div className="acts"><CalmGo onClick={() => nav(`/work/projects/${p.id}`)}>Open project</CalmGo>{canEdit && <CalmLink onClick={onEdit}>Edit</CalmLink>}</div>
    </CalmCard>
  );
}
