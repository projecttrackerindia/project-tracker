import { useState } from 'react';
import { Bar, CartesianGrid, Cell, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, BarChart } from 'recharts';
import { timeApi } from '../../api/endpoints';
import type { TimesheetInsights as Insights } from '../../api/types';
import { Icon } from '../../components/Icon';
import { ErrorState, PageLoader } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { TimesheetStatusChip, mondayOf, weekLabel } from './Approvals';
import { dayName, dayNum } from './grid';
import { formatMinutes } from './time';

const SHARE_COLORS = ['#8b5cf6', '#38bdf8', '#34d399', '#f59e0b', '#fb7185', '#22d3ee', '#a3a3a3'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);
/** Axis ticks on whole hours (minutes in, minutes out). */
function hourTicks(max: number) {
  const step = max > 3000 ? 600 : max > 1500 ? 300 : max > 600 ? 120 : 60;
  const top = Math.max(step, Math.ceil(max / step) * step);
  return Array.from({ length: top / step + 1 }, (_, i) => i * step);
}
const fmt = (iso: string, year = false) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) });
const range = (from: string, to: string) => `${fmt(from)} – ${fmt(to, true)}`;
const shortWeek = (monday: string) => `${dayNum(monday)} ${new Date(`${monday}T00:00:00`).toLocaleDateString(undefined, { month: 'short' })}`;

function Tip({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color?: string }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      <b>{label}</b>
      {payload.map((p) => <span key={p.name} style={{ color: p.color }}>{p.name}: {formatMinutes(Math.round(p.value))}</span>)}
    </div>
  );
}

/**
 * Timesheet → Insights: the last weeks against the person's normal week, overtime, billable share, where the time went, the shape of an
 * average week, how often time is logged on the day, the streak of logged days, and the days still empty.
 */
