import { lazy, Suspense, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { aiControlApi, type AgentLevel, type AiControl } from './aiControlApi';
import { Icon } from '../../components/Icon';
import { Embedded, Kpi, PageHead, PageLoader, Segmented } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { aiWorkspaceApi } from '../ai/aiApi';
import { useAiStatus, AiWorkspaceSwitch } from '../ai/Assistant';
import { AiOwnKeyCard } from '../ai/OwnAiKey';
import { aiProviderApi } from '../ai/providerApi';
import { AiUsageCard } from '../ai/AiUsageCard';
import { LastChanged } from './SettingsCenter';
import './aiControl.css';

const AgentTrackerPage = lazy(() => import('../ai/AgentTrackerPage').then((m) => ({ default: m.AgentTrackerPage })));

const LEVELS: { id: AgentLevel; label: string }[] = [
  { id: 'off', label: 'Off' }, { id: 'suggest', label: 'Suggest' }, { id: 'askFirst', label: 'Ask first' }, { id: 'auto', label: 'Auto' },
];
const thisMonth = () => new Date().toISOString().slice(0, 7);
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const MCP = `${typeof window === 'undefined' ? '' : window.location.origin}/api/v1/mcp`;

export type AiTab = 'control' | 'usage' | 'tracker';

/** Settings › AI: the control centre, the month's usage by person, and the agent tracker (moved here from Agents). */
export function AiSettings({ tab, onTab }: { tab: AiTab; onTab: (t: AiTab) => void }) {
  const control = useWsQuery(['ai', 'control'], aiControlApi.get, { staleTime: 30_000 });
  const people = control.data?.people ?? 0;
  return (
    <div className="aic">
      <PageHead eyebrow="Settings › AI" title="AI control centre" sub="One place to decide what the AI knows, what it may do, and what it costs.">
        {control.data && <span className={`ds-pill ${control.data.aiOn ? 'success' : ''}`}><i className="aic-dot" />{control.data.aiOn ? `AI on for ${people} ${people === 1 ? 'person' : 'people'}` : 'AI is off here'}</span>}
      </PageHead>
      <Segmented label="AI settings" value={tab} onChange={onTab} options={[{ id: 'control', label: 'Control centre' }, { id: 'usage', label: 'Usage' }, { id: 'tracker', label: 'Agent tracker' }]} />
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

function ControlCentre({ control, loading }: { control?: AiControl; loading: boolean }) {
  const status = useAiStatus();
  const usage = useWsQuery(['ai', 'usage'], aiWorkspaceApi.usage, { enabled: !!status?.enabled, staleTime: 30_000 });
  const report = useWsQuery(['ai', 'report', thisMonth()], () => aiWorkspaceApi.report(thisMonth()), { enabled: !!status?.configured && !!status?.entitled, staleTime: 30_000 });
  if (loading) return <PageLoader />;
  if (!control) return <p className="muted">The AI settings could not be loaded.</p>;
  const u = usage.data, r = report.data;
  const success = r && r.answers > 0 ? Math.round(((r.answers - r.failed) / r.answers) * 100) : null;
  const ctxEmpty = control.contextLength === 0;
  return (
    <>
      <div className="ds-kpis aic-kpis">
        <Kpi label="Credits this month" value={u ? (u.unlimited ? <>{u.creditsUsed.toLocaleString()}<small> · unlimited</small></> : <>{u.creditsUsed.toLocaleString()}<small> / {u.creditsLimit.toLocaleString()}</small></>) : '—'}
          caption={u && !u.unlimited ? <span className="ds-meter"><i style={{ width: `${Math.min(100, (u.creditsUsed / Math.max(1, u.creditsLimit)) * 100)}%` }} /></span> : undefined} />
        <Kpi label="Answer success" value={success === null ? '—' : `${success}%`} tone={success === null ? undefined : success >= 90 ? 'success' : success >= 70 ? 'warning' : 'danger'}
          caption={r ? `${(r.answers - r.failed).toLocaleString()} of ${r.answers.toLocaleString()} · ${r.failed} failed` : undefined} />
        <Kpi label="Organisation context" value={ctxEmpty ? 'Empty' : 'Written'} tone={ctxEmpty ? 'danger' : 'success'} caption={`${control.contextLength.toLocaleString()} / ${control.contextLimit.toLocaleString()} characters`} />
        <Kpi label="Automations" value={control.automations} caption={<Link to="/settings/timelines/automation">rules running ›</Link>} />
      </div>
      <div className="aic-grid">
        <section className="aic-card" aria-labelledby="aic-agents">
          <h3 id="aic-agents">What each agent may do</h3>
          <p className="aic-sub">Pick a level per agent. “Ask first” puts its work in the Inbox for one-tap approval.</p>
          <AgentLevels control={control} />
        </section>
        <div className="aic-side">
          <ModelCard />
          <TeachCard limit={control.contextLimit} canEdit={control.canEdit} />
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

/** One model answers everyone: the organisation's own Claude key (for everyone who agreed), or the included Gemini. */
function ModelCard() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['ai', 'provider'], aiProviderApi.get, { staleTime: 30_000, retry: false });
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const s = q.data;
  if (q.isLoading) return <section className="aic-card"><PageLoader /></section>;
  if (!s) return null;
  const claude = s.configured && s.enabled && s.provider === 'anthropic';
  const save = async (enabled: boolean) => {
    setBusy(true);
    try {
      await aiProviderApi.save({ provider: s.provider, quickModel: s.quickModel, standardModel: s.standardModel, deepModel: s.deepModel, enabled, fallbackToPlatform: s.fallbackToPlatform });
      void invalidateWorkspace(wid, 'ai'); toast(enabled ? 'Answers come from your organisation’s Claude for everyone who agreed.' : 'Answers come from the included Gemini.');
    } catch (e) { toast(errText(e, 'Could not change the model.'), 'error'); }
    finally { setBusy(false); }
  };
  const pickClaude = () => { if (claude) return; if (s.configured && s.provider === 'anthropic') void save(true); else setAdding(true); };
  const pickGemini = async () => {
    if (!claude) return;
    if (await confirmDialog({ title: 'Answer with Gemini?', message: 'Everyone’s questions go to the included Gemini and use AI credits. Your Claude key stays saved.', confirmText: 'Use Gemini' })) void save(false);
  };
  return (
    <section className="aic-card" data-setting="ai.ownKey">
      <h3>Model</h3>
      <p className="aic-sub">One model answers everyone{s.peopleAgreed ? ` · ${s.peopleAgreed} agreed to the organisation’s Claude` : ''}.</p>
      <div className="aic-models" role="radiogroup" aria-label="Model">
        <button type="button" role="radio" aria-checked={claude} disabled={busy} className={`aic-model ${claude ? 'on' : ''}`} onClick={pickClaude}>
          <b>Claude (your organisation)</b><span>{s.configured && s.provider === 'anthropic' ? `Own Anthropic account · key …${s.keyHint ?? ''}` : 'Own Anthropic account · data stays under your contract'}</span>
        </button>
        <button type="button" role="radio" aria-checked={!claude} disabled={busy} className={`aic-model ${!claude ? 'on' : ''}`} onClick={() => void pickGemini()}>
          <b>Google Gemini</b><span>Included credits{claude && s.fallbackToPlatform ? ' · used only when Claude cannot answer' : ''}</span>
        </button>
      </div>
      {s.lastError && <p className="aic-warn" role="alert"><Icon name="alert" size={14} /> {s.lastError}</p>}
      {(adding || (s.configured && s.provider !== 'anthropic')) && <div className="aic-key"><AiOwnKeyCard /></div>}
    </section>
  );
}

/** "Teach it" the organisation: shared with every question. "Draft it from my projects" writes a first version from the workspace's records. */
function TeachCard({ limit, canEdit }: { limit: number; canEdit: boolean }) {
  const wid = useWorkspaceId();
  const status = useAiStatus();
  const q = useWsQuery(['ai', 'instructions'], aiWorkspaceApi.instructions, { enabled: !!status?.configured, staleTime: 60_000 });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'draft' | 'save' | null>(null);
  useEffect(() => { if (q.data) setText(q.data.text ?? ''); }, [q.data]);
  const saved = q.data?.text ?? '';
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
