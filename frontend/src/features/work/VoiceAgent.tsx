import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { workApi } from '../../api/endpoints.platform';
import { Icon, type IconName } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Modal, PageLoader, ErrorState, Spinner } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import './voice.css';
import './voiceTools.css';
import { audioSupported, playParts, startRecording, stopPlayback, unlockAudio, wavSeconds, type Recording } from './voiceAudio';
import { errText, voiceApi, type Call, type CallItem, type Reply, type Turn, type VoiceSettings } from './voiceApi';
import { ToolsTab } from './VoiceTools';

const PATTERN_HELP = '{yyyy} {MM} {dd} {HH} {callId} {ticket} {language} {channel}';
type Tab = 'overview' | 'agent' | 'tools' | 'calls' | 'setup';
const TABS: { id: Tab; label: string; icon: IconName; manage?: boolean }[] = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'agent', label: 'Agent', icon: 'user', manage: true },
  { id: 'tools', label: 'Tools', icon: 'link', manage: true },
  { id: 'calls', label: 'Calls', icon: 'phone' },
  { id: 'setup', label: 'Setup', icon: 'settings', manage: true },
];
const TAB_KEY = 'pt.voice.tab';

/** Operations › Voice agent: the AI that answers the support line, in the caller's language. One area per job instead of one long page. */
export function VoiceAgentPanel() {
  const q = useWsQuery(['voice', 'settings'], voiceApi.settings);
  const [test, setTest] = useState(false);
  const [tab, setTabState] = useState<Tab>(() => { try { return (localStorage.getItem(TAB_KEY) as Tab) || 'overview'; } catch { return 'overview'; } });
  const setTab = (t: Tab) => { setTabState(t); try { localStorage.setItem(TAB_KEY, t); } catch { /* per-browser convenience only */ } };
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const s = q.data;
  const tabs = TABS.filter((t) => !t.manage || s.canManage);
  const current = tabs.some((t) => t.id === tab) ? tab : 'overview';
  return (
    <div className="va">
      <header className="va-top">
        <div className="va-who">
          <span className="va-avatar" aria-hidden="true"><Icon name="mic" size={18} /></span>
          <div>
            <h2>{s.agentName}<span className={`va-state ${s.enabled ? 'on' : ''}`}>{s.enabled ? 'Answering' : 'Off'}</span></h2>
            <p>AI voice agent · {s.languages.map((l) => s.availableLanguages[l] ?? l).join(', ')}</p>
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setTest(true)}><Icon name="phone" size={15} /> Test call</button>
      </header>
      <nav className="tabs va-tabs" role="tablist" aria-label="Voice agent">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={current === t.id} className={`tab${current === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={15} /> {t.label}
          </button>
        ))}
      </nav>
      <div className="va-panel" role="tabpanel">
        {current === 'overview' && <Overview s={s} go={setTab} onTest={() => setTest(true)} />}
        {current === 'agent' && <AgentTab s={s} />}
        {current === 'tools' && <ToolsTab s={s} />}
        {current === 'calls' && <CallsTab />}
        {current === 'setup' && <SetupTab s={s} />}
      </div>
      {test && <TestCall s={s} onClose={() => setTest(false)} />}
    </div>
  );
}

// ------------------------------------------------------------------ overview

function Overview({ s, go, onTest }: { s: VoiceSettings; go: (t: Tab) => void; onTest: () => void }) {
  const calls = useWsQuery(['voice', 'calls'], voiceApi.calls, { refetchInterval: 30_000 });
  const tools = useWsQuery(['voice', 'connectors'], voiceApi.connectors, { enabled: s.canManage });
  const list = calls.data ?? [];
  const week = Date.now() - 7 * 86400_000;
  const recent = list.filter((c) => new Date(c.startedAt).getTime() >= week);
  const real = recent.filter((c) => c.channel !== 'test');
  const tickets = recent.filter((c) => c.ticketKey).length;
  const transferred = recent.filter((c) => c.transferred).length;
  const durations = recent.filter((c) => c.endedAt).map((c) => (new Date(c.endedAt!).getTime() - new Date(c.startedAt).getTime()) / 1000);
  const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
  const resolved = recent.length ? Math.round(((recent.length - transferred - tickets) / recent.length) * 100) : null;
  const toolList = tools.data ?? [];
  const steps: { done: boolean; title: string; text: string; tab?: Tab; action?: () => void }[] = [
    { done: !!s.agentName && s.languages.length > 0, title: 'Persona and languages', text: `${s.agentName} speaks ${s.languages.length} language${s.languages.length === 1 ? '' : 's'}`, tab: 'agent' },
    { done: !!s.knowledge?.trim(), title: 'Company knowledge', text: s.knowledge?.trim() ? 'Policies and answers added' : 'Add products, policies and branch hours', tab: 'agent' },
    { done: toolList.length > 0, title: 'Connect your systems', text: toolList.length ? `${toolList.length} tool${toolList.length === 1 ? '' : 's'} · ${toolList.filter((t) => t.flow).length} with a flow` : 'Add your loan or payment API', tab: 'tools' },
    { done: !!s.speechConfigured, title: 'Real voice (Sarvam AI)', text: s.speechConfigured ? 'Speech ready' : 'Add the Sarvam key on the server', tab: 'setup' },
    { done: s.archiveConfigured, title: 'Recordings storage', text: s.archiveConfigured ? 'Bucket connected' : 'Connect a bucket for transcripts', tab: 'setup' },
    { done: list.length > 0, title: 'Try a test call', text: list.length ? 'Done — keep testing after each change' : 'Speak or type as a caller would', action: onTest },
    { done: false, title: 'Phone number', text: 'Plivo or Exotel; your number forwards to the agent', tab: 'setup' },
  ];
  const done = steps.filter((x) => x.done).length;
  return (
    <div className="va-over">
      <div className="va-kpis">
        <Kpi label="Calls this week" value={String(recent.length)} sub={real.length ? `${real.length} from customers` : 'all test calls'} />
        <Kpi label="Handled by the agent" value={resolved === null ? '—' : `${Math.max(0, resolved)}%`} sub="no ticket, no handover" />
        <Kpi label="Tickets logged" value={String(tickets)} sub="for the team to follow up" />
        <Kpi label="Handed to a person" value={String(transferred)} sub={s.transferNumber ? `to ${s.transferNumber}` : 'no number set'} />
        <Kpi label="Average call" value={avg === null ? '—' : avg >= 60 ? `${Math.floor(avg / 60)}m ${avg % 60}s` : `${avg}s`} sub="from greeting to goodbye" />
      </div>
      <div className="va-over-grid">
        {s.canManage && (
          <section className="va-card">
            <div className="va-card-head"><h3><Icon name="checks" size={16} /> Setup</h3><span className="va-progress"><i style={{ width: `${(done / steps.length) * 100}%` }} /></span><small>{done} of {steps.length}</small></div>
            <ul className="va-check">{steps.map((x) => (
              <li key={x.title} className={x.done ? 'done' : ''}>
                <span className="va-check-ic">{x.done ? <Icon name="check" size={13} /> : null}</span>
                <span><b>{x.title}</b><small>{x.text}</small></span>
                {(x.tab || x.action) && !x.done && <button className="btn btn-ghost btn-sm" onClick={() => (x.action ? x.action() : go(x.tab!))}>Open</button>}
              </li>))}
            </ul>
          </section>
        )}
        <section className="va-card">
          <div className="va-card-head"><h3><Icon name="phone" size={16} /> Latest calls</h3><button className="btn btn-ghost btn-sm" onClick={() => go('calls')}>All calls</button></div>
          {list.length === 0 ? <p className="va-muted">No calls yet.</p> : <ul className="va-calls compact">{list.slice(0, 5).map((c) => <CallRow key={c.id} c={c} onOpen={() => go('calls')} />)}</ul>}
        </section>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return <div className="va-kpi"><small>{label}</small><b>{value}</b><span>{sub}</span></div>;
}

// ------------------------------------------------------------------ agent (persona, knowledge, rules)

function useSettingsForm(s: VoiceSettings) {
  const wid = useWorkspaceId();
  const [f, setF] = useState(s);
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(s), [s]);
  const dirty = useMemo(() => JSON.stringify(f) !== JSON.stringify(s), [f, s]);
  const set = <K extends keyof VoiceSettings>(k: K, v: VoiceSettings[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true);
    try { await voiceApi.save(f); toast('Voice agent saved.'); void invalidateWorkspace(wid, 'voice'); }
    catch (e) { toast(errText(e, 'Could not save.'), 'error'); }
    finally { setBusy(false); }
  };
  const bar = (
    <div className={`va-savebar ${dirty ? 'show' : ''}`} aria-hidden={!dirty}>
      <span>Unsaved changes</span>
      <button className="btn btn-ghost btn-sm" onClick={() => setF(s)} tabIndex={dirty ? 0 : -1}>Discard</button>
      <button className="btn btn-primary btn-sm" disabled={busy || !dirty} onClick={() => void save()} tabIndex={dirty ? 0 : -1}>{busy ? <Spinner /> : null} Save</button>
    </div>
  );
  return { f, set, bar };
}

function AgentTab({ s }: { s: VoiceSettings }) {
  const types = useWsQuery(['work-types'], () => workApi.types(), { staleTime: 300_000 });
  const { f, set, bar } = useSettingsForm(s);
  const toggleLang = (l: string) => set('languages', f.languages.includes(l) ? f.languages.filter((x) => x !== l) : [...f.languages, l]);
  return (
    <div className="va-stack">
      <section className="va-card">
        <h3><Icon name="user" size={16} /> Persona</h3>
        <div className="va-grid">
          <label className="va-field"><span>Name</span><input value={f.agentName} onChange={(e) => set('agentName', e.target.value)} /></label>
          <label className="va-field"><span>Company name it says</span><input value={f.companyName} onChange={(e) => set('companyName', e.target.value)} placeholder="Northwind Business Finance" /></label>
        </div>
        <div className="va-field"><span>Languages — tap in order; the first is the greeting language</span>
          <div className="va-langs">{Object.entries(f.availableLanguages).map(([code, name]) => (
            <button key={code} type="button" className={f.languages.includes(code) ? 'on' : ''} aria-pressed={f.languages.includes(code)} onClick={() => toggleLang(code)}>
              {f.languages.includes(code) && <span className="va-order">{f.languages.indexOf(code) + 1}</span>}{name}</button>
          ))}</div></div>
        <label className="va-toggle inline"><input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} /><span><b>Agent answers calls</b><small>Off: callers hear your normal line.</small></span></label>
      </section>
      <section className="va-card">
        <h3><Icon name="note" size={16} /> Knowledge</h3>
        <label className="va-field"><span>Products, policies, branch hours and common answers. The agent trusts this and never invents beyond it.</span>
          <textarea rows={9} value={f.knowledge ?? ''} onChange={(e) => set('knowledge', e.target.value)} placeholder={'EMI is due on the 5th of each month.\nBranches open 9:30 am to 6 pm, Monday to Saturday.\nFor a foreclosure letter, the customer must visit the branch with ID.'} />
          <small>{(f.knowledge ?? '').length.toLocaleString('en-IN')} / 20,000 characters</small></label>
      </section>
      <section className="va-card">
        <h3><Icon name="shield" size={16} /> Caller check and handover</h3>
        <label className="va-toggle"><input type="checkbox" checked={f.requireVerification} onChange={(e) => set('requireVerification', e.target.checked)} />
          <span><b>Check the caller before sharing account details</b><small>Tools with an identity check verify it against your system; otherwise the agent asks for:</small>
            <input value={f.verificationRule} onChange={(e) => set('verificationRule', e.target.value)} disabled={!f.requireVerification} aria-label="What the caller confirms" /></span></label>
        <div className="va-grid">
          <label className="va-field"><span>Hand over to a person at</span><input value={f.transferNumber ?? ''} onChange={(e) => set('transferNumber', e.target.value || null)} placeholder="+91 …" /></label>
          <label className="va-field"><span>Tickets are created as</span>
            <Select className="select" aria-label="Ticket type" value={f.workTypeId ?? ''} onChange={(e) => set('workTypeId', e.target.value || null)}>
              <option value="">First work type</option>{(types.data ?? []).filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></label>
        </div>
      </section>
      {bar}
    </div>
  );
}

// ------------------------------------------------------------------ setup (speech, storage, phone)

function SetupTab({ s }: { s: VoiceSettings }) {
  const { f, set, bar } = useSettingsForm(s);
  const example = f.storageKeyPattern.replace('{yyyy}', '2026').replace('{MM}', '10').replace('{dd}', '22').replace('{HH}', '09').replace('{callId}', 'a1b2c3').replace('{ticket}', 'WT-42').replace('{language}', 'te').replace('{channel}', 'phone');
  return (
    <div className="va-stack">
      <div className="va-setup">
        <SetupItem icon="mic" title="Speech — Sarvam AI" ok={!!s.speechConfigured} okText="Ready: the agent hears and speaks Indian languages." todo="Add Voice__SarvamApiKey on the server to talk by voice. Until then, test calls are typed." />
        <SetupItem icon="database" title="Recordings and transcripts" ok={s.archiveConfigured} okText="Bucket connected: each call is archived when it ends." todo="Connect an S3-compatible bucket (Google Cloud Storage, S3, R2) to keep transcripts." />
        <SetupItem icon="phone" title="Phone number" ok={false} okText="" todo="Take a number from Plivo or Exotel (trial calls your verified mobile) and forward it to the agent. Ask support to connect it." />
      </div>
      <section className="va-card">
        <h3><Icon name="folder" size={16} /> Where calls are stored</h3>
        <label className="va-field"><span>Folder pattern</span><input className="mono" value={f.storageKeyPattern} onChange={(e) => set('storageKeyPattern', e.target.value)} />
          <small>Use {PATTERN_HELP}. This gives <span className="mono">{example}/transcript.json</span></small></label>
      </section>
      {bar}
    </div>
  );
}

function SetupItem({ icon, title, ok, okText, todo }: { icon: IconName; title: string; ok: boolean; okText: string; todo: string }) {
  return <div className={`va-setup-item ${ok ? 'ok' : ''}`}><span className="va-setup-ic"><Icon name={icon} size={18} /></span><span><b>{title}</b><small>{ok ? okText : todo}</small></span><em>{ok ? 'Ready' : 'To do'}</em></div>;
}

// ------------------------------------------------------------------ calls

function CallRow({ c, onOpen, active }: { c: CallItem; onOpen: () => void; active?: boolean }) {
  return (
    <li className={active ? 'on' : ''}><button onClick={onOpen}>
      <span className={`va-dot ${c.status}`} /><span className="va-call-main"><b>{c.callerNumber ?? (c.channel === 'test' ? 'Test call' : 'Unknown caller')}</b>
        <small>{formatDateTime(c.startedAt)} · {c.language.toUpperCase()}{c.ticketKey ? ` · ${c.ticketKey}` : ''}{c.transferred ? ' · handed over' : ''}</small>
        {c.summary && <span className="va-sum">{c.summary}</span>}</span></button></li>
  );
}

function CallsTab() {
  const q = useWsQuery(['voice', 'calls'], voiceApi.calls, { refetchInterval: 30_000 });
  const [filter, setFilter] = useState<'all' | 'ticket' | 'transferred' | 'test'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const list = (q.data ?? []).filter((c) => filter === 'all' || (filter === 'ticket' ? !!c.ticketKey : filter === 'transferred' ? c.transferred : c.channel === 'test'));
  const selected = open ?? list[0]?.id ?? null;
  return (
    <div className="va-callsplit">
      <section className="va-card va-calllist">
        <div className="seg va-seg" role="tablist">{([['all', 'All'], ['ticket', 'With ticket'], ['transferred', 'Handed over'], ['test', 'Tests']] as const).map(([k, l]) =>
          <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>)}</div>
        {list.length === 0 ? <p className="va-muted">No calls here yet.</p> : <ul className="va-calls">{list.map((c) => <CallRow key={c.id} c={c} active={c.id === selected} onOpen={() => setOpen(c.id)} />)}</ul>}
      </section>
      <section className="va-card va-calldetail">{selected ? <CallDetail id={selected} /> : <p className="va-muted">Choose a call to see its transcript.</p>}</section>
    </div>
  );
}

function CallDetail({ id }: { id: string }) {
  const q = useWsQuery(['voice', 'call', id], () => voiceApi.call(id));
  const c = q.data;
  if (!c) return <PageLoader />;
  const secs = c.endedAt ? Math.round((new Date(c.endedAt).getTime() - new Date(c.startedAt).getTime()) / 1000) : null;
  return (
    <div className="va-detail">
      <div className="va-detail-head">
        <h3>{c.callerNumber ?? (c.channel === 'test' ? 'Test call' : 'Call')}</h3>
        <small>{formatDateTime(c.startedAt)}{secs !== null ? ` · ${secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`}` : ''} · {c.language.toUpperCase()}</small>
      </div>
      <div className="va-flags">
        {c.verified && <span className="va-flag ok"><Icon name="shield" size={12} /> Verified</span>}
        {c.ticketKey && <span className="va-flag"><Icon name="tag" size={12} /> {c.ticketKey}</span>}
        {c.transferred && <span className="va-flag warn"><Icon name="users" size={12} /> Handed over</span>}
        {c.archiveKey && <span className="va-flag" title={c.archiveKey}><Icon name="database" size={12} /> Archived</span>}
        {c.workTaskId && <Link className="btn btn-sm" to={`/work?tab=tickets&item=${c.workTaskId}`}>Open ticket</Link>}
      </div>
      {c.summary && <p className="va-summary"><b>Summary</b>{c.summary}</p>}
      <Transcript turns={c.turns} />
    </div>
  );
}

