import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../../api/client';
import { toast } from '../../stores/ui';
import { portfolioApi, type PasteResult, type PasteRowIn, type PlanSheet as PlanSheetData } from './portfolioApi';
import { dm, parseTsv } from './planSheet';
import { fuzzyPerson, pastedDate, type StatusKey } from './planSheetQuery';
import { Dot, Owner } from './planSheetParts';

type Field = 'title' | 'owner' | 'start' | 'due' | 'status' | 'progress' | 'ignore';
const FIELDS: { id: Field; label: string }[] = [{ id: 'title', label: 'Task' }, { id: 'owner', label: 'Owner' }, { id: 'start', label: 'Start' }, { id: 'due', label: 'Due' },
  { id: 'status', label: 'Status' }, { id: 'progress', label: 'Progress' }, { id: 'ignore', label: "Don't import" }];
const WORDS: [Field, RegExp][] = [
  ['title', /^(task|tasks|task name|title|name|item|activity|work|deliverable|summary|description)$/],
  ['owner', /^(owner|assigned to|assignee|assigned|who|responsible|person|resource|owner name)$/],
  ['start', /^(start|start date|from|begin|begins|starts)$/],
  ['due', /^(end|due|due date|end date|finish|finish date|deadline|to|target|target date|ends)$/],
  ['status', /^(status|state|stage)$/],
  ['progress', /^(% ?done|% ?complete|progress|percent|complete|percent complete|done %)$/],
];
const guess = (h: string): Field | null => WORDS.find(([, re]) => re.test(h.trim().toLowerCase()))?.[0] ?? null;
const catKey = (c: string | null | undefined): StatusKey => (c === 'Done' ? 'done' : c === 'Active' ? 'prog' : 'todo');

/**
 * Paste from Excel: the columns matched to the sheet's fields by their headers (changeable), names matched loosely to people ("J. Weber",
 * "tomas.ortega"), statuses to the project's columns ("WIP" → In progress), dates read as DD/MM (or MM/DD), all checked on the server first;
 * rows with problems are flagged and left out. Progress, when mapped, is set on the new tasks after they are added.
 */
