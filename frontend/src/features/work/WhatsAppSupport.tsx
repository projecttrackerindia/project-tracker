import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, del, download, fetchBlobUrl, get, post, put } from '../../api/client';
import { teamApi, workspaceApi } from '../../api/endpoints.auth';
import { workApi } from '../../api/endpoints.platform';
import { projectApi } from '../../api/endpoints.projects';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { ErrorState, Modal, PageLoader, Spinner } from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { useIsMobile } from '../../lib/mobile';
import { confirmDialog, toast } from '../../stores/ui';
import './whatsapp.css';

interface SavedReply { title: string; text: string }
interface Channel {
  id: string; name: string; teamId: string | null; teamName: string | null; phoneNumberId: string; businessAccountId: string; displayPhone: string | null; verifiedName: string | null;
  enabled: boolean; autoReply: boolean; agentName: string; workTypeId: string | null; webhookUrl: string; verifyToken: string; lastInboundAt: string | null; checkedAt: string | null;
  lastError: string | null; openChats: number; connectedAt: string;
  firstReplyMinutes: number; tellCustomer: boolean; askRating: boolean; updateTemplate: string | null; updateTemplateLanguage: string; savedReplies: SavedReply[] | null;
  answerFromDocuments?: boolean; knowledgeProjectId?: string | null;
}
export interface ChatItem {
  id: string; channelId: string; channelName: string; contact: string; contactName: string | null; language: string; status: 'open' | 'waiting' | 'closed'; mode: 'ai' | 'human';
  lastMessageAt: string; lastText: string | null; unread: number; workTaskId: string | null; ticketKey: string | null; canReply: boolean;
  assigneeId: string | null; assigneeName: string | null; waitingSince: string | null; replyDueAt: string | null; rating: number | null;
}
interface Media { kind: 'image' | 'voice' | 'video' | 'document' | 'sticker'; id: string; mime: string | null; fileName: string | null; transcript: string | null }
/** A DocTracker page an AI answer was taken from. */
interface Source { documentId: string; key: string; title: string }
interface Message { from: 'contact' | 'ai' | 'agent' | 'update' | 'system'; text: string; at: string; by?: string | null; media?: Media | null; sources?: Source[] | null }
interface Chat { chat: ChatItem; messages: Message[]; savedReplies: SavedReply[] | null }
interface Queues { mine: number; unassigned: number; waiting: number; open: number; late: number }
interface ChannelForm {
  name: string; teamId: string | null; phoneNumberId: string; businessAccountId: string; accessToken: string; appSecret: string; enabled: boolean; autoReply: boolean; agentName: string; workTypeId: string | null;
  firstReplyMinutes: number; tellCustomer: boolean; askRating: boolean; updateTemplate: string; updateTemplateLanguage: string; savedReplies: SavedReply[];
  answerFromDocuments: boolean; knowledgeProjectId: string | null; allPages: boolean;
}
type View = 'mine' | 'unassigned' | 'waiting' | 'open' | 'closed';

const api = {
  channels: () => get<Channel[]>('/support/channels'),
  save: (b: ChannelForm, id?: string) => (id ? put<Channel>(`/support/channels/${id}`, b) : post<Channel>('/support/channels', b)),
  check: (id: string) => post<Channel>(`/support/channels/${id}/check`, {}),
  remove: (id: string) => del(`/support/channels/${id}`),
  chats: (view: View, channelId?: string) => get<ChatItem[]>('/support/conversations', {
    status: view === 'closed' ? 'closed' : 'open', view: view === 'open' || view === 'closed' ? undefined : view, channelId: channelId || undefined }),
  queues: () => get<Queues>('/support/queues'),
  chat: (id: string) => get<Chat>(`/support/conversations/${id}`),
  reply: (id: string, text: string) => post<Chat>(`/support/conversations/${id}/reply`, { text }),
  ticket: (id: string) => post<Chat>(`/support/conversations/${id}/ticket`, {}),
  mode: (id: string, mode: 'ai' | 'human' | 'close') => post<Chat>(`/support/conversations/${id}/${mode}`, {}),
  assign: (id: string, userId: string | null) => post<Chat>(`/support/conversations/${id}/assign`, { userId }),
  suggest: (id: string) => post<{ text: string }>(`/support/conversations/${id}/suggest`, {}),
};
const errText = (e: unknown, f: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : f);
const copy = (text: string, what: string) => { void navigator.clipboard?.writeText(text).then(() => toast(`${what} copied.`), () => toast('Copy it by hand.', 'error')); };

