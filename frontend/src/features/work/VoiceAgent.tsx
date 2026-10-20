import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, del, get, post, put, uploadFile } from '../../api/client';
import { workApi } from '../../api/endpoints.platform';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Modal, PageLoader, ErrorState, Spinner } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import './voice.css';

interface VoiceSettings {
  enabled: boolean; agentName: string; companyName: string; languages: string[]; knowledge: string | null; requireVerification: boolean; verificationRule: string;
  transferNumber: string | null; workTypeId: string | null; storageKeyPattern: string; archiveConfigured: boolean; canManage: boolean; availableLanguages: Record<string, string>; speechConfigured?: boolean;
}
interface Connector { id: string; name: string; description: string; method: string; urlTemplate: string; headerName: string | null; hasSecret: boolean; enabled: boolean; placeholders: string[] }
interface Turn { role: 'agent' | 'caller' | 'tool'; text: string; at: string; tool?: string | null }
interface Call { id: string; channel: string; direction: string; callerNumber: string | null; language: string; status: string; startedAt: string; endedAt: string | null; turns: Turn[]; summary: string | null; workTaskId: string | null; ticketKey: string | null; verified: boolean; transferred: boolean; archiveKey: string | null }
interface Reply { call: Call; say: string; ended: boolean; audio?: string | null; heard?: string | null }
interface CallItem { id: string; channel: string; callerNumber: string | null; language: string; status: string; startedAt: string; endedAt: string | null; summary: string | null; ticketKey: string | null; transferred: boolean }

const voiceApi = {
  settings: () => get<VoiceSettings>('/voice/settings'),
  save: (b: Omit<VoiceSettings, 'archiveConfigured' | 'canManage' | 'availableLanguages' | 'speechConfigured'>) => put<VoiceSettings>('/voice/settings', b),
  connectors: () => get<Connector[]>('/voice/connectors'),
  saveConnector: (b: Partial<Connector> & { secret?: string }, id?: string) => (id ? put<Connector>(`/voice/connectors/${id}`, b) : post<Connector>('/voice/connectors', b)),
  removeConnector: (id: string) => del(`/voice/connectors/${id}`),
  calls: () => get<CallItem[]>('/voice/calls'),
  call: (id: string) => get<Call>(`/voice/calls/${id}`),
  start: (b: { callerNumber?: string; language?: string; speak?: boolean }) => post<Reply>('/voice/calls/test', b),
  say: (id: string, text: string, speak = false) => post<Reply>(`/voice/calls/${id}/say`, { text, speak }),
  listen: (id: string, audio: File) => uploadFile<Reply>(`/voice/calls/${id}/listen`, audio),
  end: (id: string) => post<Call>(`/voice/calls/${id}/end`, {}),
};
const errText = (e: unknown, f: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : f);
const PATTERN_HELP = '{yyyy} {MM} {dd} {HH} {callId} {ticket} {language} {channel}';

/** Operations › Voice agent: the AI that answers the support line, in the caller's language. */
export function VoiceAgentPanel() {
  const q = useWsQuery(['voice', 'settings'], voiceApi.settings);
  const [test, setTest] = useState(false);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const s = q.data;
  return (
    <div className="va">
      <header className="va-hero">
        <div>
          <span className="va-eyebrow"><Icon name="phone" size={13} /> AI voice agent</span>
          <h2>{s.agentName} answers your support line</h2>
          <p>Speaks {s.languages.map((l) => s.availableLanguages[l] ?? l).join(', ')}. Checks the caller, reads your systems, logs a ticket and hands over to a person when needed.</p>
        </div>
        <div className="va-hero-actions">
          <span className={`va-state ${s.enabled ? 'on' : ''}`}>{s.enabled ? 'On' : 'Off'}</span>
          <button className="btn btn-primary" onClick={() => setTest(true)}><Icon name="message" size={15} /> Try a test call</button>
        </div>
      </header>
      <ol className="va-steps">
        <li className="done"><b>1. Agent and languages</b><span>Below</span></li>
        <li className={s.archiveConfigured ? 'done' : ''}><b>2. Storage for recordings</b><span>{s.archiveConfigured ? 'S3 bucket connected' : 'Add the S3 bucket in Railway'}</span></li>
        <li className={s.speechConfigured ? 'done' : ''}><b>3. Speech (Sarvam AI)</b><span>{s.speechConfigured ? 'Voice ready — try a spoken test call' : 'Add the key in Railway for real voice'}</span></li>
        <li><b>4. Phone number</b><span>Plivo or Exotel trial; calls your verified mobile</span></li>
      </ol>
      {s.canManage && <SettingsForm s={s} />}
      {s.canManage && <Connectors />}
      <CallLog />
      {test && <TestCall s={s} onClose={() => setTest(false)} />}
    </div>
  );
}

