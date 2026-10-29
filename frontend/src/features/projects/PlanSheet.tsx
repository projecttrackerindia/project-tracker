import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { ApiError, get, put } from '../../api/client';
import { bulkApi, savedViewApi, type SavedView } from '../../api/platformApi';
import { Icon } from '../../components/Icon';
import { ErrorState, Modal, PageLoader } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { dueChange } from './DueChangeFields';
import { portfolioApi, type PasteResult, type PlanSheet as PlanSheetData, type PortfolioFilter, type SheetChange, type SheetRow, type SheetStatus } from './portfolioApi';
import {
  ago, buildDisplay, cellText, DEFAULT_CONFIG, DEFAULT_FILTERS, dayNum, dm, isItem, isOpen, mapColumns, parseDue, parseTsv, parseTypedDate, pasteRows, PASTE_FIELDS, totals,
  type ColId, type Display, type GroupBy, type PasteField, type SheetConfig, type SheetFilters,
} from './planSheet';
import './planSheet.css';

// ---------------------------------------------------------------- columns

interface Col { id: ColId; label: string; w: number; frozen?: boolean; num?: boolean }
const BASE_COLS: Col[] = [
  { id: 'key', label: 'Key', w: 86, frozen: true }, { id: 'title', label: 'Title', w: 178, frozen: true }, { id: 'owner', label: 'Owner', w: 132 },
  { id: 'start', label: 'Start', w: 66 }, { id: 'due', label: 'End / Due', w: 112 }, { id: 'dur', label: 'Dur.', w: 52, num: true }, { id: 'status', label: 'Status', w: 104 },
  { id: 'progress', label: 'Progress', w: 92 }, { id: 'deps', label: 'Depends', w: 74 }, { id: 'meeting', label: 'Meeting', w: 212 }, { id: 'updated', label: 'Updated', w: 84 },
  { id: 'notes', label: 'Notes', w: 190 },
];
const SEL_W = 34, GANTT_W = 260;
const EXPORT_NAME: Record<ColId, string> = { key: 'Key', title: 'Title', owner: 'Owner', start: 'Start', due: 'Due', dur: 'Duration', status: 'Status', progress: 'Progress', deps: 'Depends on', meeting: 'Meeting', updated: 'Updated', notes: 'Notes' };
const GROUP_LABEL: Record<GroupBy, string> = { project: 'Project › Task', owner: 'Owner', status: 'Status', cadence: 'Meeting cadence', none: 'None (flat list)' };
const REASONS = ['Waiting on external', 'Scope changed', 'Capacity', 'Dependency late'];
type Layout = 'grid' | 'gridTimeline';

