import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, get, put } from '../../api/client';
import { resourcesApi } from '../../api/endpoints';
import { savedViewApi, type SavedView } from '../../api/platformApi';
import { openPalette } from '../../components/CommandPalette';
import { registerPaletteCommands } from '../../components/paletteRegistry';
import { ErrorState, PageLoader } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { hubInvoke, isLiveConnected, onLiveConnected, onSheetFocus, onViewing } from '../live/bus';
import { DotsMenu, type DotsItem } from '../talk/DotsMenu';
import { dueChange } from './DueChangeFields';
import { portfolioApi, type PlanSheet as PlanSheetData, type PortfolioFilter, type SheetChange, type SheetRow, type SheetStatus } from './portfolioApi';
import { addDays, dayNum, dm, isOpen, parseTsv } from './planSheet';
import {
  checklistPct, DUE_LABEL, estimateLoad, interpret, isWork, matchesAll, slipDays, STATUS_KEYS, STATUS_LABEL, statusKey, weekLabel, weekStart,
  type DueKey, type Load, type StatusKey, type Tok,
} from './planSheetQuery';
import { Av, Dot, Floating, NoteText, Owner, personColor, Progress, Ring, Status } from './planSheetParts';
import { DateEditor, NotesEditor, PeoplePicker, ProgressEditor, StatusPicker } from './planSheetEditors';
import { PasteModal } from './planSheetPaste';
import { Inspector, type EditCol, type LinkedMeeting } from './planSheetInspector';
import { ReasonModal } from './planSheetReason';
import './planSheet.css';

type Layout = 'sheet' | 'split' | 'timeline';
type ColId = 'task' | 'owner' | 'dates' | 'due' | 'status' | 'progress' | 'notes' | 'gantt';
const COLS: Record<'sheet' | 'narrow' | 'split' | 'timeline', [ColId, string, number][]> = {
  sheet: [['task', 'Task', 33], ['owner', 'Owner', 13], ['dates', 'Dates', 13], ['status', 'Status', 10], ['progress', 'Progress', 12], ['notes', 'Notes', 19]],
  narrow: [['task', 'Task', 46], ['owner', 'Owner', 20], ['due', 'Due', 15], ['status', 'Status', 19]],
  split: [['task', 'Task', 30], ['owner', 'Owner', 14], ['dates', 'Dates', 14], ['status', 'Status', 11], ['gantt', 'Timeline', 31]],
  timeline: [['task', 'Task', 30], ['gantt', 'Timeline', 70]],
};
const EDITOR_OF: Partial<Record<ColId, EditCol>> = { owner: 'owner', dates: 'dates', due: 'dates', status: 'status', progress: 'progress', notes: 'notes' };
const FILLABLE: ColId[] = ['owner', 'dates', 'due', 'status', 'progress'];
const REASON_UNDO = 'Undone on the plan sheet';
const EXPORT_COLUMNS = ['Key', 'Title', 'Owner', 'Start', 'Due', 'Status', 'Progress', 'Depends on', 'Notes'];

interface EditEntry { id: number; label: string; at: number; count: number; inverse: SheetChange[] | null; move?: { id: string; projectId: string; afterId: string | null; beforeId: string | null } }
type Display = { type: 'g'; p: SheetRow; all: SheetRow[]; shown: number } | { type: 'r'; r: SheetRow; level: number };
interface Prefs { defaultView?: string | null }

function usePhone() {
  const q = '(max-width: 760px)';
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => { const m = window.matchMedia(q); const on = () => setPhone(m.matches); m.addEventListener('change', on); return () => m.removeEventListener('change', on); }, []);
  return phone;
}
const editableTarget = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]');

/**
 * Portfolio › Plan sheet: every project with its tasks in one full-width grid. One command field filters it (owner:, status:, due:, project: or a
 * plain sentence that Aura reads into tokens) and keeps saved views; Paste, Export and Present sit under ⋯ and in ⌘K. Cells open rich editors
 * (a calendar with slip and knock-on, people with their weekly load, status, a progress slider, notes with @mentions); the fill handle drags a
 * value down a column (with a smart fill from checklists); every edit can be undone (⌘Z) from the toast. A task opens the inspector on the
 * right; rows drag to a new place or into another project; others on the sheet show live. On a phone each project is a card.
 */