function SettingsForm({ s }: { s: VoiceSettings }) {
  const wid = useWorkspaceId();
  const types = useWsQuery(['work-types'], () => workApi.types(), { staleTime: 300_000 });
  const [f, setF] = useState(s);
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(s), [s]);
  const set = <K extends keyof VoiceSettings>(k: K, v: VoiceSettings[K]) => setF((x) => ({ ...x, [k]: v }));
  const toggleLang = (l: string) => set('languages', f.languages.includes(l) ? f.languages.filter((x) => x !== l) : [...f.languages, l]);
  const save = async () => {
    setBusy(true);
    try { await voiceApi.save(f); toast('Voice agent saved.'); void invalidateWorkspace(wid, 'voice'); }
    catch (e) { toast(errText(e, 'Could not save.'), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <section className="va-card" aria-labelledby="va-agent">
      <h3 id="va-agent"><Icon name="user" size={16} /> The agent</h3>
      <div className="va-grid">
        <label className="va-field"><span>Name</span><input value={f.agentName} onChange={(e) => set('agentName', e.target.value)} /></label>
        <label className="va-field"><span>Company name it says</span><input value={f.companyName} onChange={(e) => set('companyName', e.target.value)} placeholder="FiveStar Business Finance" /></label>
      </div>
      <div className="va-field"><span>Languages (the first is the greeting language)</span>
        <div className="va-langs">{Object.entries(f.availableLanguages).map(([code, name]) => (
          <button key={code} type="button" className={f.languages.includes(code) ? 'on' : ''} aria-pressed={f.languages.includes(code)} onClick={() => toggleLang(code)}>
            {f.languages.includes(code) && <span className="va-order">{f.languages.indexOf(code) + 1}</span>}{name}</button>
        ))}</div></div>
      <label className="va-field"><span>What it should know (products, policies, branch hours, common answers)</span>
        <textarea rows={6} value={f.knowledge ?? ''} onChange={(e) => set('knowledge', e.target.value)} placeholder={'EMI is due on the 5th of each month.\nBranches open 9:30 am to 6 pm, Monday to Saturday.\nFor a foreclosure letter, the customer must visit the branch with ID.'} /></label>
      <label className="va-toggle"><input type="checkbox" checked={f.requireVerification} onChange={(e) => set('requireVerification', e.target.checked)} />
        <span><b>Check the caller before sharing account details</b><small>They confirm:</small>
          <input value={f.verificationRule} onChange={(e) => set('verificationRule', e.target.value)} disabled={!f.requireVerification} aria-label="What the caller confirms" /></span></label>
      <div className="va-grid">
        <label className="va-field"><span>Transfer to a person at</span><input value={f.transferNumber ?? ''} onChange={(e) => set('transferNumber', e.target.value || null)} placeholder="+91 …" /></label>
        <label className="va-field"><span>Tickets are created as</span>
          <Select className="select" aria-label="Ticket type" value={f.workTypeId ?? ''} onChange={(e) => set('workTypeId', e.target.value || null)}>
            <option value="">First work type</option>{(types.data ?? []).filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></label>
      </div>
      <label className="va-field"><span>Storage folders for recordings and transcripts</span>
        <input value={f.storageKeyPattern} onChange={(e) => set('storageKeyPattern', e.target.value)} />
        <small>Use {PATTERN_HELP}. Example: {'{yyyy}/{MM}/{dd}/{ticket}-{callId}'} → 2026/10/20/WT-42-a1b2…/transcript.json</small></label>
      <div className="va-actions">
        <label className="va-toggle inline"><input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} /><span><b>Agent on</b></span></label>
        <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? <Spinner /> : null} Save</button>
      </div>
    </section>
  );
}

function Connectors() {
  const q = useWsQuery(['voice', 'connectors'], voiceApi.connectors);
  const [edit, setEdit] = useState<Connector | 'new' | null>(null);
  const remove = async (c: Connector) => {
    if (!(await confirmDialog({ title: `Remove ${c.name}?`, message: 'The agent can no longer read this system.', confirmText: 'Remove', danger: true }))) return;
    try { await voiceApi.removeConnector(c.id); void q.refetch(); } catch (e) { toast(errText(e, 'Could not remove.'), 'error'); }
  };
  return (
    <section className="va-card" aria-labelledby="va-conn">
      <div className="va-card-head"><h3 id="va-conn"><Icon name="link" size={16} /> Your systems it can read</h3>
        <button className="btn btn-sm" onClick={() => setEdit('new')}><Icon name="plus" size={14} /> Add API</button></div>
      <p className="va-muted">Your MuleSoft APIs (loan details, EMI schedule, payments). The agent only reads them, and only says figures they return. Keys are stored encrypted and never shown again.</p>
      {(q.data ?? []).length === 0 ? <p className="va-muted">None yet. Without them the agent takes a ticket for account questions.</p> : (
        <ul className="va-conns">{q.data!.map((c) => (
          <li key={c.id}><div><b>{c.name}</b> <small>{c.method} · {c.urlTemplate}</small><p>{c.description}</p></div>
            <span className="va-conn-actions"><button className="btn btn-sm btn-ghost" onClick={() => setEdit(c)}>Edit</button><button className="btn btn-sm btn-ghost" onClick={() => void remove(c)}>Remove</button></span></li>
        ))}</ul>
      )}
      {edit && <ConnectorModal c={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void q.refetch(); }} />}
    </section>
  );
}

