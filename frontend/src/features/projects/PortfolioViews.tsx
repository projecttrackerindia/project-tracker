import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useWsQuery } from '../../lib/hooks';
import { useAuth } from '../../stores/auth';
import { portfolioApi, type DecisionOption, type PortfolioDecision, type PortfolioFilter, type TimelineProject } from './portfolioApi';
import { useDecisionActions, type DecisionItem } from './portfolioDecisions';
import { dayMonth } from './projectParts';
import type { PortfolioBrief, PortfolioRisk } from '../ai/aiApi';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** ISO week number (Week 44 in the eyebrow). */
export function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
}

/** The key chip colour: stable per project key, from the design's palette. */
const CHIP = ['#30b0c7', '#28cd41', '#af52de', '#5856d6', '#0a84ff', '#8ac43f', '#ff9500', '#ff375f', '#a2845e', '#00c7be'];
const chipColour = (key: string) => { let h = 0; for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0; return CHIP[h % CHIP.length]; };
const otherOptions = (d: PortfolioDecision | null): DecisionOption[] => d?.options.filter((o) => o.kind !== 'accept_date') ?? [];

/**
 * A row of the "Decisions this week" rail: the project, Due → Forecast · owner, and Propose date / Add people. Add people opens why it
 * moved and the other ways to recover (move someone onto it, cut scope), each of which can be proposed.
 */
export function DecisionCard({ item, filter, owner }: { item: DecisionItem; filter: PortfolioFilter; owner?: string | null }) {
  const a = useDecisionActions(item, filter);
  const [open, setOpen] = useState(false);
  const others = otherOptions(item.decision);
  const tone = item.slipDays > 14 ? 'late' : 'risk';
  const late = item.slipDays > 0 ? `${plural(item.slipDays, 'day')} late` : 'On the edge';
  const causes = item.decision?.causes.length ? item.decision.causes.map(cap) : item.changes.length ? item.changes : [item.why];
  return (
    <article className={`pf-dec ${a.done ?? ''}`} data-project={item.key} aria-label={`${item.name}: due ${dayMonth(item.due)}, forecast ${item.forecast ? dayMonth(item.forecast) : 'none yet'}`}>
      <h4><Link to={`/work/projects/${item.projectId}`}>{item.name}</Link> <span className="pf-sr">{item.key} · {late}</span></h4>
      <p className="pf-dec-dates">
        Due <s>{dayMonth(item.due)}</s> → {item.forecast ? <>Forecast <b className={tone}>{dayMonth(item.forecast)}</b></> : <em>No forecast yet</em>}
        {owner && <> · {owner}</>}
      </p>
      <div className="pf-dec-acts">
        {a.done ? <span className="ds-pill success" role="status">{a.done === 'accepted' ? '✓ team told' : '✓ proposed'}</span> : <>
          {a.canAct
            ? <button type="button" className="pf-btn pri" aria-label={`Propose ${dayMonth(item.forecast)}`} title={`Propose ${dayMonth(item.forecast)} as the new due date`} disabled={a.busy !== null || a.waiting > 0} onClick={() => void a.propose(item.acceptOpt!.id)}>{a.busy === item.acceptOpt!.id ? 'Proposing…' : 'Propose date'}</button>
            : <Link className="pf-btn pri" to={`/work/projects/${item.projectId}`}>Open project</Link>}
          <button type="button" className="pf-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>Add people</button>
        </>}
      </div>
      {a.waiting > 0 && !a.done && <Link className="pj2-waiting" to={`/work/projects/${item.projectId}?tab=activity`}>{a.waiting} proposal{a.waiting === 1 ? '' : 's'} already waiting in {item.key} ›</Link>}
      {open && (
        <div className="pf-dec-changes">
          <ul className="pf-why">{causes.map((c) => <li key={c}>{c}</li>)}</ul>
          {others.length > 0 && (
            <ul className="pf-options">
              {others.map((o) => (
                <li key={o.id}>
                  <div className="pf-option-main"><b>{o.title}</b><span className={`pf-effect ${o.slipDays != null && o.slipDays <= 0 ? 'ok' : 'late'}`}>{o.effect}</span></div>
                  <ul className="pf-steps">{o.steps.map((x) => <li key={x}>{x}</li>)}</ul>
                  {o.why && <p className="pf-option-why">{o.why}</p>}
                  {a.canAct && <button type="button" className="pf-btn" disabled={a.busy !== null || a.waiting > 0} onClick={() => void a.propose(o.id)}>{a.busy === o.id ? 'Proposing…' : 'Propose this'}</button>}
                </li>
              ))}
            </ul>
          )}
          {others.length === 0 && <p className="pf-option-why">No one has room to join right now. <Link to={`/work/projects/${item.projectId}?tab=people`}>Open the project’s people ›</Link></p>}
        </div>
      )}
    </article>
  );
}

