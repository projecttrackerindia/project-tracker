import { Fragment, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { ErrorState } from '../../components/ui';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { DateEditor, StatusPicker } from './planSheetEditors';
import { ReasonModal } from './planSheetReason';
import { COLOURS, type Colour } from './planSheetTabs';
import { portfolioApi, type SheetChange, type SheetRow, type SheetStatus } from './portfolioApi';
import { PortfolioSkeleton, usePortfolio, useShellLine, useShellMenu } from './PortfolioShell';
import { patchPortfolio, refreshPortfolio } from './portfolioShared';
import { dayNum } from './planSheet';

/**
 * Portfolio › Plan sheet, the approved calm design (demo shot 13, the user's own screenshot): pastel folder tabs, one per project (dot and short name)
 * with All last and the colour filter on the right; one white page that the active tab joins; the project's tasks grouped by phase (bold header,
 * tasks under it on curved hairline connectors); exactly Task · Owner · Start · Due · Status, plain names and dates (an overdue due in red) and a
 * soft status pill; the hint "Click any date to edit · changes save instantly". A date opens the rounded calendar with the slip and ripple preview
 * and saves at once with "✓ Saved". Everything else the sheet does (search and tokens, saved views, split and timeline layouts, bulk, paste, fill,
 * history and undo, notify, export, the inspector) is the full sheet, one click away under ⋯ › "Open the full sheet".
 */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const md = (iso: string | null) => (iso ? `${MON[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}` : '—');
const short = (t: string) => t.split(/\s+/)[0] ?? t;
const done = (r: SheetRow) => r.category === 'Done' || r.category === 'Cancelled';
const blocked = (r: SheetRow) => !done(r) && /block/i.test(r.status);
const pill = (r: SheetRow): [string, string] => done(r) ? ['Done', 'green'] : blocked(r) ? ['Blocked', 'red'] : r.category === 'Todo' ? ['To do', 'grey'] : ['In progress', 'blue'];
const late = (r: SheetRow, today: string) => !done(r) && !!r.due && dayNum(r.due) < dayNum(today);

interface Phase { id: string; title: string | null; rows: SheetRow[] }
/** A project's phases: each top-level task with sub-items is a phase (its header), its sub-items the rows; lone top-level tasks share one group. */
function phasesOf(projectId: string, work: SheetRow[]): Phase[] {
  const mine = work.filter((r) => r.projectId === projectId && r.kind !== 'meeting');
  const kids = new Map<string, SheetRow[]>();
  for (const r of mine) if (r.parentId && r.parentId !== projectId && r.level > 0) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r]);
  const out: Phase[] = []; let loose: Phase | null = null;
  for (const r of mine) {
    if (r.level > 0 && r.parentId && kids.has(r.parentId) && mine.some((x) => x.id === r.parentId)) continue;
    const ch = kids.get(r.id);
    if (ch?.length) out.push({ id: r.id, title: r.title, rows: ch });
    else { if (!loose) { loose = { id: `loose-${projectId}`, title: null, rows: [] }; out.push(loose); } loose.rows.push(r); }
  }
  return out;
}

