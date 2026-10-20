import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { del, get, post } from '../../api/client';
import { useWsQuery } from '../../lib/hooks';
import { EmptyState, PageLoader } from '../../components/ui';
import { Select } from '../../components/Select';
import { Icon, type IconName } from '../../components/Icon';
import { Markdown } from './Markdown';
import { AgentsHubNav } from '../agents/AgentsHubNav';
import { formatDateTime, timeAgo } from '../../lib/format';
import './workflows.css';

type Kind = 'portfolio' | 'workload' | 'history';
interface Source { kind: string; id: string; label: string; link: string; version?: string }
interface Result { summary: string; evidenceAt: string; methodology: string; sources: Source[] }
interface Job { id: string; kind: Kind; title: string; status: string; progress: number; attempts: number; createdAt: string; errorCode: string | null; result: Result | null }
interface Schedule { id: string; title: string; kind: Kind; intervalMinutes: number; nextRunAt: string; enabled: boolean }
interface ForecastEvaluation { forecasts: number; verifiedCompletions: number; comparableProjects: number; meanAbsoluteErrorDays: number | null; methodology: string; items: { id: string; project: string; link: string; projectedFinish: string | null; recordedCompletedAt: string | null; errorDays: number | null; scopeChanged: boolean; reopened: boolean }[] }

const KINDS: { id: Kind; label: string; hint: string; icon: IconName; tone: string }[] = [
  { id: 'portfolio', label: 'Portfolio risks and delivery forecast', hint: 'Which projects will slip, and why', icon: 'radar', tone: 'purple' },
  { id: 'workload', label: 'Workload and capacity review', hint: 'Who is overloaded, who has room', icon: 'users', tone: 'blue' },
  { id: 'history', label: 'Delivery history and recurring blockers', hint: 'What keeps slowing delivery down', icon: 'activity', tone: 'amber' },
];
const label = (k: Kind) => KINDS.find((x) => x.id === k)?.label ?? k;
const every = (m: number) => (m === 60 ? 'every hour' : m === 1440 ? 'every day' : m === 10080 ? 'every week' : `every ${Math.round(m / 60)} hours`);
const STATUS: Record<string, string> = { queued: 'Queued', running: 'Running', succeeded: 'Done', completed: 'Done', failed: 'Failed', cancelled: 'Cancelled' };

