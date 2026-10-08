import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { chatApi } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import type { ChatAttachment, ChatMessage, ChatThread, Conversation } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Avatar, PageLoader, Spinner } from '../../components/ui';
import { queryClient, useAuth, useEntitlement, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { COMMON_EMOJI, dayKey, dayLabel, domToBody, markdownToHtml, mentionChipHtml, mentionsUser, plainText, renderBody, timeOf } from './chatFormat';
import { chatKeys, useChat, useTypingNames } from './chatStore';
import { sendTyping } from './ChatRealtime';
import { openReminderComposer } from '../reminders/store';

const MAX_LENGTH = 4000;
const MAX_FILES = 5;
const REACTIONS = ['👍', '❤️', '😂', '🎉', '🙏', '👀', '✅', '🚀'];
const GROUP_WITHIN_MS = 5 * 60_000;
const drafts = new Map<string, string>();   // what was typed and not sent, per conversation, until the tab is closed

/** Closes a popover (the emoji picker) on an outside click. */
function useClickOutside(ref: RefObject<HTMLElement | null>, onOutside: () => void) {
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onOutside(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  });
}

/** Keeps the composer's selection intact when a toolbar button is clicked (mousedown would otherwise blur it first). */
const keepFocus = (e: SyntheticEvent) => e.preventDefault();

// ------------------------------------------------------------------ the thread of one conversation
/** `variant="panel"` is the project chat in its slide-in panel: a close button instead of back / details, and no navigating away when access is lost. */
export function Thread({ conversation, onBack, onInfo, infoOpen = false, onFiles, filesOpen = false, variant = 'page', onClose }: {
  conversation: Conversation; onBack: () => void; onInfo?: () => void; infoOpen?: boolean; onFiles?: () => void; filesOpen?: boolean;
  variant?: 'page' | 'panel'; onClose?: () => void;
}) {
  const wid = useWorkspaceId()!;
  const me = useAuth((s) => s.ctx!.user.id);
  const navigate = useNavigate();
  const id = conversation.id;
  const online = useChat((s) => s.online);
  const setOpen = useChat((s) => s.setOpenConversation);
  const typingNames = useTypingNames(id);

  const thread = useQuery({ queryKey: chatKeys.thread(wid, id), queryFn: () => chatApi.messages(id), staleTime: 30_000 });
  const items = useMemo(() => thread.data?.items ?? [], [thread.data]);
  const projectId = conversation.projectId;
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [newBelow, setNewBelow] = useState(0);

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
    else navigate('/chat', { replace: true });
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
  const isOnline = (userId: string, fallback: boolean) => online[userId] ?? fallback;
  const onlineCount = others.filter((m) => isOnline(m.userId, m.online)).length;
  const status = typingNames.length
    ? <span className="typing-text">{typingNames.length === 1 ? `${typingNames[0]} is typing` : `${typingNames.slice(0, 2).join(' and ')} are typing`}<i className="dots"><b /><b /><b /></i></span>
    : conversation.type === 'Direct'
      ? (other && isOnline(other.userId, other.online) ? <span className="status-on">Active now</span> : 'Offline')
      : `${conversation.members.length} members${onlineCount ? ` · ${onlineCount} online` : ''}`;

  // A message I sent counts as read once everyone else in the conversation has read past it (the recipient in a direct
  // chat, or everyone in a group — the same rule WhatsApp-style double ticks use).
  const lastMineId = [...items].reverse().find((m) => m.kind === 'User' && m.senderId === me)?.id;
  const isRead = (m: ChatMessage) => others.length > 0 && others.every((o) => utcMs(o.lastReadAt) >= utcMs(m.createdAt));

  return (
    <div className="chat-thread">
      <header className="chat-head">
        {variant === 'page' && <button className="btn-icon chat-back" onClick={onBack} aria-label="Back to conversations"><Icon name="arrowLeft" /></button>}
        <ConversationAvatar conversation={conversation} online={other ? isOnline(other.userId, other.online) : false} />
        <div className="chat-head-text">
          <h2>{conversation.name}</h2>
          <div className="chat-sub" aria-live="polite">{status}</div>
        </div>
        {variant === 'page' && (
          <>
            <button className={`btn-icon chat-head-action ${filesOpen ? 'on' : ''}`} onClick={onFiles} aria-label="Files shared in this conversation" aria-pressed={filesOpen} title="Files"><Icon name="folder" size={17} /></button>
            <button className={`btn-icon chat-head-action ${infoOpen ? 'on' : ''}`} onClick={onInfo} aria-label="Conversation details" aria-pressed={infoOpen} title="Details"><Icon name="info" size={17} /></button>
          </>
        )}
        {variant === 'panel' && <button className="btn-icon" onClick={onClose ?? onBack} aria-label="Close chat" title="Close"><Icon name="close" /></button>}
      </header>

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
          return (
            <div key={m.id} className="chat-row-wrap">
              {newDay && <div className="day-sep"><span>{dayLabel(m.createdAt)}</span></div>}
              {m.kind === 'System'
                ? <div className="sys-line" data-msg={m.id}>{m.body}</div>
                : <MessageRow m={m} mine={mine} grouped={grouped} showName={conversation.type !== 'Direct'} canModerate={conversation.canManage}
                    ticks={conversation.type !== 'Project'} aboutMe={!mine && mentionsUser(m.body, me)}
                    read={mine && isRead(m)} showStatus={mine && m.id === lastMineId}
                    onReply={() => { setEditing(null); setReplyTo(m); }}
                    onEdit={() => { setReplyTo(null); setEditing(m); }} onDelete={() => void remove(m)} onJump={jumpTo} />}
            </div>
          );
        })}
      </div>

      {newBelow > 0 && <button className="new-below" onClick={() => toBottom(true)}><Icon name="chevronD" size={14} /> {newBelow} new {newBelow === 1 ? 'message' : 'messages'}</button>}

      <Composer key={`${id}:${editing?.id ?? ''}`} conversation={conversation} replyTo={replyTo} editing={editing}
        mentionable={conversation.type === 'Project' ? conversation.members.filter((m) => m.userId !== me).map((m) => ({ userId: m.userId, name: m.name })) : []}
        onCancel={() => { setReplyTo(null); setEditing(null); }}
        onSent={(m) => {
          setReplyTo(null); setEditing(null);
          queryClient.setQueryData<ChatThread>(chatKeys.thread(wid, id), (old) => {
            if (!old) return old;
            return old.items.some((x) => x.id === m.id) ? { ...old, items: old.items.map((x) => (x.id === m.id ? m : x)) } : { ...old, items: [...old.items, m] };
          });
          void queryClient.invalidateQueries({ queryKey: chatKeys.conversations(wid) });
        }} />
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
  return (
    <button type="button" className="chat-file" onClick={() => void save()} disabled={busy} title={`Download ${file.fileName}`}>
      <span className="chat-file-icon"><Icon name="paperclip" size={16} /></span>
      <span className="chat-file-meta"><b>{file.fileName}</b><em>{fileSize(file.sizeBytes)}</em></span>
      {busy ? <Spinner /> : <Icon name="download" size={14} />}
    </button>
  );
}