export function CalmPlanSheet() {
  const { sheet, projects, work, url, colourOf, today, tabPrefs, phone } = usePortfolio();
  const wid = useWorkspaceId();
  const nav = useNavigate();
  const [, setParams] = useSearchParams();
  const [edit, setEdit] = useState<{ id: string; col: 'due' | 'status'; anchor: HTMLElement } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ changes: SheetChange[]; label: string; moves: { key: string; from: string; to: string; days: number | null }[] } | null>(null);
  const colours = url.colours;
  const shown = useMemo(() => projects.filter((p) => !colours.length || colours.includes(colourOf(p.id))), [projects, colours, colourOf]);
  const tab = url.tab === 'all' ? 'all' : shown.find((p) => p.id === url.tab)?.id ?? shown[0]?.id ?? 'all';
  const name = (id: string) => tabPrefs.names[id] || projects.find((p) => p.id === id)?.title || '';
  const statusesBy = useMemo(() => { const m = new Map<string, SheetStatus[]>(); for (const s of sheet.data?.statuses ?? []) m.set(s.projectId, [...(m.get(s.projectId) ?? []), s]); return m; }, [sheet.data]);
  // Phase rows are headers, not tasks: the counts are the tasks under them (and lone tasks).
  const parents = useMemo(() => new Set(work.map((r) => r.parentId).filter(Boolean)), [work]);
  const scope = (tab === 'all' ? work : work.filter((r) => r.projectId === tab)).filter((r) => !parents.has(r.id) && r.kind !== 'meeting');
  const open = scope.filter((r) => !done(r)).length, nBlocked = scope.filter(blocked).length + scope.filter((r) => !blocked(r) && late(r, today)).length;
  useShellLine(projects.length ? `${tab === 'all' ? 'All projects' : short(name(tab))} · ${open} open, ${nBlocked} blocked.` : null);
  const full = () => setParams((cur) => { const n = new URLSearchParams(cur); n.set('classic', '1'); return n; });
  useShellMenu([
    { label: 'Open the full sheet', icon: 'list', hint: 'Search, views, split and timeline, bulk, paste, fill, history, notify, export', onSelect: full },
  ]);

  const save = async (changes: SheetChange[], label: string, reason?: { reason: string; dependency: string }) => {
    const rows = work;
    if (!reason) {
      const moves = changes.flatMap((c) => { const r = rows.find((x) => x.id === c.id); return r?.due && c.dueDate && dayNum(c.dueDate) > dayNum(r.due) ? [{ key: r.key, from: r.due, to: c.dueDate, days: dayNum(c.dueDate) - dayNum(r.due) }] : []; });
      if (moves.length) { setAsk({ changes, label, moves }); return; }
    }
    const st = (id?: string) => (sheet.data?.statuses ?? []).find((s) => s.id === id);
    patchPortfolio(wid, changes, (_r, c) => ({ ...(c.dueDate ? { due: c.dueDate } : {}), ...(c.startDate ? { start: c.startDate } : {}), ...(c.statusId && st(c.statusId) ? { statusId: c.statusId, status: st(c.statusId)!.name, category: st(c.statusId)!.category } : {}) }));
    try {
      const withV = changes.map((c) => ({ ...c, version: c.version ?? rows.find((r) => r.id === c.id)?.version }));
      const res = await portfolioApi.sheetBulk(withV, reason?.reason, reason?.dependency);
      const bad = res.rows.find((x) => !x.ok);
      if (bad) toast(`${bad.key ?? 'A row'}: ${bad.error ?? 'not saved'}`, 'error');
      else { setSaved(changes[0]!.id); window.setTimeout(() => setSaved((x) => (x === changes[0]!.id ? null : x)), 1800); }
    } catch (e) { toast(e instanceof ApiError ? e.message : 'The change could not be saved.', 'error'); }
    finally { void refreshPortfolio(wid); }
  };
  const editRow = edit ? work.find((r) => r.id === edit.id) : undefined;

  if (sheet.isLoading) return <PortfolioSkeleton label="Loading the plan sheet" />;
  if (sheet.isError) return <ErrorState error={sheet.error} retry={() => void sheet.refetch()} />;
  const row = (r: SheetRow, nested: boolean, last: boolean) => {
    const [pl, tone] = pill(r);
    return (
      <tr key={r.id} className="cps-r">
        <td className={`cps-tn ${nested ? 'nest' : ''} ${last ? 'last' : ''}`}>
          {nested && <i className="cps-curve" aria-hidden="true" />}
          <button type="button" className="cps-t" title={r.title} onClick={() => nav(`/work/projects/${r.projectId}?tab=work&task=${r.id}`)}>{r.title}</button>
        </td>
        <td className="cps-dim">{r.owner ? short(r.owner) : '—'}</td>
        <td className="cps-dim">{md(r.start)}</td>
        <td>
          <button type="button" className={`cps-dc ${late(r, today) || blocked(r) ? 'late' : ''}`} disabled={!r.canEdit} aria-label={`Due date of ${r.title}: ${md(r.due)}`}
            onClick={(e) => setEdit({ id: r.id, col: 'due', anchor: e.currentTarget })}>{md(r.due)}</button>
          {saved === r.id && <span className="ps3-saved" role="status">✓ Saved</span>}
        </td>
        <td><button type="button" className={`cps-pill ${tone}`} disabled={!r.canEdit} aria-label={`Status of ${r.title}: ${pl}`} onClick={(e) => setEdit({ id: r.id, col: 'status', anchor: e.currentTarget })}>{pl}</button></td>
      </tr>
    );
  };
  const projectBody = (pid: string, withHead: boolean) => (
    <tbody key={pid}>
      {withHead && <tr className="cps-proj"><td colSpan={5}><i className={`cps-pd pc-${colourOf(pid)}`} />{name(pid)}</td></tr>}
      {phasesOf(pid, work).map((ph) => <Fragment key={ph.id}>
        {ph.title && <tr key={`h${ph.id}`} className="cps-ph"><td colSpan={5}>{ph.title}</td></tr>}
        {ph.rows.map((r, i) => row(r, !!ph.title, i === ph.rows.length - 1))}
      </Fragment>)}
      {!work.some((r) => r.projectId === pid) && <tr><td colSpan={5} className="cps-empty">No tasks yet.</td></tr>}
    </tbody>
  );
  return (
    <div className="cps">
      <div className="cps-top">
        <div className="cps-tabs" role="tablist" aria-label="Plan sheet projects">
          {shown.map((p) => (
            <button key={p.id} type="button" role="tab" aria-selected={tab === p.id} className={`cps-ft pc-${colourOf(p.id)} ${tab === p.id ? 'on' : ''}`} onClick={() => url.setTab(p.id)} title={name(p.id)}>
              <b aria-hidden="true" />{short(name(p.id))}
            </button>
          ))}
          <button type="button" role="tab" aria-selected={tab === 'all'} className={`cps-ft all ${tab === 'all' ? 'on' : ''}`} onClick={() => url.setTab('all')}>All</button>
        </div>
        {!phone && <span className="ps3-sp" />}
        <div className="cps-sw" role="group" aria-label="Filter projects by colour">
          <span>Filter</span>
          {COLOURS.map((c: Colour) => <button key={c} type="button" className={`pc-${c} ${colours.includes(c) ? 'on' : ''}`} aria-pressed={colours.includes(c)} aria-label={c[0]!.toUpperCase() + c.slice(1)}
            onClick={() => url.setColours(colours.includes(c) ? colours.filter((x) => x !== c) : [...colours, c])} />)}
        </div>
      </div>
      <div className={`cps-page ${tab === shown[0]?.id ? 'first' : ''}`}>
        <div className="cps-scroll">
          <table className="cps-t-table" aria-label="Plan sheet">
            <thead><tr><th style={{ width: '44%' }}>Task</th><th>Owner</th><th>Start</th><th>Due</th><th>Status</th></tr></thead>
            {tab === 'all' ? shown.map((p) => projectBody(p.id, true)) : projectBody(tab, false)}
          </table>
        </div>
        <div className="cps-hint">Click any date to edit · changes save instantly</div>
      </div>
      {edit && editRow && edit.col === 'due' && <DateEditor r={editRow} rows={work} today={today} anchor={edit.anchor} onClose={() => setEdit(null)} onSave={(c, label) => { setEdit(null); void save(c, label); }} />}
      {edit && editRow && edit.col === 'status' && <StatusPicker r={editRow} statuses={statusesBy.get(editRow.projectId) ?? []} anchor={edit.anchor} onClose={() => setEdit(null)}
        onPick={(id) => { setEdit(null); if (id !== editRow.statusId) void save([{ id: editRow.id, statusId: id }], 'Status'); }} />}
      {ask && <ReasonModal moves={ask.moves} onClose={() => setAsk(null)} onSave={(reason, dependency) => { const a = ask; setAsk(null); void save(a.changes, a.label, { reason, dependency }); }} />}
    </div>
  );
}