const initials = (n: string | null | undefined) => (n ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
const HUES = [212, 280, 150, 18, 330, 190, 40, 250];
const hue = (id: string | null | undefined) => HUES[[...(id ?? '')].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
function Who({ id, name, bold, size = 20 }: { id: string | null; name: string | null; bold?: boolean; size?: number }) {
  if (!name) return <span className="psh-muted">—</span>;
  return <span className={`psh-who ${bold ? 'b' : ''}`}><i style={{ '--h': hue(id), width: size, height: size } as CSSProperties} aria-hidden="true">{initials(name)}</i><span>{name}</span></span>;
}
function chipTone(r: SheetRow): string {
  if (r.kind === 'meeting') return 'blue';
  if (r.kind === 'project') return r.category === 'Delayed' ? 'red' : r.category === 'AtRisk' ? 'orange' : r.progress === 100 ? 'green' : r.category === 'OnHold' ? '' : 'blue';
  if (/block|wait/i.test(r.status)) return 'red';
  return r.category === 'Done' ? 'green' : r.category === 'Active' ? 'blue' : r.category === 'Cancelled' ? '' : '';
}
export function StatusChip({ r }: { r: SheetRow }) {
  const label = r.kind === 'project' && r.progress === 100 ? 'Done' : r.status;
  return <span className={`psh-chip ${chipTone(r)}`}>{label}</span>;
}
export function Cadence({ c }: { c: string }) {
  const tone = c === 'Daily' ? 'blue' : /week|fortnight/i.test(c) ? 'violet' : /month/i.test(c) ? 'orange' : '';
  return <span className={`psh-chip ${tone}`}>{c}</span>;
}
const nextText = (iso: string | null) => iso ? `${new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} · ${new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}` : '';
const lateDays = (r: SheetRow, today: string) => r.due && r.late ? Math.max(1, dayNum(today) - dayNum(r.due)) : 0;

function usePhone() {
  const q = '(max-width: 760px)';
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => { const m = window.matchMedia(q); const on = () => setPhone(m.matches); m.addEventListener('change', on); return () => m.removeEventListener('change', on); }, []);
  return phone;
}

interface Prefs { defaultView?: string | null }

// ---------------------------------------------------------------- the view

/**
 * Portfolio › Plan sheet: every project, task, sub-item and meeting in one grid, edited like Excel and saved as you go through the Work API (one row at a
 * time on the server, so every rule applies). Arrow keys move, Enter / F2 / typing edits, Tab and Shift+Tab save and move, Esc cancels, Ctrl D fills
 * down; checkboxes (or Shift-click) select rows for the bulk bar. A due date moving later asks for one reason for the whole batch. Ctrl V of rows copied
 * from Excel opens a preview that is checked on the server first. On a phone each row is a card under its project, with swipe actions.
 */
export function PlanSheetView({ filter, actionsSlot, onPresent }: { filter: PortfolioFilter; actionsSlot: HTMLElement | null; onPresent: () => void }) {
  const phone = usePhone();
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx?.user?.id) ?? null;
  const [params, setParams] = useSearchParams();
  const [scope, setScope] = useState<{ id: string; teamId: string | null; label: string }>({ id: 'all', teamId: null, label: 'Everything I can see' });
  const f: PortfolioFilter = scope.teamId ? { ...filter, teamId: scope.teamId } : filter;
  const mine = scope.id === 'mine';
  const q = useWsQuery(['portfolio', 'sheet', f, mine], () => portfolioApi.sheet(f, mine), { staleTime: 30_000, placeholderData: (p) => p });
  const [cfg, setCfg] = useState<SheetConfig>(DEFAULT_CONFIG);
  const [layout, setLayout] = useState<Layout>('grid');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Map<string, Partial<SheetRow>>>(new Map());
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [announce, setAnnounce] = useState('');
  const [reasonAsk, setReasonAsk] = useState<{ changes: SheetChange[]; moves: { key: string; from: string; to: string; days: number | null }[] } | null>(null);
  const [paste, setPaste] = useState<string[][] | null>(null);
  const [menu, setMenu] = useState<null | 'export' | 'filter' | 'views' | 'viewing' | 'group'>(null);
  const views = useWsQuery(['saved-views', 'portfolio'], () => savedViewApi.list('portfolio'), { staleTime: 60_000, retry: false });
  const prefs = useWsQuery(['ui', 'plansheet'], async () => { try { return (await get<{ value: Prefs | null }>('/me/ui/plansheet'))?.value ?? {}; } catch { return {}; } }, { staleTime: 300_000 });
  const sheetViews = useMemo(() => (views.data ?? []).filter((v) => v.config.list === 'sheet'), [views.data]);
  const [activeView, setActiveView] = useState<string | null>(null);
  const today = q.data?.asOf ?? new Date().toISOString().slice(0, 10);

  const applyView = useCallback((v: SavedView) => {
    const c = v.config as { group?: GroupBy; sort?: SheetConfig['sort']; filters?: Partial<SheetFilters>; layout?: Layout };
    setCfg({ group: c.group ?? 'project', sort: c.sort ?? null, filters: { ...DEFAULT_FILTERS, ...(c.filters ?? {}), values: c.filters?.values ?? {} } });
    if (c.layout) setLayout(c.layout);
    setActiveView(v.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only setters (the parser reads `c.layout` as the `layout` state)
  }, []);
  // Deep link ?v=<saved view>, else my default view.
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current || !views.data || !prefs.data) return;
    const id = params.get('v') ?? prefs.data.defaultView ?? null;
    const v = sheetViews.find((x) => x.id === id);
    applied.current = true;
    if (v) applyView(v);
  }, [views.data, prefs.data, sheetViews, params, applyView]);

  const data = q.data;
  const rows = useMemo(() => (data?.rows ?? []).map((r) => { const o = overrides.get(r.id); return o ? { ...r, ...o } : r; }), [data, overrides]);
  const display = useMemo(() => buildDisplay(rows, cfg, collapsed, me, today), [rows, cfg, collapsed, me, today]);
  const statusesBy = useMemo(() => {
    const m = new Map<string, SheetStatus[]>();
    for (const s of data?.statuses ?? []) m.set(s.projectId, [...(m.get(s.projectId) ?? []), s]);
    return m;
  }, [data]);
  const nameOf = useCallback((id: string | null | undefined) => data?.people.find((p) => p.id === id)?.name ?? null, [data]);

  // ---- saving: optimistic, through the bulk endpoint (one row at a time on the server), with a reason for later due dates
  const save = useCallback(async (changes: SheetChange[], reason?: string, dependency?: string) => {
    if (!data || changes.length === 0) return;
    if (reason === undefined) {
      const moves = changes.flatMap((c) => {
        const r = rows.find((x) => x.id === c.id); if (!r || !c.dueDate) return [];
        const d = dueChange(r.due, c.dueDate);
        const timeLater = !d && r.due === c.dueDate && !!c.dueTime && !!r.dueTime && c.dueTime > r.dueTime;
        return d?.delay || timeLater ? [{ key: r.key, from: r.due!, to: c.dueDate, days: d?.days ?? 0 }] : [];
      });
      if (moves.length) { setReasonAsk({ changes, moves }); return; }
    }
    const patch = new Map(overrides);
    for (const c of changes) {
      const r = rows.find((x) => x.id === c.id); if (!r) continue;
      const o: Partial<SheetRow> = { ...(patch.get(c.id) ?? {}) };
      if (c.title !== undefined) o.title = c.title;
      if (c.unassign) { o.ownerId = null; o.owner = null; }
      if (c.assigneeId) { o.ownerId = c.assigneeId; o.owner = nameOf(c.assigneeId); }
      if (c.startDate) o.start = c.startDate;
      if (c.clearStart) o.start = null;
      if (c.dueDate) { o.due = c.dueDate; o.late = isOpen(r) && dayNum(c.dueDate) < dayNum(today); }
      if (c.dueTime) o.dueTime = c.dueTime;
      if (c.statusId) { const s = data.statuses.find((x) => x.id === c.statusId); if (s) { o.statusId = s.id; o.status = s.name; o.category = s.category; } }
      const start = o.start !== undefined ? o.start : r.start, due = o.due !== undefined ? o.due : r.due;
      o.durationDays = start && due && dayNum(due) >= dayNum(start) ? dayNum(due) - dayNum(start) + 1 : null;
      patch.set(c.id, o);
    }
    setOverrides(patch);
    try {
      const withVersions = changes.map((c) => ({ ...c, version: c.version ?? rows.find((x) => x.id === c.id)?.version }));
      const res = await portfolioApi.sheetBulk(withVersions, reason, dependency);
      const failed = res.rows.filter((x) => !x.ok);
      setOverrides((cur) => {
        const n = new Map(cur);
        for (const x of res.rows) {
          if (!x.ok) n.delete(x.id);
          else if (x.version != null) n.set(x.id, { ...(n.get(x.id) ?? {}), version: x.version });
        }
        return n;
      });
      if (res.changed) { setSavedAt(Date.now()); setAnnounce(`${res.changed === 1 ? 'Saved' : `${res.changed} rows saved`}`); }
      if (failed.length) {
        const first = failed[0];
        toast(failed.length === 1 ? `${first.key ?? 'A row'}: ${first.error ?? 'not saved'}` : `${res.changed} saved · ${failed.length} not saved (${first.key ?? 'a row'}: ${first.error})`, 'error');
      }
      await q.refetch();
      setOverrides(new Map());
    } catch (e) {
      setOverrides(new Map(overrides));
      toast(e instanceof ApiError ? e.message : 'The change could not be saved.', 'error');
    }
  }, [data, rows, overrides, nameOf, today, q]);

  // ---- paste anywhere on the sheet (not while typing in a field)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input,textarea,[contenteditable="true"]') || t.closest('.modal, .psh-paste'))) return;
      if (!document.querySelector('.psh')) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      const grid = parseTsv(text);
      if (grid.length === 0 || (grid.length === 1 && grid[0].length === 1)) return;
      e.preventDefault();
      if (grid.length > 500 && !window.confirm(`Paste ${grid.length} rows? That is more than 500.`)) return;
      setPaste(grid);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  const exportAs = async (format: 'xlsx' | 'csv', opts: { visible: boolean; meetings: boolean }) => {
    setMenu(null);
    try {
      const visibleRows = display.flatMap((d) => (d.type === 'row' ? [d.row.id] : []));
      await portfolioApi.sheetExport(f, { format, mine, meetings: opts.meetings, columns: opts.visible ? cols(layout, data?.meetings ?? false).map((c) => EXPORT_NAME[c.id]) : undefined,
        ids: opts.visible && anyActive(cfg, collapsed) ? visibleRows : undefined });
    } catch { toast('The export could not be made.', 'error'); }
  };

  const saveView = async (name: string) => {
    try {
      const v = await savedViewApi.create({ scope: 'portfolio', name, sharing: 'private', config: { list: 'sheet', group: cfg.group, sort: cfg.sort, filters: cfg.filters, layout } });
      setActiveView(v.id); void invalidateWorkspace(wid, 'saved-views'); toast(`Saved the view “${name}”.`);
      const n = new URLSearchParams(params); n.set('v', v.id); setParams(n, { replace: true });
    } catch (e) { toast(e instanceof ApiError ? e.message : 'The view could not be saved.', 'error'); }
  };
  const setDefault = async (id: string | null) => {
    try { await put('/me/ui/plansheet', { value: { ...(prefs.data ?? {}), defaultView: id } }); void invalidateWorkspace(wid, 'ui', 'plansheet'); void prefs.refetch(); }
    catch { toast('Could not set the default view.', 'error'); }
  };

  const actions = actionsSlot && createPortal(
    <div className="psh-head-actions">
      <button type="button" className="psh-btn" onClick={() => setPaste([])}><Icon name="upload" size={14} />Paste from Excel</button>
      <span className="psh-rel">
        <button type="button" className={`psh-btn ${menu === 'export' ? 'pri' : ''}`} aria-haspopup="menu" aria-expanded={menu === 'export'} onClick={() => setMenu(menu === 'export' ? null : 'export')}>
          <Icon name="download" size={14} />Export</button>
        {menu === 'export' && <ExportMenu viewName={sheetViews.find((v) => v.id === activeView)?.name ?? 'Plan sheet'} rows={display.filter((d) => d.type === 'row').length}
          cols={cols(layout, data?.meetings ?? false).length} zone={data?.timeZone ?? ''} meetingsAvailable={!!data?.meetings} onExport={exportAs} onClose={() => setMenu(null)} />}
      </span>
      <button type="button" className="psh-btn" onClick={onPresent}><Icon name="play" size={14} />Present sheet</button>
    </div>, actionsSlot);

  if (q.isLoading) return <>{actions}<PageLoader /></>;
  if (q.isError || !data) return <>{actions}<ErrorState error={q.error} retry={() => q.refetch()} /></>;

  const viewName = sheetViews.find((v) => v.id === activeView)?.name;
  const toolbar = (
    <div className="psh-toolbar" role="toolbar" aria-label="Plan sheet tools">
      <span className="psh-rel">
        <button type="button" className="psh-viewing" aria-haspopup="menu" aria-expanded={menu === 'viewing'} onClick={() => setMenu(menu === 'viewing' ? null : 'viewing')}>
          Viewing: {scope.label} <Icon name="chevronD" size={13} /></button>
        {menu === 'viewing' && (
          <Pop label="Viewing" onClose={() => setMenu(null)} className="psh-menu">
            <div className="hd">WHAT THE SHEET SHOWS</div>
            {data.scopes.filter((s) => s.id !== 'team').map((s) => (
              <button key={s.id} type="button" role="menuitemradio" aria-checked={scope.id === s.id} disabled={!s.allowed} className={`mi ${scope.id === s.id ? 'on' : ''}`}
                title={s.why ?? undefined} onClick={() => { setScope({ id: s.id, teamId: null, label: s.label }); setMenu(null); }}>
                {!s.allowed && <Icon name="lock" size={13} />}{s.label}{!s.allowed && <small>{s.why}</small>}{scope.id === s.id && <small>✓</small>}
              </button>
            ))}
            {data.scopes.some((s) => s.id === 'team') && <><hr /><div className="hd">ONE TEAM</div></>}
            {data.scopes.filter((s) => s.id === 'team').map((s) => (
              <button key={s.teamId} type="button" role="menuitemradio" aria-checked={scope.teamId === s.teamId} className={`mi ${scope.teamId === s.teamId ? 'on' : ''}`}
                onClick={() => { setScope({ id: 'team', teamId: s.teamId, label: s.label }); setMenu(null); }}>{s.label}</button>
            ))}
          </Pop>
        )}
      </span>
      <span className="psh-rel">
        <button type="button" className="psh-btn sm" aria-haspopup="menu" aria-expanded={menu === 'views'} onClick={() => setMenu(menu === 'views' ? null : 'views')}>My views <Icon name="chevronD" size={13} /></button>
        {menu === 'views' && <ViewsMenu views={sheetViews} active={activeView} defaultId={prefs.data?.defaultView ?? null} onApply={(v) => { applyView(v); setMenu(null); }}
          onSave={(n) => { void saveView(n); setMenu(null); }} onDefault={(id) => void setDefault(id)} onClose={() => setMenu(null)} />}
      </span>
      {viewName && <span className="psh-chip blue lg">View: {viewName}</span>}
      <FilterChips cfg={cfg} setCfg={(c) => { setCfg(c); setActiveView(null); }} />
      <span className="psh-rel">
        <button type="button" className={`psh-btn sm ${menu === 'filter' ? 'pri' : ''}`} aria-haspopup="dialog" aria-expanded={menu === 'filter'} onClick={() => setMenu(menu === 'filter' ? null : 'filter')}>
          <Icon name="filter" size={13} />Filter · Group</button>
        {menu === 'filter' && <FilterGroup cfg={cfg} rows={rows} setCfg={(c) => { setCfg(c); setActiveView(null); }} views={sheetViews} defaultId={prefs.data?.defaultView ?? null}
          onApply={(v) => { applyView(v); setMenu(null); }} onSave={(n) => { void saveView(n); setMenu(null); }} onClose={() => setMenu(null)} />}
      </span>
      <span className="psh-rel">
        <button type="button" className="psh-btn sm" aria-haspopup="menu" aria-expanded={menu === 'group'} onClick={() => setMenu(menu === 'group' ? null : 'group')}>Group: {GROUP_LABEL[cfg.group]}</button>
        {menu === 'group' && (
          <Pop label="Group by" onClose={() => setMenu(null)} className="psh-menu">
            {(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => <button key={g} type="button" role="menuitemradio" aria-checked={cfg.group === g} className={`mi ${cfg.group === g ? 'on' : ''}`}
              onClick={() => { setCfg({ ...cfg, group: g }); setActiveView(null); setMenu(null); }}>{GROUP_LABEL[g]}{cfg.group === g && <small>✓</small>}</button>)}
          </Pop>
        )}
      </span>
      <span className="psh-sp" />
      <div className="psh-seg" role="tablist" aria-label="Sheet layout">
        <button type="button" role="tab" aria-selected={layout === 'grid'} className={layout === 'grid' ? 'on' : ''} onClick={() => setLayout('grid')}>Grid</button>
        <button type="button" role="tab" aria-selected={layout === 'gridTimeline'} className={layout === 'gridTimeline' ? 'on' : ''} onClick={() => setLayout('gridTimeline')}>Grid + timeline</button>
        <button type="button" role="tab" aria-selected={false} onClick={() => { const n = new URLSearchParams(params); n.set('view', 'portfolio'); n.set('mode', 'timeline'); setParams(n, { replace: true }); }}>Timeline</button>
      </div>
    </div>
  );

  return (
    <div className="psh">
      {actions}
      <div className="psh-live" aria-live="polite" role="status">{announce}</div>
      {phone ? (
        <PhoneSheet data={data} rows={rows} cfg={cfg} setCfg={setCfg} collapsed={collapsed} me={me} today={today} statusesBy={statusesBy} save={save} />
      ) : (
        <>
          {toolbar}
          <Grid data={data} display={display} layout={layout} today={today} collapsed={collapsed} cfg={cfg} rowsAll={rows}
            setCfg={(c) => { setCfg(c); setActiveView(null); }} statusesBy={statusesBy} save={save}
            toggle={(id) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })} refresh={() => q.refetch()} />
          <div className="psh-hints">
            <span>{savedAt ? `Saved · ${ago(new Date(savedAt).toISOString())}` : data.truncated ? 'Showing the first 5,000 rows' : 'Changes save as you go'}</span>
            <span><kbd>↵</kbd> edit</span><span><kbd>Tab</kbd> next cell</span><span><kbd>Ctrl D</kbd> fill down</span><span><kbd>Ctrl V</kbd> paste rows</span>
            <span>Red date = late · amber = at risk · <i className="psh-dia" /> meeting</span>
            <span>Times in {data.timeZone}</span>
          </div>
        </>
      )}
      {reasonAsk && <ReasonModal moves={reasonAsk.moves} onClose={() => setReasonAsk(null)}
        onSave={(reason, dep) => { const c = reasonAsk.changes; setReasonAsk(null); void save(c, reason, dep); }} />}
      {paste && <PasteModal grid={paste} data={data} onClose={() => setPaste(null)} defaultProject={firstProject(display)}
        onDone={() => { setPaste(null); void q.refetch(); }} />}
    </div>
  );
}

