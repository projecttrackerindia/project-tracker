import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { chatApi, documentApi, projectApi, taskApi, workApi } from '../../api/endpoints';
import type { ChatAttachment, ChatExtract, ChatLink, ChatMessage, ChatPoll, ChatUnfurl, Conversation } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { Modal, Spinner } from '../../components/ui';
import { formatDate, formatDateTime } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { reminderApi } from '../reminders/api';
import { deviceZone } from '../reminders/time';
import { chatKeys } from './chatStore';
import { putMessage } from './chatCache';
export { putMessage };
import { plainText } from './chatFormat';

// ------------------------------------------------------------------ task and page keys as live cards

const KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/g;
/** The task (PAY-12) and page (DOC-7) keys written in a message. */
export const keysIn = (body: string) => Array.from(new Set(Array.from(plainText(body).toUpperCase().matchAll(KEY_RE)).map((x) => x[1]))).slice(0, 6);

/** What the keys in the open conversation are now, fetched once for all its messages. */
export const UnfurlContext = createContext<Map<string, ChatUnfurl>>(new Map());

export function useUnfurls(messages: ChatMessage[]) {
  const wid = useWorkspaceId() ?? '';
  const keys = Array.from(new Set(messages.filter((m) => !m.isDeleted && m.kind === 'User').flatMap((m) => keysIn(m.body)))).sort().slice(0, 30);
  const q = useQuery({ queryKey: chatKeys.unfurl(wid, keys.join(',')), queryFn: () => chatApi.unfurl(keys), enabled: !!wid && keys.length > 0, staleTime: 60_000 });
  const map = new Map<string, ChatUnfurl>();
  for (const u of q.data ?? []) map.set(u.key, u);
  return map;
}

