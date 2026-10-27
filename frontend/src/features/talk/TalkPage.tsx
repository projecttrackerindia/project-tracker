import { Face } from '../../components/Face';
import { useMemo, useState } from 'react';
import { MeetPage } from '../meet/MeetPage';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { chatApi } from '../../api/endpoints';
import type { Conversation } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, PageLoader, Spinner } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { useAuth, useIsPersonal, useWorkspaceId } from '../../stores/auth';
import { listTime } from '../chat/chatFormat';
import { chatKeys, useChat } from '../chat/chatStore';
import { AskChatDialog, CatchUpDialog, QuestionsBox, SavedPanel, ScheduledPanel, StatusButton } from '../chat/ChatTools';
import { FilesPanel, InfoPanel, NewChatModal } from '../chat/Panels';
import { Thread } from '../chat/Thread';
import { MeetingDetail } from '../meet/MeetingDetail';
import { parseRef } from '../meet/meetApi';
import { DotsMenu } from './DotsMenu';
import { ToolbarSlot } from './ToolbarSlot';
import { WhileAway } from '../chat/ChatPage';
import { talkApi, type TalkFilter, type TalkRow } from './talkApi';
import './talk.css';

const FILTERS: { id: TalkFilter; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'unread', label: 'Unread' }, { id: 'chat', label: 'Chats' }, { id: 'meetings', label: 'Meetings' }];
const KIND_OF: Record<TalkFilter, TalkRow['kind'] | null> = { all: null, unread: null, chat: 'chat', mail: 'mail', meetings: 'meeting' };
const NO_CONVERSATIONS: Conversation[] = [];
const DAY = 86_400_000;