export function PasteModal({ grid: initial, data, defaultProject, today, onClose, onDone }: {
  grid: string[][]; data: PlanSheetData; defaultProject: string | null; today: string; onClose: () => void; onDone: () => void;
}) {
  const [grid, setGrid] = useState(initial);
  const projects = data.rows.filter((r) => r.kind === 'project');
  const [projectId, setProjectId] = useState(defaultProject ?? projects[0]?.id ?? '');
  const width = Math.max(0, ...grid.map((r) => r.length));
  const auto = useMemo(() => {
    const g = (grid[0] ?? []).map(guess);
    const header = g.filter(Boolean).length >= Math.min(2, grid[0]?.length ?? 0);
    const used = new Set<Field>();
    const order: Field[] = ['title', 'owner', 'start', 'due', 'status', 'progress'];
    const map = Array.from({ length: width }, (_, i) => {
      const f = header ? g[i] : order[i];
      if (f && !used.has(f)) { used.add(f); return f; }
      return 'ignore' as Field;
    });
    return { header, map };
  }, [grid, width]);
  const [map, setMap] = useState<Field[] | null>(null);
  const m = map && map.length === width ? map : auto.map;
  const [order, setOrder] = useState<'dmy' | 'mdy'>('dmy');
  const body = useMemo(() => (auto.header ? grid.slice(1) : grid), [grid, auto.header]);
  const col = (f: Field) => m.indexOf(f);
  const cell = (r: string[], f: Field) => { const i = col(f); return i < 0 ? undefined : (r[i] ?? '').trim() || undefined; };
  const input: PasteRowIn[] = useMemo(() => body.map((r) => {
    const owner = cell(r, 'owner'), p = fuzzyPerson(owner, data.people);
    const date = (f: Field) => { const raw = cell(r, f); return raw ? pastedDate(raw, order, today) ?? raw : undefined; };
    return { title: cell(r, 'title') ?? '', owner: p?.name ?? owner, start: date('start'), due: date('due'), status: cell(r, 'status') };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cell() reads m
  }), [body, m, order, data.people, today]);
  const progress = (r: string[]) => { const raw = cell(r, 'progress'); if (!raw) return null; const n = parseFloat(raw.replace('%', '')); return Number.isFinite(n) ? Math.round(Math.max(0, Math.min(100, n <= 1 && raw.includes('.') ? n * 100 : n))) : NaN; };
  const [res, setRes] = useState<PasteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (!projectId || input.length === 0) { setRes(null); return; }
    let live = true; setBusy(true);
    portfolioApi.sheetPaste(projectId, input, false).then((x) => { if (live) { setRes(x); setErr(''); } })
      .catch((e) => live && setErr(e instanceof ApiError ? e.message : 'The rows could not be checked.')).finally(() => live && setBusy(false));
    return () => { live = false; };
  }, [projectId, input]);
  const rows = (res?.rows ?? []).map((x) => ({ ...x, pct: progress(body[x.index] ?? []) }));
  const problems = rows.map((x) => ({ x, list: [...x.problems, ...(Number.isNaN(x.pct) ? [`Progress “${cell(body[x.index] ?? [], 'progress')}” is not a number`] : [])] })).filter((y) => y.list.length);
  const ready = rows.filter((x) => x.ready && !Number.isNaN(x.pct));
  const needsReason = ready.some((x) => x.needsReason);
  const project = projects.find((p) => p.id === projectId);
  const statuses = data.statuses.filter((s) => s.projectId === projectId);
  // The caption under each column's field: what was matched.
  const caption = (f: Field): { ok: boolean; text: string } => {
    switch (f) {
      case 'title': return { ok: true, text: 'Title' };
      case 'owner': { const typed = rows.filter((x) => (input[x.index]?.owner ?? '') !== ''); const hit = typed.filter((x) => x.ownerId); return { ok: hit.length === typed.length, text: `Matched ${hit.length} of ${typed.length} ${typed.length === 1 ? 'person' : 'people'}` }; }
      case 'start': return { ok: true, text: 'Dates · start' };
      case 'due': return { ok: true, text: 'Dates · due' };
      case 'status': {
        const first = rows.find((x) => x.status && input[x.index]?.status && input[x.index]!.status!.toLowerCase() !== x.status.toLowerCase());
        const bad = rows.some((x) => input[x.index]?.status && !x.status);
        return { ok: !bad, text: first ? `“${input[first.index]!.status}” → ${first.status}` : bad ? 'Some not matched' : 'Matched' };
      }
      case 'progress': return { ok: !rows.some((x) => Number.isNaN(x.pct)), text: 'Percent' };
      default: return { ok: true, text: 'Not imported' };
    }
  };
  const commit = async () => {
    if (!res) return;
    if (needsReason && !reason.trim()) { setErr('Say why the due dates are moving.'); return; }
    setBusy(true);
    try {
      const out = await portfolioApi.sheetPaste(projectId, input, true, ready.map((x) => x.index), reason.trim() || null);
      const withPct = out.rows.filter((x) => x.saved && x.savedId).map((x) => ({ id: x.savedId!, pct: progress(body[x.index] ?? []) })).filter((x) => x.pct != null && !Number.isNaN(x.pct) && x.pct > 0);
      if (withPct.length) await portfolioApi.sheetBulk(withPct.map((x) => ({ id: x.id, progress: x.pct! }))).catch(() => toast('The tasks were added; their progress could not be set.', 'error'));
      const failed = out.rows.filter((x) => ready.some((y) => y.index === x.index) && !x.saved);
      toast(failed.length ? `${out.saved} added · ${failed.length} not added (${failed[0].error})` : `${out.saved} task${out.saved === 1 ? '' : 's'} added to ${out.projectName}.`, failed.length ? 'error' : 'success');
      onDone();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'The rows could not be added.'); } finally { setBusy(false); }
  };
  const show = (x: (typeof rows)[number], f: Field, j: number) => {
    const raw = (body[x.index] ?? [])[j] ?? '';
    switch (f) {
      case 'title': return x.title || <span className="ps3-dim">(no title)</span>;
      case 'owner': return x.owner ? <Owner id={x.ownerId} name={x.owner} /> : raw ? <span style={{ color: 'var(--p-orange)' }}>“{raw}”</span> : '';
      case 'start': return x.start ? <span className="ps3-num">{dm(x.start)}</span> : raw ? <span style={{ color: 'var(--p-orange)' }}>{raw}</span> : '';
      case 'due': return x.due ? <span className="ps3-num">{dm(x.due)}</span> : raw ? <span style={{ color: 'var(--p-orange)' }}>{raw}</span> : '';
      case 'status': { const s = statuses.find((y) => y.id === x.statusId); return s ? <span className="ps3-st"><Dot k={catKey(s.category)} />{s.name}</span> : raw ? <span style={{ color: 'var(--p-orange)' }}>{raw}</span> : ''; }
      case 'progress': return x.pct == null ? '' : Number.isNaN(x.pct) ? <span style={{ color: 'var(--p-orange)' }}>{raw}</span> : `${x.pct}%`;
      default: return <span className="ps3-dim">{raw}</span>;
    }
  };
  return createPortal(
    <>
      <div className="ps3-scrim ps3-modal-scrim" onMouseDown={onClose} />
      <div className="ps3-modal" role="dialog" aria-modal="true" aria-label="Paste from Excel" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <div className="ps3-modal-h">
          <div style={{ minWidth: 0 }}>
            <h2>{grid.length ? <>Paste {body.length} row{body.length === 1 ? '' : 's'} into{' '}
              <select aria-label="Project to paste into" value={projectId} onChange={(e) => setProjectId(e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></> : 'Paste from Excel'}</h2>
            <div className="ps3-dim" style={{ marginTop: 3, fontSize: 12.5 }}>{grid.length ? 'We matched your columns. Check the preview, then add.' : 'Copy rows in Excel and paste them here. The first row may be headers.'}</div>
          </div>
          <span className="ps3-sp" />
          {res && problems.length > 0 && <span className="ps3-qc" style={{ background: 'rgba(255,149,0,.12)', color: 'var(--p-orange)', cursor: 'default' }}>{problems.length} need{problems.length === 1 ? 's' : ''} a look</span>}
        </div>
        {grid.length === 0 ? (
          <textarea className="ps3-paste-box" aria-label="Paste rows here" autoFocus placeholder="Paste rows copied from Excel here (⌘V)"
            onPaste={(e) => { const g = parseTsv(e.clipboardData.getData('text/plain')); if (g.length) { e.preventDefault(); setGrid(g); } }}
            onChange={(e) => { const g = parseTsv(e.target.value); if (g.length && /\t/.test(e.target.value)) setGrid(g); }} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="ps3-mt">
              <thead>
                <tr>{Array.from({ length: width }, (_, j) => <th key={j}><div className="ps3-dim" style={{ fontSize: 11 }}>From Excel · {auto.header ? grid[0][j] || `Column ${String.fromCharCode(65 + j)}` : `Column ${String.fromCharCode(65 + j)}`}</div></th>)}</tr>
                <tr>{m.map((f, j) => {
                  const c = caption(f);
                  return <td key={j} style={{ borderBottom: '1px solid var(--p-line)' }}>
                    <select className="ps3-mapsel" aria-label={`Field for column ${String.fromCharCode(65 + j)}`} value={f} onChange={(e) => { const n = [...m]; const v = e.target.value as Field; const k = n.indexOf(v); if (k >= 0 && v !== 'ignore') n[k] = 'ignore'; n[j] = v; setMap(n); }}>
                      {FIELDS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
                    <div className={`ps3-mapok ${c.ok ? '' : 'no'}`}>{c.ok ? '✓' : '!'} {c.text}</div></td>;
                })}</tr>
              </thead>
              <tbody>
                {rows.map((x) => <tr key={x.index} className={problems.some((p) => p.x.index === x.index) ? 'bad' : ''}>{m.map((f, j) => <td key={j}>{show(x, f, j)}</td>)}</tr>)}
                {busy && !res && <tr><td colSpan={width} className="ps3-dim">Checking the rows…</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        {problems.slice(0, 2).map((p) => <div key={p.x.index} style={{ margin: '12px 24px 0' }} className="ps3-warn" role="alert"><i>!</i><span>“{p.x.title || `Row ${p.x.index + 1}`}” — <b>{p.list.join(' · ')}</b>. It is left out; fix it in Excel and paste again, or add the rest.</span></div>)}
        {problems.length > 2 && <div className="ps3-dim" style={{ margin: '6px 24px 0', fontSize: 12 }}>and {problems.length - 2} more rows with problems</div>}
        {needsReason && <div style={{ margin: '12px 24px 0' }}><label className="ps3-dim" style={{ fontSize: 12 }}>Some rows update tasks and move their due date later — why?{' '}
          <input className="ps3-typed" style={{ width: 280 }} aria-label="Reason for the date changes" value={reason} onChange={(e) => { setReason(e.target.value); setErr(''); }} maxLength={480} /></label></div>}
        {err && <p className="ps3-err" role="alert">{err}</p>}
        <div className="ps3-modal-f">
          <span className="ps3-dim" style={{ fontSize: 12 }}>Dates read as {order === 'dmy' ? 'DD/MM' : 'MM/DD'} · <button type="button" className="ps3-link" style={{ fontWeight: 400, fontSize: 12 }} onClick={() => setOrder(order === 'dmy' ? 'mdy' : 'dmy')}>change</button></span>
          <span className="ps3-sp" />
          <button type="button" className="ps3-qc lg" onClick={onClose}>Cancel</button>
          <button type="button" className="ps3-qc lg pri" disabled={busy || ready.length === 0} onClick={() => void commit()}>Add {ready.length} task{ready.length === 1 ? '' : 's'}</button>
        </div>
        {project == null && grid.length > 0 && <p className="ps3-err">Choose a project to paste into.</p>}
      </div>
    </>,
    document.body,
  );
}
