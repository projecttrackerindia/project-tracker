import { useEffect, useMemo, useRef, useState } from 'react';
import type { SheetChange, SheetRow, SheetStatus } from './portfolioApi';
import { addDays, dayNum, dm } from './planSheet';
import { checklistPct, parseNatural, type Load, type StatusKey } from './planSheetQuery';
import { Av, Dot, Floating } from './planSheetParts';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ym = (iso: string) => iso.slice(0, 7);
const monthAdd = (m: string, n: number) => { const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const delta = (a: string | null, b: string | null) => (a && b ? dayNum(b) - dayNum(a) : 0);
const signed = (n: number) => (n > 0 ? `+${n}d` : `${n}d`);

/**
 * Dates: a month calendar with the start → due range, quick chips (Today, Fri, +1 week, +2d) and a typed date ("next tue"), the slip against the
 * current due date, what moves for the tasks that wait on this one (shifted along unless "keep the overlap") and a warning when it would be due
 * before a task it depends on. Click a day for the due date, Shift-click for the start. Enter saves, Esc cancels.
 */
export function DateEditor({ r, rows, today, anchor, onSave, onClose }: {
  r: SheetRow; rows: SheetRow[]; today: string; anchor: HTMLElement | null; onSave: (changes: SheetChange[], label: string) => void; onClose: () => void;
}) {
  const [due, setDue] = useState<string | null>(r.due);
  const [start, setStart] = useState<string | null>(r.start);
  const [month, setMonth] = useState(ym(r.due ?? today));
  const [typed, setTyped] = useState('');
  const [typedErr, setTypedErr] = useState(false);
  const [shift, setShift] = useState(true);
  const project = r.kind === 'project';
  const move = delta(r.due, due);
  const dependents = useMemo(() => rows.filter((x) => x.id !== r.id && x.dependsOn.includes(r.key) && x.kind !== 'meeting'), [rows, r]);
  const overlap = due ? dependents.filter((x) => { const s = x.start ?? x.due; return !!s && dayNum(s) <= dayNum(due); }) : [];
  // The tasks that wait on this one move by the same number of days (keeping their gap), unless the overlap is kept.
  const ripple = move > 0 ? dependents.filter((x) => x.start ?? x.due).map((x) => ({ x, from: x.start ?? x.due!, to: addDays(x.start ?? x.due!, move), due: x.due ? addDays(x.due, move) : null })) : [];
  const blockers = due ? rows.filter((x) => r.dependsOn.includes(x.key) && x.due && dayNum(x.due) > dayNum(due)) : [];
  const badRange = !!(start && due && dayNum(due) < dayNum(start));
  const pick = (iso: string, asStart: boolean) => {
    if (asStart) setStart(iso); else { setDue(iso); if (start && dayNum(iso) < dayNum(start) && !r.start) setStart(null); }
    setMonth(ym(iso));
  };
  const save = () => {
    if (badRange || !due) return;
    const c: SheetChange = { id: r.id };
    if (due !== r.due) c.dueDate = due;
    if (start !== r.start) { if (start) c.startDate = start; else if (!project) c.clearStart = true; }
    const changes: SheetChange[] = c.dueDate || c.startDate || c.clearStart ? [c] : [];
    if (shift) for (const p of ripple) changes.push({ id: p.x.id, startDate: p.x.start ? p.to : undefined, dueDate: p.due ?? undefined });
    if (changes.length === 0) { onClose(); return; }
    onSave(changes.map((x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) as SheetChange), changes.length > 1 ? `Moved ${r.key} and ${changes.length - 1} after it` : `Moved ${r.key}`);
  };
  // The month grid, Monday first, padded with the neighbouring months.
  const cells = useMemo(() => {
    const first = `${month}-01`, d0 = dayNum(first), dow = (new Date(d0 * 86_400_000).getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
    const n = Math.ceil((dow + days) / 7) * 7;
    return Array.from({ length: n }, (_, i) => addDays(first, i - dow));
  }, [month]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const chip = (label: string, iso: string | null) => <button type="button" className="ps3-qc" disabled={!iso} onClick={() => iso && pick(iso, false)}>{label}</button>;
  const base = due ?? today;
  return (
    <Floating anchor={anchor} onClose={onClose} width={300} place="right" label={`Dates of ${r.key}`} className="ps3-datepop" style={{ padding: '12px 14px' }}>
      <div ref={ref} tabIndex={-1} style={{ outline: 0 }} onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'INPUT') { e.preventDefault(); save(); } }}>
        <div className="ps3-calh"><b>{MONTHS[+month.slice(5, 7) - 1]} {month.slice(0, 4)}</b>
          <span><button type="button" aria-label="Previous month" onClick={() => setMonth(monthAdd(month, -1))}>‹</button><button type="button" aria-label="Next month" onClick={() => setMonth(monthAdd(month, 1))}>›</button></span></div>
        <div className="ps3-cal" role="grid" aria-label="Calendar">
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i} className="h" aria-hidden="true">{d}</span>)}
          {cells.map((iso) => {
            const n = dayNum(iso), sel = iso === due || iso === start, inR = !!(start && due && n > dayNum(start) && n < dayNum(due));
            const cls = [iso.slice(0, 7) !== month ? 'o' : '', sel ? 's' : inR ? 'r' : '', iso === today && !sel ? 't' : ''].join(' ');
            return <button key={iso} type="button" className={cls} aria-pressed={sel} aria-label={`${dm(iso)}${iso === due ? ', due' : iso === start ? ', start' : ''}`}
              onClick={(e) => pick(iso, e.shiftKey)}>{+iso.slice(8, 10)}</button>;
          })}
        </div>
        <div className="row" style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap', padding: 0 }}>
          {chip('Today', today)}{chip('Fri', parseNatural('fri', base, today))}{chip('+1 week', addDays(base, 7))}{chip('+2d', addDays(base, 2))}
          <input className="ps3-typed" aria-label="Type a date" placeholder="Type “next tue”" value={typed} style={typedErr ? { boxShadow: 'inset 0 0 0 1px var(--p-red)' } : undefined}
            onChange={(e) => { setTyped(e.target.value); setTypedErr(false); }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault(); e.stopPropagation();
              if (!typed.trim()) { save(); return; }
              const iso = parseNatural(typed, base, today); if (iso) { pick(iso, false); setTyped(''); } else setTypedErr(true);
            }} />
        </div>
        <div className="hr" style={{ margin: '10px -14px' }} />
        <div className="ps3-prev">
          <div><span className="ps3-dim">Due</span><span>{move !== 0 && <><s className="ps3-dim">{dm(r.due)}</s> → </>}<b>{dm(due) || '—'}</b>
            {move !== 0 && <span style={{ color: move > 0 ? 'var(--p-orange)' : 'var(--p-green)', fontWeight: 600 }}> {signed(move)} {move > 0 ? 'slip' : 'earlier'}</span>}</span></div>
          <div><span className="ps3-dim">Start</span><span>{start ? dm(start) : '—'} <span className="ps3-dim" style={{ fontSize: 11 }}>· ⇧-click a day</span></span></div>
          {ripple.length > 0 && <div><span className="ps3-dim">Ripple</span><span style={{ textAlign: 'right' }}>{ripple.slice(0, 3).map((p) => <span key={p.x.id} style={{ display: 'block', opacity: shift ? 1 : .45 }}>{p.x.key} moves {dm(p.from)} → {dm(p.to)}</span>)}</span></div>}
        </div>
        {overlap.length > 0 && (
          <div className="ps3-warn" style={{ marginTop: 9 }} role="status"><i>!</i><span>{overlap[0].key} starts {dm(overlap[0].start ?? overlap[0].due)}, before this ends.{' '}
            {shift ? <><b>Shift it too</b> (shown above) or <button type="button" onClick={() => setShift(false)}>keep the overlap</button>.</> : <>Keeping the overlap · <button type="button" onClick={() => setShift(true)}>Shift it too</button></>}</span></div>
        )}
        {blockers.length > 0 && <div className="ps3-warn" style={{ marginTop: 9 }} role="alert"><i>!</i><span><b>Due before dependency</b> — {r.key} waits on {blockers[0].key}, which ends {dm(blockers[0].due)}.</span></div>}
        {badRange && <div className="ps3-warn" style={{ marginTop: 9 }} role="alert"><i>!</i><span>The due date is before the start.</span></div>}
        <div style={{ display: 'flex', alignItems: 'center', marginTop: 10, gap: 8 }}>
          <span className="ps3-dim" style={{ fontSize: 11.5 }}>↵ save · Esc cancel</span><span className="ps3-sp" />
          <button type="button" className="ps3-qc" onClick={onClose}>Cancel</button>
          <button type="button" className="ps3-qc pri" disabled={badRange || !due} onClick={save}>Save</button>
        </div>
      </div>
    </Floating>
  );
}

