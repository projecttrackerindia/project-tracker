import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import { ApiError, get, put } from '../../api/client';
import { savedViewApi, type SavedView } from '../../api/platformApi';
import '../../components/calm/calm-kit.css';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { DotsMenu, type DotsItem } from '../talk/DotsMenu';
import { portfolioApi, type PlanSheet, type SheetRow } from './portfolioApi';
import { CommandField } from './portfolioCommand';
import { interpret, isWork, matchesAll, DUE_LABEL, type QueryCtx, type Tok } from './planSheetQuery';
import { ColourFilter, TabStrip, useTabPrefs, type Colour, type TabPrefs } from './planSheetTabs';
import { needsReview, useActionReview } from './planSheetActions';
import {
  MODE_LABEL, MODES, portfolioKeys, projectColour, projectPasses, sheetProjects, usePortfolioUrl, type PortfolioUrlState, type ProjectLike, type SheetLayout,
} from './portfolioShared';
import './planSheet.css';
import './planSheetTabs.css';
import './portfolioShell.css';
import './portfolioCalm.css';
import { PortfolioViewsBar } from './PortfolioSavedViews';
import { zoneToday } from '../../lib/zone';
export { PortfolioSkeleton } from './portfolioSkeleton';

/**
 * Portfolio's one shell (design plansheet4–8, the approved standard), the same on every tab: "Portfolio" and the tab's title with Board · Timeline ·
 * Plan sheet · Capacity · Present inline, who else is here and ⋯; the project folder tabs with the fixed Action items tab; then one tinted page with
 * the single command field (tokens, saved views), the colour filter and the tab's own tools, and the tab itself, which fades in the same way on every
 * switch and fills the window to the bottom. The filter lives in the address (portfolioShared), the data in one key family, the colours in one place.
 */

interface ShellSlots { tools: HTMLElement | null; presence: HTMLElement | null }
export interface PortfolioCtxValue {
  url: PortfolioUrlState; sheet: UseQueryResult<PlanSheet, Error>; projects: SheetRow[]; work: SheetRow[]; people: { id: string; name: string }[];
  today: string; me: string | null; qctx: QueryCtx; text: string; setText: (t: string) => void; interpreted: Tok[];
  /** Tokens typed and committed (what the tabs filter by), plus the project folder tab on the project tabs. */ active: Tok[];
  colourOf: (projectId: string) => Colour; tabPrefs: TabPrefs; saveTabs: (p: TabPrefs) => void; review: ReturnType<typeof useActionReview>;
  /** The grey second line of the title; a tab may set its own (useShellLine). */ setLine: (l: string | null) => void;
  phone: boolean; slots: ShellSlots; setTabMenu: (items: DotsItem[]) => void; activeView: string | null; defaultView: string | null; setDefaultView: (id: string | null) => Promise<void>;
  /** Whether a project passes the field, the colour filter and the folder tab (Board, Timeline, Present, Capacity). */ passes: (p: ProjectLike) => boolean;
}
const Ctx = createContext<PortfolioCtxValue | null>(null);
export function usePortfolio(): PortfolioCtxValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePortfolio outside PortfolioShell');
  return v;
}

/** A project's colour (the Plan sheet tab colours) for parts that may also be drawn outside the shell. */
export function useProjectColour(): (projectId: string) => Colour {
  const v = useContext(Ctx);
  return v?.colourOf ?? ((id: string) => projectColour({ pins: [], colors: {}, hidden: [], names: {} }, [], id));
}
/** Whether a project passes the shared filter; everything passes outside the shell. */
export function useProjectFilter(): (p: ProjectLike) => boolean {
  const v = useContext(Ctx);
  return v?.passes ?? (() => true);
}

export function usePhone() {
  const q = '(max-width: 760px)';
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => { const m = window.matchMedia(q); const on = () => setPhone(m.matches); m.addEventListener('change', on); return () => m.removeEventListener('change', on); }, []);
  return phone;
}

