import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import './portfolio.css';
import { formatDate } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { portfolioApi, type PortfolioBoard, type PortfolioCapacity, type PortfolioFilter, type PortfolioMoney, type TimelineProject } from './portfolioApi';

/** The parts of the portfolio board that Projects › Portfolio shows: filters, money, capacity and the roadmap. */
const money = (v: number | null | undefined, currency: string) => v == null ? '—' : `${Math.round(v).toLocaleString('en-IN')} ${currency}`;
const hours = (minutes: number) => `${Math.round(minutes / 60)} h`;

/** How many board filters are set (the "Filters · n" pill). */
export const filterCount = (f: PortfolioFilter) => [f.ownerId, f.groupId, f.health, f.dueFrom || f.dueTo].filter(Boolean).length;

/** Owner, group, health and due-date filters for the board (kept in the address so a filtered board can be shared). Opened from "Filters · n". */
export function PortfolioFilters({ board, filter, onChange }: { board: PortfolioBoard; filter: PortfolioFilter; onChange: (f: PortfolioFilter) => void }) {
  const set = (k: keyof PortfolioFilter, v: string) => onChange({ ...filter, [k]: v || null });
  const any = filterCount(filter) > 0;
  return (
    <div className="pb-filters" role="group" aria-label="Filters">
      <span className="pb-pick"><Select className="select" value={filter.ownerId ?? ''} aria-label="Owner" onChange={(e) => set('ownerId', e.target.value)}>
        <option value="">Every owner</option>{board.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </Select></span>
      <span className="pb-pick"><Select className="select" value={filter.groupId ?? ''} aria-label="Group" onChange={(e) => set('groupId', e.target.value)}>
        <option value="">Every group</option>{board.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
      </Select></span>
      <span className="pb-pick"><Select className="select" value={filter.health ?? ''} aria-label="Health" onChange={(e) => set('health', e.target.value)}>
        <option value="">Any health</option><option value="OnTrack">On track</option><option value="AtRisk">At risk</option><option value="Delayed">Delayed</option>
      </Select></span>
      <label className="pb-date">Due from <input className="input" type="date" value={filter.dueFrom ?? ''} onChange={(e) => set('dueFrom', e.target.value)} /></label>
      <label className="pb-date">to <input className="input" type="date" value={filter.dueTo ?? ''} onChange={(e) => set('dueTo', e.target.value)} /></label>
      {any && <button type="button" className="link-btn" onClick={() => onChange({ teamId: filter.teamId })}>Clear filters</button>}
    </div>
  );
}

/** Money: budget against cost from the timesheet, burn by month and the forecast at completion, with a warning when it overruns. */
export function MoneySection({ m }: { m: PortfolioMoney }) {
  if (!m.entitled || !m.showMoney) return m.notes.length ? <section className="pb-money" aria-label="Money"><h3>Money</h3><p className="muted">{m.notes[0]}</p></section> : null;
  const max = Math.max(1, ...m.burn.map((b) => b.cost));
  return (
    <section className="pb-money" aria-label="Money">
      <h3>Money <em>{m.currency}</em></h3>
      <div className="pi-kpis">
        <div className="pi-kpi"><label>Budget</label><b>{money(m.budget, '')}</b></div>
        <div className="pi-kpi"><label>Spent</label><b>{money(m.spent, '')}</b></div>
        <div className="pi-kpi"><label>Forecast at completion</label><b className={m.forecast > m.budget && m.budget > 0 ? 'bad' : ''}>{money(m.forecast, '')}</b></div>
        <div className="pi-kpi"><label>Forecast to overrun</label><b className={m.overrunning ? 'bad' : 'ok'}>{m.overrunning}</b></div>
      </div>
      <div className="pb-burn" role="img" aria-label="Cost by month">
        {m.burn.map((b) => <div key={b.month} title={`${b.month}: ${money(b.cost, m.currency)}`}><i style={{ height: `${(b.cost / max) * 100}%` }} /><span>{b.month.slice(0, 3)}</span></div>)}
      </div>
      {m.projects.length > 0 && (
        <table className="ops-table-narrow pb-money-table">
          <thead><tr><th>Project</th><th>Budget</th><th>Spent</th><th>Forecast</th><th aria-label="Used" /></tr></thead>
          <tbody>
            {m.projects.map((p) => (
              <tr key={p.projectId} className={p.warning ? 'warn' : ''}>
                <td><b>{p.key}</b> {p.name}{p.warning && <div className="pb-warn"><Icon name="alert" size={12} /> {p.warning}</div>}</td>
                <td>{money(p.budget, '')}</td><td>{money(p.spent, '')}</td><td title={p.basis}>{money(p.forecast, '')}</td>
                <td className="pb-used">{p.budget ? <span className="pb-meter"><i className={(p.forecast ?? 0) > p.budget ? 'over' : ''} style={{ width: `${Math.min(100, (p.spent / p.budget) * 100)}%` }} /></span> : <span className="muted">no budget</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {m.notes.map((n) => <p key={n} className="muted pb-note">{n}</p>)}
    </section>
  );
}

/** Capacity: who is over 100% in the next four weeks across all projects, and which projects that puts at risk. */
export function CapacitySection({ c }: { c: PortfolioCapacity }) {
  const loadClass = (l: number | null) => (l == null ? '' : l > 120 ? 'bad' : l > 100 ? 'warn' : l > 80 ? 'full' : 'ok');
  return (
    <section className="pb-capacity" aria-label="Capacity">
      <h3>Capacity, {formatDate(c.from)} to {formatDate(c.to)} <em>{c.over.length} over 100%</em></h3>
      {c.over.length === 0 ? <p className="ps-ok"><Icon name="checkCircle" size={14} /> Nobody is over 100% in the next 4 weeks ({c.people} people with dated work).</p> : (
        <div className="pb-cap-grid" role="table" aria-label="Load by week">
          <div className="pb-cap-row head" role="row"><span role="columnheader">Person</span>{c.over[0].weeks.map((w) => <span key={w.weekStart} role="columnheader">Week of {formatDate(w.weekStart)}</span>)}<span role="columnheader">Projects</span></div>
          {c.over.map((p) => (
            <div key={p.userId} className="pb-cap-row" role="row">
              <span role="cell"><b>{p.name}</b>{p.leaveDays > 0 && <small> · {p.leaveDays} day{p.leaveDays === 1 ? '' : 's'} leave</small>}</span>
              {p.weeks.map((w) => {
                // No time that week (on leave, or the week is over) but work landing in it: say so, not a percentage of nothing.
                const noTime = w.capacityMinutes === 0 && w.demandMinutes > 0;
                return <span key={w.weekStart} role="cell" className={`pb-load ${noTime ? 'bad' : loadClass(w.load)}`} title={`${hours(w.demandMinutes)} of work, ${hours(w.capacityMinutes)} available`}>{noTime ? `${hours(w.demandMinutes)}, no time` : w.load == null ? '—' : `${w.load}%`}</span>;
              })}
              <span role="cell" className="pb-cap-projects">{p.projects.map((x) => x.key).join(', ')}</span>
            </div>
          ))}
        </div>
      )}
      {c.projectsAtRisk.length > 0 && <p className="pb-note"><b>Projects at risk:</b> {c.projectsAtRisk.map((p) => `${p.key} (${p.tasks} task${p.tasks === 1 ? '' : 's'}, ${hours(p.minutes)})`).join(' · ')}</p>}
      {c.notes.map((n) => <p key={n} className="muted pb-note">{n}</p>)}
    </section>
  );
}

const dayMs = 86_400_000;
const at = (d: string) => new Date(d + 'T00:00:00Z').getTime();

/** Every project on one roadmap: planned span, milestones, dependencies, and slipped dates as ghosts (the original due date and the forecast). */
export function TimelineView({ filter, onPick }: { filter: PortfolioFilter; onPick: (id: string) => void }) {
  const q = useWsQuery(['portfolio', 'timeline', filter], () => portfolioApi.timeline(filter), { placeholderData: (p) => p });
  if (q.isLoading) return <p className="muted" role="status">Loading the timeline…</p>;
  const t = q.data;
  if (!t || t.projects.length === 0) return <p className="muted">No projects match.</p>;
  const from = at(t.from) - 7 * dayMs, to = at(t.to) + 7 * dayMs, span = Math.max(dayMs, to - from);
  const x = (d: string) => `${((at(d) - from) / span) * 100}%`;
  const today = new Date(); const todayIso = today.toISOString().slice(0, 10);
  const months: string[] = [];
  for (let d = new Date(from); d.getTime() < to; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10));
  const names = Object.fromEntries(t.projects.map((p) => [p.id, p.key]));
  const bar = (p: TimelineProject) => {
    const s = p.start ?? p.due; const e = p.due ?? p.start;
    if (!s || !e) return null;
    return <i className={`tl-bar ${p.health}`} style={{ left: x(s), width: `calc(${x(e)} - ${x(s)} + 4px)` }}><b style={{ width: `${p.progress}%` }} /></i>;
  };
  return (
    <section className="pb-timeline" aria-label="Timeline">
      <div className="tl-scale">{months.filter((m) => at(m) >= from).map((m) => <span key={m} style={{ left: x(m) }}>{new Date(m).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}</span>)}</div>
      <div className="tl-rows">
        <div className="tl-overlay" aria-hidden="true"><i className="tl-today" style={{ left: x(todayIso) }} title="Today" /></div>
        {t.projects.map((p) => (
          <div key={p.id} className="tl-row">
            <button type="button" className="tl-name" onClick={() => onPick(p.id)} title={`${p.name}${p.group ? ` · ${p.group}` : ''}`}>
              <b>{p.key}</b> {p.name}{p.dependsOn.length > 0 && <small className="tl-deps" title="Waits on work in">↳ {p.dependsOn.map((d) => names[d] ?? '?').join(', ')}</small>}
            </button>
            <div className="tl-track" aria-label={`${p.key}: ${p.start ? formatDate(p.start) : 'no start'} to ${p.due ? formatDate(p.due) : 'no due date'}${p.forecast ? `, likely ${formatDate(p.forecast)}` : ''}`}>
              {bar(p)}
              {p.originalDue && <i className="tl-ghost" style={{ left: x(p.originalDue) }} title={`Originally due ${formatDate(p.originalDue)}`} />}
              {p.forecast && p.due && p.forecast > p.due && <i className="tl-slip" style={{ left: x(p.due), width: `calc(${x(p.forecast)} - ${x(p.due)})` }} title={`Likely to finish ${formatDate(p.forecast)}`} />}
              {p.milestones.filter((m) => m.due).map((m) => <i key={m.id} className={`tl-ms ${m.status}`} style={{ left: x(m.due!) }} title={`${m.name}: ${formatDate(m.due!)} (${m.status})`} />)}
            </div>
          </div>
        ))}
      </div>
      <div className="tl-legend"><span><i className="tl-bar OnTrack" /> planned</span><span><i className="tl-slip" /> likely slip</span><span><i className="tl-ghost" /> original due date</span><span><i className="tl-ms Pending" /> milestone</span></div>
    </section>
  );
}
