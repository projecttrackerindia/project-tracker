import { handToVault } from '../vault/vaultHandoff';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type SyntheticEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { chatApi } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import type { ChatAttachment, ChatMessage, ChatThread, Conversation, MeetingCard, StandupCard, StandupItem } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { Avatar, Badge, PageLoader, Spinner } from '../../components/ui';
import { formatDate, formatDateTime } from '../../lib/format';
import { queryClient, useAuth, useEntitlement, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { COMMON_EMOJI, dayKey, dayLabel, domToBody, markdownToHtml, mentionChipHtml, mentionsUser, plainText, timeOf } from './chatFormat';
import { markAnswered } from './chatCache';
import { chatKeys, PRESENCE_LABEL, useChat, useTypingNames } from './chatStore';
import type { PresenceStatus } from '../../api/types';
import { fallbackStatus, PresenceDot } from './Presence';
import { sendTyping } from './ChatRealtime';
import { openReminderComposer } from '../reminders/store';
import { offerReminderAfterSend } from '../reminders/Suggestions';
import '../meet/meet.css';
import { StartCallButton } from '../calls/StartCall';
import { insertIntoComposer, LinkedChips, MakeFromMessage, PollCard, putMessage, SeenByDialog, SmartReplies, TranslateLine, UnfurlCards, UnfurlContext, useUnfurls, VoiceNote } from './MessageExtras';
import { DotsMenu } from '../talk/DotsMenu';
import { flyToMyWork } from '../talk/flyTask';
import { AskChatDialog, CatchUpDialog, COMPOSER_AI, PollDialog, ScheduleDialog, useVoiceRecorder } from './ChatTools';
import type { ChatExtract } from '../../api/types';
import { haptic } from '../../lib/mobile';
import { Popover } from '../../lib/popover';
import { MessageBody } from './CodeBlock';
import { isCodeOnly } from './codeDetect';
import { cleanFileName, detectPayload, findSecrets, KIND_MIME, kindOfFile, maskSecrets, payloadFileName } from './payload';
import { PayloadFileCard, PayloadSuggestion, type PayloadDraft } from './PayloadViews';

/** The stand-up summary posted after each session of a project's scrum call. */
function StandupCardMessage({ card }: { card: StandupCard; projectId?: string }) {
  const section = (title: string, items: StandupItem[], total: number, due?: boolean) => total > 0 && (
    <div className="su-sec">
      <h5>{title}</h5>
      <ul>{items.map((i) => (
        <li key={i.taskId}><code>{i.key}</code><Link className="link" to={`/work?item=${i.taskId}`}><span>{i.title}</span></Link><em>{due && i.due ? `due ${formatDate(i.due)}` : i.who ?? ''}</em></li>
      ))}</ul>
      {total > items.length && <div className="su-more">and {total - items.length} more</div>}
    </div>
  );
  return (
    <div className="su-card">
      <div className="su-head"><Icon name="checks" size={16} /><b>Stand-up summary</b><span>{formatDate(card.day)}</span></div>
      <div className="su-counts">
        <Badge tone="success">{card.doneCount} done</Badge><Badge tone="info">{card.doingCount} in progress</Badge>{card.overdueCount > 0 && <Badge tone="danger">{card.overdueCount} overdue</Badge>}
      </div>
      {section('Done since the last stand-up', card.done, card.doneCount)}
      {section('In progress', card.doing, card.doingCount)}
      {section('Overdue', card.overdue, card.overdueCount, true)}
      {card.doneCount + card.doingCount + card.overdueCount === 0 && <p className="su-more" style={{ margin: '6px 0 0' }}>Nothing done, in progress or overdue in this project.</p>}
    </div>
  );
}

/** A meeting posted in the project chat: its public details, Join (a Project Tracker call opens here), and the meeting in Meet. */
function MeetingCardMessage({ body, projectId }: { body: string; projectId: string }) {
  let card: MeetingCard | null = null;
  try { card = JSON.parse(body) as MeetingCard; } catch { /* malformed - fall through to the plain-text fallback below */ }
  if (!card) return <div className="sys-line">Meeting</div>;
  if ((card as unknown as { kind?: string }).kind === 'standup') return <StandupCardMessage card={card as unknown as StandupCard} projectId={projectId} />;
  const cancelled = card.status === 'Cancelled';
  return (
    <div className={`gm-chat-card ${cancelled ? 'cancelled' : ''}`}>
      <div className="gm-chat-card-head"><Icon name="video" size={16} /><b>{card.title}</b>{cancelled && <Badge tone="danger">Cancelled</Badge>}</div>
      <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 8px' }}>{formatDateTime(card.startTimeUtc)} – {formatDateTime(card.endTimeUtc)} · {card.participantCount} participant{card.participantCount === 1 ? '' : 's'}</p>
      {!cancelled && (
        <div style={{ display: 'flex', gap: 8 }}>
          {card.meetUri.startsWith('/')
            ? <Link className="btn btn-primary btn-sm" to={card.meetUri}><Icon name="video" size={13} /> Join</Link>
            : <a className="btn btn-primary btn-sm" href={card.meetUri} target="_blank" rel="noopener noreferrer"><Icon name="video" size={13} /> Join</a>}
          <Link className="btn btn-ghost btn-sm" to={`/meet?project=${projectId}&open=p:${card.meetingId}`}>Details</Link>
        </div>
      )}
    </div>
  );
}

const MAX_LENGTH = 4000;
const MAX_FILES = 5;
const REACTIONS = ['👍', '❤️', '😂', '🎉', '🙏', '👀', '✅', '🚀'];
const GROUP_WITHIN_MS = 5 * 60_000;
const drafts = new Map<string, string>();   // what was typed and not sent, per conversation, until the tab is closed

/** Keeps the composer's selection intact when a toolbar button is clicked (mousedown would otherwise blur it first). */
const keepFocus = (e: SyntheticEvent) => e.preventDefault();

// ------------------------------------------------------------------ the thread of one conversation
/** `variant="panel"` is the project chat in its slide-in panel: a close button instead of back / details, and no navigating away when access is lost. */
export function Thread({ conversation, onBack, onInfo, infoOpen = false, onFiles, filesOpen = false, variant = 'page', onClose, banner, sub }: {
  conversation: Conversation; onBack: () => void; onInfo?: () => void; infoOpen?: boolean; onFiles?: () => void; filesOpen?: boolean;
  /** 'talk': the v2 header (Call and ···), a strip under it, and ✦ drafting in the message box. */
  variant?: 'page' | 'panel' | 'talk'; onClose?: () => void; banner?: React.ReactNode; sub?: string;
}) {
  const wid = useWorkspaceId()!;
  const me = useAuth((s) => s.ctx!.user.id);
  const navigate = useNavigate();
  const id = conversation.id;
  const statuses = useChat((s) => s.status);
  const setOpen = useChat((s) => s.setOpenConversation);
  const typingNames = useTypingNames(id);

  const thread = useQuery({ queryKey: chatKeys.thread(wid, id), queryFn: () => chatApi.messages(id), staleTime: 30_000 });
  const items = useMemo(() => thread.data?.items ?? [], [thread.data]);
  const projectId = conversation.projectId;
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [newBelow, setNewBelow] = useState(0);
  const [params, setParams] = useSearchParams();
  const [openThread, setOpenThread] = useState<string | null>(() => params.get('thread'));
  const [side, setSide] = useState<null | 'pins'>(null);
  const [dialog, setDialog] = useState<null | 'catchup' | 'ask' | 'poll'>(null);
  const unfurls = useUnfurls(items);
  const pins = useQuery({ queryKey: chatKeys.pins(wid, id), queryFn: () => chatApi.pins(id), staleTime: 60_000 });
  const pinCount = pins.data?.length ?? 0;

  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const firstPaint = useRef(true);
  const lastSeenId = useRef<string | undefined>(undefined);
  const restoreFrom = useRef<number | null>(null);

  useEffect(() => { setOpen(id); return () => setOpen(null); }, [id, setOpen]);
  // A conversation that is gone (left the group, removed) sends the person back to the list instead of showing an error.
  useEffect(() => {
    if (!(thread.error instanceof ApiError && thread.error.status === 404)) return;
    if (variant === 'panel') { toast('You no longer have access to this chat.', 'info'); onClose?.(); }
    else navigate('/messages', { replace: true });
  }, [thread.error, navigate, variant, onClose]);

  // ---- keep the view where the person expects it
  const toBottom = useCallback((smooth = false) => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    setNewBelow(0);
  }, []);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !thread.data) return;
    if (restoreFrom.current !== null) { el.scrollTop = el.scrollHeight - restoreFrom.current; restoreFrom.current = null; return; }
    const last = items.at(-1);
    if (firstPaint.current) { firstPaint.current = false; lastSeenId.current = last?.id; toBottom(); return; }
    if (last && last.id !== lastSeenId.current) {
      lastSeenId.current = last.id;
      if (atBottom.current || last.senderId === me) toBottom(true);
      else setNewBelow((n) => n + 1);
    }
  }, [items, thread.data, me, toBottom]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom.current) setNewBelow(0);
  };

  const loadOlder = async () => {
    const first = items[0];
    if (!first || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await chatApi.messages(id, first.createdAt);
      const el = listRef.current;
      restoreFrom.current = el ? el.scrollHeight - el.scrollTop : null;   // keep the message the person was reading in place
      queryClient.setQueryData<ChatThread>(chatKeys.thread(wid, id), (old) => old && { items: [...page.items, ...old.items], hasMore: page.hasMore });
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not load earlier messages.', 'error'); }
    finally { setLoadingOlder(false); }
  };

  // A link to a message (a search hit, a citation, a catch-up line, a saved message) opens the conversation scrolled to it.
  const wanted = params.get('m');
  useEffect(() => {
    if (!wanted || !thread.data || params.get('thread')) return;
    const t = window.setTimeout(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-msg="${wanted}"]`);
      if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); window.setTimeout(() => el.classList.remove('flash'), 1600); }
      const next = new URLSearchParams(params); next.delete('m'); setParams(next, { replace: true });
    }, 120);
    return () => window.clearTimeout(t);
  }, [wanted, thread.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = params.get('thread'); if (t) setOpenThread(t); }, [params]);
  const closeThread = () => {
    setOpenThread(null);
    if (params.get('thread')) { const next = new URLSearchParams(params); next.delete('thread'); next.delete('m'); setParams(next, { replace: true }); }
  };

  // ---- tell the server what has been read
  const reading = useRef(false);
  const unread = useRef(conversation.unread);
  unread.current = conversation.unread;
  const markRead = useCallback(async () => {
    if (reading.current || document.hidden || unread.current === 0) return;
    reading.current = true;
    try {
      await chatApi.markRead(id);
      queryClient.setQueryData<Conversation[]>(chatKeys.conversations(wid), (old) => old?.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));
      void queryClient.invalidateQueries({ queryKey: chatKeys.unread(wid) });
      if (projectId) {
        queryClient.setQueryData<Conversation>(chatKeys.project(wid, projectId), (old) => old && { ...old, unread: 0, unreadMentions: 0 });
        void queryClient.invalidateQueries({ queryKey: chatKeys.projectUnread(wid) });
      }
    } catch { /* the next message or focus tries again */ }
    finally { reading.current = false; }
  }, [id, wid, projectId]);
  useEffect(() => { if (thread.data && conversation.unread > 0) void markRead(); }, [thread.data, conversation.unread, items.length, markRead]);
  useEffect(() => {
    const back = () => { if (!document.hidden) void markRead(); };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    return () => { document.removeEventListener('visibilitychange', back); window.removeEventListener('focus', back); };
  }, [markRead]);

  // ---- act on a message
  const remove = async (m: ChatMessage) => {
    if (!(await confirmDialog({ title: 'Delete message', message: 'This message will be removed for everyone in the conversation.', confirmText: 'Delete' }))) return;
    try { await chatApi.deleteMessage(m.id); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete the message.', 'error'); }
  };
  const jumpTo = (messageId: string) => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-msg="${messageId}"]`);
    if (!el) { toast('That message is further up. Scroll up to load earlier messages.', 'info'); return; }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    window.setTimeout(() => el.classList.remove('flash'), 1400);
  };

  // ---- who is here
  const others = useMemo(() => conversation.members.filter((m) => m.userId !== me), [conversation.members, me]);
  const other = conversation.type === 'Direct' ? others[0] : null;
  const presenceOf = (m: { userId: string; online: boolean; status?: PresenceStatus }): PresenceStatus => statuses[m.userId] ?? fallbackStatus(m);
  const onlineCount = others.filter((m) => presenceOf(m) === 'active').length;
  const otherStatus: PresenceStatus = other ? presenceOf(other) : 'offline';
  const status = typingNames.length
    ? <span className="typing-text">{conversation.type === 'Direct' ? 'typing' : typingNames.length === 1 ? `${typingNames[0].split(' ')[0]} is typing` : `${typingNames.slice(0, 2).map((n) => n.split(' ')[0]).join(' and ')} are typing`}<i className="dots"><b /><b /><b /></i></span>
    : conversation.type === 'Direct'
      ? <>{otherStatus === 'active' ? <span className="status-on">{PRESENCE_LABEL.active}</span> : otherStatus === 'away' ? <span className="status-away">{PRESENCE_LABEL.away}</span> : PRESENCE_LABEL.offline}
          {other?.statusText && <span className="status-line"> · {other.statusEmoji} {other.statusText}</span>}{other?.dnd && <span className="status-line" title="Do not disturb"> · do not disturb</span>}</>
      : `${conversation.members.length} members${onlineCount ? ` · ${onlineCount} online` : ''}`;

  // A message I sent counts as read once everyone else in the conversation has read past it (the recipient in a direct
  // chat, or everyone in a group — the same rule WhatsApp-style double ticks use).
  const isRead = (m: ChatMessage) => others.length > 0 && others.every((o) => utcMs(o.lastReadAt) >= utcMs(m.createdAt));

  // ✦ in an empty message box: a reply to the last thing someone else said, from the same suggestions as "Suggest replies".
  const draftReply = async () => {
    const last = [...items].reverse().find((x) => x.kind === 'User' && !x.isDeleted && x.senderId !== me && !!x.body);
    if (!last) { toast('Nothing to reply to yet. Write the first message.', 'info'); return null; }
    try { const r = await chatApi.replies(last.id); if (!r.replies.length) toast('No reply to suggest right now.', 'info'); return r.replies[0] ?? null; }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not draft a reply right now.', 'error'); return null; }
  };

  return (
    <div className={`chat-thread${variant === 'talk' ? ' talk-thread' : ''}`}>
      {variant === 'talk' ? (
        <header className="chat-head talk-head">
          <button className="btn-icon chat-back" onClick={onBack} aria-label="Back to conversations"><Icon name="arrowLeft" /></button>
          {conversation.type === 'Direct' ? <ConversationAvatar conversation={conversation} status={otherStatus} /> : <span className="talk-head-gl" aria-hidden="true">#</span>}
          <div className="chat-head-text">
            <h2>{conversation.name}</h2>
            <div className="chat-sub" aria-live="polite">{typingNames.length ? status : sub ?? status}</div>
          </div>
          {conversation.type !== 'Direct' && (
            <span className="talk-ppl" aria-label={`${conversation.members.length} members`}>
              {others.slice(0, 4).map((m) => <Avatar key={m.userId} name={m.name} size="sm" userId={m.userId} />)}
            </span>
          )}
          <StartCallButton conversationId={conversation.id} label={conversation.type === 'Direct' ? 'Call' : 'Group call'} compact className="talk-ib talk-call" />
          <DotsMenu label="Conversation actions" className="talk-info" icon="info" items={[
            { label: 'Details', hint: 'People, mute, leave', icon: 'info', onSelect: () => onInfo?.(), hidden: !onInfo },
            { label: 'Catch me up', hint: 'Decisions, questions and actions in this chat', icon: 'sparkle', onSelect: () => setDialog('catchup') },
            { label: 'Ask this conversation', icon: 'search', onSelect: () => setDialog('ask') },
            { label: `Pinned messages${pinCount ? ` (${pinCount})` : ''}`, icon: 'flag', onSelect: () => setSide((v) => (v === 'pins' ? null : 'pins')) },
            { label: 'Files', icon: 'folder', onSelect: () => onFiles?.(), hidden: !onFiles },
          ]} />
        </header>
      ) : (
      <header className="chat-head">
        {variant === 'page' && <button className="btn-icon chat-back" onClick={onBack} aria-label="Back to conversations"><Icon name="arrowLeft" /></button>}
        <ConversationAvatar conversation={conversation} status={otherStatus} />
        <div className="chat-head-text">
          <h2>{conversation.name}</h2>
          <div className="chat-sub" aria-live="polite">{status}</div>
        </div>
        <StartCallButton conversationId={conversation.id} label={conversation.type === 'Direct' ? `Call ${conversation.name}` : 'Group call with everyone in this chat'} compact className="btn-icon chat-head-action call" />
        <button className="btn-icon chat-head-action ai" onClick={() => setDialog('catchup')} aria-label="Catch me up on this conversation" title="Catch me up"><Icon name="sparkle" size={16} /></button>
        <button className="btn-icon chat-head-action" onClick={() => setDialog('ask')} aria-label="Ask this conversation" title="Ask this conversation"><Icon name="search" size={16} /></button>
        <button className={`btn-icon chat-head-action ${side === 'pins' ? 'on' : ''}`} onClick={() => setSide((v) => (v === 'pins' ? null : 'pins'))} aria-label={`Pinned messages${pinCount ? ` (${pinCount})` : ''}`} aria-pressed={side === 'pins'} title="Pinned">
          <Icon name="flag" size={16} />{pinCount > 0 && <span className="head-count">{pinCount}</span>}
        </button>
        {variant === 'page' && (
          <>
            <button className={`btn-icon chat-head-action ${filesOpen ? 'on' : ''}`} onClick={onFiles} aria-label="Files shared in this conversation" aria-pressed={filesOpen} title="Files"><Icon name="folder" size={17} /></button>
            <button className={`btn-icon chat-head-action ${infoOpen ? 'on' : ''}`} onClick={onInfo} aria-label="Conversation details" aria-pressed={infoOpen} title="Details"><Icon name="info" size={17} /></button>
          </>
        )}
        {variant === 'panel' && <button className="btn-icon" onClick={onClose ?? onBack} aria-label="Close chat" title="Close"><Icon name="close" /></button>}
      </header>
      )}
      {banner}

      <UnfurlContext.Provider value={unfurls}>
      <div className="chat-messages" ref={listRef} onScroll={onScroll} role="log" aria-label={`Messages with ${conversation.name}`}>
        {thread.isLoading && <PageLoader />}
        {thread.isError && !(thread.error instanceof ApiError && thread.error.status === 404) && (
          <div className="chat-note">Messages could not be loaded. <button className="link-btn" onClick={() => void thread.refetch()}>Try again</button></div>
        )}
        {thread.data?.hasMore && (
          <div className="chat-older"><button className="btn btn-ghost btn-sm" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? <Spinner /> : 'Load earlier messages'}</button></div>
        )}
        {thread.data && items.length === 0 && (
          <div className="chat-empty"><Icon name="message" size={28} /><p>No messages yet.</p><span>{conversation.type === 'Project' ? 'Start the conversation with the project team. Type @ to mention someone.' : `Say hello to ${conversation.type === 'Direct' ? conversation.name : 'the group'}.`}</span></div>
        )}
        {items.map((m, i) => {
          const prev = items[i - 1];
          const newDay = !prev || dayKey(prev.createdAt) !== dayKey(m.createdAt);
          const grouped = !newDay && !!prev && prev.kind === 'User' && m.kind === 'User' && prev.senderId === m.senderId
            && utcMs(m.createdAt) - utcMs(prev.createdAt) < GROUP_WITHIN_MS;
          const mine = m.senderId === me;
          const next = items[i + 1];
          const tail = !next || dayKey(next.createdAt) !== dayKey(m.createdAt) || next.kind !== 'User' || m.kind !== 'User' || next.senderId !== m.senderId
            || utcMs(next.createdAt) - utcMs(m.createdAt) >= GROUP_WITHIN_MS;
          return (
            <div key={m.id} className="chat-row-wrap">
              {newDay && <div className="day-sep"><span>{dayLabel(m.createdAt)}</span></div>}
              {m.kind === 'System'
                ? (decisionOf(m.body)
                    ? <DecisionCapsule id={m.id} d={decisionOf(m.body)!} />
                    : <div className="sys-line" data-msg={m.id}>{m.body}</div>)
                : m.kind === 'Meeting' && conversation.projectId
                ? <MeetingCardMessage body={m.body} projectId={conversation.projectId} />
                : <MessageRow m={m} mine={mine} grouped={grouped} tail={tail} showName={conversation.type !== 'Direct'} canModerate={conversation.canManage}
                    ticks={conversation.type !== 'Project'} aboutMe={!mine && mentionsUser(m.body, me)}
                    read={mine && isRead(m)} conversation={conversation} onThread={() => setOpenThread(m.id)} talk={variant === 'talk'}
                    onReply={() => { setEditing(null); setReplyTo(m); }}
                    onEdit={() => { setReplyTo(null); setEditing(m); }} onDelete={() => void remove(m)} onJump={jumpTo} />}
            </div>
          );
        })}
      </div>
      </UnfurlContext.Provider>

      {newBelow > 0 && <button className="new-below" onClick={() => toBottom(true)}><Icon name="chevronD" size={14} /> {newBelow} new {newBelow === 1 ? 'message' : 'messages'}</button>}

      <Composer key={`${id}:${editing?.id ?? ''}`} conversation={conversation} replyTo={replyTo} editing={editing} onPoll={() => setDialog('poll')}
        placeholder={variant === 'talk' ? `Message ${conversation.type === 'Direct' ? conversation.name : `#${conversation.name.replace(/^#/, '')}`}` : undefined} draftReply={variant === 'talk' ? draftReply : undefined} talk={variant === 'talk'}
        mentionable={conversation.type === 'Project' ? conversation.members.filter((m) => m.userId !== me).map((m) => ({ userId: m.userId, name: m.name })) : []}
        onCancel={() => { setReplyTo(null); setEditing(null); }}
        onSent={(m) => {
          setReplyTo(null); setEditing(null);
          queryClient.setQueryData<ChatThread>(chatKeys.thread(wid, id), (old) => {
            if (!old) return old;
            return old.items.some((x) => x.id === m.id) ? { ...old, items: old.items.map((x) => (x.id === m.id ? m : x)) } : { ...old, items: [...old.items, m] };
          });
          void queryClient.invalidateQueries({ queryKey: chatKeys.conversations(wid) });
          if (!editing) markAnswered(wid, m);   // also when the live connection is down (a phone just woke up)
        }} />

      {openThread && <ThreadPanel key={openThread} conversation={conversation} rootId={openThread} focus={params.get('thread') ? params.get('m') : null} onClose={closeThread} unfurls={unfurls} />}
      {side === 'pins' && !openThread && <PinsPanel conversation={conversation} onClose={() => setSide(null)} onJump={(mid) => { setSide(null); jumpTo(mid); }} />}
      {dialog === 'catchup' && <CatchUpDialog conversationId={id} onClose={() => setDialog(null)} />}
      {dialog === 'ask' && <AskChatDialog conversationId={id} onClose={() => setDialog(null)} />}
      {dialog === 'poll' && <PollDialog conversation={conversation} onClose={() => setDialog(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------ a thread beside the conversation
/** A thread: its first message and the replies under it, with its own composer. Replies stay here and do not fill the conversation. */
function ThreadPanel({ conversation, rootId, focus, onClose, unfurls }: { conversation: Conversation; rootId: string; focus: string | null; onClose: () => void; unfurls: Map<string, import('../../api/types').ChatUnfurl> }) {
  const wid = useWorkspaceId()!;
  const me = useAuth((s) => s.ctx!.user.id);
  const q = useQuery({ queryKey: chatKeys.threadView(wid, rootId), queryFn: () => chatApi.thread(rootId), staleTime: 15_000 });
  const listRef = useRef<HTMLDivElement>(null);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const count = q.data?.replies.length ?? 0;
  useEffect(() => {
    const el = listRef.current;
    if (!el || !q.data) return;
    const target = focus ? el.querySelector<HTMLElement>(`[data-msg="${focus}"]`) : null;
    if (target) { target.scrollIntoView({ block: 'center' }); target.classList.add('flash'); window.setTimeout(() => target.classList.remove('flash'), 1600); }
    else el.scrollTop = el.scrollHeight;
  }, [count, q.data, focus]);
  const remove = async (m: ChatMessage) => {
    if (!(await confirmDialog({ title: 'Delete message', message: 'This message will be removed for everyone in the thread.', confirmText: 'Delete' }))) return;
    try { await chatApi.deleteMessage(m.id); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete the message.', 'error'); }
  };
  const all = q.data ? [q.data.root, ...q.data.replies] : [];
  return (
    <aside className="thread-side" aria-label="Thread">
      <div className="thread-side-head">
        <div><h3>Thread</h3><span className="muted">{count} {count === 1 ? 'reply' : 'replies'}</span></div>
        <button className="btn-icon" onClick={onClose} aria-label="Close thread"><Icon name="close" /></button>
      </div>
      <UnfurlContext.Provider value={unfurls}>
        <div className="thread-side-list chat-messages" ref={listRef}>
          {q.isLoading && <PageLoader />}
          {q.isError && <div className="chat-note">This thread is not available.</div>}
          {all.map((m, i) => (
            <div key={m.id} className={i === 0 ? 'thread-root' : ''}>
              <MessageRow m={m} mine={m.senderId === me} grouped={false} tail showName canModerate={conversation.canManage} ticks={false}
                aboutMe={m.senderId !== me && mentionsUser(m.body, me)} read={false} conversation={conversation} inThread
                onReply={() => { setEditing(null); setReplyTo(m); }} onEdit={() => { setReplyTo(null); setEditing(m); }} onDelete={() => void remove(m)}
                onJump={(mid) => listRef.current?.querySelector<HTMLElement>(`[data-msg="${mid}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })} />
              {i === 0 && count > 0 && <div className="thread-sep"><span>{count} {count === 1 ? 'reply' : 'replies'}</span></div>}
            </div>
          ))}
        </div>
      </UnfurlContext.Provider>
      {q.data && !q.data.root.isDeleted && (
        <Composer key={`${rootId}:${editing?.id ?? ''}`} conversation={conversation} replyTo={replyTo} editing={editing} threadRootId={rootId}
          mentionable={conversation.type === 'Project' ? conversation.members.filter((m) => m.userId !== me).map((m) => ({ userId: m.userId, name: m.name })) : []}
          onCancel={() => { setReplyTo(null); setEditing(null); }}
          onSent={(m) => { const edit = !!editing; setReplyTo(null); setEditing(null); putMessage(wid, m); if (!edit) markAnswered(wid, m); }} />
      )}
    </aside>
  );
}

/** The pinned messages of the conversation; clicking one goes to it. */
function PinsPanel({ conversation, onClose, onJump }: { conversation: Conversation; onClose: () => void; onJump: (id: string) => void }) {
  const wid = useWorkspaceId()!;
  const q = useQuery({ queryKey: chatKeys.pins(wid, conversation.id), queryFn: () => chatApi.pins(conversation.id), staleTime: 15_000 });
  return (
    <aside className="thread-side" aria-label="Pinned messages">
      <div className="thread-side-head"><div><h3>Pinned</h3><span className="muted">{q.data?.length ?? 0} pinned</span></div><button className="btn-icon" onClick={onClose} aria-label="Close pinned messages"><Icon name="close" /></button></div>
      <div className="thread-side-list">
        {q.data?.length === 0 && <p className="chat-note">Nothing pinned yet. Pin a message to keep it at hand for everyone here.</p>}
        <ul className="pin-list">{(q.data ?? []).map((m) => (
          <li key={m.id}><button type="button" className="saved-row" onClick={() => (m.threadRootId ? toast('That message is in a thread.', 'info') : onJump(m.id))}>
            <b>{m.senderName ?? 'Decision'}</b><span>{plainText(m.body).slice(0, 200) || 'Attachment'}</span>
            <time>{m.pinnedBy ? `pinned by ${m.pinnedBy}` : ''}</time>
          </button></li>
        ))}</ul>
      </div>
    </aside>
  );
}

/** A closed poll's decision line ("Decision: X — “question” (N voted, closed by W)"), or null for any other system line. */
export function decisionOf(body: string): { text: string; by: string | null; agreed: number | null } | null {
  const m = /^Decision:\s*(.+?)(?:\s+—\s+“[^”]*”)?\s*(?:\((\d+) voted, closed by ([^)]+)\))?$/.exec(body.trim());
  return m ? { text: m[1], by: m[3] ?? null, agreed: m[2] ? Number(m[2]) : null } : null;
}

function DecisionCapsule({ id, d }: { id: string; d: NonNullable<ReturnType<typeof decisionOf>> }) {
  return (
    <div className="decision-cap" data-msg={id} role="note" aria-label={`Decision: ${d.text}`}>
      <span className="decision-tag">DECISION</span><b>{d.text}</b>
      {(d.by || d.agreed) && <span className="decision-by">— {[d.by?.split(' ')[0], d.agreed ? `agreed by ${d.agreed}` : null].filter(Boolean).join(' · ')}</span>}
    </div>
  );
}

const utcMs = (iso: string) => new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`).getTime();

/** A single grey check for sent, a double check — coloured once read — matching the familiar messaging-app convention. */
function Ticks({ read }: { read: boolean }) {
  return (
    <span className={`ticks ${read ? 'read' : ''}`} title={read ? 'Read' : 'Sent'}>
      <Icon name={read ? 'checks' : 'tick'} size={13} aria-label={read ? 'Read' : 'Sent'} />
    </span>
  );
}

// ------------------------------------------------------------------ one message
function fileSize(bytes: number) { return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; }

/** A picture sent in chat, fetched with the signed-in person's access (a file is never a public link). Click to view it larger. */
function ChatImage({ file }: { file: ChatAttachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true; let made: string | null = null;
    chatApi.fileUrl(file.id, true).then((u) => { made = u; if (live) setUrl(u); else URL.revokeObjectURL(u); }).catch(() => undefined);
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [file.id]);
  useEffect(() => {
    if (!open) return;
    const close = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);
  return (
    <>
      <button type="button" className="chat-img" onClick={() => url && setOpen(true)} aria-label={`View ${file.fileName}`}>
        {url ? <img src={url} alt={file.fileName} loading="lazy" /> : <span className="chat-img-wait"><Spinner /></span>}
      </button>
      {open && url && (
        <div className="chat-lightbox" role="dialog" aria-label={file.fileName} onClick={() => setOpen(false)}>
          <img src={url} alt={file.fileName} onClick={(e) => e.stopPropagation()} />
          <button type="button" className="btn-icon" aria-label="Close" onClick={() => setOpen(false)}><Icon name="close" size={18} /></button>
        </div>
      )}
    </>
  );
}

function ChatFile({ file }: { file: ChatAttachment }) {
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const url = await chatApi.fileUrl(file.id);
      const a = document.createElement('a'); a.href = url; a.download = file.fileName; document.body.appendChild(a); a.click(); a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch { toast('Could not download the file.', 'error'); }
    finally { setBusy(false); }
  };
  // JSON, logs, XML, CSV and text files show what is in them (a preview, and a viewer to open).
  if (kindOfFile(file.fileName, file.contentType)) return <PayloadFileCard file={file} onDownload={() => void save()} />;
  return (
    <button type="button" className="chat-file" onClick={() => void save()} disabled={busy} title={`Download ${file.fileName}`}>
      <span className="chat-file-icon"><Icon name="paperclip" size={16} /></span>
      <span className="chat-file-meta"><b>{file.fileName}</b><em>{fileSize(file.sizeBytes)}</em></span>
      {busy ? <Spinner /> : <Icon name="download" size={14} />}
    </button>
  );
}

const remindAbout = (m: ChatMessage) =>
  openReminderComposer({ subject: { type: 'ChatMessage', id: m.id, title: m.body.replace(/\s+/g, ' ').slice(0, 117) + (m.body.length > 117 ? '…' : ''), key: 'Message' } });

/**
 * One message. Time, "edited" and the read ticks sit inside the bubble; the avatar shows once, beside the last message of a run. With a
 * mouse, a small toolbar appears on hover; on a phone, a long press opens the actions as a sheet and a swipe to the right replies.
 */
function MessageRow({ m, mine, grouped, tail, showName, canModerate, ticks, aboutMe, read, onReply, onEdit, onDelete, onJump, conversation, onThread, inThread = false, talk = false }: {
  m: ChatMessage; mine: boolean; grouped: boolean; tail: boolean; showName: boolean; canModerate: boolean; ticks: boolean; aboutMe: boolean; read: boolean;
  onReply: () => void; onEdit: () => void; onDelete: () => void; onJump: (id: string) => void;
  conversation: Conversation; onThread?: () => void; inThread?: boolean;
  /** Talk: Make task · Remind me · ↩ beside the bubble, and a made task flies to My Work. */ talk?: boolean;
}) {
  const wid = useWorkspaceId();
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const actsRef = useRef<HTMLDivElement>(null);
  const unhook = useRef<(() => void) | null>(null);
  /**
   * The hover actions sit against the bubble's top edge, on its outer side. On a bubble taller than the visible list they follow the
   * visible part of it (sticky) and never go below the bottom of the list, so the composer stays clear.
   */
  const placeActs = useCallback(() => {
    const wrap = wrapRef.current, bar = actsRef.current;
    if (!wrap || !bar) return;
    const w = wrap.getBoundingClientRect();
    const list = wrap.closest('.chat-messages')?.getBoundingClientRect();
    const box = list ?? { top: 0, bottom: window.innerHeight };
    const h = bar.offsetHeight || 32;
    const lowest = Math.min(w.height - h, box.bottom - 8 - h - w.top);
    const top = Math.max(Math.min(0, w.height - h), Math.min(Math.max(0, box.top + 8 - w.top), lowest));
    // A wide bubble in a narrow pane leaves no room beside it: then the bar sits just above the bubble's top edge, or, when that edge
    // is scrolled out of view (a tall bubble), tucks inside the bubble's visible top corner.
    const room = mine ? w.left - (list?.left ?? 0) : (list?.right ?? window.innerWidth) - w.right;
    const beside = room >= bar.offsetWidth + 12, above = !beside && w.top - h - 4 >= box.top;
    bar.classList.toggle('above', above);
    bar.classList.toggle('inside', !beside && !above);
    bar.style.top = `${Math.round(above ? -(h + 4) : top)}px`;
  }, [mine]);
  const onHover = () => {
    placeActs();
    if (unhook.current) return;
    const list = wrapRef.current?.closest('.chat-messages');
    if (!list) return;
    list.addEventListener('scroll', placeActs, { passive: true });
    unhook.current = () => list.removeEventListener('scroll', placeActs);
  };
  const onUnhover = () => { if (!more) { unhook.current?.(); unhook.current = null; } };
  useEffect(() => () => unhook.current?.(), []);
  const [extra, setExtra] = useState<null | 'translate' | 'replies'>(null);
  const [making, setMaking] = useState<ChatExtract['kind'] | null>(null);
  const [seen, setSeen] = useState(false);
  const isPoll = m.kind === 'Poll';
  const canThread = !inThread && !m.threadRootId && !!onThread;
  const update = (updated: ChatMessage) => { if (wid) putMessage(wid, updated); };
  const pin = () => chatApi.pin(m.id, !m.pinnedAt).then(update).catch((e) => toast(e instanceof ApiError ? e.message : 'Could not pin it.', 'error'));
  const save = () => chatApi.save(m.id, !m.saved).then((u) => { update(u); toast(u.saved ? 'Saved. Find it under Saved in the chat list.' : 'Removed from saved.', 'success'); })
    .catch((e) => toast(e instanceof ApiError ? e.message : 'Could not save it.', 'error'));
  const moreItems: { label: string; icon: IconName; run: () => void; hidden?: boolean }[] = [
    { label: 'Make a task', icon: 'checkCircle', run: () => setMaking('task') },
    { label: 'Make a ticket', icon: 'tag', run: () => setMaking('ticket') },
    { label: 'Make a reminder', icon: 'alarm', run: () => setMaking('reminder') },
    { label: 'Make a page', icon: 'note', run: () => setMaking('page') },
    { label: 'Translate', icon: 'message', run: () => setExtra('translate'), hidden: !m.body || isPoll },
    { label: 'Suggest replies', icon: 'sparkle', run: () => setExtra('replies'), hidden: mine || isPoll || !m.body },
    { label: 'Seen by', icon: 'eye', run: () => setSeen(true), hidden: !mine || conversation.type === 'Project' },
  ];
  const [sheet, setSheetState] = useState(false);
  const sheetAt = useRef(0);
  const setSheet = (open: boolean) => { if (open) sheetAt.current = performance.now(); setSheetState(open); };
  const [swipe, setSwipe] = useState(0);
  const touch = useRef<{ x: number; y: number; timer: number; horizontal: boolean | null; long: boolean } | null>(null);
  /** Adds or takes back the person's own reaction; the answer is the message as it now stands, written into the open conversation at once. */
  const onReact = (emoji: string, on: boolean) => {
    if (!wid) return;
    (on ? chatApi.react(m.id, emoji) : chatApi.unreact(m.id, emoji))
      .then((updated) => queryClient.setQueryData<ChatThread>(chatKeys.thread(wid, m.conversationId), (old) => old && { ...old, items: old.items.map((x) => (x.id === updated.id ? updated : x)) }))
      .catch((e) => toast(e instanceof ApiError ? e.message : 'Could not save your reaction.', 'error'));
  };
  const toggleReaction = (emoji: string) => onReact(emoji, !(m.reactions?.find((r) => r.emoji === emoji)?.mine));
  const copy = () => { void navigator.clipboard?.writeText(plainText(m.body)).then(() => toast('Copied.')).catch(() => undefined); };

  // ---- touch: long press for the actions, swipe right to reply
  const onTouchStart = (e: React.TouchEvent) => {
    if (m.isDeleted || e.touches.length !== 1) return;
    const t = e.touches[0];
    const timer = window.setTimeout(() => { if (touch.current && !touch.current.horizontal) { touch.current.long = true; haptic(12); setSheet(true); } }, 430);
    touch.current = { x: t.clientX, y: t.clientY, timer, horizontal: null, long: false };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = touch.current;
    if (!s) return;
    const dx = e.touches[0].clientX - s.x, dy = e.touches[0].clientY - s.y;
    if (s.horizontal === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) { s.horizontal = Math.abs(dx) > Math.abs(dy) && dx > 0; window.clearTimeout(s.timer); }
    if (s.horizontal) { const v = Math.max(0, Math.min(72, dx * 0.6)); if (v >= 48 && swipe < 48) haptic(8); setSwipe(v); }
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touch.current;
    if (!s) return;
    window.clearTimeout(s.timer);
    if (s.long && e.cancelable) e.preventDefault();   // the finger lifting after a long press is not a tap on the sheet
    if (s.horizontal && swipe >= 48) onReply();
    setSwipe(0);
    touch.current = null;
  };

  const meta = (
    <span className="bubble-meta">
      {m.editedAt && !m.isDeleted && <span>edited</span>}
      <time dateTime={m.createdAt} title={formatDateTime(m.createdAt)}>{timeOf(m.createdAt)}</time>
      {ticks && mine && !m.isDeleted && <Ticks read={read} />}
    </span>
  );

  return (
    <div className={`msg ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''} ${tail ? 'tail' : ''} ${aboutMe ? 'mentions-me' : ''} ${more ? 'menu-open' : ''}`} data-msg={m.id}
      onMouseEnter={onHover} onMouseLeave={onUnhover} onFocus={onHover}>
      {!mine && (tail ? <Avatar name={m.senderName} size="sm" userId={m.senderId ?? undefined} /> : <span className="avatar-gap" />)}
      <div className="msg-col">
        {(!grouped || m.pinnedAt || m.asksMe) && ((!mine && showName && !grouped) || (aboutMe && !m.isDeleted) || m.pinnedAt || m.asksMe) && (
          <div className="msg-meta">
            {!mine && showName && !grouped && <strong>{m.senderName ?? 'Former member'}</strong>}
            {aboutMe && !m.isDeleted && <span className="mention-flag" title="You were mentioned">@ you</span>}
            {m.asksMe && !m.isDeleted && <span className="asks-flag" title="A question for you that you have not answered yet"><Icon name="message" size={12} /> Waiting for your answer</span>}
            {m.pinnedAt && <span className="pin-flag" title={m.pinnedBy ? `Pinned by ${m.pinnedBy}` : 'Pinned'}><Icon name="flag" size={12} /> Pinned</span>}
          </div>
        )}
        <div className="bubble-wrap" ref={wrapRef} style={swipe ? { transform: `translateX(${swipe}px)` } : undefined}
          onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}
          onContextMenu={(e) => { if (touch.current?.long) e.preventDefault(); }}>
          {swipe > 0 && <span className={`swipe-reply ${swipe >= 48 ? 'ready' : ''}`} aria-hidden><Icon name="undo" size={14} /></span>}
          <div className={`bubble${!m.body && (m.attachments?.length ?? 0) > 0 && !isPoll ? ' files-only' : ''}${!m.isDeleted && !isPoll && isCodeOnly(m.body) ? ' code-only' : ''}`}>
            {m.replyTo && !m.isDeleted && (
              <button className="reply-quote" onClick={() => onJump(m.replyTo!.id)} type="button">
                <b>{m.replyTo.senderName ?? 'Former member'}</b>
                <span>{m.replyTo.isDeleted ? 'Message deleted' : m.replyTo.snippet}</span>
              </button>
            )}
            {m.isDeleted
              ? <em className="deleted">This message was deleted{meta}</em>
              : <>
                  {(m.attachments?.length ?? 0) > 0 && (
                    <div className="chat-files">{m.attachments!.map((f) => (f.isVoice ? <VoiceNote key={f.id} file={f} /> : f.isImage ? <ChatImage key={f.id} file={f} /> : <ChatFile key={f.id} file={f} />))}</div>
                  )}
                  {isPoll && m.poll ? <><PollCard poll={m.poll} onChanged={update} /><div className="msg-text">{meta}</div></>
                    : <div className="msg-text">{m.body ? <MessageBody body={m.body} /> : null}{meta}</div>}
                </>}
          </div>
            {!m.isDeleted && (
              // Beside the bubble, never on it: the two things people do most, and everything else under ···.
              <div className="msg-actions" ref={actsRef} role="group" aria-label="Message actions">
                {talk ? <>
                  <button type="button" className="msg-act make" onClick={() => setMaking('task')}><Icon name="tick" size={13} />Make task</button>
                  <button type="button" className="msg-act" onClick={() => remindAbout(m)}><Icon name="clock" size={13} />Remind me</button>
                  <button type="button" className="msg-act" onClick={onReply} aria-label="Reply" title="Reply"><Icon name="undo" size={13} /></button>
                </> : <>
                <button type="button" className="msg-act" onClick={onReply}>Reply</button>
                <button type="button" className="msg-act" onClick={() => setMaking('task')}>Make task</button>
                </>}
                <div className="react-wrap" ref={moreRef}>
                  <button type="button" className="msg-act dots" onClick={() => setMore((v) => !v)} aria-label="More actions" aria-expanded={more} title="More"><Icon name="more" size={14} /></button>
                  <Popover open={more} onClose={() => { setMore(false); unhook.current?.(); unhook.current = null; }} anchorRef={moreRef} side="bottom" align={mine ? 'end' : 'start'} within=".chat-messages">
                    <div className="more-pop" role="menu" aria-label="More actions">
                      <div className="more-reacts" role="group" aria-label="React">
                        {REACTIONS.slice(0, 6).map((emoji) => (
                          <button key={emoji} type="button" role="menuitem" className={m.reactions?.find((r) => r.emoji === emoji)?.mine ? 'on' : ''} aria-label={`React ${emoji}`} onClick={() => { setMore(false); toggleReaction(emoji); }}>{emoji}</button>
                        ))}
                      </div>
                      {canThread && <button type="button" role="menuitem" onClick={() => { setMore(false); onThread!(); }}><Icon name="message" size={15} />Reply in thread</button>}
                      {!talk && <button type="button" role="menuitem" onClick={() => { setMore(false); remindAbout(m); }}><Icon name="alarm" size={15} />Remind me</button>}
                      <button type="button" role="menuitem" onClick={() => { setMore(false); void save(); }}><Icon name="star" size={15} />{m.saved ? 'Remove from saved' : 'Save for later'}</button>
                      {m.body && <button type="button" role="menuitem" onClick={() => { setMore(false); copy(); }}><Icon name="copy" size={15} />Copy text</button>}
                      <button type="button" role="menuitem" onClick={() => { setMore(false); void pin(); }}><Icon name="flag" size={15} />{m.pinnedAt ? 'Unpin' : 'Pin to the conversation'}</button>
                      {moreItems.filter((x) => !x.hidden && x.label !== 'Make a task').map((x) => <button key={x.label} type="button" role="menuitem" onClick={() => { setMore(false); x.run(); }}><Icon name={x.icon} size={15} />{x.label}</button>)}
                      {mine && !isPoll && <button type="button" role="menuitem" onClick={() => { setMore(false); onEdit(); }}><Icon name="edit" size={15} />Edit</button>}
                      {(mine || canModerate) && <button type="button" role="menuitem" className="danger" onClick={() => { setMore(false); onDelete(); }}><Icon name="trash" size={15} />Delete</button>}
                    </div>
                  </Popover>
                </div>
              </div>
            )}
        </div>
        {!m.isDeleted && m.kind === 'User' && <UnfurlCards body={m.body} />}
        {!m.isDeleted && <LinkedChips links={m.linked} />}
        {canThread && (m.threadReplies ?? 0) > 0 && (
          <button type="button" className="thread-link" onClick={onThread}>
            <Icon name="message" size={13} /> {m.threadReplies} {m.threadReplies === 1 ? 'reply' : 'replies'}{m.threadLastAt && <span> · last {timeOf(m.threadLastAt)}</span>}
          </button>
        )}
        {extra === 'translate' && <TranslateLine m={m} onClose={() => setExtra(null)} />}
        {extra === 'replies' && <SmartReplies m={m} onClose={() => setExtra(null)} />}
        {!m.isDeleted && (m.reactions?.length ?? 0) > 0 && (
          <div className="chat-reactions">
            {m.reactions!.map((r) => (
              <button key={r.emoji} type="button" className={`react-chip ${r.mine ? 'on' : ''}`} onClick={() => onReact(r.emoji, !r.mine)}
                title={r.names.join(', ')} aria-pressed={r.mine} aria-label={`${r.emoji} ${r.count}${r.mine ? ', you reacted' : ''}`}>{r.emoji}<span>{r.count}</span></button>
            ))}
          </div>
        )}
        {making && <MakeFromMessage m={m} conversation={conversation} kind={making} onClose={() => setMaking(null)}
          onMade={talk ? (made) => flyToMyWork(document.querySelector(`[data-msg="${m.id}"] .bubble`), made) : undefined} />}
        {seen && <SeenByDialog m={m} onClose={() => setSeen(false)} />}
      </div>
      {sheet && createPortal(
        <div className="msg-sheet-scrim" onClick={() => { if (performance.now() - sheetAt.current > 350) setSheet(false); }}>
          <div className="msg-sheet" role="dialog" aria-label="Message actions" onClickCapture={(e) => { if (performance.now() - sheetAt.current < 350) { e.preventDefault(); e.stopPropagation(); } }} onClick={(e) => e.stopPropagation()}>
            <div className="msg-sheet-preview">{plainText(m.body).replace(/\*\*|__/g, '').slice(0, 140) || 'Attachment'}</div>
            <div className="msg-sheet-reacts">
              {REACTIONS.slice(0, 6).map((emoji) => (
                <button key={emoji} type="button" className={m.reactions?.find((r) => r.emoji === emoji)?.mine ? 'on' : ''} aria-label={`React ${emoji}`}
                  onClick={() => { setSheet(false); toggleReaction(emoji); }}>{emoji}</button>
              ))}
            </div>
            <div className="msg-sheet-list">
              <button type="button" onClick={() => { setSheet(false); onReply(); }}><Icon name="undo" size={17} />Reply</button>
              {canThread && <button type="button" onClick={() => { setSheet(false); onThread!(); }}><Icon name="message" size={17} />Reply in thread</button>}
              {m.body && <button type="button" onClick={() => { setSheet(false); copy(); }}><Icon name="copy" size={17} />Copy text</button>}
              <button type="button" onClick={() => { setSheet(false); remindAbout(m); }}><Icon name="alarm" size={17} />Remind me</button>
              <button type="button" onClick={() => { setSheet(false); void save(); }}><Icon name="star" size={17} />{m.saved ? 'Remove from saved' : 'Save for later'}</button>
              <button type="button" onClick={() => { setSheet(false); void pin(); }}><span className="sheet-emoji" aria-hidden="true"><Icon name="flag" size={18} /></span>{m.pinnedAt ? 'Unpin' : 'Pin'}</button>
              {moreItems.filter((x) => !x.hidden).map((x) => <button key={x.label} type="button" onClick={() => { setSheet(false); x.run(); }}><span className="sheet-emoji" aria-hidden="true"><Icon name={x.icon} size={18} /></span>{x.label}</button>)}
              {mine && !isPoll && <button type="button" onClick={() => { setSheet(false); onEdit(); }}><Icon name="edit" size={17} />Edit</button>}
              {(mine || canModerate) && <button type="button" className="danger" onClick={() => { setSheet(false); onDelete(); }}><Icon name="trash" size={17} />Delete</button>}
            </div>
          </div>
        </div>, document.body)}
    </div>
  );
}

// ------------------------------------------------------------------ writing
function Composer({ conversation, replyTo, editing, mentionable, onCancel, onSent, threadRootId = null, onPoll, placeholder, draftReply, talk = false }: {
  /** Talk: ＋ · 📎 · the box · "Draft reply" · send (voice notes under ＋; no Aa or emoji buttons). */ talk?: boolean;
  conversation: Conversation; replyTo: ChatMessage | null; editing: ChatMessage | null; mentionable: { userId: string; name: string }[];
  onCancel: () => void; onSent: (m: ChatMessage) => void;
  /** Writing in a thread: the reply goes under this message. */ threadRootId?: string | null;
  onPoll?: () => void; placeholder?: string;
  /** With an empty box, ✦ drafts a reply to the last message (Talk). */ draftReply?: () => Promise<string | null>;
}) {
  const id = conversation.id;
  const draftKey = threadRootId ? `${id}:${threadRootId}` : id;   // a thread keeps its own unsent draft
  const [drafting, setDrafting] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [later, setLater] = useState(false);
  const aiRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(() => editing?.body ?? drafts.get(draftKey) ?? '');
  const [isEmpty, setIsEmpty] = useState(() => !text);
  const [marks, setMarks] = useState({ bold: false, italic: false, underline: false });
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [formatting, setFormatting] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const lastTyping = useRef(0);
  const composing = useRef(false);

  // ---- files and pictures: uploaded as soon as they are chosen (so a big one is ready by the time the message is), sent with the message
  type Pending = { localId: string; name: string; size: number; status: 'uploading' | 'ready' | 'error'; attachment?: ChatAttachment; error?: string };
  const canAttach = useEntitlement('CHAT_ATTACHMENTS') > 0 && !editing;
  const [pending, setPending] = useState<Pending[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const addFiles = (list: FileList | File[]) => {
    if (!canAttach) return;
    const incoming = Array.from(list);
    const room = MAX_FILES - pending.length;
    if (incoming.length > room) toast(`A message can carry up to ${MAX_FILES} files.`, 'info');
    for (const file of incoming.slice(0, Math.max(0, room))) {
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setPending((p) => [...p, { localId, name: file.name, size: file.size, status: 'uploading' }]);
      chatApi.uploadFile(id, file)
        .then((attachment) => setPending((p) => p.map((x) => (x.localId === localId ? { ...x, status: 'ready', attachment } : x))))
        .catch((e) => setPending((p) => p.map((x) => (x.localId === localId ? { ...x, status: 'error', error: e instanceof ApiError ? e.message : 'Could not upload it.' } : x))));
    }
  };
  const dropFile = (localId: string) => {
    const f = pending.find((x) => x.localId === localId);
    setPending((p) => p.filter((x) => x.localId !== localId));
    if (f?.attachment) void chatApi.removeFile(f.attachment.id).catch(() => undefined);
  };
  const readyIds = pending.filter((f) => f.status === 'ready').map((f) => f.attachment!.id);

  // ---- a large payload (JSON, logs, XML, CSV, a very long text) is offered as a file instead of a wall of text
  const navigate = useNavigate();
  const [payload, setPayload] = useState<PayloadDraft | null>(null);
  const [payloadBusy, setPayloadBusy] = useState(false);
  const offerAsFile = (raw: string, caption: string) => {
    const p = canAttach ? detectPayload(raw) : null;
    if (!p) return false;
    const secrets = findSecrets(p.text);
    setPayload({ ...p, name: payloadFileName(p.kind, conversation.name), secrets, mask: secrets.length > 0, caption });
    return true;
  };
  const clearBox = () => { setText(''); setIsEmpty(true); if (box.current) box.current.innerHTML = ''; drafts.delete(draftKey); };
  const sendPayloadAsFile = async () => {
    if (!payload || payloadBusy || uploading) return;
    const content = payload.mask ? maskSecrets(payload.text) : payload.text;
    const name = cleanFileName(payload.name, payload.kind);
    const caption = (payload.caption ? `${payload.caption}\n` : '') + text.trim();
    setPayloadBusy(true);
    try {
      const att = await chatApi.uploadFile(id, new File([content], name, { type: KIND_MIME[payload.kind] }));
      setPayload(null);
      clearBox();
      send.mutate({ body: caption.trim(), ids: [...readyIds, att.id] });
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not upload the file.', 'error'); }
    finally { setPayloadBusy(false); }
  };
  const sendPayloadAsText = () => {
    if (!payload) return;
    const body = [payload.caption, payload.raw, text.trim()].filter(Boolean).join('\n');
    if (body.length > MAX_LENGTH) { toast(`A message can be up to ${MAX_LENGTH.toLocaleString()} characters — send it as a file.`, 'info'); return; }
    setPayload(null);
    clearBox();
    send.mutate({ body, ids: readyIds });
  };
  const payloadToVault = () => {
    if (!payload) return;
    const title = cleanFileName(payload.name, payload.kind).replace(/\.[^.]+$/, '');
    // Handed over in memory only (never the clipboard or the address); nothing is sent to the chat.
    handToVault(title, payload.text);
    toast('Opened a new Vault item with this payload. Nothing was sent.', 'info');
    setPayload(null);
    navigate('/library/vault?new=item');
  };
  const uploading = pending.some((f) => f.status === 'uploading');

  // ---- @mentions (project chats): typing @ and a few letters suggests the people in the chat; picking one puts a chip in the text.
  const [mention, setMention] = useState<{ query: string; index: number } | null>(null);
  const mentionAt = useRef<{ node: Text; start: number; end: number } | null>(null);
  const suggestions = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return mentionable
      .filter((p) => p.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [mention, mentionable]);
  const closeMention = () => { mentionAt.current = null; setMention(null); };

  /** Looks at the text just before the caret: "@" (at the start or after a space) followed by the letters typed so far. */
  const detectMention = () => {
    if (!mentionable.length) return;
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    if (!sel || !sel.isCollapsed || !node || node.nodeType !== Node.TEXT_NODE || !box.current?.contains(node) || (node.parentElement?.closest('.mention-chip'))) { closeMention(); return; }
    const before = (node.textContent ?? '').slice(0, sel.anchorOffset);
    const m = /(^|[\s\u00a0])@([^\s@]{0,30})$/.exec(before);
    if (!m) { closeMention(); return; }
    mentionAt.current = { node: node as Text, start: sel.anchorOffset - m[2].length - 1, end: sel.anchorOffset };
    setMention((cur) => ({ query: m[2], index: cur && cur.query === m[2] ? cur.index : 0 }));
  };

  const pickMention = (p: { userId: string; name: string }) => {
    const at = mentionAt.current;
    if (!at) return;
    const range = document.createRange();
    range.setStart(at.node, at.start);
    range.setEnd(at.node, at.end);
    range.deleteContents();
    const holder = document.createElement('div');
    holder.innerHTML = mentionChipHtml(p.name, p.userId);
    const space = document.createTextNode('\u00a0');
    range.insertNode(space);
    range.insertNode(holder.firstChild!);
    const caret = document.createRange();
    caret.setStart(space, 1);
    caret.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(caret);
    closeMention();
    box.current?.focus();
    sync();
  };

  useEffect(() => { box.current?.focus(); }, [replyTo, editing]);
  // Seeds the box once with real <b>/<i>/<u> markup instead of raw ** symbols. Only runs on mount — this component
  // remounts fresh (see its `key` at the call site) whenever the conversation or edit target changes, and afterwards
  // the box's content is owned by the browser (typing, execCommand), never re-rendered from React state.
  useEffect(() => {
    if (box.current) box.current.innerHTML = markdownToHtml(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useMutation({
    mutationFn: (v: { body: string; ids: string[] }) => (editing ? chatApi.edit(editing.id, v.body) : chatApi.send(id, v.body, replyTo?.id, v.ids, threadRootId)),
    onSuccess: (m, v) => { drafts.delete(draftKey); setPending([]); onSent(m); if (!editing) offerReminderAfterSend(v.body); },
    onError: (e, v) => {
      setText(v.body);
      if (box.current) { box.current.innerHTML = markdownToHtml(v.body); setIsEmpty(!v.body); }
      toast(e instanceof ApiError ? e.message : 'The message could not be sent.', 'error');
    },
  });

  /** Replaces what is in the box (a rewritten or translated draft, a suggested reply). */
  const setBox = (value: string) => {
    if (!box.current) return;
    box.current.innerHTML = markdownToHtml(value);
    box.current.focus();
    const sel = window.getSelection(); const r = document.createRange(); r.selectNodeContents(box.current); r.collapse(false); sel?.removeAllRanges(); sel?.addRange(r);
    sync();
  };
  useEffect(() => {
    const onInsert = (e: Event) => {
      const d = (e as CustomEvent<{ conversationId: string; text: string; threadRootId: string | null }>).detail;
      if (d.conversationId !== id || (d.threadRootId ?? null) !== (threadRootId ?? null) || editing) return;
      setBox(d.text);
    };
    window.addEventListener('chat:insert', onInsert);
    return () => window.removeEventListener('chat:insert', onInsert);
  });
  const rewrite = async (action: string, language?: string) => {
    setAiOpen(false);
    const body = text.trim();
    if (!body) return;
    setAiBusy(true);
    try { setBox((await chatApi.transform(plainText(body), action, language)).text); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'The AI could not rewrite it right now.', 'error'); }
    setAiBusy(false);
  };
  const voice = useVoiceRecorder(id, (attachmentId) => send.mutate({ body: '', ids: [attachmentId] }));

  const submit = () => {
    if (payload) { void sendPayloadAsFile(); return; }
    const body = text.trim();
    // A payload typed or dropped into the box (not pasted): ask before sending it as a wall of text.
    if (body && !editing && offerAsFile(plainText(body), '')) { clearBox(); return; }
    if ((!body && readyIds.length === 0) || send.isPending || uploading || body.length > MAX_LENGTH) return;
    setText('');
    setIsEmpty(true);
    if (box.current) box.current.innerHTML = '';
    send.mutate({ body, ids: readyIds });
  };

  /** Whether the toolbar buttons should show as "on" right now — reflects the mark(s) around the cursor or selection,
   *  the same way the bold/italic/underline buttons in a real word processor track where you're typing. */
  const updateMarks = () => setMarks({ bold: document.queryCommandState('bold'), italic: document.queryCommandState('italic'), underline: document.queryCommandState('underline') });

  /** Re-reads the box's live DOM (the source of truth once it's mounted — see the effect above) into the plain-text
   *  body used for drafts, the character count and sending. */
  const sync = () => {
    const el = box.current;
    if (!el) return;
    const value = domToBody(el);
    setText(value);
    setIsEmpty(!value);
    updateMarks();
    if (!editing) { if (value) drafts.set(draftKey, value); else drafts.delete(draftKey); }
    if (value && Date.now() - lastTyping.current > 2500) { lastTyping.current = Date.now(); sendTyping(id); }
    detectMention();
  };

  const applyMark = (cmd: 'bold' | 'italic' | 'underline') => {
    box.current?.focus();
    document.execCommand('styleWithCSS', false, 'false');   // keeps output as <b>/<i>/<u> rather than inline styles
    document.execCommand(cmd);
    sync();
  };
  const insertEmoji = (emoji: string) => {
    box.current?.focus();
    document.execCommand('insertText', false, emoji);
    sync();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (mention && suggestions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setMention({ ...mention, index: (mention.index + step + suggestions.length) % suggestions.length });
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pickMention(suggestions[Math.min(mention.index, suggestions.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMention(); return; }
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); applyMark('bold'); return; }
      if (k === 'i') { e.preventDefault(); applyMark('italic'); return; }
      if (k === 'u') { e.preventDefault(); applyMark('underline'); return; }
    }
    if (payload && e.key === 'Escape') { e.stopPropagation(); setPayload(null); return; }
    if (e.key === 'Enter' && !e.shiftKey && !composing.current && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
    else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); document.execCommand('insertLineBreak'); sync(); }
    else if (e.key === 'Escape') {
      if (emojiOpen) { e.stopPropagation(); setEmojiOpen(false); }
      else if (replyTo || editing) {
        e.stopPropagation();
        if (editing) { setText(''); setIsEmpty(true); if (box.current) box.current.innerHTML = ''; }
        onCancel();
      }
    }
  };

  /** Pasted content keeps only its text — no foreign fonts, colors or styles carried in from elsewhere. */
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const pictures = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (pictures.length > 0 && canAttach) { e.preventDefault(); addFiles(pictures); return; }
    e.preventDefault();
    const pasted = e.clipboardData.getData('text/plain');
    // A big JSON / log / XML / CSV paste does not go into the box: the suggestion offers it as a file, with what is typed as the caption.
    if (!editing && !payload && offerAsFile(pasted, text.trim())) { clearBox(); return; }
    document.execCommand('insertText', false, pasted);
    sync();
  };

  const over = text.length > MAX_LENGTH - 500;
  const ready = (!!text.trim() || readyIds.length > 0 || !!payload) && !send.isPending && !uploading && text.length <= MAX_LENGTH;
  return (
    <div className={`composer ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => { if (canAttach && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { if (!canAttach) return; e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}>
      {mention && suggestions.length > 0 && (
        <ul className="mention-list" role="listbox" aria-label="Mention someone">
          {suggestions.map((p, i) => (
            <li key={p.userId} role="option" aria-selected={i === mention.index} className={i === mention.index ? 'active' : ''}
              onMouseDown={(e) => { e.preventDefault(); pickMention(p); }} onMouseEnter={() => setMention({ ...mention, index: i })}>
              <Avatar name={p.name} size="sm" userId={p.userId} /><span>{p.name}</span>
            </li>
          ))}
        </ul>
      )}
      {(replyTo || editing) && (
        <div className="composer-ctx">
          <Icon name={editing ? 'edit' : 'undo'} size={14} />
          <div><b>{editing ? 'Editing message' : `Replying to ${replyTo!.senderName ?? 'a message'}`}</b>{!editing && <span>{plainText(replyTo!.body).slice(0, 120)}</span>}</div>
          <button className="btn-icon" onClick={() => { if (editing) setText(''); onCancel(); }} aria-label="Cancel"><Icon name="close" size={14} /></button>
        </div>
      )}
      {formatting && (
        <div className="composer-tools" role="toolbar" aria-label="Formatting">
          <button type="button" className={`btn-icon sm ${marks.bold ? 'on' : ''}`} onMouseDown={keepFocus} onClick={() => applyMark('bold')}
            aria-label="Bold" aria-pressed={marks.bold} title="Bold (Ctrl+B)"><Icon name="bold" size={15} /></button>
          <button type="button" className={`btn-icon sm ${marks.italic ? 'on' : ''}`} onMouseDown={keepFocus} onClick={() => applyMark('italic')}
            aria-label="Italic" aria-pressed={marks.italic} title="Italic (Ctrl+I)"><Icon name="italic" size={15} /></button>
          <button type="button" className={`btn-icon sm ${marks.underline ? 'on' : ''}`} onMouseDown={keepFocus} onClick={() => applyMark('underline')}
            aria-label="Underline" aria-pressed={marks.underline} title="Underline (Ctrl+U)"><Icon name="underline" size={15} /></button>
          <span className="composer-tools-hint">Enter sends · Shift+Enter new line{editing || replyTo ? ' · Esc cancels' : ''}</span>
        </div>
      )}
      {payload && <PayloadSuggestion draft={payload} busy={payloadBusy || send.isPending} canText={payload.raw.length + payload.caption.length + text.length < MAX_LENGTH}
        onChange={setPayload} onFile={() => void sendPayloadAsFile()} onText={sendPayloadAsText} onVault={payloadToVault} onDismiss={() => setPayload(null)} />}
      {pending.length > 0 && (
        <ul className="composer-files" aria-label="Files to send">
          {pending.map((f) => (
            <li key={f.localId} className={f.status}>
              <Icon name="paperclip" size={13} /><span title={f.error ?? f.name}>{f.name}</span><em>{f.status === 'uploading' ? 'uploading…' : f.status === 'error' ? (f.error ?? 'failed') : fileSize(f.size)}</em>
              <button type="button" className="btn-icon sm" onClick={() => dropFile(f.localId)} aria-label={`Remove ${f.name}`}><Icon name="close" size={12} /></button>
            </li>
          ))}
        </ul>
      )}
      {voice.state !== 'idle' && (
        <div className="voice-rec" role="status">
          {voice.state === 'recording' ? <><span className="aid-dot" aria-hidden="true" /> Recording {Math.floor(voice.secs / 60)}:{String(voice.secs % 60).padStart(2, '0')}
            <button type="button" className="btn btn-ghost btn-sm" onClick={voice.cancel}>Cancel</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void voice.finish()}><Icon name="send" size={13} /> Send</button></>
            : <><Spinner /> Sending and transcribing…</>}
        </div>
      )}
      <div className="composer-row">
        <div className="composer-pill">
          {!editing && !threadRootId && (
            <div className="emoji-wrap" ref={plusRef}>
              <button type="button" className={`btn-icon pill-btn ${plusOpen ? 'on' : ''}`} onMouseDown={keepFocus} onClick={() => setPlusOpen((v) => !v)} aria-label="More: poll, send later" aria-expanded={plusOpen} title="Poll, send later"><Icon name="plus" size={17} /></button>
              <Popover open={plusOpen} onClose={() => setPlusOpen(false)} anchorRef={plusRef} side="top" align="start" focusOnOpen={false} restoreFocus={false}>
                <div className="more-pop up" role="menu" aria-label="More">
                  {onPoll && <button type="button" role="menuitem" onClick={() => { setPlusOpen(false); onPoll(); }}><Icon name="chart" size={15} />Poll</button>}
                  <button type="button" role="menuitem" disabled={!text.trim()} onClick={() => { setPlusOpen(false); setLater(true); }}><Icon name="clock" size={15} />Send later{!text.trim() ? ' (write first)' : ''}</button>
                  {talk && <button type="button" role="menuitem" aria-pressed={formatting} onClick={() => { setPlusOpen(false); setFormatting((v) => !v); }}><span className="aa" aria-hidden="true">Aa</span>Formatting</button>}
                  {talk && canAttach && voice.supported && <button type="button" role="menuitem" disabled={voice.state !== 'idle'} onClick={() => { setPlusOpen(false); void voice.start(); }}><Icon name="mic" size={15} />Voice note</button>}
                </div>
              </Popover>
            </div>
          )}
          {!editing && (
            <>
              <input ref={picker} type="file" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
              <button type="button" className="btn-icon pill-btn" onMouseDown={keepFocus} disabled={pending.length >= MAX_FILES}
                onClick={() => (canAttach ? picker.current?.click() : toast('Sending files in chat is not part of your plan. You can upgrade it under Settings → Billing.', 'info'))}
                aria-label="Attach a file" title={canAttach ? 'Attach files or pictures' : 'Files in chat are not part of your plan'}><Icon name="paperclip" size={17} /></button>
            </>
          )}
          <div ref={box} contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Write a message"
            className={`composer-editable ${isEmpty ? 'is-empty' : ''}`} enterKeyHint="send"
            data-placeholder={placeholder ?? (conversation.type === 'Project' ? 'Message the team · @ to mention' : 'Message')}
            onInput={sync} onKeyDown={onKeyDown} onPaste={onPaste} onBlur={() => window.setTimeout(closeMention, 120)}
            onKeyUp={(e) => { updateMarks(); if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') detectMention(); }}
            onMouseUp={() => { updateMarks(); detectMention(); }}
            onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
          <div className="emoji-wrap" ref={aiRef}>
            {isEmpty && draftReply && !editing && talk
              ? <button type="button" className="talk-draft" onMouseDown={keepFocus} disabled={drafting}
                  onClick={async () => { setDrafting(true); try { const t = await draftReply(); if (t) insertIntoComposer(conversation.id, t, threadRootId); } finally { setDrafting(false); } }}
                  aria-label="Draft a reply with AI" title="Draft a reply with AI">{drafting ? <Spinner /> : <span className="talk-orb sm" aria-hidden="true" />}Draft reply</button>
              : isEmpty && draftReply && !editing
              ? <button type="button" className="btn-icon pill-btn ai" onMouseDown={keepFocus} disabled={drafting}
                  onClick={async () => { setDrafting(true); try { const t = await draftReply(); if (t) insertIntoComposer(conversation.id, t, threadRootId); } finally { setDrafting(false); } }}
                  aria-label="Draft a reply with AI" title="Draft a reply with AI">{drafting ? <Spinner /> : <Icon name="sparkle" size={16} />}</button>
              : <button type="button" className={`btn-icon pill-btn ai ${aiOpen ? 'on' : ''}`} onMouseDown={keepFocus} onClick={() => setAiOpen((v) => !v)} disabled={isEmpty || aiBusy}
              aria-label="Rewrite or translate with AI" aria-expanded={aiOpen} title="Rewrite or translate with AI">{aiBusy ? <Spinner /> : <Icon name="sparkle" size={16} />}</button>}
            <Popover open={aiOpen} onClose={() => setAiOpen(false)} anchorRef={aiRef} side="top" align="start" focusOnOpen={false} restoreFocus={false}>
              <div className="more-pop up" role="menu" aria-label="Rewrite with AI">
                {COMPOSER_AI.map((a) => <button key={a.label} type="button" role="menuitem" onMouseDown={keepFocus} onClick={() => void rewrite(a.id, a.language)}>{a.label}</button>)}
              </div>
            </Popover>
          </div>
          {!talk && <button type="button" className={`btn-icon pill-btn ${formatting ? 'on' : ''}`} onMouseDown={keepFocus} onClick={() => setFormatting((v) => !v)}
            aria-label="Formatting" aria-pressed={formatting} title="Formatting"><span className="aa">Aa</span></button>}
          {!talk && <div className="emoji-wrap" ref={emojiRef}>
            <button type="button" className={`btn-icon pill-btn ${emojiOpen ? 'on' : ''}`} onMouseDown={keepFocus} onClick={() => setEmojiOpen((v) => !v)}
              aria-label="Add emoji" aria-expanded={emojiOpen} aria-haspopup="true" title="Emoji"><Icon name="smile" size={17} /></button>
            <Popover open={emojiOpen} onClose={() => setEmojiOpen(false)} anchorRef={emojiRef} side="top" align="end" focusOnOpen={false} restoreFocus={false}>
              <div className="emoji-popover" role="menu" aria-label="Emoji">
                {COMMON_EMOJI.map((emoji) => (
                  <button key={emoji} type="button" className="emoji-item" role="menuitem" onMouseDown={keepFocus}
                    onClick={() => { insertEmoji(emoji); setEmojiOpen(false); }} aria-label={emoji}>{emoji}</button>
                ))}
              </div>
            </Popover>
          </div>}
        </div>
        {isEmpty && !editing && pending.length === 0 && !talk && canAttach && voice.supported && voice.state === 'idle'
          ? <button className="send-btn ready mic" onMouseDown={keepFocus} onClick={() => void voice.start()} aria-label="Record a voice note" title="Record a voice note (Telugu, Hindi or English)"><Icon name="mic" size={17} /></button>
          : <button className={`send-btn ${ready ? 'ready' : ''}`} onMouseDown={keepFocus} onClick={submit} disabled={!ready} aria-label={editing ? 'Save' : 'Send'}>
              {send.isPending ? <Spinner /> : <Icon name={editing ? 'tick' : talk ? 'arrowUp' : 'send'} size={17} />}
            </button>}
      </div>
      {later && <ScheduleDialog conversation={conversation} body={text.trim()} threadRootId={threadRootId} onClose={() => setLater(false)}
        onScheduled={() => { setText(''); setIsEmpty(true); if (box.current) box.current.innerHTML = ''; drafts.delete(draftKey); }} />}
      {over && <div className="composer-hint"><span className={text.length > MAX_LENGTH ? 'over' : ''}>{text.length.toLocaleString()} / {MAX_LENGTH.toLocaleString()}</span></div>}
    </div>
  );
}

// ------------------------------------------------------------------ shared bits
export function ConversationAvatar({ conversation, status }: { conversation: Conversation; status: PresenceStatus }) {
  if (conversation.type === 'Project') return <span className="avatar group-avatar" title={conversation.name}><Icon name="folder" size={16} /></span>;
  if (conversation.type === 'Group') return <span className="avatar group-avatar" title={conversation.name}><Icon name="users" size={16} /></span>;
  return <span className="avatar-wrap"><Avatar name={conversation.name} userId={conversation.otherUserId ?? undefined} /><PresenceDot status={status} /></span>;
}
