import { Face } from '../../components/Face';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { queryClient } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { Popover } from '../../lib/popover';
import { haptic } from '../../lib/mobile';
import { MeetPage } from '../meet/MeetPage';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { chatApi } from '../../api/endpoints';
import type { Conversation } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, PageLoader } from '../../components/ui';
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
import { usePresence } from '../chat/Presence';
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
 * their conversation id in the address (/messages/{id}); meetings open with ?meeting=. Mail has its own place (/mail).
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
  const chatId = (() => { const m = /\/messages\/([^/?#]+)/.exec(location.pathname); return m ? decodeURIComponent(m[1]) : null; })();
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
  const prefs = useTalkPrefs(wid ?? '');
  const kind = KIND_OF[filter];
  const needle = search.trim().toLowerCase();
  const unreadCount = rows.filter((r) => r.unread > 0).length;
  const matching = rows.filter((r) => (!kind || r.kind === kind) && (filter !== 'unread' || r.unread > 0) && (!needle || `${r.title} ${r.last ?? ''} ${r.sub ?? ''}`.toLowerCase().includes(needle))
    && !(prefs.hidden[r.id] && prefs.hidden[r.id] === (r.at ?? '')));
  // Pinned conversations sit as round avatars above the list (Messages), only in the plain list and only when there are any.
  const showPins = !needle && filter === 'all';
  const pinnedRows = showPins ? prefs.pinned.map((pid) => matching.find((r) => r.id === pid)).filter((r): r is TalkRow => !!r) : [];
  const shown = showPins ? matching.filter((r) => !prefs.pinned.includes(r.id)) : matching;
  const rowActions = (r: TalkRow): RowAction[] => {
    const c = r.kind === 'chat' ? live.find((x) => x.id === r.id) : undefined;
    const pinned = prefs.pinned.includes(r.id);
    return [
      { id: 'pin', label: pinned ? 'Unpin' : 'Pin', icon: pinned ? 'pinOff' : 'pin', run: () => prefs.togglePin(r.id) },
      ...(c ? [{ id: 'mute', label: c.isMuted ? 'Unmute' : 'Mute', icon: 'bell' as RowAction['icon'], run: () => void chatApi.mute(c.id, !c.isMuted).then(() => queryClient.invalidateQueries({ queryKey: chatKeys.conversations(wid ?? '') })).catch(() => toast('Could not change that.', 'error')) }] : []),
      ...(c && c.unread > 0 ? [{ id: 'read', label: 'Mark as read', icon: 'checkCircle' as RowAction['icon'], run: () => void chatApi.markRead(c.id).then(() => queryClient.setQueryData<Conversation[]>(chatKeys.conversations(wid ?? ''), (old) => old?.map((x) => (x.id === c.id ? { ...x, unread: 0 } : x)))).catch(() => toast('Could not mark it read.', 'error')) }] : []),
      { id: 'hide', label: 'Hide', icon: 'eyeOff', danger: true, run: () => { prefs.hide(r.id, r.at ?? ''); if (r.id === activeId) back(); toast(`${r.title} is hidden until something new arrives.`, 'info'); } },
    ];
  };
  const reduce = useReducedMotion();

  const setParam = (patch: Record<string, string | null>, path?: string) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v === null) next.delete(k); else next.set(k, v); }
    const qs = next.toString();
    navigate(`${path ?? location.pathname}${qs ? `?${qs}` : ''}`, { replace: !path });
  };
  const keepF = filter === 'all' ? '' : `?f=${filter}`;
  const open = (r: TalkRow) => {
    setPanel(null);
    if (r.kind === 'chat') navigate(`/messages/${r.id}${keepF}`);
    else navigate(`/messages?${new URLSearchParams({ ...(filter === 'all' ? {} : { f: filter }), meeting: r.meetingRef ?? '', ...(r.sessionStart ? { at: r.sessionStart } : {}) })}`);
  };
  const back = () => navigate(`/messages${keepF}`);
  const activeId = chatId ?? (meeting ? `meet:${params.get('meeting')}` : null);
  const current = chatId ? live.find((c) => c.id === chatId) ?? null : null;
  const opened = !!activeId;

  if (talk.isLoading && conversations.isLoading) return <PageLoader />;

  return (
    <div className={`talk-shell${opened ? ' is-open' : ''}`} data-testid="talk">
      <h1 className="sr-only">Messages</h1>
      <ToolbarSlot title={<span className="tb-big" aria-hidden="true">Messages</span>} />
      <aside className="talk-list" aria-label="Conversations">
        <div className="talk-large" aria-hidden="true">Messages</div>
        <div className="talk-list-top">
          <label className="talk-search"><Icon name="search" size={14} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search chats and meetings" aria-label="Search Messages" />
          </label>
          {chatUsable && <StatusButton />}
          <DotsMenu label="More in Messages" items={[
            { label: 'New conversation', hint: 'Message a colleague or start a group', icon: 'plus', onSelect: () => setDialog('new'), hidden: !chatUsable },
            { label: 'Catch me up', hint: 'What you missed across your chats', icon: 'sparkle', onSelect: () => setDialog('catchup'), hidden: !chatUsable },
            { label: 'Ask the chat', hint: 'Answers from your conversations, with links', icon: 'search', onSelect: () => setDialog('ask'), hidden: !chatUsable },
            { label: 'Saved messages', icon: 'star', onSelect: () => setPanel('saved'), hidden: !chatUsable },
            { label: 'Scheduled messages', icon: 'clock', onSelect: () => setPanel('scheduled'), hidden: !chatUsable },
            // Meetings keep their full views (Meet): scheduling, the upcoming list with replies, series, past notes and the notetaker.
            { label: 'Schedule a meeting', icon: 'calendar', onSelect: () => navigate('/messages?f=meetings&new=schedule') },
            { label: 'All meetings', hint: 'Upcoming, series, past and the notetaker', icon: 'video', onSelect: () => navigate('/messages?f=meetings&s=upcoming') },
          ]} />
        </div>
        {/* A small segmented control, as Messages' filters. */}
        <div className="talk-filters talk-seg" role="group" aria-label="Show">
          {FILTERS.map((x) => (
            <button key={x.id} type="button" className={`ds-chip talk-chip${filter === x.id ? ' on' : ''}`} aria-pressed={filter === x.id}
              onClick={() => setParam({ f: x.id === 'all' ? null : x.id })}>
              {filter === x.id && <motion.span className="talk-seg-thumb" layoutId={reduce ? undefined : 'talk-seg'} transition={{ type: 'spring', stiffness: 520, damping: 40 }} aria-hidden="true" />}
              <span className="talk-seg-label">{x.label}{x.id === 'unread' && unreadCount > 0 ? ` ${unreadCount}` : ''}</span>
            </button>
          ))}
        </div>
        <div className="talk-scroll">
          {talk.isError && <div className="talk-note" role="alert">{talk.error instanceof ApiError ? talk.error.message : 'Messages could not be loaded.'} <button type="button" className="link-btn" onClick={() => void talk.refetch()}>Try again</button></div>}
          {/* Questions colleagues asked you in chat and are waiting on (cleared by replying). */}
          {chatUsable && !needle && (filter === 'all' || filter === 'chat') && <QuestionsBox />}
          {pinnedRows.length > 0 && (
            <ul className="talk-pins" aria-label="Pinned conversations">
              {pinnedRows.slice(0, 8).map((r) => (
                <li key={r.id}>
                  <button type="button" className={`talk-pin${r.id === activeId ? ' active' : ''}`} onClick={() => open(r)} aria-current={r.id === activeId ? 'true' : undefined} data-pin={r.title}
                    onContextMenu={(e) => { e.preventDefault(); prefs.togglePin(r.id); }} title={`${r.title} (right-click to unpin)`}>
                    <span className="talk-gl"><RowAvatar r={r} conversation={r.kind === 'chat' ? live.find((c) => c.id === r.id) : undefined} />{r.unread > 0 && <span className="talk-pin-dot" aria-label={`${r.unread} unread`} />}</span>
                    <span className="talk-pin-name">{r.title.replace(/^#/, '').split(' ')[0]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <LayoutGroup>
            <ul className="talk-rows">
              <AnimatePresence initial={false}>
                {shown.map((r) => <Row key={r.id} r={r} conversation={r.kind === 'chat' ? live.find((c) => c.id === r.id) : undefined} active={r.id === activeId} onOpen={() => open(r)} actions={rowActions(r)} reduce={!!reduce} />)}
              </AnimatePresence>
            </ul>
          </LayoutGroup>
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

type RowAction = { id: string; label: string; icon: import('../../components/Icon').IconName; run: () => void; danger?: boolean };

/** Per-device list conveniences (Messages' Pin and Hide): which conversations are pinned, and which are hidden until something new arrives. */
function useTalkPrefs(wid: string) {
  const key = `pm_talk_prefs:${wid}`;
  const read = () => { try { const v = JSON.parse(localStorage.getItem(key) ?? '{}') as { pinned?: string[]; hidden?: Record<string, string> }; return { pinned: v.pinned ?? [], hidden: v.hidden ?? {} }; } catch { return { pinned: [] as string[], hidden: {} as Record<string, string> }; } };
  const [state, setState] = useState(read);
  useEffect(() => { setState(read()); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (next: typeof state) => { setState(next); try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* private window: kept for this visit */ } };
  return {
    ...state,
    togglePin: (id: string) => save({ ...state, pinned: state.pinned.includes(id) ? state.pinned.filter((x) => x !== id) : [...state.pinned, id].slice(-8) }),
    hide: (id: string, at: string) => save({ pinned: state.pinned.filter((x) => x !== id), hidden: { ...state.hidden, [id]: at } }),
  };
}

function RowAvatar({ r, conversation }: { r: TalkRow; conversation?: Conversation }) {
  const channel = r.kind === 'chat' && (conversation ? conversation.type !== 'Direct' : r.group);
  const recording = r.kind === 'meeting' && !r.upcoming && !r.live && !!r.sessionStart && Date.parse(r.sessionStart) < Date.now();
  const initials = r.avatar.initials || r.title.replace(/^#/, '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return r.kind === 'meeting'
    ? <span className={`talk-av square ${recording ? 'rec' : 'cal'}`} aria-hidden="true">{recording ? <Icon name="play" size={16} /> : <Icon name="calendar" size={18} />}</span>
    : channel
      ? <span className={`talk-av square av-c${hue(r.title)}`} aria-hidden="true">#</span>
      : <Face userId={r.avatar.userId} hasAvatar={r.avatar.hasAvatar || undefined} className={`talk-av av-c${hue(r.title)}`} text={initials} />;
}

const SWIPE_OPEN = 148;

/**
 * A Messages-style row: avatar with its source glyph (meeting ▶, a person's live status), unread blue dot on the left, name and time,
 * two lines of preview. Right-click (desktop) opens Pin · Mute · Mark as read · Hide; on a phone the same actions sit under a swipe
 * (right: Read and Pin; left: Mute and Hide). Rows glide to their new place when a conversation jumps to the top.
 */
function Row({ r, conversation, active, onOpen, actions, reduce }: { r: TalkRow; conversation?: Conversation; active: boolean; onOpen: () => void; actions: RowAction[]; reduce: boolean }) {
  const channel = r.kind === 'chat' && (conversation ? conversation.type !== 'Direct' : r.group);
  const title = channel && !r.title.startsWith('#') ? `#${r.title}` : r.title;
  const iso = r.kind === 'meeting' ? r.sessionStart ?? r.at : r.at;
  const when = r.live ? 'Now' : iso ? shortTime(iso) : meetingTime(r);
  const second = r.kind === 'meeting' ? (r.live ? 'Live now' : r.sub ?? 'Meeting') : r.last;
  const [menu, setMenu] = useState(false);
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const t = useRef<{ x: number; y: number; base: number; horizontal: boolean | null } | null>(null);
  const left = actions.filter((a) => a.id === 'read' || a.id === 'pin');     // revealed by swiping right
  const right = actions.filter((a) => a.id === 'mute' || a.id === 'hide');   // revealed by swiping left
  const run = (a: RowAction) => { setDx(0); setMenu(false); a.run(); };
  return (
    <motion.li layout={reduce ? false : 'position'} transition={{ type: 'spring', stiffness: 500, damping: 42 }} exit={reduce ? undefined : { opacity: 0, height: 0 }}>
      <div className={`talk-row-swipe${dx !== 0 ? ' swiping' : ''}`} ref={anchor}>
        {dx > 0 && <div className="talk-swipe-acts l">{left.map((a) => <button key={a.id} type="button" className={`sw-${a.id}`} onClick={() => run(a)}><Icon name={a.icon} size={18} />{a.label}</button>)}</div>}
        {dx < 0 && <div className="talk-swipe-acts r">{right.map((a) => <button key={a.id} type="button" className={`sw-${a.id}`} onClick={() => run(a)}><Icon name={a.icon} size={18} />{a.label}</button>)}</div>}
        <button type="button" className={`talk-row k-${r.kind}${active ? ' active' : ''}${r.unread > 0 ? ' unread' : ''}`} onClick={() => { if (dx !== 0) { setDx(0); return; } onOpen(); }} aria-current={active ? 'true' : undefined} data-row={r.title}
          style={dx ? { transform: `translateX(${dx}px)`, transition: dragging ? 'none' : undefined } : undefined}
          onContextMenu={(e) => { e.preventDefault(); setMenu(true); }}
          onTouchStart={(e) => { const p = e.touches[0]; t.current = { x: p.clientX, y: p.clientY, base: dx, horizontal: null }; }}
          onTouchMove={(e) => {
            const s = t.current; if (!s) return;
            const mx = e.touches[0].clientX - s.x, my = e.touches[0].clientY - s.y;
            if (s.horizontal === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) s.horizontal = Math.abs(mx) > Math.abs(my);
            if (!s.horizontal) return;
            setDragging(true);
            const v = Math.max(right.length ? -SWIPE_OPEN - 24 : 0, Math.min(left.length ? SWIPE_OPEN + 24 : 0, s.base + mx));
            setDx(v);
          }}
          onTouchEnd={() => { const s = t.current; t.current = null; setDragging(false); if (!s?.horizontal) return; setDx((v) => { const next = v > 56 ? (left.length > 1 ? SWIPE_OPEN : SWIPE_OPEN / 2) : v < -56 ? -(right.length > 1 ? SWIPE_OPEN : SWIPE_OPEN / 2) : 0; if (next) haptic(8); return next; }); }}>
          {r.unread > 0 && <span className="talk-dot" aria-label={`${r.unread} unread`} />}
          <span className="talk-gl">
            <RowAvatar r={r} conversation={conversation} />
            {/* Meetings keep their ▶ badge. A person shows a dot only for their real status (green active, amber away, nothing when
                offline or unknown), never a decorative colour that reads as "available". */}
            {r.kind === 'meeting'
              ? <span className="talk-src s-meeting" title="Meeting" aria-hidden="true"><Icon name="play" size={8} /></span>
              : !channel && <PeerStatus userId={conversation?.otherUserId ?? r.avatar.userId ?? null} />}
          </span>
          <span className="talk-text">
            <span className="talk-top"><b>{title}</b>{r.live && <span className="talk-live">Live</span>}{conversation?.isMuted && <Icon name="bell" size={11} className="talk-muted" aria-label="Muted" />}<time>{when}<Icon name="chevronR" size={10} className="talk-chev" /></time></span>
            <span className="talk-preview">{second || <em>No messages yet</em>}</span>
          </span>
        </button>
      </div>
      <Popover open={menu} onClose={() => setMenu(false)} anchorRef={anchor} side="bottom" align="start">
        <ul className="v2-dots-list talk-row-menu" role="menu" aria-label={`${r.title} actions`}>
          {actions.map((a) => <li key={a.id}><button type="button" role="menuitem" className={a.danger ? 'danger' : ''} onClick={() => run(a)}><Icon name={a.icon} size={15} />{a.label}</button></li>)}
        </ul>
      </Popover>
    </motion.li>
  );
}

/** The other person's live status as a dot on their avatar; nothing until the app knows they are active or away. */
function PeerStatus({ userId }: { userId: string | null }) {
  const status = usePresence(userId, 'offline');
  if (status === 'offline') return null;
  return <span className={`talk-src s-presence ${status}`} role="img" aria-label={status === 'away' ? 'Away' : 'Active'} title={status === 'away' ? 'Away' : 'Active now'} />;
}

function Gone({ text, onBack }: { text: string; onBack: () => void }) {
  return (
    <div className="talk-empty">
      <Icon name="alert" size={28} />
      <h2>Not here</h2>
      <p>{text}</p>
      <button type="button" className="btn btn-ghost" onClick={onBack}>Back to Messages</button>
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