export function PlanSheetView({ filter, tabs, extraMenu, onPresent }: { filter: PortfolioFilter; tabs: ReactNode; extraMenu: DotsItem[]; onPresent: () => void }) {
  const phone = usePhone();
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx?.user?.id) ?? null;
  const [params, setParams] = useSearchParams();
  const q = useWsQuery(['portfolio', 'sheet', filter], () => portfolioApi.sheet(filter), { staleTime: 30_000, placeholderData: (p) => p });
  const data = q.data;
  const today = data?.asOf ?? new Date().toISOString().slice(0, 10);
  const [toks, setToks] = useState<Tok[]>([]);
  const [text, setText] = useState('');
  const [layout, setLayout] = useState<Layout>('sheet');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Map<string, Partial<SheetRow>>>(new Map());
  const [inspect, setInspect] = useState<string | null>(null);
  const [paste, setPaste] = useState<string[][] | null>(null);
  const [reasonAsk, setReasonAsk] = useState<{ changes: SheetChange[]; label: string; moves: { key: string; from: string; to: string; days: number | null }[] } | null>(null);
  const [edits, setEdits] = useState<EditEntry[]>([]);
  const [toastAt, setToastAt] = useState<{ text: string; at: number; undo: boolean } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [warn, setWarn] = useState<string | null>(null);
  const views = useWsQuery(['saved-views', 'portfolio'], () => savedViewApi.list('portfolio'), { staleTime: 60_000, retry: false });
  const prefs = useWsQuery(['ui', 'plansheet'], async () => { try { return (await get<{ value: Prefs | null }>('/me/ui/plansheet'))?.value ?? {}; } catch { return {}; } }, { staleTime: 300_000 });
  const sheetViews = useMemo(() => (views.data ?? []).filter((v) => v.config.list === 'sheet'), [views.data]);
  const [activeView, setActiveView] = useState<string | null>(null);

  const rows = useMemo(() => (data?.rows ?? []).map((r) => { const o = overrides.get(r.id); return o ? { ...r, ...o } : r; }), [data, overrides]);
  const projects = useMemo(() => rows.filter((r) => r.kind === 'project'), [rows]);
  const work = useMemo(() => rows.filter(isWork), [rows]);
  const people = useMemo(() => data?.people ?? [], [data]);
  const interpreted = useMemo(() => (text.trim() ? interpret(text, people, projects) : []), [text, people, projects]);
  const active = useMemo(() => [...toks, ...interpreted], [toks, interpreted]);
  const ctx = useMemo(() => ({ today, me }), [today, me]);
  const matching = useMemo(() => work.filter((r) => matchesAll(r, active, ctx)), [work, active, ctx]);
  const statusesBy = useMemo(() => { const m = new Map<string, SheetStatus[]>(); for (const s of data?.statuses ?? []) m.set(s.projectId, [...(m.get(s.projectId) ?? []), s]); return m; }, [data]);

  // Each project's next meeting: shown in the inspector of its tasks and under the open task due first (the one the meeting will look at).
  const meetings = useMemo(() => {
    const byProject = new Map<string, LinkedMeeting>(), byTask = new Map<string, LinkedMeeting>();
    for (const p of projects) {
      const m = rows.filter((r) => r.kind === 'meeting' && r.projectId === p.id && r.nextAt).sort((a, b) => Date.parse(a.nextAt!) - Date.parse(b.nextAt!))[0];
      if (!m) continue;
      const lm = { title: m.title, nextAt: m.nextAt, cadence: m.cadence };
      byProject.set(p.id, lm);
      const first = work.filter((r) => r.projectId === p.id && isOpen(r) && r.due).sort((a, b) => dayNum(a.due!) - dayNum(b.due!))[0];
      if (first) byTask.set(first.id, lm);
    }
    return { byProject, byTask };
  }, [projects, rows, work]);

  const display: Display[] = useMemo(() => {
    const out: Display[] = [];
    const on = active.length > 0;
    const pass = new Set(matching.map((r) => r.id));
    for (const p of projects) {
      const all = work.filter((r) => r.projectId === p.id);
      const shown = new Set(all.filter((r) => pass.has(r.id)).map((r) => r.id));
      for (const r of all) if (shown.has(r.id) && r.parentId) shown.add(r.parentId);
      if (on && shown.size === 0) continue;
      out.push({ type: 'g', p, all, shown: on ? shown.size : all.length });
      if (collapsed.has(p.id)) continue;
      for (const r of all) if (!on || shown.has(r.id)) out.push({ type: 'r', r, level: r.kind === 'subtask' ? 1 : 0 });
    }
    return out;
  }, [projects, work, matching, active.length, collapsed]);

  // ---- views
  const applyView = useCallback((v: SavedView) => {
    const c = v.config as { tokens?: Tok[]; layout?: Layout | 'grid' | 'gridTimeline'; filters?: { ownerMe?: boolean; lateOnly?: boolean; notDone?: boolean; due30?: boolean } };
    const t: Tok[] = c.tokens ?? [];
    if (!c.tokens && c.filters) {
      if (c.filters.ownerMe) t.push({ kind: 'owner', value: 'me', label: 'Me' });
      if (c.filters.lateOnly) t.push({ kind: 'status', value: 'late', label: 'Late' });
      if (c.filters.notDone) t.push({ kind: 'status', value: 'open', label: 'Not done' });
      if (c.filters.due30) t.push({ kind: 'due', value: 'next-30', label: DUE_LABEL['next-30'] });
    }
    setToks(t); setText('');
    setLayout(c.layout === 'gridTimeline' ? 'split' : c.layout === 'split' || c.layout === 'timeline' ? c.layout : 'sheet');
    setActiveView(v.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only setters (the linter reads `c.layout` as the `layout` state)
  }, []);
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
      const v = await savedViewApi.create({ scope: 'portfolio', name, sharing: 'private', config: { list: 'sheet', tokens: active, layout } });
      setActiveView(v.id); setToks(active); setText(''); void invalidateWorkspace(wid, 'saved-views'); toast(`Saved the view “${name}”.`);
      const n = new URLSearchParams(params); n.set('v', v.id); setParams(n, { replace: true });
    } catch (e) { toast(e instanceof ApiError ? e.message : 'The view could not be saved.', 'error'); }
  };
  const setDefault = async (id: string | null) => {
    try { await put('/me/ui/plansheet', { value: { ...(prefs.data ?? {}), defaultView: id } }); void prefs.refetch(); toast(id ? 'This view now opens first.' : 'No default view.'); }
    catch { toast('Could not set the default view.', 'error'); }
  };

  // ---- saving: optimistic through the bulk endpoint (one row at a time on the server), one reason for later due dates, and an undo entry
  const nameOf = useCallback((id: string | null | undefined) => people.find((p) => p.id === id)?.name ?? null, [people]);
  const inverseOf = (r: SheetRow, c: SheetChange): SheetChange => {
    const inv: SheetChange = { id: r.id };
    if (c.assigneeId || c.unassign) { if (r.ownerId) inv.assigneeId = r.ownerId; else inv.unassign = true; }
    if (c.startDate || c.clearStart) { if (r.start) inv.startDate = r.start; else inv.clearStart = true; }
    if (c.dueDate && r.due) inv.dueDate = r.due;
    if (c.dueTime) { if (r.dueTime) inv.dueTime = r.dueTime; else inv.clearDueTime = true; }
    if (c.statusId && r.statusId) inv.statusId = r.statusId;
    if (c.title !== undefined) inv.title = r.title;
    if (c.progress !== undefined || c.clearProgress) { if (r.manualProgress && r.progress != null) inv.progress = r.progress; else inv.clearProgress = true; }
    if (c.notes !== undefined) inv.notes = r.notes ?? '';
    return inv;
  };
  const pushEdit = (e: Omit<EditEntry, 'id' | 'at'>) => {
    const at = Date.now();
    setEdits((list) => [{ ...e, id: at + Math.random(), at }, ...list].slice(0, 30));
    setToastAt({ text: e.label, at, undo: true });
  };
  const save = useCallback(async (changes: SheetChange[], label: string, opts: { reason?: string; dependency?: string; undo?: boolean } = {}) => {
    if (!data || changes.length === 0) return;
    if (opts.reason === undefined) {
      const moves = changes.flatMap((c) => {
        const r = rows.find((x) => x.id === c.id); if (!r || !c.dueDate) return [];
        const d = dueChange(r.due, c.dueDate);
        return d?.delay ? [{ key: r.key, from: r.due!, to: c.dueDate, days: d.days ?? 0 }] : [];
      });
      if (moves.length) { setReasonAsk({ changes, label, moves }); return; }
    }
    const before = new Map(rows.map((r) => [r.id, r]));
    const patch = new Map(overrides);
    for (const c of changes) {
      const r = before.get(c.id); if (!r) continue;
      const o: Partial<SheetRow> = { ...(patch.get(c.id) ?? {}) };
      if (c.title !== undefined) o.title = c.title;
      if (c.unassign) { o.ownerId = null; o.owner = null; }
      if (c.assigneeId) { o.ownerId = c.assigneeId; o.owner = nameOf(c.assigneeId); }
      if (c.startDate) o.start = c.startDate;
      if (c.clearStart) o.start = null;
      if (c.dueDate) { o.due = c.dueDate; o.late = isOpen(r) && dayNum(c.dueDate) < dayNum(today); }
      if (c.statusId) { const s = data.statuses.find((x) => x.id === c.statusId); if (s) { o.statusId = s.id; o.status = s.name; o.category = s.category; if (s.category === 'Done') { o.late = false; o.atRisk = false; o.progress = 100; } } }
      if (c.progress !== undefined) { o.progress = c.progress; o.manualProgress = true; }
      if (c.notes !== undefined) o.notes = c.notes || null;
      patch.set(c.id, o);
    }
    setOverrides(patch);
    try {
      const withVersions = changes.map((c) => ({ ...c, version: c.version ?? before.get(c.id)?.version }));
      const res = await portfolioApi.sheetBulk(withVersions, opts.reason, opts.dependency);
      const failed = res.rows.filter((x) => !x.ok);
      const ok = new Set(res.rows.filter((x) => x.ok).map((x) => x.id));
      if (failed.length) {
        const first = failed[0];
        toast(failed.length === 1 ? `${first.key ?? 'A row'}: ${first.error ?? 'not saved'}` : `${res.changed} saved · ${failed.length} not saved (${first.key ?? 'a row'}: ${first.error})`, 'error');
      }
      if (res.changed) {
        if (opts.undo) setToastAt({ text: `Undone · ${label}`, at: Date.now(), undo: false });
        else pushEdit({ label, count: res.changed, inverse: changes.filter((c) => ok.has(c.id)).map((c) => inverseOf(before.get(c.id)!, c)) });
      }
      await q.refetch();
      setOverrides(new Map());
    } catch (e) {
      setOverrides(new Map(overrides));
      toast(e instanceof ApiError ? e.message : 'The change could not be saved.', 'error');
    }
  }, [data, rows, overrides, nameOf, today, q]);

  const move = useCallback(async (m: { id: string; projectId: string; afterId: string | null; beforeId: string | null }, undo = false) => {
    const r = rows.find((x) => x.id === m.id); if (!r) return;
    // Where it was, for Undo: its neighbours among the top-level tasks of its project.
    const sibs = rows.filter((x) => x.kind === 'task' && x.projectId === r.projectId);
    const i = sibs.findIndex((x) => x.id === r.id);
    const back = { id: r.id, projectId: r.projectId, afterId: sibs[i - 1]?.id ?? null, beforeId: sibs[i + 1]?.id ?? null };
    try {
      const res = await portfolioApi.sheetMove({ id: m.id, projectId: m.projectId, afterId: m.afterId, beforeId: m.beforeId, version: r.version });
      const to = projects.find((p) => p.id === m.projectId);
      if (undo) setToastAt({ text: `Moved ${res.key} back`, at: Date.now(), undo: false });
      else pushEdit({ label: res.movedProject ? `Moved ${r.key} to ${to?.title ?? 'another project'} as ${res.key}` : `Moved ${r.key}`, count: 1, inverse: null, move: back });
      await q.refetch();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'The task could not be moved.', 'error'); }
  }, [rows, projects, q]);

  const undo = useCallback(() => {
    const [last, ...rest] = edits;
    if (!last) { setToastAt({ text: 'Nothing to undo', at: Date.now(), undo: false }); return; }
    setEdits(rest);
    if (last.move) void move(last.move, true);
    else if (last.inverse?.length) void save(last.inverse, last.label, { reason: REASON_UNDO, undo: true });
  }, [edits, move, save]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== 'z' || editableTarget(e.target)) return;
      if (!document.querySelector('.ps3')) return;
      e.preventDefault(); undo();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [undo]);
  useEffect(() => { if (!toastAt) return; const t = window.setTimeout(() => setToastAt((x) => (x?.at === toastAt.at ? null : x)), 6500); return () => window.clearTimeout(t); }, [toastAt]);

  // ---- paste anywhere on the sheet (not while typing)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (editableTarget(e.target) || (e.target as HTMLElement | null)?.closest?.('.ps3-modal')) return;
      if (!document.querySelector('.ps3')) return;
      const grid = parseTsv(e.clipboardData?.getData('text/plain') ?? '');
      if (grid.length === 0 || (grid.length === 1 && grid[0].length === 1)) return;
      e.preventDefault();
      if (grid.length > 500) { toast('Paste at most 500 rows at a time.', 'error'); return; }
      setPaste(grid);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  const exportAs = useCallback(async (format: 'xlsx' | 'csv') => {
    try { await portfolioApi.sheetExport(filter, { format, columns: EXPORT_COLUMNS, ids: active.length ? [...projects.map((p) => p.id), ...matching.map((r) => r.id)] : undefined }); }
    catch { toast('The export could not be made.', 'error'); }
  }, [filter, active.length, projects, matching]);
  const focusSearch = () => document.querySelector<HTMLInputElement>('.ps3-cmd input')?.focus();
  useEffect(() => registerPaletteCommands('plansheet', [
    { id: 'paste', group: 'Plan sheet', label: 'Paste from Excel', icon: 'upload', keywords: 'import rows spreadsheet', run: () => setPaste([]) },
    { id: 'xlsx', group: 'Plan sheet', label: 'Export plan sheet to Excel', icon: 'download', keywords: 'xlsx download', run: () => void exportAs('xlsx') },
    { id: 'csv', group: 'Plan sheet', label: 'Export plan sheet as CSV', icon: 'download', keywords: 'csv download', run: () => void exportAs('csv') },
    { id: 'present', group: 'Plan sheet', label: 'Present', icon: 'present', keywords: 'meeting slides', run: onPresent },
    { id: 'filter', group: 'Plan sheet', label: 'Filter the sheet…', icon: 'filter', keywords: 'search owner status due', run: () => setTimeout(focusSearch, 30) },
    { id: 'sheet', group: 'Plan sheet', label: 'Show as sheet', icon: 'list', run: () => setLayout('sheet') },
    { id: 'split', group: 'Plan sheet', label: 'Show sheet and timeline', icon: 'layers', run: () => setLayout('split') },
    { id: 'timeline', group: 'Plan sheet', label: 'Show as timeline', icon: 'calendar', run: () => setLayout('timeline') },
    { id: 'undo', group: 'Plan sheet', label: 'Undo the last edit', hint: '⌘Z', icon: 'undo', run: undo },
  ]), [exportAs, onPresent, undo]);

  // ---- who else has the sheet open, and the cell they are on
  const liveKey = wid ? `sheet:${wid.replace(/-/g, '').toLowerCase()}` : null;
  const [viewers, setViewers] = useState<Record<string, { name: string; seen: number; cell: string | null }>>({});
  useEffect(() => {
    if (!liveKey) return;
    const announce = () => hubInvoke('Watch', liveKey);
    announce();
    const offC = onLiveConnected(announce);
    const offV = onViewing((e) => {
      if (e.key !== liveKey || e.userId === me) return;
      if (e.hello) hubInvoke('Here', liveKey);
      setViewers((v) => { const n = { ...v }; if (e.on) n[e.userId] = { name: e.name ?? v[e.userId]?.name ?? 'Someone', seen: Date.now(), cell: v[e.userId]?.cell ?? null }; else delete n[e.userId]; return n; });
    });
    const offF = onSheetFocus((e) => {
      if (e.key !== liveKey || e.userId === me) return;
      setViewers((v) => ({ ...v, [e.userId]: { name: e.name ?? v[e.userId]?.name ?? 'Someone', seen: Date.now(), cell: e.cell } }));
    });
    const tick = window.setInterval(() => { hubInvoke('Here', liveKey); setViewers((v) => Object.fromEntries(Object.entries(v).filter(([, x]) => Date.now() - x.seen < 75_000))); }, 30_000);
    return () => { offC(); offV(); offF(); window.clearInterval(tick); hubInvoke('SheetFocus', liveKey, null); hubInvoke('Unwatch', liveKey); };
  }, [liveKey, me]);
  const focusCell = useCallback((cell: string | null) => { if (liveKey && isLiveConnected()) hubInvoke('SheetFocus', liveKey, cell); }, [liveKey]);
  const others = Object.entries(viewers).map(([id, v]) => ({ id, ...v }));

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !data) return <ErrorState error={q.error} retry={() => q.refetch()} />;

  const menu: DotsItem[] = [
    { label: 'Paste from Excel', icon: 'upload', hint: 'Or ⌘V anywhere on the sheet', onSelect: () => setPaste([]) },
    { label: 'Export to Excel', icon: 'download', hint: active.length ? 'The rows the filter shows' : 'The whole sheet', onSelect: () => void exportAs('xlsx') },
    { label: 'Export as CSV', icon: 'download', onSelect: () => void exportAs('csv') },
    { label: 'Present', icon: 'present', onSelect: onPresent },
    ...(activeView ? [{ label: prefs.data?.defaultView === activeView ? 'Stop opening this view first' : 'Open this view first', icon: 'star' as const, onSelect: () => void setDefault(prefs.data?.defaultView === activeView ? null : activeView) }] : []),
    ...extraMenu,
  ];
  const head = (
    <div className="ps3-head">
      <div className="ps3-crumb">Portfolio</div><h1>Plan</h1>
      {!phone && <div className="ps3-tabs">{tabs}</div>}
      <span className="ps3-sp" />
      {!phone && others.length > 0 && <div className="ps3-pres" aria-label={`Also on the sheet: ${others.map((o) => o.name).join(', ')}`} title={`Also here: ${others.map((o) => o.name).join(', ')}`}>
        {others.slice(0, 4).map((o) => <Av key={o.id} id={o.id} name={o.name} size={24} />)}</div>}
      {!phone && <DotsMenu label="More on the plan sheet" items={menu} />}
    </div>
  );
  const command = (
    <CommandField toks={toks} setToks={(t) => { setToks(t); setActiveView(null); }} text={text} setText={(t) => { setText(t); if (t) setActiveView(null); }} interpreted={interpreted}
      count={matching.length} total={work.length} filtering={active.length > 0} people={people} projects={projects} work={work} ctx={ctx} compact={phone}
      views={sheetViews} activeView={activeView} defaultView={prefs.data?.defaultView ?? null} onApplyView={applyView} onSaveView={(n) => void saveView(n)} />
  );
  return (
    <div className={`ps3 ${phone ? 'ps3-phone' : ''}`}>
      {head}
      {phone ? <>
        <div className="ps3-cmdrow">{command}</div>
        <PhoneCards display={display} data={data} rows={rows} today={today} statusesBy={statusesBy} save={save} />
      </> : <>
        <div className="ps3-cmdrow">{command}
          <div className="ps3-vsw" role="tablist" aria-label="Sheet layout">
            {(['sheet', 'split', 'timeline'] as Layout[]).map((l) => <button key={l} type="button" role="tab" aria-selected={layout === l} onClick={() => setLayout(l)}>{l === 'sheet' ? 'Sheet' : l === 'split' ? 'Split' : 'Timeline'}</button>)}
          </div>
        </div>
        <SheetGrid data={data} display={display} rows={rows} work={work} today={today} layout={layout} inspectId={inspect} setInspect={setInspect} collapsed={collapsed}
          toggle={(id) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })} statusesBy={statusesBy} meetings={meetings}
          save={save} move={move} others={others} focusCell={focusCell} onWarn={setWarn} refresh={() => q.refetch()} />
      </>}
      {toastAt && !historyOpen && (
        <div className="ps3-toast" role="status">
          <span>{toastAt.text}</span>
          {toastAt.undo && (() => { const n = edits.filter((e) => Date.now() - e.at < 60_000).length; return n > 1 ? <span className="m" style={{ cursor: 'default' }}>· {n} edits this minute</span> : null; })()}
          {toastAt.undo && <button type="button" className="b" onClick={undo}>Undo ⌘Z</button>}
          <button type="button" className="m" onClick={() => setHistoryOpen(true)}>History</button>
        </div>
      )}
      {historyOpen && (
        <Floating anchor={new DOMRect(window.innerWidth / 2 - 180, window.innerHeight - 80, 360, 1)} place="above" width={360} label="Edit history" onClose={() => setHistoryOpen(false)} style={{ padding: '6px 0' }}>
          <div className="ph">History · this session</div>
          {edits.length === 0 && <div className="it ps3-dim">No edits yet</div>}
          {edits.slice(0, 10).map((e, i) => <div key={e.id} className="it" style={{ cursor: 'default' }}><span style={{ flex: 1, minWidth: 0 }}>{e.label}<span className="ps3-dim" style={{ display: 'block', fontSize: 11 }}>{new Date(e.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span></span>
            {i === 0 && <button type="button" className="ps3-qc" onClick={() => { setHistoryOpen(false); undo(); }}>Undo</button>}</div>)}
        </Floating>
      )}
      {warn && <div className="ps3-toast warn" role="alert">{warn}</div>}
      {reasonAsk && <ReasonModal moves={reasonAsk.moves} onClose={() => setReasonAsk(null)}
        onSave={(reason, dep) => { const a = reasonAsk; setReasonAsk(null); void save(a.changes, a.label, { reason, dependency: dep }); }} />}
      {paste && <PasteModal grid={paste} data={data} today={today} onClose={() => setPaste(null)}
        defaultProject={(inspect ? rows.find((r) => r.id === inspect)?.projectId : null) ?? firstProject(display)}
        onDone={() => { setPaste(null); void q.refetch(); }} />}
    </div>
  );
}

