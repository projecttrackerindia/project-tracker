import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, del, get, post, put } from '../../api/client';
import { teamApi } from '../../api/endpoints.auth';
import { workApi } from '../../api/endpoints.platform';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { EmptyState, ErrorState, Modal, PageLoader, Spinner } from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import './whatsapp.css';

interface Channel {
  id: string; name: string; teamId: string | null; teamName: string | null; phoneNumberId: string; businessAccountId: string; displayPhone: string | null; verifiedName: string | null;
  enabled: boolean; autoReply: boolean; agentName: string; workTypeId: string | null; webhookUrl: string; verifyToken: string; lastInboundAt: string | null; checkedAt: string | null;
  lastError: string | null; openChats: number; connectedAt: string;
}
interface ChatItem {
  id: string; channelId: string; channelName: string; contact: string; contactName: string | null; language: string; status: 'open' | 'waiting' | 'closed'; mode: 'ai' | 'human';
  lastMessageAt: string; lastText: string | null; unread: number; workTaskId: string | null; ticketKey: string | null; canReply: boolean;
}
interface Message { from: 'contact' | 'ai' | 'agent' | 'system'; text: string; at: string; by?: string | null }
interface Chat { chat: ChatItem; messages: Message[] }
interface ChannelForm { name: string; teamId: string | null; phoneNumberId: string; businessAccountId: string; accessToken: string; appSecret: string; enabled: boolean; autoReply: boolean; agentName: string; workTypeId: string | null }

const api = {
  channels: () => get<Channel[]>('/support/channels'),
  save: (b: ChannelForm, id?: string) => (id ? put<Channel>(`/support/channels/${id}`, b) : post<Channel>('/support/channels', b)),
  check: (id: string) => post<Channel>(`/support/channels/${id}/check`, {}),
  remove: (id: string) => del(`/support/channels/${id}`),
  chats: (status: string, channelId?: string) => get<ChatItem[]>('/support/conversations', { status, channelId: channelId || undefined }),
  chat: (id: string) => get<Chat>(`/support/conversations/${id}`),
  reply: (id: string, text: string) => post<Chat>(`/support/conversations/${id}/reply`, { text }),
  ticket: (id: string) => post<Chat>(`/support/conversations/${id}/ticket`, {}),
  mode: (id: string, mode: 'ai' | 'human' | 'close') => post<Chat>(`/support/conversations/${id}/${mode}`, {}),
};
const errText = (e: unknown, f: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : f);
const copy = (text: string, what: string) => { void navigator.clipboard?.writeText(text).then(() => toast(`${what} copied.`), () => toast('Copy it by hand.', 'error')); };

/** Operations › WhatsApp: each team's own WhatsApp Business number, its AI support employee, and the chats it handles. */
export function WhatsAppSupportPanel({ canManage }: { canManage: boolean }) {
  const channels = useWsQuery(['support', 'channels'], api.channels, { enabled: canManage });
  const [editing, setEditing] = useState<Channel | 'new' | null>(null);
  const [setup, setSetup] = useState<Channel | null>(null);
  const list = channels.data ?? [];
  return (
    <div className="wa">
      <header className="wa-hero">
        <div>
          <span className="wa-eyebrow"><Icon name="message" size={14} /> WhatsApp support</span>
          <h2>Each team answers on its own WhatsApp number</h2>
          <p>An AI support employee replies from your company knowledge in Telugu, Hindi, Tamil or English, raises a ticket with the whole chat when something needs doing, and hands over to your team when someone asks for a person.</p>
        </div>
        {canManage && <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={15} /> Connect WhatsApp</button>}
      </header>
      {canManage && (channels.isLoading ? <PageLoader /> : channels.isError ? <ErrorState error={channels.error} retry={() => channels.refetch()} /> : list.length > 0 && (
        <section className="wa-channels" aria-label="Connected numbers">
          {list.map((c) => <ChannelCard key={c.id} c={c} onEdit={() => setEditing(c)} onSetup={() => setSetup(c)} onChanged={() => void channels.refetch()} />)}
        </section>
      ))}
      {canManage && !channels.isLoading && list.length === 0 && (
        <EmptyState icon="message" title="No WhatsApp number connected yet" text="Connect a team's WhatsApp Business number to let its AI employee answer chats." />
      )}
      <Inbox channels={list} />
      {editing && <ChannelModal c={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(c, isNew) => { setEditing(null); void channels.refetch(); if (isNew) setSetup(c); }} />}
      {setup && <SetupModal c={setup} onClose={() => setSetup(null)} />}
    </div>
  );
}

