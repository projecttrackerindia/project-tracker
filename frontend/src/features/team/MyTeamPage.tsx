import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { teamViewApi } from '../../api/endpoints';
import type { TeamMember, TeamTask } from '../../api/types';
import { ChartTip } from '../../components/ChartTip';
import { Avatar, Badge, EmptyState, ErrorState, Modal, PageHead, PageLoader, PriorityBadge, StatCard, TaskStatusBadge } from '../../components/ui';
import { formatDateShort } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { formatMinutes } from '../time/time';

/** The three bars per person in the workload chart: what each colour counts. The bars and the key below the title are both drawn from this. */
const SERIES = [
  { key: 'open', name: 'Open', color: '#8b5cf6', meaning: 'Tasks that are not finished yet.' },
  { key: 'overdue', name: 'Overdue', color: '#fb7185', meaning: 'Open tasks that are past their due date (they are also counted in Open).' },
  { key: 'done', name: 'Done (30d)', color: '#34d399', meaning: 'Tasks finished in the last 30 days.' },
] as const;

const NAME_WIDTH = 132;

/** A person's name at the left of their bars: every name starts at the same left edge (not right-aligned and ragged), and long ones are shortened rather than wrapped. */
function NameTick({ x, y, payload }: { x?: number; y?: number; payload?: { value: string } }) {
  const name = payload?.value ?? '';
  return (
    <text x={(x ?? 0) - NAME_WIDTH + 8} y={y} dy={4} textAnchor="start" fill="var(--text-2)" fontSize={12} fontWeight={600}>
      <title>{name}</title>{name.length > 19 ? `${name.slice(0, 18)}…` : name}
    </text>
  );
}

/** The people who report to me in the organization chart and how their work is going. Read-only. */
export function MyTeamPage() {
  const q = useWsQuery(['my-team'], teamViewApi.get, { refetchInterval: 60_000 });
  const [open, setOpen] = useState<TeamMember | null>(null);

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const t = q.data;
  const workload = t.members.map((m) => ({ name: m.name, open: m.open, overdue: m.overdue, done: m.doneLast30Days }));
  const maxWorkload = Math.max(1, ...workload.map((w) => Math.max(w.open, w.overdue, w.done)));

  return (
    <>
      <PageHead title="My team" sub="The people who report to you in the organization chart, directly or through others." />
      {t.members.length === 0 ? (
        <div className="card"><div className="card-body"><EmptyState icon="users" title="Nobody reports to you yet" text="When the organization chart shows people below you, their work appears here." /></div></div>
      ) : (
        <>
          <div className="stat-grid">
            <StatCard value={t.totals.people} label="People" /><StatCard value={t.totals.open} label="Open tasks" />
            <StatCard value={t.totals.overdue} label="Overdue" />
          </div>
          <div className="card mb-22">
            <div className="card-head">
              <div><h3>Team workload</h3><p>Open work per assignee — a planning aid, not a performance score</p></div>
              {/* Just the names, top right beside the title; hovering one says what it counts */}
              <ul className="chart-key" aria-label="Chart colours">
                {SERIES.map((s) => <li key={s.key} title={s.meaning}><i style={{ background: s.color }} aria-hidden="true" /><b>{s.name}</b><span className="sr-only">: {s.meaning}</span></li>)}
              </ul>
            </div>
            <div className="card-body">
              <div style={{ height: Math.max(160, workload.length * 76) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={workload} layout="vertical" margin={{ top: 0, right: 20, left: 2, bottom: 0 }} barGap={3}>
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
          <div className="team-list">
            {t.members.map((m) => (
              <div className="card team-card" key={m.userId}>
                <div className="team-head">
                  <Avatar name={m.name} />
                  <div className="team-who">
                    <b>{m.name}</b> {m.jobRole && <Badge tone="purple">{m.jobRole}</Badge>} <Badge tone="neutral">{m.level === 1 ? 'Direct report' : 'Indirect report'}</Badge>
                    <div className="muted" style={{ fontSize: 12 }}>{m.level === 1 ? 'Reports to you' : `Reports to ${m.reportsTo ?? 'someone in your line'}`} · {m.email}</div>
                  </div>
                  <div className="team-nums">
                    <span title="Open tasks"><b>{m.open}</b><i>Open</i></span>
                    <span className={m.overdue > 0 ? 'bad' : ''} title="Overdue"><b>{m.overdue}</b><i>Overdue</i></span>
                    <span title="Finished in the last 30 days"><b>{m.doneLast30Days}</b><i>Done (30d)</i></span>
                    <span title="Time logged in the last 7 days"><b>{formatMinutes(m.loggedMinutesLast7Days)}</b><i>Logged (7d)</i></span>
                  </div>
                </div>
                {m.nextUp.length > 0 && <div className="team-tasks">{m.nextUp.map((k) => <TaskLine key={k.id} t={k} />)}</div>}
                <div className="row" style={{ gap: 8, marginTop: 12 }}>
                  {m.open > m.nextUp.length && <button className="btn btn-ghost btn-sm" onClick={() => setOpen(m)}>All {m.open} open tasks</button>}
                  {m.open === 0 && <span className="muted" style={{ fontSize: 12.5 }}>Nothing open right now.</span>}
                  <Link className="btn btn-ghost btn-sm" to={`/timesheet?user=${m.userId}`}>Timesheet</Link>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {open && <PersonModal member={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function TaskLine({ t }: { t: TeamTask }) {
  const nav = useNavigate();
  return (
    <div className="team-task">
      <button type="button" className="link" onClick={() => nav(`/projects/${t.projectId}?task=${t.id}`)}><b>{t.key}</b> {t.title}</button>
      <span className="sprint-task-meta">
        <span className="muted">{t.projectName}</span><PriorityBadge priority={t.priority} /><TaskStatusBadge name={t.statusName} category={t.category} />
        {t.dueDate && <span className={t.isOverdue ? 'bad' : 'muted'}>{formatDateShort(t.dueDate)}</span>}
      </span>
    </div>
  );
}

function PersonModal({ member, onClose }: { member: TeamMember; onClose: () => void }) {
  const q = useWsQuery(['my-team', member.userId], () => teamViewApi.person(member.userId));
  return (
    <Modal size="lg" title={member.name} subtitle="Open tasks, most urgent first" onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}>
      {q.isLoading ? <PageLoader /> : q.isError || !q.data ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
        <div className="team-tasks">{q.data.openTasks.map((k) => <TaskLine key={k.id} t={k} />)}</div>
      )}
    </Modal>
  );
}