const firstProject = (display: Display[]) => { for (const d of display) if (d.type === 'g') return d.p.id; return null; };

// ---------------------------------------------------------------- the command field

function CommandField({ toks, setToks, text, setText, interpreted, count, total, filtering, people, projects, work, ctx, compact, views, activeView, defaultView, onApplyView, onSaveView }: {
  toks: Tok[]; setToks: (t: Tok[]) => void; text: string; setText: (t: string) => void; interpreted: Tok[]; count: number; total: number; filtering: boolean;
  people: { id: string; name: string }[]; projects: SheetRow[]; work: SheetRow[]; ctx: { today: string; me: string | null }; compact: boolean;
  views: SavedView[]; activeView: string | null; defaultView: string | null; onApplyView: (v: SavedView) => void; onSaveView: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const word = text.trim().split(/\s+/).pop()?.toLowerCase() ?? '';
  const byOwner = useMemo(() => { const m = new Map<string, number>(); for (const r of work) if (r.ownerId && isOpen(r)) m.set(r.ownerId, (m.get(r.ownerId) ?? 0) + 1); return m; }, [work]);
  const ppl = useMemo(() => {
    const list = people.filter((p) => !toks.some((t) => t.kind === 'owner' && t.value === p.id));
    const hit = word.length >= 2 ? list.filter((p) => p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(word))) : [];
    return (hit.length ? hit : list.filter((p) => byOwner.has(p.id)).sort((a, b) => (byOwner.get(b.id) ?? 0) - (byOwner.get(a.id) ?? 0))).slice(0, hit.length ? 4 : 2);
  }, [people, toks, word, byOwner]);
  const statusCount = useMemo(() => { const m: Record<StatusKey, number> = { late: 0, risk: 0, prog: 0, todo: 0, done: 0 }; for (const r of work) m[statusKey(r)]++; return m; }, [work]);
  const [hi, setHi] = useState(0);
  const add = (t: Tok) => { setToks([...toks.filter((x) => !(x.kind === t.kind && x.value === t.value)), t]); setText(''); input.current?.focus(); };
  const has = (k: Tok['kind'], v: string) => [...toks, ...interpreted].some((t) => t.kind === k && t.value === v);
  const commit = () => { if (interpreted.length) { setToks([...toks, ...interpreted.filter((t) => !toks.some((x) => x.kind === t.kind && x.value === t.value))]); setText(''); } };
  const tokLabel = (t: Tok) => t.kind === 'text' ? <>{t.label}</> : <><span className="k">{t.kind} </span>{t.label}</>;
  const person = (id: string) => people.find((p) => p.id === id);
  return (
    <>
      <div ref={box} className={`ps3-cmd ${open ? 'focus' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); input.current?.focus(); } }}>
        <span className="ic" aria-hidden="true">⌕</span>
        {toks.map((t, i) => (
          <span key={`${t.kind}:${t.value}`} className="ps3-tok">{t.kind === 'owner' && t.value !== 'me' && <Av id={t.value} name={person(t.value)?.name} size={16} />}{tokLabel(t)}
            <button type="button" className="x" aria-label={`Remove ${t.kind} ${t.label}`} onClick={() => setToks(toks.filter((_, j) => j !== i))}>✕</button></span>
        ))}
        <input ref={input} aria-label="Filter, search or ask" placeholder={toks.length ? '' : compact ? 'Filter or ask' : 'Filter, search or ask — try “late this week”'} value={text}
          onFocus={() => setOpen(true)} onChange={(e) => { setText(e.target.value); setHi(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); if (interpreted.length) commit(); else if (ppl[hi]) add({ kind: 'owner', value: ppl[hi].id, label: ppl[hi].name }); }
            else if (e.key === 'Backspace' && !text && toks.length) setToks(toks.slice(0, -1));
            else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((x) => Math.min(ppl.length - 1, x + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((x) => Math.max(0, x - 1)); }
            else if (e.key === 'Escape') { setOpen(false); input.current?.blur(); }
          }} />
        <span className={`ps3-count ${filtering ? 'on' : ''}`} aria-live="polite">{compact ? (filtering ? count : total) : filtering ? `${count} of ${total} tasks` : `${total} tasks`}</span>
        {!compact && <kbd role="button" tabIndex={-1} title="Commands (⌘K)" onMouseDown={(e) => { e.preventDefault(); openPalette(); }}>⌘K</kbd>}
      </div>
      {open && !compact && <div className="ps3-cmd-scrim" aria-hidden="true" />}
      {open && (
        <Floating anchor={box.current} onClose={() => { setOpen(false); setNaming(null); setCustom(null); }} width={compact ? 358 : 560} label="Filter suggestions" style={{ paddingBottom: 8 }}>
          {interpreted.length > 0 && <>
            <div style={{ display: 'flex', gap: 8, padding: '12px 14px 6px', alignItems: 'center', flexWrap: 'wrap' }}><span className="ps3-dim" style={{ fontSize: 12 }}>Aura read this as</span>
              {interpreted.map((t) => <button key={`${t.kind}:${t.value}`} type="button" className="ps3-tok aura" onClick={commit} title="Keep these filters (↵)">{tokLabel(t)}</button>)}</div>
            <div className="hr" />
          </>}
          {ppl.length > 0 && <><div className="ph">People</div>
            {ppl.map((p, i) => <button key={p.id} type="button" className={`it ${i === hi ? 'on' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => add({ kind: 'owner', value: p.id, label: p.name })}>
              <Av id={p.id} name={p.name} /><span style={{ flex: 1 }}>{p.name}</span><span className="ps3-dim">{byOwner.get(p.id) ?? 0} task{byOwner.get(p.id) === 1 ? '' : 's'}</span>{i === hi && <span aria-hidden="true">↵</span>}</button>)}</>}
          <div className="ph">Status</div>
          <div className="row">{STATUS_KEYS.map((k) => <button key={k} type="button" className="ps3-tok" style={has('status', k) ? { boxShadow: '0 0 0 1px var(--p-blue)' } : undefined}
            onClick={() => add({ kind: 'status', value: k, label: STATUS_LABEL[k] })}><span className="ps3-st"><Dot k={k} />{STATUS_LABEL[k]}</span><span className="ps3-dim" style={{ fontWeight: 400 }}>{statusCount[k]}</span></button>)}</div>
          <div className="ph">Dates</div>
          <div className="row">{(['overdue', 'this-week', 'next-2-weeks', 'slipped'] as DueKey[]).map((k) => <button key={k} type="button" className={`ps3-qc ${has('due', k) ? 'on' : ''}`} onClick={() => add({ kind: 'due', value: k, label: DUE_LABEL[k] })}>{DUE_LABEL[k]}</button>)}
            <button type="button" className={`ps3-qc ${custom ? 'on' : ''}`} onClick={() => setCustom(custom ? null : { from: ctx.today, to: addDays(ctx.today, 14) })}>Custom…</button>
            {custom && <span className="ps3-save-view"><input type="date" aria-label="From" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} style={{ width: 130 }} />
              <input type="date" aria-label="To" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} style={{ width: 130 }} />
              <button type="button" className="ps3-qc pri" disabled={!custom.from || !custom.to || custom.to < custom.from} onClick={() => { add({ kind: 'due', value: `${custom.from}..${custom.to}`, label: `${dm(custom.from)} – ${dm(custom.to)}` }); setCustom(null); }}>Add</button></span>}</div>
          <div className="ph">Projects</div>
          <div className="row" style={{ paddingBottom: 8 }}>{projects.map((p) => <button key={p.id} type="button" className={`ps3-qc ${has('project', p.id) ? 'on' : ''}`} onClick={() => add({ kind: 'project', value: p.id, label: p.title })}>{p.title}</button>)}</div>
          <div className="hr" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px 2px', flexWrap: 'wrap' }}><span className="ps3-dim" style={{ fontSize: 12 }}>Saved views</span>
            {views.length === 0 && <span className="ps3-dim" style={{ fontSize: 12 }}>none yet</span>}
            {views.slice(0, 6).map((v) => <button key={v.id} type="button" className={`ps3-qc ${activeView === v.id ? 'on' : ''}`} onClick={() => { onApplyView(v); setOpen(false); }}>{defaultView === v.id ? '★ ' : ''}{v.name}</button>)}
            <span className="ps3-sp" />
            {naming === null ? <button type="button" className="ps3-link" disabled={!filtering} title={filtering ? undefined : 'Add a filter first'} style={filtering ? undefined : { opacity: .5 }} onClick={() => setNaming('')}>＋ Save as view</button>
              : <form className="ps3-save-view" onSubmit={(e) => { e.preventDefault(); if (naming.trim()) { onSaveView(naming.trim()); setNaming(null); setOpen(false); } }}>
                <input autoFocus aria-label="Name for the view" placeholder="Name the view" value={naming} onChange={(e) => setNaming(e.target.value)} maxLength={80} />
                <button type="submit" className="ps3-qc pri" disabled={!naming.trim()}>Save</button></form>}
          </div>
        </Floating>
      )}
    </>
  );
}