function ChannelCard({ c, onEdit, onSetup, onChanged }: { c: Channel; onEdit: () => void; onSetup: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const state = !c.enabled ? { label: 'Paused', cls: '' } : c.lastError ? { label: 'Needs attention', cls: 'bad' } : c.displayPhone ? { label: 'Connected', cls: 'ok' } : { label: 'Not checked yet', cls: 'warn' };
  const check = async () => {
    setBusy(true);
    try { const r = await api.check(c.id); toast(r.lastError ? r.lastError : `Connected: ${r.verifiedName ?? r.displayPhone}.`, r.lastError ? 'error' : 'success'); onChanged(); }
    catch (e) { toast(errText(e, 'Could not check.'), 'error'); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: `Disconnect ${c.name}?`, message: 'Its chats are removed from the inbox. Tickets already raised stay.', confirmText: 'Disconnect', danger: true }))) return;
    try { await api.remove(c.id); onChanged(); } catch (e) { toast(errText(e, 'Could not disconnect.'), 'error'); }
  };
  return (
    <article className="wa-channel">
      <div className="wa-channel-top">
        <span className="wa-avatar" aria-hidden><Icon name="message" size={16} /></span>
        <div className="wa-channel-text">
          <b>{c.name}</b>
          <small>{c.displayPhone ? `${c.verifiedName ?? ''} ${c.displayPhone}`.trim() : `Number ID ${c.phoneNumberId}`}{c.teamName ? ` · ${c.teamName}` : ''}</small>
        </div>
        <span className={`wa-state ${state.cls}`}>{state.label}</span>
      </div>
      <p className="wa-channel-meta">
        <span><Icon name="agent" size={13} /> {c.agentName}{c.autoReply ? ' answers first' : ' (people answer)'}</span>
        <span><Icon name="inbox" size={13} /> {c.openChats} open</span>
        {c.lastInboundAt && <span><Icon name="clock" size={13} /> last message {timeAgo(c.lastInboundAt)}</span>}
      </p>
      {c.lastError && <p className="wa-error">{c.lastError}</p>}
      <div className="wa-channel-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onSetup}>Webhook setup</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void check()}>{busy ? <Spinner /> : null} Check connection</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit}>Edit</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void remove()} aria-label={`Disconnect ${c.name}`}><Icon name="trash" size={14} /></button>
      </div>
    </article>
  );
}