/** A tool turn: for a tool with a flow, the facts and outcome it returned; otherwise the start of the raw answer. */
function ToolTurn({ t }: { t: Turn }) {
  let parsed: { facts?: Record<string, string>; identity?: string; next?: string; error?: string; say_this?: string } | null = null;
  try { const j = JSON.parse(t.text); if (j && typeof j === 'object' && ('facts' in j || 'identity' in j || 'next' in j || 'error' in j)) parsed = j; } catch { parsed = null; }
  if (!parsed) return <div className="va-tool"><Icon name="database" size={12} /> {t.tool}: {t.text.length > 160 ? t.text.slice(0, 160) + '…' : t.text}</div>;
  return (
    <div className="va-tool rich">
      <span className="va-tool-name"><Icon name="database" size={12} /> {t.tool}</span>
      {parsed.identity && <span className={`va-tool-tag ${parsed.identity.startsWith('confirmed') ? 'ok' : 'bad'}`}>{parsed.identity.startsWith('confirmed') ? 'Identity confirmed' : 'Identity did not match'}</span>}
      {parsed.facts && Object.entries(parsed.facts).map(([k, v]) => <span key={k} className="va-tool-fact"><i>{k}</i> {v}</span>)}
      {parsed.next && <span className="va-tool-next">{parsed.next}</span>}
      {parsed.error && <span className="va-tool-next">{parsed.error}</span>}
    </div>
  );
}

