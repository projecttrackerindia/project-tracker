import { useState } from 'react';
import { Link } from 'react-router-dom';
import { del, get, post } from '../../api/client';
import { useWsQuery } from '../../lib/hooks';
import { PageLoader } from '../../components/ui';
import { Markdown } from './Markdown';

type Kind = 'portfolio' | 'workload' | 'history';
interface Source { kind: string; id: string; label: string; link: string; version?: string }
interface Result { summary: string; evidenceAt: string; methodology: string; sources: Source[] }
interface Job { id: string; kind: Kind; title: string; status: string; progress: number; attempts: number; createdAt: string; errorCode: string | null; result: Result | null }
interface Schedule { id: string; title: string; kind: Kind; intervalMinutes: number; nextRunAt: string; enabled: boolean }
interface ForecastEvaluation { forecasts: number; verifiedCompletions: number; comparableProjects: number; meanAbsoluteErrorDays: number | null; methodology: string; items: { id: string; project: string; link: string; projectedFinish: string | null; recordedCompletedAt: string | null; errorDays: number | null; scopeChanged: boolean; reopened: boolean }[] }
const labels: Record<Kind, string> = { portfolio: 'Portfolio risks and delivery forecast', workload: 'Workload and capacity review', history: 'Delivery history and recurring blockers' };

export function AgentWorkflowsPage() {
  const jobs = useWsQuery(['agent-workflows', 'jobs'], () => get<Job[]>('/ai/operations/jobs'), { refetchInterval: 15_000 });
  const schedules = useWsQuery(['agent-workflows', 'schedules'], () => get<Schedule[]>('/ai/operations/schedules'), { refetchInterval: 60_000 });
  const forecasts = useWsQuery(['agent-workflows', 'forecasts'], () => get<ForecastEvaluation>('/ai/operations/forecasts'));
  const [kind, setKind] = useState<Kind>('portfolio');
  const [interval, setInterval] = useState(1440);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => { await Promise.all([jobs.refetch(), schedules.refetch(), forecasts.refetch()]); };
  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'The review could not be updated.'); }
    finally { setBusy(false); }
  };
  const picked = jobs.data?.find(j => j.id === selected);
  if (jobs.isLoading) return <PageLoader />;
  return <div className="page">
    <div className="page-header"><div><h1>Proactive agent workflows</h1><p>Review delivery, capacity and recurring blockers before you need to ask.</p></div><Link to="/ai" className="btn">Open AI workspace</Link></div>
    {(error || jobs.error || schedules.error) && <div className="alert alert-error" role="alert">{error || jobs.error?.message || schedules.error?.message}</div>}
    <section className="card" style={{ padding: 20, marginBottom: 20 }}>
      <h2>Create a review</h2>
      <p>These reviews use the project data you can access. They do not spend AI credits or change assignments, dates or permissions.</p>
      <label>Review <select value={kind} onChange={e => setKind(e.target.value as Kind)}>{Object.entries(labels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>{' '}
      <button className="btn btn-primary" disabled={busy} onClick={() => void perform(() => post('/ai/operations/jobs', { kind, title: labels[kind], idempotencyKey: crypto.randomUUID() }))}>Run now</button>{' '}
      <label>Repeat <select value={interval} onChange={e => setInterval(Number(e.target.value))}><option value={60}>Hourly</option><option value={1440}>Daily</option><option value={10080}>Weekly</option></select></label>{' '}
      <button className="btn" disabled={busy} onClick={() => void perform(() => post('/ai/operations/schedules', { kind, title: labels[kind], intervalMinutes: interval }))}>Schedule review</button>
    </section>
    <section className="card" style={{ padding: 20, marginBottom: 20 }}><h2>Scheduled reviews</h2>
      {!schedules.data?.length && <p>No scheduled reviews yet. The first review runs shortly after you create a schedule.</p>}
      {schedules.data?.map(s => <div key={s.id} style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}><span>{s.title} · every {s.intervalMinutes / 60} hours · next {new Date(s.nextRunAt).toLocaleString()}</span><button className="btn" disabled={busy} onClick={() => void perform(() => del(`/ai/operations/schedules/${s.id}`))}>Remove schedule</button></div>)}
    </section>
    <section className="card" style={{ padding: 20 }}><h2>Review history</h2>
      {!jobs.data?.length && <p>Your reviews and saved results will appear here.</p>}
      {jobs.data?.map(j => <div key={j.id} style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <button className="btn" onClick={() => setSelected(j.id)}>{j.title}</button><span>{j.status} · {j.progress}% · {new Date(j.createdAt).toLocaleString()}</span>
        {['queued', 'running'].includes(j.status) && <button className="btn" disabled={busy} onClick={() => void perform(() => post(`/ai/operations/jobs/${j.id}/cancel`, {}))}>Cancel</button>}
      </div>)}
    </section>
    {forecasts.data && <section className="card" style={{ padding: 20, marginTop: 20 }}><h2>Forecast outcome evidence</h2>
      <p>{forecasts.data.forecasts} recorded forecasts; {forecasts.data.verifiedCompletions} audited completions; {forecasts.data.comparableProjects} comparable projects. {forecasts.data.meanAbsoluteErrorDays == null ? 'No comparable error measurement yet.' : `Mean absolute error: ${forecasts.data.meanAbsoluteErrorDays.toFixed(1)} days.`}</p>
      <p>{forecasts.data.methodology}</p>
      {forecasts.data.items.slice(0, 20).map(f => <p key={f.id}><Link to={f.link}>{f.project}</Link> · predicted {f.projectedFinish ?? 'insufficient evidence'} · recorded completion {f.recordedCompletedAt ? new Date(f.recordedCompletedAt).toLocaleDateString() : 'not yet observed'}{f.errorDays != null && ` · ${f.errorDays} days from prediction`}{f.scopeChanged && ' · scope changed'}{f.reopened && ' · reopened or unfinished work'}</p>)}
    </section>}
    {picked && <section className="card" style={{ padding: 20, marginTop: 20 }}><h2>{picked.title}</h2>
      {picked.errorCode && <p role="alert">{picked.errorCode === 'AI_EVIDENCE_ACCESS_CHANGED' ? 'Your access has changed since this review. Run a new review to see current authorized evidence.' : `This review could not finish (${picked.errorCode}).`}</p>}
      {picked.result ? <><p>Evidence as of {new Date(picked.result.evidenceAt).toLocaleString()}</p><Markdown text={picked.result.summary} /><p>{picked.result.methodology}</p><h3>Sources</h3><ul>{picked.result.sources.map(s => <li key={`${s.kind}:${s.id}`}><Link to={s.link}>{s.label}</Link>{s.version && ` · ${s.version}`}</li>)}</ul><Link to="/ai" state={{ ask: `Review this ${picked.kind} analysis and recommend actions. Retrieve current evidence first.`, ts: Date.now() }}>Ask the agent to investigate and propose actions</Link></> : !picked.errorCode && <p>{picked.status === 'cancelled' ? 'This review was cancelled.' : 'A result will appear when the worker finishes.'}</p>}
    </section>}
  </div>;
}