/** Where a row sits: a chat by its last message; a meeting now or within a day with the newest, one further ahead lower the further away it is. */
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
 * Talk: chats and meetings in one list (filters All · Unread · Chats · Meetings), and the open one on the right in the same pane: a chat
 * thread (actions beside the bubble, ✦ summary strip, ✦ draft a reply) or a meeting. Calls start from the list or a thread. Chats keep
 * their conversation id in the address (/talk/{id}); meetings open with ?meeting=. Mail has its own place (/mail).
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
  const meeting = parseRef(params.get('meeting'));
  const [search, setSearch] = useState('');
  const [panel, setPanel] = useState<'info' | 'files' | 'saved' | 'scheduled' | null>(null);
  const [dialog, setDialog] = useState<null | 'catchup' | 'ask' | 'new'>(null);

  const talk = useWsQuery(['talk', 'conversations'], () => talkApi.conversations('talk'), { staleTime: 15_000, refetchInterval: 120_000 });
  // The live chat list (the realtime connection keeps it current), so a new message moves its chat to the top at once.
  const conversations = useQuery({
    queryKey: chatKeys.conversations(wid ?? ''),
    queryFn: async () => { const list = await chatApi.conversations(); seed(list.flatMap((c) => c.members)); return list; },
    enabled: !!wid && chatUsable, staleTime: 15_000,
  });
  const live = conversations.data ?? NO_CONVERSATIONS;

  // One list: the merged rows, with each chat's last message and unread count taken from the live list.
  const rows = useMemo(() => {
    const now = Date.now();
    const byId = new Map(live.map((c) => [c.id, c]));
    const out: TalkRow[] = [];
    const seen = new Set<string>();
    for (const r of talk.data?.items ?? []) {
      if (r.kind === 'mail') continue;   // mail lives in Mail now
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
  const unreadCount = rows.filter((r) => r.unread > 0).length;
  const shown = rows.filter((r) => (!kind || r.kind === kind) && (filter !== 'unread' || r.unread > 0) && (!needle || `${r.title} ${r.last ?? ''} ${r.sub ?? ''}`.toLowerCase().includes(needle)));

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
    else navigate(`/talk?${new URLSearchParams({ ...(filter === 'all' ? {} : { f: filter }), meeting: r.meetingRef ?? '', ...(r.sessionStart ? { at: r.sessionStart } : {}) })}`);
  };
  const back = () => navigate(`/talk${keepF}`);
  const activeId = chatId ?? (meeting ? `meet:${params.get('meeting')}` : null);
  const current = chatId ? live.find((c) => c.id === chatId) ?? null : null;
  const opened = !!activeId;

  if (talk.isLoading && conversations.isLoading) return <PageLoader />;

  return (
    <div className={`talk-shell${opened ? ' is-open' : ''}`} data-testid="talk">
      <h1 className="sr-only">Talk</h1>
      <ToolbarSlot title={<span className="tb-big" aria-hidden="true">Talk</span>} />
      <aside className="talk-list" aria-label="Conversations">
        <div className="talk-list-top">
          <label className="talk-search"><Icon name="search" size={14} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search chats and meetings" aria-label="Search Talk" />
          </label>
          {chatUsable && <StatusButton />}
          <DotsMenu label="More in Talk" items={[
            { label: 'New conversation', hint: 'Message a colleague or start a group', icon: 'plus', onSelect: () => setDialog('new'), hidden: !chatUsable },
            { label: 'Catch me up', hint: 'What you missed across your chats', icon: 'sparkle', onSelect: () => setDialog('catchup'), hidden: !chatUsable },
            { label: 'Ask the chat', hint: 'Answers from your conversations, with links', icon: 'search', onSelect: () => setDialog('ask'), hidden: !chatUsable },
            { label: 'Saved messages', icon: 'star', onSelect: () => setPanel('saved'), hidden: !chatUsable },
            { label: 'Scheduled messages', icon: 'clock', onSelect: () => setPanel('scheduled'), hidden: !chatUsable },
            // Meetings keep their full views (Meet): scheduling, the upcoming list with replies, series, past notes and the notetaker.
            { label: 'Schedule a meeting', icon: 'calendar', onSelect: () => navigate('/talk?f=meetings&new=schedule') },
            { label: 'All meetings', hint: 'Upcoming, series, past and the notetaker', icon: 'video', onSelect: () => navigate('/talk?f=meetings&s=upcoming') },
          ]} />
        </div>
        <div className="talk-filters" role="group" aria-label="Show">
          {FILTERS.map((x) => (
            <button key={x.id} type="button" className={`ds-chip talk-chip${filter === x.id ? ' on' : ''}`} aria-pressed={filter === x.id}
              onClick={() => setParam({ f: x.id === 'all' ? null : x.id })}>{x.label}{x.id === 'unread' && unreadCount > 0 ? ` ${unreadCount}` : ''}</button>
          ))}
        </div>
        <div className="talk-scroll">
          {talk.isError && <div className="talk-note" role="alert">{talk.error instanceof ApiError ? talk.error.message : 'Talk could not be loaded.'} <button type="button" className="link-btn" onClick={() => void talk.refetch()}>Try again</button></div>}
          {/* Questions colleagues asked you in chat and are waiting on (cleared by replying). */}
          {chatUsable && !needle && (filter === 'all' || filter === 'chat') && <QuestionsBox />}
          <ul className="talk-rows">
            {shown.map((r) => <Row key={r.id} r={r} conversation={r.kind === 'chat' ? live.find((c) => c.id === r.id) : undefined} active={r.id === activeId} onOpen={() => open(r)} />)}
          </ul>
          {shown.length === 0 && !talk.isLoading && (
            <EmptyState icon={filter === 'meetings' ? 'video' : 'message'}
              title={needle ? 'Nothing found' : filter === 'meetings' ? 'No meetings in the next two weeks' : 'No conversations yet'}
              text={needle ? undefined : filter === 'meetings' ? 'Meetings you organize or are invited to show here.' : 'Message a colleague or start a group.'}
              action={!needle && filter !== 'meetings' && chatUsable ? <button type="button" className="btn btn-primary" onClick={() => setDialog('new')}>Start a conversation</button> : undefined} />
          )}
        </div>
      </aside>

      <section className="talk-pane" aria-label="Conversation">
        {chatId ? (
          current
            ? <Thread key={current.id} variant="talk" conversation={current} onBack={back}
                banner={<SummaryStrip key={current.id} conversation={current} onCatchUp={() => setDialog('catchup')} />}
                infoOpen={panel === 'info'} onInfo={() => setPanel((p) => (p === 'info' ? null : 'info'))}
                filesOpen={panel === 'files'} onFiles={() => setPanel((p) => (p === 'files' ? null : 'files'))} />
            : conversations.isLoading || conversations.isFetching ? <PageLoader />
              : <Gone text="This conversation was removed, or you are no longer in it." onBack={back} />
        ) : meeting ? (
          <div className="talk-meeting">
            <MeetingDetail key={params.get('meeting')} inline kind={meeting.kind} id={meeting.id} at={params.get('at')} onClose={back}
              onProject={(pid) => navigate(`/work/projects/${pid}`)}
              headerExtra={<button type="button" className="btn-icon talk-pane-back" onClick={back} aria-label="Back to conversations"><Icon name="arrowLeft" /></button>} />
          </div>
        ) : chatUsable ? (
          // Nothing open: "While you were away" (decisions on request, the first question waiting for you, the latest file).
          <WhileAway missing={false} list={live} onCatchUp={() => setDialog('catchup')} onNew={() => setDialog('new')} />
        ) : (
          <div className="talk-empty">
            <Icon name="message" size={30} />
            <h2>Pick a conversation</h2>
            <p>Chats and meetings are all on the left. Start a call or a new conversation from there.</p>
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

/** The list's time, as Messages: "10:38" today (no AM/PM), "Yesterday", the weekday this week, else "14 Oct". */
function shortTime(iso: string) {
  const t = listTime(iso);
  return /\d:\d\d/.test(t) ? new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s?[ap]m$/i, '') : t;
}

/** A Messages-style row: avatar with its source glyph (chat ●, meeting ▶), unread dot, name and time, two lines of preview. */
function Row({ r, conversation, active, onOpen }: { r: TalkRow; conversation?: Conversation; active: boolean; onOpen: () => void }) {
  const channel = r.kind === 'chat' && (conversation ? conversation.type !== 'Direct' : r.group);
  const recording = r.kind === 'meeting' && !r.upcoming && !r.live && !!r.sessionStart && Date.parse(r.sessionStart) < Date.now();
  const title = channel && !r.title.startsWith('#') ? `#${r.title}` : r.title;
  const iso = r.kind === 'meeting' ? r.sessionStart ?? r.at : r.at;
  const when = r.live ? 'Now' : iso ? shortTime(iso) : meetingTime(r);
  const initials = r.avatar.initials || r.title.replace(/^#/, '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const second = r.kind === 'meeting' ? (r.live ? 'Live now' : r.sub ?? 'Meeting') : r.last;
  return (
    <li>
      <button type="button" className={`talk-row k-${r.kind}${active ? ' active' : ''}${r.unread > 0 ? ' unread' : ''}`} onClick={onOpen} aria-current={active ? 'true' : undefined} data-row={r.title}>
        {r.unread > 0 && <span className="talk-dot" aria-label={`${r.unread} unread`} />}
        <span className="talk-gl">
          {r.kind === 'meeting'
            ? <span className={`talk-av square ${recording ? 'rec' : 'cal'}`} aria-hidden="true">{recording ? <Icon name="play" size={16} /> : <Icon name="calendar" size={18} />}</span>
            : channel
              ? <span className={`talk-av square av-c${hue(r.title)}`} aria-hidden="true">#</span>
              : <Face userId={r.avatar.userId} hasAvatar={r.avatar.hasAvatar || undefined} className={`talk-av av-c${hue(r.title)}`} text={initials} />}
          <span className={`talk-src s-${r.kind}`} title={r.kind === 'meeting' ? 'Meeting' : 'Chat'} aria-hidden="true">
            {r.kind === 'meeting' ? <Icon name="play" size={8} /> : null}
          </span>
        </span>
        <span className="talk-text">
          <span className="talk-top"><b>{title}</b>{r.live && <span className="talk-live">Live</span>}<time>{when}</time></span>
          <span className="talk-preview">{second || <em>No messages yet</em>}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * Pinned at the top of a chat: "While you were away · N messages" and up to three decisions from the catch-up AI. The AI is asked when there is
 * something to catch up on (3+ unread) or on request, as before; until then the card offers to read it.
 */
function SummaryStrip({ conversation, onCatchUp }: { conversation: Conversation; onCatchUp: () => void }) {
  const [asked, setAsked] = useState(conversation.unread >= 3);
  const [missed] = useState(conversation.unread);
  const lastId = conversation.lastMessage?.at ?? '';
  const q = useWsQuery(['chat', 'summary', conversation.id, lastId], () => chatApi.catchUp(conversation.id), { enabled: asked && !!conversation.lastMessage, staleTime: 10 * 60_000, retry: false });
  if (!conversation.lastMessage) return null;
  const d = q.data;
  const lines = d ? (d.decisions.length ? d.decisions : d.actions).slice(0, 3).map((x) => (x.owner && !x.text.includes(x.owner.split(' ')[0]) ? `${x.text} (${x.owner.split(' ')[0]})` : x.text)) : [];
  const count = d?.messages ?? missed;
  return (
    <section className="talk-away" aria-label="While you were away" data-testid="summary-strip">
      <span className="talk-orb" aria-hidden="true" />
      <div className="talk-away-body">
        <div className="talk-away-hd"><b>While you were away{count > 0 ? ` · ${count} message${count === 1 ? '' : 's'}` : ''}</b><span className="talk-away-pin">📌 Pinned</span></div>
        {!asked ? <button type="button" className="talk-away-act" onClick={() => setAsked(true)}>Show what was decided</button>
          : q.isLoading ? <p className="talk-away-note"><Spinner /> Reading the conversation…</p>
            : q.isError ? <p className="talk-away-note">{q.error instanceof ApiError ? q.error.message : 'No summary right now.'}</p>
              : lines.length ? <ul>{lines.map((l) => <li key={l}>{l}</li>)}</ul>
                : <p className="talk-away-note">{d?.summary || 'Nothing decided since you were last here.'} {d && <button type="button" className="link-btn" onClick={onCatchUp}>See actions</button>}</p>}
      </div>
    </section>
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
 * the meetings page; everything else is the one list of chats and meetings. Old mail addresses (?f=mail, ?mail=) move to Mail.
 */
export function TalkPage() {
  const [params] = useSearchParams();
  const s = params.get('s') as MeetSection | null;
  if (params.get('f') === 'meetings' && ((s && MEET_SECTIONS.includes(s)) || params.has('new')))
    return <MeetPage section={s && MEET_SECTIONS.includes(s) ? s : 'upcoming'} />;
  if (params.get('f') === 'mail' || params.has('mail')) return <Navigate to={`/mail${params.has('compose') ? '?compose=1' : ''}`} replace />;
  return <TalkHome />;
}
