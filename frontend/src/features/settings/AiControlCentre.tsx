import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { projectApi } from '../../api/endpoints';
import { aiControlApi, type AgentLevel, type AiControl } from './aiControlApi';
import { Select } from '../../components/Select';
import { Embedded, EmptyState, Kpi, PageHead, PageLoader, Segmented } from '../../components/ui';
import { ProjectAgentSettings } from '../agent/ProjectAgentTab';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { aiWorkspaceApi, type AiWorkspaceReport } from '../ai/aiApi';
import { useAiStatus, AiWorkspaceSwitch } from '../ai/Assistant';
import { AiOwnKeyCard } from '../ai/OwnAiKey';
import { AiUsageCard } from '../ai/AiUsageCard';
import { LastChanged } from './SettingsCenter';
import './aiControl.css';

const AgentTrackerPage = lazy(() => import('../ai/AgentTrackerPage').then((m) => ({ default: m.AgentTrackerPage })));

const LEVELS: { id: AgentLevel; label: string }[] = [
  { id: 'off', label: 'Off' }, { id: 'suggest', label: 'Suggest' }, { id: 'askFirst', label: 'Ask first' }, { id: 'auto', label: 'Act and tell me' },
];
const thisMonth = () => new Date().toISOString().slice(0, 7);
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const MCP = `${typeof window === 'undefined' ? '' : window.location.origin}/api/v1/mcp`;

export type AiTab = 'control' | 'usage' | 'tracker' | 'project-agent';

/**
 * Settings › AI: the control centre, the month's usage by person, the agent tracker (moved here from Agents), and each project's agent
 * (moved here from the project's Agent tab). Admins see all four; a project lead sees Project agent.
 */
export function AiSettings({ tab, onTab, admin = true, agent = true }: { tab: AiTab; onTab: (t: AiTab) => void; admin?: boolean; agent?: boolean }) {
  const control = useWsQuery(['ai', 'control'], aiControlApi.get, { staleTime: 30_000, retry: false, enabled: admin });
  const people = control.data?.people ?? 0;
  const tabs: { id: AiTab; label: string }[] = [
    ...(admin ? [{ id: 'control' as const, label: 'Control centre' }, { id: 'usage' as const, label: 'Usage' }, { id: 'tracker' as const, label: 'Agent tracker' }] : []),
    ...(agent ? [{ id: 'project-agent' as const, label: 'Project agent' }] : []),
  ];
  return (
    <div className="aic">
      <PageHead eyebrow="Settings › AI" title={admin ? 'Groot control centre' : 'Groot · Project agent'} sub={admin ? 'One place to decide what Groot knows, what it may do, and what it costs.' : 'How Groot behaves on the projects you lead.'}>
        {admin && control.data?.agents && <span className={`ds-pill ${control.data.aiOn ? 'success' : ''}`}><i className="aic-dot" />{control.data.aiOn ? `AI on for ${people} ${people === 1 ? 'person' : 'people'}` : 'AI is off here'}</span>}
      </PageHead>
      {tabs.length > 1 && <Segmented label="AI settings" value={tab} onChange={onTab} options={tabs} />}
      {tab === 'project-agent' && <ProjectAgentPicker />}
      {tab === 'control' && <ControlCentre control={control.data} loading={control.isLoading} />}
      {tab === 'usage' && (
        <div className="aic-usage">
          <div data-setting="ai.enabled"><AiWorkspaceSwitch /><LastChanged k="ai.enabled" section="ai" /></div>
          <div data-setting="ai.budget"><AiUsageCard /></div>
        </div>
      )}
      {tab === 'tracker' && <Embedded><Suspense fallback={<PageLoader />}><AgentTrackerPage /></Suspense></Embedded>}
    </div>
  );
}

/**
 * Settings › AI › Project agent: pick a project, then everything its agent does - what it reads, the meeting bot and its four levels, minutes,
 * morning updates, the Google account for transcripts, accuracy, credits and its readings. On the project itself it is one on/off switch.
 */
