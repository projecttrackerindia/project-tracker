import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { resourcesApi } from '../../api/endpoints';
import type { CapacityPlan, CapacityPlanCell, WorkloadScope } from '../../api/types';
import { Avatar, EmptyState, ErrorState, Modal, PageLoader, Segmented } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { useRebalance } from '../insights/InsightsPage';
import { isoWeek } from './PortfolioViews';
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
  const label = `${fmtH(c.bookedMinutes)} booked of ${fmtH(c.capacityMinutes)}${c.leaveDays ? `, ${c.leaveDays} day${c.leaveDays === 1 ? '' : 's'} leave` : ''}`;
  return (
    <div className={`cp-cell ${tone}`} title={label} aria-label={label}>
      {unit === 'hours'
        ? <><b>{h(c.bookedMinutes)}</b><span> / {h(c.capacityMinutes)}h</span></>
        : <><b>{Math.round(ratio * 100)}%</b><span className="cp-sub"> of {h(c.capacityMinutes)}h</span></>}
      {c.leaveDays > 0 && <em className="cp-leave-dot" aria-hidden="true" />}
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
  const q = useWsQuery(['capacity', 'plan', scope ?? ''], () => resourcesApi.plan({ weeks: 6, scope }), { staleTime: 60_000, placeholderData: (p) => p });
  const { busy, rebalance } = useRebalance((job) => navigate(`/insights?tab=reports&job=${encodeURIComponent(job)}`));

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const p: CapacityPlan = q.data;
  if (!p.entitled) return <div className="card"><div className="card-body"><EmptyState icon="gauge" title="Capacity planning comes with the Business plan" text="See each person's booked work against their capacity for the weeks ahead, with leave taken into account." /></div></div>;

  const s = p.suggestion;
  const t = p.totals;
  const weeksTxt = (a: string, b: string) => a === b ? `week ${isoWeek(day(a))}` : `weeks ${isoWeek(day(a))}–${isoWeek(day(b))}`;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

  return (
    <section className="cp" aria-label="Capacity">
      <div className="cp-head">
        <div className="cp-eyebrow">{SCOPE_LABEL[p.scope]} · {p.people.length === 1 ? '1 person' : `${p.people.length} people`}</div>
        <div className="cp-tools">
          <ul className="cp-legend" aria-label="Legend">
            <li><i className="cap" />Capacity</li><li><i className="booked" />Booked</li><li><i className="over" />Over-booked</li><li><i className="leave" />Leave</li>
          </ul>
          {p.available.length > 1 && <Segmented<WorkloadScope> label="Whose capacity" value={p.scope} onChange={setScope} options={p.available.map((x) => ({ id: x, label: SCOPE_LABEL[x] }))} />}
          <Segmented<Unit> label="Show as" value={unit} onChange={setUnit} options={[{ id: 'hours', label: 'Hours' }, { id: 'pct', label: '%' }]} />
        </div>
      </div>

      {s && (
        <div className="v2-ai-card cp-ai" role="note">
          <span className="v2-spark" aria-hidden="true">✦</span>
          <div className="v2-ai-card-main"><span>
            <b>{s.fromName} is {fmtH(s.overMinutes)} over in {weeksTxt(s.firstWeek, s.lastWeek)} while {s.toName} has {fmtH(s.freeMinutes)} free.</b>{' '}
            Move {s.tasks.map((x, i) => <span key={x.id}>{i > 0 && (i === s.tasks.length - 1 ? ' and ' : ', ')}“{x.title}” ({fmtH(x.minutes)})</span>)} to {s.toName} — no dates change.
          </span></div>
          <div className="cp-ai-acts">
            <button type="button" className="btn btn-sm" onClick={() => setPreview(true)}>Preview</button>
            <button type="button" className="btn btn-sm btn-ai" disabled={busy} onClick={() => void rebalance()}>{busy ? 'Working…' : 'Rebalance'}</button>
          </div>
        </div>
      )}

      <div className="card cp-card">
        {p.people.length === 0 ? <EmptyState icon="users" title="Nobody to show" /> : (
          <div className="cp-grid" role="table" aria-label="Capacity by person and week" style={{ ['--n' as string]: p.weekStarts.length }}>
            <div className="cp-row cp-th" role="row">
              <div className="cp-who" role="columnheader">Person</div>
              {p.weekStarts.map((w) => <div key={w} role="columnheader">{wk(w)}<small>{short(w)}</small></div>)}
            </div>
            {p.people.map((person) => (
              <div className="cp-row" role="row" key={person.userId}>
                <div className="cp-who" role="rowheader">
                  <Avatar name={person.name} userId={person.userId} />
                  <div><b>{person.name}</b><small>{h(person.weeklyCapacityMinutes)}h a week</small></div>
                </div>
                {person.weeks.map((c) => <div role="cell" key={c.weekStart}><Cell c={c} unit={unit} /></div>)}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="cp-foot">
        <span>Team total · {p.weeks} weeks: <b>{fmtH(t.bookedMinutes)} booked / {fmtH(t.capacityMinutes)} available</b>{t.booked !== null && ` (${Math.round(t.booked * 100)}%)`}</span>
        <span>{plural(t.overWeeks, 'over-booked week')} · {plural(t.leaveWeeks, 'leave week')} · {plural(t.publicHolidays, 'public holiday')}</span>
      </div>

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