/**
 * People: type to search; each person with their load for the task's week (over 100% in red). The least-loaded person is suggested; highlighting
 * someone who would go over 100% shows a warning with the suggestion.
 */
export function PeoplePicker({ r, people, loadFor, week, mon, anchor, initial = '', onPick, onClose, onWarn }: {
  r: SheetRow; people: { id: string; name: string }[]; loadFor: (id: string) => Load; week: string; mon: string; anchor: HTMLElement | null; initial?: string;
  onPick: (id: string | null) => void; onClose: () => void; onWarn: (text: string | null) => void;
}) {
  const [q, setQ] = useState(initial);
  const loads = useMemo(() => people.map((p) => ({ p, l: loadFor(p.id) })), [people, loadFor]);
  const suggested = useMemo(() => [...loads].filter((x) => x.p.id !== r.ownerId && x.l.pct < 70).sort((a, b) => a.l.pct - b.l.pct)[0] ?? null, [loads, r.ownerId]);
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    const rank = (n: string) => { const l = n.toLowerCase(); return !t ? 0 : l.startsWith(t) ? 0 : l.split(/\s+/).some((w) => w.startsWith(t)) ? 1 : l.includes(t) ? 2 : 3; };
    return loads.filter((x) => rank(x.p.name) < 3).sort((a, b) => rank(a.p.name) - rank(b.p.name)).slice(0, 8);
  }, [loads, q]);
  const showSuggested = !q.trim() && suggested;
  const flat = showSuggested ? [suggested, ...list.filter((x) => x.p.id !== suggested.p.id)].slice(0, 8) : list;
  const [i, setI] = useState(0);
  const hi = flat[Math.min(i, flat.length - 1)];
  useEffect(() => {
    if (hi && hi.l.pct > 100 && hi.p.id !== suggested?.p.id) onWarn(`${hi.p.name} would be at ${hi.l.pct}% the week of ${dm(mon)} — Aura suggests ${suggested?.p.name ?? 'someone with more room'}`);
    else onWarn(null);
  }, [hi, suggested, mon, onWarn]);
  useEffect(() => () => onWarn(null), [onWarn]);
  const bar = (pct: number, on: boolean) => <span className="ps3-wl" style={on ? { background: 'rgba(255,255,255,.3)' } : undefined}><b style={{ width: `${Math.min(pct, 100)}%`, background: on ? '#fff' : pct > 100 ? 'var(--p-red)' : pct >= 80 ? 'var(--p-orange)' : 'var(--p-green)' }} /></span>;
  const item = (x: { p: { id: string; name: string }; l: Load }, n: number, sub?: string) => (
    <button key={x.p.id} type="button" role="option" aria-selected={n === i} className={`it ${n === i ? 'on' : ''}`} onMouseEnter={() => setI(n)} onClick={() => onPick(x.p.id)}>
      <Av id={x.p.id} name={x.p.name} />
      <span style={{ flex: 1, minWidth: 0 }}>{x.p.name}{sub && <span className="ps3-dim" style={{ display: 'block', fontSize: 11 }}>{sub}</span>}</span>
      {bar(x.l.pct, n === i)}
      {!sub && <span className="ps3-num" style={{ width: 38, textAlign: 'right', fontSize: 12, ...(x.l.pct > 100 && n !== i ? { color: 'var(--p-red)', fontWeight: 600 } : n === i ? {} : { color: 'var(--p-ink2)' }) }}>{x.l.pct}%</span>}
    </button>
  );
  return (
    <Floating anchor={anchor} onClose={onClose} width={340} label={`Owner of ${r.key}`} style={{ paddingBottom: 8 }}>
      <div style={{ padding: '10px 14px 6px' }}>
        <label className="ps3-pick-in"><span>To</span>
          <input autoFocus role="combobox" aria-expanded aria-controls="ps3-people" aria-label="Search people" value={q} onChange={(e) => { setQ(e.target.value); setI(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(flat.length - 1, x + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); if (hi) onPick(hi.p.id); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
            }} />
          <span className="ps3-dim" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>Workload · {week}</span></label>
      </div>
      <div id="ps3-people" role="listbox" aria-label="People">
        {showSuggested && <><div className="ph">Suggested</div>{item(suggested, 0, suggested.l.pct < 50 ? 'Free most of the week' : `${suggested.l.pct}% booked`)}<div className="ph">Everyone</div></>}
        {flat.slice(showSuggested ? 1 : 0).map((x, n) => item(x, n + (showSuggested ? 1 : 0)))}
        {flat.length === 0 && <div className="it ps3-dim">Nobody matches “{q}”</div>}
        {r.kind !== 'project' && r.ownerId && <button type="button" className="it" onClick={() => onPick(null)}><span className="ps3-dim">No owner</span></button>}
      </div>
      <div className="hr" />
      <div style={{ padding: '4px 14px', fontSize: 12 }} className="ps3-dim">↵ assign · Esc cancel{loads[0]?.l.source === 'estimate' ? ' · load from assigned hours' : ''}</div>
    </Floating>
  );
}