function ProjectAgentPicker() {
  const [params, setParams] = useSearchParams();
  const projects = useWsQuery(['projects', 'list', 'agent-picker'], () => projectApi.list({ pageSize: 100 }), { staleTime: 60_000 });
  const items = [...(projects.data?.items ?? [])].filter((p) => p.status !== 'Archived').sort((a, b) => a.name.localeCompare(b.name));
  const id = params.get('project') ?? items[0]?.id ?? null;
  const chosen = items.find((p) => p.id === id);
  const pick = (v: string) => setParams((p) => { const n = new URLSearchParams(p); n.set('project', v); return n; }, { replace: true });
  if (projects.isLoading) return <PageLoader />;
  return (
    <div className="aic-pagent">
      <div className="aic-pagent-pick">
        <label className="aic-pagent-label">Project
          <Select className="select" value={id ?? ''} onChange={(e) => pick(e.target.value)} aria-label="Project">
            {id && !chosen && <option value={id}>This project</option>}
            {items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </label>
        {id && <Link className="aic-link" to={`/work/projects/${id}?tab=activity`}>Open the project ›</Link>}
      </div>
      <p className="aic-sub">Each project has its own agent. It is switched on or off on the project’s Activity tab; here is how it behaves.</p>
      {id ? <div className="aic-pagent-settings"><ProjectAgentSettings key={id} projectId={id} archived={chosen?.status === 'Archived'} /></div>
        : <EmptyState icon="folder" title="No projects yet" text="Once there is a project, its agent is set up here." />}
    </div>
  );
}

function ControlCentre({ control, loading }: { control?: AiControl; loading: boolean }) {
  const status = useAiStatus();
  // The control centre serves this month's answers and credits itself; the usage and report endpoints are read only when it does not.
  const f = control?.figures ?? undefined;
  const usage = useWsQuery(['ai', 'usage'], aiWorkspaceApi.usage, { enabled: !f && !!status?.enabled, staleTime: 30_000 });
  const report = useWsQuery(['ai', 'report', thisMonth()], () => aiWorkspaceApi.report(thisMonth()), { enabled: !!status?.configured && !!status?.entitled, staleTime: 30_000 });
  if (loading) return <PageLoader />;
  // Each part stands on its own: one figure that cannot be read does not hide the others (or the model and the key).
  const c = control?.agents ? control : undefined;
  const u = f ? { creditsUsed: f.creditsUsed, creditsLimit: f.creditsLimit, unlimited: f.unlimited } : typeof usage.data?.creditsUsed === 'number' ? usage.data : undefined;
  const r = f ? { answers: f.answers, failed: f.failed } : typeof report.data?.answers === 'number' ? report.data : undefined;
  const success = f ? f.successPercent : r && r.answers > 0 ? Math.round(((r.answers - r.failed) / r.answers) * 100) : null;
  const ctxEmpty = (c?.contextLength ?? 0) === 0;
  return (
    <>
      <div className="ds-kpis aic-kpis">
        <Kpi label="Credits this month" value={u ? (u.unlimited ? <>{u.creditsUsed.toLocaleString()}<small> · unlimited</small></> : <>{u.creditsUsed.toLocaleString()}<small> / {u.creditsLimit.toLocaleString()}</small></>) : '—'}
          caption={u && !u.unlimited ? <span className="ds-meter"><i style={{ width: `${Math.min(100, (u.creditsUsed / Math.max(1, u.creditsLimit)) * 100)}%` }} /></span> : undefined} />
        <Kpi label="Answer success" value={success === null ? '—' : `${success}%`} tone={success === null ? undefined : success >= 90 ? 'success' : success >= 70 ? 'warning' : 'danger'}
          caption={r ? `${(r.answers - r.failed).toLocaleString()} of ${r.answers.toLocaleString()} · ${r.failed} failed` : undefined} />
        <Kpi label="Organisation context" value={!c ? '—' : ctxEmpty ? 'Empty' : 'Written'} tone={!c ? undefined : ctxEmpty ? 'danger' : 'success'} caption={c ? `${c.contextLength.toLocaleString()} / ${c.contextLimit.toLocaleString()} characters` : undefined} />
        <Kpi label="Automations" value={c ? c.automations : '—'} caption={<Link to="/settings/timelines/automation">rules running ›</Link>} />
      </div>
      <section className="aic-card aic-wide" data-setting="ai.ownKey" aria-labelledby="aic-conn">
        <h3 id="aic-conn">AI provider</h3>
        <p className="aic-sub">Which AI answers the assistant, the key it uses, and which model handles which kind of question.</p>
        <AiOwnKeyCard />
      </section>
      <UsageThisMonth report={report.data} figures={f} />
      <div className="aic-grid">
        <section className="aic-card" aria-labelledby="aic-agents">
          <h3 id="aic-agents">Agents &amp; permissions</h3>
          <p className="aic-sub">Pick a level per agent. “Ask first” puts its work in the Inbox for one-tap approval; “Act and tell me” acts and reports what it did.</p>
          {c ? <AgentLevels control={c} /> : <p className="muted">The agents' levels could not be loaded.</p>}
        </section>
        <div className="aic-side">
          <TeachCard limit={c?.contextLimit ?? 4000} />
          <PrivacyCard />
          <section className="aic-card">
            <h3>Outside AI apps</h3>
            <p className="aic-sub">Claude or ChatGPT can work here as you, with your permissions.</p>
            <div className="aic-mcp"><code>{MCP.replace(/^https?:\/\//, '')}</code>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void navigator.clipboard?.writeText(MCP).then(() => toast('Address copied.'), () => toast('Could not copy it.', 'error')); }}>Copy</button></div>
            <Link className="aic-link" to="/settings/integrations/connected-apps">Connected apps ›</Link>
          </section>
        </div>
      </div>
    </>
  );
}

function AgentLevels({ control }: { control: AiControl }) {
  const wid = useWorkspaceId();
  const [busy, setBusy] = useState<string | null>(null);
  const set = async (agent: string, level: AgentLevel) => {
    setBusy(agent);
    try { await aiControlApi.setLevel(agent, level); void invalidateWorkspace(wid, 'ai', 'control'); }
    catch (e) { toast(errText(e, 'Could not change it.'), 'error'); }
    finally { setBusy(null); }
  };
  return (
    <ul className="aic-agents">
      {control.agents.map((a) => (
        <li key={a.id} className="aic-agent">
          <div className="aic-agent-info"><b>{a.name}</b><span>{a.description}</span></div>
          {control.canEdit
            ? <Segmented label={`${a.name} level`} value={a.level} onChange={(v) => { if (busy !== a.id && v !== a.level) void set(a.id, v); }} options={LEVELS} />
            : <span className="ds-pill">{LEVELS.find((l) => l.id === a.level)?.label}</span>}
        </li>
      ))}
    </ul>
  );
}

const FEATURE_NAMES: Record<string, string> = { ask: 'Ask', assistant: 'Ask', briefing: 'Briefing', morning_briefing: 'Briefing', triage: 'Triage', docs: 'Docs', documents: 'Docs' };
const featureName = (f: string) => FEATURE_NAMES[f.toLowerCase()] ?? f.replaceAll('_', ' ').replace(/^\w/, (x) => x.toUpperCase());

/** This month's requests and credits, split by feature (the assistant's answers by level, then the other AI features), as small bars. */
function UsageThisMonth({ report, figures }: { report?: AiWorkspaceReport; figures?: AiControl['figures'] }) {
  const used = report?.creditsUsed ?? figures?.creditsUsed;
  const limit = report?.creditsLimit ?? figures?.creditsLimit;
  const unlimited = report?.unlimited ?? figures?.unlimited;
  const answers = report?.answers ?? figures?.answers;
  const rows = [
    ...(report?.byTier ?? []).filter((t) => t.answers > 0).map((t) => ({ name: `Ask · ${t.tier}`, answers: t.answers, credits: t.credits })),
    ...(report?.features ?? []).map((x) => ({ name: featureName(x.feature), answers: x.answers, credits: x.credits })),
  ];
  const max = Math.max(1, ...rows.map((r) => r.credits || r.answers));
  return (
    <section className="aic-card aic-wide" data-setting="ai.usage" aria-labelledby="aic-usage-h">
      <h3 id="aic-usage-h">Usage this month</h3>
      <p className="aic-sub">Counts only, never what anyone asked. Answers on your own key are billed by the provider; credits apply to Project Tracker&rsquo;s AI.</p>
      <div className="aic-usage-top">
        <div><span>Requests</span><b>{answers === undefined ? '—' : answers.toLocaleString()}</b></div>
        <div><span>Credits used</span><b>{used === undefined ? '—' : used.toLocaleString()}</b></div>
        <div><span>Limit</span><b>{unlimited ? 'Unlimited' : limit === undefined ? '—' : limit.toLocaleString()}</b></div>
      </div>
      {!unlimited && used !== undefined && limit ? <span className="ds-meter aic-usage-meter"><i style={{ width: `${Math.min(100, (used / Math.max(1, limit)) * 100)}%` }} /></span> : null}
      {rows.length === 0 ? <p className="muted aic-usage-empty">No AI use yet this month.</p> : (
        <ul className="aic-bars" aria-label="Usage by feature">
          {rows.map((r) => (
            <li key={r.name}><span className="aic-bar-name">{r.name}</span>
              <span className="aic-bar"><i style={{ width: `${Math.max(3, ((r.credits || r.answers) / max) * 100)}%` }} /></span>
              <span className="aic-bar-val">{r.answers.toLocaleString()} req · {r.credits.toLocaleString()} cr</span></li>
          ))}
        </ul>
      )}
      <Link className="aic-link" to="/settings/ai/usage">By person and budgets ›</Link>
    </section>
  );
}

/** Privacy: what leaves Project Tracker when someone asks, and what is kept. */
function PrivacyCard() {
  return (
    <section className="aic-card" data-setting="ai.privacy">
      <h3>Privacy</h3>
      <ul className="aic-privacy">
        <li><b>What is sent</b><span>The question, and only the records the person asking can already see that are needed to answer it, plus your organisation context.</span></li>
        <li><b>Where it goes</b><span>To your own Claude or ChatGPT account for people who agreed; otherwise to Project Tracker&rsquo;s AI (Gemini).</span></li>
        <li><b>Keys</b><span>Stored encrypted on the server; only the last four characters are ever shown.</span></li>
        <li><b>Kept here</b><span>Conversations stay in the workspace; admins see counts, never questions or answers.</span></li>
      </ul>
      <Link className="aic-link" to="/settings/security">Security and data settings ›</Link>
    </section>
  );
}

/** "Teach it" the organisation: shared with every question. "Draft it from my projects" writes a first version from the workspace's records. */
function TeachCard({ limit }: { limit: number }) {
  const wid = useWorkspaceId();
  const status = useAiStatus();
  const q = useWsQuery(['ai', 'instructions'], aiWorkspaceApi.instructions, { enabled: !!status?.configured, staleTime: 60_000 });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'draft' | 'save' | null>(null);
  useEffect(() => { if (q.data) setText(q.data.text ?? ''); }, [q.data]);
  const saved = q.data?.text ?? '';
  const canEdit = !!q.data?.canEdit;
  const dirty = text.trim() !== saved.trim();
  const draft = async () => {
    if (text.trim() && !(await confirmDialog({ title: 'Replace what is written?', message: 'The draft replaces the text in the box. Nothing is saved until you save.', confirmText: 'Draft it' }))) return;
    setBusy('draft');
    try { setText((await aiControlApi.draftContext()).text); toast('Drafted from your projects. Edit it, then save.'); }
    catch (e) { toast(errText(e, 'Could not draft it.'), 'error'); }
    finally { setBusy(null); }
  };
  const save = async () => {
    setBusy('save');
    try { await aiWorkspaceApi.setInstructions(text); void invalidateWorkspace(wid, 'ai'); toast('Saved. The assistant uses this from the next question.'); }
    catch (e) { toast(errText(e, 'Could not save it.'), 'error'); }
    finally { setBusy(null); }
  };
  return (
    <section className="aic-card aic-teach" data-setting="ai.instructions">
      <h3>Teach it your organisation</h3>
      <textarea className="textarea" rows={6} maxLength={limit} value={text} disabled={!canEdit} aria-label="About your organisation"
        placeholder="We are a NBFC. MuleSoft is our integration layer. Prod releases freeze on the last Friday. P1 = customer-facing outage…" onChange={(e) => setText(e.target.value)} />
      <div className="aic-teach-foot"><span>{text.length.toLocaleString()} / {limit.toLocaleString()}</span>
        {canEdit && dirty && <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save'}</button>}</div>
      {canEdit && <button type="button" className="btn aic-ai-btn" disabled={busy !== null} onClick={() => void draft()}>{busy === 'draft' ? 'Drafting…' : 'Draft it from my projects'}</button>}
      <LastChanged k="ai.instructions" section="ai" />
    </section>
  );
}