const firstProject = (display: Display[]) => { for (const d of display) if (d.type === 'row') return d.row.projectId; return null; };
const anyActive = (cfg: SheetConfig, collapsed: Set<string>) => collapsed.size > 0 || cfg.group !== 'project' || Object.values(cfg.filters).some((v) => (typeof v === 'boolean' ? v : Object.values(v).some((x) => (x as string[] | undefined)?.length)));
// The Meeting column only when there are meetings to show; Grid + timeline adds the mini-Gantt column after these.
const cols = (_layout: Layout, meetings: boolean) => BASE_COLS.filter((c) => meetings || c.id !== 'meeting');

// ---------------------------------------------------------------- small popover

function Pop({ label, onClose, children, className = '', style, role = 'menu' }: { label: string; onClose: () => void; children: ReactNode; className?: string; style?: CSSProperties; role?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[aria-expanded="true"]')) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [onClose]);
  // Inside the grid's frame, a popover that would be cut off at the bottom opens upwards instead.
  const [up, setUp] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current; const frame = el?.closest('.psh-frame'); if (!el || !frame) return;
    if (el.getBoundingClientRect().bottom > frame.getBoundingClientRect().bottom - 4) setUp(true);
  }, []);
  return <div ref={ref} role={role} aria-label={label} className={`psh-pop ${className} ${up ? 'up' : ''}`} style={style}>{children}</div>;
}

function ExportMenu({ viewName, rows, cols: n, zone, meetingsAvailable, onExport, onClose }: {
  viewName: string; rows: number; cols: number; zone: string; meetingsAvailable: boolean; onExport: (f: 'xlsx' | 'csv', o: { visible: boolean; meetings: boolean }) => void; onClose: () => void;
}) {
  const [visible, setVisible] = useState(true);
  const [meetings, setMeetings] = useState(true);
  return (
    <Pop label="Export" onClose={onClose} className="psh-menu psh-export">
      <div className="hd">EXPORT “{viewName.toUpperCase()}”</div>
      <button type="button" role="menuitem" className="mi on" onClick={() => onExport('xlsx', { visible, meetings })}>Excel workbook (.xlsx)<small>⌘E</small></button>
      <button type="button" role="menuitem" className="mi" onClick={() => onExport('csv', { visible, meetings })}>CSV (.csv)</button>
      <button type="button" role="menuitem" className="mi" disabled title="Not available yet">PDF — one page per project<small>Soon</small></button>
      <hr />
      <button type="button" role="menuitemcheckbox" aria-checked={visible} className="mi" onClick={() => setVisible(!visible)}><span className={`psh-check ${visible ? 'on' : ''}`}>{visible && '✓'}</span>Only visible columns & filters</button>
      <button type="button" role="menuitemcheckbox" aria-checked className="mi" disabled><span className="psh-check on">✓</span>Keep groups as outline levels</button>
      <button type="button" role="menuitemcheckbox" aria-checked={false} className="mi" disabled title="Not available yet"><span className="psh-check" />Include timeline as colour cells</button>
      {meetingsAvailable && <button type="button" role="menuitemcheckbox" aria-checked={meetings} className="mi" onClick={() => setMeetings(!meetings)}><span className={`psh-check ${meetings ? 'on' : ''}`}>{meetings && '✓'}</span>Include meeting rows</button>}
      <hr />
      <div className="mi note">{rows} rows · {n} columns · dates in {zone}</div>
    </Pop>
  );
}

function ViewsMenu({ views, active, defaultId, onApply, onSave, onDefault, onClose }: {
  views: SavedView[]; active: string | null; defaultId: string | null; onApply: (v: SavedView) => void; onSave: (name: string) => void; onDefault: (id: string | null) => void; onClose: () => void;
}) {
  const [name, setName] = useState('');
  return (
    <Pop label="My views" onClose={onClose} className="psh-menu">
      <div className="hd">SAVED VIEWS</div>
      {views.length === 0 && <div className="mi note">No saved views yet</div>}
      {views.map((v) => (
        <div key={v.id} className={`mi split ${active === v.id ? 'on' : ''}`}>
          <button type="button" role="menuitem" onClick={() => onApply(v)}>{v.name}</button>
          <button type="button" className="star" aria-label={defaultId === v.id ? `${v.name} is the default; remove` : `Make ${v.name} the default`} aria-pressed={defaultId === v.id}
            onClick={() => onDefault(defaultId === v.id ? null : v.id)}>{defaultId === v.id ? '★' : '☆'}</button>
        </div>
      ))}
      <hr />
      <form className="psh-save-view" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave(name.trim()); }}>
        <input aria-label="Name for the current view" placeholder="Save current as view…" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        <button type="submit" className="psh-btn sm pri" disabled={!name.trim()}>Save</button>
      </form>
    </Pop>
  );
}

function FilterChips({ cfg, setCfg }: { cfg: SheetConfig; setCfg: (c: SheetConfig) => void }) {
  const f = cfg.filters;
  const off = (k: keyof Omit<SheetFilters, 'values'>) => setCfg({ ...cfg, filters: { ...f, [k]: false } });
  const chips: [string, () => void][] = [];
  if (f.notDone) chips.push(['Status ≠ Done', () => off('notDone')]);
  if (f.due30) chips.push(['Due in 30 days', () => off('due30')]);
  if (f.lateOnly) chips.push(['Late only', () => off('lateOnly')]);
  if (f.meetingsOnly) chips.push(['Meeting rows only', () => off('meetingsOnly')]);
  for (const [c, v] of Object.entries(f.values) as [ColId, string[]][]) if (v?.length) chips.push([`${BASE_COLS.find((x) => x.id === c)?.label}: ${v.length === 1 ? v[0] : `${v.length} values`}`, () => setCfg({ ...cfg, filters: { ...f, values: { ...f.values, [c]: [] } } })]);
  return (
    <>
      {chips.map(([label, clear]) => <span key={label} className="psh-chip lg">{label}<button type="button" aria-label={`Remove filter ${label}`} onClick={clear}>✕</button></span>)}
      <button type="button" className={`psh-chip lg ${f.ownerMe ? 'blue' : ''}`} aria-pressed={f.ownerMe} onClick={() => setCfg({ ...cfg, filters: { ...f, ownerMe: !f.ownerMe } })}>{f.ownerMe ? 'Owner: me ✕' : 'Owner: any'}</button>
    </>
  );
}

function FilterGroup({ cfg, rows, setCfg, views, defaultId, onApply, onSave, onClose }: {
  cfg: SheetConfig; rows: SheetRow[]; setCfg: (c: SheetConfig) => void; views: SavedView[]; defaultId: string | null; onApply: (v: SavedView) => void; onSave: (n: string) => void; onClose: () => void;
}) {
  const f = cfg.filters;
  const [name, setName] = useState('');
  const toggle = (k: keyof Omit<SheetFilters, 'values'>) => setCfg({ ...cfg, filters: { ...f, [k]: !f[k] } });
  const late = rows.filter((r) => isItem(r) && r.late).length, meetings = rows.filter((r) => r.kind === 'meeting').length;
  const item = (k: keyof Omit<SheetFilters, 'values'>, label: string, n?: number) => (
    <button type="button" role="menuitemcheckbox" aria-checked={f[k]} className="mi" onClick={() => toggle(k)}><span className={`psh-check ${f[k] ? 'on' : ''}`}>{f[k] && '✓'}</span>{label}{n != null && <small>{n}</small>}</button>
  );
  return (
    <Pop label="Filter and group" onClose={onClose} className="psh-fg" role="dialog">
      <div className="psh-menu">
        <div className="hd">FILTER</div>
        {item('notDone', 'Status is not Done')}{item('due30', 'Due within next 30 days')}{item('lateOnly', 'Late only', late)}{item('ownerMe', 'Owner is me')}{item('meetingsOnly', 'Meeting rows only', meetings)}
        <hr />
        <div className="hd">SORT</div>
        {(['due', 'start', 'title', 'owner', 'progress'] as ColId[]).map((c) => {
          const on = cfg.sort?.col === c;
          return <button key={c} type="button" className={`mi ${on ? 'on' : ''}`} onClick={() => setCfg({ ...cfg, sort: on ? (cfg.sort!.dir === 1 ? { col: c, dir: -1 } : null) : { col: c, dir: 1 } })}>
            {BASE_COLS.find((x) => x.id === c)!.label} · {on && cfg.sort!.dir === -1 ? 'latest first' : 'earliest first'}<small>{on ? (cfg.sort!.dir === 1 ? '↑' : '↓') : '⇅'}</small></button>;
        })}
      </div>
      <div className="psh-menu">
        <div className="hd">GROUP BY</div>
        {(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => <button key={g} type="button" className={`mi ${cfg.group === g ? 'on' : ''}`} onClick={() => setCfg({ ...cfg, group: g })}>{GROUP_LABEL[g]}{cfg.group === g && <small>✓</small>}</button>)}
        <hr />
        <div className="hd">SAVED VIEWS</div>
        {views.map((v) => <button key={v.id} type="button" className="mi" onClick={() => onApply(v)}>{defaultId === v.id ? '★ ' : ''}{v.name}{defaultId === v.id && <small>default</small>}</button>)}
        <form className="psh-save-view" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave(name.trim()); }}>
          <input aria-label="Save current as view" placeholder="Save current as view…" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <button type="submit" className="psh-btn sm pri" disabled={!name.trim()}>Save</button>
        </form>
      </div>
    </Pop>
  );
}

// ---------------------------------------------------------------- the grid

type Editing = { id: string; col: ColId; draft: string | null };
const EDITABLE_TASK: ColId[] = ['title', 'owner', 'start', 'due', 'status'];
const EDITABLE_PROJECT: ColId[] = ['owner', 'start', 'due'];
const canEditCell = (r: SheetRow, c: ColId) => r.canEdit && (r.kind === 'project' ? EDITABLE_PROJECT.includes(c) : r.kind === 'meeting' ? false : EDITABLE_TASK.includes(c));