// ------------------------------------------------------------------------------------------------------------------ Board
type Col = 'ok' | 'risk' | 'late';
const colOf = (h: string): Col | null => h === 'OnTrack' ? 'ok' : h === 'AtRisk' ? 'risk' : h === 'Delayed' ? 'late' : null;
const COLS: { id: Col; label: string }[] = [{ id: 'ok', label: 'On track' }, { id: 'risk', label: 'At risk' }, { id: 'late', label: 'Late' }];
const SHOWN = 4;

function explain(p: TimelineProject, r: PortfolioRisk | undefined, col: Col) {
  if (r?.reasons[0]) return r.reasons[0];
  if (col === 'ok') return p.forecast && p.due ? `Forecast ${dayMonth(p.forecast)} is on or before the due date ${dayMonth(p.due)}.` : 'Work is moving at the pace the due date needs.';
  if (p.forecast && p.due && p.forecast > p.due) return `Forecast ${dayMonth(p.forecast)} is after the due date ${dayMonth(p.due)}.`;
  return col === 'late' ? 'The due date has passed or overdue work is piling up.' : 'Work is slower than the due date needs.';
}

const useProjects = (filter: PortfolioFilter, brief: PortfolioBrief) => {
  const q = useWsQuery(['portfolio', 'timeline', filter], () => portfolioApi.timeline(filter), { placeholderData: (p) => p });
  const projects: TimelineProject[] = q.data?.projects ?? brief.ranked.map((r) => ({
    id: r.projectId, key: r.key, name: r.name, health: r.health, group: r.group, start: r.startDate, due: r.dueDate, originalDue: null, forecast: r.projectedFinish, progress: r.progress, milestones: [], dependsOn: [],
  }));
  return { q, projects };
};