function MessageRow({ m, mine, grouped, showName, canModerate, ticks, aboutMe, read, showStatus, onReply, onEdit, onDelete, onJump }: {
  m: ChatMessage; mine: boolean; grouped: boolean; showName: boolean; canModerate: boolean; ticks: boolean; aboutMe: boolean; read: boolean; showStatus: boolean;
  onReply: () => void; onEdit: () => void; onDelete: () => void; onJump: (id: string) => void;
}) {
  const wid = useWorkspaceId();
  const [picking, setPicking] = useState(false);
  const pickRef = useRef<HTMLDivElement>(null);
  useClickOutside(pickRef, () => setPicking(false));
  /** Adds or takes back the person's own reaction; the answer is the message as it now stands, written into the open conversation at once. */
  const onReact = (emoji: string, on: boolean) => {
    if (!wid) return;
    (on ? chatApi.react(m.id, emoji) : chatApi.unreact(m.id, emoji))
      .then((updated) => queryClient.setQueryData<ChatThread>(chatKeys.thread(wid, m.conversationId), (old) => old && { ...old, items: old.items.map((x) => (x.id === updated.id ? updated : x)) }))
      .catch((e) => toast(e instanceof ApiError ? e.message : 'Could not save your reaction.', 'error'));
  };
  return (
    <div className={`msg ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''} ${aboutMe ? 'mentions-me' : ''}`} data-msg={m.id} ref={pickRef}>
      {!mine && (grouped ? <span className="avatar-gap" /> : <Avatar name={m.senderName} size="sm" />)}
      <div className="msg-col">
        {!grouped && (
          <div className="msg-meta">
            {!mine && showName && <strong>{m.senderName ?? 'Former member'}</strong>}
            <time dateTime={m.createdAt}>{timeOf(m.createdAt)}</time>
            {ticks && mine && !m.isDeleted && <Ticks read={read} />}
            {aboutMe && !m.isDeleted && <span className="mention-flag" title="You were mentioned">@ You were mentioned</span>}
          </div>
        )}
        <div className="bubble" title={grouped ? timeOf(m.createdAt) : undefined}>
          {m.replyTo && !m.isDeleted && (
            <button className="reply-quote" onClick={() => onJump(m.replyTo!.id)} type="button">
              <b>{m.replyTo.senderName ?? 'Former member'}</b>
              <span>{m.replyTo.isDeleted ? 'Message deleted' : m.replyTo.snippet}</span>
            </button>
          )}
          {m.isDeleted
            ? <em className="deleted">This message was deleted</em>
            : <>
                {m.body && <div className="msg-text">{renderBody(m.body)}{m.editedAt && <span className="edited"> (edited)</span>}</div>}
                {(m.attachments?.length ?? 0) > 0 && (
                  <div className="chat-files">{m.attachments!.map((f) => (f.isImage ? <ChatImage key={f.id} file={f} /> : <ChatFile key={f.id} file={f} />))}</div>
                )}
              </>}
        </div>
        {!m.isDeleted && (m.reactions?.length ?? 0) > 0 && (
          <div className="chat-reactions">
            {m.reactions!.map((r) => (
              <button key={r.emoji} type="button" className={`react-chip ${r.mine ? 'on' : ''}`} onClick={() => onReact(r.emoji, !r.mine)}
                title={r.names.join(', ')} aria-pressed={r.mine} aria-label={`${r.emoji} ${r.count}${r.mine ? ', you reacted' : ''}`}>{r.emoji}<span>{r.count}</span></button>
            ))}
          </div>
        )}
        {/* When messages are grouped the meta row (and its ticks) is hidden; still show the status under the very last one you sent. */}
        {ticks && grouped && mine && showStatus && !m.isDeleted && <div className="msg-status"><Ticks read={read} /></div>}
        {!m.isDeleted && (
          <div className="msg-actions" role="group" aria-label="Message actions">
            <div className="react-wrap">
              <button className="btn-icon" onClick={() => setPicking((v) => !v)} aria-label="Add reaction" aria-expanded={picking} title="React"><Icon name="smile" size={14} /></button>
              {picking && (
                <div className="react-pop" role="menu" aria-label="Reactions">
                  {REACTIONS.map((emoji) => (
                    <button key={emoji} type="button" role="menuitem" className="emoji-item" aria-label={emoji}
                      onClick={() => { setPicking(false); onReact(emoji, !(m.reactions?.find((r) => r.emoji === emoji)?.mine)); }}>{emoji}</button>
                  ))}
                </div>
              )}
            </div>
            <button className="btn-icon" onClick={onReply} aria-label="Reply" title="Reply"><Icon name="undo" size={14} /></button>
            <button className="btn-icon" aria-label="Remind me about this" title="Remind me about this"
              onClick={() => openReminderComposer({ subject: { type: 'ChatMessage', id: m.id, title: m.body.replace(/\s+/g, ' ').slice(0, 117) + (m.body.length > 117 ? '…' : ''), key: 'Message' } })}><Icon name="alarm" size={14} /></button>
            {mine && <button className="btn-icon" onClick={onEdit} aria-label="Edit" title="Edit"><Icon name="edit" size={14} /></button>}
            {(mine || canModerate) && <button className="btn-icon danger" onClick={onDelete} aria-label="Delete" title="Delete"><Icon name="trash" size={14} /></button>}
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ writing
function Composer({ conversation, replyTo, editing, mentionable, onCancel, onSent }: {
  conversation: Conversation; replyTo: ChatMessage | null; editing: ChatMessage | null; mentionable: { userId: string; name: string }[];
  onCancel: () => void; onSent: (m: ChatMessage) => void;
}) {
  const id = conversation.id;
  const [text, setText] = useState(() => editing?.body ?? drafts.get(id) ?? '');
  const [isEmpty, setIsEmpty] = useState(() => !text);
  const [marks, setMarks] = useState({ bold: false, italic: false, underline: false });
  const [emojiOpen, setEmojiOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const lastTyping = useRef(0);
  const composing = useRef(false);
  useClickOutside(emojiRef, () => setEmojiOpen(false));

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
    mutationFn: (v: { body: string; ids: string[] }) => (editing ? chatApi.edit(editing.id, v.body) : chatApi.send(id, v.body, replyTo?.id, v.ids)),
    onSuccess: (m) => { drafts.delete(id); setPending([]); onSent(m); },
    onError: (e, v) => {
      setText(v.body);
      if (box.current) { box.current.innerHTML = markdownToHtml(v.body); setIsEmpty(!v.body); }
      toast(e instanceof ApiError ? e.message : 'The message could not be sent.', 'error');
    },
  });

  const submit = () => {
    const body = text.trim();
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
    if (!editing) { if (value) drafts.set(id, value); else drafts.delete(id); }
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
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    sync();
  };

  const over = text.length > MAX_LENGTH - 500;
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
              <Avatar name={p.name} size="sm" /><span>{p.name}</span>
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
      <div className="composer-tools" role="toolbar" aria-label="Formatting">
        <button type="button" className={`btn-icon sm ${marks.bold ? 'on' : ''}`} onMouseDown={keepFocus} onClick={() => applyMark('bold')}
          aria-label="Bold" aria-pressed={marks.bold} title="Bold (Ctrl+B)"><Icon name="bold" size={15} /></button>
        <button type="button" className={`btn-icon sm ${marks.italic ? 'on' : ''}`} onMouseDown={keepFocus} onClick={() => applyMark('italic')}
          aria-label="Italic" aria-pressed={marks.italic} title="Italic (Ctrl+I)"><Icon name="italic" size={15} /></button>
        <button type="button" className={`btn-icon sm ${marks.underline ? 'on' : ''}`} onMouseDown={keepFocus} onClick={() => applyMark('underline')}
          aria-label="Underline" aria-pressed={marks.underline} title="Underline (Ctrl+U)"><Icon name="underline" size={15} /></button>
        {!editing && (
          <>
            <input ref={picker} type="file" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
            <button type="button" className="btn-icon sm" onMouseDown={keepFocus} disabled={pending.length >= MAX_FILES}
              onClick={() => (canAttach ? picker.current?.click() : toast('Sending files in chat is not part of your plan. You can upgrade it under Settings → Billing.', 'info'))}
              aria-label="Attach a file" title={canAttach ? 'Attach files or pictures' : 'Files in chat are not part of your plan'}><Icon name="paperclip" size={15} /></button>
          </>
        )}
        <div className="emoji-wrap" ref={emojiRef}>
          <button type="button" className={`btn-icon sm ${emojiOpen ? 'on' : ''}`} onMouseDown={keepFocus} onClick={() => setEmojiOpen((v) => !v)}
            aria-label="Add emoji" aria-expanded={emojiOpen} aria-haspopup="true" title="Emoji"><Icon name="smile" size={15} /></button>
          {emojiOpen && (
            <div className="emoji-popover" role="menu" aria-label="Emoji">
              {COMMON_EMOJI.map((emoji) => (
                <button key={emoji} type="button" className="emoji-item" role="menuitem" onMouseDown={keepFocus}
                  onClick={() => { insertEmoji(emoji); setEmojiOpen(false); }} aria-label={emoji}>{emoji}</button>
              ))}
            </div>
          )}
        </div>
      </div>
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
      <div className="composer-row">
        <div ref={box} contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Write a message"
          className={`composer-editable ${isEmpty ? 'is-empty' : ''}`}
          data-placeholder={conversation.type === 'Project' ? `Message the ${conversation.name} team — type @ to mention someone` : `Message ${conversation.name}`}
          onInput={sync} onKeyDown={onKeyDown} onPaste={onPaste} onBlur={() => window.setTimeout(closeMention, 120)}
          onKeyUp={(e) => { updateMarks(); if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') detectMention(); }}
          onMouseUp={() => { updateMarks(); detectMention(); }}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
        <button className="btn btn-primary send-btn" onClick={submit} disabled={(!text.trim() && readyIds.length === 0) || send.isPending || uploading || text.length > MAX_LENGTH} aria-label={editing ? 'Save' : 'Send'}>
          {send.isPending ? <Spinner /> : <Icon name={editing ? 'tick' : 'send'} size={16} />}
        </button>
      </div>
      <div className="composer-hint">
        <span>Enter to {editing ? 'save' : 'send'} · Shift+Enter for a new line{editing || replyTo ? ' · Esc to cancel' : ''}</span>
        {over && <span className={text.length > MAX_LENGTH ? 'over' : ''}>{text.length.toLocaleString()} / {MAX_LENGTH.toLocaleString()}</span>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ shared bits
export function ConversationAvatar({ conversation, online }: { conversation: Conversation; online: boolean }) {
  if (conversation.type === 'Project') return <span className="avatar group-avatar" title={conversation.name}><Icon name="folder" size={16} /></span>;
  if (conversation.type === 'Group') return <span className="avatar group-avatar" title={conversation.name}><Icon name="users" size={16} /></span>;
  return <span className="avatar-wrap"><Avatar name={conversation.name} />{online && <i className="presence-dot" aria-label="Online" />}</span>;
}
