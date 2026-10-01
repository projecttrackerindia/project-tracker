import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { timeApi } from '../../api/endpoints';
import type { TimeEntry } from '../../api/types';
import { DateFilterPicker } from '../../components/DateFilterPicker';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, PageHead, PageLoader, StatCard } from '../../components/ui';
import { DOW, dateOffset, formatDate, formatDateShort, toISODate, todayISO } from '../../lib/format';
import { usePersonPicker, useWsQuery } from '../../lib/hooks';
import { useAuth } from '../../stores/auth';
import { formatMinutes } from './time';
import { Select } from '../../components/Select';

type Mode = 'single' | 'range' | 'multiple';
const TASK_COLORS = ['#8b5cf6', '#38bdf8', '#fb7185', '#34d399', '#f59e0b', '#22d3ee', '#a78bfa', '#f472b6'];

/** Monday of the week containing `d`. */
function weekStart(d: Date) {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return toISODate(x);
}

function MinutesTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return <div className="chart-tip"><b>{label}</b><span>{formatMinutes(payload[0].value)}</span></div>;
}

/** Time logged for a chosen date, range or scattered set of dates. Managers and admins can look at someone else's time too. */
export function TimesheetPage() {
  const me = useAuth((s) => s.ctx!.user);
  const [params] = useSearchParams();
  const [userId, setUserId] = useState<string>(params.get('user') ?? '');
  const { canPick, choices } = usePersonPicker();

  const [mode, setMode] = useState<Mode>('range');
  const [single, setSingle] = useState(todayISO());
  const [range, setRange] = useState(() => ({ from: weekStart(new Date()), to: dateOffset(6, new Date(weekStart(new Date()) + 'T00:00:00')) }));
  const [multi, setMulti] = useState<string[]>([todayISO()]);

  const { fetchFrom, fetchTo, onlyDates } = useMemo(() => {
    if (mode === 'single') return { fetchFrom: single, fetchTo: single, onlyDates: null as Set<string> | null };
    if (mode === 'range') return { fetchFrom: range.from, fetchTo: range.to, onlyDates: null as Set<string> | null };
    if (multi.length === 0) return { fetchFrom: todayISO(), fetchTo: todayISO(), onlyDates: new Set<string>() };
    const sorted = [...multi].sort();
    return { fetchFrom: sorted[0], fetchTo: sorted.at(-1)!, onlyDates: new Set(multi) };
  }, [mode, single, range, multi]);
  const rangeInvalid = mode === 'range' && range.to < range.from;

  const q = useWsQuery(['timesheet', fetchFrom, fetchTo, userId], () => timeApi.timesheet({ from: fetchFrom, to: fetchTo, userId: userId || undefined }), { enabled: !rangeInvalid });
  const d = q.data;
  const byDay = useMemo(() => (d ? (onlyDates ? d.byDay.filter((x) => onlyDates.has(x.date)) : d.byDay) : []), [d, onlyDates]);
  const entries = useMemo(() => (d ? (onlyDates ? d.entries.filter((e) => onlyDates.has(e.workDate)) : d.entries) : []), [d, onlyDates]);
  const totalMinutes = useMemo(() => entries.filter((e) => !e.isRunning).reduce((s, e) => s + e.minutes, 0), [entries]);
  const loggedDays = byDay.filter((x) => x.minutes > 0).length || byDay.length || 1;
  const workMinutes = useMemo(() => entries.filter((e) => !e.isRunning && e.kind === 'work').reduce((s, e) => s + e.minutes, 0), [entries]);

  const byTask = useMemo(() => {
    const map = new Map<string, { key: string; title: string; minutes: number }>();
    for (const e of entries) {
      if (e.isRunning) continue;
      const id = e.taskId ?? e.workTaskId ?? e.id;
      const row = map.get(id) ?? { key: e.taskKey, title: e.taskTitle, minutes: 0 };
      row.minutes += e.minutes;
      map.set(id, row);
    }
    return [...map.values()].sort((a, b) => b.minutes - a.minutes).slice(0, 8).reverse();
  }, [entries]);

  const chartDays = useMemo(() => byDay.map((x) => ({ ...x, label: `${DOW[new Date(x.date + 'T00:00:00').getDay()]} ${new Date(x.date + 'T00:00:00').getDate()}` })), [byDay]);


  return (
    <>
      <PageHead title="Timesheet" sub={userId && d ? `${d.user.name}’s time on project tasks and operational work` : 'The time you logged on project tasks and operational work, by day.'} />
      <div className="toolbar" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="Date selection mode">
          {([['single', 'calendar', 'Date'], ['range', 'arrowRight', 'Range'], ['multiple', 'grid', 'Dates']] as const).map(([m, icon, label]) => (
            <button key={m} type="button" className={mode === m ? 'active' : ''} aria-pressed={mode === m} title={label} onClick={() => setMode(m)}><Icon name={icon} size={14} /><span>{label}</span></button>
          ))}
        </div>
        <DateFilterPicker mode={mode} single={single} onSingle={setSingle} range={range} onRange={setRange} multi={multi} onMulti={setMulti} />
        {mode === 'range' && (
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => setRange({ from: weekStart(new Date()), to: dateOffset(6, new Date(weekStart(new Date()) + 'T00:00:00')) })}>This week</button>
          </>
        )}
        {mode === 'multiple' && (
          <>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {multi.map((dt) => (
                <span key={dt} className="badge badge-neutral" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {formatDateShort(dt)}
                  <button type="button" className="btn-icon" style={{ width: 16, height: 16 }} aria-label={`Remove ${dt}`} onClick={() => setMulti((m) => m.filter((x) => x !== dt))}><Icon name="close" size={10} /></button>
                </span>
              ))}
            </div>
          </>
        )}
        {canPick && (
          <Select className="select" style={{ maxWidth: 220, marginLeft: 'auto' }} value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Person">
            <option value="">{me.displayName} (me)</option>
            {choices.filter((m) => m.id !== me.id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        )}
      </div>

      {rangeInvalid ? <div className="card"><div className="card-body"><p className="muted" style={{ fontSize: 13 }}>The end date must not be before the start date.</p></div></div> :
       q.isLoading ? <PageLoader /> : q.isError || !d ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
        <>
          <div className="stat-grid">
            <StatCard value={formatMinutes(totalMinutes)} label="Total logged" />
            <StatCard value={entries.filter((e) => !e.isRunning).length} label="Entries" />
            <StatCard value={formatMinutes(Math.round(totalMinutes / loggedDays))} label="Avg per day logged" />
            <StatCard value={formatMinutes(totalMinutes - workMinutes)} label="On project tasks" />
            <StatCard value={formatMinutes(workMinutes)} label="On operational work" />
          </div>
          <div className="card mb-22">
            <div className="card-head"><h3>Hours by day</h3></div>
            <div className="card-body">
              {chartDays.length === 0 ? <p className="muted" style={{ fontSize: 13 }}>No dates in range.</p> : (
                <div style={{ height: 220 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartDays} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-3)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: 'var(--text-3)' }} axisLine={false} tickLine={false} tickFormatter={(v: number) => `${Math.round(v / 60)}h`} width={34} />
                      <Tooltip content={<MinutesTooltip />} cursor={{ fill: 'var(--hover-bg)' }} />
                      <Bar dataKey="minutes" fill="#8b5cf6" radius={[6, 6, 0, 0]} maxBarSize={44} animationDuration={550} animationEasing="ease-out" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>
          {byTask.length > 0 && (
            <div className="card mb-22">
              <div className="card-head"><div><h3>Where the time went</h3><p>Top tasks and operational work by time logged in this range</p></div></div>
              <div className="card-body">
                <div style={{ height: Math.max(120, byTask.length * 34) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={byTask} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" />
                      <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--text-3)' }} axisLine={false} tickLine={false} tickFormatter={(v: number) => `${Math.round(v / 60)}h`} />
                      <YAxis type="category" dataKey="key" tick={{ fontSize: 11.5, fill: 'var(--text-2)', fontWeight: 600 }} axisLine={false} tickLine={false} width={70} />
                      <Tooltip content={<MinutesTooltip />} cursor={{ fill: 'var(--hover-bg)' }} />
                      <Bar dataKey="minutes" radius={[0, 6, 6, 0]} maxBarSize={22} animationDuration={550} animationEasing="ease-out">
                        {byTask.map((t, i) => <Cell key={t.key} fill={TASK_COLORS[i % TASK_COLORS.length]} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}
          <div className="card">
            <div className="card-head"><h3>Entries</h3></div>
            <div className="card-body">
              {entries.length === 0 ? <EmptyState icon="clock" title="No time logged" text="Start a timer or log time from any project task or piece of operational work." /> : (
                <div className="time-list" style={{ marginTop: 0 }}>
                  {entries.map((e: TimeEntry) => (
                    <div className="time-row" key={e.id}>
                      <span className="time-min">{e.isRunning ? 'running' : formatMinutes(e.minutes)}</span>
                      <span className="time-what">
                        <Link className="link" to={e.kind === 'work' ? `/operations?task=${e.workTaskId}` : `/projects/${e.projectId}?task=${e.taskId}`}>{e.taskKey}</Link> {e.taskTitle} · {formatDate(e.workDate)}
                        {e.kind === 'work' && <span className="badge badge-warning" style={{ marginLeft: 6 }}>Operational</span>}
                        {e.note ? <span className="muted"> — {e.note}</span> : null}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
