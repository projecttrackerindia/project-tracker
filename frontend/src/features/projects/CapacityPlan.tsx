import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../stores/auth';
import { resourcesApi } from '../../api/endpoints';
import type { CapacityPlan, CapacityPlanCell, WorkloadScope } from '../../api/types';
import { Avatar, EmptyState, ErrorState, Modal } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { useRebalance } from '../insights/rebalance';
import { isoWeek } from './PortfolioViews';
import { PortfolioSkeleton, usePortfolio, useShellLine, useShellMenu } from './PortfolioShell';
import { AuraLine } from '../../components/calm';
import { portfolioKeys } from './portfolioShared';
import { PulseCard } from './PortfolioPulse';
import './capacityPlan.css';

type Unit = 'hours' | 'pct';
const SCOPE_LABEL: Record<WorkloadScope, string> = { Reports: 'My reports', Everyone: 'Everyone', Me: 'Just me' };
const h = (m: number) => Math.round(m / 60);
const fmtH = (m: number) => `${h(m).toLocaleString()}h`;
const day = (iso: string) => new Date(`${iso}T00:00:00`);
const short = (iso: string) => day(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const wk = (iso: string) => `Wk ${isoWeek(day(iso))}`;

/** One cell: booked against capacity, a fill bar, red when over, striped when the whole week is leave, amber when light. */
function Cell({ c, unit }: { c: CapacityPlanCell; unit: Unit }) {
  if (c.onLeave) return <div className="cp-cell leave" title={`On leave ${c.leaveDays} day${c.leaveDays === 1 ? '' : 's'}`}>Leave</div>;
  const ratio = c.capacityMinutes > 0 ? c.bookedMinutes / c.capacityMinutes : c.bookedMinutes > 0 ? 2 : 0;
  const tone = c.over ? 'over' : c.capacityMinutes > 0 && ratio < 0.65 ? 'lo' : '';
  // The calm heat (design shot 15): red when over, amber near full, green in the healthy band, pale blue with room.
  const heat = ratio > 1.05 ? 'h-over' : ratio >= 0.95 ? 'h-full' : ratio >= 0.7 ? 'h-ok' : 'h-room';
  const hol = c.holidayDays ?? 0;
  const label = `${fmtH(c.bookedMinutes)} booked of ${fmtH(c.capacityMinutes)}${c.leaveDays ? `, ${c.leaveDays} day${c.leaveDays === 1 ? '' : 's'} leave` : ''}${hol ? `, ${hol} public holiday${hol === 1 ? '' : 's'}` : ''}`;
  return (
    <div className={`cp-cell ${tone} ${heat}`} title={label} aria-label={label}>
      {unit === 'hours'
        ? <><b>{h(c.bookedMinutes)}</b><span> / {h(c.capacityMinutes)}h</span></>
        : <><b>{Math.round(ratio * 100)}%</b><span className="cp-sub"> of {h(c.capacityMinutes)}h</span></>}
      {c.leaveDays > 0 && <em className="cp-leave-dot" aria-hidden="true" />}
      {hol > 0 && <em className="cp-hol-dot" aria-hidden="true" />}
      <i style={{ ['--w' as string]: `${Math.min(100, ratio * 100)}%` }} />
    </div>
  );
}

/**
 * Portfolio › Capacity (design s-capacity): six weeks ahead, person × week. Capacity is weekly hours less planned leave; booked is the remaining
 * estimate of open tasks spread over their dates. A ✦ card names the tasks to move from the most over-booked person to whoever has room
 * (Preview lists them; Rebalance starts the AI workload review). Footer: team totals.
 */
export function CapacityPlanView() {
  const navigate = useNavigate();
  const [unit, setUnit] = useState<Unit>('hours');
  const [scope, setScope] = useState<WorkloadScope | undefined>(undefined);
  const [preview, setPreview] = useState(false);
  const canHolidays = useAuth((x) => x.ctx?.current?.role === 'Owner' || x.ctx?.current?.role === 'Admin');
  const q = useWsQuery(portfolioKeys.capacity(scope ?? ''), () => resourcesApi.plan({ weeks: 6, scope }), { staleTime: 60_000, placeholderData: (p) => p });
  // The shell's field on Capacity: owners are the people, a project (token or folder tab) or a colour keeps the people with work in it, text their names.
  const { active, work, me, colourOf, url } = usePortfolio();
  const ownerIds = active.filter((t) => t.kind === 'owner').map((t) => (t.value === 'me' ? me : t.value));
  const projIds = active.filter((t) => t.kind === 'project').map((t) => t.value);
  const words = active.filter((t) => t.kind === 'text').map((t) => t.value.toLowerCase());
  const shows = (userId: string, name: string) => (!ownerIds.length || ownerIds.includes(userId))
    && (!projIds.length || work.some((r) => r.ownerId === userId && projIds.includes(r.projectId)))
    && (!url.colours.length || work.some((r) => r.ownerId === userId && url.colours.includes(colourOf(r.projectId))))
    && words.every((w) => name.toLowerCase().includes(w));
  const { busy, rebalance } = useRebalance((job) => navigate(`/insights?tab=reports&job=${encodeURIComponent(job)}`));
  const loadOf = (person: { weeks: CapacityPlanCell[] }) => { const cap = person.weeks.reduce((a, c) => a + c.capacityMinutes, 0); const b = person.weeks.reduce((a, c) => a + c.bookedMinutes, 0); return cap > 0 ? Math.round((b / cap) * 100) : null; };
  const ppl = q.data?.people ?? [];
  const ranked = ppl.map((x) => ({ n: x.name.split(' ')[0], l: loadOf(x) })).filter((x): x is { n: string; l: number } => x.l != null).sort((a, b) => b.l - a.l);
  const over = ranked[0] && ranked[0].l > 100 ? ranked[0] : null, room = ranked.length > 1 && ranked[ranked.length - 1]!.l < 75 ? ranked[ranked.length - 1] : null;
  // The calm Capacity (demo shot 15): no tool bar; whose capacity and hours / % are in ⋯.
  useShellMenu([
    ...((q.data?.available ?? []).length > 1 ? (q.data?.available ?? []).map((x) => ({ label: `Show ${SCOPE_LABEL[x].toLowerCase()}`, icon: 'users' as const, hint: x === q.data?.scope ? 'Shown now' : undefined, onSelect: () => setScope(x) })) : []),
    { label: unit === 'hours' ? 'Show as % of capacity' : 'Show in hours', icon: 'gauge' as const, onSelect: () => setUnit(unit === 'hours' ? 'pct' : 'hours') },
  ]);
  useShellLine(q.data ? over && room ? `${over.n} is over, ${room.n} has room.` : over ? `${over.n} is over.` : room ? `${room.n} has room.` : 'Everyone is in the healthy band.' : null);

  if (q.isLoading) return <PortfolioSkeleton label="Loading capacity" />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const p: CapacityPlan = { ...q.data, people: q.data.people.filter((x) => shows(x.userId, x.name)) };
  if (!p.entitled) return <div className="card"><div className="card-body"><EmptyState icon="gauge" title="Capacity planning comes with the Business plan" text="See each person's booked work against their capacity for the weeks ahead, with leave taken into account." /></div></div>;

  const s = p.suggestion;
  const holidayWeeks = p.weekStarts.filter((_, i) => (p.people[0]?.weeks[i]?.holidayDays ?? 0) > 0).map(wk);
  const t = p.totals;
  const weeksTxt = (a: string, b: string) => a === b ? `week ${isoWeek(day(a))}` : `weeks ${isoWeek(day(a))}–${isoWeek(day(b))}`;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

  return (
    <section className="cp" aria-label="Capacity">
      <div className="cp-head">
        <div className="cp-eyebrow">{SCOPE_LABEL[p.scope]} · {p.people.length === 1 ? '1 person' : `${p.people.length} people`}</div>
        <ul className="cp-legend" aria-label="Legend">
          <li><i className="cap" />Capacity</li><li><i className="booked" />Booked</li><li><i className="over" />Over-booked</li><li><i className="leave" />Leave</li>
        </ul>

      </div>

      <div className="card cp-card">
        {p.people.length === 0 ? <EmptyState icon="users" title="Nobody to show" /> : (
          <div className="cp-grid" role="table" aria-label="Capacity by person and week" style={{ ['--n' as string]: p.weekStarts.length }}>
            <div className="cp-row cp-th" role="row">
              <div className="cp-who" role="columnheader">Person</div>
              {p.weekStarts.map((w, i) => <div key={w} role="columnheader">{wk(w)}<small>{short(w)}{(p.people[0]?.weeks[i]?.holidayDays ?? 0) > 0 && <span className="cp-hol" title="Public holiday this week"> · holiday</span>}</small></div>)}
              <div role="columnheader" className="cp-load">Load</div>
            </div>
            {p.people.map((person) => (
              <div className="cp-row" role="row" key={person.userId}>
                <div className="cp-who" role="rowheader">
                  <Avatar name={person.name} userId={person.userId} />
                  <div><b>{person.name}</b><small>{h(person.weeklyCapacityMinutes)}h a week</small></div>
                </div>
                {person.weeks.map((c) => <div role="cell" key={c.weekStart}><Cell c={c} unit={unit} /></div>)}
                {(() => { const l = loadOf(person); return <div role="cell" className={`cp-load ${l != null && l > 100 ? 'hot' : ''}`}>{l == null ? '—' : `${l}%`}</div>; })()}
              </div>
            ))}
          </div>
        )}
      </div>

      {s && <AuraLine className="cp-aura" text={<>{s.fromName} is {fmtH(s.overMinutes)} over in {weeksTxt(s.firstWeek, s.lastWeek)}. {s.toName} has {fmtH(s.freeMinutes)} free.</>}
        action={busy ? 'Working…' : `Rebalance ${plural(s.tasks.length, 'task')}`} onAction={() => setPreview(true)} />}

      <div className="cp-foot">
        <span>Team total · {p.weeks} weeks: <b>{fmtH(t.bookedMinutes)} booked / {fmtH(t.capacityMinutes)} available</b>{t.booked !== null && ` (${Math.round(t.booked * 100)}%)`}</span>
        <span>{plural(t.overWeeks, 'over-booked week')} · {plural(t.leaveWeeks, 'leave week')} · {plural(t.publicHolidays, 'public holiday')}{holidayWeeks.length > 0 && ` (${holidayWeeks.join(', ')})`}{canHolidays && <> · <Link className="link" to="/settings/general/holidays">Holidays ›</Link></>}</span>
      </div>

      {/* The pulse below the grid is not in the calm design; the same numbers are the foot line and the Aura sentence. */}

      {preview && s && (
        <Modal title="Suggested move" size="sm" onClose={() => setPreview(false)}
          footer={<><button type="button" className="btn" onClick={() => setPreview(false)}>Not now</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => { setPreview(false); void rebalance(); }}>Rebalance</button></>}>
          <p className="cp-sheet-lead">From <b>{s.fromName}</b> to <b>{s.toName}</b> in {weeksTxt(s.firstWeek, s.lastWeek)}. Due dates stay as they are.</p>
          <ul className="cp-sheet-list">
            {s.tasks.map((x) => <li key={x.id}><span>{x.title}</span><em>{fmtH(x.minutes)}{x.dueDate ? ` · due ${short(x.dueDate)}` : ''}</em></li>)}
          </ul>
        </Modal>
      )}
    </section>
  );
}

