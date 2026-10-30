import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { ApiError } from '../../api/client';
import { taskApi } from '../../api/endpoints';
import { toast } from '../../stores/ui';
import type { PlanSheet as PlanSheetData, SheetChange, SheetRow, SheetStatus } from './portfolioApi';
import { dayNum, dm, isOpen } from './planSheet';
import { estimateLoad, slipDays, statusKey, weekLabel, weekStart, type Load } from './planSheetQuery';
import { NoteText, Owner, Progress, Status } from './planSheetParts';
import { DateEditor, NotesEditor, PeoplePicker, ProgressEditor, StatusPicker } from './planSheetEditors';
import { Inspector, type EditCol, type LinkedMeeting } from './planSheetInspector';
import { CalendarDate } from './planSheetCalendar';
import type { Colour } from './planSheetTabs';

type Node = { kind: 'phase'; id: string; name: string; kids: Node[]; rows: SheetRow[] } | { kind: 'row'; id: string; r: SheetRow; kids: Node[] };
interface Flat { n: Node; depth: number; guides: ('v' | 'e' | 'l' | 'n')[]; last: boolean }

/** Phase › Task › Subtask: the project's stages first (when its tasks have them), then each task with its sub-items, at any depth. */
export function buildTree(project: SheetRow, work: SheetRow[]): Node[] {
  const mine = work.filter((r) => r.projectId === project.id);
  const ids = new Set(mine.map((r) => r.id));
  const kids = new Map<string, SheetRow[]>();
  for (const r of mine) if (r.parentId && ids.has(r.parentId)) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r]);
  const node = (r: SheetRow): Node => ({ kind: 'row', id: r.id, r, kids: (kids.get(r.id) ?? []).map(node) });
  const roots = mine.filter((r) => !r.parentId || !ids.has(r.parentId));
  if (!roots.some((r) => r.stageId)) return roots.map(node);
  const phases = new Map<string, { name: string; rows: SheetRow[] }>();
  for (const r of roots) {
    const k = r.stageId ?? 'none';
    if (!phases.has(k)) phases.set(k, { name: r.stage ?? 'No phase', rows: [] });
    phases.get(k)!.rows.push(r);
  }
  return [...phases.entries()].map(([id, p]) => ({ kind: 'phase', id: `phase:${id}`, name: p.name, rows: p.rows, kids: p.rows.map(node) }));
}
const all = (n: Node): SheetRow[] => n.kind === 'row' ? [n.r, ...n.kids.flatMap(all)] : n.kids.flatMap(all);
/** A branch's roll-up: progress weighted equally over its leaves, the span of its dates, and late/at-risk counts. */
export function rollup(rows: SheetRow[]) {
  const leaves = rows.length;
  const pct = leaves ? Math.round(rows.reduce((a, r) => a + (statusKey(r) === 'done' ? 100 : r.progress ?? 0), 0) / leaves) : 0;
  const starts = rows.map((r) => r.start ?? r.due).filter((x): x is string => !!x).sort();
  const dues = rows.map((r) => r.due).filter((x): x is string => !!x).sort();
  return { pct, start: starts[0] ?? null, due: dues[dues.length - 1] ?? null, late: rows.filter((r) => isOpen(r) && r.late).length, risk: rows.filter((r) => isOpen(r) && !r.late && r.atRisk).length };
}

/**
 * A project's focus view (design plansheet5–6): breadcrumb and ‹ / Esc back, a hero strip with its progress ring and a mini timeline, then the tree
 * Phase › Task › Subtask with curved connector lines (the chosen branch drawn in the project colour), roll-ups on phases and parents, and "+ Add
 * subtask" inline. A row opens the inspector, which shows where it sits.
 */
