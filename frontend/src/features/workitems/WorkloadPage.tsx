import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { workItemApi } from '../../api/endpoints';
import type { WorkItemKind, WorkloadPerson, WorkloadScope } from '../../api/types';
import { ChartTip } from '../../components/ChartTip';
import { Avatar, Badge, EmptyState, ErrorState, Modal, PageHead, PageLoader, StatCard } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { formatMinutes } from '../time/time';
import { KIND_META, WorkItemRow, fromPersonItem, useVisibleKinds, workItemLink } from './workItems';

/** The three bars per person in the workload chart: what each colour counts. The bars and the key below the title are both drawn from this. */
const SERIES = [
  { key: 'open', name: 'Open', color: '#8b5cf6', meaning: 'Work of every kind that is not finished yet.' },
  { key: 'overdue', name: 'Overdue', color: '#fb7185', meaning: 'Open work that is past its due date (it is also counted in Open).' },
  { key: 'done', name: 'Done (30d)', color: '#34d399', meaning: 'Work finished in the last 30 days.' },
] as const;

const SCOPES: Record<WorkloadScope, { label: string; sub: string }> = {
  Reports: { label: 'Direct reports', sub: 'The people who report to you in the org chart, directly or through others.' },
  Everyone: { label: 'Everyone', sub: 'Everybody in the workspace.' },
  Me: { label: 'Just me', sub: 'Your own work.' },
};
const NAME_WIDTH = 132;

function NameTick({ x, y, payload }: { x?: number; y?: number; payload?: { value: string } }) {
  const name = payload?.value ?? '';
  return (
    <text x={(x ?? 0) - NAME_WIDTH + 8} y={y} dy={4} textAnchor="start" fill="var(--text-2)" fontSize={12} fontWeight={600}>
      <title>{name}</title>{name.length > 19 ? `${name.slice(0, 18)}…` : name}
    </text>
  );
}

const KIND_KEYS: { kind: WorkItemKind; count: keyof NonNullable<WorkloadPerson['openByKind']> }[] = [
  { kind: 'Task', count: 'tasks' }, { kind: 'Issue', count: 'issues' }, { kind: 'ActionItem', count: 'actionItems' }, { kind: 'Operational', count: 'operational' },
];

/**
 * Workload: open work per person across every kind (project tasks, test issues, action items, operational work). A manager sees their
 * reporting line, someone with broad reports access can see everyone, and anyone can see their own. A planning aid, not a performance score.
 */
export function WorkloadPage() {
  const [params, setParams] = useSearchParams();
  const wanted = (params.get('scope') as WorkloadScope | null) ?? undefined;
  const q = useWsQuery(['workload', wanted ?? ''], () => workItemApi.workload(wanted), { refetchInterval: 60_000 });
  const [open, setOpen] = useState<WorkloadPerson | null>(null);
  const kinds = useVisibleKinds();

  if (q.isLoading) return <PageLoader />;
  // A scope from an old link or bookmark that this person cannot use: fall back to their default view.
  if (q.isError && wanted) return <Navigate to="/workload" replace />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const t = q.data;
  const setScope = (s: WorkloadScope) => { const n = new URLSearchParams(params); n.set('scope', s); setParams(n, { replace: true }); };
  const chart = t.members.map((m) => ({ name: m.name, open: m.open, overdue: m.overdue, done: m.doneLast30Days }));
  const maxWorkload = Math.max(1, ...chart.map((w) => Math.max(w.open, w.overdue, w.done)));
  const dueThisWeek = t.members.reduce((n, m) => n + m.dueThisWeek, 0);

  return (
    <>
      <PageHead title="Workload" sub={SCOPES[t.scope].sub}>
        {t.available.length > 1 && (
          <div className="seg" role="group" aria-label="Whose workload">
            {t.available.map((s) => <button key={s} type="button" className={t.scope === s ? 'active' : ''} aria-pressed={t.scope === s} onClick={() => setScope(s)}>{SCOPES[s].label}</button>)}
          </div>
        )}
      </PageHead>

      {t.members.length === 0 ? (
        <div className="card"><div className="card-body"><EmptyState icon="users" title={t.scope === 'Reports' ? 'Nobody reports to you yet' : 'Nobody to show'} text={t.scope === 'Reports' ? 'When the org chart shows people below you, their work appears here.' : undefined} /></div></div>
      ) : (
        <>
          <div className="stat-grid">
            <StatCard icon="users" tone="blue" value={t.totals.people} label="People" />
            <StatCard icon="inbox" tone="purple" value={t.totals.open} label="Open work" foot="Every kind" />
            <StatCard icon="alert" tone="red" value={t.totals.overdue} label="Overdue" />
            <StatCard icon="calendar" tone="amber" value={dueThisWeek} label="Due in the next 7 days" />
          </div>
          {t.members.length > 1 && (
            <div className="card mb-22">
              <div className="card-head">
                <div><h3>Open work per person</h3><p>A planning aid, not a performance score</p></div>
                <ul className="chart-key" aria-label="Chart colours">
                  {SERIES.map((s) => <li key={s.key} title={s.meaning}><i style={{ background: s.color }} aria-hidden="true" /><b>{s.name}</b><span className="sr-only">: {s.meaning}</span></li>)}
                </ul>
              </div>
              <div className="card-body">
                <div style={{ height: Math.max(160, chart.length * 76) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chart} layout="vertical" margin={{ top: 0, right: 20, left: 2, bottom: 0 }} barGap={3}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" />
                      <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--text-3)' }} axisLine={false} tickLine={false} domain={[0, maxWorkload]} />
                      <YAxis type="category" dataKey="name" tick={<NameTick />} axisLine={false} tickLine={false} width={NAME_WIDTH} interval={0} />
                      <Tooltip content={<ChartTip />} cursor={{ fill: 'var(--hover-bg)' }} />
                      {SERIES.map((s) => <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} radius={[0, 6, 6, 0]} barSize={16} animationDuration={600} animationEasing="ease-out" />)}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}
          <div className="kind-key" style={{ marginBottom: 12 }} aria-label="Kinds of work">
            {KIND_KEYS.filter((k) => kinds.includes(k.kind)).map((k) => <span key={k.kind}><i style={{ background: `var(--kind-${k.kind})` }} />{KIND_META[k.kind].plural}</span>)}
          </div>
          <div className="team-list">
            {t.members.map((m) => <PersonCard key={m.userId} m={m} scope={t.scope} onAll={() => setOpen(m)} />)}
          </div>
        </>
      )}
      {open && <PersonModal member={open} scope={t.scope} onClose={() => setOpen(null)} />}
    </>
  );
}