/** Under the grid, the room it leaves: the team's load week by week, who is most booked, and who has room to take work. */
export function CapacityPulse({ p }: { p: CapacityPlan }) {
  const weeks = p.weekStarts.map((w, i) => {
    const booked = p.people.reduce((a, x) => a + (x.weeks[i]?.bookedMinutes ?? 0), 0), cap = p.people.reduce((a, x) => a + (x.weeks[i]?.capacityMinutes ?? 0), 0);
    return { w, pct: cap > 0 ? Math.round((booked / cap) * 100) : 0 };
  });
  const top = Math.max(100, ...weeks.map((x) => x.pct));
  const ratio = (c: CapacityPlanCell) => (c.capacityMinutes > 0 ? c.bookedMinutes / c.capacityMinutes : 0);
  const busiest = p.people.map((x) => { const i = x.weeks.reduce((b, c, k) => (ratio(c) > ratio(x.weeks[b]!) ? k : b), 0); return { x, pct: Math.round(ratio(x.weeks[i]!) * 100), wk: x.weeks[i]?.weekStart }; })
    .sort((a, b) => b.pct - a.pct).slice(0, 4);
  const room = p.people.map((x) => ({ x, free: x.weeks.slice(0, 2).reduce((a, c) => a + Math.max(0, c.capacityMinutes - c.bookedMinutes), 0) }))
    .filter((r) => r.free >= 60).sort((a, b) => b.free - a.free).slice(0, 4);
  const two = p.weekStarts.length > 1 ? `${wk(p.weekStarts[0]!)}–${isoWeek(day(p.weekStarts[1]!))}` : wk(p.weekStarts[0] ?? p.from);
  return (
    <div className="pfp cp-pulse">
      <PulseCard title="Team load by week" meta={`${p.people.length === 1 ? '1 person' : `${p.people.length} people`}`}>
        <div className="pfp-chart" role="img" aria-label={weeks.map((x) => `${wk(x.w)} ${x.pct}%`).join(', ')}>
          {weeks.map((x) => (
            <div key={x.w} className="pfp-col">
              <span className="pfp-track cp-track" style={{ ['--cap' as string]: `${(100 / top) * 100}%` }}>
                <span className="pfp-bar" style={{ height: `${(x.pct / top) * 100}%` }}><span className="pfp-n">{x.pct}%</span><i className={x.pct > 100 ? 'cp-over' : 'cp-ok'} /></span>
              </span>
              <small>{wk(x.w)}</small>
            </div>
          ))}
        </div>
      </PulseCard>
      <PulseCard title="Most booked" meta="peak week">
        <ul className="pfp-list">
          {busiest.map(({ x, pct, wk: w }) => (
            <li key={x.userId}>
              <Avatar name={x.name} userId={x.userId} size="sm" />
              <span className="pfp-name">{x.name}</span>
              <span className={`pfp-st ${pct > 100 ? 'late' : ''}`}>{pct}%</span>
              <span className="pfp-what">{w ? wk(w) : ''}</span>
            </li>
          ))}
        </ul>
      </PulseCard>
      <PulseCard title="Room to take work" meta={two}>
        {room.length === 0 ? <p className="pfp-calm">Nobody has spare hours in the next two weeks.</p> : (
          <ul className="pfp-list">
            {room.map(({ x, free }) => (
              <li key={x.userId}>
                <Avatar name={x.name} userId={x.userId} size="sm" />
                <span className="pfp-name">{x.name}</span>
                <span className="pfp-what"><b className="cp-free">{fmtH(free)}</b> free</span>
              </li>
            ))}
          </ul>
        )}
      </PulseCard>
    </div>
  );
}