/** The tab's own controls, drawn in the shell's command row (after the field and the colour filter). */
export function ShellTools({ children }: { children: ReactNode }) {
  const { slots } = usePortfolio();
  return slots.tools ? createPortal(children, slots.tools) : null;
}
/** Who else is here, drawn in the shell's head. */
export function ShellPresence({ children }: { children: ReactNode }) {
  const { slots } = usePortfolio();
  return slots.presence ? createPortal(children, slots.presence) : null;
}
/** The tab's own second line under the title ("Sofia is over, Tom has room."). */
export function useShellLine(line: string | null) {
  const { setLine } = usePortfolio();
  useEffect(() => { setLine(line); }, [line, setLine]);
  useEffect(() => () => setLine(null), [setLine]);
}
/** The ISO week number of a date. */
export function weekNo(isoDay: string): number {
  const d = new Date(`${isoDay}T00:00:00Z`); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3);
  const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 4)); return 1 + Math.round(((d.getTime() - y.getTime()) / 86_400_000 - 3 + ((y.getUTCDay() + 6) % 7)) / 7);
}
const firstWord = (t: string) => t.split(/\s+/)[0] ?? t;
const fmtDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).replace(/(\d+) (\w+)/, '$2 $1');

/** The tab's own ⋯ items, listed above the Portfolio's. */
export function useShellMenu(items: DotsItem[]) {
  const { setTabMenu } = usePortfolio();
  // Handed up only when what the menu shows changes; a choice always runs the tab's latest handler.
  const latest = useRef(items);
  useEffect(() => { latest.current = items; });
  const sig = items.map((i) => `${i.label}|${i.hint ?? ''}|${i.icon ?? ''}|${i.hidden ? 1 : 0}`).join('\n');
  useEffect(() => {
    setTabMenu(latest.current.map((it, k) => ({ ...it, onSelect: () => latest.current[k]?.onSelect() })));
  }, [sig, setTabMenu]);
  useEffect(() => () => setTabMenu([]), [setTabMenu]);
}

const HEALTH_OF: Record<string, string> = { Delayed: 'Delayed', AtRisk: 'AtRisk', OnTrack: 'OnTrack', Done: 'Completed' };
interface Prefs { defaultView?: string | null }