/**
 * Operations › WhatsApp: the desk where the team answers customers on its own WhatsApp numbers. Chats arrive live, sit in queues (mine,
 * unassigned, waiting), each has an owner and a first-reply clock, and the customer hears about their ticket without asking. The numbers
 * themselves are managed behind one button once connected.
 */
export function WhatsAppSupportPanel({ canManage }: { canManage: boolean }) {
  const channels = useWsQuery(['support', 'channels'], api.channels, { enabled: canManage });
  const [editing, setEditing] = useState<Channel | 'new' | null>(null);
  const [setup, setSetup] = useState<Channel | null>(null);
  const [managing, setManaging] = useState(false);
  const list = channels.data ?? [];
  const none = canManage && !channels.isLoading && !channels.isError && list.length === 0;
  const trouble = list.filter((c) => c.enabled && c.lastError).length;
  return (
    <div className="wa">
      {none ? (
        <header className="wa-hero">
          <div>
            <span className="wa-eyebrow"><Icon name="message" size={14} /> WhatsApp support</span>
            <h2>Answer customers on your own WhatsApp number</h2>
            <p>An AI support employee replies from your company knowledge in Telugu, Hindi, Tamil or English and raises tickets. Your team takes over any chat, and customers hear about their ticket here without asking.</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={15} /> Connect WhatsApp</button>
        </header>
      ) : canManage && list.length > 0 && (
        <div className="wa-numbers">
          {list.map((c) => (
            <span key={c.id} className={`wa-number ${!c.enabled ? 'off' : c.lastError ? 'bad' : 'ok'}`} title={c.lastError ?? (c.enabled ? 'Connected' : 'Paused')}>
              <i aria-hidden /> {c.name}
            </span>
          ))}
          {trouble > 0 && <span className="wa-number-alert"><Icon name="alert" size={13} /> {trouble} need{trouble === 1 ? 's' : ''} attention</span>}
          <button type="button" className="btn btn-ghost btn-sm wa-manage" onClick={() => setManaging(true)}><Icon name="settings" size={14} /> Numbers</button>
        </div>
      )}
      {channels.isError && <ErrorState error={channels.error} retry={() => channels.refetch()} />}
      {!none && <Desk channels={list} />}
      {managing && (
        <Modal title="WhatsApp numbers" subtitle="Each team can answer on its own number." onClose={() => setManaging(false)} size="lg"
          footer={<><button type="button" className="btn btn-ghost" onClick={() => setManaging(false)}>Done</button><button type="button" className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={15} /> Connect another</button></>}>
          <section className="wa-channels" aria-label="Connected numbers">
            {list.map((c) => <ChannelCard key={c.id} c={c} onEdit={() => setEditing(c)} onSetup={() => setSetup(c)} onChanged={() => void channels.refetch()} />)}
          </section>
        </Modal>
      )}
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
    firstReplyMinutes: c?.firstReplyMinutes ?? 15, tellCustomer: c?.tellCustomer ?? true, askRating: c?.askRating ?? true,
    updateTemplate: c?.updateTemplate ?? '', updateTemplateLanguage: c?.updateTemplateLanguage ?? 'en', savedReplies: c?.savedReplies ?? [],
    answerFromDocuments: c?.answerFromDocuments ?? true, knowledgeProjectId: c?.knowledgeProjectId ?? null, allPages: !c?.knowledgeProjectId,
  });
  const projects = useWsQuery(['projects', 'whatsapp-pages'], () => projectApi.list({ pageSize: 200, sort: 'name' }), { staleTime: 300_000, enabled: f.answerFromDocuments });
  const setReply = (i: number, k: keyof SavedReply, v: string) => setF((x) => ({ ...x, savedReplies: x.savedReplies.map((r, j) => (j === i ? { ...r, [k]: v } : r)) }));
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof ChannelForm>(k: K, v: ChannelForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true);
    try { const r = await api.save({ ...f, savedReplies: f.savedReplies.filter((x) => x.title.trim() || x.text.trim()) }, c?.id); toast(c ? 'Saved.' : 'Connected. One last step: add the webhook in Meta.'); onSaved(r, !c); }
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
        <label className="wa-toggle"><input type="checkbox" checked={f.answerFromDocuments} onChange={(e) => set('answerFromDocuments', e.target.checked)} />
          <span>Answer from DocTracker pages<small>Only approved or published pages marked Public. Personal data in them stays masked, and each answer names the page it used.</small></span></label>
        {f.answerFromDocuments && (
          <label className="wa-field wa-pages"><span>Pages from</span>
            <Select className="select" aria-label="Pages from" value={f.allPages ? '' : f.knowledgeProjectId ?? ''}
              onChange={(e) => setF((x) => ({ ...x, knowledgeProjectId: e.target.value || null, allPages: !e.target.value }))}>
              <option value="">Every public page in the workspace</option>
              {(projects.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} space</option>)}
            </Select></label>
        )}
        <label className="wa-toggle"><input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          <span>Active<small>Paused numbers ignore new messages.</small></span></label>
        <fieldset className="wa-meta">
          <legend>Desk</legend>
          <div className="wa-grid">
            <label className="wa-field"><span>First reply within (minutes)</span>
              <input type="number" min={1} max={1440} value={f.firstReplyMinutes} onChange={(e) => set('firstReplyMinutes', Math.max(1, Math.min(1440, Number(e.target.value) || 15)))} /></label>
            <label className="wa-field"><span>Update template (after 24 hours)</span>
              <input value={f.updateTemplate} onChange={(e) => set('updateTemplate', e.target.value.trim())} placeholder="ticket_update" /></label>
            <label className="wa-field"><span>Template language</span>
              <input value={f.updateTemplateLanguage} onChange={(e) => set('updateTemplateLanguage', e.target.value.trim())} placeholder="en" /></label>
          </div>
          <details className="wa-help">
            <summary>What should the template say?</summary>
            <p>Create a <b>Utility</b> template in WhatsApp Manager with two values, for example: <i>Update on your request: ticket {'{{1}}'} is {'{{2}}'}. Reply here if you need anything.</i> Once Meta approves it, enter its name here. Inside 24 hours of the customer's last message, updates go as normal messages in their language and need no template.</p>
          </details>
          <label className="wa-toggle"><input type="checkbox" checked={f.tellCustomer} onChange={(e) => set('tellCustomer', e.target.checked)} />
            <span>Tell customers about their ticket<small>Raised, picked up, on hold and resolved, in their language.</small></span></label>
          <label className="wa-toggle"><input type="checkbox" checked={f.askRating} onChange={(e) => set('askRating', e.target.checked)} />
            <span>Ask for a rating when a chat closes<small>One question, answered with 1 to 5.</small></span></label>
          <div className="wa-saved-edit">
            <span className="wa-field-label">Saved replies <small>(type / in a reply to use them)</small></span>
            {f.savedReplies.map((r, i) => (
              <div key={i} className="wa-saved-row">
                <input aria-label="Saved reply name" value={r.title} maxLength={60} placeholder="Name, like Reset steps" onChange={(e) => setReply(i, 'title', e.target.value)} />
                <textarea aria-label="Saved reply text" value={r.text} maxLength={1000} rows={2} placeholder="The message" onChange={(e) => setReply(i, 'text', e.target.value)} />
                <button type="button" className="btn-icon" aria-label={`Remove ${r.title || 'saved reply'}`} onClick={() => setF((x) => ({ ...x, savedReplies: x.savedReplies.filter((_, j) => j !== i) }))}><Icon name="trash" size={14} /></button>
              </div>
            ))}
            {f.savedReplies.length < 50 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setF((x) => ({ ...x, savedReplies: [...x.savedReplies, { title: '', text: '' }] }))}><Icon name="plus" size={13} /> Add a saved reply</button>}
          </div>
        </fieldset>
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

