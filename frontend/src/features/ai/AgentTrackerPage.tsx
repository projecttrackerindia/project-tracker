import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { get, put } from '../../api/client';
import { useWsQuery } from '../../lib/hooks';
import { useAuth } from '../../stores/auth';
import { ErrorState, PageHead, PageLoader } from '../../components/ui';

interface Trace {
  agent: string; version: string; correlationId: string; provider: string; model: string; startedAt: string;
  durationMs: number; contextMs: number; firstTokenMs: number | null; promptChars: number; toolDefinitions: number;
  outcome: string; errorCode: string | null; intent?: string | null; intentConfidence?: number | null; intentMs?: number | null;
  models: { step: number; durationMs: number; inputTokens: number; outputTokens: number; stopReason: string }[];
  tools: { name: string; durationMs: number; succeeded: boolean; state: string }[];
}
interface Run { id: string; createdAt: string; status: string; inputTokens: number; outputTokens: number; feedback: string | null; trace: Trace }
interface Tracker {
  agent: { id: string; name: string; version: string; enabled: boolean; provider: string; model: string; capabilities: string[]; maxToolCalls: number; timeoutSeconds: number };
  total: number; succeeded: number; failed: number; partial: number; awaitingConfirmation: number; averageMs: number; p95Ms: number;
  inputTokens: number; outputTokens: number; sampleLimited: boolean; page: number; pageSize: number; runs: Run[];
}
interface Health { configured: boolean; reachable: boolean; modelAvailable: boolean; provider: string; model: string; queueDepth: number; errorCode: string | null }
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function AgentTrackerPage() {
  const client = useQueryClient();
  const role = useAuth((s) => s.ctx?.current?.role);
  const authorized = role === 'Owner' || role === 'Admin';
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [model, setModel] = useState('');
  const [days, setDays] = useState('7');
  const [from, setFrom] = useState(() => new Date(Date.now() - 7 * 86400000).toISOString());
  const [selected, setSelected] = useState<string | null>(null);
  const q = useWsQuery(['ai', 'tracker', page, status, model, from], () => get<Tracker>('/ai/tracker', { page, status: status || undefined, model: model || undefined, from }), { enabled: authorized, staleTime: 15000 });
  const toggle = useMutation({ mutationFn: (enabled: boolean) => put('/ai/tracker/agent', { enabled }), onSuccess: () => { q.refetch(); client.invalidateQueries({ predicate: (query) => query.queryKey.includes('ai') }); } });
  const health = useMutation({ mutationFn: () => get<Health>('/ai/tracker/health') });
  const d = q.data;
  return <>
    <PageHead title="Agent Tracker" sub="Execution outcomes and performance in this workspace. Private conversations stay private." />
    {!authorized ? <p>Only workspace owners and administrators can view Agent Tracker.</p> : <>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <label>Period <select className="input" value={days} onChange={(e) => { setDays(e.target.value); setFrom(new Date(Date.now() - Number(e.target.value) * 86400000).toISOString()); setPage(1); }}>
          <option value="1">Last day</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option>
        </select></label>
        <label>Outcome <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All outcomes</option>{['succeeded', 'awaiting_confirmation', 'partial', 'failed', 'timeout', 'cancelled'].map((s) => <option key={s} value={s}>{s.replaceAll('_', ' ')}</option>)}
        </select></label>
        <label>Model <input className="input" value={model} placeholder="Exact model name" onChange={(e) => { setModel(e.target.value); setPage(1); }} /></label>
        <button className="btn" onClick={() => q.refetch()}>Refresh</button>
      </div>
      {q.isLoading ? <PageLoader /> : q.isError || !d ? <ErrorState error={q.error} retry={() => q.refetch()} /> : <>
        <div className="card"><div className="card-body">
          <div className="row" style={{ justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div><h3>{d.agent.name} · v{d.agent.version}</h3><p>{d.agent.provider} · {d.agent.model || 'Model not configured'} · {d.agent.enabled ? 'Enabled' : 'Disabled'}</p>
              <p className="muted">{d.agent.capabilities.join(' · ')}</p></div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" disabled={toggle.isPending} onClick={() => toggle.mutate(!d.agent.enabled)}>{d.agent.enabled ? 'Disable assistant' : 'Enable assistant'}</button>
              <button className="btn" disabled={health.isPending} onClick={() => health.mutate()}>Check model health</button>
            </div>
          </div>
          {toggle.isError && <ErrorState error={toggle.error} retry={() => toggle.reset()} />}
          {health.isError && <ErrorState error={health.error} retry={() => health.mutate()} />}
          {health.data && <p role="status">{health.data.reachable && health.data.modelAvailable ? 'Model service reachable; configured model installed.' : `Model health: ${health.data.errorCode ?? 'not available'}`} Queue: {health.data.queueDepth}.</p>}
          <p className="muted">{d.agent.maxToolCalls} tool calls maximum · {d.agent.timeoutSeconds}s per model call. Health checks do not run inference.</p>
        </div></div>
        <div className="row" style={{ gap: 24, flexWrap: 'wrap', margin: '20px 0' }}>
          {[['Runs', d.total], ['Succeeded', d.succeeded], ['Failed / timed out', d.failed], ['Partial', d.partial], ['Awaiting confirmation', d.awaitingConfirmation], ['Success rate', d.total ? `${Math.round(d.succeeded / d.total * 100)}%` : '—'], ['Average', seconds(d.averageMs)], ['p95', seconds(d.p95Ms)], ['Input tokens', d.inputTokens.toLocaleString()], ['Output tokens', d.outputTokens.toLocaleString()]].map(([label, value]) => <div key={label}><span className="muted">{label}</span><div><strong>{value}</strong></div></div>)}
        </div>
        <p className="muted">Timing covers context preparation, model calls and tools. Tokens are reported by the provider; missing usage is recorded as zero. Hosting costs are excluded.</p>
        {d.sampleLimited && <p role="status">Metrics cover the latest 10,000 matching runs. Narrow the period for complete results.</p>}
        {d.runs.length === 0 ? <div className="card"><div className="card-body">No recorded runs match these filters. Tracking starts with this release.</div></div> : <div className="table-wrap"><table>
          <thead><tr><th>Started</th><th>Outcome</th><th>Model</th><th>Duration</th><th>First token</th><th>Calls</th><th>Tools</th><th>Details</th></tr></thead>
          <tbody>{d.runs.map((r) => <RunRow key={r.id} run={r} expanded={selected === r.id} select={() => setSelected(selected === r.id ? null : r.id)} />)}</tbody>
        </table></div>}
        <div className="row" style={{ gap: 12, marginTop: 16 }}>
          <button className="btn" disabled={page === 1} onClick={() => { setPage(page - 1); setSelected(null); }}>Previous</button>
          <span>Page {page} of {Math.max(1, Math.ceil(d.total / d.pageSize))}</span>
          <button className="btn" disabled={page * d.pageSize >= d.total} onClick={() => { setPage(page + 1); setSelected(null); }}>Next</button>
        </div>
      </>}
    </>}
  </>;
}

function RunRow({ run: r, expanded, select }: { run: Run; expanded: boolean; select: () => void }) {
  return <>
    <tr><td>{new Date(r.trace.startedAt).toLocaleString()}</td><td>{r.status.replaceAll('_', ' ')}</td><td>{r.trace.model}</td><td>{seconds(r.trace.durationMs)}</td><td>{r.trace.firstTokenMs === null ? '—' : seconds(r.trace.firstTokenMs)}</td><td>{r.trace.models.length}</td><td>{r.trace.tools.length}</td><td><button className="btn" aria-expanded={expanded} onClick={select}>Trace</button></td></tr>
    {expanded && <tr><td colSpan={8}><div className="card-body">
      <p>{r.trace.intent && <>Intent: {r.trace.intent.replaceAll('_', ' ')} · Routing: {r.trace.intentMs ?? 0}ms · </>}Correlation: {r.trace.correlationId} · {r.trace.provider} · Context: {seconds(r.trace.contextMs)} · Prompt: {r.trace.promptChars.toLocaleString()} characters · {r.trace.toolDefinitions} available tools</p>
      {r.trace.errorCode && <p>Error: {r.trace.errorCode}</p>}
      {r.trace.models.map((m, i) => <p key={i}>Model call {i + 1}: {seconds(m.durationMs)} · {m.inputTokens} input / {m.outputTokens} output tokens · {m.stopReason}</p>)}
      {r.trace.tools.map((t, i) => <p key={i}>{t.name}: {seconds(t.durationMs)} · {t.succeeded ? t.state.replaceAll('_', ' ') : 'failed'}</p>)}
      {r.trace.tools.length === 0 && <p className="muted">No tool calls.</p>}
    </div></td></tr>}
  </>;
}
