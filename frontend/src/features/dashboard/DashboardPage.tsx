import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { insightApi, workApi } from '../../api/endpoints';
import type { StatusCategory } from '../../api/types';
import { ChartTip } from '../../components/ChartTip';
import { Icon, type IconName } from '../../components/Icon';
import { EmptyState, ErrorState, HealthBadge, PageHead, PageLoader, Progress, StatCard } from '../../components/ui';
import { formatDate, formatDateShort, timeAgo } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useAuth, useCan, useIsPersonal, useModule } from '../../stores/auth';
import { formatMinutes } from '../time/time';
import { TaskModal } from '../tasks/TaskModal';
import { ProjectFormModal } from '../projects/ProjectFormModal';
import { WorkTaskModal } from '../work/WorkTaskModal';
import { WorkItemRow, useVisibleKinds, workItemLink, type WorkRowItem } from '../workitems/workItems';

const CATEGORY_COLOR: Record<StatusCategory, string> = { Todo: '#38bdf8', Active: '#8b5cf6', Done: '#34d399', Cancelled: '#9aa0b5' };
const CATEGORY_LABEL: Record<StatusCategory, string> = { Todo: 'To do', Active: 'In progress', Done: 'Done', Cancelled: 'Cancelled' };

export function activityIcon(action: string): { icon: IconName; tone: string } {
  if (action.startsWith('task.created')) return { icon: 'plus', tone: 'blue' };
  if (action.startsWith('task.status')) return { icon: 'kanban', tone: 'blue' };
  if (action === 'task.assigned') return { icon: 'user', tone: 'purple' };
  if (action === 'task.commented') return { icon: 'message', tone: 'purple' };
  if (action.endsWith('deleted')) return { icon: 'trash', tone: 'amber' };
  if (action.startsWith('task.')) return { icon: 'edit', tone: 'amber' };
  if (action.startsWith('project.')) return { icon: 'folder', tone: 'purple' };
  if (action.startsWith('member.') || action.startsWith('team.')) return { icon: 'users', tone: 'green' };
  if (action.startsWith('subscription.')) return { icon: 'card', tone: 'amber' };
  return { icon: 'activity', tone: '' };
}

