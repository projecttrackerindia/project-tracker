import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { chatApi } from '../../api/endpoints';
import type { ChatCatchUp, ChatCatchUpItem, ChatAskAnswer, ChatStatus, Conversation } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, Modal, Spinner } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { queryClient, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { audioSupported, startRecording, unlockAudio, type Recording } from '../work/voiceAudio';
import { chatKeys } from './chatStore';
import { listTime, plainText } from './chatFormat';

/** Opens a message where it was said: its conversation (and its thread), scrolled to it. */
export const messageLink = (conversationId: string, messageId: string | null, threadRootId?: string | null) =>
  `/chat/${conversationId}${threadRootId ? `?thread=${threadRootId}&m=${messageId ?? ''}` : messageId ? `?m=${messageId}` : ''}`;

// ------------------------------------------------------------------ catch me up

function ItemList({ title, icon, items, onOpen }: { title: string; icon: string; items: ChatCatchUpItem[]; onOpen: (i: ChatCatchUpItem) => void }) {
  if (!items.length) return null;
  return (
    <section className="cu-sec">
      <h4><span aria-hidden="true">{icon}</span> {title}</h4>
      <ul>
        {items.map((i, n) => (
          <li key={n}>
            <span>{i.text}{i.owner && <em> · {i.owner}</em>}{i.due && <em> · {i.due}</em>}</span>
            {i.messageId && i.conversationId && <button type="button" className="link-btn" onClick={() => onOpen(i)}>{i.conversationName ?? 'Open'} →</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Catch me up": what was missed - in one conversation or in all - as a summary with decisions, questions to me and actions, each linked to its message. */
export function CatchUpDialog({ conversationId, onClose }: { conversationId?: string | null; onClose: () => void }) {
  const navigate = useNavigate();
  const [state, setState] = useState<{ busy: boolean; data: ChatCatchUp | null; error: string | null }>({ busy: true, data: null, error: null });
  useEffect(() => {
    let off = false;
    chatApi.catchUp(conversationId).then((data) => { if (!off) setState({ busy: false, data, error: null }); })
      .catch((e) => { if (!off) setState({ busy: false, data: null, error: e instanceof ApiError ? e.message : 'Could not catch you up right now.' }); });
    return () => { off = true; };
  }, [conversationId]);
  const open = (i: ChatCatchUpItem) => { onClose(); navigate(messageLink(i.conversationId!, i.messageId)); };
  const d = state.data;
  return (
    <Modal title="✨ Catch me up" subtitle={conversationId ? 'What you missed in this conversation' : 'What you missed in your chats'} onClose={onClose}
      footer={<button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>}>
      {state.busy ? <p className="muted"><Spinner /> Reading what you missed…</p>
        : state.error ? <div className="doc-alert" role="alert"><div>{state.error}</div></div>
          : d && (
            <div className="catch-up" aria-live="polite">
              <p className="cu-summary">{d.summary}</p>
              {d.messages > 0 && <p className="muted small">{d.messages} message{d.messages === 1 ? '' : 's'} in {d.conversations} conversation{d.conversations === 1 ? '' : 's'}</p>}
              <ItemList title="Questions for you" icon="❓" items={d.questions} onOpen={open} />
              <ItemList title="Decisions" icon="🧭" items={d.decisions} onOpen={open} />
              <ItemList title="Actions" icon="✅" items={d.actions} onOpen={open} />
            </div>
          )}
    </Modal>
  );
}

// ------------------------------------------------------------------ ask the chat

export function AskChatDialog({ conversationId, onClose }: { conversationId?: string | null; onClose: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<ChatAskAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ask = async () => {
    if (q.trim().length < 3 || busy) return;
    setBusy(true); setError(null);
    try { setAnswer(await chatApi.ask(q.trim(), conversationId)); } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not answer right now.'); }
    setBusy(false);
  };
  const parts = answer ? answer.answer.split(/(\[\d+\])/g) : [];
  return (
    <Modal title="✨ Ask the chat" subtitle={conversationId ? 'Answers from this conversation, with links to the messages' : 'Answers from your conversations, with links to the messages'}
      onClose={onClose} onSubmit={(e) => { e.preventDefault(); void ask(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Close</button><button type="submit" className="btn btn-primary" disabled={busy || q.trim().length < 3}>{busy && <Spinner />}Ask</button></>}>
      <label className="field"><span>Question</span>
        <input className="input" value={q} maxLength={500} autoFocus onChange={(e) => setQ(e.target.value)} placeholder="e.g. What did we agree about the refund window?" /></label>
      {error && <div className="doc-alert" role="alert"><div>{error}</div></div>}
      {answer && (
        <div className="ask-answer" aria-live="polite">
          <p>{parts.map((p, i) => {
            const m = /^\[(\d+)\]$/.exec(p);
            const c = m ? answer.citations.find((x) => x.n === Number(m[1])) : undefined;
            return c ? <button key={i} type="button" className="dt-cite" onClick={() => { onClose(); navigate(messageLink(c.conversationId, c.messageId, c.threadRootId)); }}>{c.n}</button> : <span key={i}>{p}</span>;
          })}</p>
          {answer.citations.length > 0 && (
            <ol className="ask-sources">{answer.citations.map((c) => (
              <li key={c.n}><button type="button" className="link-btn" onClick={() => { onClose(); navigate(messageLink(c.conversationId, c.messageId, c.threadRootId)); }}>
                <b>{c.conversationName}</b> · {c.senderName ?? 'System'} · {listTime(c.at)}</button><q>{c.snippet}</q></li>
            ))}</ol>
          )}
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ questions waiting for me, saved messages, scheduled messages

export function QuestionsBox() {
  const wid = useWorkspaceId() ?? '';
  const navigate = useNavigate();
  const q = useWsQuery([...chatKeys.questions(wid)].slice(1), () => chatApi.questions(), { staleTime: 30_000 });
  const [open, setOpen] = useState(true);
  const items = q.data ?? [];
  if (!items.length) return null;
  return (
    <section className="q-box" aria-label="Questions waiting for you">
      <button type="button" className="q-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">❓</span><b>Waiting for your answer</b><span className="unread-badge">{items.length}</span><Icon name="chevronD" size={13} />
      </button>
      {open && (
        <ul>{items.slice(0, 6).map((x) => (
          <li key={x.messageId}>
            <button type="button" className="q-row" onClick={() => navigate(messageLink(x.conversationId, x.messageId, x.threadRootId))}>
              <span className="q-who"><b>{x.senderName ?? 'Someone'}</b> in {x.conversationName}</span><span className="q-text">{x.snippet}</span><time>{listTime(x.at)}</time>
            </button>
          </li>
        ))}</ul>
      )}
    </section>
  );
}

export function SavedPanel({ onClose }: { onClose: () => void }) {
  const wid = useWorkspaceId() ?? '';
  const navigate = useNavigate();
  const q = useWsQuery([...chatKeys.saved(wid)].slice(1), () => chatApi.saved(), { staleTime: 10_000 });
  const unsave = async (id: string) => {
    try { await chatApi.save(id, false); void q.refetch(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not remove it.', 'error'); }
  };
  return (
    <aside className="chat-info" aria-label="Saved messages">
      <div className="chat-info-head"><h3>Saved</h3><button className="btn-icon" onClick={onClose} aria-label="Close saved messages"><Icon name="close" /></button></div>
      <div className="chat-info-body">
        {q.isLoading && <Spinner />}
        {!q.isLoading && !q.data?.length && <EmptyState icon="star" title="Nothing saved" text="Save a message to find it here later (only you see this list)." />}
        <ul className="saved-list">{(q.data ?? []).map((s) => (
          <li key={s.message.id}>
            <button type="button" className="saved-row" onClick={() => navigate(messageLink(s.message.conversationId, s.message.id, s.message.threadRootId))}>
              <b>{s.conversationName}</b><span>{s.message.senderName ? `${s.message.senderName}: ` : ''}{plainText(s.message.body).slice(0, 160) || 'Attachment'}</span><time>{listTime(s.message.createdAt)}</time>
            </button>
            <button type="button" className="btn-icon sm" aria-label="Remove from saved" onClick={() => void unsave(s.message.id)}><Icon name="close" size={12} /></button>
          </li>
        ))}</ul>
      </div>
    </aside>
  );
}

export function ScheduledPanel({ conversationId, onClose }: { conversationId?: string; onClose: () => void }) {
  const wid = useWorkspaceId() ?? '';
  const q = useWsQuery([...chatKeys.scheduled(wid, conversationId)].slice(1), () => chatApi.scheduled(conversationId), { staleTime: 5_000 });
  const cancel = async (id: string) => {
    try { await chatApi.cancelScheduled(id); void q.refetch(); toast('Cancelled. It will not be sent.', 'info'); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not cancel it.', 'error'); }
  };
  return (
    <aside className="chat-info" aria-label="Scheduled messages">
      <div className="chat-info-head"><h3>Scheduled</h3><button className="btn-icon" onClick={onClose} aria-label="Close scheduled messages"><Icon name="close" /></button></div>
      <div className="chat-info-body">
        {!q.isLoading && !q.data?.length && <EmptyState icon="clock" title="Nothing scheduled" text="Write a message and choose “Send later” to send it at a set time." />}
        <ul className="saved-list">{(q.data ?? []).map((s) => (
          <li key={s.id} className={s.status === 'Failed' ? 'failed' : ''}>
            <div className="saved-row">
              <b>{s.conversationName} · {formatDateTime(s.sendAt)}</b>
              <span>{s.body.slice(0, 160)}</span>
              {s.status === 'Failed' && <em className="danger-text">Not sent: {s.error}</em>}
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void cancel(s.id)}>Cancel</button>
          </li>
        ))}</ul>
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ my status and do-not-disturb

const STATUS_PRESETS: { emoji: string; text: string; hours: number | null }[] = [
  { emoji: '📅', text: 'In a meeting', hours: 1 },
  { emoji: '🚗', text: 'Commuting', hours: 1 },
  { emoji: '🤒', text: 'Out sick', hours: 24 },
  { emoji: '🌴', text: 'On leave', hours: null },
  { emoji: '🏠', text: 'Working from home', hours: 10 },
];
const DND_PRESETS: { label: string; hours: number }[] = [{ label: '30 minutes', hours: 0.5 }, { label: '1 hour', hours: 1 }, { label: '2 hours', hours: 2 }, { label: 'Until tomorrow', hours: 16 }];

export function StatusButton() {
  const wid = useWorkspaceId() ?? '';
  const q = useWsQuery([...chatKeys.myStatus(wid)].slice(1), () => chatApi.status(), { staleTime: 60_000 });
  const [open, setOpen] = useState(false);
  const s = q.data;
  return (
    <>
      <button type="button" className={`btn btn-ghost btn-sm status-btn ${s?.dnd ? 'dnd' : ''}`} onClick={() => setOpen(true)} title="Your status and do not disturb">
        {s?.dnd ? '🔕' : s?.emoji ?? '🙂'}<span className="sr-only">Your status</span>
      </button>
      {open && <StatusDialog current={s ?? null} onClose={() => setOpen(false)} onSaved={(n) => { queryClient.setQueryData(chatKeys.myStatus(wid), n); invalidateWorkspace(wid, 'chat'); }} />}
    </>
  );
}

function StatusDialog({ current, onClose, onSaved }: { current: ChatStatus | null; onClose: () => void; onSaved: (s: ChatStatus) => void }) {
  const [emoji, setEmoji] = useState(current?.emoji ?? '');
  const [text, setText] = useState(current?.text ?? '');
  const [clearHours, setClearHours] = useState<number | null>(null);
  const [dndHours, setDndHours] = useState<number | null>(current?.dnd ? -1 : null);
  const [busy, setBusy] = useState(false);
  const save = async (clear = false) => {
    setBusy(true);
    const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
    try {
      const s = await chatApi.setStatus(clear ? {} : {
        emoji: emoji || null, text: text.trim() || null, clearAt: clearHours ? hoursFromNow(clearHours) : current?.clearAt ?? null,
        dndUntil: dndHours === -1 ? current?.dndUntil ?? null : dndHours ? hoursFromNow(dndHours) : null,
      });
      onSaved(s); onClose();
      toast(clear ? 'Status cleared.' : s.dnd ? 'Do not disturb is on: no pop-ups, and e-mail and push wait until it ends.' : 'Status saved.', 'success');
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save your status.', 'error'); }
    setBusy(false);
  };
  return (
    <Modal title="Your status" subtitle="The people you chat with see it beside your name" size="sm" onClose={onClose} onSubmit={(e) => { e.preventDefault(); void save(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={() => void save(true)} disabled={busy}>Clear</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy && <Spinner />}Save</button></>}>
      <div className="status-presets">
        {STATUS_PRESETS.map((p) => (
          <button key={p.text} type="button" className={text === p.text ? 'on' : ''} onClick={() => { setEmoji(p.emoji); setText(p.text); setClearHours(p.hours); }}>{p.emoji} {p.text}</button>
        ))}
      </div>
      <div className="make-row">
        <label className="field status-emoji"><span>Emoji</span><input className="input" value={emoji} maxLength={4} onChange={(e) => setEmoji(e.target.value)} placeholder="🙂" /></label>
        <label className="field"><span>Status</span><input className="input" value={text} maxLength={100} onChange={(e) => setText(e.target.value)} placeholder="e.g. On leave till Monday" /></label>
      </div>
      <fieldset className="dnd-set">
        <legend>🔕 Do not disturb</legend>
        <p className="muted small">No pop-ups for new messages; e-mail and phone push wait until it ends. Security alerts still reach you.</p>
        <div className="status-presets">
          <button type="button" className={dndHours === null ? 'on' : ''} onClick={() => setDndHours(null)}>Off</button>
          {current?.dnd && <button type="button" className={dndHours === -1 ? 'on' : ''} onClick={() => setDndHours(-1)}>Keep (until {formatDateTime(current.dndUntil!)})</button>}
          {DND_PRESETS.map((p) => <button key={p.label} type="button" className={dndHours === p.hours ? 'on' : ''} onClick={() => setDndHours(p.hours)}>{p.label}</button>)}
        </div>
      </fieldset>
    </Modal>
  );
}

// ------------------------------------------------------------------ polls and send later

export function PollDialog({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [closesIn, setClosesIn] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = question.trim().length >= 3 && options.filter((o) => o.trim()).length >= 2;
  const create = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await chatApi.createPoll(conversation.id, { question: question.trim(), options: options.map((o) => o.trim()).filter(Boolean), multiple,
        closesAt: closesIn ? new Date(Date.now() + closesIn * 3_600_000).toISOString() : null });
      onClose();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not start the poll.', 'error'); }
    setBusy(false);
  };
  return (
    <Modal title="📊 Quick poll" subtitle="Ask the group and record what was decided" size="sm" onClose={onClose} onSubmit={(e) => { e.preventDefault(); void create(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={!ready || busy}>{busy && <Spinner />}Post poll</button></>}>
      <label className="field"><span>Question</span><input className="input" value={question} maxLength={300} autoFocus onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Which date works for the release?" /></label>
      <div className="field"><span>Options</span>
        {options.map((o, i) => (
          <div key={i} className="poll-edit-row">
            <input className="input" value={o} maxLength={120} aria-label={`Option ${i + 1}`} placeholder={`Option ${i + 1}`} onChange={(e) => setOptions((all) => all.map((x, j) => (j === i ? e.target.value : x)))} />
            {options.length > 2 && <button type="button" className="btn-icon sm" aria-label={`Remove option ${i + 1}`} onClick={() => setOptions((all) => all.filter((_, j) => j !== i))}><Icon name="close" size={12} /></button>}
          </div>
        ))}
        {options.length < 10 && <button type="button" className="link-btn" onClick={() => setOptions((all) => [...all, ''])}><Icon name="plus" size={12} /> Add option</button>}
      </div>
      <label className="check"><input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} /> People may choose more than one</label>
      <label className="field"><span>Closes</span>
        <select className="input" value={closesIn ?? ''} onChange={(e) => setClosesIn(e.target.value ? Number(e.target.value) : null)}>
          <option value="">When I close it</option><option value="1">In 1 hour</option><option value="4">In 4 hours</option><option value="24">In a day</option><option value="72">In 3 days</option>
        </select></label>
    </Modal>
  );
}

const nextAt = (days: number, hour: number) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d; };
const nextMonday = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(9, 0, 0, 0); return d; };
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function ScheduleDialog({ conversation, body, threadRootId, onScheduled, onClose }: { conversation: Conversation; body: string; threadRootId?: string | null; onScheduled: () => void; onClose: () => void }) {
  const wid = useWorkspaceId() ?? '';
  const [at, setAt] = useState(localInput(nextAt(1, 9)));
  const [busy, setBusy] = useState(false);
  const presets = [{ label: 'Tomorrow 9 am', d: nextAt(1, 9) }, { label: 'Tomorrow 2 pm', d: nextAt(1, 14) }, { label: 'Monday 9 am', d: nextMonday() }];
  const save = async () => {
    setBusy(true);
    try {
      const s = await chatApi.schedule(conversation.id, { body, sendAt: new Date(at).toISOString(), threadRootId: threadRootId ?? null });
      void queryClient.invalidateQueries({ queryKey: chatKeys.scheduled(wid, conversation.id) });
      toast(`Scheduled for ${formatDateTime(s.sendAt)}.`, 'success');
      onScheduled(); onClose();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not schedule it.', 'error'); }
    setBusy(false);
  };
  return (
    <Modal title="Send later" subtitle={plainText(body).slice(0, 90)} size="sm" onClose={onClose} onSubmit={(e) => { e.preventDefault(); void save(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy || !at}>{busy && <Spinner />}Schedule</button></>}>
      <div className="status-presets">{presets.map((p) => <button key={p.label} type="button" className={localInput(p.d) === at ? 'on' : ''} onClick={() => setAt(localInput(p.d))}>{p.label}</button>)}</div>
      <label className="field"><span>Date and time</span><input className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></label>
    </Modal>
  );
}

// ------------------------------------------------------------------ voice notes

/**
 * Records a voice note (plain WAV, the same on every phone and browser), uploads it - it is transcribed on arrival - and hands the uploaded
 * file to send. Telugu, Hindi and English are understood.
 */
export function useVoiceRecorder(conversationId: string, onReady: (attachmentId: string) => void) {
  const [state, setState] = useState<'idle' | 'recording' | 'uploading'>('idle');
  const [secs, setSecs] = useState(0);
  const rec = useRef<Recording | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const started = useRef(0);
  useEffect(() => {
    if (state !== 'recording') return;
    const t = window.setInterval(() => setSecs(Math.round((Date.now() - started.current) / 1000)), 500);
    return () => window.clearInterval(t);
  }, [state]);
  useEffect(() => () => { rec.current?.cancel(); stream.current?.getTracks().forEach((t) => t.stop()); }, []);
  const stopTracks = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; };
  const start = async () => {
    unlockAudio();
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      rec.current = await startRecording(stream.current);
      started.current = Date.now(); setSecs(0); setState('recording');
    } catch { stopTracks(); toast('The microphone is not available. Allow it for this site in the browser.', 'error'); }
  };
  const cancel = () => { rec.current?.cancel(); rec.current = null; stopTracks(); setState('idle'); };
  const finish = async () => {
    const r = rec.current;
    if (!r) return;
    const blob = r.stop(); rec.current = null; stopTracks();
    const seconds = (Date.now() - started.current) / 1000;
    if (seconds < 1) { setState('idle'); toast('Hold on a little longer: that was too short to send.', 'info'); return; }
    setState('uploading');
    try { const a = await chatApi.uploadVoice(conversationId, blob, seconds); onReady(a.id); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not send the voice note.', 'error'); }
    setState('idle');
  };
  return { supported: audioSupported(), state, secs, start, cancel, finish };
}

// ------------------------------------------------------------------ rewrite what I am writing

export const COMPOSER_AI: { id: string; label: string; language?: string }[] = [
  { id: 'fix', label: 'Fix spelling and grammar' }, { id: 'shorten', label: 'Make it shorter' }, { id: 'formal', label: 'More formal' },
  { id: 'friendly', label: 'More friendly' }, { id: 'rewrite', label: 'Rewrite it clearly' },
  { id: 'translate', label: 'Translate to English', language: 'en' }, { id: 'translate', label: 'Translate to Telugu', language: 'te' }, { id: 'translate', label: 'Translate to Hindi', language: 'hi' },
];
