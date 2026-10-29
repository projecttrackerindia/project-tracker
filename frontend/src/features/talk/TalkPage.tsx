import { Face } from '../../components/Face';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { queryClient } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { Popover } from '../../lib/popover';
import { haptic } from '../../lib/mobile';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, get, put } from '../../api/client';
import { chatApi } from '../../api/endpoints';
import type { Conversation } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, PageLoader } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { useAuth, useIsPersonal, useWorkspaceId } from '../../stores/auth';
import { listTime } from '../chat/chatFormat';
import { chatKeys, useChat } from '../chat/chatStore';
import { dropUnread } from '../chat/unreadBadge';
import { AskChatDialog, CatchUpDialog, QuestionsBox, SavedPanel, ScheduledPanel, StatusButton } from '../chat/ChatTools';
import { FilesPanel, InfoPanel, NewChatModal } from '../chat/Panels';
import { Thread } from '../chat/Thread';
import { DotsMenu } from './DotsMenu';
import { ToolbarSlot } from './ToolbarSlot';
import { WhileAway } from '../chat/ChatPage';
import { talkApi, type TalkFilter, type TalkRow } from './talkApi';
import { usePresence } from '../chat/Presence';
import { avatarBg, defaultTheme } from '../../lib/personTheme';
import { readablePreview } from './preview';
import './talk.css';

