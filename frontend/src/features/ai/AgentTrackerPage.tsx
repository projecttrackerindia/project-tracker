import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient , keepPreviousData } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { AgentMark } from '../../components/AgentMark';
import { Icon, type IconName } from '../../components/Icon';
import { EmptyState, ErrorState, PageLoader } from '../../components/ui';
import { formatDateTime , plural } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useAuth } from '../../stores/auth';
import { ActivityChart, BarList, FleetTrend, Histogram, LatencyTrend, Ring, Spark, StackBar } from './tracker/TrackerCharts';
import { compact, KIND_LABEL, KIND_ORDER, pct, secs, series, SOURCE_LABEL, STATUS, trackerApi, words, type Fleet, type Run, type Tracker } from './tracker/types';
import { AlertList, AlertsView, CostView, TrustPanels } from './tracker/TrackerWatch';
import type { Alerts } from './tracker/types';
import { AgentsHubNav } from '../agents/AgentsHubNav';
import './tracker/tracker.css';

type Tab = 'overview' | 'assistant' | 'agent' | 'meetings' | 'costs' | 'alerts' | 'runs';
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' }, { id: 'assistant', label: 'Assistant', icon: 'agent' }, { id: 'agent', label: 'Project agent', icon: 'sparkle' },
  { id: 'meetings', label: 'Meetings & follow-ups', icon: 'video' }, { id: 'costs', label: 'Credits', icon: 'bolt' }, { id: 'alerts', label: 'Alerts', icon: 'radar' },
  { id: 'runs', label: 'Runs', icon: 'list' },
];
const PERIODS = [{ days: 1, label: '24 hours' }, { days: 7, label: '7 days' }, { days: 30, label: '30 days' }];
const statusLabel = (s: string) => (s === 'awaiting_confirmation' ? 'awaiting approval' : words(s));
const OUTCOMES = ['succeeded', 'awaiting_confirmation', 'partial', 'failed', 'timeout', 'cancelled', 'executing'];
const outcomeTone = (s: string) => (s === 'succeeded' ? 'good' : s === 'partial' ? 'warn' : s === 'awaiting_confirmation' || s === 'executing' ? 'info' : 'bad');

/**
 * Agent Tracker: how every agent in the workspace is doing - the assistant (runs, outcomes, speed, tools, models, feedback), the project agent
 * (readings, proposals and how people decided on them), the meeting bot and follow-ups - with each run's trace one tap away. Operational
 * data only: private conversations stay private. Owners and admins.
 */