function PersonCard({ m, scope, onAll }: { m: WorkloadPerson; scope: WorkloadScope; onAll: () => void }) {
  const nav = useNavigate();
  const by = m.openByKind;
  const total = by ? Math.max(1, by.total) : 1;
  return (
    <div className="card team-card">
      <div className="team-head">
        <Avatar name={m.name} />
        <div className="team-who">
          <b>{m.name}</b> {m.jobRole && <Badge tone="purple">{m.jobRole}</Badge>} {scope === 'Reports' && m.level > 0 && <Badge tone="neutral">{m.level === 1 ? 'Direct report' : 'Indirect report'}</Badge>}
          <div className="muted" style={{ fontSize: 12 }}>{scope === 'Reports' && m.level > 0 ? (m.level === 1 ? 'Reports to you' : `Reports to ${m.reportsTo ?? 'someone in your line'}`) + ' · ' : ''}{m.email}</div>
        </div>
        <div className="team-nums">
          <span title="Open work of every kind"><b>{m.open}</b><i>Open</i></span>
          <span className={m.overdue > 0 ? 'bad' : ''} title="Overdue"><b>{m.overdue}</b><i>Overdue</i></span>
          <span title="Due in the next 7 days"><b>{m.dueThisWeek}</b><i>This week</i></span>
          <span title="Finished in the last 30 days"><b>{m.doneLast30Days}</b><i>Done (30d)</i></span>
          <span title="Time logged in the last 7 days"><b>{formatMinutes(m.loggedMinutesLast7Days)}</b><i>Logged (7d)</i></span>
        </div>
      </div>
      {by && by.total > 0 && (
        <div className="row" style={{ gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          <div className="kind-bar" style={{ flex: 1 }} role="img" aria-label={KIND_KEYS.map((k) => `${by[k.count]} ${KIND_META[k.kind].plural}`).join(', ')}>
            {KIND_KEYS.map((k) => by[k.count] > 0 && <span key={k.kind} className={k.kind} style={{ width: `${(by[k.count] / total) * 100}%` }} title={`${by[k.count]} ${KIND_META[k.kind].plural.toLowerCase()}`} />)}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>{KIND_KEYS.filter((k) => by[k.count] > 0).map((k) => `${by[k.count]} ${(by[k.count] === 1 ? KIND_META[k.kind].label : KIND_META[k.kind].plural).toLowerCase()}`).join(' · ')}</span>
        </div>
      )}
      {m.nextUp.length > 0 && <div className="wi-list" style={{ marginTop: 10 }}>{m.nextUp.map((k) => <WorkItemRow key={`${k.kind}:${k.id}`} item={fromPersonItem(k)} onOpen={(i) => nav(workItemLink(i))} />)}</div>}
      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        {m.open > m.nextUp.length && <button className="btn btn-ghost btn-sm" onClick={onAll}>All {m.open} open items</button>}
        {m.open === 0 && <span className="muted" style={{ fontSize: 12.5 }}>Nothing open right now.</span>}
        <Link className="btn btn-ghost btn-sm" to={scope === 'Me' ? '/timesheet' : `/timesheet?user=${m.userId}`}>Timesheet</Link>
      </div>
    </div>
  );
}

function PersonModal({ member, scope, onClose }: { member: WorkloadPerson; scope: WorkloadScope; onClose: () => void }) {
  const nav = useNavigate();
  const q = useWsQuery(['workload', 'person', member.userId, scope], () => workItemApi.person(member.userId, scope));
  return (
    <Modal size="lg" title={member.name} subtitle="Open work of every kind, most urgent first" onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}>
      {q.isLoading ? <PageLoader /> : q.isError || !q.data ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
        <div className="wi-list">{q.data.openTasks.map((k) => <WorkItemRow key={`${k.kind}:${k.id}`} item={fromPersonItem(k)} onOpen={(i) => { onClose(); nav(workItemLink(i)); }} />)}</div>
      )}
    </Modal>
  );
}