export function DashboardPage() {
  const nav = useNavigate();
  const user = useAuth((s) => s.ctx!.user);
  const personal = useIsPersonal();
  const canCreateTask = useCan('tasks.create');
  const canCreateProject = useCan('projects.create');
  const [taskModal, setTaskModal] = useState<{ id?: string } | null>(null);
  const [workModal, setWorkModal] = useState<string | null>(null);
  const kinds = useVisibleKinds();
  const [projectModal, setProjectModal] = useState(false);
  const [showTasks, showProjects, showActivity, showMembers] = [useModule('tasks') > 0, useModule('projects') > 0, useModule('activity') > 0, useModule('members') > 0];
  const permReports = useCan('reports.view'), modReports = useModule('reports');
  const canReports = permReports && modReports > 0;
  const q = useWsQuery(['dashboard'], insightApi.dashboard);
  const reportQ = useWsQuery(['dashboard-report'], () => insightApi.report(14), { enabled: canReports });
  const showWork = useModule('work') > 0;
  const workQ = useWsQuery(['work', 'summary', 'dashboard'], () => workApi.summary(), { enabled: showWork });

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const { counts: c, projects, activity } = q.data;
  const myWork = q.data.myWork ?? [];
  const openItem = (i: WorkRowItem) => {
    if (i.kind === 'Task') setTaskModal({ id: i.id });
    else if (i.kind === 'Operational') setWorkModal(i.id);
    else nav(workItemLink(i));
  };

  const trend = reportQ.data?.completedPerDay.map((d) => ({ label: formatDateShort(d.date), count: d.count })) ?? [];
  const statusDist = (reportQ.data?.statusDistribution ?? []).filter((s) => s.count > 0);
  const statusTotal = statusDist.reduce((s, x) => s + x.count, 0);

  return (
    <>
      <PageHead title={`Welcome back, ${user.displayName.split(' ')[0]}`} sub={`Here's an overview of your ${personal ? 'personal workspace' : 'workspace'} — ${formatDate(new Date().toISOString())}`}>
        {canCreateProject && <button className="btn btn-ghost" onClick={() => setProjectModal(true)}><Icon name="folder" /> New project</button>}
        {canCreateTask && showTasks && showProjects && <button className="btn btn-primary" onClick={() => setTaskModal({})}><Icon name="plus" /> Add task</button>}
      </PageHead>

      <div className="stat-grid">
        {kinds.length > 0 && <>
          <StatCard icon="calendar" tone="blue" value={c.myDueToday} label="Due today" foot="Assigned to you, every kind" />
          <StatCard icon="checkCircle" tone="green" value={c.myCompletedToday} label="Completed today" foot="Keep the streak going" />
          <Link className="stat-card" to="/my-work" style={{ display: 'block' }}>
            <div className="stat-top"><div className="stat-icon amber"><Icon name="inbox" /></div></div>
            <div className="stat-value">{c.myOpen}</div><div className="stat-label">My open work</div><div className="stat-foot">{showTasks ? `${c.openTasks} open project task${c.openTasks === 1 ? '' : 's'} in the workspace` : 'Assigned to you'}</div>
          </Link>
          <Link className="stat-card" to="/my-work?overdue=1" style={{ display: 'block' }}>
            <div className="stat-top"><div className="stat-icon red"><Icon name="alert" /></div></div>
            <div className="stat-value">{c.myOverdue}</div><div className="stat-label">My overdue work</div><div className="stat-foot">{c.myOverdue ? 'Needs attention' : 'All caught up'}</div>
          </Link>
          <StatCard icon="clock" tone="purple" value={formatMinutes(c.myLoggedMinutesThisWeek)} label="Logged this week" foot="Time tracked so far" />
        </>}
        {showWork && workQ.data && <>
          <Link className="stat-card" to="/operations?open=1" style={{ display: 'block' }}>
            <div className="stat-top"><div className={`stat-icon ${workQ.data.overdue ? 'red' : 'amber'}`}><Icon name="bolt" /></div></div>
            <div className="stat-value">{workQ.data.open}</div><div className="stat-label">Open work tasks</div><div className="stat-foot">{workQ.data.overdue} overdue · {workQ.data.unassigned} unassigned</div>
          </Link>
        </>}
        {showProjects && <>
          <StatCard icon="folder" tone="purple" value={c.activeProjects} label="Active projects" foot={`${c.totalProjects} total`} />
          <StatCard icon="target" tone="cyan" value={c.completedProjects} label="Completed projects" foot="Delivered" />
        </>}
        {!personal && showMembers && <StatCard icon="users" tone="blue" value={c.members} label="Members" foot={`${c.overdueTasks} overdue tasks overall`} />}
        {(showTasks || showProjects) && <div className="stat-card">
          <div className="stat-top"><div className="stat-icon cyan"><Icon name="chart" /></div></div>
          <div className="stat-value">{c.overallProgress}%</div><div className="stat-label">Overall progress</div>
          <div style={{ marginTop: 12 }}><Progress value={c.overallProgress} /></div>
        </div>}
      </div>

      {kinds.length > 0 && (
        <div className="card mb-22">
          <div className="card-head">
            <div><h3>My work</h3><p>Next up across project tasks, test issues, action items and operational work</p></div>
            <Link className="btn btn-ghost btn-sm" to="/my-work">Open My work</Link>
          </div>
          {myWork.length === 0
            ? <div className="card-body"><EmptyState icon="checkCircle" title="Nothing is assigned to you" text="Work of every kind assigned to you shows up here." /></div>
            : <div className="wi-list">{myWork.slice(0, 6).map((w) => <WorkItemRow key={`${w.kind}:${w.id}`} item={w} onOpen={openItem} />)}</div>}
        </div>
      )}

      {canReports && (trend.length > 0 || statusDist.length > 0) && <div className="grid-2 mb-22">
        {trend.length > 0 && <div className="card">
          <div className="card-head"><div><h3>Tasks completed</h3><p>Last 14 days</p></div></div>
          <div className="card-body">
            <div style={{ height: 190 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="dashTrendFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.35} /><stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-3)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} interval="preserveStartEnd" />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--text-3)' }} axisLine={false} tickLine={false} width={24} />
                  <Tooltip content={<ChartTip format={(v) => `${v} completed`} />} cursor={{ stroke: 'var(--border-strong)' }} />
                  <Area type="monotone" dataKey="count" stroke="#8b5cf6" strokeWidth={2.5} fill="url(#dashTrendFill)" animationDuration={700} animationEasing="ease-out" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>}

        {statusDist.length > 0 && <div className="card">
          <div className="card-head"><h3>Task status</h3></div>
          <div className="card-body">
            <div className="row" style={{ gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ width: 150, height: 150, flexShrink: 0 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={statusDist} dataKey="count" nameKey="category" innerRadius={44} outerRadius={70} paddingAngle={2} animationDuration={650} animationEasing="ease-out"
                      fill="#8b5cf6" stroke="var(--surface-1)" strokeWidth={2}>
                      {statusDist.map((s) => <Cell key={s.category} fill={CATEGORY_COLOR[s.category]} />)}
                    </Pie>
                    <Tooltip content={<ChartTip format={(v) => `${v} (${statusTotal ? Math.round((v / statusTotal) * 100) : 0}%)`} />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div style={{ flex: 1, minWidth: 140, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {statusDist.map((s) => (
                  <div key={s.category} className="row" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
                    <span className="row" style={{ gap: 7 }}><i style={{ width: 9, height: 9, borderRadius: 3, background: CATEGORY_COLOR[s.category], display: 'inline-block' }} />{CATEGORY_LABEL[s.category]}</span>
                    <b>{s.count}</b>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>}
      </div>}

      {(showProjects || showActivity) && <div className="grid-2 mb-22">
        {showProjects && <div className="card">
          <div className="card-head"><div><h3>Project overview</h3><p>Projects by deadline</p></div><button className="btn btn-ghost btn-sm" onClick={() => nav('/projects')}>All projects</button></div>
          <div className="card-body">
            {projects.length ? projects.map((p, i) => (
              <div key={p.id} style={{ padding: '13px 0', borderBottom: i < projects.length - 1 ? '1px solid var(--border)' : 'none', cursor: 'pointer' }} onClick={() => nav(`/projects/${p.id}`)}>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 650, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                    <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{p.owner?.name ?? 'Unassigned'} · {formatDate(p.dueDate)}</div>
                  </div>
                  <HealthBadge health={p.health} />
                </div>
                <div className="row"><div style={{ flex: 1 }}><Progress value={p.progress} /></div><b style={{ fontSize: 12, minWidth: 38, textAlign: 'right' }}>{p.progress}%</b></div>
              </div>
            )) : <EmptyState icon="folder" title="No projects yet" text="Create a project to start tracking progress." />}
          </div>
        </div>}

        {showActivity && <div className="card">
          <div className="card-head"><div><h3>Recent activity</h3><p>Latest updates across your workspace</p></div><button className="btn btn-ghost btn-sm" onClick={() => nav('/activity')}>View all</button></div>
          <div className="card-body">
            {activity.length ? <div className="activity-list">{activity.map((a) => {
              const ic = activityIcon(a.action);
              return (
                <div className="act-item" key={a.id}>
                  <div className={`act-ico ${ic.tone}`}><Icon name={ic.icon} /></div>
                  <div className="act-body"><div className="act-text">{a.actor && <b>{a.actor.name} </b>}{a.summary}</div><div className="act-time">{timeAgo(a.createdAt)}</div></div>
                </div>
              );
            })}</div> : <EmptyState icon="activity" title="No activity yet" text="Your actions will appear here." />}
          </div>
        </div>}
      </div>}

      {taskModal && <TaskModal taskId={taskModal.id} onClose={() => setTaskModal(null)} />}
      {workModal && <WorkTaskModal taskId={workModal} onClose={() => setWorkModal(null)} />}
      {projectModal && <ProjectFormModal onClose={() => setProjectModal(false)} onSaved={(id) => nav(`/projects/${id}`)} />}
    </>
  );
}
