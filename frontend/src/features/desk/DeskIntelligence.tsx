import { Select } from '../../components/Select';
import { useEffect, useRef, useState } from 'react';
import { SiriOrb } from '../../components/aura/SiriOrb';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { deskAiApi, isObj, type DeskRouting, type EngineerStatus, type VoiceSession, type VoiceStep, type WhatsAppThread } from '../../api/deskAiApi';
import { useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { useDeskSettings } from './deskAiHooks';
import { acceptState } from './deskAiLogic';
import './desk-ai.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const hm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const mins = (iso: string, now: number) => Math.round((Date.parse(iso) - now) / 60e3);
const STATUS_LABEL: Record<EngineerStatus, string> = { available: 'Available', busy: 'Busy', away: 'Away', offline: 'Offline' };
const METHOD_LABEL: Record<string, string> = { auto: 'Routed by AI', manual: 'Reassigned', override: 'Supervisor override', escalated: 'Escalated', review: 'Waiting for a person', existing: 'Assigned when raised' };
const LANG: Record<string, string> = { en: 'English', hi: 'हिन्दी', te: 'తెలుగు', ta: 'தமிழ்', kn: 'ಕನ್ನಡ', ml: 'മലയാളം', mr: 'मराठी', bn: 'বাংলা', gu: 'ગુજરાતી', pa: 'ਪੰਜਾਬੀ', od: 'ଓଡ଼ିଆ' };

/** The signed-in engineer's availability, in the Desk's toolbar. Shown once routing is on. */
export function AvailabilitySwitch({ meId }: { meId: string | null }) {
  const qc = useQueryClient();
  const wid = useWorkspaceId();
  const settings = useDeskSettings();
  const people = useWsQuery(['desk', 'engineers'], () => deskAiApi.engineers(), { staleTime: 30_000, retry: false, enabled: !!settings?.routingEnabled });
  const mine = Array.isArray(people.data) ? people.data.find((p) => p.userId === meId) : undefined;
  if (!settings?.routingEnabled || !meId) return null;
  const status = mine?.status ?? 'offline';
  const set = async (s: EngineerStatus) => {
    try { await deskAiApi.myStatus(s); toast(`You are ${STATUS_LABEL[s].toLowerCase()} for new tickets.`); }
    catch (e) { toast(errText(e, 'Could not change your status.'), 'error'); }
    finally { void qc.invalidateQueries({ queryKey: [wid, 'desk', 'engineers'] }); }
  };
  return (
    <label className={`dai-avail s-${status}`} title="Your availability for new tickets">
      <i aria-hidden="true" />
      <Select aria-label="Your availability" value={status} onChange={(e) => void set(e.target.value as EngineerStatus)}>
        {(Object.keys(STATUS_LABEL) as EngineerStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
      </Select>
    </label>
  );
}

export function WhatsAppBubbles({ thread }: { thread: WhatsAppThread }) {
  const msgs = thread.messages.filter((m) => m.from !== 'system' || m.text.length < 200);
  return (
    <div className="dai-wa" data-testid="dai-wa-thread">
      <div className="dai-wa-h"><span className="dai-wa-dot" aria-hidden="true" />WhatsApp · {thread.chat.contactName ?? thread.chat.contact}{!thread.chat.canReply && <span className="dq-faint"> · 24-hour window closed, templates only</span>}</div>
      {msgs.map((m, i) => (
        <div key={`${m.at}-${i}`} className={`dai-wa-m ${m.from === 'contact' ? 'in' : m.from === 'system' ? 'note' : 'out'}`}>
          {m.media && <span className="dai-wa-media">{m.media.kind === 'voice' ? '🎙 Voice note' : m.media.kind === 'image' ? '🖼 Photo' : m.media.kind === 'video' ? '🎬 Video' : `📄 ${m.media.fileName ?? 'Document'}`}</span>}
          <span>{m.text}</span>
          <small>{[m.from === 'ai' ? 'AI employee' : m.from === 'update' ? m.by ?? 'Update' : m.from === 'agent' ? m.by : null, hm(m.at)].filter(Boolean).join(' · ')}</small>
        </div>
      ))}
    </div>
  );
}

/** AI summary, assignment (accept, next engineer, reassign, supervisor override, review) and the SLA clocks of one ticket. */
export function RoutingCard({ ticketId, now }: { ticketId: string; now: number }) {
  const qc = useQueryClient();
  const wid = useWorkspaceId();
  const q = useWsQuery(['desk', 'routing', ticketId], () => deskAiApi.routing(ticketId), { staleTime: 15_000, refetchInterval: 30_000, retry: false });
  const people = useWsQuery(['desk', 'engineers'], () => deskAiApi.engineers(), { staleTime: 30_000, retry: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [pick, setPick] = useState(false);
  const r = isObj<DeskRouting>(q.data) && 'workTaskId' in q.data ? q.data : null;
  if (!r || (!r.routingEnabled && !r.insight)) return null;
  const run = async (what: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(what);
    try { await fn(); toast(done); }
    catch (e) { toast(errText(e, 'Could not save the change.'), 'error'); }
    finally { setBusy(null); setPick(false); void qc.invalidateQueries({ queryKey: [wid, 'desk'] }); }
  };
  const cur = r.current;
  const i = r.insight;
  const engineers = Array.isArray(people.data) ? people.data : [];
  const state = acceptState(cur, now);
  return (
    <div className="dq-card dq-cc dai-card" data-testid="dai-routing">
      {i && (
        <div className="dai-sum">
          <div className="dai-sum-h"><SiriOrb className="dq-orb" /><b>AI summary</b>
            <span className="dq-sp" /><span className={`dai-conf${i.needsReview ? ' low' : ''}`} title={i.source === 'ai' ? 'From the AI model' : 'From keyword rules'}>{i.confidence}%</span></div>
          {i.summary && <p>{i.summary}</p>}
          <div className="dai-chips">
            <span>{i.category}</span><span className={`dq-pill p-${i.priority.toLowerCase()}`}>{i.priority}</span>{i.department && <span>{i.department}</span>}
            {i.channel !== 'app' && <span>{i.channel === 'whatsapp' ? 'WhatsApp' : 'Voice'}</span>}{i.contact && <span>{i.contact.name}{i.organization ? ` · ${i.organization}` : ''}</span>}
          </div>
          {i.needsReview && (
            <div className="dai-review" role="status">
              <span>Below the {r.threshold}% threshold — a person decides.</span>
              <div className="dq-row" style={{ gap: 6 }}>
                <button type="button" className="dq-btn sm pri" disabled={!!busy} onClick={() => void run('approve', () => deskAiApi.review(ticketId, true), 'Approved and routed.')}>Approve</button>
                <button type="button" className="dq-btn sm" disabled={!!busy} onClick={() => void run('reject', () => deskAiApi.review(ticketId, false), 'Kept as it was.')}>Reject</button>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="dq-lbl" style={{ marginTop: i ? 12 : 0 }}>Assignment</div>
      {cur ? (
        <div className="dai-asg">
          <div className="dq-kv"><span>{METHOD_LABEL[cur.method] ?? cur.method}</span><b>{cur.assignee?.name ?? 'Unassigned'}</b></div>
          {cur.reason && <div className="dai-why">{cur.reason}</div>}
          {state && <div className={`dai-state ${state.tone}`}>{state.text}</div>}
        </div>
      ) : <div className="dq-faint dq-s12">{r.routingEnabled ? 'Not routed yet.' : 'Routing is off.'}</div>}
      <div className="dai-acts">
        {r.canAccept && <button type="button" className="dq-btn sm pri" disabled={!!busy} onClick={() => void run('accept', () => deskAiApi.accept(ticketId), 'Accepted.')}>{busy === 'accept' ? 'Accepting…' : 'Accept'}</button>}
        {r.routingEnabled && <button type="button" className="dq-btn sm" disabled={!!busy} onClick={() => void run('next', () => deskAiApi.reassign(ticketId, null), 'Offered to the next engineer.')}>Next engineer</button>}
        <button type="button" className="dq-btn sm" aria-expanded={pick} onClick={() => setPick((v) => !v)}>{r.canOverride ? 'Override…' : 'Reassign…'}</button>
      </div>
      {pick && (
        <div className="dai-pick" role="listbox" aria-label="Give the ticket to">
          {(r.candidates.length ? r.candidates.map((c) => ({ id: c.userId, name: c.name, note: c.reason, score: c.score as number | null }))
            : engineers.map((e) => ({ id: e.userId, name: e.name, note: `${STATUS_LABEL[e.status]} · ${e.active} open`, score: null as number | null }))).slice(0, 6).map((c) => (
            <button key={c.id} type="button" role="option" aria-selected={cur?.assignee?.id === c.id} className="dai-pick-i" disabled={!!busy}
              onClick={() => void run('pick', () => (r.canOverride ? deskAiApi.override(ticketId, c.id, 'Chosen on the Desk') : deskAiApi.reassign(ticketId, c.id)), `Given to ${c.name}.`)}>
              <b>{c.name}</b><span>{c.note}</span>{c.score !== null && <i style={{ width: `${Math.max(6, c.score)}%` }} aria-label={`Score ${c.score}`} />}
            </button>
          ))}
          {r.candidates.length === 0 && engineers.length === 0 && <div className="dq-faint dq-s12">No engineers set up. Add them in Desk › Integrations.</div>}
        </div>
      )}
      {(r.responseDueAt || r.resolutionDueAt) && (
        <div className="dai-sla">
          {r.responseDueAt && <div><span>First response</span><b className={mins(r.responseDueAt, now) < 0 ? 'late' : ''}>{hm(r.responseDueAt)}</b></div>}
          {r.resolutionDueAt && <div><span>Resolve by</span><b className={mins(r.resolutionDueAt, now) < 0 ? 'late' : ''}>{new Date(r.resolutionDueAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</b></div>}
        </div>
      )}
    </div>
  );
}

/** One recorded turn: fetched with the session only when played. */
function TurnAudio({ sessionId, index }: { sessionId: string; index: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (url) return <audio className="dai-audio" src={url} controls autoPlay />;
  return <button type="button" className="dai-play" aria-label="Play the recording" onClick={() => { deskAiApi.audio(sessionId, index).then(setUrl).catch((e: unknown) => toast(errText(e, 'The recording is no longer kept.'), 'error')); }}>▶</button>;
}

/** Voice conversations on the ticket (transcript, summary, recordings) and the way to start one or call back. */
export function VoiceCard({ ticketId }: { ticketId: string }) {
  const status = useWsQuery(['desk', 'voice-status'], () => deskAiApi.voiceStatus(), { staleTime: 60_000, retry: false });
  const list = useWsQuery(['desk', 'voice', ticketId], () => deskAiApi.ticketVoice(ticketId), { staleTime: 30_000, retry: false });
  const [open, setOpen] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const sessions = Array.isArray(list.data) ? list.data : [];
  const st = isObj<NonNullable<typeof status.data>>(status.data) && 'enabled' in status.data ? status.data : null;
  if (!st?.enabled && sessions.length === 0) return null;
  const callback = async () => {
    const number = window.prompt('Customer phone number with country code');
    if (!number) return;
    try { await deskAiApi.callback(ticketId, number); toast('Calling…'); }
    catch (e) { toast(errText(e, 'The call could not be placed.'), 'warning'); }
  };
  return (
    <div className="dq-card dq-cc dai-card" data-testid="dai-voice">
      <div className="dq-row"><div className="dq-lbl" style={{ margin: 0 }}>Voice</div><span className="dq-sp" />
        {st?.enabled && <button type="button" className="dq-btn sm" onClick={() => setSheet(true)}>Voice intake</button>}
        {st?.enabled && <button type="button" className="dq-btn sm white" title={st.telephonyReady ? 'Call the customer' : 'Needs a telephony provider'} onClick={() => void callback()}>Call back</button>}
      </div>
      {sessions.length === 0 ? <div className="dq-faint dq-s12" style={{ marginTop: 8 }}>No calls on this ticket yet.</div> : sessions.map((s) => (
        <div key={s.id} className="dai-call">
          <button type="button" className="dai-call-h" aria-expanded={open === s.id} onClick={() => setOpen((v) => (v === s.id ? null : s.id))}>
            <span className={`dai-call-ic ${s.status}`} aria-hidden="true" />
            <b>{new Date(s.startedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</b>
            <span className="dq-faint">{[LANG[s.language] ?? s.language, s.recorded ? 'recorded' : s.consentGiven === false ? 'not recorded' : null, s.status].filter(Boolean).join(' · ')}</span>
          </button>
          {s.summary && <p className="dai-call-sum">{s.summary}</p>}
          {open === s.id && (
            <ol className="dai-tr" aria-label="Transcript">
              {s.transcript.map((t) => <li key={t.index} className={t.role}><span>{t.role === 'caller' ? 'Caller' : 'Assistant'}</span><p>{t.text}</p>{t.hasAudio && <TurnAudio sessionId={s.id} index={t.index} />}</li>)}
            </ol>
          )}
        </div>
      ))}
      {sheet && st && <VoiceSheet ticketId={ticketId} languages={st.languages} speechReady={st.speechReady} onClose={() => setSheet(false)} />}
    </div>
  );
}

/** Voice intake: language, the consent question, turns (microphone with Sarvam, or typed), then the summary and the ticket. */
export function VoiceSheet({ ticketId, languages, speechReady, onClose }: { ticketId: string | null; languages: string[]; speechReady: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const wid = useWorkspaceId();
  const [lang, setLang] = useState(languages[0] ?? 'en');
  const [step, setStep] = useState<VoiceStep | null>(null);
  const [done, setDone] = useState<VoiceSession | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const speak = (s: VoiceStep) => { if (s.audio) void new Audio(`data:audio/wav;base64,${s.audio}`).play().catch(() => undefined); };
  const go = async (fn: () => Promise<VoiceStep>) => {
    setBusy(true);
    try { const s = await fn(); setStep(s); speak(s); }
    catch (e) { toast(errText(e, 'That did not work.'), 'error'); }
    finally { setBusy(false); }
  };
  const finish = async () => {
    if (!step) return;
    setBusy(true);
    try { setDone(await deskAiApi.complete(step.session.id)); void qc.invalidateQueries({ queryKey: [wid, 'desk'] }); }
    catch (e) { toast(errText(e, 'Could not finish the conversation.'), 'error'); }
    finally { setBusy(false); }
  };
  const record = async () => {
    if (rec) { rec.stop(); return; }
    if (!step) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream);
      chunks.current = [];
      r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      r.onstop = () => { stream.getTracks().forEach((t) => t.stop()); setRec(null); const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' }); void go(() => deskAiApi.listen(step.session.id, blob)); };
      r.start(); setRec(r);
    } catch { toast('The microphone is not available. Type what the caller says instead.', 'warning'); }
  };
  const session = step?.session;
  const turns = session?.transcript ?? [];
  return createPortal(
    <div className="dq-page dai-scrim" role="presentation" onClick={onClose}>
      <div className="dai-sheet" role="dialog" aria-modal="true" aria-label="Voice intake" onClick={(e) => e.stopPropagation()}>
        <div className="dai-sheet-h"><b>Voice intake</b><span className="dq-faint">{speechReady ? 'Sarvam AI speech' : 'Typed (speech not set up)'}</span><span className="dq-sp" />
          <button type="button" className="dq-sr-x" aria-label="Close" onClick={onClose}>×</button></div>
        {!step && (
          <div className="dai-sheet-b">
            <p className="dai-lead">The assistant introduces itself as automated and asks before recording. Nothing is kept until the caller agrees.</p>
            <div className="dai-langs" role="radiogroup" aria-label="Language">
              {languages.map((l) => <button key={l} type="button" role="radio" aria-checked={lang === l} className={lang === l ? 'on' : ''} onClick={() => setLang(l)}>{LANG[l] ?? l}</button>)}
            </div>
            <button type="button" className="dq-btn pri" disabled={busy} onClick={() => void go(() => deskAiApi.startVoice(ticketId, lang))}>Start</button>
          </div>
        )}
        {step && !done && (
          <div className="dai-sheet-b">
            <ol className="dai-tr live" aria-label="Conversation">{turns.map((t) => <li key={t.index} className={t.role}><span>{t.role === 'caller' ? 'Caller' : 'Assistant'}</span><p>{t.text}</p></li>)}</ol>
            {session?.status === 'consent' ? (
              <div className="dai-consent">
                <button type="button" className="dq-btn pri" disabled={busy} onClick={() => void go(() => deskAiApi.consent(session.id, true))}>Caller agrees</button>
                <button type="button" className="dq-btn" disabled={busy} onClick={() => void go(() => deskAiApi.consent(session.id, false))}>Caller declines recording</button>
              </div>
            ) : (
              <form className="dq-comp dai-turn" onSubmit={(e) => { e.preventDefault(); const t = text.trim(); if (t && session) { setText(''); void go(() => deskAiApi.say(session.id, t)); } }}>
                {speechReady && <button type="button" className={`dai-mic${rec ? ' on' : ''}`} aria-label={rec ? 'Stop and send' : 'Record the caller'} onClick={() => void record()} disabled={busy && !rec}>●</button>}
                <textarea rows={1} value={text} aria-label="What the caller said" placeholder="Type what the caller said…" onChange={(e) => setText(e.target.value)} />
                <button type="submit" className="dq-kbd" disabled={busy || !text.trim()}>Send</button>
              </form>
            )}
            <div className="dq-row" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="dq-btn sm pri" disabled={busy || session?.status !== 'active' || turns.filter((t) => t.role === 'caller').length < 2} onClick={() => void finish()}>Finish and file ticket</button>
            </div>
          </div>
        )}
        {done && (
          <div className="dai-sheet-b">
            <div className="dai-done"><span aria-hidden="true">✓</span><div><b>{done.ticketKey ?? 'Ticket'} {ticketId ? 'updated' : 'raised'}</b><p>{done.summary}</p>
              <small className="dq-faint">{done.recorded ? `Recording kept until ${new Date(done.retainUntil ?? '').toLocaleDateString()}` : 'No recording kept'}</small></div></div>
            <button type="button" className="dq-btn pri" onClick={onClose}>Done</button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
