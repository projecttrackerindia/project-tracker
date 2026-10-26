import { useMemo, useState } from 'react';
import { MeetPage } from '../meet/MeetPage';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { chatApi } from '../../api/endpoints';
import type { Conversation } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, PageLoader, Spinner } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useIsPersonal, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { StartCallButton } from '../calls/StartCall';
import { listTime } from '../chat/chatFormat';
import { chatKeys, useChat } from '../chat/chatStore';
import { AskChatDialog, CatchUpDialog, SavedPanel, ScheduledPanel } from '../chat/ChatTools';
import { insertIntoComposer } from '../chat/MessageExtras';
import { FilesPanel, InfoPanel, NewChatModal } from '../chat/Panels';
import { fallbackStatus } from '../chat/Presence';
import { ConversationAvatar, Thread } from '../chat/Thread';
import { ConnectModal, Reader, useMailAccounts } from '../mailbox/MailParts';
import { mailboxApi } from '../mailbox/mailboxApi';
import { MeetingDetail } from '../meet/MeetingDetail';
import { parseRef } from '../meet/meetApi';
import { DotsMenu } from './DotsMenu';
import { talkApi, type TalkFilter, type TalkRow } from './talkApi';
import './talk.css';

const FILTERS: { id: TalkFilter; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'chat', label: 'Chat' }, { id: 'mail', label: 'Mail' }, { id: 'meetings', label: 'Meetings' }];
const KIND_OF: Record<TalkFilter, TalkRow['kind'] | null> = { all: null, chat: 'chat', mail: 'mail', meetings: 'meeting' };
const NO_CONVERSATIONS: Conversation[] = [];
const DAY = 86_400_000;

/** Where a row sits: a chat or mail by its last message; a meeting now or within a day with the newest, one further ahead lower the further away it is. */
function sortKey(r: TalkRow, now: number) {
  const at = r.at ? Date.parse(r.at) : 0;
  if (r.kind !== 'meeting') return at;
  if (r.live || (at >= now && at - now <= DAY)) return now;
  return at > now ? now - (at - now) : at;
}

/** A steady colour for a name (six calm hues), so the same person or meeting always looks the same. */
function hue(name: string) { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0; return h % 6; }

/** When a meeting is: "Tomorrow 10:30", "Now", or the day. */
function meetingTime(r: TalkRow) {
  if (r.live) return 'Now';
  if (!r.sessionStart) return '';
  const d = new Date(r.sessionStart), now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY);
  return days === 0 ? `Today ${time}` : days === 1 ? `Tomorrow ${time}` : days === -1 ? 'Yesterday' : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/**
 * Talk: chat, mail and meetings in one list (filters All · Chat · Mail · Meetings), and the open one on the right in the same pane: a chat
 * thread (actions beside the bubble, ✦ summary strip, ✦ draft a reply), a mail conversation, or a meeting. Calls start from the list or a
 * thread. Chats keep their conversation id in the address (/talk/{id}); mail and meetings open with ?mail= and ?meeting=.
 */