function Grid({ data, display, layout, today, collapsed, cfg, rowsAll, setCfg, statusesBy, save, toggle, refresh }: {
  data: PlanSheetData; display: Display[]; layout: Layout; today: string; collapsed: Set<string>; cfg: SheetConfig; rowsAll: SheetRow[]; setCfg: (c: SheetConfig) => void;
  statusesBy: Map<string, SheetStatus[]>; save: (c: SheetChange[]) => Promise<void>; toggle: (id: string) => void; refresh: () => Promise<unknown>;
}) {
  const columns = cols(layout, data.meetings);
  const nav = useMemo(() => display.flatMap((d) => (d.type === 'row' ? [d.row] : [])), [display]);
  const [active, setActive] = useState<{ r: number; c: number }>({ r: 0, c: 1 });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [headMenu, setHeadMenu] = useState<ColId | null>(null);
  const [bulk, setBulk] = useState<null | 'owner' | 'dates' | 'status'>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [maxH, setMaxH] = useState<number>(560);
  useEffect(() => {
    const fit = () => { const el = frame.current; if (!el) return; const top = el.getBoundingClientRect().top + window.scrollY; setMaxH(Math.max(320, window.innerHeight - top - 136)); };
    fit(); window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit);
  }, []);
  const lefts = useMemo(() => { let l = SEL_W; return columns.map((c) => { const x = l; l += c.w; return x; }); }, [columns]);
  const r = Math.min(active.r, Math.max(0, nav.length - 1));
  const activeRow = nav[r];
  const activeCol = columns[Math.min(active.c, columns.length - 1)];
  const focusGrid = () => requestAnimationFrame(() => wrap.current?.focus({ preventScroll: true }));
  useEffect(() => {
    const cell = wrap.current?.querySelector<HTMLElement>('[data-active="true"]');
    cell?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  const move = (dr: number, dc: number) => setActive((a) => ({ r: Math.max(0, Math.min(nav.length - 1, a.r + dr)), c: Math.max(0, Math.min(columns.length - 1, a.c + dc)) }));
  const startEdit = (draft: string | null) => {
    if (!activeRow || !activeCol || !canEditCell(activeRow, activeCol.id)) return;
    setEditing({ id: activeRow.id, col: activeCol.id, draft });
  };
  const finish = (change: SheetChange | null, then: 'down' | 'right' | 'left' | null) => {
    setEditing(null);
    if (change) void save([change]);
    if (then === 'down') move(1, 0); else if (then === 'right') move(0, 1); else if (then === 'left') move(0, -1);
    wrap.current?.focus({ preventScroll: true });
    focusGrid();
  };

  // Fill down: the active column from the first selected row (or the row above) into the others.
  const fillChange = (src: SheetRow, dst: SheetRow, c: ColId): SheetChange | null => {
    if (!canEditCell(dst, c) || src.id === dst.id) return null;
    switch (c) {
      case 'owner': return src.ownerId ? (src.ownerId === dst.ownerId ? null : { id: dst.id, assigneeId: src.ownerId }) : dst.kind === 'project' || !dst.ownerId ? null : { id: dst.id, unassign: true };
      case 'start': return src.start && src.start !== dst.start ? { id: dst.id, startDate: src.start } : null;
      case 'due': return src.due && (src.due !== dst.due || src.dueTime !== dst.dueTime) ? { id: dst.id, dueDate: src.due, ...(src.dueTime && dst.kind !== 'project' ? { dueTime: src.dueTime } : {}) } : null;
      case 'status': {
        const target = statusesBy.get(dst.projectId) ?? [];
        const s = target.find((x) => x.name === src.status) ?? target.find((x) => x.category === src.category);
        return s && s.id !== dst.statusId ? { id: dst.id, statusId: s.id } : null;
      }
      case 'title': return src.title !== dst.title ? { id: dst.id, title: src.title } : null;
      default: return null;
    }
  };
  const fillDown = () => {
    if (!activeCol) return;
    const sel = nav.filter((x) => selected.has(x.id));
    let changes: SheetChange[];
    if (sel.length >= 2) changes = sel.slice(1).map((d) => fillChange(sel[0], d, activeCol.id)).filter((x): x is SheetChange => !!x);
    else { const above = nav[r - 1]; changes = above && activeRow ? [fillChange(above, activeRow, activeCol.id)].filter((x): x is SheetChange => !!x) : []; }
    if (changes.length === 0) { toast('Nothing to fill down here.', 'info'); return; }
    void save(changes);
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    if (e.target !== wrap.current) return;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && (k === 'd' || k === 'D')) { e.preventDefault(); fillDown(); return; }
    if (k === 'ArrowDown') { e.preventDefault(); if (e.shiftKey && activeRow) extendSel(r + 1); move(1, 0); }
    else if (k === 'ArrowUp') { e.preventDefault(); if (e.shiftKey && activeRow) extendSel(r - 1); move(-1, 0); }
    else if (k === 'ArrowRight') { e.preventDefault(); move(0, 1); }
    else if (k === 'ArrowLeft') { e.preventDefault(); move(0, -1); }
    else if (k === 'Tab') { e.preventDefault(); move(0, e.shiftKey ? -1 : 1); }
    else if (k === 'Home') { e.preventDefault(); setActive((a) => ({ ...a, c: 0 })); }
    else if (k === 'End') { e.preventDefault(); setActive((a) => ({ ...a, c: columns.length - 1 })); }
    else if (k === 'Enter' || k === 'F2') { e.preventDefault(); startEdit(null); }
    else if (k === ' ' && activeRow) { e.preventDefault(); toggleSel(activeRow.id, r, e.shiftKey); }
    else if (k === 'Escape') { setSelected(new Set()); }
    else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); startEdit(k); }
  };
  const extendSel = (to: number) => {
    const from = anchor ?? r; const [a, b] = [Math.min(from, to), Math.max(from, to)];
    if (anchor == null) setAnchor(r);
    setSelected(new Set(nav.slice(Math.max(0, a), b + 1).filter((x) => x.kind !== 'project').map((x) => x.id)));
  };
  const toggleSel = (id: string, index: number, shift: boolean) => {
    if (shift && anchor != null) { const [a, b] = [Math.min(anchor, index), Math.max(anchor, index)]; setSelected(new Set([...selected, ...nav.slice(a, b + 1).filter((x) => x.kind !== 'project').map((x) => x.id)])); return; }
    const n = new Set(selected); if (n.has(id)) n.delete(id); else n.add(id); setSelected(n); setAnchor(index);
  };
  const selRows = nav.filter((x) => selected.has(x.id));

  // Mini timeline (Grid + timeline): range of the visible dates, today line, meetings as diamonds.
  const g = useMemo(() => {
    const ds = nav.flatMap((x) => [x.start, x.due]).filter((x): x is string => !!x).map(dayNum);
    if (!ds.length) return null;
    const a = Math.min(...ds, dayNum(today)) - 3, b = Math.max(...ds, dayNum(today)) + 3;
    return { a, span: Math.max(1, b - a), x: (iso: string) => ((dayNum(iso) - a) / Math.max(1, b - a)) * 100 };
  }, [nav, today]);
  const t = totals(display);
  const totalW = SEL_W + columns.reduce((a, c) => a + c.w, 0) + (layout === 'gridTimeline' ? GANTT_W : 0);

  return (
    <>
      <div className="psh-frame" ref={frame} style={{ maxHeight: maxH }}>
        <div ref={wrap} className="psh-scroll" role="grid" aria-label="Plan sheet" aria-rowcount={nav.length + 2} aria-colcount={columns.length + 1} tabIndex={0} onKeyDown={onKey}
          aria-activedescendant={activeRow && activeCol ? `psh-${activeRow.id}-${activeCol.id}` : undefined}>
          <table className="psh-table" style={{ width: totalW }}>
            <colgroup><col style={{ width: SEL_W }} />{columns.map((c) => <col key={c.id} style={{ width: c.w }} />)}{layout === 'gridTimeline' && <col style={{ width: GANTT_W }} />}</colgroup>
            <thead>
              <tr role="row">
                <th className="frz" style={{ left: 0 }} role="columnheader"><span className="psh-vh">Select</span></th>
                {columns.map((c, i) => {
                  const sorted = cfg.sort?.col === c.id ? (cfg.sort.dir === 1 ? 'ascending' : 'descending') : 'none';
                  const filtered = (cfg.filters.values[c.id]?.length ?? 0) > 0;
                  return (
                    <th key={c.id} role="columnheader" aria-sort={sorted} className={`${c.frozen ? 'frz' : ''} ${c.id === 'title' ? 'frzline' : ''} ${c.num ? 'num' : ''}`} style={c.frozen ? { left: lefts[i] } : undefined}>
                      <span className="psh-th">{c.label}{sorted !== 'none' && <em>{sorted === 'ascending' ? '↑' : '↓'}</em>}
                        <button type="button" className={`psh-th-btn ${filtered ? 'on' : ''}`} aria-label={`Sort and filter ${c.label}`} aria-haspopup="menu" aria-expanded={headMenu === c.id}
                          onClick={() => setHeadMenu(headMenu === c.id ? null : c.id)}><Icon name="chevronD" size={11} /></button>
                      </span>
                      {headMenu === c.id && <HeadMenu col={c} cfg={cfg} rows={rowsAll} setCfg={setCfg} onClose={() => setHeadMenu(null)} />}
                    </th>
                  );
                })}
                {layout === 'gridTimeline' && <th role="columnheader">{g ? `${dm(new Date(g.a * 86_400_000).toISOString().slice(0, 10))} – ${dm(new Date((g.a + g.span) * 86_400_000).toISOString().slice(0, 10))}` : 'Timeline'}</th>}
              </tr>
            </thead>
            <tbody>
              {(() => { let n = -1; return display.map((d) => {
                if (d.type === 'group') return (
                  <tr key={d.id} className="grp" role="row">
                    <td className="frz" style={{ left: 0 }}><button type="button" className="psh-tw" aria-expanded={!collapsed.has(d.id)} aria-label={`${collapsed.has(d.id) ? 'Expand' : 'Collapse'} ${d.label}`} onClick={() => toggle(d.id)}>{collapsed.has(d.id) ? '▸' : '▾'}</button></td>
                    <td className="frz" style={{ left: lefts[0] }} />
                    <td className="frz frzline" style={{ left: lefts[1] }} role="rowheader" aria-level={1}>{d.label} <span className="psh-muted">· {d.count} rows</span></td>
                    <td colSpan={columns.length - 2 + (layout === 'gridTimeline' ? 1 : 0)} />
                  </tr>
                );
                n++;
                const row = d.row; const idx = n;
                const isSel = selected.has(row.id);
                return (
                  <tr key={row.id} role="row" aria-selected={isSel} aria-level={d.level + 1} className={`${row.kind === 'project' ? 'grp' : ''} ${row.kind === 'subtask' ? 'subr' : ''} ${isSel ? 'sel' : ''}`}>
                    <td className="frz sel-cell" style={{ left: 0 }}>
                      {row.kind === 'project'
                        ? <button type="button" className="psh-tw" aria-expanded={!collapsed.has(row.id)} aria-label={`${collapsed.has(row.id) ? 'Expand' : 'Collapse'} ${row.title}`} onClick={() => toggle(row.id)}>{collapsed.has(row.id) ? '▸' : '▾'}</button>
                        : <label className="psh-rowsel"><input type="checkbox" checked={isSel} aria-label={`Select ${row.key} ${row.title}`}
                            onChange={() => undefined} onClick={(e) => toggleSel(row.id, idx, e.shiftKey)} /><span className="psh-check-ui" aria-hidden="true">{isSel ? '✓' : ''}</span><span className="psh-rownum" aria-hidden="true">{idx + 1}</span></label>}
                    </td>
                    {columns.map((c, ci) => {
                      const isActive = idx === r && ci === active.c;
                      const isEditing = editing?.id === row.id && editing.col === c.id;
                      return (
                        <td key={c.id} id={`psh-${row.id}-${c.id}`} role="gridcell" data-active={isActive} aria-readonly={!canEditCell(row, c.id)}
                          className={`${c.frozen ? 'frz' : ''} ${c.id === 'title' ? 'frzline t' : ''} ${c.num ? 'num' : ''} ${isActive ? (isEditing ? 'cell-edit' : 'cell-focus') : ''} ${dueClass(row, c.id)}`}
                          style={c.frozen ? { left: lefts[ci] } : undefined}
                          onMouseDown={() => setActive({ r: idx, c: ci })} onDoubleClick={() => { setActive({ r: idx, c: ci }); if (canEditCell(row, c.id)) setEditing({ id: row.id, col: c.id, draft: null }); }}>
                          <Cell r={row} c={c.id} today={today} level={d.level} childCount={d.childCount} />
                          {isActive && !isEditing && canEditCell(row, c.id) && <span className="psh-fillh" aria-hidden="true" title="Ctrl D fills down" />}
                          {isEditing && <Editor r={row} col={c.id} draft={editing!.draft} data={data} statuses={statusesBy.get(row.projectId) ?? []} today={today} onDone={finish} />}
                        </td>
                      );
                    })}
                    {layout === 'gridTimeline' && <td className="psh-gcell"><MiniBar r={row} g={g} today={today} /></td>}
                  </tr>
                );
              }); })()}
              <tr className="tot" role="row">
                <td className="frz" style={{ left: 0 }} /><td className="frz" style={{ left: lefts[0] }} />
                <td className="frz frzline" style={{ left: lefts[1] }}>{t.rows} rows · {t.projects} project{t.projects === 1 ? '' : 's'}</td>
                {columns.slice(2).map((c) => <td key={c.id} className={c.num ? 'num' : ''}>{totalCell(c.id, t)}</td>)}
                {layout === 'gridTimeline' && <td />}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      {selRows.length > 0 && (
        <div className="psh-bulk" role="toolbar" aria-label="Selected rows">
          <b>{selRows.length} row{selRows.length === 1 ? '' : 's'} selected</b>
          <span className="psh-rel"><button type="button" className="psh-bbtn" aria-expanded={bulk === 'owner'} onClick={() => setBulk(bulk === 'owner' ? null : 'owner')}>Owner</button>
            {bulk === 'owner' && <OwnerList people={data.people} allowNone label="Owner for the selected rows" className="up"
              onPick={(id) => { setBulk(null); void save(selRows.filter((x) => x.canEdit && x.kind !== 'meeting').map((x) => (id ? { id: x.id, assigneeId: id } : { id: x.id, unassign: true })).filter((c) => !(c.unassign && findRow(selRows, c.id)?.kind === 'project'))); }}
              onClose={() => setBulk(null)} />}</span>
          <span className="psh-rel"><button type="button" className="psh-bbtn" aria-expanded={bulk === 'dates'} onClick={() => setBulk(bulk === 'dates' ? null : 'dates')}>Dates…</button>
            {bulk === 'dates' && <DatesPop today={today} onClose={() => setBulk(null)} onApply={(o) => {
              setBulk(null);
              void save(selRows.filter((x) => x.canEdit && x.kind !== 'meeting').map((x) => {
                const c: SheetChange = { id: x.id };
                if (o.shift) { if (x.due) c.dueDate = isoAdd(x.due, o.shift); if (x.start) c.startDate = isoAdd(x.start, o.shift); }
                if (o.start) c.startDate = o.start; if (o.due) c.dueDate = o.due;
                return c;
              }).filter((c) => c.dueDate || c.startDate));
            }} />}</span>
          <span className="psh-rel"><button type="button" className="psh-bbtn" aria-expanded={bulk === 'status'} onClick={() => setBulk(bulk === 'status' ? null : 'status')}>Status</button>
            {bulk === 'status' && (
              <Pop label="Status for the selected rows" onClose={() => setBulk(null)} className="psh-menu up">
                {[['Todo', 'Not started'], ['Active', 'In progress'], ['Done', 'Done']].map(([cat, label]) => (
                  <button key={cat} type="button" role="menuitem" className="mi" onClick={() => {
                    setBulk(null);
                    void save(selRows.filter((x) => x.canEdit && (x.kind === 'task' || x.kind === 'subtask')).map((x) => ({ id: x.id, statusId: (statusesBy.get(x.projectId) ?? []).find((s) => s.category === cat)?.id ?? '' })).filter((c) => c.statusId));
                  }}>{label}</button>
                ))}
              </Pop>
            )}</span>
          <button type="button" className="psh-bbtn" onClick={fillDown}>Fill down ⌃D</button>
          <span className="psh-rel"><button type="button" className="psh-bbtn" onClick={() => setBulk(bulk === 'dates' ? null : 'dates')}>Move</button></span>
          <button type="button" className="psh-bbtn danger" onClick={async () => {
            const ids = selRows.filter((x) => x.kind === 'task' || x.kind === 'subtask').map((x) => x.id);
            if (!ids.length || !(await confirmDialog({ title: `Delete ${ids.length} item${ids.length === 1 ? '' : 's'}?`, message: 'They go to the bin and can be restored from there.', confirmText: 'Delete', danger: true }))) return;
            try { const res = await bulkApi.run({ ids, delete: true }); toast(res.failed.length ? `${res.changed} deleted · ${res.failed.length} could not be` : `${res.changed} deleted.`, res.failed.length ? 'error' : 'success'); setSelected(new Set()); await refresh(); }
            catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete.', 'error'); }
          }}>Delete</button>
          <button type="button" className="psh-bbtn" aria-label="Clear the selection" onClick={() => setSelected(new Set())}>✕</button>
        </div>
      )}
    </>
  );
}
const findRow = (list: SheetRow[], id: string) => list.find((x) => x.id === id);
const isoAdd = (iso: string, n: number) => new Date((dayNum(iso) + n) * 86_400_000).toISOString().slice(0, 10);
const dueClass = (r: SheetRow, c: ColId) => (c === 'due' && r.kind !== 'meeting' ? (r.late ? 'late' : r.atRisk ? 'risk' : '') : '');