function ChannelModal({ c, onClose, onSaved }: { c: Channel | null; onClose: () => void; onSaved: (c: Channel, isNew: boolean) => void }) {
  const teams = useWsQuery(['teams'], () => teamApi.list(), { staleTime: 300_000 });
  const types = useWsQuery(['work-types'], () => workApi.types(), { staleTime: 300_000 });
  const [f, setF] = useState<ChannelForm>({
    name: c?.name ?? '', teamId: c?.teamId ?? null, phoneNumberId: c?.phoneNumberId ?? '', businessAccountId: c?.businessAccountId ?? '', accessToken: '', appSecret: '',
    enabled: c?.enabled ?? true, autoReply: c?.autoReply ?? true, agentName: c?.agentName ?? 'Asha', workTypeId: c?.workTypeId ?? null,
  });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof ChannelForm>(k: K, v: ChannelForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true);
    try { const r = await api.save(f, c?.id); toast(c ? 'Saved.' : 'Connected. One last step: add the webhook in Meta.'); onSaved(r, !c); }
    catch (e) { toast(errText(e, 'Could not save.'), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal title={c ? `Edit ${c.name}` : 'Connect WhatsApp'} subtitle="Your team's WhatsApp Business number on the WhatsApp Cloud API." onClose={onClose} size="lg"
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? <Spinner /> : null}{c ? 'Save' : 'Connect'}</button></>}>
      <form className="wa-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="wa-grid">
          <label className="wa-field"><span>Name</span><input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="IT helpdesk" autoFocus /></label>
          <label className="wa-field"><span>Team</span>
            <Select className="select" aria-label="Team" value={f.teamId ?? ''} onChange={(e) => set('teamId', e.target.value || null)}>
              <option value="">Whole workspace</option>{(teams.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></label>
          <label className="wa-field"><span>AI employee's name</span><input value={f.agentName} onChange={(e) => set('agentName', e.target.value)} placeholder="Asha" /></label>
          <label className="wa-field"><span>Tickets are raised as</span>
            <Select className="select" aria-label="Ticket type" value={f.workTypeId ?? ''} onChange={(e) => set('workTypeId', e.target.value || null)}>
              <option value="">First work type</option>{(types.data ?? []).filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></label>
        </div>
        <fieldset className="wa-meta">
          <legend>From Meta</legend>
          <details className="wa-help">
            <summary>Where do I find these?</summary>
            <ol>
              <li>Open <b>business.facebook.com</b> › WhatsApp Manager › your number › <b>API setup</b>: copy the <b>Phone number ID</b> and <b>WhatsApp Business Account ID</b>.</li>
              <li>Business settings › Users › <b>System users</b> › add one (Admin) › <b>Generate token</b> for your app with <i>whatsapp_business_messaging</i> and <i>whatsapp_business_management</i>, expiry <b>Never</b>.</li>
              <li>developers.facebook.com › your app › Settings › Basic › <b>App secret</b> › Show.</li>
            </ol>
            <small>The number must be on the WhatsApp Cloud API, not the WhatsApp Business app.</small>
          </details>
          <div className="wa-grid">
            <label className="wa-field"><span>Phone number ID</span><input inputMode="numeric" value={f.phoneNumberId} onChange={(e) => set('phoneNumberId', e.target.value.trim())} placeholder="1234567890123456" /></label>
            <label className="wa-field"><span>WhatsApp Business Account ID</span><input inputMode="numeric" value={f.businessAccountId} onChange={(e) => set('businessAccountId', e.target.value.trim())} placeholder="1029384756…" /></label>
            <label className="wa-field"><span>Permanent access token</span><input type="password" autoComplete="off" value={f.accessToken} onChange={(e) => set('accessToken', e.target.value)} placeholder={c ? 'Saved — paste a new one to replace it' : 'EAAG…'} /></label>
            <label className="wa-field"><span>App secret</span><input type="password" autoComplete="off" value={f.appSecret} onChange={(e) => set('appSecret', e.target.value)} placeholder={c ? 'Saved — paste a new one to replace it' : '32 letters and digits'} /></label>
          </div>
          <small className="wa-muted"><Icon name="lock" size={12} /> The token and secret are stored encrypted and never shown again.</small>
        </fieldset>
        <label className="wa-toggle"><input type="checkbox" checked={f.autoReply} onChange={(e) => set('autoReply', e.target.checked)} />
          <span>The AI employee answers first<small>Off: chats wait in the inbox for your team.</small></span></label>
        <label className="wa-toggle"><input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          <span>Active<small>Paused numbers ignore new messages.</small></span></label>
      </form>
    </Modal>
  );
}

function SetupModal({ c, onClose }: { c: Channel; onClose: () => void }) {
  return (
    <Modal title="Add the webhook in Meta" subtitle={`So messages to ${c.name} reach ${c.agentName}.`} onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
      <ol className="wa-steps">
        <li>Open <b>developers.facebook.com</b> › your app › <b>WhatsApp › Configuration</b> › Webhook › <b>Edit</b>.</li>
        <li><span>Callback URL</span><code className="wa-copy">{c.webhookUrl}<button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(c.webhookUrl, 'Callback URL')}><Icon name="copy" size={13} /></button></code></li>
        <li><span>Verify token</span><code className="wa-copy">{c.verifyToken}<button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(c.verifyToken, 'Verify token')}><Icon name="copy" size={13} /></button></code></li>
        <li>Press <b>Verify and save</b>, then under Webhook fields <b>Subscribe</b> to <b>messages</b>.</li>
        <li>Send a WhatsApp message to the number: it appears in the inbox below and {c.agentName} replies.</li>
      </ol>
    </Modal>
  );
}

// ------------------------------------------------------------------ inbox