/** Agents → Workflows: background reviews of delivery, capacity and recurring blockers, run now or on a schedule, and how forecasts turned out. */
export function AgentWorkflowsPage() {
  const [params] = useSearchParams();
  const jobs = useWsQuery(['agent-workflows', 'jobs'], () => get<Job[]>('/ai/operations/jobs'), { refetchInterval: 15_000 });
  const schedules = useWsQuery(['agent-workflows', 'schedules'], () => get<Schedule[]>('/ai/operations/schedules'), { refetchInterval: 60_000 });
  const forecasts = useWsQuery(['agent-workflows', 'forecasts'], () => get<ForecastEvaluation>('/ai/operations/forecasts'));
  const [kind, setKind] = useState<Kind>('portfolio');
  const [interval, setIntervalMinutes] = useState(1440);
  const [selected, setSelected] = useState<string | null>(() => params.get('job'));
  useEffect(() => { const job = params.get('job'); if (job) setSelected(job); }, [params]);
  const selectedJob = useWsQuery(['agent-workflows', 'job', selected], () => get<Job>(`/ai/operations/jobs/${selected}`), { enabled: !!selected });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => { await Promise.all([jobs.refetch(), schedules.refetch(), forecasts.refetch()]); };
  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'The review could not be updated.'); }
    finally { setBusy(false); }
  };
  const picked = jobs.data?.find((j) => j.id === selected) ?? selectedJob.data;
  if (jobs.isLoading) return <PageLoader />;
  const f = forecasts.data;

  return (
    <div className="awf">
      <AgentsHubNav sub="Background reviews of delivery, capacity and recurring blockers" />
      {(error || jobs.error || schedules.error) && <div className="callout callout-error mb-18" role="alert"><Icon name="alert" size={16} /><div>{error || jobs.error?.message || schedules.error?.message}</div></div>}

      <section className="card awf-create" aria-labelledby="awf-create-title">
        <div className="card-head">
          <div><h3 id="awf-create-title">Start a review</h3><p>Uses only the project data you can see. No AI credits, and nothing is changed: no assignments, dates or permissions.</p></div>
          <Link to="/ai" className="btn btn-ghost btn-sm"><Icon name="sparkle" size={14} />Open the assistant</Link>
        </div>
        <div className="card-body">
          <div className="awf-kinds" role="radiogroup" aria-label="Review">
            {KINDS.map((k) => (
              <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className={`awf-kind ${k.tone} ${kind === k.id ? 'on' : ''}`} onClick={() => setKind(k.id)}>
                <span className="awf-kind-icon"><Icon name={k.icon} size={18} /></span>
                <span><b>{k.label}</b><small>{k.hint}</small></span>
              </button>
            ))}
          </div>
          <div className="awf-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void perform(() => post('/ai/operations/jobs', { kind, title: label(kind), idempotencyKey: crypto.randomUUID() }))}>
              <Icon name="play" size={14} />Run now
            </button>
            <span className="awf-or">or repeat it</span>
            <Select className="select awf-repeat" value={String(interval)} onChange={(e) => setIntervalMinutes(Number(e.target.value))} aria-label="How often">
              <option value="60">Hourly</option><option value="1440">Daily</option><option value="10080">Weekly</option>
            </Select>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void perform(() => post('/ai/operations/schedules', { kind, title: label(kind), intervalMinutes: interval }))}>
              <Icon name="repeat" size={14} />Schedule review
            </button>
          </div>
        </div>
      </section>

      <div className="awf-grid">
        <section className="card" aria-labelledby="awf-history">
          <div className="card-head"><div><h3 id="awf-history">Reviews</h3><p>Newest first. Pick one to read it.</p></div></div>
          {!jobs.data?.length ? <div className="card-body"><EmptyState icon="radar" title="No reviews yet" text="Run one above; the result is saved here." /></div> : (
            <ul className="awf-jobs">
              {jobs.data.map((j) => {
                const k = KINDS.find((x) => x.id === j.kind);
                const live = ['queued', 'running'].includes(j.status);
                return (
                  <li key={j.id} className={selected === j.id ? 'on' : ''}>
                    <button type="button" className="awf-job" onClick={() => setSelected(j.id)} aria-current={selected === j.id}>
                      <span className={`awf-dot ${k?.tone ?? ''}`}><Icon name={k?.icon ?? 'radar'} size={14} /></span>
                      <span className="awf-job-text"><b>{j.title}</b><small>{timeAgo(j.createdAt)}</small></span>
                      <span className={`awf-status ${j.status}`}>{live ? `${STATUS[j.status] ?? j.status} · ${j.progress}%` : STATUS[j.status] ?? j.status}</span>
                    </button>
                    {live && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void perform(() => post(`/ai/operations/jobs/${j.id}/cancel`, {}))}>Cancel</button>}
                    {live && <span className="awf-progress" aria-hidden><i style={{ width: `${j.progress}%` }} /></span>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="card awf-detail" aria-labelledby="awf-detail-title">
          {!picked ? (
            <div className="card-body"><EmptyState icon="note" title="Pick a review" text="Its findings, the method behind them and every source appear here." /></div>
          ) : (
            <>
              <div className="card-head"><div><h3 id="awf-detail-title">{picked.title}</h3>{picked.result && <p>Evidence as of {formatDateTime(picked.result.evidenceAt)}</p>}</div></div>
              <div className="card-body awf-body">
                {picked.errorCode && <div className="callout callout-warning" role="alert"><Icon name="alert" size={16} /><div>{picked.errorCode === 'AI_EVIDENCE_ACCESS_CHANGED' ? 'Your access has changed since this review. Run a new review to see current authorized evidence.' : picked.errorCode === 'AI_EVIDENCE_EXPIRED' ? 'Saved review evidence expires after 30 days. Run a new review for current evidence.' : `This review could not finish (${picked.errorCode}).`}</div></div>}
                {picked.result ? (
                  <>
                    <Markdown text={picked.result.summary} />
                    <details className="awf-method"><summary>How this was worked out</summary><p>{picked.result.methodology}</p></details>
                    {picked.result.sources.length > 0 && <><h4>Sources</h4><ul className="awf-sources">{picked.result.sources.map((s) => <li key={`${s.kind}:${s.id}`}><Link to={s.link}>{s.label}</Link>{s.version && <span> · {s.version}</span>}</li>)}</ul></>}
                    <Link className="btn btn-primary btn-sm" to="/ai" state={{ ask: `Review this ${picked.kind} analysis and recommend actions. Retrieve current evidence first.`, ts: Date.now() }}><Icon name="sparkle" size={14} />Ask the agent for actions</Link>
                  </>
                ) : !picked.errorCode && <p className="muted">{picked.status === 'cancelled' ? 'This review was cancelled.' : 'The result appears here when the review finishes.'}</p>}
              </div>
            </>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="awf-schedules">
        <div className="card-head"><div><h3 id="awf-schedules">Scheduled reviews</h3><p>They run in the background and land in Reviews.</p></div></div>
        <div className="card-body">
          {!schedules.data?.length ? <p className="muted">No scheduled reviews. The first one runs shortly after you schedule it.</p> : (
            <ul className="awf-schedules">
              {schedules.data.map((s) => (
                <li key={s.id}>
                  <Icon name="repeat" size={15} />
                  <span><b>{s.title}</b><small>{every(s.intervalMinutes)} · next {formatDateTime(s.nextRunAt)}</small></span>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void perform(() => del(`/ai/operations/schedules/${s.id}`))}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {f && (
        <section className="card" aria-labelledby="awf-forecasts">
          <div className="card-head"><div><h3 id="awf-forecasts">How forecasts turned out</h3><p>{f.methodology}</p></div></div>
          <div className="card-body">
            <div className="awf-stats">
              <div><b>{f.forecasts}</b><span>forecasts recorded</span></div>
              <div><b>{f.verifiedCompletions}</b><span>completions checked</span></div>
              <div><b>{f.comparableProjects}</b><span>comparable projects</span></div>
              <div><b>{f.meanAbsoluteErrorDays == null ? '–' : `${f.meanAbsoluteErrorDays.toFixed(1)}d`}</b><span>average miss</span></div>
            </div>
            {f.items.length > 0 && (
              <div className="table-wrap">
                <table className="awf-table">
                  <thead><tr><th>Project</th><th>Predicted finish</th><th>Finished</th><th className="num">Off by</th><th>Notes</th></tr></thead>
                  <tbody>{f.items.slice(0, 20).map((x) => (
                    <tr key={x.id}><td><Link to={x.link}>{x.project}</Link></td><td>{x.projectedFinish ?? 'not enough evidence'}</td>
                      <td>{x.recordedCompletedAt ? new Date(x.recordedCompletedAt).toLocaleDateString() : 'not yet'}</td>
                      <td className="num">{x.errorDays != null ? `${x.errorDays}d` : '–'}</td>
                      <td className="muted">{[x.scopeChanged && 'scope changed', x.reopened && 'reopened'].filter(Boolean).join(' · ') || '—'}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