function totalCell(c: ColId, t: ReturnType<typeof totals>): ReactNode {
  switch (c) {
    case 'owner': return `${t.owners} owner${t.owners === 1 ? '' : 's'}`;
    case 'start': return dm(t.start);
    case 'due': return dm(t.end);
    case 'dur': return t.spanDays != null ? `${t.spanDays}d` : '';
    case 'status': return <>{t.late > 0 && <span className="psh-chip red">{t.late} late</span>} {t.risk > 0 && <span className="psh-chip orange">{t.risk} risk</span>}</>;
    case 'progress': return t.avg != null ? `${t.avg}% avg` : '';
    case 'meeting': return t.meetings ? `${t.meetings} meeting${t.meetings === 1 ? '' : 's'}` : '';
    default: return '';
  }
}

function Cell({ r, c, today, level, childCount }: { r: SheetRow; c: ColId; today: string; level: number; childCount?: number }) {
  const project = r.kind === 'project';
  switch (c) {
    case 'key': return <span className="psh-key">{r.kind === 'meeting' ? 'MTG' : r.key}</span>;
    case 'title': return (
      <span className="psh-title" style={{ paddingLeft: project ? 0 : Math.max(0, level - 1) * 20 }} title={r.title}>
        {r.kind === 'meeting' && <i className="psh-dia" aria-label="Meeting" />}{project ? <b>{r.title}</b> : r.title}
        {project && childCount != null && <span className="psh-muted"> · {childCount} rows</span>}
      </span>
    );
    case 'owner': return <Who id={r.ownerId} name={r.owner} bold={project} />;
    case 'start': return <>{cellText(r, 'start')}</>;
    case 'due': return r.kind === 'meeting' ? null : <span>{cellText(r, 'due')}{r.late && !project && <span className="psh-vh"> · {lateDays(r, today)} days late</span>}{r.atRisk && !r.late && <span className="psh-vh"> · at risk</span>}</span>;
    case 'dur': return <>{cellText(r, 'dur')}</>;
    case 'status': return <StatusChip r={r} />;
    case 'progress': return r.progress == null || r.kind === 'meeting' ? null : <span className="psh-prog"><span className="bar"><i style={{ width: `${r.progress}%` }} className={r.progress === 100 && !project ? 'done' : ''} /></span>{r.progress}%</span>;
    case 'deps': return <span className="psh-key">{r.kind === 'task' || r.kind === 'subtask' ? r.dependsOn.join(', ') || '—' : ''}</span>;
    case 'meeting': return r.cadence ? <span className="psh-mt"><Cadence c={r.cadence} /> <span>{nextText(r.nextAt)}</span></span> : null;
    case 'updated': return <span className="psh-muted" title={r.updatedBy ? `${r.updatedBy}${r.updatedAt ? ` · ${new Date(r.updatedAt).toLocaleString('en-GB')}` : ''}` : undefined}>{project ? '' : ago(r.updatedAt)}</span>;
    case 'notes': return <span className={`psh-notes ${r.late && !project ? 'late' : project && r.atRisk ? 'risk' : ''}`} title={r.notes ?? undefined}>{r.notes}</span>;
  }
}