export function TimesheetInsights({ userId, onOpenWeek }: { userId: string; onOpenWeek: (monday: string) => void }) {
  const [weeks, setWeeks] = useState(8);
  const q = useWsQuery(['timesheet', 'insights', userId, weeks], () => timeApi.insights(userId || undefined, weeks));
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const d: Insights = q.data;
  const series = d.weeks.map((w) => ({ label: shortWeek(w.weekStart), Billable: w.billableMinutes, 'Not billable': w.loggedMinutes - w.billableMinutes, Normal: w.targetMinutes, week: w.weekStart }));
  const shareTotal = d.byProject.reduce((n, s) => n + s.minutes, 0) || 1;
  const weekday = d.byWeekday.map((w) => ({ label: WEEKDAYS[w.day], Average: w.averageMinutes }));
  const weekTicks = hourTicks(Math.max(0, ...series.map((s) => Math.max(s.Billable + s['Not billable'], s.Normal))));
  const dayTicks = hourTicks(Math.max(0, ...weekday.map((w) => w.Average)));

  return (
    <div className="tsi">
      <div className="tsi-head">
        <div><b>{d.user.name}</b><span>{range(d.from, d.to)}</span></div>
        <div className="seg" role="group" aria-label="Weeks">
          {[4, 8, 12].map((n) => <button key={n} type="button" className={weeks === n ? 'active' : ''} aria-pressed={weeks === n} onClick={() => setWeeks(n)}>{n} weeks</button>)}
        </div>
      </div>

      <div className="tsi-kpis">
        <Kpi icon="gauge" tone="purple" label="Of a normal week" value={pct(d.utilisation)} foot={`${formatMinutes(d.loggedMinutes)} of ${formatMinutes(d.targetMinutes)}`} />
        <Kpi icon="coin" tone="green" label="Billable" value={pct(d.billableShare)} foot={formatMinutes(d.billableMinutes)} />
        <Kpi icon="alarm" tone="amber" label="Overtime" value={formatMinutes(d.overtimeMinutes)} foot="above normal days" />
        <Kpi icon="clock" tone="blue" label="Logged on the day" value={pct(d.sameDayShare)} foot="same-day entries" />
        <Kpi icon="bolt" tone="pink" label="Streak" value={`${d.streak} day${d.streak === 1 ? '' : 's'}`} foot="days in a row" />
        <Kpi icon="alert" tone={d.missingDays.length ? 'red' : 'green'} label="Days missing" value={String(d.missingDays.length)} foot="last two weeks" />
      </div>

      <div className="tsi-grid">
        <div className="card tsi-wide">
          <div className="card-head"><div><h3>Week by week</h3><p>Logged time, billable and not, against the normal week (dashed) less planned leave. Click a week to open it.</p></div></div>
          <div className="card-body" style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} onClick={(e) => { const w = (e as { activePayload?: { payload: { week: string } }[] })?.activePayload?.[0]?.payload.week; if (w) onOpenWeek(w); }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-3)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
                <YAxis ticks={weekTicks} domain={[0, weekTicks.at(-1)!]} tick={{ fontSize: 11, fill: 'var(--text-3)' }} axisLine={false} tickLine={false} tickFormatter={(v: number) => `${Math.round(v / 60)}h`} width={36} />
                <Tooltip content={<Tip />} cursor={{ fill: 'var(--hover-bg)' }} />
                <Bar dataKey="Billable" stackId="t" fill="#34d399" maxBarSize={38} animationDuration={500} />
                <Bar dataKey="Not billable" stackId="t" fill="#8b5cf6" radius={[6, 6, 0, 0]} maxBarSize={38} animationDuration={500} />
                <Line dataKey="Normal" type="linear" stroke="#f59e0b" strokeDasharray="6 4" dot={{ r: 3, fill: '#f59e0b', strokeWidth: 0 }} strokeWidth={2} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div><h3>Where the time went</h3><p>By project, and operational work</p></div></div>
          <div className="card-body">
            {d.byProject.length === 0 ? <p className="muted">No time logged in these weeks.</p> : (
              <>
                <div className="tsi-stack" aria-hidden>{d.byProject.map((s, i) => <i key={s.label} style={{ width: `${(s.minutes / shareTotal) * 100}%`, background: SHARE_COLORS[i % SHARE_COLORS.length] }} />)}</div>
                <ul className="tsi-shares">
                  {d.byProject.map((s, i) => (
                    <li key={s.label}><span className="tsi-dot" style={{ background: SHARE_COLORS[i % SHARE_COLORS.length] }} /><span className="tsi-share-name">{s.label}</span>
                      <b>{formatMinutes(s.minutes)}</b><em>{Math.round((s.minutes / shareTotal) * 100)}%</em></li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div><h3>An average week</h3><p>Time logged per weekday</p></div></div>
          <div className="card-body" style={{ height: 200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weekday} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-3)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
                <YAxis ticks={dayTicks} domain={[0, dayTicks.at(-1)!]} tick={{ fontSize: 11, fill: 'var(--text-3)' }} axisLine={false} tickLine={false} tickFormatter={(v: number) => `${Math.round(v / 60)}h`} width={34} />
                <Tooltip content={<Tip />} cursor={{ fill: 'var(--hover-bg)' }} />
                <Bar dataKey="Average" radius={[6, 6, 0, 0]} maxBarSize={30} animationDuration={500}>
                  {weekday.map((w, i) => <Cell key={w.label} fill={i >= 5 ? '#a3a3a3' : '#38bdf8'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div><h3>Weeks</h3><p>Where each week's approval stands</p></div></div>
          <ul className="tsi-weeks">
            {[...d.weeks].reverse().map((w) => (
              <li key={w.weekStart}>
                <button type="button" className="tsi-week" onClick={() => onOpenWeek(w.weekStart)}>
                  <span className="tsi-week-name">{weekLabel(w.weekStart)}</span>
                  <span className="tsi-week-bar" aria-hidden><i style={{ width: `${w.targetMinutes ? Math.min(100, (w.loggedMinutes / w.targetMinutes) * 100) : 0}%` }} /></span>
                  <b>{formatMinutes(w.loggedMinutes)}</b>
                  {w.overtimeMinutes > 0 && <em className="tsi-ot" title="Above the normal day">+{formatMinutes(w.overtimeMinutes)}</em>}
                  {w.leaveDays > 0 && <em className="tsi-leave">{w.leaveDays}d leave</em>}
                  <TimesheetStatusChip status={w.status} />
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <div className="card-head"><div><h3>Days with nothing logged</h3><p>Working days in the last two weeks, not on leave</p></div></div>
          <div className="card-body">
            {d.missingDays.length === 0 ? <p className="tsi-allgood"><Icon name="checkCircle" size={16} /> Every working day has time on it.</p> : (
              <div className="tsi-missing">
                {d.missingDays.map((day) => (
                  <button type="button" key={day} className="tsi-miss" onClick={() => onOpenWeek(mondayOf(day))}><b>{dayName(day)}</b><span>{dayNum(day)}</span></button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Kpi({ icon, tone, label, value, foot }: { icon: 'gauge' | 'coin' | 'alarm' | 'clock' | 'bolt' | 'alert'; tone: string; label: string; value: string; foot: string }) {
  return (
    <div className={`tsi-kpi ${tone}`}>
      <span className="tsi-kpi-icon"><Icon name={icon} size={16} /></span>
      <div><b>{value}</b><span>{label}</span><small>{foot}</small></div>
    </div>
  );
}