function Inbox({ channels }: { channels: Channel[] }) {
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const [channelId, setChannelId] = useState('');
  const [params, setParams] = useSearchParams();
  // A notification links straight to the chat (?chat=<id>); the address is cleaned once it is open.
  const [openId, setOpenId] = useState<string | null>(params.get('chat'));
  useEffect(() => {
    if (!params.has('chat')) return;
    const next = new URLSearchParams(params); next.delete('chat'); setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const q = useWsQuery(['support', 'chats', status, channelId], () => api.chats(status, channelId), { refetchInterval: 10_000 });
  const chats = q.data ?? [];
  return (
    <section className="wa-inbox" aria-label="WhatsApp chats">
      <div className="wa-inbox-head">
        <h3><Icon name="inbox" size={16} /> Chats</h3>
        <div className="wa-inbox-filters">
          <div className="seg" role="group" aria-label="Show">
            {(['open', 'closed'] as const).map((s) => <button key={s} type="button" className={status === s ? 'active' : ''} aria-pressed={status === s} onClick={() => setStatus(s)}>{s === 'open' ? 'Open' : 'Closed'}</button>)}
          </div>
          {channels.length > 1 && <Select className="select" aria-label="Number" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            <option value="">All numbers</option>{channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}
        </div>
      </div>
      {q.isLoading ? <PageLoader /> : q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : chats.length === 0
        ? <p className="wa-muted wa-empty">{status === 'open' ? 'No open chats. New WhatsApp messages appear here.' : 'No closed chats yet.'}</p>
        : (
          <ul className="wa-chats">
            {chats.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => setOpenId(c.id)} className={c.unread ? 'unread' : ''}>
                  <span className="wa-chat-avatar" aria-hidden>{(c.contactName ?? '#').slice(0, 1).toUpperCase()}</span>
                  <span className="wa-chat-main">
                    <span className="wa-chat-row"><b>{c.contactName ?? c.contact}</b><small>{timeAgo(c.lastMessageAt)}</small></span>
                    <span className="wa-chat-last">{c.lastText ?? ''}</span>
                    <span className="wa-chat-tags">
                      <em className={`wa-mode ${c.mode}`}>{c.mode === 'ai' ? 'AI employee' : c.status === 'waiting' ? 'Waiting for your team' : 'Your team'}</em>
                      {c.ticketKey && <em>{c.ticketKey}</em>}
                      {channels.length > 1 && <em>{c.channelName}</em>}
                    </span>
                  </span>
                  {c.unread > 0 && <span className="wa-unread">{c.unread}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      {openId && <ChatModal id={openId} onClose={() => { setOpenId(null); void q.refetch(); }} />}
    </section>
  );
}

function ChatModal({ id, onClose }: { id: string; onClose: () => void }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['support', 'chat', id], () => api.chat(id), { refetchInterval: 6_000 });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement | null>(null);
  const count = q.data?.messages.length ?? 0;
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [count]);
  const act = async (fn: () => Promise<Chat>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) toast(ok); void q.refetch(); void invalidateWorkspace(wid, 'support'); } catch (e) { toast(errText(e, 'That did not work.'), 'error'); } finally { setBusy(false); }
  };
  const send = async () => { const t = text.trim(); if (!t) return; await act(() => api.reply(id, t)); setText(''); };
  if (q.isLoading || !q.data) return <Modal title="Chat" onClose={onClose}>{q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : <PageLoader />}</Modal>;
  const { chat, messages } = q.data;
  return (
    <Modal title={chat.contactName ?? chat.contact} subtitle={`${chat.contact} · ${chat.channelName}`} onClose={onClose} size="lg"
      footer={<div className="wa-chat-actions">
        {chat.mode === 'ai'
          ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => api.mode(id, 'human'), 'You have the chat.')}><Icon name="user" size={14} /> Take over</button>
          : <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => api.mode(id, 'ai'), 'The AI employee has the chat again.')}><Icon name="agent" size={14} /> Hand back to AI</button>}
        {chat.workTaskId
          ? <Link className="btn btn-ghost btn-sm" to={`?task=${chat.workTaskId}`}><Icon name="link" size={14} /> {chat.ticketKey}</Link>
          : <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => api.ticket(id), 'Ticket raised.')}><Icon name="plus" size={14} /> Raise ticket</button>}
        {chat.status !== 'closed' && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => api.mode(id, 'close'), 'Chat closed.').then(onClose)}><Icon name="check" size={14} /> Close</button>}
      </div>}>
      <div className="wa-thread" role="log" aria-label="Messages">
        {messages.map((m, i) => (
          <div key={i} className={`wa-msg ${m.from === 'contact' ? 'in' : 'out'} ${m.from}`}>
            {m.from !== 'contact' && <small className="wa-msg-by">{m.from === 'ai' ? `${m.by ?? 'AI'} · AI` : m.by ?? 'Team'}</small>}
            <p>{m.text}</p>
            <time dateTime={m.at} title={formatDateTime(m.at)}>{timeAgo(m.at)}</time>
          </div>
        ))}
        <div ref={end} />
      </div>
      {chat.canReply
        ? <form className="wa-reply" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Reply on WhatsApp… (you take over the chat)" aria-label="Reply"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
          <button className="btn btn-primary" disabled={busy || !text.trim()} aria-label="Send"><Icon name="send" size={14} /></button>
        </form>
        : <p className="wa-muted">WhatsApp allows replies only within 24 hours of the person's last message. Ask them to write again, or call them.</p>}
    </Modal>
  );
}