function MiniBar({ r, g, today }: { r: SheetRow; g: { x: (iso: string) => number } | null; today: string }) {
  if (!g) return null;
  const tone = r.late ? 'r' : r.atRisk ? 'o' : r.progress === 100 || r.category === 'Done' ? 'g' : '';
  return (
    <div className="psh-gantt" aria-hidden="true">
      {r.kind === 'meeting' ? (r.nextAt && <b className="m" style={{ left: `${g.x(r.nextAt.slice(0, 10))}%` }} />)
        : r.due && <b className={tone} style={{ left: `${g.x(r.start ?? r.due)}%`, width: `max(6px, ${g.x(r.due) - g.x(r.start ?? r.due)}%)` }} />}
      <span className="today" style={{ left: `${g.x(today)}%` }} />
    </div>
  );
}

function HeadMenu({ col, cfg, rows: all, setCfg, onClose }: { col: Col; cfg: SheetConfig; rows: SheetRow[]; setCfg: (c: SheetConfig) => void; onClose: () => void }) {
  const values = useMemo(() => [...new Set(all.filter(isItem).map((r) => cellText(r, col.id)).filter(Boolean))].sort().slice(0, 40), [all, col.id]);
  const chosen = cfg.filters.values[col.id] ?? [];
  const setVals = (v: string[]) => setCfg({ ...cfg, filters: { ...cfg.filters, values: { ...cfg.filters.values, [col.id]: v } } });
  const filterable = ['owner', 'status', 'deps', 'meeting', 'key'].includes(col.id);
  return (
    <Pop label={`${col.label} sort and filter`} onClose={onClose} className="psh-menu psh-headmenu">
      <div className="hd">SORT</div>
      <button type="button" role="menuitem" className={`mi ${cfg.sort?.col === col.id && cfg.sort.dir === 1 ? 'on' : ''}`} onClick={() => { setCfg({ ...cfg, sort: { col: col.id, dir: 1 } }); onClose(); }}>{['start', 'due'].includes(col.id) ? 'Earliest first' : 'A → Z'}</button>
      <button type="button" role="menuitem" className={`mi ${cfg.sort?.col === col.id && cfg.sort.dir === -1 ? 'on' : ''}`} onClick={() => { setCfg({ ...cfg, sort: { col: col.id, dir: -1 } }); onClose(); }}>{['start', 'due'].includes(col.id) ? 'Latest first' : 'Z → A'}</button>
      {cfg.sort?.col === col.id && <button type="button" role="menuitem" className="mi" onClick={() => { setCfg({ ...cfg, sort: null }); onClose(); }}>Clear sort</button>}
      {col.id === 'due' && <><hr /><button type="button" role="menuitemcheckbox" aria-checked={cfg.filters.lateOnly} className="mi" onClick={() => setCfg({ ...cfg, filters: { ...cfg.filters, lateOnly: !cfg.filters.lateOnly } })}>
        <span className={`psh-check ${cfg.filters.lateOnly ? 'on' : ''}`}>{cfg.filters.lateOnly && '✓'}</span>Late only</button></>}
      {filterable && values.length > 0 && <>
        <hr /><div className="hd">SHOW</div>
        <div className="psh-vals">{values.map((v) => {
          const on = chosen.includes(v);
          return <button key={v} type="button" role="menuitemcheckbox" aria-checked={on} className="mi" onClick={() => setVals(on ? chosen.filter((x) => x !== v) : [...chosen, v])}>
            <span className={`psh-check ${on ? 'on' : ''}`}>{on && '✓'}</span>{v}</button>;
        })}</div>
        {chosen.length > 0 && <button type="button" className="mi" onClick={() => setVals([])}>Clear filter</button>}
      </>}
    </Pop>
  );
}

// ---------------------------------------------------------------- editors

function OwnerList({ people, allowNone, label, initial = '', onPick, onClose, onTab, className = '' }: {
  people: { id: string; name: string }[]; allowNone?: boolean; label: string; initial?: string; onPick: (id: string | null) => void; onClose: () => void; onTab?: (id: string | null, back: boolean) => void; className?: string;
}) {
  const [qText, setQ] = useState(initial);
  const [i, setI] = useState(0);
  const list = useMemo(() => {
    const t = qText.trim().toLowerCase();
    if (!t) return people.slice(0, 8);
    // Name starts with it, then a word starts with it, then anywhere in the name.
    const rank = (n: string) => { const l = n.toLowerCase(); return l.startsWith(t) ? 0 : l.split(/\s+/).some((w) => w.startsWith(t)) ? 1 : l.includes(t) ? 2 : 3; };
    return people.map((p) => ({ p, r: rank(p.name) })).filter((x) => x.r < 3).sort((a, b) => a.r - b.r).map((x) => x.p).slice(0, 8);
  }, [people, qText]);
  const pick = (n: number) => (list[n] ? list[n].id : null);
  return (
    <Pop label={label} onClose={onClose} className={`psh-menu psh-owner ${className}`} role="dialog">
      <div className="hd">ASSIGN OWNER · type to search</div>
      <input autoFocus className="psh-search" role="combobox" aria-expanded aria-controls="psh-owner-list" aria-label="Search people" value={qText}
        onChange={(e) => { setQ(e.target.value); setI(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(list.length - 1, x + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
          else if (e.key === 'Enter') { e.preventDefault(); const id = pick(i); if (id) onPick(id); }
          else if (e.key === 'Tab' && onTab) { e.preventDefault(); onTab(pick(i), e.shiftKey); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
        }} />
      <div id="psh-owner-list" role="listbox" aria-label="People">
        {list.map((p, n) => (
          <button key={p.id} type="button" role="option" aria-selected={n === i} className={`mi ${n === i ? 'on' : ''}`} onMouseEnter={() => setI(n)} onClick={() => onPick(p.id)}>
            <Who id={p.id} name={p.name} />{n === i && <small>↵</small>}</button>
        ))}
        {list.length === 0 && <div className="mi note">Nobody matches “{qText}”</div>}
      </div>
      {allowNone && <button type="button" className="mi" onClick={() => onPick(null)}>No owner</button>}
      <hr /><div className="mi note">Tab saves & moves right · Esc cancels</div>
    </Pop>
  );
}

function Editor({ r, col, draft, data, statuses, today, onDone }: {
  r: SheetRow; col: ColId; draft: string | null; data: PlanSheetData; statuses: SheetStatus[]; today: string;
  onDone: (change: SheetChange | null, then: 'down' | 'right' | 'left' | null) => void;
}) {
  const nav = (e: { key: string; shiftKey: boolean }) => (e.key === 'Tab' ? (e.shiftKey ? 'left' : 'right') : 'down') as 'down' | 'right' | 'left';
  if (col === 'owner') {
    const pick = (id: string | null, then: 'down' | 'right' | 'left') => onDone(id === r.ownerId ? null : id ? { id: r.id, assigneeId: id } : r.kind === 'project' ? null : { id: r.id, unassign: true }, then);
    return <OwnerList people={data.people} allowNone={r.kind !== 'project'} label={`Owner of ${r.key}`} initial={draft ?? ''} onPick={(id) => pick(id, 'down')} onTab={(id, back) => pick(id, back ? 'left' : 'right')}
      onClose={() => onDone(null, null)} />;
  }
  if (col === 'status') return <StatusMenu r={r} statuses={statuses} draft={draft} onDone={onDone} />;
  if (col === 'title') return <TitleEditor r={r} draft={draft} onDone={onDone} nav={nav} />;
  return <DateEditor r={r} col={col} draft={draft} today={today} onDone={onDone} nav={nav} />;
}

function TitleEditor({ r, draft, onDone, nav }: { r: SheetRow; draft: string | null; onDone: (c: SheetChange | null, t: 'down' | 'right' | 'left' | null) => void; nav: (e: { key: string; shiftKey: boolean }) => 'down' | 'right' | 'left' }) {
  const [v, setV] = useState(draft ?? r.title);
  return <input autoFocus className="psh-inline" aria-label={`Title of ${r.key}`} value={v} onChange={(e) => setV(e.target.value)} maxLength={300}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); onDone(v.trim() && v.trim() !== r.title ? { id: r.id, title: v.trim() } : null, nav(e)); }
      else if (e.key === 'Escape') { e.preventDefault(); onDone(null, null); }
    }} onBlur={() => onDone(null, null)} />;
}

function StatusMenu({ r, statuses, draft, onDone }: { r: SheetRow; statuses: SheetStatus[]; draft: string | null; onDone: (c: SheetChange | null, t: 'down' | 'right' | 'left' | null) => void }) {
  const list = draft ? statuses.filter((s) => s.name.toLowerCase().startsWith(draft.toLowerCase())).concat(statuses.filter((s) => !s.name.toLowerCase().startsWith(draft.toLowerCase()))) : statuses;
  const [i, setI] = useState(Math.max(0, draft ? 0 : list.findIndex((s) => s.id === r.statusId)));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const pick = (n: number, then: 'down' | 'right' | 'left') => { const s = list[n]; onDone(s && s.id !== r.statusId ? { id: r.id, statusId: s.id } : null, then); };
  return (
    <Pop label={`Status of ${r.key}`} onClose={() => onDone(null, null)} className="psh-menu psh-status" role="listbox">
      <div ref={ref} tabIndex={-1} className="psh-focus-trap" onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(list.length - 1, x + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
        else if (e.key === 'Enter') { e.preventDefault(); pick(i, 'down'); }
        else if (e.key === 'Tab') { e.preventDefault(); pick(i, e.shiftKey ? 'left' : 'right'); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDone(null, null); }
      }}>
        <div className="hd">STATUS</div>
        {list.map((s, n) => <button key={s.id} type="button" role="option" aria-selected={n === i} className={`mi ${n === i ? 'on' : ''}`} onMouseEnter={() => setI(n)} onClick={() => pick(n, 'down')}>
          <span className={`psh-chip ${s.category === 'Done' ? 'green' : s.category === 'Active' ? 'blue' : ''}`}>{s.name}</span>{s.id === r.statusId && <small>current</small>}</button>)}
      </div>
    </Pop>
  );
}