export function AgentTrackerPage() {
  const client = useQueryClient();
  const role = useAuth((s) => s.ctx?.current?.role);
  const authorized = role === 'Owner' || role === 'Admin';
  // The open tab lives in the address: it survives a reload or the switch between the phone and desktop layouts, and a link can open it.
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.some((t) => t.id === params.get('tab')) ? (params.get('tab') as Tab) : 'overview';
  const setTab = (t: Tab) => setParams((p) => { const n = new URLSearchParams(p); if (t === 'overview') n.delete('tab'); else n.set('tab', t); return n; }, { replace: true });
  const [days, setDays] = useState(7);
  const from = useMemo(() => new Date(Math.floor(Date.now() / 60_000) * 60_000 - days * 86_400_000).toISOString(), [days]);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [model, setModel] = useState('');
  const [intent, setIntent] = useState('');
  const q = useWsQuery(['ai', 'tracker', page, status, model, intent, from], () => trackerApi.list({ page, status: status || undefined, model: model || undefined, intent: intent || undefined, from }),
    { enabled: authorized, staleTime: 15_000, placeholderData: keepPreviousData });   // a new period keeps the page in place while it loads
  const fleet = useWsQuery(['ai', 'tracker', 'fleet', from], () => trackerApi.fleet(from), { enabled: authorized, staleTime: 30_000, placeholderData: keepPreviousData });
  const alerts = useWsQuery(['ai', 'tracker', 'alerts'], () => trackerApi.alerts(), { enabled: authorized, staleTime: 60_000 });
  // On a phone the tab row scrolls: keep the open tab in view.
  const tabsRef = useRef<HTMLElement>(null);
  useEffect(() => { tabsRef.current?.querySelector<HTMLElement>('button.on')?.scrollIntoView?.({ inline: 'center', block: 'nearest' }); }, [tab]);
  const toggle = useMutation({ mutationFn: (enabled: boolean) => trackerApi.setEnabled(enabled), onSuccess: () => { void q.refetch(); void client.invalidateQueries({ predicate: (x) => x.queryKey.includes('ai') }); } });
  const health = useMutation({ mutationFn: () => trackerApi.health() });
  const filter = (f: { status?: string; intent?: string; model?: string }) => {
    if (f.status !== undefined) setStatus(f.status); if (f.intent !== undefined) setIntent(f.intent); if (f.model !== undefined) setModel(f.model);
    setPage(1); setTab('runs');
  };

  if (!authorized) return <div className="trk"><EmptyState icon="lock" title="Owners and admins only" text="Agent Tracker shows how the workspace's agents perform. Ask an owner or admin." /></div>;
  const d = q.data;
  return (
    <div className={`trk ${q.isPlaceholderData || fleet.isPlaceholderData ? 'trk-refreshing' : ''}`}>
      <AgentsHubNav sub="How every agent in the workspace is doing" />
      <header className="trk-hero">
        <div className="trk-hero-glow" aria-hidden />
        <div className="trk-hero-row">
          <span className="trk-hero-mark"><AgentMark size={34} animated={!!d?.agent.enabled} /></span>
          <div className="trk-hero-text">
            <h1>Agent Tracker</h1>
            <p>Every agent in this workspace - how often it works, how fast, what it costs and where it struggles. Private conversations stay private.</p>
          </div>
          <div className="trk-hero-actions">
            <div className="trk-seg" role="group" aria-label="Period">
              {PERIODS.map((p) => <button key={p.days} type="button" className={days === p.days ? 'on' : ''} aria-pressed={days === p.days} onClick={() => { setDays(p.days); setPage(1); }}>{p.label}</button>)}
            </div>
            <button type="button" className="trk-icon-btn" aria-label="Refresh" title="Refresh" onClick={() => { void q.refetch(); void fleet.refetch(); }}><Icon name="refresh" size={16} /></button>
          </div>
        </div>
        {d && (
          <div className="trk-status-row">
            <span className={`trk-chip ${d.agent.enabled ? 'on' : 'off'}`}><i />{d.agent.enabled ? 'Assistant on' : 'Assistant off'}</span>
            <span className="trk-chip"><Icon name="layers" size={12} />{d.agent.provider}</span>
            <span className="trk-chip"><Icon name="code" size={12} />{d.agent.model || 'No model configured'}</span>
            <span className="trk-chip"><Icon name="bolt" size={12} />{d.agent.maxToolCalls} tools per run · {d.agent.timeoutSeconds}s per call</span>
            <span className="trk-spacer" />
            <button type="button" className="trk-ghost" disabled={health.isPending} onClick={() => health.mutate()}>{health.isPending ? <span className="spinner" /> : <Icon name="activity" size={14} />}Check model health</button>
            <button type="button" className="trk-ghost" disabled={toggle.isPending} onClick={() => toggle.mutate(!d.agent.enabled)}><Icon name={d.agent.enabled ? 'pause' : 'play'} size={14} />{d.agent.enabled ? 'Switch assistant off' : 'Switch assistant on'}</button>
          </div>
        )}
        {health.data && (
          <p className={`trk-health ${health.data.reachable && health.data.modelAvailable ? 'ok' : 'bad'}`} role="status">
            <Icon name={health.data.reachable && health.data.modelAvailable ? 'checkCircle' : 'alert'} size={14} />
            {health.data.reachable && health.data.modelAvailable ? 'Model service reachable and the configured model is installed.' : `Model health: ${health.data.errorCode ?? 'not available'}.`}
            {' '}Queue {health.data.queueDepth}{health.data.maxConcurrentRequests != null ? ` · ${health.data.activeRequests ?? 0}/${health.data.maxConcurrentRequests} running, ${health.data.queueDepth}/${health.data.maxQueuedRequests} waiting, ${health.data.queueTimeoutSeconds}s wait limit` : ''}.
          </p>
        )}
        {(toggle.isError || health.isError) && <ErrorState error={toggle.error ?? health.error} retry={() => { toggle.reset(); health.reset(); }} />}
      </header>

      <nav className="trk-tabs" aria-label="Agent Tracker" ref={tabsRef}>
        {TABS.map((t) => <button key={t.id} type="button" className={tab === t.id ? 'on' : ''} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}><Icon name={t.icon} size={15} /><span>{t.label}</span>
          {t.id === 'alerts' && !!alerts.data?.active.length && <em className={`trk-tab-count sev-${alerts.data.active.some((a) => a.severity === 'critical') ? 'critical' : 'warning'}`} aria-label={`${alerts.data.active.length} active`}>{alerts.data.active.length}</em>}</button>)}
      </nav>

      {q.isLoading ? <PageLoader /> : q.isError || !d ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
        <>
          {d.sampleLimited && <p className="trk-note"><Icon name="info" size={13} />Figures cover the latest 10,000 matching runs - choose a shorter period for complete results.</p>}
          {tab === 'overview' && <Overview d={d} fleet={fleet.data} alerts={alerts.data} onFilter={filter} goTo={setTab} />}
          {tab === 'assistant' && <AssistantView d={d} onFilter={filter} />}
          {tab === 'agent' && (fleet.isLoading ? <PageLoader /> : fleet.data ? <ProjectAgentView f={fleet.data} /> : <ErrorState error={fleet.error} retry={() => fleet.refetch()} />)}
          {tab === 'meetings' && (fleet.isLoading ? <PageLoader /> : fleet.data ? <MeetingsView f={fleet.data} /> : <ErrorState error={fleet.error} retry={() => fleet.refetch()} />)}
          {tab === 'costs' && <CostView />}
          {tab === 'alerts' && (alerts.isError ? <ErrorState error={alerts.error} retry={() => alerts.refetch()} /> : <AlertsView alerts={alerts.data} onOpen={(t) => setTab(t as Tab)} />)}
          {tab === 'runs' && <RunsView d={d} page={page} setPage={setPage} status={status} model={model} intent={intent} onFilter={(f) => { filter(f); }} />}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ helpers

const bucketLabel = (iso: string, unit: 'hour' | 'day') => {
  const t = new Date(iso);
  return unit === 'hour' ? t.toLocaleTimeString([], { hour: 'numeric' }) : t.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

function Panel({ title, icon, hint, children, className, action }: { title: string; icon: IconName; hint?: string; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <section className={`trk-panel ${className ?? ''}`}>
      <header><h3><Icon name={icon} size={15} />{title}</h3>{action}</header>
      {hint && <p className="trk-hint">{hint}</p>}
      {children}
    </section>
  );
}

function Kpi({ label, value, sub, tone, icon }: { label: string; value: string | number; sub?: string; tone: string; icon: IconName }) {
  return (
    <div className={`trk-kpi trk-tone-${tone}`}>
      <span className="trk-kpi-icon"><Icon name={icon} size={16} /></span>
      <div><b>{value}</b><span>{label}</span>{sub && <small>{sub}</small>}</div>
    </div>
  );
}

// ------------------------------------------------------------------ overview

function Overview({ d, fleet, alerts, onFilter, goTo }: { d: Tracker; fleet?: Fleet; alerts?: Alerts; onFilter: (f: { status?: string; intent?: string }) => void; goTo: (t: Tab) => void }) {
  const ins = d.insights;
  const timeline = (ins?.timeline ?? []).map((b) => ({ label: bucketLabel(b.at, ins!.bucketUnit), succeeded: b.succeeded, partial: b.partial, awaiting: b.awaiting, failed: b.failed }));
  const runsSpark = (ins?.timeline ?? []).map((b) => b.succeeded + b.partial + b.awaiting + b.failed);
  const f = fleet;
  const decided = f ? f.projectAgent.approved + f.projectAgent.dismissed : 0;
  const cards: { id: Tab; name: string; icon: IconName; accent: string; big: string; bigLabel: string; facts: string[]; spark: number[] }[] = [
    { id: 'assistant', name: 'Project Assistant', icon: 'agent', accent: 'indigo', big: `${pct(d.succeeded, d.total) ?? '–'}${d.total ? '%' : ''}`, bigLabel: 'runs succeed',
      facts: [`${compact(d.total)} runs`, `typical ${secs(d.p50Ms)}`, `${compact(d.inputTokens + d.outputTokens)} tokens`], spark: runsSpark },
    { id: 'agent', name: 'Project agent', icon: 'sparkle', accent: 'emerald', big: f ? `${pct(f.projectAgent.approved, decided) ?? '–'}${decided ? '%' : ''}` : '…', bigLabel: 'proposals approved',
      facts: f ? [`${plural(f.projectAgent.projectsOn, 'project')} on`, plural(f.projectAgent.readings, 'reading'), plural(f.projectAgent.findings, 'proposal')] : [], spark: (f?.days ?? []).map((x) => x.findings) },
    { id: 'meetings', name: 'Meeting bot', icon: 'video', accent: 'amber', big: f ? `${pct(f.meetings.attended, f.meetings.sessions) ?? '–'}${f.meetings.sessions ? '%' : ''}` : '…', bigLabel: 'sessions attended',
      facts: f ? [`${f.meetings.sessions} sessions`, `${f.meetings.delegations} sent in someone's place`, `${f.meetings.minutesSent} minutes sent`] : [], spark: (f?.days ?? []).map((x) => x.meetings) },
    { id: 'meetings', name: 'Follow-ups', icon: 'flag', accent: 'rose', big: f ? `${pct(f.followUps.kept, f.followUps.kept + f.followUps.missed) ?? '–'}${f.followUps.kept + f.followUps.missed ? '%' : ''}` : '…', bigLabel: 'commitments kept',
      facts: f ? [`${f.followUps.commitments} commitments`, `${f.followUps.answered}/${f.followUps.checkInsSent} check-ins answered`, `${f.followUps.changeRequests} change requests`] : [], spark: (f?.days ?? []).map((x) => x.decided) },
  ];
  return (
    <div className="trk-stack-page">
      {!!alerts?.active.length && (
        <section className="trk-panel trk-attention" aria-label="Needs attention">
          <header><h3><Icon name="radar" size={15} />Needs attention</h3><button type="button" className="trk-link" onClick={() => goTo('alerts')}>Alert settings<Icon name="arrowRight" size={12} /></button></header>
          <AlertList alerts={alerts.active.slice(0, 3)} compactView onOpen={(t) => goTo(t as Tab)} />
        </section>
      )}
      <div className="trk-agents">
        {cards.map((c) => (
          <button key={c.name} type="button" className={`trk-agent trk-accent-${c.accent}`} onClick={() => goTo(c.id)}>
            <span className="trk-agent-top"><span className="trk-agent-icon"><Icon name={c.icon} size={18} /></span><b>{c.name}</b><Icon name="arrowRight" size={14} /></span>
            <span className="trk-agent-big"><strong>{c.big}</strong><span>{c.bigLabel}</span></span>
            <Spark values={c.spark} color={`var(--trk-accent)`} />
            <span className="trk-agent-facts">{c.facts.map((x) => <em key={x}>{x}</em>)}</span>
          </button>
        ))}
      </div>

      <div className="trk-grid-2">
        <Panel title="Assistant runs" icon="chart" hint={`Per ${ins?.bucketUnit ?? 'day'}, by outcome. Hover a bar for the numbers.`}>
          {d.total === 0 ? <EmptyState icon="chart" title="No runs in this period" text="Runs appear as people use the assistant." /> : (
            <>
              <div className="trk-chart"><ActivityChart data={timeline} unit={ins?.bucketUnit ?? 'day'} /></div>
              <ul className="trk-legend">{STATUS.map((s) => <li key={s.key}><i style={{ background: s.color }} />{s.label}</li>)}</ul>
            </>
          )}
        </Panel>
        <Panel title="Agent fleet activity" icon="activity" hint="Project agent readings and proposals, decisions made on them and meeting sessions, per day.">
          {!f ? <PageLoader /> : (
            <>
              <div className="trk-chart"><FleetTrend data={f.days.map((x) => ({ label: new Date(`${x.day}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' }), ...x }))}
                lines={[{ key: 'readings', label: 'Readings' }, { key: 'findings', label: 'Proposals' }, { key: 'decided', label: 'Decided' }, { key: 'meetings', label: 'Meetings' }]} /></div>
              <ul className="trk-legend">{['Readings', 'Proposals', 'Decided', 'Meetings'].map((l, i) => <li key={l}><i style={{ background: series(i) }} />{l}</li>)}</ul>
            </>
          )}
        </Panel>
      </div>

      <div className="trk-grid-3">
        <Panel title="Health at a glance" icon="gauge">
          <div className="trk-rings">
            <Ring value={pct(d.succeeded, d.total)} label="Success" tone="var(--trk-good)" sub={`${d.succeeded}/${d.total}`} />
            <Ring value={ins ? pct(ins.feedbackUp, ins.feedbackUp + ins.feedbackDown) : null} label="Helpful" tone="var(--trk-s1)" sub={ins ? `${ins.feedbackUp} up · ${ins.feedbackDown} down` : undefined} />
            <Ring value={f ? pct(f.projectAgent.approved, f.projectAgent.approved + f.projectAgent.dismissed) : null} label="Approved" tone="var(--trk-s3)" sub="agent proposals" />
          </div>
        </Panel>
        <Panel title="Most frequent problems" icon="alert" action={d.frequentErrors?.length ? <button type="button" className="trk-link" onClick={() => onFilter({ status: 'failed' })}>See failed runs</button> : undefined}>
          {!d.frequentErrors?.length ? <p className="trk-calm"><Icon name="checkCircle" size={15} />No errors in this period.</p> : (
            <BarList rows={d.frequentErrors.slice(0, 6).map((e) => ({ label: words(e.code), value: e.count }))} color="var(--trk-bad)" unit={(v) => `${v} run${v === 1 ? '' : 's'}`} />
          )}
        </Panel>
        <Panel title="Slowest requests" icon="clock">
          {!d.slowestPaths?.length ? <p className="trk-hint">No runs yet.</p> : (
            <ul className="trk-paths">
              {d.slowestPaths.slice(0, 5).map((p) => (
                <li key={p.intent}><button type="button" onClick={() => onFilter({ intent: p.intent })}><span>{words(p.intent)}</span><b>{secs(p.p95Ms)}</b><small>{p.requests} runs · typical {secs(p.p50Ms)}</small></button></li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ assistant

function AssistantView({ d, onFilter }: { d: Tracker; onFilter: (f: { status?: string; intent?: string; model?: string }) => void }) {
  const ins = d.insights;
  const ph = ins?.phases;
  const phaseParts = ph ? [
    { label: 'Context', value: ph.contextMs, color: 'var(--trk-s1)', hint: secs(ph.contextMs) },
    { label: 'Routing', value: ph.routingMs, color: 'var(--trk-s2)', hint: secs(ph.routingMs) },
    { label: 'Model', value: ph.modelMs, color: 'var(--trk-s3)', hint: secs(ph.modelMs) },
    { label: 'Tools', value: ph.toolMs, color: 'var(--trk-s4)', hint: secs(ph.toolMs) },
    { label: 'Other', value: ph.otherMs, color: 'var(--trk-s5)', hint: secs(ph.otherMs) },
  ] : [];
  const trend = (ins?.timeline ?? []).filter((b) => b.p50Ms > 0).map((b) => ({ label: bucketLabel(b.at, ins!.bucketUnit), p50: b.p50Ms, p95: b.p95Ms }));
  return (
    <div className="trk-stack-page">
      <div className="trk-kpis">
        <Kpi label="Runs" value={compact(d.total)} sub={`${d.modelCalls} model calls`} tone="indigo" icon="play" />
        <Kpi label="Succeeded" value={`${pct(d.succeeded, d.total) ?? '–'}${d.total ? '%' : ''}`} sub={`${d.failed} failed · ${d.partial} partial`} tone="emerald" icon="checkCircle" />
        <Kpi label="Typical time" value={secs(d.p50Ms)} sub={`slow (p95) ${secs(d.p95Ms)}`} tone="violet" icon="timer" />
        <Kpi label="First words" value={ins?.firstTokenP50Ms != null ? secs(ins.firstTokenP50Ms) : '–'} sub="typical time to first token" tone="sky" icon="bolt" />
        <Kpi label="Tokens" value={compact(d.inputTokens + d.outputTokens)} sub={`${compact(d.inputTokens)} in · ${compact(d.outputTokens)} out${ins?.cacheReadTokens ? ` · ${compact(ins.cacheReadTokens)} cached` : ''}`} tone="amber" icon="coin" />
        <Kpi label="Waiting for approval" value={d.awaitingConfirmation} sub={`${compact(d.databaseCommands)} database commands`} tone="rose" icon="shield" />
      </div>

      <div className="trk-grid-2">
        <Panel title="How long runs take" icon="timer" hint="Number of runs by duration, from the first word typed to the last answer.">
          <div className="trk-chart short"><Histogram data={(ins?.latency ?? []).map((b) => ({ label: b.label, count: b.count }))} /></div>
        </Panel>
        <Panel title="Speed over time" icon="activity" hint="Typical (p50) and slow (p95) run time.">
          {trend.length < 2 ? <p className="trk-hint">Not enough runs yet to draw a trend.</p> : (
            <>
              <div className="trk-chart short"><LatencyTrend data={trend} /></div>
              <ul className="trk-legend"><li><i style={{ background: series(0) }} />Typical (p50)</li><li><i style={{ background: series(1) }} />Slow (p95)</li></ul>
            </>
          )}
        </Panel>
      </div>

      <Panel title="Where the time goes" icon="layers" hint="Average per run. Model time includes queueing and transport.">
        <StackBar parts={phaseParts} height={16} />
      </Panel>

      <div className="trk-grid-3">
        <Panel title="Tools" icon="bolt" hint="Calls in this period; the red part failed.">
          {!ins?.tools.length ? <p className="trk-hint">No tool calls.</p> : <BarList rows={ins.tools.map((t) => ({ label: words(t.name), value: t.calls, bad: t.failures, note: `avg ${secs(t.averageMs)}` }))} color="var(--trk-s1)" />}
        </Panel>
        <Panel title="Models" icon="code">
          {!ins?.models.length ? <p className="trk-hint">No runs.</p> : (
            <ul className="trk-models">
              {ins.models.map((m) => (
                <li key={m.model}>
                  <button type="button" onClick={() => onFilter({ model: m.model })}><b>{m.model}</b><span>{m.runs} runs · avg {secs(m.averageMs)}</span></button>
                  <StackBar legend={false} height={6} parts={[{ label: 'Input tokens', value: m.inputTokens, color: 'var(--trk-s7)' }, { label: 'Output tokens', value: m.outputTokens, color: 'var(--trk-s2)' }]} />
                  <small>{compact(m.inputTokens)} in · {compact(m.outputTokens)} out</small>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Actions it proposed" icon="checks" hint="Changes the assistant offered to make, confirmed by a person.">
          {!ins?.actions.length ? <p className="trk-hint">No actions in this period.</p> : <BarList rows={ins.actions.map((a) => ({ label: words(a.kind), value: a.count, bad: a.failed, note: `${a.confirmed} confirmed` }))} color="var(--trk-s3)" />}
        </Panel>
      </div>

      {!!d.slowestPaths?.length && (
        <Panel title="Request types, slowest first" icon="clock" hint="Each bar runs from the typical time (p50) to the slow time (p95). Select one to see its runs.">
          <ul className="trk-ranges">
            {(() => { const max = Math.max(1, ...d.slowestPaths!.map((p) => p.p95Ms)); return d.slowestPaths!.map((p) => (
              <li key={p.intent}>
                <button type="button" onClick={() => onFilter({ intent: p.intent })}>
                  <span className="trk-range-label"><b>{words(p.intent)}</b><small>{p.requests} runs{p.failures ? ` · ${p.failures} failed or partial` : ''}</small></span>
                  <span className="trk-range-track"><i style={{ left: `${(p.p50Ms / max) * 100}%`, width: `${Math.max(1.5, ((p.p95Ms - p.p50Ms) / max) * 100)}%` }} /></span>
                  <span className="trk-range-vals">{secs(p.p50Ms)} – {secs(p.p95Ms)}</span>
                </button>
              </li>
            )); })()}
          </ul>
        </Panel>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ project agent

function ProjectAgentView({ f }: { f: Fleet }) {
  const a = f.projectAgent;
  const kinds = [...a.kinds].sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind));
  const maxKind = Math.max(1, ...kinds.map((k) => k.found));
  const decided = a.approved + a.dismissed;
  return (
    <div className="trk-stack-page">
      <div className="trk-kpis">
        <Kpi label="Projects with the agent on" value={a.projectsOn} tone="emerald" icon="folder" />
        <Kpi label="Readings" value={a.readings} sub={a.failedReadings ? `${a.failedReadings} failed` : 'none failed'} tone="indigo" icon="note" />
        <Kpi label="Proposals" value={a.findings} sub={`${a.pending} waiting`} tone="violet" icon="sparkle" />
        <Kpi label="Approved" value={`${pct(a.approved, decided) ?? '–'}${decided ? '%' : ''}`} sub={`${a.approved} approved · ${a.dismissed} dismissed`} tone="sky" icon="checkCircle" />
        <Kpi label="Done by the agent itself" value={a.autoApplied} sub="autonomy level 4" tone="amber" icon="bolt" />
        <Kpi label="Time to decide" value={a.averageDecisionHours == null ? '–' : a.averageDecisionHours < 1 ? `${Math.round(a.averageDecisionHours * 60)}m` : `${a.averageDecisionHours}h`} sub={`${compact(a.credits)} AI credits`} tone="rose" icon="clock" />
      </div>

      <div className="trk-grid-2">
        <Panel title="From reading to done" icon="workflow" hint="What the agent found, what people decided and what they kept.">
          <div className="trk-funnel">
            {[
              { label: 'Proposed', value: a.findings, color: 'var(--trk-s1)' },
              { label: 'Decided', value: decided, color: 'var(--trk-s7)' },
              { label: 'Approved', value: a.approved, color: 'var(--trk-s3)' },
              { label: 'By the agent', value: a.autoApplied, color: 'var(--trk-s4)' },
            ].map((s, i, all) => (
              <div key={s.label} className="trk-funnel-step">
                <span className="trk-funnel-bar" style={{ width: `${Math.max(4, (s.value / Math.max(1, all[0].value)) * 100)}%`, background: s.color }} />
                <span className="trk-funnel-text"><b>{s.value}</b>{s.label}{i > 0 && all[0].value > 0 ? <small>{pct(s.value, all[0].value)}%</small> : null}</span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Autonomy across projects" icon="shield" hint="How much each project's agent may do by itself.">
          <StackBar height={16} parts={[
            { label: '1 Observer', value: a.atLevel1, color: 'var(--trk-s1)' }, { label: '2 Assistant', value: a.atLevel2, color: 'var(--trk-s2)' },
            { label: '3 Participant', value: a.atLevel3, color: 'var(--trk-s3)' }, { label: '4 Delegate', value: a.atLevel4, color: 'var(--trk-s4)' },
          ]} />
          <h4 className="trk-sub">What it reads</h4>
          {a.sources.length === 0 ? <p className="trk-hint">Nothing read in this period.</p>
            : <BarList rows={a.sources.map((s) => ({ label: SOURCE_LABEL[s.source] ?? s.source, value: s.signals }))} color="var(--trk-s7)" unit={(v) => `${v}`} />}
        </Panel>
      </div>

      <Panel title="Proposals by kind" icon="layers" hint="Each bar is split into approved, done by the agent, dismissed and waiting.">
        {kinds.length === 0 ? <EmptyState icon="sparkle" title="No proposals in this period" text="Switch the agent on in a project (project › Agent) and it starts reading mail, chat and meetings." /> : (
          <>
            <ul className="trk-kinds">
              {kinds.map((k) => (
                <li key={k.kind}>
                  <span className="trk-kind-label">{KIND_LABEL[k.kind] ?? words(k.kind)}</span>
                  <span className="trk-kind-bar" style={{ width: `${(k.found / maxKind) * 100}%` }} title={`${k.found} proposed: ${k.approved - k.auto} approved, ${k.auto} by the agent, ${k.dismissed} dismissed, ${k.pending} waiting`}>
                    {k.approved - k.auto > 0 && <i style={{ flexGrow: k.approved - k.auto, background: 'var(--trk-good)' }} />}
                    {k.auto > 0 && <i style={{ flexGrow: k.auto, background: 'var(--trk-s4)' }} />}
                    {k.dismissed > 0 && <i style={{ flexGrow: k.dismissed, background: 'var(--trk-muted)' }} />}
                    {k.pending > 0 && <i style={{ flexGrow: k.pending, background: 'var(--trk-info)' }} />}
                  </span>
                  <b>{k.found}</b>
                </li>
              ))}
            </ul>
            <ul className="trk-legend">
              <li><i style={{ background: 'var(--trk-good)' }} />Approved</li><li><i style={{ background: 'var(--trk-s4)' }} />By the agent</li>
              <li><i style={{ background: 'var(--trk-muted)' }} />Dismissed</li><li><i style={{ background: 'var(--trk-info)' }} />Waiting</li>
            </ul>
          </>
        )}
      </Panel>

      <TrustPanels f={f} />

      {f.projects.length > 0 && (
        <Panel title="Projects" icon="folder">
          <div className="trk-table-wrap">
            <table className="trk-table">
              <thead><tr><th>Project</th><th>Level</th><th>Readings</th><th>Proposals</th><th>Decisions</th><th aria-label="Approved share" /></tr></thead>
              <tbody>{f.projects.map((p) => (
                <tr key={p.projectId}>
                  <td><Link to={`/projects/${p.projectId}?tab=agent`}><b>{p.key}</b> {p.name}</Link></td>
                  <td>{p.level ? <span className={`trk-level l${p.level}`}>{p.level}</span> : <span className="trk-dim">off</span>}</td>
                  <td>{p.readings}</td><td>{p.findings}{p.pending ? <small> · {p.pending} waiting</small> : null}</td>
                  <td>{p.approved} approved · {p.dismissed} dismissed</td>
                  <td className="trk-mini"><StackBar legend={false} height={6} parts={[{ label: 'Approved', value: p.approved, color: 'var(--trk-good)' }, { label: 'Dismissed', value: p.dismissed, color: 'var(--trk-muted)' }, { label: 'Waiting', value: p.pending, color: 'var(--trk-info)' }]} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ meetings and follow-ups

function MeetingsView({ f }: { f: Fleet }) {
  const m = f.meetings; const u = f.followUps;
  return (
    <div className="trk-stack-page">
      <div className="trk-kpis">
        <Kpi label="Bot sessions" value={m.sessions} sub={`${m.attended} attended · ${m.failed} failed`} tone="amber" icon="video" />
        <Kpi label="Meet's own transcripts" value={m.meetTranscripts} sub="read without a bot" tone="sky" icon="note" />
        <Kpi label="Minutes e-mailed" value={m.minutesSent} tone="indigo" icon="mail" />
        <Kpi label="Sent in someone's place" value={m.delegations} sub={`${m.delegationsReported} reported back`} tone="violet" icon="agent" />
        <Kpi label="Commitments" value={u.commitments} sub={`${u.open} open`} tone="emerald" icon="flag" />
        <Kpi label="Change requests" value={u.changeRequests} sub="more time or blocked" tone="rose" icon="clock" />
      </div>
      <div className="trk-grid-2">
        <Panel title="Meeting sessions" icon="video">
          <div className="trk-rings">
            <Ring value={pct(m.attended, m.sessions)} label="Attended" tone="var(--trk-s4)" sub={`${m.attended}/${m.sessions}`} />
            <Ring value={pct(m.delegationsReported, m.delegations)} label="Reported" tone="var(--trk-s7)" sub="delegations" />
          </div>
          <StackBar parts={[{ label: 'Attended', value: m.attended, color: 'var(--trk-good)' }, { label: 'Failed', value: m.failed, color: 'var(--trk-bad)' }, { label: 'Other', value: Math.max(0, m.sessions - m.attended - m.failed), color: 'var(--trk-muted)' }]} />
          {m.failed > 0 && <p className="trk-hint">Sessions fail when nobody lets the bot in, the host refuses it or no bot worker is free - see each project's meetings.</p>}
        </Panel>
        <Panel title="Commitments" icon="flag" hint="Work agreed with an owner and a date, followed up on its due day.">
          <div className="trk-rings">
            <Ring value={pct(u.kept, u.kept + u.missed)} label="Kept" tone="var(--trk-good)" sub={`${u.kept} of ${u.kept + u.missed}`} />
            <Ring value={pct(u.answered, u.checkInsSent)} label="Answered" tone="var(--trk-s1)" sub="check-ins" />
          </div>
          <StackBar parts={[{ label: 'Kept', value: u.kept, color: 'var(--trk-good)' }, { label: 'Moved', value: u.moved, color: 'var(--trk-warn)' }, { label: 'Missed', value: u.missed, color: 'var(--trk-bad)' }, { label: 'Open', value: u.open, color: 'var(--trk-muted)' }]} />
        </Panel>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ runs

function RunsView({ d, page, setPage, status, model, intent, onFilter }: { d: Tracker; page: number; setPage: (p: number) => void; status: string; model: string; intent: string; onFilter: (f: { status?: string; intent?: string; model?: string }) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
  return (
    <div className="trk-stack-page">
      <div className="trk-filters">
        <div className="trk-chips" role="group" aria-label="Outcome">
          <button type="button" className={status === '' ? 'on' : ''} onClick={() => onFilter({ status: '' })}>All</button>
          {OUTCOMES.map((s) => <button key={s} type="button" className={`${status === s ? 'on' : ''} t-${outcomeTone(s)}`} onClick={() => onFilter({ status: s })}><i />{statusLabel(s)}</button>)}
        </div>
        <input className="input" value={model} placeholder="Model" aria-label="Model" onChange={(e) => onFilter({ model: e.target.value })} />
        <input className="input" value={intent} placeholder="Request type" aria-label="Request type" onChange={(e) => onFilter({ intent: e.target.value })} />
        {(status || model || intent) && <button type="button" className="trk-link" onClick={() => onFilter({ status: '', model: '', intent: '' })}>Clear</button>}
      </div>
      {d.runs.length === 0 ? <EmptyState icon="list" title="No runs match" text="Change the filters or the period." /> : (
        <ol className="trk-runs">
          {d.runs.map((r) => <RunRow key={r.id} r={r} open={open === r.id} toggle={() => setOpen(open === r.id ? null : r.id)} />)}
        </ol>
      )}
      <div className="trk-pager">
        <button type="button" className="btn btn-ghost btn-sm" disabled={page === 1} onClick={() => setPage(page - 1)}><Icon name="chevronL" size={14} />Previous</button>
        <span>Page {page} of {pages} · {d.total} runs</span>
        <button type="button" className="btn btn-ghost btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next<Icon name="chevronR" size={14} /></button>
      </div>
    </div>
  );
}

/** One run, and its trace as a waterfall: context, routing, each model call and each tool in the order they ran. */
function RunRow({ r, open, toggle }: { r: Run; open: boolean; toggle: () => void }) {
  const t = r.trace;
  const tone = outcomeTone(r.status);
  const total = Math.max(1, t.durationMs);
  const steps: { label: string; ms: number; color: string; note?: string; bad?: boolean }[] = [
    { label: 'Context', ms: t.contextMs, color: 'var(--trk-s1)' },
    ...(t.intentMs ? [{ label: `Routing${t.intent ? ` → ${words(t.intent)}` : ''}`, ms: t.intentMs, color: 'var(--trk-s2)' }] : []),
    ...t.models.map((m, i) => ({ label: `Model call ${i + 1}`, ms: m.durationMs, color: 'var(--trk-s3)', note: `${m.inputTokens} in / ${m.outputTokens} out · ${words(m.stopReason)}` })),
    ...t.tools.map((x) => ({ label: words(x.name), ms: x.durationMs, color: 'var(--trk-s4)', note: x.succeeded ? words(x.state) : 'failed', bad: !x.succeeded })),
  ];
  let at = 0;
  return (
    <li className={`trk-run ${open ? 'open' : ''}`}>
      <button type="button" className="trk-run-head" aria-expanded={open} onClick={toggle}>
        <span className={`trk-pill t-${tone}`}><i />{statusLabel(r.status)}</span>
        <span className="trk-run-main"><b>{t.intent ? words(t.intent) : 'reasoning'}</b><small>{formatDateTime(t.startedAt)} · {t.model}</small></span>
        <span className="trk-run-bar" aria-hidden><i style={{ width: `${Math.min(100, (t.durationMs / 20_000) * 100)}%` }} className={`t-${tone}`} /></span>
        <span className="trk-run-time">{secs(t.durationMs)}</span>
        <span className="trk-run-meta">{t.models.length} call{t.models.length === 1 ? '' : 's'} · {t.tools.length} tool{t.tools.length === 1 ? '' : 's'}</span>
        <span className="trk-run-fb" title={r.feedback ? (r.feedback === 'up' ? 'Marked helpful' : 'Marked unhelpful') : undefined}>{r.feedback && <Icon name={r.feedback === 'up' ? 'smile' : 'alert'} size={14} />}</span>
        <Icon name="chevronD" size={14} />
      </button>
      {open && (
        <div className="trk-trace">
          <ol className="trk-waterfall" aria-label="Trace">
            {steps.map((s, i) => {
              const left = (at / total) * 100; at += s.ms;
              return (
                <li key={i}>
                  <span className="trk-wf-label">{s.label}{s.note && <small className={s.bad ? 'bad' : ''}>{s.note}</small>}</span>
                  <span className="trk-wf-track"><i style={{ left: `${Math.min(99, left)}%`, width: `${Math.max(0.8, (s.ms / total) * 100)}%`, background: s.bad ? 'var(--trk-bad)' : s.color }} /></span>
                  <span className="trk-wf-ms">{secs(s.ms)}</span>
                </li>
              );
            })}
          </ol>
          <dl className="trk-facts">
            <div><dt>First words</dt><dd>{t.firstTokenMs == null ? '–' : secs(t.firstTokenMs)}</dd></div>
            <div><dt>Prompt</dt><dd>{compact(t.promptChars)} characters · {t.toolDefinitions} tools offered</dd></div>
            {t.database && <div><dt>Database</dt><dd>{t.database.commands} commands · {t.database.durationMs.toFixed(0)}ms{t.database.failedCommands ? ` · ${t.database.failedCommands} failed` : ''}</dd></div>}
            {t.preparation && <div><dt>Checks and setup</dt><dd>{secs(t.preparation.durationMs)}</dd></div>}
            <div><dt>Provider</dt><dd>{t.provider}</dd></div>
            <div><dt>Correlation</dt><dd><code>{t.correlationId}</code></dd></div>
            {t.errorCode && <div><dt>Error</dt><dd className="bad">{words(t.errorCode)}</dd></div>}
            {t.actions?.map((a) => <div key={a.id}><dt>Action</dt><dd>{words(a.kind)} · {words(a.status)} · {a.attempts} attempt{a.attempts === 1 ? '' : 's'}{a.confirmationWaitMs != null ? ` · waited ${secs(a.confirmationWaitMs)} for approval` : ''}</dd></div>)}
          </dl>
        </div>
      )}
    </li>
  );
}