function ConnectorModal({ c, onClose, onSaved }: { c: Connector | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: c?.name ?? '', description: c?.description ?? '', method: c?.method ?? 'GET', urlTemplate: c?.urlTemplate ?? '', headerName: c?.headerName ?? 'client_id', secret: '', enabled: c?.enabled ?? true });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await voiceApi.saveConnector(f, c?.id); toast('Saved.'); onSaved(); } catch (e) { toast(errText(e, 'Could not save.'), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal title={c ? `Edit ${c.name}` : 'Add an API'} onClose={onClose} size="lg"
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? <Spinner /> : null} Save</button></>}>
      <div className="va-form">
        <label className="va-field"><span>Name (the agent uses it)</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="loan_details" /></label>
        <label className="va-field"><span>What it returns and when to use it</span><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Loan balance, next EMI date and amount, and the customer's date of birth, by loan number" /></label>
        <div className="va-grid">
          <label className="va-field va-short"><span>Method</span><Select className="select" aria-label="Method" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option>GET</option><option>POST</option></Select></label>
          <label className="va-field"><span>Address (https; caller values in braces)</span><input value={f.urlTemplate} onChange={(e) => setF({ ...f, urlTemplate: e.target.value })} placeholder="https://api.yourcompany.in/loans/v1/{loanNumber}" /></label>
        </div>
        <div className="va-grid">
          <label className="va-field"><span>Key header</span><input value={f.headerName} onChange={(e) => setF({ ...f, headerName: e.target.value })} placeholder="client_id or Authorization" /></label>
          <label className="va-field"><span>Key {c?.hasSecret ? '(leave empty to keep)' : ''}</span><input type="password" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} autoComplete="off" /></label>
        </div>
        <p className="va-muted">Use a read-only key made for the agent. Private and local addresses are refused.</p>
      </div>
    </Modal>
  );
}