export function PortfolioShell({ teamId, baseMenu, filters, children }: {
  teamId: string | null | undefined; baseMenu: (url: PortfolioUrlState) => DotsItem[]; filters?: (url: PortfolioUrlState) => ReactNode; children: (ctx: PortfolioCtxValue) => ReactNode;
}) {
  const url = usePortfolioUrl(teamId);
  const { mode, filter, toks, colours, tab } = url;
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx?.user?.id) ?? null;
  const phone = usePhone();
  const [params, setParams] = useSearchParams();
  // One dataset for the shell and the Plan sheet: its projects (the folder tabs, the colours), people and tasks (the field's suggestions and counts).
  const sheet = useWsQuery(portfolioKeys.sheet(filter), () => portfolioApi.sheet(filter), { staleTime: 30_000, placeholderData: (p) => p });
  const data = sheet.data && !Array.isArray(sheet.data) ? sheet.data : undefined;
  const today = data?.asOf ?? zoneToday();
  const projects = useMemo(() => sheetProjects(data), [data]);
  const work = useMemo(() => (data?.rows ?? []).filter(isWork), [data]);
  const people = useMemo(() => data?.people ?? [], [data]);
  const [text, setText] = useState('');
  const interpreted = useMemo(() => (text.trim() ? interpret(text, people, projects.map((p) => ({ id: p.id, title: p.title, key: p.key }))) : []), [text, people, projects]);
  const typed = useMemo(() => [...toks, ...interpreted], [toks, interpreted]);
  const qctx = useMemo(() => ({ today, me }), [today, me]);
  const { prefs: tabPrefs, save: saveTabs } = useTabPrefs();
  const colourOf = useCallback((id: string) => projectColour(tabPrefs, projects, id), [tabPrefs, projects]);
  const review = useActionReview(mode === 'sheet' || mode === 'actions' || mode === 'overview');
  const [tabLine, setLine] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [slots, setSlots] = useState<ShellSlots>({ tools: null, presence: null });
  const toolsRef = useCallback((el: HTMLElement | null) => setSlots((s) => (s.tools === el ? s : { ...s, tools: el })), []);
  const presenceRef = useCallback((el: HTMLElement | null) => setSlots((s) => (s.presence === el ? s : { ...s, presence: el })), []);
  const [tabMenu, setTabMenu] = useState<DotsItem[]>([]);
  // Full height: the tinted page reaches the window's bottom on every tab (the Plan sheet's grid sizes itself the same way).
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = pageRef.current; if (!el) return;
    // The app pads its content's end for the Aura bar; the Portfolio draws its own page under the bar, so it takes that space back and the
    // window itself never scrolls when a tab fits (the Plan sheet's grid and the Timeline scroll inside themselves).
    const host = el.closest<HTMLElement>('.pf-shell');
    const fit = () => {
      if (host?.parentElement) host.style.marginBottom = `-${parseFloat(getComputedStyle(host.parentElement).paddingBottom) || 0}px`;
      const top = el.getBoundingClientRect().top + window.scrollY;
      el.style.setProperty('--pfx-fill', `${Math.max(320, window.innerHeight - top)}px`);
    };
    fit();
    window.addEventListener('resize', fit);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit); ro?.observe(document.body);
    return () => { window.removeEventListener('resize', fit); ro?.disconnect(); };
  }, [mode, phone]);
  // Colour filter from a tab's own menu ("Filter to this colour").
  const { setColours } = url;
  useEffect(() => { const on = (e: Event) => setColours((e as CustomEvent<Colour[]>).detail); window.addEventListener('ps4-colour', on); return () => window.removeEventListener('ps4-colour', on); }, [setColours]);

  // ---- saved views (the field's ★ list): tokens and the sheet layout
  const views = useWsQuery(['saved-views', 'portfolio'], () => savedViewApi.list('portfolio'), { staleTime: 60_000, retry: false });
  const prefs = useWsQuery(['ui', 'plansheet'], async () => { try { return (await get<{ value: Prefs | null }>('/me/ui/plansheet'))?.value ?? {}; } catch { return {}; } }, { staleTime: 300_000 });
  const sheetViews = useMemo(() => (Array.isArray(views.data) ? views.data : []).filter((v) => v.config.list === 'sheet'), [views.data]);
  const [activeView, setActiveView] = useState<string | null>(null);
  const applyView = useCallback((v: SavedView) => {
    const c = v.config as { tokens?: Tok[]; layout?: SheetLayout | 'grid' | 'gridTimeline'; filters?: { ownerMe?: boolean; lateOnly?: boolean; notDone?: boolean; due30?: boolean } };
    const t: Tok[] = [...(c.tokens ?? [])];
    if (!c.tokens && c.filters) {
      if (c.filters.ownerMe) t.push({ kind: 'owner', value: 'me', label: 'Me' });
      if (c.filters.lateOnly) t.push({ kind: 'status', value: 'late', label: 'Late' });
      if (c.filters.notDone) t.push({ kind: 'status', value: 'open', label: 'Not done' });
      if (c.filters.due30) t.push({ kind: 'due', value: 'next-30', label: DUE_LABEL['next-30'] });
    }
    url.setToks(t); setText('');
    url.setLayout(c.layout === 'gridTimeline' ? 'split' : c.layout === 'split' || c.layout === 'timeline' ? c.layout : 'sheet');
    setActiveView(v.id);
  }, [url]);
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current || !views.data || !prefs.data) return;
    const id = params.get('v') ?? prefs.data.defaultView ?? null;
    const v = sheetViews.find((x) => x.id === id);
    applied.current = true;
    if (v) applyView(v);
  }, [views.data, prefs.data, sheetViews, params, applyView]);
  const saveView = async (name: string) => {
    try {
      const v = await savedViewApi.create({ scope: 'portfolio', name, sharing: 'private', config: { list: 'sheet', tokens: typed, layout: url.layout } });
      url.setToks(typed); setText(''); setActiveView(v.id); void invalidateWorkspace(wid, 'saved-views'); toast(`Saved the view “${name}”.`);
      setParams((cur) => { const n = new URLSearchParams(cur); n.set('v', v.id); return n; }, { replace: true });
    } catch (e) { toast(e instanceof ApiError ? e.message : 'The view could not be saved.', 'error'); }
  };
  const setDefaultView = useCallback(async (id: string | null) => {
    try { await put('/me/ui/plansheet', { value: { ...(prefs.data ?? {}), defaultView: id } }); void prefs.refetch(); toast(id ? 'This view now opens first.' : 'No default view.'); }
    catch { toast('Could not set the default view.', 'error'); }
  }, [prefs]);

  // ---- what the field means on each tab
  const onProjectTab = mode !== 'sheet';
  // The folder tabs belong to the Plan sheet (design #portfolio): on the other tabs a folder left in the address does not filter.
  const folderProject = mode === 'sheet' && tab && tab !== 'actions' && projects.some((p) => p.id === tab) ? tab : null;
  const active = useMemo(() => (onProjectTab && folderProject && !typed.some((t) => t.kind === 'project' && t.value === folderProject)
    ? [...typed, { kind: 'project' as const, value: folderProject, label: projects.find((p) => p.id === folderProject)?.title ?? '' }] : typed), [onProjectTab, folderProject, typed, projects]);
  const passes = useCallback((p: ProjectLike) => (!colours.length || colours.includes(colourOf(p.id))) && projectPasses(p, active, qctx, work), [colours, colourOf, active, qctx, work]);
  const projectLikes = useMemo(() => projects.map((p) => ({ id: p.id, name: p.title, key: p.key, ownerId: p.ownerId, owner: p.owner, due: p.due, health: HEALTH_OF[p.category] ?? 'OnTrack' })), [projects]);
  const matchingTasks = useMemo(() => work.filter((r) => matchesAll(r, typed, qctx)).length, [work, typed, qctx]);
  const counts = useMemo(() => { const m = new Map<string, number>(); for (const r of work) m.set(r.projectId, (m.get(r.projectId) ?? 0) + 1); return m; }, [work]);
  const reviewItems = review.data?.items ?? [];
  const actionCount = review.data ? reviewItems.filter((i) => i.state !== 'done' && i.state !== 'cancelled').length : null;
  const filtering = typed.length > 0 || colours.length > 0 || !!folderProject;
  const nProjects = projectLikes.filter(passes).length;
  const countText = (mode === 'sheet' && tab === 'actions') || mode === 'actions'
    ? `${reviewItems.length} items${reviewItems.some((i) => needsReview(i)) ? ` · ${reviewItems.filter((i) => needsReview(i)).length} to review` : ''}`
    : mode === 'sheet' ? undefined
    : mode === 'capacity' ? `${people.length} people`
    : phone ? (filtering ? nProjects : projects.length) : filtering ? `${nProjects} of ${projects.length} projects` : `${projects.length} projects`;

  const pick = (t: string | null) => {
    // Action items live on the Plan sheet: picking them from another tab goes there.
    if (t === 'actions' && mode !== 'sheet') { setParams((cur) => { const n = new URLSearchParams(cur); n.set('view', 'portfolio'); n.set('mode', 'sheet'); n.set('pt', 'actions'); return n; }); return; }
    url.setTab(t);
  };
  const tabOrder0 = 'actions';
  // The calm Plan sheet (the approved design) draws its own folder tabs and page; ?classic=1 is the full sheet with every tool.
  const classic = mode === 'sheet' && params.get('classic') === '1';
  const pageColour: Colour | 'ai' | 'none' = mode === 'sheet' && tab === 'actions' ? 'ai' : folderProject ? colourOf(folderProject) : 'none';
  // ---- the calm title: one sentence and a grey second line, from the real data (a tab can set its own second line)
  const atRisk = projects.filter((p) => p.category === 'AtRisk' || p.category === 'Delayed');
  const openWork = (pid?: string) => work.filter((r) => (!pid || r.projectId === pid) && r.category !== 'Done');
  const blocked = (pid?: string) => openWork(pid).filter((r) => r.late).length;
  const decisionN = reviewItems.filter((i) => needsReview(i)).length;
  const fp = folderProject ? projects.find((p) => p.id === folderProject) : null;
  const latest = [...projects].filter((p) => p.due).sort((a, b) => (b.due ?? '').localeCompare(a.due ?? ''))[0];
  const inReview = openWork().filter((r) => /review/i.test(r.status)).length;
  const head: [string, string] = mode === 'overview'
    ? atRisk.length === 0 ? (projects.length ? ['Everything is on track.', `${projects.length} projects this week.`] : ['Portfolio.', 'No projects yet.'])
      : atRisk.length === 1 ? [`${firstWord(atRisk[0]!.title)} is at risk.`, projects.length > 1 ? 'Everything else is on track.' : 'Its plan needs a look.']
      : [`${atRisk.length} projects are at risk.`, `${atRisk.slice(0, 2).map((p) => firstWord(p.title)).join(' and ')} need a look.`]
    : mode === 'actions' ? [`${reviewItems.length} action item${reviewItems.length === 1 ? '' : 's'}.`, decisionN ? `${decisionN} need${decisionN === 1 ? 's' : ''} a decision.` : 'Nothing waits on a decision.']
    : mode === 'sheet' ? ['Plan sheet.', fp ? `${firstWord(tabPrefs.names[fp.id] || fp.title)} · ${openWork(fp.id).length} open, ${blocked(fp.id)} late.` : tab === 'actions' ? 'Action items first.' : `${projects.length} projects · ${openWork().length} open.`]
    : mode === 'timeline' ? ['Timeline.', latest?.due ? `${firstWord(latest.title)} drives ${fmtDay(latest.due)}.` : 'No dates yet.']
    : mode === 'capacity' ? ['Load', phone ? 'Next 2 weeks.' : 'Next 2 weeks · assigned work + meetings + leave']
    : mode === 'board' ? ['Board.', `${inReview} in review, ${blocked()} late.`]
    : ['Present.', `Week ${weekNo(today)}.`];
  const second = tabLine ?? head[1];
  const onPills = mode === 'present' ? 'overview' : mode;

  const value: PortfolioCtxValue = {
    url, sheet, projects, work, people, today, me, qctx, text, setText, interpreted, active, colourOf, tabPrefs, saveTabs, review, phone, slots, setTabMenu,
    activeView, defaultView: prefs.data?.defaultView ?? null, setDefaultView, passes, setLine,
  };
  const field = (
    <CommandField toks={toks} setToks={(t) => { url.setToks(t); setActiveView(null); }} text={text} setText={(t) => { setText(t); if (t) setActiveView(null); }} interpreted={interpreted}
      count={matchingTasks} total={work.length} filtering={typed.length > 0} people={people} projects={projects} work={work} ctx={qctx} compact={phone}
      views={sheetViews} activeView={activeView} defaultView={prefs.data?.defaultView ?? null} onApplyView={applyView} onSaveView={(n) => void saveView(n)}
      countText={countText} {...((mode === 'sheet' && tab === 'actions') || mode === 'actions' ? { label: 'Search action items', placeholder: 'Search action items' } : {})} />
  );
  const swatch = <ColourFilter on={colours} set={url.setColours} />;
  const menu = [...(classic ? [{ label: 'Back to the plan sheet', icon: 'list' as const, onSelect: () => setParams((cur) => { const n = new URLSearchParams(cur); n.delete('classic'); return n; }) }] : []), ...tabMenu, ...baseMenu(url)];
  return (
    <Ctx.Provider value={value}>
      <div className={`ps3 ps4 pfx pfc ${phone ? 'ps3-phone pfx-phone' : ''}`} data-mode={mode}>
        <header className="pfc-head">
          <div className="pfc-crumb">Portfolio{mode !== 'overview' && <> › {MODE_LABEL[mode]}</>}</div>
          <h1 className="pfc-title">{head[0]}<em>{second}</em></h1>
        </header>
        <div className="pfc-bar">
          <div className="calm-pills pfc-pills" role="tablist" aria-label="Portfolio view">
            {MODES.map((m) => <button key={m} type="button" role="tab" aria-selected={m === onPills} onClick={() => url.setMode(m)}>{MODE_LABEL[m]}</button>)}
          </div>
          <span className="ps3-sp" />
          <span className="pfx-presence" ref={presenceRef} />
          {!classic && mode !== 'sheet' && mode !== 'present' && <button type="button" className="pfc-find" aria-label="Search and filter" aria-pressed={findOpen} onClick={() => setFindOpen((x) => !x)}>⌕</button>}
          <DotsMenu label={mode === 'sheet' ? 'More on the plan sheet' : 'More on Portfolio'} items={menu} />
          {!phone && <button type="button" className="pfc-week" onClick={() => url.setMode('present')} title="Present the week">Week {weekNo(today)} ›</button>}
        </div>
        {mode !== 'present' && <PortfolioViewsBar url={url} />}
        {classic && <TabStrip projects={projects} counts={counts} actionCount={actionCount} active={tab} onPick={pick} prefs={tabPrefs} save={saveTabs} compact={phone} />}
        <div ref={pageRef} className={`ps4-page pfx-page pc-${pageColour} ${mode === 'sheet' && (tab || folderProject) ? 'tabbed' : ''} ${mode === 'sheet' && tab === tabOrder0 ? 'first' : ''} ${classic ? 'pfc-sheetpage' : 'pfc-plain'}`}>
          {/* The field shows on Overview only while a filter is on, so an active filter is never invisible. */}
          {/* The calm tabs show no field bar (design #portfolio): it opens from the search icon, and stays while a filter is on. The full sheet always has it. */}
          {mode !== 'present' && (classic || (mode !== 'sheet' && (findOpen || toks.length > 0 || colours.length > 0))) && <>
            <div className="ps3-cmdrow pfx-cmdrow">{field}{!phone && swatch}<span className="pfx-tools" ref={toolsRef} /></div>
            {phone && <div className="ps3-cmdrow pfx-cmdrow2">{swatch}</div>}
          </>}
          {filters?.(url)}
          <div key={`${mode}:${mode === 'sheet' ? tab ?? '' : ''}`} className="pfx-stage">{children(value)}</div>
        </div>
      </div>
    </Ctx.Provider>
  );
}
