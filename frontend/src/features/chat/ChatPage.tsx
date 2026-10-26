import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { chatApi } from '../../api/endpoints';
import type { Conversation } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, PageLoader } from '../../components/ui';
import { useDebounced } from '../../lib/hooks';
import { useAuth, useIsPersonal, useWorkspaceId } from '../../stores/auth';
import { useWsQuery } from '../../lib/hooks';
import { listTime } from './chatFormat';
import { chatKeys, useChat, useTypingNames } from './chatStore';
import { fallbackStatus } from './Presence';
import { FilesPanel, InfoPanel, NewChatModal } from './Panels';
import { AskChatDialog, CatchUpDialog, messageLink, QuestionsBox, SavedPanel, ScheduledPanel, StatusButton } from './ChatTools';
import { Menu } from '../../components/Menu';
import { ConversationAvatar, Thread } from './Thread';

const NO_CONVERSATIONS: Conversation[] = [];

/** True once `on` has been true for `ms` without a break: keeps a routine one-second reconnect from flashing a warning. */
function useAfter(on: boolean, ms: number) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) { setLate(false); return; }
    const t = window.setTimeout(() => setLate(true), ms);
    return () => window.clearTimeout(t);
  }, [on, ms]);
  return late;
}

/** Chat between the people of an organization: private chats and groups, updated live. */
export function ChatPage() {
  const { id: legacyId, conversationId } = useParams();
  const id = conversationId ?? legacyId;   // v2: /talk/:conversationId (was /chat/:id)
  const navigate = useNavigate();
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx?.user.id);
  const role = useAuth((s) => s.ctx?.current?.role);
  const personal = useIsPersonal();
  const seed = useChat((s) => s.seedOnline);
  const link = useChat((s) => s.link);
  const linkDown = useAfter(link === 'reconnecting' || link === 'offline', 2500);
  const usable = !personal && role !== 'Guest';

  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [panel, setPanel] = useState<'info' | 'files' | 'saved' | 'scheduled' | null>(null);
  const [dialog, setDialog] = useState<null | 'catchup' | 'ask'>(null);
  const term = useDebounced(search.trim(), 300);

  const conversations = useQuery({
    queryKey: chatKeys.conversations(wid ?? ''),
    queryFn: async () => { const list = await chatApi.conversations(); seed(list.flatMap((c) => c.members)); return list; },
    enabled: !!wid && usable, staleTime: 15_000,
  });
  const hits = useQuery({ queryKey: [wid, 'chat', 'search', term], queryFn: () => chatApi.search(term), enabled: !!wid && usable && term.length >= 2, staleTime: 30_000 });

  const list = conversations.data ?? NO_CONVERSATIONS;
  const current = list.find((c) => c.id === id);
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle ? list.filter((c) => c.name.toLowerCase().includes(needle) || c.members.some((m) => m.name.toLowerCase().includes(needle))) : list;
  }, [list, search]);

  if (!usable) {
    return <EmptyState icon="message" title="Chat is for organizations"
      text="Create or join an organization workspace to message the people you work with. Guests cannot use chat." />;
  }
  if (conversations.isLoading) return <PageLoader />;
  if (conversations.isError) return <ErrorState error={conversations.error} retry={() => void conversations.refetch()} />;

  // Opened from a link to a conversation the person is not in (or that no longer exists): show the list, not an error page.
  const missing = !!id && !current && conversations.isFetched && !conversations.isFetching;

  return (
    <div className="chat-shell">
      <h1 className="sr-only">Chat</h1>
      {linkDown && (
        <div className="chat-link" role="status"><Icon name="alert" size={14} />{link === 'offline' ? 'Live updates are off. Trying to reconnect…' : 'Reconnecting…'}</div>
      )}

      <aside className={`chat-list ${id && !missing ? 'hide-narrow' : ''}`} aria-label="Conversations">
        <div className="chat-list-head">
          <h2>Chat</h2>
          <StatusButton />
          <Menu label="" icon="more" items={[
            { label: 'Catch me up', hint: 'What you missed: decisions, questions for you, actions', icon: 'sparkle', onSelect: () => setDialog('catchup') },
            { label: 'Saved messages', hint: 'Messages you kept for later', icon: 'star', onSelect: () => setPanel('saved') },
            { label: 'Scheduled messages', hint: 'Written now, sent later', icon: 'clock', onSelect: () => setPanel('scheduled') },
            { label: 'Ask the chat', hint: 'Answers from your conversations, with links', icon: 'search', onSelect: () => setDialog('ask') },
          ]} />
          <button className="btn btn-primary btn-sm chat-new" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> New</button>
        </div>
        <div className="search-box"><Icon name="search" size={15} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people and messages" aria-label="Search conversations" />
          {search && <button className="btn-icon" onClick={() => setSearch('')} aria-label="Clear search"><Icon name="close" size={13} /></button>}
        </div>

        <div className="chat-list-scroll">
          {!search && <QuestionsBox />}
          {list.length === 0 && !search && (
            <EmptyState icon="message" title="No conversations yet" text="Message a colleague or start a group."
              action={<button className="btn btn-primary" onClick={() => setCreating(true)}>Start a conversation</button>} />
          )}
          <ul>{shown.map((c) => <ConversationRow key={c.id} c={c} me={me ?? ''} active={c.id === id} onOpen={() => navigate(`/chat/${c.id}`)} />)}</ul>
          {search && shown.length === 0 && !hits.data?.length && !hits.isFetching && <p className="chat-note">Nothing found for “{search.trim()}”.</p>}

          {term.length >= 2 && !!hits.data?.length && (
            <div className="hit-section">
              <div className="info-title">Messages</div>
              <ul>{hits.data.map((h) => (
                <li key={h.messageId}>
                  <button className="hit-row" onClick={() => { setSearch(''); navigate(`/chat/${h.conversationId}`); }}>
                    <b>{h.conversationName}</b>
                    <span>{h.senderName ? `${h.senderName}: ` : ''}{h.snippet}</span>
                    <time>{listTime(h.at)}</time>
                  </button>
                </li>
              ))}</ul>
            </div>
          )}
        </div>
      </aside>

      <section className={`chat-main ${!id || missing ? 'hide-narrow' : ''}`}>
        {current
          ? <Thread key={current.id} conversation={current} infoOpen={panel === 'info'} onInfo={() => setPanel((p) => (p === 'info' ? null : 'info'))}
              filesOpen={panel === 'files'} onFiles={() => setPanel((p) => (p === 'files' ? null : 'files'))} onBack={() => navigate('/chat')} />
          : id && !missing
            ? <PageLoader />   // the list is still catching up with a conversation that was just opened
            : <WhileAway missing={missing} list={list} onCatchUp={() => setDialog('catchup')} onNew={() => setCreating(true)} />}
      </section>

      {current && panel === 'info' && <InfoPanel key={current.id} conversation={current} onClose={() => setPanel(null)} />}
      {current && panel === 'files' && <FilesPanel key={current.id} conversation={current} onClose={() => setPanel(null)} />}
      {panel === 'saved' && <SavedPanel onClose={() => setPanel(null)} />}
      {panel === 'scheduled' && <ScheduledPanel onClose={() => setPanel(null)} />}
      {dialog === 'catchup' && <CatchUpDialog onClose={() => setDialog(null)} />}
      {dialog === 'ask' && <AskChatDialog onClose={() => setDialog(null)} />}
      {creating && <NewChatModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function ConversationRow({ c, me, active, onOpen }: { c: Conversation; me: string; active: boolean; onOpen: () => void }) {
  const statuses = useChat((s) => s.status);
  const typing = useTypingNames(c.id);
  const other = c.type === 'Direct' ? c.members.find((m) => m.userId !== me) : null;
  const presence = other ? (statuses[other.userId] ?? fallbackStatus(other)) : 'offline';
  const last = c.lastMessage;
  const preview = typing.length ? <span className="typing-text">typing…</span>
    : last ? <>{last.isMine && !last.isSystem ? 'You: ' : c.type === 'Group' && last.senderName && !last.isSystem ? `${last.senderName.split(' ')[0]}: ` : ''}{last.snippet || 'Message deleted'}</>
      : <em>No messages yet</em>;
  return (
    <li>
      <button className={`conv-row ${active ? 'active' : ''} ${c.unread > 0 ? 'unread' : ''}`} onClick={onOpen} aria-current={active ? 'true' : undefined}>
        <span className={`conv-av av-c${hue(c.name)}`}><ConversationAvatar conversation={c} status={presence} /></span>
        <span className="conv-text">
          <span className="conv-top"><b>{c.name}</b>{other?.dnd && <span className="conv-dnd" title="Do not disturb" aria-label="Do not disturb"><Icon name="moon" size={12} /></span>}{other?.statusEmoji && <span title={other.statusText ?? undefined}>{other.statusEmoji}</span>}{c.isMuted && <Icon name="bell" size={12} style={{ opacity: 0.5 }} />}<time>{last ? listTime(last.at) : ''}</time></span>
          <span className="conv-bottom"><span className="conv-preview">{preview}</span>{c.unread > 0 && <span className="unread-badge" aria-label={`${c.unread} unread`}>{c.unread > 99 ? '99+' : c.unread}</span>}</span>
        </span>
      </button>
    </li>
  );
}

/** A steady colour for a person's initials (six calm hues), so the same colleague always looks the same in the list. */
function hue(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 6;
}

/**
 * Nothing open yet: "While you were away" - the decisions (read for you on request, one click), the first question waiting for an answer,
 * and the latest file someone shared; or pick a conversation on the left.
 */
function WhileAway({ missing, list, onCatchUp, onNew }: { missing: boolean; list: Conversation[]; onCatchUp: () => void; onNew: () => void }) {
  const navigate = useNavigate();
  const wid = useWorkspaceId() ?? '';
  const questions = useWsQuery([...chatKeys.questions(wid)].slice(1), () => chatApi.questions(), { staleTime: 30_000 });
  const q = questions.data?.[0];
  const file = list.find((c) => c.lastMessage && !c.lastMessage.isSystem && /^Sent (a file|an image|a voice note)/.test(c.lastMessage.snippet));
  const who = (c: Conversation) => (c.lastMessage!.isMine ? 'You' : (c.lastMessage!.senderName ?? c.name).split(' ')[0]);
  const fileText = file ? `${who(file)} ${file.lastMessage!.snippet.replace(/^Sent a file: /, 'sent ').replace(/^Sent /, 'sent ')}` : null;
  if (missing) return (
    <div className="chat-away">
      <h2 className="chat-away-title">Conversation not found</h2>
      <p className="chat-away-foot">It may have been removed, or you may no longer be in it. Pick a conversation on the left, or <button type="button" className="link-btn" onClick={onNew}>start a new one</button>.</p>
    </div>
  );
  return (
    <div className="chat-away" data-testid="chat-away">
      <span className="eyebrow">Catch me up</span>
      <h2 className="chat-away-title">While you were away</h2>
      <div className="chat-away-tiles">
        <button type="button" className="chat-away-tile" onClick={onCatchUp}>
          <small>Decisions</small><b>See what was decided in your chats</b>
        </button>
        <button type="button" className="chat-away-tile" disabled={!q} onClick={() => q && navigate(messageLink(q.conversationId, q.messageId, q.threadRootId))}>
          <small>Questions for you</small><b>{q ? `${(q.senderName ?? 'Someone').split(' ')[0]} needs an answer from you` : 'Nobody is waiting on you'}</b>
        </button>
        <button type="button" className="chat-away-tile" disabled={!file} onClick={() => file && navigate(`/chat/${file.id}`)}>
          <small>Files</small><b>{fileText ?? 'No new files'}</b>
        </button>
      </div>
      <p className="chat-away-foot">{list.length ? 'Or pick a conversation on the left.' : <>No conversations yet. <button type="button" className="link-btn" onClick={onNew}>Message a colleague or start a group</button>.</>}</p>
    </div>
  );
}