// ---------------------------------------------------------------- the grid

function SheetGrid({ data, display, rows, work, today, layout, inspectId, setInspect, collapsed, toggle, statusesBy, meetings, save, move, others, focusCell, onWarn, refresh }: {
  data: PlanSheetData; display: Display[]; rows: SheetRow[]; work: SheetRow[]; today: string; layout: Layout; inspectId: string | null; setInspect: (id: string | null) => void;
  collapsed: Set<string>; toggle: (id: string) => void; statusesBy: Map<string, SheetStatus[]>; meetings: { byProject: Map<string, LinkedMeeting>; byTask: Map<string, LinkedMeeting> };
  save: (c: SheetChange[], label: string) => Promise<void>; move: (m: { id: string; projectId: string; afterId: string | null; beforeId: string | null }) => Promise<void>;
  others: { id: string; name: string; cell: string | null }[]; focusCell: (cell: string | null) => void; onWarn: (t: string | null) => void; refresh: () => Promise<unknown>;
}) {
  const inspected = inspectId ? rows.find((r) => r.id === inspectId) ?? null : null;
  const cols = COLS[inspected ? 'narrow' : layout];
  const nav = useMemo(() => display.flatMap((d) => (d.type === 'r' ? [d.r] : [])), [display]);
  const navCols: ColId[] = cols.map((c) => c[0]).filter((c) => c !== 'gantt');
  const [act, setAct] = useState<{ id: string; col: ColId } | null>(null);
  const [edit, setEdit] = useState<{ id: string; col: EditCol | 'title'; anchor: HTMLElement | null; draft?: string } | null>(null);
  const [fill, setFill] = useState<{ col: ColId; src: string; to: string[] } | null>(null);
  const [smart, setSmart] = useState<{ src: SheetRow; targets: SheetRow[]; anchor: DOMRect } | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; line: { top: number; left: number; width: number } | null; target: { projectId: string; afterId: string | null; beforeId: string | null } | null } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(600);
  useEffect(() => {
    // The grid scrolls inside itself and the page never does: its height is what the window has left below it, less what the layout puts after it.
    const fit = () => {
      const el = wrap.current; if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY, after = Math.max(0, document.documentElement.scrollHeight - (top + el.offsetHeight));
      setH(Math.max(360, window.innerHeight - top - after));
    };
    fit(); const t = window.setTimeout(fit, 120); window.addEventListener('resize', fit);
    return () => { window.clearTimeout(t); window.removeEventListener('resize', fit); };
  }, []);
  useEffect(() => { focusCell(act ? `${act.id}:${act.col}` : null); }, [act, focusCell]);
  const cellEl = (id: string, col: ColId) => wrap.current?.querySelector<HTMLElement>(`[data-cell="${id}:${col}"]`) ?? null;
  const open = (r: SheetRow, col: ColId, anchor?: HTMLElement | null, draft?: string) => {
    if (!r.canEdit) return;
    const ed = EDITOR_OF[col];
    if (col === 'task') { setEdit({ id: r.id, col: 'title', anchor: anchor ?? cellEl(r.id, col), draft }); return; }
    if (ed) setEdit({ id: r.id, col: ed, anchor: anchor ?? cellEl(r.id, col), draft });
  };
  const done = (changes: SheetChange[] | null, label = 'Saved') => { setEdit(null); if (changes?.length) void save(changes, label); requestAnimationFrame(() => wrap.current?.focus({ preventScroll: true })); };
  // Keep the active cell in view by scrolling the grid only (never the page).
  useEffect(() => {
    const el = act ? cellEl(act.id, act.col) : null, box = wrap.current;
    if (!el || !box) return;
    const r = el.getBoundingClientRect(), b = box.getBoundingClientRect(), head = 34;
    if (r.top < b.top + head) box.scrollTop -= b.top + head - r.top;
    else if (r.bottom > b.bottom - 88) box.scrollTop += r.bottom - (b.bottom - 88);
  }, [act]);

  // Workload for the people picker: the capacity plan when there is one, else worked out from the sheet's own assigned hours.
  const editRow = edit ? rows.find((r) => r.id === edit.id) ?? null : null;
  const mon = weekStart(editRow?.due && dayNum(editRow.due) >= dayNum(today) ? (editRow.start && dayNum(editRow.start) > dayNum(today) ? editRow.start : editRow.due) : addDays(today, 7));
  const plan = useWsQuery(['resources', 'plan', mon], () => resourcesApi.plan({ from: mon, weeks: 1, scope: 'Everyone' }), { enabled: edit?.col === 'owner', staleTime: 120_000, retry: false });
  const loadFor = useCallback((id: string): Load => {
    const name = data.people.find((p) => p.id === id)?.name ?? '';
    const extra = editRow && editRow.ownerId !== id ? estimateLoad([{ ...editRow, ownerId: id }], id, mon).minutes : 0;
    const cell = plan.data?.entitled ? plan.data.people.find((p) => p.userId === id)?.weeks.find((w) => w.weekStart === mon) : undefined;
    if (cell && cell.capacityMinutes > 0) { const minutes = cell.bookedMinutes + extra; return { id, name, minutes, capacity: cell.capacityMinutes, pct: Math.round((minutes * 100) / cell.capacityMinutes), source: 'plan' }; }
    const e = estimateLoad(work, id, mon);
    const minutes = e.minutes + extra;
    return { id, name, minutes, capacity: e.capacity, pct: Math.round((minutes * 100) / e.capacity), source: 'estimate' };
  }, [data.people, editRow, mon, plan.data, work]);

  // ---- fill handle: drag the active cell's value down its column
  const fillRef = useRef(fill); fillRef.current = fill;
  const fillChange = (src: SheetRow, dst: SheetRow, col: ColId): SheetChange | null => {
    if (!dst.canEdit || src.id === dst.id) return null;
    switch (col) {
      case 'owner': return src.ownerId ? (src.ownerId === dst.ownerId ? null : { id: dst.id, assigneeId: src.ownerId }) : dst.ownerId ? { id: dst.id, unassign: true } : null;
      case 'dates': case 'due': return src.due && (src.due !== dst.due || (col === 'dates' && src.start !== dst.start)) ? { id: dst.id, dueDate: src.due, ...(col === 'dates' && src.start ? { startDate: src.start } : {}) } : null;
      case 'status': { const t = statusesBy.get(dst.projectId) ?? []; const s = t.find((x) => x.name === src.status) ?? t.find((x) => x.category === src.category); return s && s.id !== dst.statusId ? { id: dst.id, statusId: s.id } : null; }
      case 'progress': return src.progress != null && src.progress !== dst.progress ? { id: dst.id, progress: src.progress } : null;
      default: return null;
    }
  };
  const startFill = (e: React.PointerEvent, r: SheetRow, col: ColId) => {
    e.preventDefault(); e.stopPropagation();
    setFill({ col, src: r.id, to: [] });
    const srcIdx = nav.findIndex((x) => x.id === r.id);
    const moveH = (ev: PointerEvent) => {
      const tr = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('tr[data-row]');
      const idx = tr ? nav.findIndex((x) => x.id === tr.dataset.row) : -1;
      setFill((f) => (f ? { ...f, to: idx > srcIdx ? nav.slice(srcIdx + 1, idx + 1).map((x) => x.id) : [] } : f));
    };
    const up = () => {
      window.removeEventListener('pointermove', moveH); window.removeEventListener('pointerup', up);
      const f = fillRef.current; setFill(null);
      if (!f || f.to.length === 0) return;
      const src = rows.find((x) => x.id === f.src)!, targets = f.to.map((id) => rows.find((x) => x.id === id)!).filter((x) => x && x.canEdit);
      if (f.col === 'progress' && src.progress === 100 && targets.some((t) => statusKey(t) !== 'done' && checklistPct(t) != null && checklistPct(t) !== 100)) {
        const last = cellEl(targets[targets.length - 1].id, 'progress')?.getBoundingClientRect();
        setSmart({ src, targets, anchor: last ?? new DOMRect(window.innerWidth / 2, 300, 1, 1) });
        return;
      }
      const changes = targets.map((t) => fillChange(src, t, f.col)).filter((x): x is SheetChange => !!x);
      if (changes.length === 0) { toast('Nothing to fill there.', 'info'); return; }
      void save(changes, `Filled ${changes.length} cell${changes.length === 1 ? '' : 's'}`);
    };
    window.addEventListener('pointermove', moveH); window.addEventListener('pointerup', up);
  };
  const smartValue = (t: SheetRow) => (statusKey(t) !== 'done' && checklistPct(t) != null ? checklistPct(t)! : 100);

  // ---- drag a row to a new place, or into another project
  const dragRef = useRef(drag); dragRef.current = drag;
  const startDrag = (e: React.PointerEvent, r: SheetRow) => {
    if (r.kind !== 'task' || !r.canEdit) return;
    e.preventDefault(); e.stopPropagation();
    setDrag({ id: r.id, x: e.clientX, y: e.clientY, line: null, target: null });
    const tops = (pid: string) => rows.filter((x) => x.kind === 'task' && x.projectId === pid && x.id !== r.id);
    const moveH = (ev: PointerEvent) => {
      const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('tr[data-row], tr[data-group]');
      let line = null, target = null;
      const table = wrap.current?.querySelector('table')?.getBoundingClientRect();
      if (el && table) {
        const rect = el.getBoundingClientRect(), pid = el.dataset.project!;
        const list = tops(pid);
        if (el.dataset.group) { line = { top: rect.bottom, left: table.left + 24, width: table.width - 48 }; target = { projectId: pid, afterId: null, beforeId: list[0]?.id ?? null }; }
        else {
          const over = rows.find((x) => x.id === el.dataset.row)!;
          const anchorId = over.kind === 'subtask' && over.parentId ? over.parentId : over.id;
          const i = list.findIndex((x) => x.id === anchorId);
          const before = ev.clientY < rect.top + rect.height / 2 && over.kind !== 'subtask';
          if (anchorId !== r.id && i >= 0) {
            line = { top: before ? rect.top : rect.bottom, left: table.left + 24, width: table.width - 48 };
            target = before ? { projectId: pid, afterId: list[i - 1]?.id ?? null, beforeId: list[i].id } : { projectId: pid, afterId: list[i].id, beforeId: list[i + 1]?.id ?? null };
          }
        }
      }
      setDrag((d) => (d ? { ...d, x: ev.clientX, y: ev.clientY, line, target } : d));
    };
    const up = () => {
      window.removeEventListener('pointermove', moveH); window.removeEventListener('pointerup', up);
      const d = dragRef.current; setDrag(null);
      if (d?.target) void move({ id: d.id, ...d.target });
    };
    window.addEventListener('pointermove', moveH); window.addEventListener('pointerup', up);
  };
  const dragRow = drag ? rows.find((x) => x.id === drag.id) : null;
  const dragTo = drag?.target && dragRow && drag.target.projectId !== dragRow.projectId ? rows.find((x) => x.id === drag.target!.projectId) : null;

  // ---- keyboard: arrows move, Enter/F2 edits, typing edits (title, owner), Esc leaves the inspector
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (edit || e.target !== wrap.current) return;
    const ri = act ? nav.findIndex((x) => x.id === act.id) : -1, ci = act ? navCols.indexOf(act.col) : 0;
    const go = (dr: number, dc: number) => {
      const r2 = nav[Math.max(0, Math.min(nav.length - 1, (ri < 0 ? 0 : ri) + dr))]; const c2 = navCols[Math.max(0, Math.min(navCols.length - 1, Math.max(0, ci) + dc))];
      if (r2 && c2) setAct({ id: r2.id, col: c2 });
    };
    const r = act ? rows.find((x) => x.id === act.id) : null;
    if (e.key === 'ArrowDown') { e.preventDefault(); go(1, 0); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); go(-1, 0); }
    else if (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); go(0, 1); }
    else if (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey)) { e.preventDefault(); go(0, -1); }
    else if ((e.key === 'Enter' || e.key === 'F2') && r && act) { e.preventDefault(); if (act.col === 'task' && e.key === 'Enter') setInspect(r.id); else open(r, act.col); }
    else if (e.key === ' ' && r) { e.preventDefault(); setInspect(inspectId === r.id ? null : r.id); }
    else if (e.key === 'Escape') { if (inspectId) setInspect(null); else setAct(null); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && r && act) {
      e.preventDefault(); const above = nav[ri - 1]; const c = above ? fillChange(above, r, act.col) : null;
      if (c) void save([c], 'Filled 1 cell'); else toast('Nothing to fill down here.', 'info');
    }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && r && act && (act.col === 'task' || act.col === 'owner')) { e.preventDefault(); open(r, act.col, null, e.key); }
  };

  const gantt = useMemo(() => {
    const ds = nav.flatMap((x) => [x.start, x.due]).filter((x): x is string => !!x).map(dayNum);
    if (!ds.length) return null;
    const a = Math.min(...ds, dayNum(today)) - 3, b = Math.max(...ds, dayNum(today)) + 3;
    return { a, b, x: (iso: string) => ((dayNum(iso) - a) / Math.max(1, b - a)) * 100 };
  }, [nav, today]);
  const cursorAt = (id: string, col: ColId) => others.filter((o) => o.cell === `${id}:${col}`);

  const cell = (r: SheetRow, col: ColId, level: number): ReactNode => {
    const k = statusKey(r);
    switch (col) {
      case 'task': {
        const mt = meetings.byTask.get(r.id);
        return (
          <div className="ps3-task" style={{ paddingLeft: level * 18 }}>
            <div style={{ minWidth: 0 }}>
              <div className="ps3-ttl"><span className="ps3-key">{r.key}</span>{edit?.id === r.id && edit.col === 'title'
                ? <TitleInput r={r} draft={edit.draft} onDone={(t) => done(t !== null && t !== r.title ? [{ id: r.id, title: t }] : null, `Renamed ${r.key}`)} />
                : <b title={r.title}>{r.title}</b>}</div>
              {(r.dependsOn.length > 0 || mt) && <div className="ps3-sub" style={{ paddingLeft: r.key.length * 6.6 + 8 }}>
                {r.dependsOn.length > 0 && <span>↳ after {r.dependsOn.join(', ')}</span>}
                {mt && <span className="m">◆ {mt.title}{mt.nextAt ? ` · ${new Date(mt.nextAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}` : ''}</span>}</div>}
            </div>
          </div>
        );
      }
      case 'owner': return <Owner id={r.ownerId} name={r.owner} />;
      case 'dates': {
        const s = slipDays(r, today);
        return <span className="ps3-num">{r.start && <span className="ps3-dim">{dm(r.start)} → </span>}<span style={k === 'late' ? { color: 'var(--p-red)' } : undefined}>{dm(r.due) || <span className="ps3-dim">No date</span>}</span>{s > 0 && <span className={`ps3-slip ${k === 'late' ? 'late' : 'risk'}`}>+{s}d</span>}</span>;
      }
      case 'due': { const s = slipDays(r, today); return <><span className="ps3-num" style={k === 'late' ? { color: 'var(--p-red)' } : undefined}>{dm(r.due) || '—'}</span>{s > 0 && <span className={`ps3-slip ${k === 'late' ? 'late' : 'risk'}`}>+{s}d</span>}</>; }
      case 'status': return <Status r={r} />;
      case 'progress': {
        const pv = smart && smart.targets.some((t) => t.id === r.id) ? smartValue(r) : fill?.col === 'progress' && fill.to.includes(r.id) ? rows.find((x) => x.id === fill.src)?.progress ?? r.progress : r.progress;
        return <Progress value={pv} k={k} />;
      }
      case 'notes': return <div className="ps3-note">{r.notes ? <NoteText text={r.notes} /> : <span className="ph">Add a note…<span className="ps3-slash">/</span></span>}</div>;
      case 'gantt': {
        if (!gantt) return null;
        const s = r.start ?? r.due;
        return <div className="ps3-gantt" aria-hidden="true">{s && r.due && <b className={k} style={{ left: `${gantt.x(s)}%`, width: `max(6px, ${gantt.x(r.due) - gantt.x(s)}%)` }} />}<span className="today" style={{ left: `${gantt.x(today)}%` }} /></div>;
      }
    }
  };

  const half = Math.ceil(cols.length / 2);
  return (
    <div className="ps3-body">
      <div className="ps3-sheet">
        <div ref={wrap} className="ps3-scroll" style={{ '--ps3-h': `${h}px` } as CSSProperties} role="grid" aria-label="Plan sheet" tabIndex={0} onKeyDown={onKey}
          aria-rowcount={nav.length + 1} aria-colcount={cols.length}>
          <table className="ps3-table">
            <colgroup>{cols.map(([id, , w]) => <col key={id} style={{ width: `${w}%` }} />)}</colgroup>
            <thead><tr role="row">{cols.map(([id, label]) => <th key={id} role="columnheader">{id === 'gantt' && gantt
              ? <span className="ps3-gantt-h"><span>{dm(new Date(gantt.a * 86_400_000).toISOString().slice(0, 10))}</span><span>Today</span><span>{dm(new Date(gantt.b * 86_400_000).toISOString().slice(0, 10))}</span></span> : label}</th>)}</tr></thead>
            <tbody>
              {display.length === 0 && <tr><td colSpan={cols.length} className="ps3-empty">Nothing matches the filter.</td></tr>}
              {display.map((d) => {
                if (d.type === 'g') {
                  const p = d.p, open0 = d.all.filter(isOpen);
                  const late = open0.filter((x) => x.late).length, risk = open0.filter((x) => !x.late && x.atRisk).length;
                  const pct = p.progress ?? (d.all.length ? Math.round(d.all.reduce((a, x) => a + (x.progress ?? 0), 0) / d.all.length) : 0);
                  const tone = late || p.late ? 'var(--p-red)' : risk || p.atRisk ? 'var(--p-orange)' : pct >= 100 ? 'var(--p-green)' : 'var(--p-blue)';
                  const summary = late ? `${late} late` : risk ? `${risk} at risk` : p.late ? 'Late' : p.atRisk ? 'At risk' : 'On track';
                  const owners = new Map<string, string | null>();
                  for (const x of [p, ...d.all]) if (x.ownerId && !owners.has(x.ownerId) && owners.size < 3) owners.set(x.ownerId, x.owner);
                  return (
                    <tr key={p.id} className="g" role="row" data-group={p.id} data-project={p.id} aria-level={1}>
                      <td colSpan={half}><div className="ps3-gt">
                        <button type="button" className="tw" aria-expanded={!collapsed.has(p.id)} aria-label={`${collapsed.has(p.id) ? 'Expand' : 'Collapse'} ${p.title}`} onClick={() => toggle(p.id)}>{collapsed.has(p.id) ? '▸' : '▾'}</button>
                        <Ring pct={pct} color={tone} />{p.title}<span className="ps3-gm">{d.shown} · {pct}%</span></div></td>
                      <td colSpan={cols.length - half}><div className="ps3-gm" style={{ justifyContent: 'flex-end' }}>
                        <span style={{ color: tone }}>{summary}</span>{p.due && <span>Ends {dm(p.due)}</span>}
                        <span className="ps3-pres">{[...owners.entries()].map(([id, name]) => <Av key={id} id={id} name={name} size={18} />)}</span></div></td>
                    </tr>
                  );
                }
                const r = d.r;
                return (
                  <tr key={r.id} role="row" data-row={r.id} data-project={r.projectId} className={`${inspectId === r.id ? 'sel' : ''} ${drag?.id === r.id ? 'dragging' : ''}`} aria-selected={inspectId === r.id}>
                    {cols.map(([col]) => {
                      const isAct = act?.id === r.id && act.col === col;
                      const inRange = fill?.col === col && fill.to.includes(r.id) || (smart && col === 'progress' && smart.targets.some((t) => t.id === r.id));
                      const curs = cursorAt(r.id, col);
                      return (
                        <td key={col} role="gridcell" data-cell={`${r.id}:${col}`} className={`${isAct || (edit?.id === r.id && EDITOR_OF[col] === edit.col) ? 'act' : ''} ${inRange ? 'rng' : ''}`}
                          aria-selected={isAct}
                          onMouseDown={(e) => { if ((e.target as HTMLElement).closest('a, .ps3-grip, .ps3-handle, input')) return; setAct({ id: r.id, col }); }}
                          onClick={(e) => {
                            if ((e.target as HTMLElement).closest('a, .ps3-grip, .ps3-handle, input')) return;
                            if (col === 'task' || col === 'gantt') setInspect(r.id); else if (r.canEdit) open(r, col, e.currentTarget);
                          }}
                          onDoubleClick={(e) => { if (col === 'task') open(r, 'task', e.currentTarget); }}>
                          {col === 'task' && r.kind === 'task' && r.canEdit && <button type="button" className="ps3-grip" aria-label={`Drag ${r.key} to move it`} onPointerDown={(e) => startDrag(e, r)}>⋮⋮</button>}
                          {cell(r, col, d.level)}
                          {isAct && !edit && FILLABLE.includes(col) && r.canEdit && <span className="ps3-handle" aria-hidden="true" title="Drag down to fill" onPointerDown={(e) => startFill(e, r, col)} />}
                          {curs.map((o) => <span key={o.id}><span className="ps3-cbox" style={{ boxShadow: `inset 0 0 0 1.5px ${personColor(o.id)}` }} /><span className="ps3-cursor" style={{ background: personColor(o.id) }}>{o.name}</span></span>)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {inspected && <Inspector h={h} r={inspected} rows={rows} project={rows.find((x) => x.id === inspected.projectId)} today={today} meeting={meetings.byProject.get(inspected.projectId) ?? null}
        onClose={() => setInspect(null)} onChanged={() => void refresh()} onEdit={(col, anchor) => setEdit({ id: inspected.id, col, anchor })} />}

      {edit && editRow && edit.col === 'dates' && <DateEditor r={editRow} rows={rows} today={today} anchor={edit.anchor} onClose={() => done(null)} onSave={(c, label) => done(c, label)} />}
      {edit && editRow && edit.col === 'owner' && <PeoplePicker r={editRow} people={data.people} loadFor={loadFor} week={weekLabel(mon)} mon={mon} anchor={edit.anchor} initial={edit.draft} onWarn={onWarn}
        onClose={() => done(null)} onPick={(id) => done(id === editRow.ownerId ? null : [id ? { id: editRow.id, assigneeId: id } : { id: editRow.id, unassign: true }], `Gave ${editRow.key} to ${data.people.find((p) => p.id === id)?.name ?? 'nobody'}`)} />}
      {edit && editRow && edit.col === 'status' && <StatusPicker r={editRow} statuses={statusesBy.get(editRow.projectId) ?? []} anchor={edit.anchor} onClose={() => done(null)}
        onPick={(sid) => done(sid === editRow.statusId ? null : [{ id: editRow.id, statusId: sid }], `${editRow.key} → ${data.statuses.find((s) => s.id === sid)?.name ?? 'status'}`)} />}
      {edit && editRow && edit.col === 'progress' && <ProgressEditor r={editRow} anchor={edit.anchor} onClose={() => done(null)}
        onSave={(v) => done(v === null ? [{ id: editRow.id, clearProgress: true }] : v === editRow.progress && editRow.manualProgress ? null : [{ id: editRow.id, progress: v }], `${editRow.key} progress ${v ?? 'worked out'}${v === null ? '' : '%'}`)} />}
      {edit && editRow && edit.col === 'notes' && <NotesEditor r={editRow} people={data.people} anchor={edit.anchor} onClose={() => done(null)}
        onSave={(t) => done(t === (editRow.notes ?? '') ? null : [{ id: editRow.id, notes: t }], `Note on ${editRow.key}`)} />}

      {smart && (
        <Floating anchor={smart.anchor} onClose={() => setSmart(null)} width={400} label="Smart fill" style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><span className="ps3-orb sm" aria-hidden="true" /><b>Fill progress from status?</b></div>
          <div className="ps3-dim" style={{ fontSize: 12, lineHeight: 1.5, margin: '8px 0 10px' }}>
            You’re dragging {smart.src.progress}% down {smart.targets.length + 1} rows. {listKeys(smart.targets.filter((t) => smartValue(t) !== 100).map((t) => t.key))} {smart.targets.filter((t) => smartValue(t) !== 100).length === 1 ? 'isn’t' : 'aren’t'} done — Aura can fill from each task’s checklist instead.</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{smart.src.key}</span><span>{smart.src.progress}% <span className="ps3-dim">keep</span></span></div>
            {smart.targets.map((t) => { const v = smartValue(t); return <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between' }}><span>{t.key}</span>
              <span><s className="ps3-dim">{smart.src.progress}%</s> → <b style={{ color: 'var(--p-blue)' }}>{v}%</b> {v !== 100 && <span className="ps3-dim">{t.checklistDone} of {t.checklistTotal} items</span>}</span></div>; })}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
            <button type="button" className="ps3-qc" onClick={() => { const s = smart; setSmart(null); void save(s.targets.map((t) => ({ id: t.id, progress: s.src.progress! })), `Filled ${s.targets.length} cells`); }}>Fill {smart.src.progress}% anyway</button>
            <button type="button" className="ps3-qc pri" onClick={() => { const s = smart; setSmart(null); void save(s.targets.map((t) => ({ id: t.id, progress: smartValue(t) })), `Smart-filled ${s.targets.length} cells`); }}>Use smart fill</button>
          </div>
        </Floating>
      )}
      {drag && dragRow && <>
        {drag.line && <div className="ps3-drop" style={{ top: drag.line.top - 1, left: drag.line.left, width: drag.line.width }} />}
        <div className="ps3-dragrow ps3-float" style={{ left: drag.x - 120, top: drag.y - 18 }}><span className="ps3-dim">⋮⋮</span><span className="ps3-key">{dragRow.key}</span><b style={{ fontWeight: 500 }}>{dragRow.title}</b><span className="ps3-sp" />
          {dragTo && <span className="ps3-dim" style={{ fontSize: 12 }}>Move to {dragTo.title}</span>}</div>
      </>}
    </div>
  );
}
const listKeys = (k: string[]) => (k.length <= 1 ? k.join('') : `${k.slice(0, -1).join(', ')} and ${k[k.length - 1]}`);

function TitleInput({ r, draft, onDone }: { r: SheetRow; draft?: string; onDone: (t: string | null) => void }) {
  const [v, setV] = useState(draft ?? r.title);
  return <input autoFocus className="ps3-inline" aria-label={`Title of ${r.key}`} value={v} maxLength={300} onChange={(e) => setV(e.target.value)}
    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onDone(v.trim() || null); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDone(null); } }}
    onBlur={() => onDone(null)} onClick={(e) => e.stopPropagation()} />;
}

// ---------------------------------------------------------------- phone: one card per project

function PhoneCards({ display, data, rows, today, statusesBy, save }: {
  display: Display[]; data: PlanSheetData; rows: SheetRow[]; today: string; statusesBy: Map<string, SheetStatus[]>; save: (c: SheetChange[], label: string) => Promise<void>;
}) {
  const [act, setAct] = useState<SheetRow | null>(null);
  const groups: { p: SheetRow; all: SheetRow[]; items: SheetRow[] }[] = [];
  for (const d of display) if (d.type === 'g') groups.push({ p: d.p, all: d.all, items: [] }); else groups[groups.length - 1]?.items.push(d.r);
  const doneStatus = (r: SheetRow) => (statusesBy.get(r.projectId) ?? []).find((x) => x.category === 'Done');
  return (
    <div>
      {groups.length === 0 && <p className="ps3-empty">Nothing matches the filter.</p>}
      {groups.map(({ p, all, items }) => {
        const open0 = all.filter(isOpen), late = open0.filter((x) => x.late).length, risk = open0.filter((x) => !x.late && x.atRisk).length;
        const pct = p.progress ?? 0, tone = late ? 'var(--p-red)' : risk ? 'var(--p-orange)' : pct >= 100 ? 'var(--p-green)' : 'var(--p-blue)';
        return (
          <section key={p.id} aria-label={p.title}>
            <div className="ps3-phone-g ps3-gt"><Ring pct={pct} color={tone} />{p.title}<span className="ps3-sp" /><span className="ps3-gm" style={{ color: tone }}>{late ? `${late} late` : risk ? `${risk} at risk` : 'On track'}</span></div>
            <div className="ps3-card">{items.map((r) => <PhoneRow key={r.id} r={r} today={today} onMenu={() => setAct(r)}
              onDone={() => { const s = doneStatus(r); if (s && s.id !== r.statusId) void save([{ id: r.id, statusId: s.id }], `${r.key} done`); }} />)}</div>
          </section>
        );
      })}
      <p className="ps3-phone-hint">Swipe a task to change status · hold for more</p>
      {act && <>
        <div className="ps3-scrim" onClick={() => setAct(null)} />
        <div className="ps3-sheet-bottom ps3-float ps3-pop" style={{ position: 'fixed', borderRadius: '18px 18px 0 0', top: 'auto' }} role="dialog" aria-label={`${act.key} ${act.title}`}>
          <div style={{ padding: '4px 18px 10px' }}><span className="ps3-key">{act.key}</span><div style={{ fontWeight: 600, fontSize: 16, marginTop: 2 }}>{act.title}</div></div>
          <div className="ph">Status</div>
          {(statusesBy.get(act.projectId) ?? []).map((s) => <button key={s.id} type="button" className={`it ${s.id === act.statusId ? 'on' : ''}`}
            onClick={() => { const r = act; setAct(null); if (s.id !== r.statusId) void save([{ id: r.id, statusId: s.id }], `${r.key} → ${s.name}`); }}>
            <Dot k={s.category === 'Done' ? 'done' : s.category === 'Active' ? 'prog' : 'todo'} />{s.name}</button>)}
          {act.due && <><div className="ph">Move due date</div><div className="row">{[1, 2, 7].map((n) => <button key={n} type="button" className="ps3-qc"
            onClick={() => { const r = act; setAct(null); void save([{ id: r.id, dueDate: addDays(r.due!, n) }], `Moved ${r.key}`); }}>+{n === 7 ? '1 week' : `${n}d`}</button>)}</div></>}
          <div className="ph">Progress</div><div className="row">{[0, 25, 50, 75, 100].map((n) => <button key={n} type="button" className={`ps3-qc ${act.progress === n ? 'on' : ''}`}
            onClick={() => { const r = act; setAct(null); void save([{ id: r.id, progress: n }], `${r.key} progress ${n}%`); }}>{n}%</button>)}</div>
          <div className="ph">Owner</div>
          {data.people.slice(0, 8).map((x) => <button key={x.id} type="button" className={`it ${x.id === act.ownerId ? 'on' : ''}`}
            onClick={() => { const r = act; setAct(null); if (x.id !== r.ownerId) void save([{ id: r.id, assigneeId: x.id }], `Gave ${r.key} to ${x.name}`); }}><Av id={x.id} name={x.name} />{x.name}</button>)}
          <div style={{ height: 10 }} /><span className="ps3-vh">{rows.length}</span>
        </div>
      </>}
    </div>
  );
}

function PhoneRow({ r, today, onDone, onMenu }: { r: SheetRow; today: string; onDone: () => void; onMenu: () => void }) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const press = useRef<number | null>(null);
  const k = statusKey(r), s = slipDays(r, today);
  const end = () => {
    if (press.current) { clearTimeout(press.current); press.current = null; }
    if (dx > 90) onDone(); else if (dx < -90) onMenu();
    setDx(0); start.current = null;
  };
  return (
    <div className="ps3-swipe">
      {dx !== 0 && <div className={`ps3-under ${dx < 0 ? 'left' : ''}`} aria-hidden="true">{dx > 0 ? '✓ Done' : 'More'}</div>}
      <div className="ps3-card-row" role="button" tabIndex={0} aria-label={`${r.key} ${r.title}`} style={{ transform: dx ? `translateX(${dx}px)` : undefined }}
        onClick={() => { if (!dx) onMenu(); }} onKeyDown={(e) => { if (e.key === 'Enter') onMenu(); }}
        onTouchStart={(e) => { const t = e.touches[0]; start.current = { x: t.clientX, y: t.clientY }; press.current = window.setTimeout(() => { press.current = null; onMenu(); }, 550); }}
        onTouchMove={(e) => { const st = start.current; if (!st) return; const t = e.touches[0]; const x = t.clientX - st.x; if (Math.abs(x) > 8 && press.current) { clearTimeout(press.current); press.current = null; } if (Math.abs(x) > Math.abs(t.clientY - st.y)) setDx(Math.max(-140, Math.min(140, x))); }}
        onTouchEnd={end} onContextMenu={(e) => { e.preventDefault(); onMenu(); }}>
        <span className={`ps3-gl ${k}`} style={{ marginTop: 5 }} aria-hidden="true" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t">{r.title}</div>
          <div className="m">{r.owner && <><Av id={r.ownerId} name={r.owner} size={16} />{r.owner.split(' ')[0]} ·</>}
            <span style={{ color: k === 'late' ? 'var(--p-red)' : 'inherit' }}>{dm(r.due) || 'No date'}</span>{s > 0 && <b style={{ color: k === 'late' ? 'var(--p-red)' : 'var(--p-orange)' }}>+{s}d</b>}</div>
          {r.progress != null && <div style={{ marginTop: 8 }}><Progress value={r.progress} k={k} /></div>}
        </div>
      </div>
    </div>
  );
}

