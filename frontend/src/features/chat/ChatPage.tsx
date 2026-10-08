import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { chatApi } from '../../api/endpoints';
import type { Conversation } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, PageLoader } from '../../components/ui';
import { useDebounced } from '../../lib/hooks';
import { useAuth, useIsPersonal, useWorkspaceId } from '../../stores/auth';
import { listTime } from './chatFormat';
import { chatKeys, useChat, useTypingNames } from './chatStore';
import { FilesPanel, InfoPanel, NewChatModal } from './Panels';
import { ConversationAvatar, Thread } from './Thread';

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
  const { id } = useParams();
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
  const [panel, setPanel] = useState<'info' | 'files' | null>(null);
  const term = useDebounced(search.trim(), 300);

  const conversations = useQuery({
    queryKey: chatKeys.conversations(wid ?? ''),
    queryFn: async () => { const list = await chatApi.conversations(); seed(list.flatMap((c) => c.members)); return list; },
    enabled: !!wid && usable, staleTime: 15_000,
  });
  const hits = useQuery({ queryKey: [wid, 'chat', 'search', term], queryFn: () => chatApi.search(term), enabled: !!wid && usable && term.length >= 2, staleTime: 30_000 });

  const list = conversations.data ?? [];
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
      {linkDown && (
        <div className="chat-link" role="status"><Icon name="alert" size={14} />{link === 'offline' ? 'Live updates are off. Trying to reconnect…' : 'Reconnecting…'}</div>
      )}

      <aside className={`chat-list ${id && !missing ? 'hide-narrow' : ''}`} aria-label="Conversations">
        <div className="chat-list-head">
          <h2>Chat</h2>
          <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> New</button>
        </div>
        <div className="search-box"><Icon name="search" size={15} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people and messages" aria-label="Search conversations" />
          {search && <button className="btn-icon" onClick={() => setSearch('')} aria-label="Clear search"><Icon name="close" size={13} /></button>}
        </div>

        <div className="chat-list-scroll">
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
            : <div className="chat-placeholder"><Icon name="message" size={40} /><h3>{missing ? 'Conversation not found' : 'Select a conversation'}</h3>
              <p>{missing ? 'It may have been removed, or you may no longer be in it.' : 'Choose someone from the list, or start a new chat.'}</p>
              <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> New conversation</button></div>}
      </section>

      {current && panel === 'info' && <InfoPanel key={current.id} conversation={current} onClose={() => setPanel(null)} />}
      {current && panel === 'files' && <FilesPanel key={current.id} conversation={current} onClose={() => setPanel(null)} />}
      {creating && <NewChatModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function ConversationRow({ c, me, active, onOpen }: { c: Conversation; me: string; active: boolean; onOpen: () => void }) {
  const online = useChat((s) => s.online);
  const typing = useTypingNames(c.id);
  const other = c.type === 'Direct' ? c.members.find((m) => m.userId !== me) : null;
  const isOnline = !!other && (online[other.userId] ?? other.online);
  const last = c.lastMessage;
  const preview = typing.length ? <span className="typing-text">typing…</span>
    : last ? <>{last.isMine && !last.isSystem ? 'You: ' : c.type === 'Group' && last.senderName && !last.isSystem ? `${last.senderName.split(' ')[0]}: ` : ''}{last.snippet || 'Message deleted'}</>
      : <em>No messages yet</em>;
  return (
    <li>
      <button className={`conv-row ${active ? 'active' : ''} ${c.unread > 0 ? 'unread' : ''}`} onClick={onOpen} aria-current={active ? 'true' : undefined}>
        <ConversationAvatar conversation={c} online={isOnline} />
        <span className="conv-text">
          <span className="conv-top"><b>{c.name}</b>{c.isMuted && <Icon name="bell" size={12} style={{ opacity: 0.5 }} />}<time>{last ? listTime(last.at) : ''}</time></span>
          <span className="conv-bottom"><span className="conv-preview">{preview}</span>{c.unread > 0 && <span className="unread-badge" aria-label={`${c.unread} unread`}>{c.unread > 99 ? '99+' : c.unread}</span>}</span>
        </span>
      </button>
    </li>
  );
}