/** Three calm columns, On track / At risk / Late, of compact cards: key chip, name, progress, owner and forecast. */
export function BoardColumns({ filter, brief }: { filter: PortfolioFilter; brief: PortfolioBrief }) {
  const { projects } = useProjects(filter, brief);
  const ranked = new Map(brief.ranked.map((r) => [r.projectId, r]));
  const [all, setAll] = useState<Col | null>(null);
  return (
    <section className="pf-board" aria-label="Board">
      {COLS.map((c) => {
        const list = projects.filter((p) => colOf(p.health) === c.id);
        const shown = all === c.id || list.length <= SHOWN + 1 ? list : list.slice(0, SHOWN);
        const more = list.length - shown.length;
        return (
          <div key={c.id} className={`pf-colwrap ${c.id}`}>
            <h4 className="pf-col-head"><i />{c.label} <em>{list.length}</em></h4>
            <div className="pf-col">
              {list.length === 0 ? <p className="pf-empty">None</p> : shown.map((p) => {
                const r = ranked.get(p.id);
                const why = explain(p, r, c.id);
                const end = p.forecast ?? p.due;
                return (
                  <Link key={p.id} to={`/work/projects/${p.id}`} className="pf-card" title={why} aria-describedby={`pf-why-${p.id}`}>
                    <span className="pf-card-t"><span className="pf-key" style={{ background: chipColour(p.key) }}>{p.key}</span><b className="pf-card-name">{p.name}</b></span>
                    <span className="pf-bar" aria-label={`${p.progress}% done`}><i style={{ width: `${Math.min(100, Math.max(0, p.progress))}%` }} /></span>
                    <span className="pf-card-f"><span>{r?.owner ?? 'No owner'}</span><span>{p.progress >= 100 ? 'Done' : end ? `→ ${dayMonth(end)}` : 'No date'}</span></span>
                    <span className="pf-tip" id={`pf-why-${p.id}`} role="tooltip">{why}</span>
                  </Link>
                );
              })}
              {more > 0 && (
                <button type="button" className="pf-card pf-more" onClick={() => setAll(c.id)}>
                  <span className="pf-card-t"><span className="pf-key more">+{more}</span><b className="pf-card-name">more {c.label.toLowerCase()}</b></span>
                  <span className="pf-bar" />
                  <span className="pf-card-f"><span>View all</span></span>
                </button>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------------------------ Timeline
const dayMs = 86_400_000;
const at = (d: string) => new Date(d.slice(0, 10) + 'T00:00:00Z').getTime();
const SEVERITY: Record<string, number> = { Delayed: 0, AtRisk: 1, OnTrack: 2 };
const monthYear = (m: number) => new Date(m).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export function TimelineLegend() {
  return (
    <div className="pf-legend" aria-label="Legend">
      <span><i className="plan" /> Plan</span><span><i className="fc" /> Forecast</span><span><i className="ms" /> Milestone</span>
    </div>
  );
}

/**
 * Gantt, six months from this month (longer when work runs later): one row per project sorted by severity, the original plan as an
 * outlined capsule and the forecast as a filled capsule in its status colour, milestones as diamonds, and a red Today line. Hovering
 * (or focusing) a row shows why it moved and the AI's best fix.
 */
export function Gantt({ filter, brief, decisions, onRange }: { filter: PortfolioFilter; brief: PortfolioBrief; decisions: PortfolioDecision[]; onRange?: (label: string) => void }) {
  const q = useWsQuery(['portfolio', 'timeline', filter], () => portfolioApi.timeline(filter), { placeholderData: (p) => p });
  const [hover, setHover] = useState<string | null>(null);
  const todayIso = new Date().toISOString().slice(0, 10);
  const t = q.data;
  const g = useMemo(() => {
    if (!t) return null;
    const now = new Date(at(todayIso));
    const from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const last = Math.max(...t.projects.flatMap((p) => [p.due, p.originalDue, p.forecast]).filter((d): d is string => !!d).map(at), at(todayIso));
    const l = new Date(last);
    const need = (l.getUTCFullYear() - now.getUTCFullYear()) * 12 + l.getUTCMonth() - now.getUTCMonth() + 1;
    const n = Math.min(12, Math.max(6, need));
    const months = Array.from({ length: n }, (_, k) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1));
    const to = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + n, 1);
    const pct = (d: string) => Math.min(100, Math.max(0, ((at(d) - from) / Math.max(dayMs, to - from)) * 100));
    const rows = [...t.projects].sort((a, b) => (SEVERITY[a.health] ?? 3) - (SEVERITY[b.health] ?? 3) || (b.forecast && b.due ? at(b.forecast) - at(b.due) : 0) - (a.forecast && a.due ? at(a.forecast) - at(a.due) : 0));
    return { months, pct, rows, label: `${monthYear(months[0])} – ${monthYear(months[n - 1])}` };
  }, [t, todayIso]);
  useEffect(() => { if (g && onRange) onRange(g.label); }, [g, onRange]);
  if (q.isLoading) return <p className="muted" role="status">Loading the timeline…</p>;
  if (!t || !g || t.projects.length === 0) return <section className="pf-gantt" aria-label="Timeline"><p className="muted pf-g-empty">No projects match.</p></section>;
  const ranked = new Map(brief.ranked.map((r) => [r.projectId, r]));
  const decided = new Map(decisions.map((d) => [d.projectId, d]));
  const first = (s: string | null | undefined) => (s ?? '').split(' ')[0];
  const seg = (a: string, b: string): CSSProperties => { const l = g.pct(a < b ? a : b); return { left: `${l}%`, width: `max(12px, ${Math.abs(g.pct(b) - l)}%)` }; };
  const hi = hover ? g.rows.findIndex((p) => p.id === hover) : -1;
  const hp = hi >= 0 ? g.rows[hi] : null;
  return (
    <section className="pf-gantt" aria-label="Timeline" style={{ '--pf-months': g.months.length } as CSSProperties}>
      <div className="pf-g-head">
        <span className="pf-g-count">{plural(t.projects.length, 'project')}</span>
        {g.months.map((m) => <span key={m}>{new Date(m).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}</span>)}
      </div>
      <div className="pf-g-body" onMouseLeave={() => setHover(null)}>
        <div className="pf-g-cols" aria-hidden="true">{g.months.map((m) => <i key={m} />)}</div>
        {g.rows.map((p, i) => {
          const start = p.start ?? p.due; const planEnd = p.originalDue ?? p.due; const fcEnd = p.forecast ?? p.due;
          const tone = colOf(p.health) ?? 'done';
          return (
            <div key={p.id} className={`pf-g-row tl-row ${hover === p.id ? 'on' : ''}`} onMouseEnter={() => setHover(p.id)} onFocus={() => setHover(p.id)} onBlur={() => setHover(null)}>
              <Link className="pf-g-name" to={`/work/projects/${p.id}`} title={p.name}><i className={tone} /><b>{p.name}</b>{ranked.get(p.id)?.owner && <small>{first(ranked.get(p.id)?.owner)}</small>}</Link>
              <div className="pf-g-track" aria-label={`${p.key}: plan ${start ? dayMonth(start) : '—'} to ${planEnd ? dayMonth(planEnd) : '—'}, forecast ${fcEnd ? dayMonth(fcEnd) : '—'}`}>
                {start && planEnd && <i className="pf-g-plan" style={seg(start, planEnd)} title={`Plan ${dayMonth(start)} → ${dayMonth(planEnd)}`} />}
                {start && fcEnd && <i className={`pf-g-fc ${tone}`} style={{ ...seg(start, fcEnd), animationDelay: `${i * 40}ms` }} title={`Forecast ${dayMonth(start)} → ${dayMonth(fcEnd)} · ${p.progress}% done`} />}
                {p.milestones.filter((m) => m.due).map((m) => <i key={m.id} className="pf-g-ms" style={{ left: `${g.pct(m.due!)}%`, animationDelay: `${i * 40 + 600 + 150}ms` }} title={`${m.name}: ${dayMonth(m.due)}`} />)}
              </div>
            </div>
          );
        })}
        <div className="pf-g-todaywrap" aria-hidden="true"><i className="pf-g-today" style={{ left: `${g.pct(todayIso)}%` }}><span>Today {dayMonth(todayIso)}</span></i></div>
        {hp && <HoverCard p={hp} index={hi} pct={g.pct} risk={ranked.get(hp.id)} decision={decided.get(hp.id) ?? null} />}
      </div>
    </section>
  );
}

function HoverCard({ p, index, pct, risk, decision }: { p: TimelineProject; index: number; pct: (d: string) => number; risk?: PortfolioRisk; decision: PortfolioDecision | null }) {
  const end = p.forecast ?? p.due;
  const slip = p.forecast && p.due ? Math.round((at(p.forecast) - at(p.due)) / dayMs) : 0;
  const reasons = (decision?.causes.length ? decision.causes.map(cap) : risk?.reasons ?? []).slice(0, 3);
  const fix = otherOptions(decision)[0];
  const x = end ? pct(end) : 50;
  // Positions are over the track (the body minus the name column).
  const style: CSSProperties = { top: `${Math.max(0, index * 46 + 4)}px`, ...(x > 58
    ? { right: `calc((100% - var(--pf-name)) * ${(100 - x) / 100} + 24px)` } : { left: `calc(var(--pf-name) + (100% - var(--pf-name)) * ${x / 100} + 24px)` }) };
  return (
    <div className="pf-hover" role="tooltip" style={style}>
      <div className="pf-hover-h"><b>{p.name}</b>{slip > 0 && <span className={`pf-slip ${colOf(p.health) ?? ''}`}>+{plural(slip, 'day')}</span>}</div>
      <p className="pf-hover-d">Due {dayMonth(p.due)} → Forecast {dayMonth(end)}</p>
      {reasons.length > 0 && <ul>{reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      {fix ? <p className="pf-hover-ai"><span className="pf-orb" aria-hidden="true" />{fix.title}{fix.finish ? ` lands it ${dayMonth(fix.finish)}.` : `: ${fix.effect}.`}</p>
        : slip <= 0 && <p className="pf-hover-ai"><span className="pf-orb" aria-hidden="true" />On course for its date.</p>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------ Present
type Reason = { label: string; text: string };
function labelled(causes: string[]): Reason[] {
  return causes.slice(0, 3).map((c, k) => {
    const w = c.toLowerCase();
    const label = /leave|split|people|person|owner|assign|carries|nobody/.test(w) ? 'People' : /wait|depend|block|sandbox|team|vendor|blocked/.test(w) ? 'Dependency'
      : /pace|week|items|tasks|finish|added|scope/.test(w) ? 'Pace' : 'Reason';
    return { label: `${String(k + 1).padStart(2, '0')} · ${label}`, text: /[.!?]$/.test(c) ? c : `${c}.` };
  });
}

function Slide({ item, filter, active }: { item: DecisionItem; filter: PortfolioFilter; active: boolean }) {
  const a = useDecisionActions(item, filter);
  const reasons = labelled(item.decision?.causes.length ? item.decision.causes.map(cap) : item.changes.length ? item.changes : [item.why]);
  const b = otherOptions(item.decision)[0];
  const tone = item.slipDays > 14 ? 'late' : 'risk';
  return (
    <section className={`pf-slide ${active ? 'on' : ''}`} aria-hidden={!active} aria-label={item.name}>
      <p className={`pf-slide-ey ${tone}`}>Decision · {item.slipDays > 0 ? `Late by ${plural(item.slipDays, 'day')}` : 'On the edge'}</p>
      <h2>{item.name}</h2>
      <p className="pf-slide-dates">Due <b>{dayMonth(item.due)}</b> <span aria-hidden="true">→</span> Forecast {item.forecast ? <span className={`fc ${tone}`}>{dayMonth(item.forecast)}</span> : <em>not yet</em>}</p>
      <div className="pf-slide-why">{reasons.map((r) => <div key={r.label}><span>{r.label}</span>{r.text}</div>)}</div>
      <div className="pf-opts">
        {a.done ? <p className="pf-opt-done" role="status">{a.done === 'accepted' ? '✓ New date set. The team was told.' : '✓ Proposed for approval.'}</p> : <>
          {item.acceptOpt && item.forecast && (
            <button type="button" className="pf-opt" tabIndex={active ? 0 : -1} disabled={!a.canAct || a.busy !== null} onClick={() => void a.accept()}>
              <small>Option A</small><b>{a.busy === 'accept' ? 'Accepting…' : `Accept ${dayMonth(item.forecast)}`}</b><span>{item.acceptOpt.effect || 'No new people · tell the team'}</span>
            </button>
          )}
          {b && (
            <button type="button" className="pf-opt rec" tabIndex={active ? 0 : -1} disabled={!a.canAct || a.busy !== null || a.waiting > 0} onClick={() => void a.propose(b.id)}>
              <small>{item.acceptOpt ? 'Option B' : 'Option A'} · recommended</small><b>{a.busy === b.id ? 'Proposing…' : b.title}</b><span>{b.effect}</span>
            </button>
          )}
          {!item.acceptOpt && !b && <Link className="pf-opt" tabIndex={active ? 0 : -1} to={`/work/projects/${item.projectId}`}><small>Next step</small><b>Open the project</b><span>No forecast to decide on yet</span></Link>}
        </>}
      </div>
    </section>
  );
}

function Overview({ brief, n, active }: { brief: PortfolioBrief; n: number; active: boolean }) {
  return (
    <section className={`pf-slide ${active ? 'on' : ''}`} aria-hidden={!active} aria-label="Overview">
      <p className="pf-slide-ey ok">Portfolio · {plural(brief.projects, 'project')}</p>
      <h2>{n === 0 ? 'No decisions this week' : `${plural(n, 'decision')} this week`}</h2>
      <p className="pf-slide-dates"><b>{brief.onTrack}</b> on track · <b>{brief.atRisk}</b> at risk · <span className="fc late">{brief.delayed} late</span></p>
      {brief.headlines.length > 0 && <div className="pf-slide-why">{brief.headlines.slice(0, 3).map((h, k) => <div key={h}><span>{String(k + 1).padStart(2, '0')}</span>{h}</div>)}</div>}
    </section>
  );
}

const clock = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** Present: full window, dark, one decision per slide (Overview first), a presenter strip with thumbnails, notes and the elapsed time. ← → / space, Esc. */
export function PresentOverlay({ items, filter, brief, asOf, onClose }: { items: DecisionItem[]; filter: PortfolioFilter; brief: PortfolioBrief; asOf: string | null; onClose: () => void }) {
  const [i, setI] = useState(0);
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const who = useAuth((s) => s.ctx?.user.displayName);
  const role = useAuth((s) => s.ctx?.current?.role);
  const n = items.length + 1;
  const go = useCallback((d: number) => setI((v) => Math.min(Math.max(0, v + d), n - 1)), [n]);
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);
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
  const cur = i === 0 ? null : items[i - 1];
  const note = cur ? cur.why : brief.headlines[0] ?? 'Every project in one view.';
  const week = isoWeek(asOf ? new Date(asOf) : new Date());
  return (
    <div className="pf-present" role="dialog" aria-modal="true" aria-label="Present decisions">
      <div className="pf-present-top">
        <b>Portfolio review · Week {week}</b>{who && <span>with {who}{role ? `, ${role}` : ''}</span>}
        <button type="button" className="pf-exit" onClick={onClose} autoFocus>Esc to exit</button>
      </div>
      <div className="pf-stage">
        <span className="pf-count" aria-live="polite"><b>{i + 1}</b> of {n}</span>
        <Overview brief={brief} n={items.length} active={i === 0} />
        {items.map((it, k) => <Slide key={it.projectId} item={it} filter={filter} active={k + 1 === i} />)}
      </div>
      <div className="pf-strip">
        <div className="pf-thumbs" role="tablist" aria-label="Slides">
          <button type="button" role="tab" aria-selected={i === 0} className={`pf-th ${i === 0 ? 'on' : ''}`} onClick={() => setI(0)}>1<b>Overview</b><i className="none" /></button>
          {items.map((it, k) => (
            <button key={it.projectId} type="button" role="tab" aria-selected={i === k + 1} className={`pf-th ${i === k + 1 ? 'on' : ''}`} onClick={() => setI(k + 1)}>
              {k + 2}<b>{it.name}</b><i className={it.slipDays > 14 ? 'late' : 'risk'} />
            </button>
          ))}
        </div>
        <p className="pf-notes"><b>Notes</b> · {note}</p>
        <div className="pf-clock" aria-label={`${clock(now - startedAt)} elapsed`}><b>{clock(now - startedAt)}</b><small>elapsed · {new Date(startedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} start</small></div>
      </div>
    </div>
  );
}