export function UnfurlCards({ body }: { body: string }) {
  const map = useContext(UnfurlContext);
  const cards = keysIn(body).map((k) => map.get(k)).filter((x): x is ChatUnfurl => !!x);
  if (!cards.length) return null;
  return (
    <div className="unfurls">
      {cards.map((c) => (
        <Link key={c.key} to={c.link} className={`unfurl ${c.done ? 'done' : ''}`}>
          <span className="unfurl-kind" aria-hidden="true"><Icon name={c.kind === 'page' ? 'note' : 'checkCircle'} size={16} /></span>
          <span className="unfurl-main"><b><code>{c.key}</code> {c.title}</b>
            <small>
              {c.status && <span className="unfurl-status" style={c.statusColor ? { color: c.statusColor } : undefined}>{c.status}</span>}
              {c.assignee && <span>· {c.assignee}</span>}{c.due && <span>· due {formatDate(c.due)}</span>}
            </small>
          </span>
        </Link>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ what was made from a message

const LINK_ICON: Record<ChatLink['kind'], IconName> = { task: 'checkCircle', ticket: 'tag', reminder: 'alarm', page: 'note' };
const linkTo = (l: ChatLink) => l.kind === 'task' || l.kind === 'ticket' ? `/work?item=${l.id}` : l.kind === 'page' ? `/documents/${l.id}` : '/reminders';

export function LinkedChips({ links }: { links: ChatLink[] | null | undefined }) {
  if (!links?.length) return null;
  return (
    <div className="msg-links">
      {links.map((l) => <Link key={`${l.kind}-${l.id}`} to={linkTo(l)} className="msg-link"><Icon name={LINK_ICON[l.kind]} size={13} />{l.key && <code>{l.key}</code>}<span>{l.title}</span></Link>)}
    </div>
  );
}

// ------------------------------------------------------------------ voice notes

const LANG: Record<string, string> = { 'te-IN': 'Telugu', 'hi-IN': 'Hindi', 'en-IN': 'English', te: 'Telugu', hi: 'Hindi', en: 'English' };
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** A voice note: play it, and read what was said (transcribed when it was sent), translated if needed. */
export function VoiceNote({ file }: { file: ChatAttachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showText, setShowText] = useState(true);
  const [translated, setTranslated] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const load = async () => {
    if (url) { void audio.current?.play().catch(() => undefined); return; }
    setBusy(true);
    try { const u = await chatApi.fileUrl(file.id, true); setUrl(u); window.setTimeout(() => void audio.current?.play().catch(() => undefined), 50); }
    catch { toast('Could not play the voice note.', 'error'); }
    finally { setBusy(false); }
  };
  const translate = async () => {
    if (!file.transcript) return;
    try { setTranslated((await chatApi.transform(file.transcript, 'translate', 'en')).text); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not translate it.', 'error'); }
  };
  return (
    <div className="voice-note">
      <div className="voice-row">
        {url ? <audio ref={audio} src={url} controls preload="auto" aria-label="Voice note" />
          : <button type="button" className="voice-play" onClick={() => void load()} aria-label="Play the voice note">{busy ? <Spinner /> : <Icon name="play" size={15} />}<span>Voice note{file.durationSeconds ? ` · ${mmss(file.durationSeconds)}` : ''}</span></button>}
      </div>
      {file.transcript && (
        <div className="voice-text">
          <button type="button" className="link-btn" onClick={() => setShowText((v) => !v)}>{showText ? 'Hide' : 'Show'} what was said{file.transcriptLanguage ? ` (${LANG[file.transcriptLanguage] ?? file.transcriptLanguage})` : ''}</button>
          {showText && <p>{translated ?? file.transcript}</p>}
          {showText && !translated && file.transcriptLanguage && !file.transcriptLanguage.startsWith('en') && <button type="button" className="link-btn" onClick={() => void translate()}>Translate to English</button>}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ polls

export function PollCard({ poll, onChanged }: { poll: ChatPoll; onChanged: (m: ChatMessage) => void }) {
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [decision, setDecision] = useState('');
  const closed = !!poll.closedAt;
  const total = Math.max(1, poll.options.reduce((a, o) => a + o.votes, 0));
  const vote = async (index: number) => {
    if (closed || busy) return;
    const mine = poll.options.filter((o) => o.mine).map((o) => o.index);
    const next = poll.multiple ? (mine.includes(index) ? mine.filter((i) => i !== index) : [...mine, index]) : (mine.includes(index) ? [] : [index]);
    setBusy(true);
    try { onChanged(await chatApi.vote(poll.id, next)); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not vote.', 'error'); }
    setBusy(false);
  };
  const close = async () => {
    setBusy(true);
    try { onChanged(await chatApi.closePoll(poll.id, decision.trim() || undefined)); setClosing(false); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not close the poll.', 'error'); }
    setBusy(false);
  };
  return (
    <div className={`poll ${closed ? 'closed' : ''}`} role="group" aria-label={`Poll: ${poll.question}`}>
      <div className="poll-q"><Icon name="chart" size={15} /><b>{poll.question}</b></div>
      <ul className="poll-options">
        {poll.options.map((o) => (
          <li key={o.index}>
            <button type="button" className={`poll-opt ${o.mine ? 'mine' : ''}`} onClick={() => void vote(o.index)} disabled={closed || busy} aria-pressed={o.mine}
              title={o.names.length ? o.names.join(', ') : undefined}>
              <span className="poll-bar" style={{ width: `${Math.round((o.votes / total) * 100)}%` }} aria-hidden="true" />
              <span className="poll-check" aria-hidden="true">{o.mine ? '✓' : ''}</span>
              <span className="poll-text">{o.text}</span>
              <span className="poll-count">{o.votes}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="poll-foot">
        <span>{poll.voters} voted{poll.multiple ? ' · several choices' : ''}{!closed && poll.closesAt ? ` · closes ${formatDateTime(poll.closesAt)}` : ''}{closed ? ' · closed' : ''}</span>
        {poll.decision && <span className="poll-decision">Decision: <b>{poll.decision}</b></span>}
        {poll.canClose && !closed && !closing && <button type="button" className="link-btn" onClick={() => setClosing(true)}>Close and decide</button>}
      </div>
      {closing && (
        <form className="poll-close" onSubmit={(e) => { e.preventDefault(); void close(); }}>
          <input className="input" value={decision} maxLength={500} onChange={(e) => setDecision(e.target.value)} placeholder="The decision (empty: the option with most votes)" aria-label="Decision" />
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Close poll</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setClosing(false)}>Cancel</button>
        </form>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ translate a message, suggested replies, seen by

export function TranslateLine({ m, onClose }: { m: ChatMessage; onClose: () => void }) {
  const [lang, setLang] = useState<'en' | 'te' | 'hi'>('en');
  const q = useWsQuery(['chat', 'translate', m.id, lang], () => chatApi.transform(plainText(m.body), 'translate', lang), { staleTime: Infinity, retry: false });
  return (
    <div className="msg-translate">
      <div className="msg-translate-head">
        <span>🌐 Translation</span>
        {(['en', 'te', 'hi'] as const).map((l) => <button key={l} type="button" className={l === lang ? 'on' : ''} onClick={() => setLang(l)}>{l === 'en' ? 'English' : l === 'te' ? 'తెలుగు' : 'हिन्दी'}</button>)}
        <button type="button" className="ct-x" aria-label="Hide translation" onClick={onClose}><Icon name="close" size={13} /></button>
      </div>
      <p>{q.isLoading ? 'Translating…' : q.isError ? (q.error instanceof ApiError ? q.error.message : 'Could not translate it.') : q.data?.text}</p>
    </div>
  );
}

/** Puts text into the open composer of a conversation (a suggested reply, a rewritten draft). */
export const insertIntoComposer = (conversationId: string, text: string, threadRootId?: string | null) =>
  window.dispatchEvent(new CustomEvent('chat:insert', { detail: { conversationId, text, threadRootId: threadRootId ?? null } }));

export function SmartReplies({ m, onClose }: { m: ChatMessage; onClose: () => void }) {
  const q = useWsQuery(['chat', 'replies', m.id], () => chatApi.replies(m.id), { staleTime: 5 * 60_000, retry: false });
  return (
    <div className="smart-replies" role="group" aria-label="Suggested replies">
      {q.isLoading ? <span className="muted"><Spinner /> Thinking of replies…</span>
        : q.isError ? <span className="muted">{q.error instanceof ApiError ? q.error.message : 'No suggestions right now.'}</span>
          : (q.data?.replies ?? []).map((r) => (
            <button key={r} type="button" className="smart-reply" onClick={() => { insertIntoComposer(m.conversationId, r, m.threadRootId); onClose(); }}>{r}</button>
          ))}
      <button type="button" className="ct-x" aria-label="Hide suggestions" onClick={onClose}><Icon name="close" size={13} /></button>
    </div>
  );
}

export function SeenByDialog({ m, onClose }: { m: ChatMessage; onClose: () => void }) {
  const q = useWsQuery(['chat', 'seen', m.id], () => chatApi.seenBy(m.id), { staleTime: 0 });
  return (
    <Modal title="Seen by" subtitle={plainText(m.body).slice(0, 80) || 'Your message'} size="sm" onClose={onClose} footer={<button className="btn btn-ghost" onClick={onClose}>Close</button>}>
      {q.isLoading ? <Spinner /> : (
        <div className="seen-by">
          <h4>Read</h4>
          {q.data?.seen.length ? <ul>{q.data.seen.map((s) => <li key={s.userId}><b>{s.name}</b><time>{formatDateTime(s.at)}</time></li>)}</ul> : <p className="muted">Nobody yet.</p>}
          {!!q.data?.notYet.length && <><h4>Not yet</h4><p className="muted">{q.data.notYet.join(', ')}</p></>}
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ make a task / ticket / reminder / page from a message

const KIND_LABEL: Record<ChatExtract['kind'], string> = { task: 'task', ticket: 'ticket', reminder: 'reminder', page: 'page' };
const para = (text: string) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });

/**
 * The fields filled from the message (by AI when it is on), for the person to check; "Create" makes the item with its own rules, then the
 * message links to it so everyone in the conversation sees what was done about it.
 */
export interface MadeTask { id: string; title: string; assigneeName: string | null; due: string | null; projectName: string | null }
export function MakeFromMessage({ m, conversation, kind, onClose, onMade }: { m: ChatMessage; conversation: Conversation; kind: ChatExtract['kind']; onClose: () => void;
  /** A task was made (Talk shows it flying to My Work, with Undo, instead of the plain toast). */ onMade?: (t: MadeTask) => void }) {
  const wid = useWorkspaceId() ?? '';
  const navigate = useNavigate();
  const fields = useWsQuery(['chat', 'extract', m.id, kind], () => chatApi.extract(m.id, kind), { staleTime: Infinity, retry: false });
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [due, setDue] = useState('');
  const [time, setTime] = useState('09:00');
  const [priority, setPriority] = useState('Medium');
  const [projectId, setProjectId] = useState(conversation.projectId ?? '');
  const [workTypeId, setWorkTypeId] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    const f = fields.data;
    if (!f || filled) return;
    setTitle(f.title); setDescription(f.description); setDue(f.due ?? ''); setPriority(f.priority ?? 'Medium'); setAssigneeId(f.assigneeId ?? '');
    if (f.projectId) setProjectId(f.projectId);
    setFilled(true);
  }, [fields.data, filled]);
  const projects = useWsQuery(['projects', 'pick'], () => projectApi.list({ pageSize: 100 }), { enabled: kind === 'task', staleTime: 60_000 });
  const types = useWsQuery(['work-types'], () => workApi.types(), { enabled: kind === 'ticket', staleTime: 300_000 });
  useEffect(() => { if (kind === 'ticket' && !workTypeId && types.data?.length) setWorkTypeId(types.data[0].id); }, [kind, types.data, workTypeId]);
  const docTypes = useWsQuery(['document-types'], documentApi.types, { enabled: kind === 'page', staleTime: 300_000 });

  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      let made: { id: string; open: string };
      if (kind === 'task') {
        if (!projectId) { toast('Choose the project.', 'error'); setBusy(false); return; }
        const t = await taskApi.create(projectId, { title: title.trim(), description: description || null, priority, dueDate: due || null, assigneeId: assigneeId || null });
        made = { id: t.id, open: `/work?item=${t.id}` };
      } else if (kind === 'ticket') {
        if (!workTypeId) { toast('Choose the kind of work.', 'error'); setBusy(false); return; }
        const w = await workApi.create({ title: title.trim(), description: description || null, workTypeId, priority, dueDate: due || null, assigneeId: assigneeId || null, relatedProjectId: conversation.projectId });
        made = { id: w.id, open: `/work?item=${w.id}` };
      } else if (kind === 'reminder') {
        const at = due ? new Date(`${due}T${time || '09:00'}:00`).toISOString() : new Date(Date.now() + 60 * 60_000).toISOString();
        const r = await reminderApi.create({ title: title.trim(), note: description || null, targetType: 'ChatMessage', targetId: m.id, when: { at, timeZone: deviceZone() } });
        made = { id: r.id, open: '/reminders' };
      } else {
        const page = (docTypes.data ?? []).find((t) => t.code === 'PAGE');
        if (!page) { toast('Pages are not available in this workspace.', 'error'); setBusy(false); return; }
        const body = JSON.stringify({ type: 'doc', content: description.split(/\n{2,}/).map((p) => para(p.trim())) });
        const d = await documentApi.create({ title: title.trim(), typeId: page.id, projectId: conversation.projectId ?? null, sections: [{ key: 'body', content: body }] });
        made = { id: d.item.id, open: `/documents/${d.item.id}` };
      }
      const linked = await chatApi.link(m.id, { kind, id: made.id });
      putMessage(wid, linked);
      if (kind === 'task' && onMade) {
        const who = conversation.members.find((p) => p.userId === assigneeId)?.name ?? null;
        const proj = (projects.data?.items ?? []).find((p) => p.id === projectId)?.name ?? null;
        onClose();
        onMade({ id: made.id, title: title.trim(), assigneeName: who, due: due || null, projectName: proj });
        return;
      }
      toast(`The ${KIND_LABEL[kind]} is made and linked to the message.`, 'success', { label: 'Open', onClick: () => navigate(made.open) });
      onClose();
    } catch (e) { toast(e instanceof ApiError ? e.message : `Could not make the ${KIND_LABEL[kind]}.`, 'error'); }
    setBusy(false);
  };

  const people = conversation.members;
  return (
    <Modal title={`Make a ${KIND_LABEL[kind]} from this message`} subtitle={fields.data?.byAi ? 'Filled by AI from the message. Check it before creating.' : 'Filled from the message. Check it before creating.'}
      onClose={onClose} onSubmit={(e) => { e.preventDefault(); void create(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy || !title.trim() || fields.isLoading}>{busy && <Spinner />}Create {KIND_LABEL[kind]}</button></>}>
      {fields.isLoading ? <p className="muted"><Spinner /> Reading the message…</p> : (
        <div className="make-form">
          <label className="field"><span>Title</span><input className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
          <label className="field"><span>{kind === 'page' ? 'Text' : 'Details'}</span><textarea className="input" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
          {kind === 'task' && !conversation.projectId && (
            <label className="field"><span>Project</span>
              <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">Choose a project</option>
                {(projects.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></label>
          )}
          {kind === 'ticket' && (
            <label className="field"><span>Kind of work</span>
              <select className="input" value={workTypeId} onChange={(e) => setWorkTypeId(e.target.value)}>{(types.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          )}
          {kind !== 'page' && (
            <div className="make-row">
              <label className="field"><span>{kind === 'reminder' ? 'Remind me on' : 'Due'}</span><input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
              {kind === 'reminder' && <label className="field"><span>At</span><input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>}
              {kind !== 'reminder' && (
                <label className="field"><span>Priority</span>
                  <select className="input" value={priority} onChange={(e) => setPriority(e.target.value)}>{['Low', 'Medium', 'High', 'Urgent'].map((p) => <option key={p}>{p}</option>)}</select></label>
              )}
            </div>
          )}
          {(kind === 'task' || kind === 'ticket') && (
            <label className="field"><span>Assignee</span>
              <select className="input" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                <option value="">Nobody yet</option>
                {people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
              </select></label>
          )}
        </div>
      )}
    </Modal>
  );
}