const catKey = (c: string): StatusKey => (c === 'Done' ? 'done' : c === 'Active' ? 'prog' : 'todo');
export function StatusPicker({ r, statuses, anchor, onPick, onClose }: { r: SheetRow; statuses: SheetStatus[]; anchor: HTMLElement | null; onPick: (id: string) => void; onClose: () => void }) {
  const [i, setI] = useState(Math.max(0, statuses.findIndex((s) => s.id === r.statusId)));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <Floating anchor={anchor} onClose={onClose} width={220} label={`Status of ${r.key}`} role="listbox" style={{ padding: '4px 0 6px' }}>
      <div ref={ref} tabIndex={-1} style={{ outline: 0 }} onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(statuses.length - 1, x + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
        else if (e.key === 'Enter') { e.preventDefault(); if (statuses[i]) onPick(statuses[i].id); }
      }}>
        <div className="ph">Status</div>
        {statuses.map((s, n) => <button key={s.id} type="button" role="option" aria-selected={n === i} className={`it ${n === i ? 'on' : ''}`} onMouseEnter={() => setI(n)} onClick={() => onPick(s.id)}>
          <Dot k={catKey(s.category)} /><span style={{ flex: 1 }}>{s.name}</span>{s.id === r.statusId && <span className="ps3-dim" style={{ fontSize: 11.5 }}>current</span>}</button>)}
      </div>
    </Floating>
  );
}