const FILTERS: { id: TalkFilter; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'unread', label: 'Unread' }, { id: 'chat', label: 'Chats' }];
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
 * Talk: chats in one list (filters All · Unread · Chats), and the open one on the right in the same pane: a chat
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
      if (r.kind === 'mail' || r.kind === 'meeting') continue;   // mail lives in Mail, meetings in Meetings
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
    && !stillHidden(prefs.hidden[r.id], r.at));
  // Pinned conversations sit as round avatars above the list (Messages), only in the plain list and only when there are any.
  const showPins = !needle && filter === 'all';
  const pinnedRows = showPins ? prefs.pinned.map((pid) => matching.find((r) => r.id === pid)).filter((r): r is TalkRow => !!r) : [];
  const shown = showPins ? matching.filter((r) => !prefs.pinned.includes(r.id)) : matching;
  // A hidden chat leaves the Messages badge too (docs/badges.md): hiding marks what it holds as read; it comes back with the next message.
  const hideRead = (c: Conversation) => {
    dropUnread(wid ?? '', c.unread, c.isMuted);
    queryClient.setQueryData<Conversation[]>(chatKeys.conversations(wid ?? ''), (old) => old?.map((x) => (x.id === c.id ? { ...x, unread: 0 } : x)));
    void chatApi.markRead(c.id).then(() => queryClient.invalidateQueries({ queryKey: chatKeys.unread(wid ?? '') })).catch(() => { /* the badge settles at the next refresh */ });
  };
  const rowActions = (r: TalkRow): RowAction[] => {
    const c = r.kind === 'chat' ? live.find((x) => x.id === r.id) : undefined;
    const pinned = prefs.pinned.includes(r.id);
    return [
      { id: 'pin', label: pinned ? 'Unpin' : 'Pin', icon: pinned ? 'pinOff' : 'pin', run: () => prefs.togglePin(r.id), undo: () => prefs.togglePin(r.id), done: `${r.title} ${pinned ? 'unpinned' : 'pinned'}.` },
      ...(c ? [{ id: 'mute', label: c.isMuted ? 'Unmute' : 'Mute', icon: 'bell' as RowAction['icon'], run: () => void chatApi.mute(c.id, !c.isMuted).then(() => { void queryClient.invalidateQueries({ queryKey: chatKeys.conversations(wid ?? '') }); void queryClient.invalidateQueries({ queryKey: chatKeys.unread(wid ?? '') }); }).catch(() => toast('Could not change that.', 'error')) }] : []),
      ...(c && c.unread > 0 ? [{ id: 'read', label: 'Mark as read', icon: 'checkCircle' as RowAction['icon'], run: () => void chatApi.markRead(c.id).then(() => { dropUnread(wid ?? '', c.unread, c.isMuted); queryClient.setQueryData<Conversation[]>(chatKeys.conversations(wid ?? ''), (old) => old?.map((x) => (x.id === c.id ? { ...x, unread: 0 } : x))); void queryClient.invalidateQueries({ queryKey: chatKeys.unread(wid ?? '') }); }).catch(() => toast('Could not mark it read.', 'error')) }] : []),
      { id: 'hide', label: 'Hide', icon: 'eyeOff', danger: true, run: () => { prefs.hide(r.id, r.at ?? ''); if (c && c.unread > 0) hideRead(c); if (r.id === activeId) back(); toast(`${r.title} is hidden until something new arrives.`, 'info', { label: 'Undo', onClick: () => prefs.unhide(r.id) }); } },
    ];
  };
  const reduce = useReducedMotion();
  // One swiped-open row at a time ("id|l" or "id|r"); a filter, search or route change, a scroll, or a tap anywhere else closes it.
  const [swiped, setSwiped] = useState<string | null>(null);
  useEffect(() => { setSwiped(null); }, [filter, needle, location.pathname, location.search]);
  useEffect(() => {
    if (!swiped) return;
    const close = (e: Event) => { const el = e.target instanceof Element ? e.target.closest('[data-swipe-row]') : null; if (el && el.getAttribute('data-swipe-row') === swiped.split('|')[0]) return;
      setSwiped(null);
      // As Mail: the tap that closes an open row does only that, it does not also open the row under the finger.
      if (e.target instanceof Element && e.target.closest('.talk-rows')) {
        const eat = (c: Event) => { c.preventDefault(); c.stopPropagation(); };
        document.addEventListener('click', eat, { capture: true, once: true });
        setTimeout(() => document.removeEventListener('click', eat, { capture: true }), 600);
      }
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [swiped]);

  const setParam = (patch: Record<string, string | null>, path?: string) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v === null) next.delete(k); else next.set(k, v); }
    const qs = next.toString();
    navigate(`${path ?? location.pathname}${qs ? `?${qs}` : ''}`, { replace: !path });
  };
  const keepF = filter === 'all' ? '' : `?f=${filter}`;
  const open = (r: TalkRow) => {
    setPanel(null);
    navigate(`/messages/${r.id}${keepF}`);
  };
  const back = () => navigate(`/messages${keepF}`);
  const activeId = chatId;
  const current = chatId ? live.find((c) => c.id === chatId) ?? null : null;
  const opened = !!activeId;

  // Rows wait for the account's pins and hides too (a chat hidden on another device must not flash in), at most ~2s.
  if ((talk.isLoading && conversations.isLoading) || !prefs.ready) return <PageLoader />;

  return (
    <div className={`talk-shell${opened ? ' is-open' : ''}`} data-testid="talk">
      <h1 className="sr-only">Messages</h1>
      <ToolbarSlot title={<span className="tb-big" aria-hidden="true">Messages</span>} />
      <aside className="talk-list" aria-label="Conversations">
        <div className="talk-large" aria-hidden="true">Messages</div>
        <div className="talk-list-top">
          <label className="talk-search"><Icon name="search" size={14} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search chats" aria-label="Search Messages" />
          </label>
          {chatUsable && <StatusButton />}
          <DotsMenu label="More in Messages" items={[
            { label: 'New conversation', hint: 'Message a colleague or start a group', icon: 'plus', onSelect: () => setDialog('new'), hidden: !chatUsable },
            { label: 'Catch me up', hint: 'What you missed across your chats', icon: 'sparkle', onSelect: () => setDialog('catchup'), hidden: !chatUsable },
            { label: 'Ask the chat', hint: 'Answers from your conversations, with links', icon: 'search', onSelect: () => setDialog('ask'), hidden: !chatUsable },
            { label: 'Saved messages', icon: 'star', onSelect: () => setPanel('saved'), hidden: !chatUsable },
            { label: 'Scheduled messages', icon: 'clock', onSelect: () => setPanel('scheduled'), hidden: !chatUsable },
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
        <div className="talk-scroll" onScroll={swiped ? () => setSwiped(null) : undefined}>
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
            {/* Keyed by the filter: a new filter swaps the list at once (no outgoing rows fading over the new list or its empty state). */}
            <ul className="talk-rows" key={`${filter}:${needle}`}>
              <AnimatePresence initial={false}>
                {shown.map((r) => <Row key={r.id} r={r} conversation={r.kind === 'chat' ? live.find((c) => c.id === r.id) : undefined} active={r.id === activeId} onOpen={() => open(r)} actions={rowActions(r)} reduce={!!reduce}
                  side={swiped?.startsWith(`${r.id}|`) ? (swiped.endsWith('|l') ? 'l' : 'r') : null} onSide={(sd) => setSwiped(sd ? `${r.id}|${sd}` : null)} />)}
              </AnimatePresence>
            </ul>
          </LayoutGroup>
          {shown.length === 0 && pinnedRows.length === 0 && !talk.isLoading && (() => {
            const showAll = <button type="button" className="btn btn-ghost" onClick={() => { setSearch(''); setParam({ f: null }); }}>Show all</button>;
            const start = chatUsable ? <button type="button" className="btn btn-primary" onClick={() => setDialog('new')}>Start a conversation</button> : undefined;
            const e = needle ? { icon: 'search' as const, title: 'Nothing found', text: `No chats match “${search.trim()}”.`, action: showAll }
              : rows.length === 0 ? { icon: 'message' as const, title: 'No conversations yet', text: 'Message a colleague or start a group.', action: start }
              : filter === 'unread' ? { icon: 'checkCircle' as const, title: 'No unread messages', text: 'You’re all caught up.', action: showAll }
              : filter === 'chat' ? { icon: 'message' as const, title: 'No chats', text: 'Direct messages and groups you’re in show here.', action: showAll }
              : { icon: 'eyeOff' as const, title: 'Nothing to show', text: 'Hidden conversations come back when something new arrives.', action: start };
            return <div className="talk-empty-state" data-testid="talk-empty"><EmptyState icon={e.icon} title={e.title} text={e.text} action={e.action} /></div>;
          })()}
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
        ) : chatUsable ? (
          // Nothing open: "While you were away" (decisions on request, the first question waiting for you, the latest file).
          <WhileAway missing={false} list={live} onCatchUp={() => setDialog('catchup')} onNew={() => setDialog('new')} />
        ) : (
          <div className="talk-empty">
            <Icon name="message" size={30} />
            <h2>Pick a conversation</h2>
            <p>Your chats are on the left. Start a call or a new conversation from there.</p>
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
  const text = !last ? null : last.isMine && !last.isSystem ? `You: ${readablePreview(last.snippet)}` : c.type !== 'Direct' && last.senderName && !last.isSystem ? `${last.senderName.split(' ')[0]}: ${readablePreview(last.snippet) || 'Message deleted'}` : readablePreview(last.snippet) || 'Message deleted';
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

type RowAction = { id: string; label: string; icon: import('../../components/Icon').IconName; run: () => void; danger?: boolean; undo?: () => void; done?: string };

/** A hidden conversation stays hidden until a message newer than the one it was hidden at arrives. */
const stillHidden = (hiddenAt: string | undefined, at: string | null) => {
  if (hiddenAt === undefined) return false;
  const a = Date.parse(at ?? ''), h = Date.parse(hiddenAt);
  return Number.isNaN(a) || Number.isNaN(h) ? (at ?? '') === hiddenAt : a <= h;
};
type TalkPrefs = { pinned: string[]; hidden: Record<string, string> };
type TalkPrefsAll = Record<string, TalkPrefs>;
const EMPTY_PREFS: TalkPrefs = { pinned: [], hidden: {} };
const clean = (v: Partial<TalkPrefs> | null | undefined): TalkPrefs => ({ pinned: Array.isArray(v?.pinned) ? v!.pinned : [], hidden: v?.hidden && typeof v.hidden === 'object' ? v.hidden : {} });

/**
 * Messages' Pin and Hide: which conversations are pinned, and which are hidden until something new arrives. Saved with the account
 * (/me/ui/conversations, one entry per workspace) so they follow the person to every device; this device keeps a copy in
 * localStorage as a cache and as the fallback when the server cannot be reached.
 */
function useTalkPrefs(wid: string) {
  const key = `pm_talk_prefs:${wid}`;
  const readLocal = (): TalkPrefs => { try { return clean(JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<TalkPrefs>); } catch { return EMPTY_PREFS; } };
  const [state, setStateRaw] = useState(readLocal);
  // The newest value, so an Undo from a toast works on what is saved now, not on the render it was created in.
  const latest = useRef(state);
  const setState = (v: TalkPrefs) => { latest.current = v; setStateRaw(v); };
  const server = useWsQuery(['ui', 'conversations'], async () => { try { return (await get<{ value: TalkPrefsAll | null }>('/me/ui/conversations'))?.value ?? {}; } catch { return null; } }, { staleTime: 5 * 60_000, retry: false });
  // Ready once the account's copy has answered (or failed); if it is slow, after 2s with this device's copy.
  const [waited, setWaited] = useState(false);
  useEffect(() => { const t = setTimeout(() => setWaited(true), 2000); return () => clearTimeout(t); }, []);
  const ready = waited || !server.isLoading;
  useEffect(() => { setState(readLocal()); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // The account's copy wins once it arrives; a device that had local pins but nothing on the server uploads them once.
    const all = server.data; if (!all) return;
    const mine = all[wid];
    if (mine) { const v = clean(mine); setState(v); try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* blocked */ } }
    else { const local = readLocal(); if (local.pinned.length || Object.keys(local.hidden).length) void put('/me/ui/conversations', { value: { ...all, [wid]: local } }).catch(() => undefined); }
  }, [server.data, wid]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (next: TalkPrefs) => {
    // Keep the newest 200 hidden chats so the saved value stays small.
    const hidden = Object.fromEntries(Object.entries(next.hidden).sort((a, b) => b[1].localeCompare(a[1])).slice(0, 200));
    const v = { pinned: next.pinned, hidden };
    setState(v);
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private window: kept for this visit */ }
    if (server.data) {
      const all = { ...server.data, [wid]: v };
      queryClient.setQueryData([wid, 'ui', 'conversations'], all);
      void put('/me/ui/conversations', { value: all }).catch(() => toast('Could not save this to your account; it is kept on this device.', 'error'));
    }
  };
  return {
    ...state,
    ready,
    togglePin: (id: string) => { const cur = latest.current; save({ ...cur, pinned: cur.pinned.includes(id) ? cur.pinned.filter((x) => x !== id) : [...cur.pinned, id].slice(-8) }); },
    hide: (id: string, at: string) => { const cur = latest.current; save({ pinned: cur.pinned.filter((x) => x !== id), hidden: { ...cur.hidden, [id]: at } }); },
    unhide: (id: string) => { const cur = latest.current; const hidden = { ...cur.hidden }; delete hidden[id]; save({ ...cur, hidden }); },
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
      : <Face userId={r.avatar.userId} hasAvatar={r.avatar.hasAvatar || undefined} className={`talk-av av-c${hue(r.title)}`} style={r.avatar.userId ? { background: avatarBg(defaultTheme(r.avatar.userId)) } : undefined} text={initials} />;
}

const ACT_W = 74;          // one swipe button
const LOCK = 8;            // px before the gesture picks an axis
const FLICK = 0.45;        // px/ms: a flick opens or closes regardless of distance
const FULL = 0.6;          // share of the row width that triggers the primary action

/**
 * A Messages-style row: avatar with its source glyph (meeting ▶, a person's live status), unread blue dot on the left, name and time,
 * two lines of preview. Desktop: hover buttons (Pin · Mute · Hide) and right-click for every action. Phone: Apple Mail's swipe — the
 * gesture locks to one axis after 8px (vertical wins: the list scrolls, the row stays put), releases snap to closed or fully open by
 * distance and velocity, a full swipe runs the outermost action (Pin on the right swipe, Hide on the left) with Undo, and only one
 * row is open at a time (the list owns which one, and closes it on a tap elsewhere, a scroll, or a filter or route change).
 */
function Row({ r, conversation, active, onOpen, actions, reduce, side, onSide }: {
  r: TalkRow; conversation?: Conversation; active: boolean; onOpen: () => void; actions: RowAction[]; reduce: boolean;
  side: 'l' | 'r' | null; onSide: (s: 'l' | 'r' | null) => void;
}) {
  const channel = r.kind === 'chat' && (conversation ? conversation.type !== 'Direct' : r.group);
  const title = channel && !r.title.startsWith('#') ? `#${r.title}` : r.title;
  const iso = r.kind === 'meeting' ? r.sessionStart ?? r.at : r.at;
  const when = r.live ? 'Now' : iso ? shortTime(iso) : meetingTime(r);
  const second = r.kind === 'meeting' ? (r.live ? 'Live now' : r.sub ?? 'Meeting') : readablePreview(r.last);
  const [menu, setMenu] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);   // live offset while a finger is down; null at rest
  const anchor = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const left = actions.filter((a) => a.id === 'pin' || a.id === 'read');     // revealed by swiping right; Pin outermost
  const right = actions.filter((a) => a.id === 'mute' || a.id === 'hide');   // revealed by swiping left; Hide outermost
  const leftW = left.length * ACT_W, rightW = right.length * ACT_W;
  const rest = side === 'l' ? leftW : side === 'r' ? -rightW : 0;
  const dx = drag ?? rest;
  const live = useRef({ rest, leftW, rightW, left, right, onSide, reduce });
  live.current = { rest, leftW, rightW, left, right, onSide, reduce };
  const swallowClick = useRef(false);

  const run = (a: RowAction, full = false) => {
    onSide(null); setMenu(false); a.run();
    if (full && a.undo && a.done) toast(a.done, 'info', { label: 'Undo', onClick: a.undo });
  };

  // Native listeners: touchmove must be non-passive to stop the page scrolling sideways once the gesture is horizontal.
  useEffect(() => {
    const el = btn.current; if (!el) return;
    let s: { x: number; y: number; base: number; lock: 'h' | 'v' | null; v: number; lx: number; lt: number; cur: number } | null = null;
    const start = (e: TouchEvent) => {
      if (e.touches.length !== 1) { s = null; return; }
      const p = e.touches[0];
      s = { x: p.clientX, y: p.clientY, base: live.current.rest, lock: null, v: 0, lx: p.clientX, lt: e.timeStamp, cur: live.current.rest };
    };
    const move = (e: TouchEvent) => {
      if (!s) return;
      const p = e.touches[0], mx = p.clientX - s.x, my = p.clientY - s.y;
      if (s.lock === null) { if (Math.abs(mx) < LOCK && Math.abs(my) < LOCK) return; s.lock = Math.abs(mx) > Math.abs(my) ? 'h' : 'v'; }
      if (s.lock === 'v') return;
      e.preventDefault();
      const { leftW: lw, rightW: rw } = live.current, width = el.offsetWidth;
      let v = s.base + mx;
      const max = lw ? width : 0, min = rw ? -width : 0;
      v = Math.max(min, Math.min(max, v));
      const dt = e.timeStamp - s.lt;
      if (dt > 0) s.v = 0.8 * ((p.clientX - s.lx) / dt) + 0.2 * s.v;
      s.lx = p.clientX; s.lt = e.timeStamp; s.cur = v;
      setDrag(v);
    };
    const end = () => {
      const g = s; s = null;
      if (!g || g.lock !== 'h') return;
      swallowClick.current = true; setTimeout(() => { swallowClick.current = false; }, 350);
      const { leftW: lw, rightW: rw, left: L, right: R, onSide: set } = live.current, width = el.offsetWidth, v = g.cur;
      if (v > width * FULL && L[0]) { setDrag(null); haptic(12); run(L[0], true); return; }
      if (v < -width * FULL && R[R.length - 1]) { setDrag(null); haptic(12); run(R[R.length - 1], true); return; }
      const projected = v + g.v * 160;
      const flick = Math.abs(g.v) > FLICK;
      let next: 'l' | 'r' | null = null;
      if (v > 0 && lw) next = (flick ? g.v > 0 : projected > lw / 2) ? 'l' : null;
      else if (v < 0 && rw) next = (flick ? g.v < 0 : projected < -rw / 2) ? 'r' : null;
      if (next) haptic(8);
      setDrag(null); set(next);
    };
    const cancel = () => { s = null; setDrag(null); };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', cancel);
    return () => { el.removeEventListener('touchstart', start); el.removeEventListener('touchmove', move); el.removeEventListener('touchend', end); el.removeEventListener('touchcancel', cancel); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const hover = actions.filter((a) => a.id === 'pin' || a.id === 'mute' || a.id === 'hide');
  return (
    <motion.li layout={reduce ? false : 'position'} transition={{ type: 'spring', stiffness: 500, damping: 42 }} exit={reduce ? undefined : { opacity: 0, height: 0 }}>
      <div className={`talk-row-swipe${dx !== 0 ? ' swiping' : ''}${drag !== null ? ' dragging' : ''}`} ref={anchor} data-swipe-row={r.id} data-swipe={side ?? (drag ? 'drag' : 'closed')}>
        {dx > 0 && <div className="talk-swipe-acts l" style={{ width: Math.max(leftW, dx) }}>{left.map((a, i) => <button key={a.id} type="button" className={`sw-${a.id}${i === 0 && dx > leftW ? ' grow' : ''}`} onClick={() => run(a)}><Icon name={a.icon} size={18} />{a.label}</button>)}</div>}
        {dx < 0 && <div className="talk-swipe-acts r" style={{ width: Math.max(rightW, -dx) }}>{right.map((a, i) => <button key={a.id} type="button" className={`sw-${a.id}${i === right.length - 1 && -dx > rightW ? ' grow' : ''}`} onClick={() => run(a)}><Icon name={a.icon} size={18} />{a.label}</button>)}</div>}
        <button ref={btn} type="button" className={`talk-row k-${r.kind}${active ? ' active' : ''}${r.unread > 0 ? ' unread' : ''}`} aria-current={active ? 'true' : undefined} data-row={r.title}
          onClick={() => { if (swallowClick.current) return; if (side) { onSide(null); return; } onOpen(); }}
          style={dx ? { transform: `translate3d(${dx}px,0,0)`, transition: drag !== null || reduce ? 'none' : undefined } : undefined}
          onContextMenu={(e) => { e.preventDefault(); setMenu(true); }}>
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
        {/* Desktop (a mouse): the swipe actions as hover buttons, no drag needed. */}
        {hover.length > 0 && (
          <span className="talk-hover-acts">
            {hover.map((a) => <button key={a.id} type="button" className={a.danger ? 'danger' : ''} title={a.label} aria-label={`${a.label} ${r.title}`} onClick={() => run(a)}><Icon name={a.icon} size={14} /></button>)}
            <button type="button" title="More" aria-label={`More actions for ${r.title}`} onClick={() => setMenu(true)}><Icon name="more" size={14} /></button>
          </span>
        )}
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


/**
 * Messages: chats only. Meetings have their own place (/meetings), and Mail its own (/mail); old addresses for either move there.
 */
export function TalkPage() {
  const [params] = useSearchParams();
  // Meetings are their own place now: old addresses (?f=meetings&…, ?meeting=) move there with what they were opened with.
  if (params.get('f') === 'meetings' || params.has('meeting')) {
    const q = new URLSearchParams(params);
    q.delete('f');
    const m = q.get('meeting'); q.delete('meeting');
    if (m && !q.has('open')) q.set('open', m);
    if (q.get('new') === '1') q.set('new', 'schedule');
    const qs = q.toString();
    return <Navigate to={`/meetings${qs ? `?${qs}` : ''}${window.location.hash}`} replace />;
  }
  if (params.get('f') === 'mail' || params.has('mail')) return <Navigate to={`/mail${params.has('compose') ? '?compose=1' : ''}`} replace />;
  return <TalkHome />;
}