function TalkHome() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx?.user.id) ?? '';
  const role = useAuth((s) => s.ctx?.current?.role);
  const personal = useIsPersonal();
  const seed = useChat((s) => s.seedOnline);
  const chatUsable = !personal && role !== 'Guest';

  const filter = (FILTERS.some((x) => x.id === params.get('f')) ? params.get('f') : 'all') as TalkFilter;
  const chatId = (() => { const m = /\/talk\/([^/?#]+)/.exec(location.pathname); return m ? decodeURIComponent(m[1]) : null; })();
  const mailId = params.get('mail');
  const mailAccount = params.get('account');
  const meeting = parseRef(params.get('meeting'));
  const [search, setSearch] = useState('');
  const [panel, setPanel] = useState<'info' | 'files' | 'saved' | 'scheduled' | null>(null);
  const [dialog, setDialog] = useState<null | 'catchup' | 'ask' | 'new' | 'connect'>(null);

  const talk = useWsQuery(['talk', 'conversations'], () => talkApi.conversations('all'), { staleTime: 15_000, refetchInterval: 120_000 });
  // The live chat list (the realtime connection keeps it current), so a new message moves its chat to the top at once.
  const conversations = useQuery({
    queryKey: chatKeys.conversations(wid ?? ''),
    queryFn: async () => { const list = await chatApi.conversations(); seed(list.flatMap((c) => c.members)); return list; },
    enabled: !!wid && chatUsable, staleTime: 15_000,
  });
  const live = conversations.data ?? NO_CONVERSATIONS;
  const mail = useMailAccounts();
  const agentOpts = useWsQuery(['mailbox', 'agent-options'], mailboxApi.agentOptions, { staleTime: 300_000, enabled: !!mailId });

  // One list: the merged rows, with each chat's last message and unread count taken from the live list.
  const rows = useMemo(() => {
    const now = Date.now();
    const byId = new Map(live.map((c) => [c.id, c]));
    const out: TalkRow[] = [];
    const seen = new Set<string>();
    for (const r of talk.data?.items ?? []) {
      if (r.kind !== 'chat') { out.push(r); continue; }
      const c = byId.get(r.id);
      seen.add(r.id);
      out.push(c ? chatRow(c, me, r) : r);
    }
    for (const c of live) if (!seen.has(c.id)) out.push(chatRow(c, me, null));
    return out.sort((a, b) => sortKey(b, now) - sortKey(a, now));
  }, [talk.data, live, me]);
  const kind = KIND_OF[filter];
  const needle = search.trim().toLowerCase();
  const shown = rows.filter((r) => (!kind || r.kind === kind) && (!needle || `${r.title} ${r.last ?? ''} ${r.sub ?? ''}`.toLowerCase().includes(needle)));
  const mailState = talk.data?.mail.state;
  const company = mail.imap.data?.company;
  const showConnect = (filter === 'all' || filter === 'mail') && mailState === 'not-connected' && !mail.loading && mail.accounts.length === 0;

  const setParam = (patch: Record<string, string | null>, path?: string) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v === null) next.delete(k); else next.set(k, v); }
    const qs = next.toString();
    navigate(`${path ?? location.pathname}${qs ? `?${qs}` : ''}`, { replace: !path });
  };
  const keepF = filter === 'all' ? '' : `?f=${filter}`;
  const open = (r: TalkRow) => {
    setPanel(null);
    if (r.kind === 'chat') navigate(`/talk/${r.id}${keepF}`);
    else if (r.kind === 'mail') navigate(`/talk?${new URLSearchParams({ ...(filter === 'all' ? {} : { f: filter }), mail: r.messageId ?? '', account: r.account ?? '' })}`);
    else navigate(`/talk?${new URLSearchParams({ ...(filter === 'all' ? {} : { f: filter }), meeting: r.meetingRef ?? '', ...(r.sessionStart ? { at: r.sessionStart } : {}) })}`);
  };
  const back = () => navigate(`/talk${keepF}`);
  const activeId = chatId ?? (mailId ? `mail:${mailId}` : meeting ? `meet:${params.get('meeting')}` : null);
  const current = chatId ? live.find((c) => c.id === chatId) ?? null : null;
  const mailAcct = mailId ? mail.accounts.find((a) => a.key === mailAccount) ?? null : null;
  const opened = !!activeId;

  if (talk.isLoading && conversations.isLoading) return <PageLoader />;

  return (
    <div className={`talk-shell${opened ? ' is-open' : ''}`} data-testid="talk">
      <h1 className="sr-only">Talk</h1>
      <aside className="talk-list" aria-label="Conversations">
        <div className="talk-list-head">
          <h2>Talk</h2>
          <DotsMenu label="More in Talk" items={[
            { label: 'New conversation', hint: 'Message a colleague or start a group', icon: 'plus', onSelect: () => setDialog('new'), hidden: !chatUsable },
            { label: 'Catch me up', hint: 'What you missed across your chats', icon: 'sparkle', onSelect: () => setDialog('catchup'), hidden: !chatUsable },
            { label: 'Ask the chat', hint: 'Answers from your conversations, with links', icon: 'search', onSelect: () => setDialog('ask'), hidden: !chatUsable },
            { label: 'Saved messages', icon: 'star', onSelect: () => setPanel('saved'), hidden: !chatUsable },
            { label: 'Scheduled messages', icon: 'clock', onSelect: () => setPanel('scheduled'), hidden: !chatUsable },
            { label: 'Connect a mailbox', icon: 'mail', onSelect: () => setDialog('connect') },
          ]} />
          <StartCallButton label="Start call" className="btn btn-primary btn-sm talk-start" />
        </div>
        <div className="ds-chips talk-filters" role="group" aria-label="Show">
          {FILTERS.map((x) => (
            <button key={x.id} type="button" className={`ds-chip${filter === x.id ? ' on' : ''}`} aria-pressed={filter === x.id}
              onClick={() => setParam({ f: x.id === 'all' ? null : x.id })}>{x.label}</button>
          ))}
        </div>
        {rows.length > 10 && (
          <label className="talk-search"><Icon name="search" size={15} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people, mail and meetings" aria-label="Search Talk" />
          </label>
        )}
        <div className="talk-scroll">
          {talk.isError && <div className="talk-note" role="alert">{talk.error instanceof ApiError ? talk.error.message : 'Talk could not be loaded.'} <button type="button" className="link-btn" onClick={() => void talk.refetch()}>Try again</button></div>}
          <ul className="talk-rows">
            {shown.map((r) => <Row key={r.id} r={r} conversation={r.kind === 'chat' ? live.find((c) => c.id === r.id) : undefined} me={me} active={r.id === activeId} onOpen={() => open(r)} />)}
            {showConnect && (
              <li>
                <button type="button" className="talk-row connect" onClick={() => setDialog('connect')} data-testid="connect-mailbox">
                  <span className="talk-av av-mail" aria-hidden="true">{(company?.name ?? 'Mail').slice(0, 2).toUpperCase()}</span>
                  <span className="talk-text">
                    <span className="talk-top"><b>{company?.name ? `${company.name} · 0 unread` : 'Your mailbox'}</b><time>—</time></span>
                    <span className="talk-bottom"><span className="talk-preview">Mail · Connect your mailbox</span></span>
                  </span>
                </button>
              </li>
            )}
            {(filter === 'all' || filter === 'mail') && mailState === 'unavailable' && (
              <li className="talk-note">Your mailbox did not answer in time. <button type="button" className="link-btn" onClick={() => void talk.refetch()}>Try again</button></li>
            )}
          </ul>
          {shown.length === 0 && !showConnect && !talk.isLoading && (
            <EmptyState icon={filter === 'meetings' ? 'video' : filter === 'mail' ? 'mail' : 'message'}
              title={needle ? 'Nothing found' : filter === 'meetings' ? 'No meetings in the next two weeks' : filter === 'mail' ? 'No mail yet' : 'No conversations yet'}
              text={needle ? undefined : filter === 'meetings' ? 'Meetings you organize or are invited to show here.' : filter === 'mail' ? undefined : 'Message a colleague or start a group.'}
              action={!needle && filter !== 'meetings' && filter !== 'mail' && chatUsable ? <button type="button" className="btn btn-primary" onClick={() => setDialog('new')}>Start a conversation</button> : undefined} />
          )}
        </div>
      </aside>

      <section className="talk-pane" aria-label="Conversation">
        {chatId ? (
          current
            ? <Thread key={current.id} variant="talk" conversation={current} onBack={back}
                banner={<SummaryStrip key={current.id} conversation={current} me={me} onCatchUp={() => setDialog('catchup')} />}
                infoOpen={panel === 'info'} onInfo={() => setPanel((p) => (p === 'info' ? null : 'info'))}
                filesOpen={panel === 'files'} onFiles={() => setPanel((p) => (p === 'files' ? null : 'files'))} />
            : conversations.isLoading || conversations.isFetching ? <PageLoader />
              : <Gone text="This conversation was removed, or you are no longer in it." onBack={back} />
        ) : mailId ? (
          mailAcct
            ? <div className="talk-mail"><Reader key={`${mailAcct.key}-${mailId}`} account={mailAcct} folder="inbox" messageId={mailId} row={null} agent={!!agentOpts.data?.available} onBack={back}
                onSent={() => { void invalidateWorkspace(wid, 'mailbox'); void talk.refetch(); }} /></div>
            : mail.loading ? <PageLoader /> : <Gone text="This mailbox is no longer connected." onBack={back} />
        ) : meeting ? (
          <div className="talk-meeting">
            <MeetingDetail key={params.get('meeting')} inline kind={meeting.kind} id={meeting.id} at={params.get('at')} onClose={back}
              onProject={(pid) => navigate(`/work/projects/${pid}`)}
              headerExtra={<button type="button" className="btn-icon talk-pane-back" onClick={back} aria-label="Back to conversations"><Icon name="arrowLeft" /></button>} />
          </div>
        ) : (
          <div className="talk-empty">
            <Icon name="message" size={30} />
            <h2>Pick a conversation</h2>
            <p>Chats, mail and meetings are all on the left. Start a call or a new conversation from there.</p>
          </div>
        )}
      </section>

      {current && panel === 'info' && <InfoPanel key={current.id} conversation={current} onClose={() => setPanel(null)} />}
      {current && panel === 'files' && <FilesPanel key={current.id} conversation={current} onClose={() => setPanel(null)} />}
      {panel === 'saved' && <SavedPanel onClose={() => setPanel(null)} />}
      {panel === 'scheduled' && <ScheduledPanel onClose={() => setPanel(null)} />}
      {dialog === 'catchup' && <CatchUpDialog conversationId={chatId} onClose={() => setDialog(null)} />}
      {dialog === 'ask' && <AskChatDialog onClose={() => setDialog(null)} />}
      {dialog === 'new' && <NewChatModal onClose={() => setDialog(null)} />}
      {dialog === 'connect' && (
        <ConnectModal accountsData={mail.imap.data} presets={mail.imap.data?.presets ?? []} google={mail.google.data} microsoft={mail.ms.data} imapAccounts={mail.imap.data?.imap ?? []}
          onClose={() => setDialog(null)} onConnected={() => { void invalidateWorkspace(wid, 'mailbox'); void invalidateWorkspace(wid, 'talk'); }} />
      )}
    </div>
  );
}