export function ProgressEditor({ r, anchor, onSave, onClose }: { r: SheetRow; anchor: HTMLElement | null; onSave: (v: number | null) => void; onClose: () => void }) {
  const [v, setV] = useState(r.progress ?? 0);
  const fromList = checklistPct(r);
  return (
    <Floating anchor={anchor} onClose={onClose} width={260} label={`Progress of ${r.key}`} style={{ padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}><b>Progress</b><span className="ps3-num" style={{ fontSize: 17, fontWeight: 650 }}>{v}%</span></div>
      <input autoFocus type="range" min={0} max={100} step={5} value={v} className="ps3-slider" aria-label="Progress" onChange={(e) => setV(+e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSave(v); } }} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
        {[0, 25, 50, 75, 100].map((n) => <button key={n} type="button" className={`ps3-qc ${v === n ? 'on' : ''}`} onClick={() => setV(n)}>{n}%</button>)}
      </div>
      {(fromList != null || r.manualProgress) && <div className="ps3-dim" style={{ fontSize: 12, marginTop: 9 }}>
        {fromList != null ? <>Checklist says {fromList}% ({r.checklistDone} of {r.checklistTotal}). </> : null}
        {r.manualProgress && <button type="button" className="ps3-link" onClick={() => onSave(null)}>Work it out again</button>}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
        <button type="button" className="ps3-qc" onClick={onClose}>Cancel</button><button type="button" className="ps3-qc pri" onClick={() => onSave(v)}>Save</button></div>
    </Floating>
  );
}

/** Notes: the first line of the task's description. @ suggests people (Enter or Tab inserts the first name); links are kept as typed. ⌘↵ saves. */
export function NotesEditor({ r, people, anchor, onSave, onClose }: { r: SheetRow; people: { id: string; name: string }[]; anchor: HTMLElement | null; onSave: (text: string) => void; onClose: () => void }) {
  const [v, setV] = useState(r.notes ?? '');
  const [caret, setCaret] = useState(v.length);
  const ta = useRef<HTMLTextAreaElement>(null);
  const at = /(^|\s)@([\w.À-ÿ-]*)$/.exec(v.slice(0, caret));
  const matches = at ? people.filter((p) => p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(at[2].toLowerCase()))).slice(0, 5) : [];
  const [mi, setMi] = useState(0);
  const insert = (p: { name: string }) => {
    if (!at) return;
    const before = v.slice(0, caret - at[2].length - 1), after = v.slice(caret);
    const text = `${before}@${p.name.split(' ')[0]} `;
    setV(text + after); setCaret(text.length);
    requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(text.length, text.length); });
  };
  return (
    <Floating anchor={anchor} onClose={onClose} width={340} label={`Notes of ${r.key}`} style={{ padding: '12px 14px' }}>
      <textarea ref={ta} autoFocus className="ps3-notes-in" aria-label="Note" value={v} maxLength={300} placeholder="Add a note… @ to mention, paste a link"
        onChange={(e) => { setV(e.target.value.replace(/\n/g, ' ')); setCaret(e.target.selectionStart); setMi(0); }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
        onKeyDown={(e) => {
          if (matches.length && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); insert(matches[mi] ?? matches[0]); return; }
          if (matches.length && e.key === 'ArrowDown') { e.preventDefault(); setMi((x) => Math.min(matches.length - 1, x + 1)); return; }
          if (matches.length && e.key === 'ArrowUp') { e.preventDefault(); setMi((x) => Math.max(0, x - 1)); return; }
          if (e.key === 'Enter') { e.preventDefault(); onSave(v.trim()); }
        }} />
      {matches.length > 0 && <div role="listbox" aria-label="Mention someone" style={{ margin: '6px -14px 0' }}>
        {matches.map((p, n) => <button key={p.id} type="button" role="option" aria-selected={n === mi} className={`it ${n === mi ? 'on' : ''}`} onMouseDown={(e) => { e.preventDefault(); insert(p); }}><Av id={p.id} name={p.name} />{p.name}</button>)}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <span className="ps3-dim" style={{ fontSize: 11.5 }}>@ mention · links kept · ↵ save</span><span className="ps3-sp" />
        <button type="button" className="ps3-qc" onClick={onClose}>Cancel</button><button type="button" className="ps3-qc pri" onClick={() => onSave(v.trim())}>Save</button></div>
    </Floating>
  );
}
