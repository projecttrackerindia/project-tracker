import { Link } from 'react-router-dom';
import { timeApi } from '../../api/endpoints';
import { EmptyState, ErrorState, PageLoader, Progress, StatCard } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { formatMinutes } from './time';
import { ProjectBudget } from './ProjectBudget';

/** Where a project's tracked time went: by person and by task, against the estimate - and, above it, the project's budget. */
export function ProjectTime({ projectId }: { projectId: string }) {
  return <><ProjectBudget projectId={projectId} /><TrackedTime projectId={projectId} /></>;
}

function TrackedTime({ projectId }: { projectId: string }) {
  const q = useWsQuery(['project', projectId, 'time'], () => timeApi.project(projectId));
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  const estimate = d.estimatedHours ? Math.round(d.estimatedHours * 60) : null;
  if (d.totalMinutes === 0) return <div className="card"><div className="card-body"><EmptyState icon="clock" title="No time tracked yet" text="Time logged on this project’s tasks shows up here." /></div></div>;
  const top = Math.max(1, ...d.byPerson.map((p) => p.minutes));
  return (
    <>
      <div className="stat-grid">
        <StatCard value={formatMinutes(d.totalMinutes)} label="Tracked" />
        {estimate ? <StatCard value={formatMinutes(estimate)} label="Estimated" /> : null}
        {estimate ? <StatCard value={`${Math.round((d.totalMinutes / estimate) * 100)}%`} label="Of estimate used" /> : null}
      </div>
      <div className="grid-2">
        <div className="card">
          <div className="card-head"><h3>By person</h3></div>
          <div className="card-body">
            {d.byPerson.map((p) => (
              <div key={p.userId} style={{ marginBottom: 12 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}><span>{p.name}</span><b>{formatMinutes(p.minutes)}</b></div>
                <Progress value={Math.round((p.minutes / top) * 100)} />
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Most time spent</h3></div>
          <div className="card-body">
            <div className="time-list" style={{ marginTop: 0 }}>
              {d.topTasks.map((t) => (
                <div className="time-row" key={t.taskId}>
                  <span className="time-min">{formatMinutes(t.minutes)}</span>
                  <span className="time-what"><Link className="link" to={`/projects/${projectId}?task=${t.taskId}`}>{t.key}</Link> {t.title}
                    {t.estimatedHours ? <span className="muted"> · est. {formatMinutes(Math.round(t.estimatedHours * 60))}</span> : null}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