function Transcript({ turns, typing }: { turns: Turn[]; typing?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  // Scroll the transcript itself to the newest line, never the whole page.
  useEffect(() => { const b = box.current; if (b) b.scrollTop = b.scrollHeight; }, [turns.length, typing]);
  return (
    <div className="va-transcript" ref={box}>
      {turns.map((t, i) => t.role === 'tool' ? <ToolTurn key={i} t={t} /> : <div key={i} className={`va-bubble ${t.role}`}>{t.text}</div>)}
      {typing && <div className="va-bubble agent typing"><Spinner /></div>}
    </div>
  );
}

type Phase = 'idle' | 'listening' | 'hearing' | 'thinking' | 'speaking';

function TestCall({ s, onClose }: { s: VoiceSettings; onClose: () => void }) {
  const wid = useWorkspaceId();
  const canTalk = !!s.speechConfigured && audioSupported();
  const [lang, setLang] = useState(s.languages[0] ?? 'en');
  const [phone, setPhone] = useState('');
  const [talk, setTalk] = useState(canTalk);
  const [call, setCall] = useState<Call | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [ended, setEnded] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [handsFree, setHandsFree] = useState(true);
  const rec = useRef<Recording | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const limit = useRef<number | undefined>(undefined);
  const fillerTimers = useRef<number[]>([]);
  const fillers = useRef<{ kind: 'ack' | 'hold'; audio: string }[]>([]);
  const fillerDone = useRef<Promise<void> | null>(null);
  const live = useRef({ callId: '', ended: false, handsFree: true, closed: false });
  live.current.handsFree = handsFree;
  useEffect(() => () => {
    live.current.closed = true; stopPlayback(); rec.current?.cancel(); window.clearTimeout(limit.current);
    fillerTimers.current.forEach((t) => window.clearTimeout(t)); stream.current?.getTracks().forEach((t) => t.stop());
  }, []);

  const clearFillers = () => { fillerTimers.current.forEach((t) => window.clearTimeout(t)); fillerTimers.current = []; };
  /** While the agent thinks: a quick "hmm, okay" soon after the caller stops, and "one moment, let me check" if it takes longer. */
  const startFillers = () => {
    clearFillers();
    const acks = fillers.current.filter((f) => f.kind === 'ack'), hold = fillers.current.find((f) => f.kind === 'hold');
    if (acks.length) fillerTimers.current.push(window.setTimeout(() => { fillerDone.current = playParts([acks[Math.floor(Math.random() * acks.length)].audio]); }, 650));
    if (hold) fillerTimers.current.push(window.setTimeout(() => { fillerDone.current = playParts([hold.audio]); }, 4200));
  };

  const answered = async (r: Reply) => {
    clearFillers();
    setCall(r.call); setEnded(r.ended); live.current.ended = r.ended;
    if (r.fillers?.length) fillers.current = r.fillers;
    if (r.ended) void invalidateWorkspace(wid, 'voice');
    if (!talk) return;
    // Let a "hmm, okay" that is already playing finish instead of cutting it off mid-word.
    if (fillerDone.current) { await Promise.race([fillerDone.current, new Promise((d) => window.setTimeout(d, 2500))]); fillerDone.current = null; }
    setPhase('speaking');
    await playParts(r.audioParts?.length ? r.audioParts : [r.audio]);
    if (live.current.closed) return;
    setPhase('idle');
    if (!r.ended && live.current.handsFree) void listen();   // like a phone call: it is your turn as soon as the agent stops talking
  };
  const start = async () => {
    if (talk) unlockAudio();   // on the tap itself, so the phone lets the greeting play
    setBusy(true);
    try {
      const r = await voiceApi.start({ language: lang, callerNumber: phone || undefined, speak: talk });
      live.current.callId = r.call.id;
      setBusy(false); await answered(r);
    } catch (e) { toast(errText(e, 'Could not start.'), 'error'); } finally { setBusy(false); }
  };
  const send = async () => {
    if (!call || !text.trim()) return;
    if (talk) unlockAudio();
    const said = text.trim(); setText('');
    setCall({ ...call, turns: [...call.turns, { role: 'caller', text: said, at: new Date().toISOString() }] });
    setBusy(true);
    try { const r = await voiceApi.say(call.id, said, talk); setBusy(false); await answered(r); }
    catch (e) { toast(errText(e, 'The agent did not answer.'), 'error'); }
    finally { setBusy(false); }
  };
  const finish = async () => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    window.clearTimeout(limit.current);
    const spoke = r.heardSpeech();
    const wav = r.stop();
    if (!live.current.callId || live.current.closed) return;
    if (!spoke || wavSeconds(wav) < 0.6) { setPhase('idle'); if (!live.current.handsFree) toast('That was too short — tap, speak, then tap again.', 'error'); return; }
    setPhase('thinking'); setBusy(true);
    startFillers();
    try { const reply = await voiceApi.listen(live.current.callId, new File([wav], 'speech.wav', { type: 'audio/wav' })); setBusy(false); await answered(reply); }
    catch (e) { clearFillers(); setPhase('idle'); toast(errText(e, 'The agent did not hear that.'), 'error'); } finally { setBusy(false); }
  };
  const listen = async () => {
    if (!live.current.callId || live.current.ended || rec.current) return;
    unlockAudio(); stopPlayback();
    try {
      stream.current ??= await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      rec.current = await startRecording(stream.current, {
        onSpeech: () => setPhase('hearing'),
        onTurnEnd: () => { if (live.current.handsFree) void finish(); },
      });
      setPhase('listening');
      limit.current = window.setTimeout(() => void finish(), 28_000);   // Sarvam's quick transcription takes up to about 30 seconds
    } catch { toast('Allow the microphone to talk to the agent.', 'error'); setTalk(false); }
  };
  /** The big button: send now while listening, interrupt the agent while it speaks, or start listening. */
  const tapMic = () => {
    unlockAudio();
    if (rec.current) { void finish(); return; }
    if (phase === 'speaking') { stopPlayback(); setPhase('idle'); }
    void listen();
  };
  const hangUp = async () => {
    live.current.closed = true;
    rec.current?.cancel(); rec.current = null; window.clearTimeout(limit.current); clearFillers(); stopPlayback();
    if (call && !ended) { try { await voiceApi.end(call.id); } catch { /* the call log shows it */ } }
    void invalidateWorkspace(wid, 'voice'); onClose();
  };
  const label = { idle: handsFree ? 'Tap to talk' : 'Tap and speak', listening: 'Listening… go ahead', hearing: handsFree ? 'Listening… pause when you are done' : 'Listening… tap to send',
    thinking: 'Thinking…', speaking: 'Speaking… tap to interrupt' }[phase];
  return (
    <Modal title="Test call" subtitle={talk ? 'Speak as a caller would, in any of the agent\'s languages — it answers out loud.' : 'Type as the caller would speak, in any of the agent\'s languages.'} onClose={() => void hangUp()} size="lg"
      footer={call ? <button className="btn btn-ghost" onClick={() => void hangUp()}>{ended ? 'Close' : 'Hang up'}</button> : undefined}>
      {!call ? (
        <div className="va-form">
          <div className="va-grid">
            <label className="va-field"><span>Greeting language</span><Select className="select" aria-label="Greeting language" value={lang} onChange={(e) => setLang(e.target.value)}>{s.languages.map((l) => <option key={l} value={l}>{s.availableLanguages[l] ?? l}</option>)}</Select></label>
            <label className="va-field"><span>Caller's number (optional)</span><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98…" /></label>
          </div>
          {canTalk ? <label className="va-toggle inline"><input type="checkbox" checked={talk} onChange={(e) => setTalk(e.target.checked)} /><span>Talk with my voice<small>Uses your microphone; the agent replies in voice (Sarvam).</small></span></label>
            : !s.speechConfigured ? <p className="va-muted">Typed test. Add the Sarvam key on the server to talk by voice.</p> : null}
          <button className="btn btn-primary" disabled={busy} onClick={() => void start()}>{busy ? <Spinner /> : <Icon name="phone" size={14} />} Start</button>
        </div>
      ) : (
        <div className="va-test">
          <Transcript turns={call.turns} typing={busy} />
          {ended ? <p className="va-muted">The call ended.{call.ticketKey ? ` Ticket ${call.ticketKey} was created.` : ''}</p>
            : talk ? <div className="va-mic">
              <button type="button" className={`va-mic-btn ${phase}`} disabled={phase === 'thinking'} onClick={tapMic}
                aria-label={phase === 'listening' || phase === 'hearing' ? 'Send now' : phase === 'speaking' ? 'Interrupt' : 'Talk'}>
                {phase === 'thinking' ? <Spinner /> : <Icon name={phase === 'speaking' ? 'square' : 'mic'} size={22} />}
              </button>
              <span aria-live="polite">{label}</span>
              <div className="va-mic-opts">
                <label className="va-toggle inline"><input type="checkbox" checked={handsFree} onChange={(e) => setHandsFree(e.target.checked)} /><span>Hands-free</span></label>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { rec.current?.cancel(); rec.current = null; setPhase('idle'); setTalk(false); }}>Type instead</button>
              </div>
            </div>
            : <form className="va-say" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="नमस्ते, मेरी EMI कब है? / నా లోన్ బ్యాలెన్స్ ఎంత? / What is my loan balance?" aria-label="What the caller says" autoFocus disabled={busy} />
              <button className="btn btn-primary" aria-label="Send" title="Send" disabled={busy || !text.trim()}><Icon name="send" size={14} /></button>
            </form>}
        </div>
      )}
    </Modal>
  );
}
