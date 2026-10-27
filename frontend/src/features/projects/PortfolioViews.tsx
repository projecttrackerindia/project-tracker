import { Face } from '../../components/Face';
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { actionItemApi, chatApi, projectApi, statusApi } from '../../api/endpoints';
import { invalidateWorkspace } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { useWsQuery } from '../../lib/hooks';
import { useAuth } from '../../stores/auth';
import { portfolioApi, type DecisionOption, type PortfolioDecision, type PortfolioFilter, type TimelineProject } from './portfolioApi';
import { decisionTone, useDecisionActions, type DecisionItem } from './portfolioDecisions';
import { dayMonth } from './projectParts';
import { ProjectFacts } from './PortfolioFacts';
import { HealthSheet } from './ProjectHealth';
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
  // Late only because of sign-offs: every task is done, but stages are still unsigned. Then the move is asking for the sign-offs.
  const detail = useWsQuery(['project', item.projectId], () => projectApi.get(item.projectId), { staleTime: 60_000, retry: false });
  const pendingStages = (detail.data?.stages ?? []).filter((s) => s.effectiveStatus !== 'Completed');
  const pr = detail.data?.project;
  const signOnly = !!pr && pendingStages.length > 0 && pr.stats.total > 0 && (pr.progress >= 100 || pr.stats.total - pr.stats.cancelled <= pr.stats.done);
  const [asked, setAsked] = useState(false);
  const [asking, setAsking] = useState(false);
  const requestSignOffs = async () => {
    setAsking(true);
    try {
      const c = await chatApi.openProject(item.projectId);
      const who = (s: (typeof pendingStages)[number]) => s.owner?.name ?? s.assignee?.name ?? pr?.owner?.name ?? 'the owner';
      await chatApi.send(c.id, `All work on ${item.name} is done; it is late only on sign-offs. Please sign off:\n${pendingStages.map((s) => `• ${s.name} — ${who(s)}`).join('\n')}`);
      setAsked(true); toast(`Asked for ${plural(pendingStages.length, 'sign-off')} in ${item.key}’s chat.`, 'success');
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not request the sign-offs.', 'error'); }
    finally { setAsking(false); }
  };
  return (
    <article className={`pf-dec ${a.done ?? ''}`} data-project={item.key} aria-label={`${item.name}: due ${dayMonth(item.due)}, forecast ${item.forecast ? dayMonth(item.forecast) : 'none yet'}`}>
      <h4><Link to={`/work/projects/${item.projectId}`}>{item.name}</Link> <span className="pf-sr">{item.key} · {late}</span></h4>
      <p className="pf-dec-dates">
        Due <s>{dayMonth(item.due)}</s> → {item.forecast ? <>Forecast <b className={tone}>{dayMonth(item.forecast)}</b></> : <em title="Nothing in this project has been finished yet, so there is no pace to forecast from">No pace yet · nothing finished</em>}
        {owner && <> · <Face byName name={owner} className="pf-own-av" />{owner}</>}
      </p>
      <div className="pf-dec-acts">
        {a.done ? <span className="ds-pill success" role="status">{a.done === 'accepted' ? '✓ team told' : '✓ proposed'}</span> : <>
          {signOnly && <button type="button" className="pf-btn pri" data-testid="request-signoffs" disabled={asking || asked} title={pendingStages.map((s) => s.name).join(', ')} onClick={() => void requestSignOffs()}>{asked ? '✓ Sign-offs requested' : asking ? 'Requesting…' : `Request ${plural(pendingStages.length, 'sign-off')}`}</button>}
          {signOnly ? null : a.canAct
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
export function BoardColumns({ filter, brief, items = [] }: { filter: PortfolioFilter; brief: PortfolioBrief; items?: DecisionItem[] }) {
  const { projects } = useProjects(filter, brief);
  const ranked = new Map(brief.ranked.map((r) => [r.projectId, r]));
  const [all, setAll] = useState<Col | null>(null);
  // Drag a card to another column: the columns follow each project's dates and progress, so a drop opens what really moves it there —
  // agree the forecast as the new date (to On track), or flag the risk with an owner and a date (to At risk / Late).
  const [drag, setDrag] = useState<{ id: string; from: Col } | null>(null);
  const [over, setOver] = useState<Col | null>(null);
  const [drop, setDrop] = useState<{ p: TimelineProject; from: Col; to: Col } | null>(null);
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  return (
    <section className={`pf-board${drag ? ' dragging' : ''}`} aria-label="Board">
      {COLS.map((c) => {
        const list = projects.filter((p) => colOf(p.health) === c.id);
        const shown = all === c.id || list.length <= SHOWN + 1 ? list : list.slice(0, SHOWN);
        const more = list.length - shown.length;
        return (
          <div key={c.id} className={`pf-colwrap ${c.id}${over === c.id && drag?.from !== c.id ? ' over' : ''}`}
            onDragOver={(e) => { if (drag) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== c.id) setOver(c.id); } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}
            onDrop={(e) => { e.preventDefault(); const d = drag; setOver(null); setDrag(null); const p = d && projects.find((x) => x.id === d.id); if (p && d.from !== c.id) setDrop({ p, from: d.from, to: c.id }); }}>
            <h4 className="pf-col-head"><i />{c.label} <em>{list.length}</em></h4>
            <div className="pf-col">
              {list.length === 0 ? <p className="pf-empty">None</p> : shown.map((p) => {
                const r = ranked.get(p.id);
                const why = explain(p, r, c.id);
                const end = p.forecast ?? p.due;
                return (
                  <Link key={p.id} to={`/work/projects/${p.id}`} className={`pf-card${drag?.id === p.id ? ' lifted' : ''}`} title={why} aria-describedby={`pf-why-${p.id}`}
                    draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p.key); setDrag({ id: p.id, from: c.id }); }} onDragEnd={() => { setDrag(null); setOver(null); }}>
                    <span className="pf-card-t"><span className="pf-key" style={{ background: chipColour(p.key) }}>{p.key}</span><b className="pf-card-name">{p.name}</b></span>
                    <span className="pf-bar" aria-label={`${p.progress}% done`}><i style={{ width: `${Math.min(100, Math.max(0, p.progress))}%` }} /></span>
                    {flagged.has(p.id) && <span className="pf-flag">⚑ Flagged</span>}
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
      {drop && <DropSheet {...drop} item={items.find((i) => i.projectId === drop.p.id) ?? null} filter={filter} onClose={() => setDrop(null)} onFlagged={(id) => setFlagged((s) => new Set(s).add(id))} />}
    </section>
  );
}

const COL_NAME: Record<Col, string> = { ok: 'On track', risk: 'At risk', late: 'Late' };

/** What a drop means. To On track: agree the forecast as the new due date (or replan in the project). To At risk / Late: flag it. */
function DropSheet({ p, from, to, item, filter, onClose, onFlagged }: { p: TimelineProject; from: Col; to: Col; item: DecisionItem | null; filter: PortfolioFilter; onClose: () => void; onFlagged: (id: string) => void }) {
  const wid = useWorkspaceId();
  const navigate = useNavigate();
  const a = useDecisionActions(item ?? { projectId: p.id, key: p.key, name: p.name, due: p.due, forecast: p.forecast, why: '', slipDays: 0, decision: null, acceptOpt: null, changes: [] }, filter);
  const [reason, setReason] = useState('');
  const [due, setDue] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 3); return d.toISOString().slice(0, 10); });
  const [busy, setBusy] = useState(false);
  const [byHand, setByHand] = useState(false);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !byHand) onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose, byHand]);
  if (byHand) return <HealthSheet projectId={p.id} projectName={p.name} initial={to === 'ok' ? 'OnTrack' : to === 'risk' ? 'AtRisk' : 'Delayed'} onClose={onClose} />;
  const flag = async () => {
    if (!reason.trim()) return;
    setBusy(true);
    try {
      await actionItemApi.create(p.id, { title: `${to === 'late' ? 'Late' : 'Risk'}: ${reason.trim()}`.slice(0, 200), details: `Flagged from Portfolio (moved from ${COL_NAME[from]} to ${COL_NAME[to]}).`, dueDate: due || null, priority: to === 'late' ? 'Critical' : 'High' });
      for (const k of ['portfolio', 'projects', 'project']) void invalidateWorkspace(wid, k);
      onFlagged(p.id); toast(`${p.key} flagged. The follow-up is on the project.`, 'success'); onClose();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not flag it.', 'error'); }
    finally { setBusy(false); }
  };
  return createPortal(
    <div className="pf-drop-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="pf-drop" role="dialog" aria-modal="true" aria-label={`Move ${p.name} to ${COL_NAME[to]}`}>
        <p className="pf-drop-ey"><span className="pf-key" style={{ background: chipColour(p.key) }}>{p.key}</span> {COL_NAME[from]} → <b>{COL_NAME[to]}</b></p>
        <h3>{to === 'ok' ? `Bring ${p.name} back on track` : `Flag ${p.name} as ${COL_NAME[to].toLowerCase()}`}</h3>
        <p className="pf-drop-why">Columns follow each project’s dates and progress{p.due ? ` (due ${dayMonth(p.due)}${p.forecast ? `, forecast ${dayMonth(p.forecast)}` : ''})` : ''}, so moving a card does what really moves it.</p>
        {to === 'ok' ? (
          <div className="pf-drop-acts">
            {item?.acceptOpt && item.forecast && <button type="button" className="pf-btn pri" disabled={!a.canAct || a.busy !== null} onClick={() => void a.accept().then(onClose)}>{a.busy ? 'Setting…' : `Make ${dayMonth(item.forecast)} the new due date`}</button>}
            <button type="button" className="pf-btn" onClick={() => navigate(`/work/projects/${p.id}`)}>Replan in the project</button>
            <button type="button" className="pf-btn" onClick={() => setByHand(true)}>Set it on track by hand…</button>
            <button type="button" className="pf-btn" onClick={onClose}>Cancel</button>
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); void flag(); }} className="pf-drop-form">
            <label>What is the risk?<textarea autoFocus rows={3} maxLength={180} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Bank sandbox keys not shared; UAT cannot start" /></label>
            <label>Follow up by<input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
            <div className="pf-drop-acts"><button type="button" className="pf-btn" onClick={() => setByHand(true)}>Set status by hand…</button><button type="submit" className="pf-btn pri" disabled={busy || !reason.trim()}>{busy ? 'Flagging…' : 'Flag it'}</button><button type="button" className="pf-btn" onClick={onClose}>Cancel</button></div>
          </form>
        )}
      </section>
    </div>, document.body);
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
  const tone = decisionTone(item);
  const status = item.health === 'OnTrack' ? 'On track' : item.health === 'AtRisk' ? 'At risk' : item.health === 'Delayed' ? 'Late' : null;
  const lead = item.slipDays > 0 ? (tone === 'ok' ? `Forecast ${plural(item.slipDays, 'day')} past due` : `Late by ${plural(item.slipDays, 'day')}`) : 'On the edge';
  return (
    <section className={`pf-slide pf-slide-split ${active ? 'on' : ''}`} aria-hidden={!active} aria-label={item.name}>
      <div className="pf-slide-main">
      <p className={`pf-slide-ey ${tone}`}>Decision · {lead}{status && tone === 'ok' ? ` · ${status}` : ''}</p>
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
      </div>
      <ProjectFacts projectId={item.projectId} active={active} />
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

const HEALTH_WORD: Record<string, string> = { OnTrack: 'On track', AtRisk: 'At risk', Delayed: 'Late', 'On track': 'On track', 'At risk': 'At risk', Late: 'Late' };
const healthTone = (h: string) => (/delay|late/i.test(h) ? 'late' : /risk/i.test(h) ? 'risk' : 'ok');

/** The project's latest weekly report (the one Reports writes from its data) as a slide: health, the verdict, what moved, slipped and comes next. */
function WeeklySlide({ item, active, near }: { item: DecisionItem; active: boolean; near: boolean }) {
  const q = useWsQuery(['project-status', 'weekly', item.projectId], () => statusApi.weekly(item.projectId), { enabled: near, staleTime: 5 * 60_000, retry: false });
  const w = q.data;
  const cols: { label: string; n: number; items: { text: string }[] }[] = w ? [
    { label: 'Moved', n: w.moved, items: w.movedItems ?? [] }, { label: 'Slipped', n: w.slipped, items: w.slippedItems ?? [] }, { label: 'Next week', n: w.next, items: w.nextItems ?? [] },
  ] : [];
  const health = w ? HEALTH_WORD[w.health] ?? w.health : null;
  return (
    <section className={`pf-slide pf-wk ${active ? 'on' : ''}`} aria-hidden={!active} aria-label={`Weekly report: ${item.name}`}>
      <p className={`pf-slide-ey ${health ? healthTone(health) : 'ok'}`}>Weekly report{w?.week ? ` · Week ${w.week}` : ''}{health ? ` · ${health}` : ''}</p>
      <h2>{item.name}</h2>
      {q.isLoading ? <p className="pf-slide-dates">Reading the week…</p> : !w ? <p className="pf-slide-dates">No weekly report for this project.</p> : <>
        <p className="pf-slide-dates">{w.verdict || `${w.progress ?? 0}% done`}</p>
        <div className="pf-slide-why pf-wk-cols">
          {cols.map((c) => (
            <div key={c.label}><span>{c.label} · {c.n}</span>
              {c.items.length === 0 ? <em className="pf-wk-none">Nothing</em> : <ul>{c.items.slice(0, 3).map((x, k) => <li key={k}>{x.text}</li>)}</ul>}
            </div>
          ))}
        </div>
        <p className="pf-wk-foot">{dayMonth(w.from)} – {dayMonth(w.to)} · written from the project&rsquo;s data{w.risks > 0 ? ` · ${plural(w.risks, 'risk')}` : ''}</p>
      </>}
    </section>
  );
}

type PresentSlide = { kind: 'overview' } | { kind: 'decision'; item: DecisionItem } | { kind: 'weekly'; item: DecisionItem };

/**
 * Present: full window, dark, one decision per slide (Overview first), a presenter strip with thumbnails, notes and the elapsed time. ← → / space, Esc.
 * "Weekly reports" adds each project's latest weekly report as the slide after its decision.
 */
export function PresentOverlay({ items, filter, brief, asOf, onClose }: { items: DecisionItem[]; filter: PortfolioFilter; brief: PortfolioBrief; asOf: string | null; onClose: () => void }) {
  const [i, setI] = useState(0);
  const [weekly, setWeekly] = useState(false);
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const who = useAuth((s) => s.ctx?.user.displayName);
  const role = useAuth((s) => s.ctx?.current?.role);
  const slides = useMemo<PresentSlide[]>(() => [{ kind: 'overview' }, ...items.flatMap((item): PresentSlide[] => weekly ? [{ kind: 'decision', item }, { kind: 'weekly', item }] : [{ kind: 'decision', item }])], [items, weekly]);
  const n = slides.length;
  const go = useCallback((d: number) => setI((v) => Math.min(Math.max(0, v + d), n - 1)), [n]);
  const toggleWeekly = () => {
    // Stay on the same project's decision when the slides change around it.
    const at = slides[i];
    const next = !weekly;
    setWeekly(next);
    if (at.kind !== 'overview') { const k = items.indexOf(at.item); setI(next ? 1 + k * 2 : 1 + k); }
  };
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
  const cur = slides[Math.min(i, n - 1)];
  const note = cur.kind === 'decision' ? cur.item.why : cur.kind === 'weekly' ? `${cur.item.name}: the latest weekly report.` : brief.headlines[0] ?? 'Every project in one view.';
  const week = isoWeek(asOf ? new Date(asOf) : new Date());
  return (
    <div className="pf-present" role="dialog" aria-modal="true" aria-label="Present decisions">
      <div className="pf-present-top">
        <b>Portfolio review · Week {week}</b>{who && <span>with {who}{role ? `, ${role}` : ''}</span>}
        {items.length > 0 && <button type="button" className={`pf-wk-tg ${weekly ? 'on' : ''}`} aria-pressed={weekly} onClick={toggleWeekly}>{weekly ? '✓ ' : '+ '}Weekly reports</button>}
        <button type="button" className="pf-exit" onClick={onClose} autoFocus>Esc to exit</button>
      </div>
      <div className="pf-stage">
        <span className="pf-count" aria-live="polite"><b>{i + 1}</b> of {n}</span>
        {slides.map((sl, k) => sl.kind === 'overview' ? <Overview key="overview" brief={brief} n={items.length} active={i === k} />
          : sl.kind === 'decision' ? <Slide key={sl.item.projectId} item={sl.item} filter={filter} active={i === k} />
          : <WeeklySlide key={`wk-${sl.item.projectId}`} item={sl.item} active={i === k} near={Math.abs(i - k) <= 2} />)}
      </div>
      <div className="pf-strip">
        <div className="pf-thumbs" role="tablist" aria-label="Slides">
          {slides.map((sl, k) => (
            <button key={sl.kind === 'overview' ? 'overview' : `${sl.kind}-${sl.item.projectId}`} type="button" role="tab" aria-selected={i === k} className={`pf-th ${i === k ? 'on' : ''} ${sl.kind === 'weekly' ? 'wk' : ''}`} onClick={() => setI(k)}>
              {k + 1}<b>{sl.kind === 'overview' ? 'Overview' : sl.kind === 'weekly' ? `Weekly · ${sl.item.name}` : sl.item.name}</b><i className={sl.kind === 'overview' ? 'none' : decisionTone(sl.item)} />
            </button>
          ))}
        </div>
        <p className="pf-notes"><b>Notes</b> · {note}</p>
        <div className="pf-clock" aria-label={`${clock(now - startedAt)} elapsed`}><b>{clock(now - startedAt)}</b><small>elapsed · {new Date(startedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} start</small></div>
      </div>
    </div>
  );
}
