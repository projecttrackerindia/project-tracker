import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useWsQuery } from '../../lib/hooks';
import { portfolioApi, type PortfolioFilter, type TimelineProject } from './portfolioApi';
import { useDecisionActions, type DecisionItem } from './portfolioDecisions';
import { dayMonth } from './projectParts';
import type { PortfolioBrief, PortfolioRisk } from '../ai/aiApi';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A decision card: project, Due → Forecast, why, and always an action. */
export function DecisionCard({ item, filter }: { item: DecisionItem; filter: PortfolioFilter }) {
  const a = useDecisionActions(item, filter);
  const [open, setOpen] = useState(false);
  const others = item.decision?.options.filter((o) => o.kind !== 'accept_date') ?? [];
  const tone = item.slipDays > 14 ? 'late' : 'risk';
  return (
    <article className={`pf-dec ${a.done ?? ''}`} data-project={item.key} aria-label={`${item.name}: due ${dayMonth(item.due)}, forecast ${item.forecast ? dayMonth(item.forecast) : 'none yet'}`}>
      <header className="pf-dec-head">
        <h4><Link to={`/work/projects/${item.projectId}`}>{item.name}</Link> <span className="pj2-key">{item.key}</span></h4>
        <span className={`pf-chip ${tone}`}>{item.slipDays > 0 ? `${item.slipDays} day${item.slipDays === 1 ? '' : 's'} late` : 'On the edge'}</span>
      </header>
      <p className="pf-dec-dates">
        Due <s>{dayMonth(item.due)}</s> → {item.forecast ? <>Forecast <b>{dayMonth(item.forecast)}</b></> : <em>No forecast yet</em>}
      </p>
      <p className="pf-dec-why">{item.why}</p>
      <div className="pf-dec-acts">
        {a.done ? <span className="ds-pill success" role="status">{a.done === 'accepted' ? '✓ team told' : '✓ proposed'}</span> : <>
          {item.changes.length > 0 && <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>What changes</button>}
          {a.canAct
            ? <button type="button" className="btn btn-primary btn-sm" disabled={a.busy !== null || a.waiting > 0} onClick={() => void a.propose(item.acceptOpt!.id)}>{a.busy === item.acceptOpt!.id ? 'Proposing…' : `Propose ${dayMonth(item.forecast)}`}</button>
            : <Link className="btn btn-soft btn-sm" to={`/work/projects/${item.projectId}`}>Open project</Link>}
        </>}
      </div>
      {a.waiting > 0 && !a.done && <Link className="pj2-waiting" to={`/work/projects/${item.projectId}?tab=activity`}>{a.waiting} proposal{a.waiting === 1 ? '' : 's'} already waiting in {item.key} ›</Link>}
      {open && (
        <div className="pf-dec-changes">
          {item.decision?.causes.length ? <ul>{item.decision.causes.map((c) => <li key={c}>{cap(c)}</li>)}</ul> : !item.decision && <ul>{item.changes.map((c) => <li key={c}>{c}</li>)}</ul>}
          {others.length > 0 && (
            <ul className="pj2-options">
              {others.map((o) => (
                <li key={o.id}>
                  <div className="pj2-option-main"><b>{o.title}</b><span className={`pj2-effect ${o.slipDays != null && o.slipDays <= 0 ? 'ok' : 'late'}`}>{o.effect}</span></div>
                  <ul className="pf-steps">{o.steps.map((s) => <li key={s}>{s}</li>)}</ul>
                  {o.why && <p className="muted">{o.why}</p>}
                  {a.canAct && <button type="button" className="btn btn-soft btn-sm" disabled={a.busy !== null || a.waiting > 0} onClick={() => void a.propose(o.id)}>{a.busy === o.id ? 'Proposing…' : 'Propose this'}</button>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

// ------------------------------------------------------------------------------------------------------------------ Board
type Col = 'ok' | 'risk' | 'late';
const colOf = (h: string): Col | null => h === 'OnTrack' ? 'ok' : h === 'AtRisk' ? 'risk' : h === 'Delayed' ? 'late' : null;
const COLS: { id: Col; label: string }[] = [{ id: 'ok', label: 'On track' }, { id: 'risk', label: 'At risk' }, { id: 'late', label: 'Late' }];

function explain(p: TimelineProject, r: PortfolioRisk | undefined, col: Col) {
  if (r?.reasons[0]) return r.reasons[0];
  if (col === 'ok') return p.forecast && p.due ? `Forecast ${dayMonth(p.forecast)} is on or before the due date ${dayMonth(p.due)}.` : 'Work is moving at the pace the due date needs.';
  if (p.forecast && p.due && p.forecast > p.due) return `Forecast ${dayMonth(p.forecast)} is after the due date ${dayMonth(p.due)}.`;
  return col === 'late' ? 'The due date has passed or overdue work is piling up.' : 'Work is slower than the due date needs.';
}

/** Three columns, On track / At risk / Late, with compact cards. */
export function BoardColumns({ filter, brief }: { filter: PortfolioFilter; brief: PortfolioBrief }) {
  const q = useWsQuery(['portfolio', 'timeline', filter], () => portfolioApi.timeline(filter), { placeholderData: (p) => p });
  const ranked = new Map(brief.ranked.map((r) => [r.projectId, r]));
  const projects: TimelineProject[] = q.data?.projects ?? brief.ranked.map((r) => ({
    id: r.projectId, key: r.key, name: r.name, health: r.health, group: r.group, start: r.startDate, due: r.dueDate, originalDue: null, forecast: r.projectedFinish, progress: r.progress, milestones: [], dependsOn: [],
  }));
  return (
    <section className="pf-board" aria-label="Board">
      {COLS.map((c) => {
        const list = projects.filter((p) => colOf(p.health) === c.id);
        return (
          <div key={c.id} className={`pf-col ${c.id}`}>
            <h4 className="pf-col-head"><i className={c.id} />{c.label} <em>{list.length}</em></h4>
            {list.length === 0 ? <p className="pf-empty">None</p> : list.map((p) => {
              const r = ranked.get(p.id);
              const why = explain(p, r, c.id);
              return (
                <Link key={p.id} to={`/work/projects/${p.id}`} className="pf-card" title={why} aria-describedby={`pf-why-${p.id}`}>
                  <b className="pf-card-name">{p.name}</b>
                  <small>{r?.owner ?? 'No owner'} · {p.progress}% done</small>
                  <span className="pf-bar"><i style={{ width: `${Math.min(100, Math.max(0, p.progress))}%` }} /></span>
                  <small>Forecast {p.forecast ? dayMonth(p.forecast) : '—'}</small>
                  <span className="pf-tip" id={`pf-why-${p.id}`} role="tooltip">{why}</span>
                </Link>
              );
            })}
          </div>
        );
      })}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------------------------ Timeline
const dayMs = 86_400_000;
const at = (d: string) => new Date(d.slice(0, 10) + 'T00:00:00Z').getTime();

/** Gantt: months across, one row per project, the original plan outlined and the forecast filled in its status colour. */
export function Gantt({ filter }: { filter: PortfolioFilter }) {
  const q = useWsQuery(['portfolio', 'timeline', filter], () => portfolioApi.timeline(filter), { placeholderData: (p) => p });
  if (q.isLoading) return <p className="muted" role="status">Loading the timeline…</p>;
  const t = q.data;
  if (!t || t.projects.length === 0) return <section className="pf-gantt" aria-label="Timeline"><p className="muted">No projects match.</p></section>;
  const todayIso = new Date().toISOString().slice(0, 10);
  const dates = t.projects.flatMap((p) => [p.start, p.due, p.originalDue, p.forecast]).filter((d): d is string => !!d);
  const lo = Math.min(at(t.from), ...dates.map(at), at(todayIso));
  const hi = Math.max(at(t.to), ...dates.map(at), at(todayIso));
  const s0 = new Date(lo); const from = Date.UTC(s0.getUTCFullYear(), s0.getUTCMonth(), 1);
  const e0 = new Date(hi); const to = Date.UTC(e0.getUTCFullYear(), e0.getUTCMonth() + 1, 1);
  const span = Math.max(dayMs, to - from);
  const pct = (d: string) => ((at(d) - from) / span) * 100;
  const months: number[] = [];
  for (let m = from; m < to; m = Date.UTC(new Date(m).getUTCFullYear(), new Date(m).getUTCMonth() + 1, 1)) months.push(m);
  const seg = (a: string, b: string): CSSProperties => { const l = pct(a < b ? a : b); return { left: `${l}%`, width: `max(4px, ${Math.abs(pct(b) - pct(a))}%)` }; };
  return (
    <section className="pf-gantt" aria-label="Timeline">
      <div className="pf-g-grid">
        <div className="pf-g-head">
          <span className="pf-g-name" />
          <div className="pf-g-months">{months.map((m) => <span key={m} style={{ left: `${((m - from) / span) * 100}%` }}>{new Date(m).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })}</span>)}</div>
        </div>
        {t.projects.map((p, i) => {
          const start = p.start ?? p.due; const planEnd = p.originalDue ?? p.due; const fcEnd = p.forecast ?? p.due;
          const tone = colOf(p.health) ?? 'done';
          return (
            <div key={p.id} className="pf-g-row tl-row">
              <Link className="pf-g-name" to={`/work/projects/${p.id}`} title={p.name}><b>{p.key}</b> {p.name}</Link>
              <div className="pf-g-track" aria-label={`${p.key}: plan ${start ? dayMonth(start) : '—'} to ${planEnd ? dayMonth(planEnd) : '—'}, forecast ${fcEnd ? dayMonth(fcEnd) : '—'}`}>
                {start && planEnd && <i className="pf-g-plan" style={{ ...seg(start, planEnd), animationDelay: `${i * 40}ms` }} title={`Plan ${dayMonth(start)} → ${dayMonth(planEnd)}`} />}
                {start && fcEnd && <i className={`pf-g-fc ${tone}`} style={{ ...seg(start, fcEnd), animationDelay: `${i * 40}ms` }} title={`Forecast ${dayMonth(start)} → ${dayMonth(fcEnd)} · ${p.progress}% done`} />}
              </div>
            </div>
          );
        })}
        <div className="pf-g-todaywrap" aria-hidden="true"><i className="pf-g-today" style={{ left: `${pct(todayIso)}%` }}><span>Today</span></i></div>
      </div>
      <div className="pf-g-legend">
        <span><i className="pf-g-plan" /> Original plan</span>
        <span><i className="pf-g-fc ok" /> On track</span><span><i className="pf-g-fc risk" /> At risk</span><span><i className="pf-g-fc late" /> Late</span>
        <span><i className="pf-g-todaykey" /> Today</span>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------------------------ Present
function Slide({ item, filter, active }: { item: DecisionItem; filter: PortfolioFilter; active: boolean }) {
  const a = useDecisionActions(item, filter);
  return (
    <section className={`pf-slide ${active ? 'on' : ''}`} aria-hidden={!active} aria-label={item.name}>
      <p className="pf-slide-key">{item.key}</p>
      <h2>{item.name}</h2>
      <p className="pf-slide-dates">Due <s>{dayMonth(item.due)}</s> <span aria-hidden="true">→</span> {item.forecast ? <b>{dayMonth(item.forecast)}</b> : <em>No forecast yet</em>}</p>
      <div className="pf-slide-why">
        <h3>What changed</h3>
        <ul>{(item.changes.length ? item.changes : [item.why]).slice(0, 4).map((c) => <li key={c}>{c}</li>)}</ul>
      </div>
      {active && (
        <div className="pf-slide-acts">
          {a.done ? <span className="ds-pill success" role="status">{a.done === 'accepted' ? '✓ team told' : '✓ proposed'}</span>
            : a.canAct ? <>
              <button type="button" className="btn btn-ghost" disabled={a.busy !== null || a.waiting > 0} onClick={() => void a.propose(item.acceptOpt!.id)}>{a.busy === item.acceptOpt!.id ? 'Proposing…' : `Propose ${dayMonth(item.forecast)}`}</button>
              <button type="button" className="btn btn-primary" disabled={a.busy !== null} onClick={() => void a.accept()}>{a.busy === 'accept' ? 'Accepting…' : 'Accept'}</button>
            </> : <Link className="btn btn-soft" to={`/work/projects/${item.projectId}`}>Open project</Link>}
        </div>
      )}
    </section>
  );
}

/** Full-screen run-through of the decisions: ← → / space to move, Esc to leave. */
export function PresentOverlay({ items, filter, onClose }: { items: DecisionItem[]; filter: PortfolioFilter; onClose: () => void }) {
  const [i, setI] = useState(0);
  const n = items.length;
  const go = useCallback((d: number) => setI((v) => Math.min(Math.max(0, v + d), Math.max(0, n - 1))), [n]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !(e.target instanceof HTMLButtonElement))) { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [go, onClose]);
  return (
    <div className="pf-present" role="dialog" aria-modal="true" aria-label="Present decisions">
      <div className="pf-present-top">
        <span className="pf-count" aria-live="polite">{n ? `${i + 1} of ${n}` : '0 of 0'}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} autoFocus>Exit · Esc</button>
      </div>
      <div className="pf-stage">
        {n === 0 ? <section className="pf-slide on"><h2>No decisions this week</h2><p className="pf-slide-dates">Every project is forecast to land on time.</p></section>
          : items.map((it, k) => <Slide key={it.projectId} item={it} filter={filter} active={k === i} />)}
      </div>
      <div className="pf-present-nav">
        <button type="button" className="btn btn-ghost" disabled={i === 0} onClick={() => go(-1)} aria-label="Previous">‹</button>
        <button type="button" className="btn btn-ghost" disabled={i >= n - 1} onClick={() => go(1)} aria-label="Next">›</button>
      </div>
    </div>
  );
}