/** A chat row from the live conversation (falling back to what Talk sent). */
function chatRow(c: Conversation, me: string, base: TalkRow | null): TalkRow {
  const last = c.lastMessage;
  const text = !last ? null : last.isMine && !last.isSystem ? `You: ${last.snippet}` : c.type !== 'Direct' && last.senderName && !last.isSystem ? `${last.senderName.split(' ')[0]}: ${last.snippet || 'Message deleted'}` : last.snippet || 'Message deleted';
  const other = c.type === 'Direct' ? c.members.find((m) => m.userId !== me) : null;
  return {
    id: c.id, kind: 'chat', title: c.name, sub: c.type === 'Project' ? 'Project chat' : c.type === 'Group' ? 'Group' : null, last: text, at: last?.at ?? c.lastActivityAt ?? base?.at ?? null,
    unread: c.unread, avatar: { initials: base?.avatar.initials ?? c.name.slice(0, 2).toUpperCase(), userId: other?.userId ?? null, hasAvatar: false, square: false }, group: c.type !== 'Direct',
    account: null, messageId: null, meetingRef: null, sessionStart: null, live: false, upcoming: false, joinUrl: null,
  };
}

function Row({ r, conversation, me, active, onOpen }: { r: TalkRow; conversation?: Conversation; me: string; active: boolean; onOpen: () => void }) {
  const statuses = useChat((s) => s.status);
  const other = conversation?.type === 'Direct' ? conversation.members.find((m) => m.userId !== me) : null;
  const presence = other ? (statuses[other.userId] ?? fallbackStatus(other)) : 'offline';
  const kindLabel = r.kind === 'chat' ? (r.group ? (r.sub === 'Project chat' ? 'Project chat' : 'Chat · group') : 'Chat') : r.kind === 'mail' ? 'Mail' : null;
  const second = r.kind === 'meeting' ? r.sub ?? 'Meeting' : [kindLabel, r.last].filter(Boolean).join(' · ');
  const when = r.kind === 'meeting' ? meetingTime(r) : r.at ? listTime(r.at) : '';
  return (
    <li>
      <button type="button" className={`talk-row k-${r.kind}${active ? ' active' : ''}${r.unread > 0 ? ' unread' : ''}`} onClick={onOpen} aria-current={active ? 'true' : undefined} data-row={r.title}>
        {conversation
          ? <span className={`talk-av conv-av av-c${hue(r.title)}`}><ConversationAvatar conversation={conversation} status={presence} /></span>
          : <span className={`talk-av av-c${hue(r.title)}${r.avatar.square ? ' square' : ''}`} aria-hidden="true">{r.avatar.initials}</span>}
        <span className="talk-text">
          <span className="talk-top"><b>{r.title}</b>{r.live && <span className="talk-live">Live</span>}<time>{when}</time></span>
          <span className="talk-bottom"><span className="talk-preview">{second || <em>No messages yet</em>}</span>
            {r.unread > 0 && <span className="unread-badge" aria-label={`${r.unread} unread`}>{r.unread > 99 ? '99+' : r.unread}</span>}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * ✦ at the top of a chat: what it is about in one line (the catch-up AI, asked for when there is something to catch up on, or on request), and
 * one action: go to the question waiting for you, draft a reply, or the full catch-up.
 */
function SummaryStrip({ conversation, me, onCatchUp }: { conversation: Conversation; me: string; onCatchUp: () => void }) {
  const navigate = useNavigate();
  const [asked, setAsked] = useState(conversation.unread >= 3);
  const [drafting, setDrafting] = useState(false);
  const lastId = conversation.lastMessage?.at ?? '';
  const q = useWsQuery(['chat', 'summary', conversation.id, lastId], () => chatApi.catchUp(conversation.id), { enabled: asked && !!conversation.lastMessage, staleTime: 10 * 60_000, retry: false });
  if (!conversation.lastMessage) return null;
  const d = q.data;
  const question = d?.questions.find((x) => x.messageId);
  const theirs = !conversation.lastMessage.isMine && !conversation.lastMessage.isSystem;
  const draft = async () => {
    setDrafting(true);
    try {
      const page = await chatApi.messages(conversation.id);
      const last = [...page.items].reverse().find((m) => m.kind === 'User' && !m.isDeleted && m.senderId !== me && !!m.body);
      if (!last) { toast('Nothing to reply to yet.', 'info'); return; }
      const r = await chatApi.replies(last.id);
      if (r.replies[0]) insertIntoComposer(conversation.id, r.replies[0]); else toast('No reply to suggest right now.', 'info');
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not draft a reply right now.', 'error'); }
    finally { setDrafting(false); }
  };
  return (
    <div className="talk-strip" role="note" aria-label="Summary" data-testid="summary-strip">
      <span className="talk-strip-mark"><Icon name="sparkle" size={13} /> Summary</span>
      <span className="talk-strip-text">
        {!asked ? 'The gist of this chat in one line.'
          : q.isLoading ? <><Spinner /> Reading the conversation…</>
            : q.isError ? (q.error instanceof ApiError ? q.error.message : 'No summary right now.')
              : d?.summary || 'Nothing new to sum up.'}
      </span>
      {!asked ? <button type="button" className="talk-strip-act" onClick={() => setAsked(true)}>Summarize</button>
        : question ? <button type="button" className="talk-strip-act" onClick={() => navigate(`/talk/${conversation.id}?m=${question.messageId}`)}>Answer {question.conversationName ? 'the question' : 'it'}</button>
          : theirs ? <button type="button" className="talk-strip-act" disabled={drafting} onClick={() => void draft()}>{drafting ? <Spinner /> : null}Draft a reply</button>
            : d ? <button type="button" className="talk-strip-act" onClick={onCatchUp}>See actions</button> : null}
    </div>
  );
}

function Gone({ text, onBack }: { text: string; onBack: () => void }) {
  return (
    <div className="talk-empty">
      <Icon name="alert" size={28} />
      <h2>Not here</h2>
      <p>{text}</p>
      <button type="button" className="btn btn-ghost" onClick={onBack}>Back to Talk</button>
    </div>
  );
}

type MeetSection = 'upcoming' | 'series' | 'past' | 'notetaker';
const MEET_SECTIONS: readonly MeetSection[] = ['upcoming', 'series', 'past', 'notetaker'];

/**
 * Talk. Meetings keep their full views here: a section (`?f=meetings&s=series|past|notetaker`) or scheduling (`&new=schedule|now`) opens
 * the meetings page; everything else is the one list of chats, mail and meetings.
 */
export function TalkPage() {
  const [params] = useSearchParams();
  const s = params.get('s') as MeetSection | null;
  if (params.get('f') === 'meetings' && ((s && MEET_SECTIONS.includes(s)) || params.has('new')))
    return <MeetPage section={s && MEET_SECTIONS.includes(s) ? s : 'upcoming'} />;
  return <TalkHome />;
}