export function FocusView({ project, data, rows, work, today, colour, name, statusesBy, meeting, save, refresh, onBack, onWarn, calendar, command }: {
  project: SheetRow; data: PlanSheetData; rows: SheetRow[]; work: SheetRow[]; today: string; colour: Colour; name: string; statusesBy: Map<string, SheetStatus[]>;
  meeting: LinkedMeeting | null; save: (c: SheetChange[], label: string) => Promise<void>; refresh: () => Promise<unknown>; onBack: () => void; onWarn: (t: string | null) => void;
  calendar: { feed: boolean; syncedAt: string | null }; command: ReactNode;
}) {
  const tree = useMemo(() => buildTree(project, work), [project, work]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ id: string; col: EditCol; anchor: HTMLElement | null } | null>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement)?.closest?.('input, textarea, [role="dialog"]')) return;
      if (edit) return;
      if (sel) setSel(null); else onBack();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [sel, edit, onBack]);

  // The path to the chosen row: its phase and its parents, so their lines and chevrons are drawn in the project colour.
  const path = useMemo(() => {
    const out: string[] = [];
    const walk = (ns: Node[], trail: string[]): boolean => { for (const n of ns) { const t = [...trail, n.id]; if (n.id === sel) { out.push(...t); return true; } if (walk(n.kids, t)) return true; } return false; };
    if (sel) walk(tree, []);
    return out;
  }, [tree, sel]);
  const flat: Flat[] = useMemo(() => {
    const out: Flat[] = [];
    const walk = (ns: Node[], depth: number, guides: Flat['guides']) => ns.forEach((n, i) => {
      const last = i === ns.length - 1;
      out.push({ n, depth, guides: depth === 0 ? [] : [...guides, last ? 'l' : 'e'], last });
      if (!collapsed.has(n.id)) walk(n.kids, depth + 1, depth === 0 ? [] : [...guides, last ? 'n' : 'v']);
    });
    walk(tree, 0, []);
    return out;
  }, [tree, collapsed]);

  const sum = rollup(work.filter((r) => r.projectId === project.id));
  const pct = project.progress ?? sum.pct;
  const inspected = sel ? rows.find((r) => r.id === sel) ?? null : null;
  const crumbs = inspected ? path.map((id) => id.startsWith('phase:') ? (tree.find((p) => p.id === id) as { name: string } | undefined)?.name ?? '' : rows.find((r) => r.id === id)?.key ?? '').filter(Boolean) : [];
  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const editRow = edit ? rows.find((r) => r.id === edit.id) ?? null : null;
  const mon = weekStart(editRow?.due ?? today);
  const loadFor = (id: string): Load => { const e = estimateLoad(work, id, mon); return { id, name: data.people.find((p) => p.id === id)?.name ?? '', minutes: e.minutes, capacity: e.capacity, pct: Math.round((e.minutes * 100) / e.capacity), source: 'estimate' }; };
  const done = (c: SheetChange[] | null, label: string) => { setEdit(null); if (c?.length) void save(c, label); };
  const addSub = async (parent: SheetRow, title: string) => {
    try { await taskApi.create(project.id, { title, priority: 'Medium', parentTaskId: parent.id }); setAdding(null); await refresh(); toast(`Added a subtask to ${parent.key}.`); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'The subtask could not be added.', 'error'); }
  };

  // Mini timeline: the project's span, the phases (or top tasks) as coloured segments, and today in red.
  const span = useMemo(() => {
    const ds = [project.start, project.due, ...work.filter((r) => r.projectId === project.id).flatMap((r) => [r.start, r.due])].filter((x): x is string => !!x).map(dayNum);
    if (!ds.length) return null;
    const a = Math.min(...ds), b = Math.max(...ds, a + 1);
    return { a, b, x: (iso: string) => Math.max(0, Math.min(100, ((dayNum(iso) - a) / (b - a)) * 100)) };
  }, [project, work]);
  const segs = tree.slice(0, 8).map((n) => ({ id: n.id, ...rollup(all(n)) }));

  return (
    <div className={`ps4-focus pc-${colour}`}>
      <div className="ps4-crumbs"><button type="button" className="back" aria-label="Back to all projects (Esc)" onClick={onBack}>‹</button>
        <span>Plan</span><span aria-hidden="true">›</span><b>{name}</b>{inspected && crumbs.slice(0, -1).map((c) => <span key={c} className="ps3-dim">› {c}</span>)}</div>
      <div className="ps4-hero">
        <span className="bigring" style={{ background: `conic-gradient(var(--pc) 0 ${pct}%, var(--p-fill) 0)` } as CSSProperties} aria-label={`${pct}% done`}><span>{pct}%</span></span>
        <div className="ttl"><b>{name}</b><span className="ps3-dim">{project.key} · {project.owner ?? 'No lead'} · {work.filter((r) => r.projectId === project.id).length} items</span></div>
        <div className="hdates"><div className="hk">Dates</div><div className="hv">{project.start ? `${dm(project.start)} → ` : ''}{dm(project.due) || 'No end date'}</div></div>
        {span && <div className="mtl" aria-hidden="true"><span className="tr" />
          {segs.map((s) => s.start && s.due ? <span key={s.id} className={`tseg ${s.late ? 'late' : s.risk ? 'risk' : ''}`} style={{ left: `${span.x(s.start)}%`, width: `max(4px, ${span.x(s.due) - span.x(s.start)}%)` }} /> : null)}
          <span className="now" style={{ left: `${span.x(today)}%` }} />
          <span className="lb" style={{ left: 0 }}>{dm(new Date(span.a * 86_400_000).toISOString().slice(0, 10))}</span>
          <span className="lb" style={{ right: 0 }}>{dm(new Date(span.b * 86_400_000).toISOString().slice(0, 10))}</span></div>}
        <div className="hcal"><div className="hk">On calendar</div><div className="hv">{work.filter((r) => r.projectId === project.id && r.due).length} dates{meeting ? ' · 1 meeting' : ''}</div></div>
      </div>
      <div className="ps3-cmdrow">{command}</div>
      <div className="ps4-tbody">
        <div className={`ps4-tree ${inspected ? 'narrow' : ''}`} role="treegrid" aria-label={`${name} tree`}>
          <div className="colh" role="row"><span>Task</span><span>Owner</span><span>Dates</span><span>Status</span><span>Progress</span><span>Notes</span></div>
          <div className="ps4-tcard">
            {flat.length === 0 && <p className="ps3-empty">No tasks in this project yet.</p>}
            {flat.map(({ n, depth, guides }) => {
              const onPath = path.includes(n.id), open = !collapsed.has(n.id);
              // The chosen branch: each elbow on its path is drawn in the project colour.
              const lines = guides.map((g, i) => <span key={i} className={`guide ${g} ${onPath && i === guides.length - 1 ? 'hf' : ''}`} aria-hidden="true" />);
              const chev = n.kids.length > 0 ? <button type="button" className={`tchev ${onPath ? 'hl' : ''}`} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${n.kind === 'phase' ? n.name : n.r.key}`} onClick={(e) => { e.stopPropagation(); toggle(n.id); }}>{open ? '▾' : '▸'}</button> : <span className="tchev" />;
              if (n.kind === 'phase') {
                const ru = rollup(all(n));
                return (
                  <div key={n.id} className="trow ph" role="row" aria-level={depth + 1}>
                    <div className="tw">{chev}<b>{n.name}</b><span className="cnt">{n.rows.length}</span></div>
                    <span /><span className="ps3-num ps3-dim">{ru.start ? `${dm(ru.start)} → ` : ''}{dm(ru.due)}</span>
                    <span className="ps3-dim" style={{ color: ru.late ? 'var(--p-red)' : ru.risk ? 'var(--p-orange)' : undefined }}>{ru.late ? `${ru.late} late` : ru.risk ? `${ru.risk} at risk` : ''}</span>
                    <Progress value={ru.pct} k={ru.late ? 'late' : ru.risk ? 'risk' : ru.pct >= 100 ? 'done' : 'prog'} />
                    <span className="ps3-dim">Rolled up from {n.rows.length}</span>
                  </div>
                );
              }
              const r = n.r, k = statusKey(r), s = slipDays(r, today);
              const ru = n.kids.length ? rollup(all(n).slice(1)) : null;
              return (
                <div key={n.id}>
                  <div className={`trow ${sel === r.id ? 'sel' : ''}`} role="row" aria-level={depth + 1} aria-selected={sel === r.id} data-row={r.id} tabIndex={0}
                    onClick={() => setSel(sel === r.id ? null : r.id)} onKeyDown={(e) => { if (e.key === 'Enter') setSel(r.id); }}>
                    <div className="tw">{lines}{chev}<span className="ps3-key">{r.key}</span><b title={r.title}>{r.title}</b></div>
                    <span onClick={(e) => { if (!r.canEdit) return; e.stopPropagation(); setEdit({ id: r.id, col: 'owner', anchor: e.currentTarget }); }}><Owner id={r.ownerId} name={r.owner} /></span>
                    <span className="ps3-num" onClick={(e) => { if (!r.canEdit) return; e.stopPropagation(); setEdit({ id: r.id, col: 'dates', anchor: e.currentTarget }); }}>
                      {r.start && <span className="ps3-dim">{dm(r.start)} → </span>}
                      {r.due ? <CalendarDate r={r} calendar={calendar} late={k === 'late'} /> : <span className="ps3-dim">No date</span>}
                      {s > 0 && <span className={`ps3-slip ${k === 'late' ? 'late' : 'risk'}`}>+{s}d</span>}</span>
                    <span onClick={(e) => { if (!r.canEdit) return; e.stopPropagation(); setEdit({ id: r.id, col: 'status', anchor: e.currentTarget }); }}><Status r={r} /></span>
                    <span onClick={(e) => { if (!r.canEdit || ru) return; e.stopPropagation(); setEdit({ id: r.id, col: 'progress', anchor: e.currentTarget }); }}><Progress value={ru ? ru.pct : r.progress} k={k} /></span>
                    <span className="ps3-note">{ru ? <span className="ps3-dim">Rolled up from {n.kids.length}</span> : r.notes ? <NoteText text={r.notes} /> : <span className="ph">Add a note…</span>}</span>
                  </div>
                  {sel === r.id && r.canEdit && (adding === r.id
                    ? <div className="trow add" role="row"><div className="tw">{guides.map((_, i) => <span key={i} className="guide n" aria-hidden="true" />)}<span className="guide l" aria-hidden="true" /><AddInput onDone={(t) => { if (t) void addSub(r, t); else setAdding(null); }} /></div></div>
                    : <div className="trow add" role="row"><div className="tw">{guides.map((_, i) => <span key={i} className="guide n" aria-hidden="true" />)}<span className="guide l" aria-hidden="true" />
                      <button type="button" className="ps3-link" onClick={(e) => { e.stopPropagation(); setAdding(r.id); }}>＋ Add subtask</button></div></div>)}
                </div>
              );
            })}
          </div>
        </div>
        {inspected && <div className="ps4-inspwrap"><div className="ps4-path" aria-label="Where it sits">{[name, ...crumbs.slice(0, -1)].join(' › ')}</div>
          <Inspector h={9999} r={inspected} rows={rows} project={project} today={today} meeting={meeting} onClose={() => setSel(null)} onChanged={() => void refresh()}
            onEdit={(col, anchor) => setEdit({ id: inspected.id, col, anchor })} /></div>}
      </div>

      {edit && editRow && edit.col === 'dates' && <DateEditor r={editRow} rows={rows} today={today} anchor={edit.anchor} onClose={() => setEdit(null)} onSave={(c, label) => done(c, label)} />}
      {edit && editRow && edit.col === 'owner' && <PeoplePicker r={editRow} people={data.people} loadFor={loadFor} week={weekLabel(mon)} mon={mon} anchor={edit.anchor} onWarn={onWarn}
        onClose={() => setEdit(null)} onPick={(id) => done(id === editRow.ownerId ? null : [id ? { id: editRow.id, assigneeId: id } : { id: editRow.id, unassign: true }], `Gave ${editRow.key} to ${data.people.find((p) => p.id === id)?.name ?? 'nobody'}`)} />}
      {edit && editRow && edit.col === 'status' && <StatusPicker r={editRow} statuses={statusesBy.get(editRow.projectId) ?? []} anchor={edit.anchor} onClose={() => setEdit(null)}
        onPick={(sid) => done(sid === editRow.statusId ? null : [{ id: editRow.id, statusId: sid }], `${editRow.key} → ${data.statuses.find((s) => s.id === sid)?.name ?? 'status'}`)} />}
      {edit && editRow && edit.col === 'progress' && <ProgressEditor r={editRow} anchor={edit.anchor} onClose={() => setEdit(null)}
        onSave={(v) => done(v === null ? [{ id: editRow.id, clearProgress: true }] : [{ id: editRow.id, progress: v }], `${editRow.key} progress ${v ?? 'worked out'}${v === null ? '' : '%'}`)} />}
      {edit && editRow && edit.col === 'notes' && <NotesEditor r={editRow} people={data.people} anchor={edit.anchor} onClose={() => setEdit(null)}
        onSave={(t) => done(t === (editRow.notes ?? '') ? null : [{ id: editRow.id, notes: t }], `Note on ${editRow.key}`)} />}
    </div>
  );
}

function AddInput({ onDone }: { onDone: (t: string | null) => void }) {
  const [v, setV] = useState('');
  return <input autoFocus className="ps4-add" aria-label="New subtask title" placeholder="Subtask title, then ↵" value={v} maxLength={300} onChange={(e) => setV(e.target.value)} onClick={(e) => e.stopPropagation()}
    onKeyDown={(e) => { if (e.key === 'Enter') onDone(v.trim() || null); else if (e.key === 'Escape') { e.stopPropagation(); onDone(null); } }} onBlur={() => { if (!v.trim()) onDone(null); }} />;
}