function DateEditor({ r, col, draft, today, onDone, nav }: {
  r: SheetRow; col: ColId; draft: string | null; today: string; onDone: (c: SheetChange | null, t: 'down' | 'right' | 'left' | null) => void; nav: (e: { key: string; shiftKey: boolean }) => 'down' | 'right' | 'left';
}) {
  const due = col === 'due';
  const cur = due ? r.due : r.start;
  const [text, setText] = useState(draft ?? (cur ? `${dm(cur)}${due && r.dueTime ? ` · ${r.dueTime}` : ''}` : ''));
  const [err, setErr] = useState('');
  const parsed = due ? parseDue(text, cur, today) : (() => { const d = parseTypedDate(text, cur, today); return d ? { date: d, time: null } : null; })();
  const commit = (then: 'down' | 'right' | 'left') => {
    if (!text.trim()) { onDone(!due && r.start && r.kind !== 'project' ? { id: r.id, clearStart: true } : null, then); return; }
    if (!parsed) { setErr('Not a date. Try 7 Nov, 7/11, 2026-11-07 or +3'); return; }
    if (due) {
      const time = parsed.time ?? r.dueTime;
      if (parsed.date === r.due && (time ?? null) === (r.dueTime ?? null)) { onDone(null, then); return; }
      onDone({ id: r.id, dueDate: parsed.date, ...(parsed.time && r.kind !== 'project' ? { dueTime: parsed.time } : {}) }, then);
    } else onDone(parsed.date === r.start ? null : { id: r.id, startDate: parsed.date }, then);
  };
  return (
    <Pop label={`${due ? 'Due date' : 'Start date'} of ${r.key}`} onClose={() => onDone(null, null)} className="psh-menu psh-date" role="dialog">
      <div className="hd">{due ? 'DUE · date and time' : 'START'}</div>
      <input autoFocus className="psh-search" aria-label={due ? 'Due date' : 'Start date'} value={text} onChange={(e) => { setText(e.target.value); setErr(''); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); commit(nav(e)); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDone(null, null); }
        }} />
      <div className="psh-date-row">
        <input type="date" aria-label="Pick a date" value={parsed?.date ?? cur ?? ''} onChange={(e) => e.target.value && setText(`${dm(e.target.value)}${due && (parsed?.time ?? r.dueTime) ? ` · ${parsed?.time ?? r.dueTime}` : ''}`)} />
        {due && r.kind !== 'project' && <input type="time" aria-label="Pick a time" value={parsed?.time ?? r.dueTime ?? ''} onChange={(e) => e.target.value && setText(`${dm(parsed?.date ?? cur ?? today)} · ${e.target.value}`)} />}
      </div>
      <div className={`mi note ${err ? 'err' : ''}`}>{err || (parsed ? `${dm(parsed.date)}${parsed.time ? ` · ${parsed.time}` : ''} · Enter saves` : '7 Nov · 18:00, 7/11, +3 or today')}</div>
    </Pop>
  );
}

function DatesPop({ today, onApply, onClose }: { today: string; onApply: (o: { shift?: number; start?: string; due?: string }) => void; onClose: () => void }) {
  const [shift, setShift] = useState('');
  const [start, setStart] = useState('');
  const [due, setDue] = useState('');
  return (
    <Pop label="Dates for the selected rows" onClose={onClose} className="psh-menu psh-dates up" role="dialog">
      <div className="hd">MOVE BY DAYS</div>
      <div className="psh-date-row"><input aria-label="Move by days" placeholder="+3 or -2" value={shift} onChange={(e) => setShift(e.target.value)} /></div>
      <div className="hd">OR SET</div>
      <div className="psh-date-row"><label>Start<input type="date" aria-label="Start for all" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label>Due<input type="date" aria-label="Due for all" value={due} min={start || undefined} onChange={(e) => setDue(e.target.value)} /></label></div>
      <div className="psh-row-end"><button type="button" className="psh-btn sm" onClick={onClose}>Cancel</button>
        <button type="button" className="psh-btn sm pri" disabled={!shift.trim() && !start && !due} onClick={() => {
          const n = parseInt(shift.replace(/\s/g, ''), 10);
          onApply({ shift: Number.isFinite(n) && n !== 0 ? n : undefined, start: start || undefined, due: due || undefined });
        }}>Apply</button></div>
      <div className="mi note">Later due dates ask for one reason · today is {dm(today)}</div>
    </Pop>
  );
}

// ---------------------------------------------------------------- reason for later due dates

export function ReasonModal({ moves, onSave, onClose, title }: { moves: { key: string; from: string; to: string; days: number | null }[]; onSave: (reason: string, dependency: string) => void; onClose: () => void; title?: string }) {
  const [reason, setReason] = useState('');
  const [chip, setChip] = useState<string | null>(null);
  const [dep, setDep] = useState('');
  const full = [chip, reason.trim()].filter(Boolean).join(': ');
  return (
    <Modal title={title ?? (moves.length === 1 ? `Why is ${moves[0].key} moving?` : `Why are ${moves.length} due dates moving?`)} subtitle="Later due dates need a reason, kept with the date history." onClose={onClose} size="sm"
      onSubmit={(e) => { e.preventDefault(); if (full) onSave(full, dep.trim()); }}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={!full}>Save</button></>}>
      <ul className="psh-moves">{moves.slice(0, 6).map((m) => <li key={m.key}><span className="psh-key">{m.key}</span> {dm(m.from)} → <b>{dm(m.to)}</b>{m.days ? <em>+{m.days}d</em> : null}</li>)}
        {moves.length > 6 && <li className="psh-muted">and {moves.length - 6} more</li>}</ul>
      <div className="psh-reasons" role="group" aria-label="Common reasons">{REASONS.map((x) => <button key={x} type="button" aria-pressed={chip === x} className={`psh-chip lg ${chip === x ? 'blue' : ''}`} onClick={() => setChip(chip === x ? null : x)}>{x}</button>)}</div>
      <label className="psh-field">Reason<textarea aria-label="Reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={480} placeholder="What changed?" /></label>
      <label className="psh-field">Waiting on (optional)<input aria-label="Waiting on" value={dep} onChange={(e) => setDep(e.target.value)} maxLength={300} /></label>
    </Modal>
  );
}

// ---------------------------------------------------------------- paste preview