// ------------------------------------------------------------------ the desk

const VIEWS: { id: View; label: string; count?: keyof Queues }[] = [
  { id: 'mine', label: 'Mine', count: 'mine' },
  { id: 'unassigned', label: 'Unassigned', count: 'unassigned' },
  { id: 'waiting', label: 'Waiting', count: 'waiting' },
  { id: 'open', label: 'All open' },
  { id: 'closed', label: 'Closed' },
];

/** Minutes until (positive) or past (negative) the first-reply time. */
const dueIn = (c: ChatItem, now: number) => (c.replyDueAt ? Math.round((new Date(c.replyDueAt).getTime() - now) / 60000) : null);
const span = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ''}`.trim() : `${m}m`);

function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

function Desk({ channels }: { channels: Channel[] }) {
  const queues = useWsQuery(['support', 'queues'], api.queues, { refetchInterval: 30_000 });
  const [picked, setPicked] = useState<View | null>(null);
  const [channelId, setChannelId] = useState('');
  const [search, setSearch] = useState('');
  const [params, setParams] = useSearchParams();
  // A notification links straight to the chat (?chat=<id>); the address is cleaned once it is open.
  const [openId, setOpenId] = useState<string | null>(params.get('chat'));
  useEffect(() => {
    if (!params.has('chat')) return;
    const next = new URLSearchParams(params); next.delete('chat'); setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const qd = queues.data;
  // Until the person picks a queue: their own chats if they have any, else the unassigned queue, else everything open.
  const view: View = picked ?? (qd ? (qd.mine > 0 ? 'mine' : qd.unassigned > 0 ? 'unassigned' : 'open') : 'open');
  const q = useWsQuery(['support', 'chats', view, channelId], () => api.chats(view, channelId), { refetchInterval: 30_000 });
  const now = useNow();
  const phone = useIsMobile();
  const term = search.trim().toLowerCase();
  const chats = (q.data ?? []).filter((c) => !term || [c.contactName, c.contact, c.lastText, c.ticketKey, c.assigneeName].some((x) => x?.toLowerCase().includes(term)));

  return (
    <section className="wad" aria-label="WhatsApp desk">
      <div className="wad-list">
        <div className="wad-views" role="tablist" aria-label="Queue">
          {VIEWS.map((v) => {
            const n = v.count ? qd?.[v.count] : undefined;
            return (
              <button key={v.id} role="tab" type="button" aria-selected={view === v.id} className={view === v.id ? 'on' : ''} onClick={() => setPicked(v.id)}>
                {v.label}{!!n && <span className="wad-n">{n}</span>}
              </button>
            );
          })}
        </div>
        <div className="wad-tools">
          <label className="wad-search"><Icon name="search" size={14} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search chats" aria-label="Search chats" /></label>
          {channels.length > 1 && <Select className="select" aria-label="Number" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            <option value="">All numbers</option>{channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}
        </div>
        {!!qd?.late && view !== 'closed' && <p className="wad-late"><Icon name="clock" size={13} /> {qd.late} chat{qd.late === 1 ? ' is' : 's are'} past the first-reply time</p>}
        {q.isLoading ? <PageLoader /> : q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : chats.length === 0
          ? <p className="wa-muted wa-empty">{term ? 'No chat matches.' : view === 'mine' ? 'Nothing assigned to you.' : view === 'unassigned' ? 'Every chat has an owner.' : view === 'waiting' ? 'Nobody is waiting for an answer.' : view === 'closed' ? 'No closed chats yet.' : 'No open chats. New WhatsApp messages appear here at once.'}</p>
          : (
            <ul className="wa-chats">
              {chats.map((c) => {
                const due = c.status !== 'closed' ? dueIn(c, now) : null;
                return (
                  <li key={c.id}>
                    <button type="button" onClick={() => setOpenId(c.id)} className={`${c.unread ? 'unread' : ''}${openId === c.id ? ' on' : ''}`} aria-current={openId === c.id ? 'true' : undefined}>
                      <span className="wa-chat-avatar" aria-hidden>{(c.contactName ?? '#').slice(0, 1).toUpperCase()}</span>
                      <span className="wa-chat-main">
                        <span className="wa-chat-row"><b>{c.contactName ?? c.contact}</b><small>{timeAgo(c.lastMessageAt)}</small></span>
                        <span className="wa-chat-last">{c.lastText ?? ''}</span>
                        <span className="wa-chat-tags">
                          {due !== null && <em className={`wa-due ${due < 0 ? 'late' : due <= 5 ? 'soon' : ''}`}>{due < 0 ? `late ${span(-due)}` : `reply in ${span(due)}`}</em>}
                          <em className={`wa-mode ${c.mode}`}>{c.mode === 'ai' ? 'AI' : c.assigneeName ?? 'Unassigned'}</em>
                          {c.ticketKey && <em>{c.ticketKey}</em>}
                          {c.rating && <em className="wa-rated">★ {c.rating}</em>}
                          {channels.length > 1 && <em>{c.channelName}</em>}
                        </span>
                      </span>
                      {c.unread > 0 && <span className="wa-unread">{c.unread}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
      </div>
      {!phone && (
        <div className="wad-chat">
          {openId ? <ChatPane key={openId} id={openId} onClose={() => setOpenId(null)} />
            : <div className="wad-pick"><Icon name="message" size={22} /><p>Pick a chat to read and answer it.</p></div>}
        </div>
      )}
      {/* On a phone an open chat takes the whole screen, above the app's bars, like a messaging app. */}
      {phone && openId && createPortal(<div className="wad-full" role="dialog" aria-label="WhatsApp chat"><ChatPane key={openId} id={openId} onClose={() => setOpenId(null)} /></div>, document.body)}
    </section>
  );
}

/** A file from the chat, fetched with the person's sign-in (the address alone opens nothing). */
function useMediaUrl(chatId: string, media: Media | null | undefined, load: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!media || !load) return;
    const ctrl = new AbortController();
    let made: string | null = null;
    fetchBlobUrl(`/support/conversations/${chatId}/media/${media.id}`, ctrl.signal).then((u) => { made = u; setUrl(u); }, () => { if (!ctrl.signal.aborted) setFailed(true); });
    return () => { ctrl.abort(); if (made) URL.revokeObjectURL(made); };
  }, [chatId, media, load]);
  return { url, failed };
}

function MediaView({ chatId, media }: { chatId: string; media: Media }) {
  const inline = media.kind === 'image' || media.kind === 'sticker' || media.kind === 'voice';
  const [load, setLoad] = useState(inline);
  const { url, failed } = useMediaUrl(chatId, media, load);
  const save = () => { void download(`/support/conversations/${chatId}/media/${media.id}`, media.fileName ?? `whatsapp-${media.kind}`).catch((e) => toast(errText(e, 'Could not download the file.'), 'error')); };
  if (failed) return <span className="wa-media-missing"><Icon name="alert" size={13} /> The file could not be fetched from WhatsApp.</span>;
  if (media.kind === 'image' || media.kind === 'sticker') return url ? <a href={url} target="_blank" rel="noreferrer" className="wa-media-img"><img src={url} alt="Photo from the customer" /></a> : <span className="wa-media-wait"><Spinner /></span>;
  if (media.kind === 'voice') return (
    <span className="wa-media-voice">
      {url ? <audio controls src={url} preload="metadata" /> : <Spinner />}
      {media.transcript ? <small>“{media.transcript}”</small> : <small className="wa-muted">Transcript on its way…</small>}
    </span>
  );
  if (media.kind === 'video') return load && url ? <video className="wa-media-video" controls src={url} preload="metadata" /> : <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLoad(true)}><Icon name="play" size={13} /> Play video</button>;
  return <button type="button" className="btn btn-ghost btn-sm wa-media-doc" onClick={save}><Icon name="download" size={13} /> {media.fileName ?? 'Download the document'}</button>;
}

function ChatPane({ id, onClose }: { id: string; onClose: () => void }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['support', 'chat', id], () => api.chat(id), { refetchInterval: 30_000 });
  const members = useWsQuery(['members'], workspaceApi.members, { staleTime: 300_000 });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [slash, setSlash] = useState(false);
  const end = useRef<HTMLDivElement | null>(null);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const count = q.data?.messages.length ?? 0;
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [count]);
  const act = async (fn: () => Promise<Chat>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) toast(ok); void invalidateWorkspace(wid, 'support'); } catch (e) { toast(errText(e, 'That did not work.'), 'error'); } finally { setBusy(false); }
  };
  const send = async () => { const t = text.trim(); if (!t) return; await act(() => api.reply(id, t)); setText(''); };
  const suggest = async () => {
    setSuggesting(true);
    try { const r = await api.suggest(id); setText(r.text); box.current?.focus(); } catch (e) { toast(errText(e, 'No suggestion this time.'), 'error'); } finally { setSuggesting(false); }
  };
  if (q.isLoading || !q.data) return <div className="wad-pane-load">{q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : <PageLoader />}</div>;
  const { chat, messages } = q.data;
  const saved = q.data.savedReplies ?? [];
  const slashTerm = text.startsWith('/') ? text.slice(1).toLowerCase() : '';
  const matches = slash ? saved.filter((r) => !slashTerm || r.title.toLowerCase().includes(slashTerm) || r.text.toLowerCase().includes(slashTerm)).slice(0, 8) : [];
  const pickSaved = (r: SavedReply) => { setText(r.text); setSlash(false); box.current?.focus(); };
  return (
    <div className="wad-pane">
      <header className="wad-head">
        <button type="button" className="btn-icon wad-back" aria-label="Back to the chats" onClick={onClose}><Icon name="arrowLeft" size={16} /></button>
        <div className="wad-who">
          <b>{chat.contactName ?? chat.contact}</b>
          <small>{chat.contact} · {chat.channelName}{chat.rating ? ` · rated ★ ${chat.rating}` : ''}</small>
        </div>
        <Select className="select wad-owner" aria-label="Owner" value={chat.assigneeId ?? ''} disabled={busy}
          onChange={(e) => void act(() => api.assign(id, e.target.value || null), e.target.value ? 'Assigned.' : 'Back in the queue.')}>
          <option value="">Unassigned</option>
          {(members.data ?? []).map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
        </Select>
      </header>
      <div className="wad-actions">
        {chat.mode === 'ai'
          ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => api.mode(id, 'human'), 'You have the chat.')}><Icon name="user" size={14} /> Take over</button>
          : <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => api.mode(id, 'ai'), 'The AI employee has the chat again.')}><Icon name="agent" size={14} /> Hand to AI</button>}
        {chat.workTaskId
          ? <Link className="btn btn-ghost btn-sm" to={`?task=${chat.workTaskId}`}><Icon name="link" size={14} /> {chat.ticketKey}</Link>
          : <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => api.ticket(id), 'Ticket raised. The customer is told shortly.')}><Icon name="plus" size={14} /> Raise ticket</button>}
        {chat.status !== 'closed' && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => api.mode(id, 'close'), 'Chat closed.')}><Icon name="check" size={14} /> Close</button>}
      </div>
      <div className="wa-thread" role="log" aria-label="Messages">
        {messages.map((m, i) => m.from === 'system' ? (
          <p key={i} className="wa-note"><Icon name="info" size={12} /> {m.text} <time dateTime={m.at}>{timeAgo(m.at)}</time></p>
        ) : (
          <div key={i} className={`wa-msg ${m.from === 'contact' ? 'in' : 'out'} ${m.from}`}>
            {m.from !== 'contact' && <small className="wa-msg-by">{m.from === 'ai' ? `${m.by ?? 'AI'} · AI` : m.from === 'update' ? 'Sent automatically' : m.by ?? 'Team'}</small>}
            {m.media && <MediaView chatId={id} media={m.media} />}
            {!(m.media && /^\[(photo|voice note|video|sticker|document)\]$/.test(m.text)) && !(m.media?.kind === 'voice') && <p>{m.text.replace(/^\[(photo|video|document)\] /, '')}</p>}
            {m.sources && m.sources.length > 0 && (
              <span className="wa-sources" aria-label="Answered from">
                <Icon name="note" size={11} /> From {m.sources.map((src, j) => <span key={src.documentId}>{j > 0 && ', '}<Link to={`/documents/${src.documentId}`}>{src.key} {src.title}</Link></span>)}
              </span>
            )}
            <time dateTime={m.at} title={formatDateTime(m.at)}>{timeAgo(m.at)}</time>
          </div>
        ))}
        <div ref={end} />
      </div>
      {chat.canReply ? (
        <form className="wa-reply" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          {slash && (
            <div className="wa-saved" role="listbox" aria-label="Saved replies">
              {saved.length === 0 ? <p className="wa-muted">No saved replies yet. Add them under Numbers › Edit.</p>
                : matches.length === 0 ? <p className="wa-muted">No saved reply matches.</p>
                  : matches.map((r) => (
                    <button key={r.title} type="button" role="option" aria-selected={false} onMouseDown={(e) => { e.preventDefault(); pickSaved(r); }}><b>{r.title}</b><span>{r.text}</span></button>
                  ))}
            </div>
          )}
          <textarea ref={box} value={text} rows={2} aria-label="Reply"
            placeholder={chat.mode === 'ai' ? 'Reply on WhatsApp… (you take over the chat) · / for saved replies' : 'Reply on WhatsApp… · / for saved replies'}
            onChange={(e) => { setText(e.target.value); setSlash(e.target.value.startsWith('/')); }}
            onBlur={() => setTimeout(() => setSlash(false), 150)}
            onKeyDown={(e) => {
              if (slash && e.key === 'Enter' && matches[0]) { e.preventDefault(); pickSaved(matches[0]); return; }
              if (e.key === 'Escape') setSlash(false);
              if (e.key === 'Enter' && !e.shiftKey && !slash) { e.preventDefault(); void send(); }
            }} />
          <div className="wa-reply-tools">
            <button type="button" className="btn btn-ghost btn-sm" disabled={suggesting} onClick={() => void suggest()} title="Draft a reply from the chat and your company knowledge">
              {suggesting ? <Spinner /> : <Icon name="sparkle" size={14} />} Suggest</button>
            <button className="btn btn-primary btn-sm" disabled={busy || !text.trim()} aria-label="Send"><Icon name="send" size={14} /> Send</button>
          </div>
        </form>
      ) : <p className="wa-window"><Icon name="clock" size={14} /> WhatsApp allows free replies only within 24 hours of the customer's last message. Ticket updates still reach them through your approved template.</p>}
    </div>
  );
}
