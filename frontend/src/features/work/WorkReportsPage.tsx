import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ApiError } from '../../api/client';
import { workApi } from '../../api/endpoints';
import type { WorkCount, WorkSummary } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { Select } from '../../components/Select';
import { ErrorState, PageHead, PageLoader } from '../../components/ui';
import { formatDate } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { WORK_STATUSES } from '../../lib/workLabels';
import { toast } from '../../stores/ui';

const PERIODS = [{ days: 7, label: 'Last 7 days' }, { days: 30, label: 'Last 30 days' }, { days: 90, label: 'Last 90 days' }, { days: 365, label: 'Last 12 months' }];
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function Stat({ icon, tone, value, label, foot, to }: { icon: IconName; tone: string; value: number; label: string; foot?: string; to?: string }) {
  const body = (
    <>
      <div className="stat-top"><div className={`stat-icon ${tone}`}><Icon name={icon} /></div></div>
      <div className="stat-value">{value}</div><div className="stat-label">{label}</div>{foot && <div className="stat-foot">{foot}</div>}
    </>
  );
  return to ? <Link className="stat-card" to={to} style={{ display: 'block' }}>{body}</Link> : <div className="stat-card">{body}</div>;
}

/** Rows with a bar for the open work and the finished work, so the heaviest type / person / project stands out. */
function Breakdown({ title, sub, rows, empty }: { title: string; sub: string; rows: (WorkCount & { key?: string })[]; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.open + r.completed));
  return (
    <div className="card">
      <div className="card-head"><div><h3>{title}</h3><p>{sub}</p></div></div>
      <div className="card-body">
        {rows.length === 0 ? <p className="muted">{empty}</p> : (
          <div className="wr-rows">
            {rows.map((r) => (
              <div className="wr-row" key={r.key ?? r.name}>
                <div className="wr-name" title={r.name}>{r.name}</div>
                <div className="wr-bar" aria-hidden="true">
                  <span className="open" style={{ width: `${(r.open / max) * 100}%` }} />
                  <span className="done" style={{ width: `${(r.completed / max) * 100}%` }} />
                </div>
                <div className="wr-num"><b>{r.open}</b> open{r.overdue > 0 && <em> · {r.overdue} overdue</em>} · {r.completed} done</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Operations analytics (a tab of Reports): how much operational work is open, late and finished, by type, person and project, with a daily trend and a CSV download. */
export function WorkReportsPage() {
  const [days, setDays] = useState(30);
  const to = iso(new Date());
  const from = iso(new Date(Date.now() - (days - 1) * 86400000));
  const q = useWsQuery(['work', 'summary', from, to], () => workApi.summary(from, to));
  const s: WorkSummary | undefined = q.data;

  return (
    <>
      <PageHead title="Operations analytics" sub="Operational work: what is open, what is late and what was finished.">
        <div style={{ width: 190 }}>
          <Select className="select" value={String(days)} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
            {PERIODS.map((p) => <option key={p.days} value={p.days}>{p.label}</option>)}
          </Select>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => void workApi.exportCsv({ sort: 'due' }).catch((e) => toast(e instanceof ApiError ? e.message : 'Could not export.', 'error'))}><Icon name="download" /> Export all (CSV)</button>
      </PageHead>

      {q.isLoading ? <PageLoader /> : q.isError || !s ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : (
        <>
          <div className="stat-grid">
            <Stat icon="bolt" tone="blue" value={s.open} label="Open work tasks" foot={`${s.unassigned} unassigned`} to="/operations?open=1" />
            <Stat icon="alert" tone="red" value={s.overdue} label="Overdue" foot="Open and past the due date" to="/operations?overdue=1" />
            <Stat icon="clock" tone="amber" value={s.dueThisWeek} label="Due in the next 7 days" />
            <Stat icon="checkCircle" tone="green" value={s.completedInPeriod} label="Completed" foot={`${formatDate(s.from)} – ${formatDate(s.to)}`} />
            <Stat icon="plus" tone="cyan" value={s.createdInPeriod} label="Raised" foot="In the same period" />
            <Stat icon="user" tone="purple" value={s.mineOpen} label="Assigned to me" foot={`${s.mineOverdue} overdue`} to="/my-work?kind=Operational" />
          </div>

          {s.sla && (s.sla.tracked > 0 || s.sla.responseTracked > 0 || s.sla.openBreached > 0 || s.sla.openAtRisk > 0) && (
            <div className="card sla-summary" style={{ marginBottom: 18 }}>
              <div className="card-head"><div><h3>Service levels</h3><p>Work resolved in this period that had a target, and what is late or at risk right now</p></div>
                <Link className="btn btn-ghost btn-sm" to="/settings/work-types">Targets</Link></div>
              <div className="card-body sla-summary-body">
                <div className={`sla-gauge ${s.sla.compliance === null ? '' : s.sla.compliance >= 0.9 ? 'ok' : s.sla.compliance >= 0.75 ? 'risk' : 'bad'}`}
                  style={{ ['--p' as string]: `${Math.round((s.sla.compliance ?? 0) * 100)}` }}>
                  <b>{s.sla.compliance === null ? '—' : `${Math.round(s.sla.compliance * 100)}%`}</b><span>resolved in time</span>
                </div>
                <div className="sla-facts">
                  <div><b>{s.sla.met}</b><span>met</span></div>
                  <div><b className={s.sla.missed ? 'bad' : ''}>{s.sla.missed}</b><span>missed</span></div>
                  <div><b>{s.sla.responseTracked ? `${Math.round((s.sla.responseMet / s.sla.responseTracked) * 100)}%` : '—'}</b><span>first response in time</span></div>
                  <Link to="/operations?sla=breached" className="sla-fact-link"><b className={s.sla.openBreached ? 'bad' : ''}>{s.sla.openBreached}</b><span>open and breached</span></Link>
                  <Link to="/operations?sla=atRisk" className="sla-fact-link"><b className={s.sla.openAtRisk ? 'risk' : ''}>{s.sla.openAtRisk}</b><span>at risk</span></Link>
                </div>
              </div>
            </div>
          )}

          <div className="card" style={{ marginBottom: 18 }}>
            <div className="card-head"><div><h3>Raised and completed</h3><p>Work tasks per day</p></div>
              <ul className="chart-key" aria-label="Key"><li><i style={{ background: 'var(--primary)' }} /><b>Raised</b></li><li><i style={{ background: 'var(--success)' }} /><b>Completed</b></li></ul></div>
            <div className="card-body" style={{ height: 230 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={s.perDay.map((d) => ({ ...d, label: formatDate(d.date).replace(/ \d{4}$/, '') }))} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-3)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} interval="preserveStartEnd" />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--text-3)' }} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ stroke: 'var(--border-strong)' }} contentStyle={{ background: 'var(--modal-bg)', border: '1px solid var(--modal-border)', borderRadius: 10, fontSize: 12 }} />
                  <Area type="monotone" dataKey="created" name="Raised" stroke="#8b5cf6" strokeWidth={2} fill="#8b5cf6" fillOpacity={0.12} />
                  <Area type="monotone" dataKey="completed" name="Completed" stroke="#34d399" strokeWidth={2} fill="#34d399" fillOpacity={0.12} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid-2">
            <Breakdown title="By work type" sub="Open and completed" rows={s.byType} empty="No work in this period." />
            <div className="card">
              <div className="card-head"><div><h3>By status</h3><p>Where the work stands</p></div></div>
              <div className="card-body">
                <div className="wr-rows">
                  {s.byStatus.map((x) => {
                    const meta = WORK_STATUSES.find((w) => w.id === x.status);
                    const max = Math.max(1, ...s.byStatus.map((y) => y.count));
                    return (
                      <div className="wr-row" key={x.status}>
                        <div className="wr-name"><span className={`badge ${meta?.badge ?? 'badge-neutral'}`}>{meta?.label ?? x.status}</span></div>
                        <div className="wr-bar" aria-hidden="true"><span className="open" style={{ width: `${(x.count / max) * 100}%` }} /></div>
                        <div className="wr-num"><b>{x.count}</b></div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <Breakdown title="By person" sub="Who the work is assigned to" rows={s.byPerson.map((p) => ({ ...p, key: p.userId ?? 'none' }))} empty="No work assigned in this period." />
            <Breakdown title="By related project" sub="Projects the work refers to (projects are not changed by it)" rows={s.byProject} empty="No work in this period." />
          </div>
        </>
      )}
    </>
  );
}