function PasteModal({ grid, data, defaultProject, onClose, onDone }: { grid: string[][]; data: PlanSheetData; defaultProject: string | null; onClose: () => void; onDone: () => void }) {
  const [cells, setCells] = useState<string[][]>(grid);
  const projects = data.rows.filter((r) => r.kind === 'project');
  const [projectId, setProjectId] = useState<string>(defaultProject ?? projects[0]?.id ?? '');
  const auto = useMemo(() => mapColumns(cells), [cells]);
  const [map, setMap] = useState<PasteField[] | null>(null);
  const m = map && map.length === auto.map.length ? map : auto.map;
  const input = useMemo(() => pasteRows(cells, auto.header, m), [cells, auto.header, m]);
  const [res, setRes] = useState<PasteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!projectId || input.length === 0) { setRes(null); return; }
    let live = true;
    setBusy(true);
    portfolioApi.sheetPaste(projectId, input, false).then((x) => { if (!live) return; setRes(x); setTicked(new Set(x.rows.filter((r) => r.ready).map((r) => r.index))); setErr(''); })
      .catch((e) => live && setErr(e instanceof ApiError ? e.message : 'The rows could not be checked.')).finally(() => live && setBusy(false));
    return () => { live = false; };
  }, [projectId, input]);
  const needsReason = !!res?.rows.some((r) => ticked.has(r.index) && r.needsReason);
  const n = res ? res.rows.filter((r) => ticked.has(r.index) && r.ready).length : 0;
  const commit = async () => {
    if (!res) return;
    if (needsReason && !reason.trim()) { setErr('Say why the due dates are moving.'); return; }
    setBusy(true);
    try {
      const out = await portfolioApi.sheetPaste(projectId, input, true, [...ticked], reason.trim() || null);
      const failed = out.rows.filter((r) => ticked.has(r.index) && r.ready && !r.saved);
      toast(failed.length ? `${out.saved} saved · ${failed.length} not saved (${failed[0].error})` : `${out.saved} row${out.saved === 1 ? '' : 's'} added to ${out.projectKey}.`, failed.length ? 'error' : 'success');
      onDone();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'The rows could not be saved.'); } finally { setBusy(false); }
  };
  const project = projects.find((p) => p.id === projectId);
  const ready = res?.ready ?? 0, look = res?.problems ?? 0;
  return (
    <Modal title={cells.length ? `Paste ${input.length} row${input.length === 1 ? '' : 's'} from Excel` : 'Paste from Excel'} size="xl" onClose={onClose} className="psh-paste"
      subtitle={cells.length ? `We matched your columns. Check the preview, then add to ${project?.title ?? 'the project'}.` : 'Copy rows in Excel and paste them here (Ctrl V). The first row may be headers.'}
      footer={<>
        <span className="psh-paste-note">Matching by title updates existing items instead of duplicating. Date changes ask for a reason.</span>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || n === 0} onClick={() => void commit()}>{`Add ${n} row${n === 1 ? '' : 's'}`}</button>
      </>}>
      {cells.length === 0 ? (
        <textarea className="psh-paste-box" aria-label="Paste rows here" autoFocus placeholder="Paste rows copied from Excel here" rows={8}
          onPaste={(e) => { const g = parseTsv(e.clipboardData.getData('text/plain')); if (g.length) { e.preventDefault(); setCells(g); } }}
          onChange={(e) => { const g = parseTsv(e.target.value); if (g.length && /\t|\n/.test(e.target.value)) setCells(g); }} />
      ) : (
        <>
          <div className="psh-paste-top">
            <label className="psh-field inline">Add to<select aria-label="Project to add to" value={projectId} onChange={(e) => setProjectId(e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.title}</option>)}</select></label>
            <span className="psh-sp" />
            {res && <><span className="psh-chip green lg">{ready} ready</span>{look > 0 && <span className="psh-chip orange lg">{look} need{look === 1 ? 's' : ''} a look</span>}</>}
          </div>
          <div className="hd psh-hd">COLUMN MAPPING</div>
          <div className="psh-mapping">
            {m.map((fld, i) => (
              <label key={i} className="psh-chip lg map">{String.fromCharCode(65 + i)} {auto.header ? `“${cells[0][i] ?? ''}”` : ''} →
                <select aria-label={`Column ${String.fromCharCode(65 + i)}`} value={fld} onChange={(e) => { const nm = [...m]; nm[i] = e.target.value as PasteField; setMap(nm); }}>
                  {PASTE_FIELDS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select></label>
            ))}
          </div>
          <div className="psh-paste-table">
            <table className="psh-table auto">
              <thead><tr><th style={{ width: 36 }}><span className="psh-vh">Include</span></th><th>Title</th><th>Owner</th><th>Start</th><th>Due</th><th>Status</th><th>Result</th></tr></thead>
              <tbody>
                {(res?.rows ?? []).map((r) => {
                  const src = input[r.index];
                  const on = ticked.has(r.index);
                  return (
                    <tr key={r.index} className={r.ready ? '' : 'bad'}>
                      <td><input type="checkbox" aria-label={`Include ${r.title || `row ${r.index + 1}`}`} checked={on} disabled={!r.ready}
                        onChange={() => setTicked((s) => { const x = new Set(s); if (x.has(r.index)) x.delete(r.index); else x.add(r.index); return x; })} /></td>
                      <td>{r.title || <span className="psh-muted">(no title)</span>}</td>
                      <td>{r.owner ? <Who id={r.ownerId} name={r.owner} /> : src?.owner ? <span className="risk">“{src.owner}”</span> : ''}</td>
                      <td className={r.start == null && src?.start ? 'late' : ''}>{r.start ? dm(r.start) : src?.start ?? ''}</td>
                      <td className={r.due == null && src?.due ? 'late' : ''}>{r.due ? dm(r.due) : src?.due ?? ''}</td>
                      <td>{r.status ? <span className="psh-chip">{r.status}</span> : src?.status ? <span className="risk">{src.status}</span> : ''}</td>
                      <td className={r.ready ? r.action === 'update' ? 'accent' : 'psh-muted' : 'risk'}>{r.ready ? r.change : r.problems.join(' · ')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {busy && !res && <p className="psh-muted" role="status">Checking the rows…</p>}
          </div>
          {needsReason && <label className="psh-field">Why are due dates moving later?<input aria-label="Reason for the date changes" value={reason} onChange={(e) => { setReason(e.target.value); setErr(''); }} maxLength={480} /></label>}
          {err && <p className="psh-err" role="alert">{err}</p>}
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- phone

function PhoneSheet({ data, rows: all, cfg, setCfg, collapsed, me, today, statusesBy, save }: {
  data: PlanSheetData; rows: SheetRow[]; cfg: SheetConfig; setCfg: (c: SheetConfig) => void; collapsed: Set<string>; me: string | null; today: string;
  statusesBy: Map<string, SheetStatus[]>; save: (c: SheetChange[]) => Promise<void>;
}) {
  const display = useMemo(() => buildDisplay(all, { ...cfg, group: 'project' }, collapsed, me, today), [all, cfg, collapsed, me, today]);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [cadOpen, setCadOpen] = useState(false);
  const [act, setAct] = useState<SheetRow | null>(null);
  const [moveRow, setMoveRow] = useState<SheetRow | null>(null);
  const owners = [...new Set(all.filter(isItem).map((r) => r.owner).filter((x): x is string => !!x))].sort();
  const cads = [...new Set(all.map((r) => r.cadence).filter((x): x is string => !!x))];
  const f = cfg.filters;
  const done = (r: SheetRow) => { const s = (statusesBy.get(r.projectId) ?? []).find((x) => x.category === 'Done'); if (s && s.id !== r.statusId) void save([{ id: r.id, statusId: s.id }]); };
  const groups: { p: SheetRow; items: SheetRow[] }[] = [];
  for (const d of display) if (d.type === 'row') { if (d.row.kind === 'project') groups.push({ p: d.row, items: [] }); else groups[groups.length - 1]?.items.push(d.row); }
  return (
    <div className="psh-phone">
      <div className="psh-phone-chips" role="toolbar" aria-label="Filters">
        <button type="button" className="psh-chip lg blue" onClick={() => setCfg({ ...cfg, group: 'project' })}>Project ▾</button>
        <button type="button" className={`psh-chip lg ${f.notDone ? 'blue' : ''}`} aria-pressed={f.notDone} onClick={() => setCfg({ ...cfg, filters: { ...f, notDone: !f.notDone } })}>Not done</button>
        <span className="psh-rel"><button type="button" className={`psh-chip lg ${f.values.owner?.length ? 'blue' : ''}`} aria-expanded={ownerOpen} onClick={() => setOwnerOpen(!ownerOpen)}>{f.values.owner?.[0] ?? 'Owner'} ▾</button>
          {ownerOpen && <Pop label="Owner" onClose={() => setOwnerOpen(false)} className="psh-menu">
            <button type="button" className="mi" onClick={() => { setCfg({ ...cfg, filters: { ...f, values: { ...f.values, owner: [] } } }); setOwnerOpen(false); }}>Anyone</button>
            {owners.map((o) => <button key={o} type="button" className="mi" onClick={() => { setCfg({ ...cfg, filters: { ...f, values: { ...f.values, owner: [o] } } }); setOwnerOpen(false); }}>{o}</button>)}
          </Pop>}</span>
        {cads.length > 0 && <span className="psh-rel"><button type="button" className={`psh-chip lg ${f.values.meeting?.length ? 'blue' : ''}`} aria-expanded={cadOpen} onClick={() => setCadOpen(!cadOpen)}>{f.values.meeting?.[0] ?? 'Cadence'} ▾</button>
          {cadOpen && <Pop label="Cadence" onClose={() => setCadOpen(false)} className="psh-menu">
            <button type="button" className="mi" onClick={() => { setCfg({ ...cfg, filters: { ...f, values: { ...f.values, meeting: [] } } }); setCadOpen(false); }}>Any</button>
            {cads.map((o) => <button key={o} type="button" className="mi" onClick={() => { setCfg({ ...cfg, filters: { ...f, values: { ...f.values, meeting: [o] } } }); setCadOpen(false); }}>{o}</button>)}
          </Pop>}</span>}
      </div>
      {groups.length === 0 && <p className="psh-muted psh-empty">Nothing matches.</p>}
      {groups.map(({ p, items }) => (
        <section key={p.id} aria-label={p.title}>
          <h3 className="psh-phone-h">{p.title.toUpperCase()} · {(p.kind === 'project' && p.progress === 100 ? 'DONE' : p.status).toUpperCase()}</h3>
          {items.map((r) => r.kind === 'meeting' ? (
            <div key={r.id} className="psh-card mt">
              <div className="psh-row"><i className="psh-dia" aria-hidden="true" /><b>{r.title}</b><span className="psh-sp" />{r.cadence && <Cadence c={r.cadence} />}</div>
              <div className="psh-card-sub">Next: {nextText(r.nextAt)}</div>
            </div>
          ) : <SwipeCard key={r.id} r={r} today={today} onDone={() => done(r)} onMenu={() => setAct(r)} />)}
        </section>
      ))}
      <p className="psh-phone-hint">Swipe right: Done · left: Move date / Owner</p>
      {act && (
        <Modal title={`${act.key} · ${act.title}`} onClose={() => setAct(null)} size="sm">
          <div className="psh-actions">
            <button type="button" className="btn" onClick={() => { const r = act; setAct(null); done(r); }}><Icon name="check" size={15} />Mark done</button>
            <button type="button" className="btn" onClick={() => { const r = act; setAct(null); setMoveRow(r); }}><Icon name="calendar" size={15} />Move date</button>
          </div>
          <OwnerInline people={data.people} onPick={(id) => { const r = act; setAct(null); if (id && id !== r.ownerId) void save([{ id: r.id, assigneeId: id }]); }} />
        </Modal>
      )}
      {moveRow && (
        <Modal title={`Move ${moveRow.key}`} onClose={() => setMoveRow(null)} size="sm">
          <div className="psh-actions">
            {[1, 3, 7].map((n) => <button key={n} type="button" className="btn" onClick={() => { const r = moveRow; setMoveRow(null); if (r.due) void save([{ id: r.id, dueDate: isoAdd(r.due, n) }]); }}>+{n} day{n === 1 ? '' : 's'}</button>)}
          </div>
          <label className="psh-field">New due date<input type="date" aria-label="New due date" defaultValue={moveRow.due ?? ''} onChange={(e) => { const r = moveRow; if (e.target.value) { setMoveRow(null); void save([{ id: r.id, dueDate: e.target.value }]); } }} /></label>
        </Modal>
      )}
    </div>
  );
}

function OwnerInline({ people, onPick }: { people: { id: string; name: string }[]; onPick: (id: string | null) => void }) {
  const [t, setT] = useState('');
  const list = people.filter((p) => p.name.toLowerCase().includes(t.trim().toLowerCase())).slice(0, 6);
  return (
    <div className="psh-owner-inline">
      <input aria-label="Change owner" placeholder="Change owner…" value={t} onChange={(e) => setT(e.target.value)} />
      {t && list.map((p) => <button key={p.id} type="button" className="psh-owner-opt" onClick={() => onPick(p.id)}><Who id={p.id} name={p.name} /></button>)}
    </div>
  );
}

function SwipeCard({ r, today, onDone, onMenu }: { r: SheetRow; today: string; onDone: () => void; onMenu: () => void }) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const press = useRef<number | null>(null);
  const late = r.late ? lateDays(r, today) : 0;
  const end = () => {
    if (press.current) { clearTimeout(press.current); press.current = null; }
    if (dx > 90) { setDx(0); onDone(); } else if (dx < -90) { setDx(0); onMenu(); } else setDx(0);
    start.current = null;
  };
  return (
    <div className="psh-swipe">
      {dx !== 0 && <div className={`psh-under ${dx < 0 ? 'left' : ''}`} aria-hidden="true">{dx >= 0 ? <span>✓ Done</span> : <span>Move date / Owner</span>}</div>}
      <div className="psh-card" style={{ transform: dx ? `translateX(${dx}px)` : undefined }} role="group" aria-label={`${r.key} ${r.title}`}
        onTouchStart={(e) => { const t = e.touches[0]; start.current = { x: t.clientX, y: t.clientY }; press.current = window.setTimeout(() => { press.current = null; onMenu(); }, 550); }}
        onTouchMove={(e) => { const s = start.current; if (!s) return; const t = e.touches[0]; const x = t.clientX - s.x; if (Math.abs(x) > 8 && press.current) { clearTimeout(press.current); press.current = null; } if (Math.abs(x) > Math.abs(t.clientY - s.y)) setDx(Math.max(-140, Math.min(140, x))); }}
        onTouchEnd={end} onContextMenu={(e) => { e.preventDefault(); onMenu(); }}>
        <div className="psh-row"><span className="psh-key">{r.key}</span><StatusChip r={r} /><span className="psh-sp" />{r.owner && <span className="psh-av" style={{ '--h': hue(r.ownerId) } as CSSProperties} title={r.owner}>{initials(r.owner)}</span>}
          <button type="button" className="psh-more" aria-label={`Actions for ${r.key}`} onClick={onMenu}><Icon name="more" size={16} /></button></div>
        <div className="psh-card-t">{r.title}</div>
        <div className={`psh-card-sub ${r.late ? 'late' : r.atRisk ? 'risk' : ''}`}>
          {r.start ? `${dm(r.start)} → ` : ''}{r.due ? <span className={r.late ? 'late' : ''}>{dm(r.due)}{r.dueTime ? `, ${r.dueTime}` : ''}{late ? ` · ${late}d late` : ''}</span> : 'No due date'}
        </div>
        {r.progress != null && <div className="psh-pbar"><i style={{ width: `${r.progress}%` }} /></div>}
      </div>
    </div>
  );
}