function CallLog() {
  const q = useWsQuery(['voice', 'calls'], voiceApi.calls, { refetchInterval: 30_000 });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="va-card" aria-labelledby="va-calls">
      <h3 id="va-calls"><Icon name="list" size={16} /> Calls</h3>
      {(q.data ?? []).length === 0 ? <p className="va-muted">No calls yet. Try a test call above.</p> : (
        <ul className="va-calls">{q.data!.map((c) => (
          <li key={c.id}><button onClick={() => setOpen(c.id)}>
            <span className={`va-dot ${c.status}`} /><span className="va-call-main"><b>{c.callerNumber ?? (c.channel === 'test' ? 'Test call' : 'Unknown caller')}</b>
              <small>{formatDateTime(c.startedAt)} · {c.language.toUpperCase()}{c.ticketKey ? ` · ${c.ticketKey}` : ''}{c.transferred ? ' · transferred' : ''}</small>
              {c.summary && <span className="va-sum">{c.summary}</span>}</span></button></li>
        ))}</ul>
      )}
      {open && <CallModal id={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function CallModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useWsQuery(['voice', 'call', id], () => voiceApi.call(id));
  const c = q.data;
  return (
    <Modal title={c ? `${c.channel === 'test' ? 'Test call' : 'Call'} · ${formatDateTime(c.startedAt)}` : 'Call'} onClose={onClose} size="lg">
      {!c ? <PageLoader /> : <>
        {c.summary && <p className="va-summary"><b>Summary:</b> {c.summary}</p>}
        <p className="va-muted">{[c.ticketKey && `Ticket ${c.ticketKey}`, c.verified && 'Caller verified', c.transferred && 'Transferred', c.archiveKey && `Archived: ${c.archiveKey}`].filter(Boolean).join(' · ')}
          {c.workTaskId && <> · <Link to={`/operations?task=${c.workTaskId}`}>Open ticket</Link></>}</p>
        <Transcript turns={c.turns} />
      </>}
    </Modal>
  );
}

function Transcript({ turns, typing }: { turns: Turn[]; typing?: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [turns.length, typing]);
  return (
    <div className="va-transcript">
      {turns.map((t, i) => t.role === 'tool'
        ? <div key={i} className="va-tool"><Icon name="database" size={12} /> {t.tool}: {t.text.length > 160 ? t.text.slice(0, 160) + '…' : t.text}</div>
        : <div key={i} className={`va-bubble ${t.role}`}>{t.text}</div>)}
      {typing && <div className="va-bubble agent typing"><Spinner /></div>}
      <div ref={end} />
    </div>
  );
}

/** Plays the agent's line (base64 WAV from Sarvam). Returns when it finishes so the mic is not opened over the agent's voice. */
function play(audio: string | null | undefined, player: MutableRefObject<HTMLAudioElement | null>): Promise<void> {
  if (!audio) return Promise.resolve();
  player.current?.pause();
  const a = new Audio(`data:audio/wav;base64,${audio}`);
  player.current = a;
  return new Promise((done) => { a.onended = () => done(); a.onerror = () => done(); void a.play().catch(() => done()); });
}

function TestCall({ s, onClose }: { s: VoiceSettings; onClose: () => void }) {
  const wid = useWorkspaceId();
  const canTalk = !!s.speechConfigured && typeof window !== 'undefined' && 'MediaRecorder' in window && !!navigator.mediaDevices?.getUserMedia;
  const [lang, setLang] = useState(s.languages[0] ?? 'en');
  const [phone, setPhone] = useState('');
  const [talk, setTalk] = useState(canTalk);
  const [call, setCall] = useState<Call | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [ended, setEnded] = useState(false);
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  useEffect(() => () => { player.current?.pause(); stream.current?.getTracks().forEach((t) => t.stop()); }, []);
  const answered = async (r: Reply) => {
    setCall(r.call); setEnded(r.ended);
    if (r.ended) void invalidateWorkspace(wid, 'voice');
    if (talk) await play(r.audio, player);
  };
  const start = async () => {
    setBusy(true);
    try { const r = await voiceApi.start({ language: lang, callerNumber: phone || undefined, speak: talk }); setBusy(false); await answered(r); }
    catch (e) { toast(errText(e, 'Could not start.'), 'error'); } finally { setBusy(false); }
  };
  const send = async () => {
    if (!call || !text.trim()) return;
    const said = text.trim(); setText('');
    setCall({ ...call, turns: [...call.turns, { role: 'caller', text: said, at: new Date().toISOString() }] });
    setBusy(true);
    try { const r = await voiceApi.say(call.id, said, talk); setBusy(false); await answered(r); }
    catch (e) { toast(errText(e, 'The agent did not answer.'), 'error'); }
    finally { setBusy(false); }
  };
  const record = async () => {
    if (!call) return;
    if (rec) { rec.stop(); return; }
    player.current?.pause();
    try {
      stream.current ??= await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
      const m = new MediaRecorder(stream.current, type ? { mimeType: type } : undefined);
      const parts: Blob[] = [];
      m.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
      m.onstop = async () => {
        setRec(null);
        const blob = new Blob(parts, { type: m.mimeType || 'audio/webm' });
        if (blob.size < 800) { toast('That was too short — tap, speak, then tap again.', 'error'); return; }
        setBusy(true);
        try {
          const r = await voiceApi.listen(call.id, new File([blob], 'speech.' + (blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'), { type: blob.type }));
          setBusy(false); await answered(r);
        } catch (e) { toast(errText(e, 'The agent did not hear that.'), 'error'); } finally { setBusy(false); }
      };
      m.start(); setRec(m);
      window.setTimeout(() => { if (m.state === 'recording') m.stop(); }, 45_000);
    } catch { toast('Allow the microphone to talk to the agent.', 'error'); setTalk(false); }
  };
  const hangUp = async () => {
    rec?.stop(); player.current?.pause();
    if (call && !ended) { try { await voiceApi.end(call.id); } catch { /* the call log shows it */ } }
    void invalidateWorkspace(wid, 'voice'); onClose();
  };
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
              <button type="button" className={`va-mic-btn${rec ? ' on' : ''}`} disabled={busy} onClick={() => void record()} aria-label={rec ? 'Stop and send' : 'Speak'}>
                {busy ? <Spinner /> : <Icon name={rec ? 'square' : 'mic'} size={22} />}
              </button>
              <span>{rec ? 'Listening… tap to send' : busy ? 'The agent is thinking…' : 'Tap and speak'}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTalk(false)}>Type instead</button>
            </div>
            : <form className="va-say" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="नमस्ते, मेरी EMI कब है? / నా లోన్ బ్యాలెన్స్ ఎంత? / What is my loan balance?" aria-label="What the caller says" autoFocus disabled={busy} />
              <button className="btn btn-primary" disabled={busy || !text.trim()}><Icon name="send" size={14} /></button>
            </form>}
        </div>
      )}
    </Modal>
  );
}
