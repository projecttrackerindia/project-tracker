import { openMessage } from './e2e/session';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { HubConnection } from '@microsoft/signalr';
import { get, getAccessToken, refreshSession } from '../../api/client';
import { chatApi } from '../../api/endpoints';
import type { ChatMessage, ChatThread, Conversation, PresenceStatus } from '../../api/types';
import { appPath } from '../../lib/orgPath';
import { firstTime, getAttention } from '../../lib/attention';
import { getAlertPrefs, isMuted, maySound } from '../notifications/centre/prefs';
import { trackIdle } from '../../lib/idle';
import { createRefreshQueue, type RefreshQueue } from '../../lib/refreshQueue';
import { CHECK_NOTIFICATIONS } from '../notifications/events';
import { readFromServer } from '../notifications/centre/readSync';
import { queryClient, useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { plainText } from './chatFormat';
import { chatKeys, useChat } from './chatStore';
import { markAnswered, putMessage } from './chatCache';
import { useProjectChat } from './projectChatStore';
import { bumpUnread, dropUnread, useUnreadCatchUp } from './unreadBadge';
import { emitCallEvent } from '../calls/incomingCalls';
import { committedHereRecently } from '../../lib/mutationEffects';
import { createSync, type SyncEvent } from '../live/realtimeSync';
import { emitReminders, emitSheetFocus, emitViewing, notifyLiveConnected, setLiveConnection, type ReminderEvent, type SheetFocusEvent, type ViewingEvent } from '../live/bus';

/** Screens that show work: refreshed (if open) when someone else changes something. Chat, settings and the like have their own events or none. */
const LIVE_KEYS = new Set(['action-items', 'activity', 'approvals', 'calendar', 'dashboard', 'dashboard-report', 'dev-links', 'issues', 'milestones', 'my-work',
  'project', 'project-status', 'projects', 'sprint-tasks', 'sprints', 'task', 'tasks', 'time', 'timer', 'timesheet', 'timeline', 'work-items', 'work', 'workload', 'capacity', 'portfolio', 'plan-sheet']);
const LIVE_THROTTLE_MS = 150;

/** The person is in another tab, another window or another app. */
const away = () => document.hidden || !document.hasFocus();

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
const RETRY_MS = 10_000;        // after a failed attempt
const REOPEN_MS = 1_000;        // after the server closed the connection on purpose (the access token ran out)

/** Seconds since 1970 at which the access token stops being valid (0 if it cannot be read). */
function tokenExpiry(token: string | null): number {
  try {
    const payload = JSON.parse(atob((token ?? '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return Number(payload.exp) || 0;
  } catch { return 0; }
}

/** The connection asks for a token each time it (re)connects, so a token that has expired is refreshed first. */
async function freshToken(): Promise<string> {
  let token = getAccessToken();
  if (!token || tokenExpiry(token) - Date.now() / 1000 < 30) token = (await refreshSession())?.accessToken ?? getAccessToken();
  return token ?? '';
}

let current: HubConnection | null = null;
let liveSync: ReturnType<typeof createSync> | null = null;
/** Runs the realtime catch-up now (for example right after a push woke the app). */
export const catchUpNow = () => liveSync?.catchUp();

/** End-to-end latency of live changes (server commit → this tab), kept for the realtime checks and the diagnostics panel. */
const latencies: number[] = [];
function markLatency(events: SyncEvent[]) {
  const now = Date.now();
  for (const e of events) if (e.at) { const ms = now - Date.parse(e.at); if (Number.isFinite(ms)) latencies.push(ms); }
  if (latencies.length > 200) latencies.splice(0, latencies.length - 200);
  (window as unknown as { __pmLiveLatency?: number[] }).__pmLiveLatency = latencies;
}

/**
 * The connection library is fetched when the live connection is first opened (after signing in), not with the first page: it is a fair
 * share of the app's code and the sign-in screens never use it.
 */
type SignalR = typeof import('@microsoft/signalr');
let signalr: SignalR | null = null;
let loading: Promise<SignalR> | null = null;
const loadSignalR = () => (loading ??= import('@microsoft/signalr').then((m) => (signalr = m)).catch((e) => { loading = null; throw e; }));

/** Tells the others in a conversation that the signed-in person is typing (the server ignores it unless they are in it). */
export function sendTyping(conversationId: string) {
  if (signalr && current?.state === signalr.HubConnectionState.Connected) void current.invoke('Typing', conversationId).catch(() => { /* typing is best effort */ });
}

/**
 * Keeps one live connection open while the app is: new messages, edits, read receipts, typing and who is online arrive as events and are
 * written straight into the cached data, so the screen updates without asking the server again. When the connection drops it reconnects
 * by itself and reloads what was missed.
 */
export function ChatRealtime({ chat: chatOn = true }: { chat?: boolean } = {}) {
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx?.user.id);
  // Read through a ref: the navigate function can change with the route, and that must not restart the connection.
  const goto = useNavigate();
  const navigate = useRef(goto);
  navigate.current = goto;
  const [hub, setHub] = useState<SignalR | null>(signalr);
  const [attempt, setAttempt] = useState(0);
  useUnreadCatchUp(chatOn ? wid : null);

  useEffect(() => {
    if (!wid || !me || hub) return;
    let off = false;
    let again: number | undefined;
    loadSignalR().then((m) => { if (!off) setHub(m); })
      .catch(() => { if (!off) again = window.setTimeout(() => setAttempt((n) => n + 1), RETRY_MS); });   // offline: try again later
    return () => { off = true; window.clearTimeout(again); };
  }, [wid, me, hub, attempt]);

  useEffect(() => {
    if (!wid || !me || !hub) return;
    const chat = useChat.getState();
    chat.reset();
    let stopped = false;
    let retry: number | undefined;

    // WebSocket first; where a proxy or network blocks it, Server-Sent Events, then long polling (the same hub, the same events).
    const connection = new hub.HubConnectionBuilder()
      .withUrl(`${BASE}/hubs/chat`, { accessTokenFactory: freshToken,
        transport: hub.HttpTransportType.WebSockets | hub.HttpTransportType.ServerSentEvents | hub.HttpTransportType.LongPolling })
      .withAutomaticReconnect([0, 2000, 5000, 10000, 20000, 30000])
      .configureLogging(hub.LogLevel.None)
      .build();
    current = connection;
    setLiveConnection(connection);

    // Tell the server when this tab goes idle (5 minutes without keyboard, mouse or touch) and when the person is back, so they show as
    // Away instead of Active. A connection starts out active, so after (re)connecting only an idle tab has anything to say.
    const sendIdle = (idle: boolean) => { if (connection.state === hub.HubConnectionState.Connected) void connection.invoke('SetIdle', idle).catch(() => { /* best effort */ }); };
    const idle = trackIdle(sendIdle);

    // Everything else that is not chat: open work screens reload (all of them) only when the realtime catch-up says the gap is too old.
    const matchesWork = (q: { queryKey: readonly unknown[] }) => q.queryKey[0] === wid && LIVE_KEYS.has(String(q.queryKey[1]));
    const liveQueue: RefreshQueue = createRefreshQueue(async () => {
      const wasFetching = queryClient.getQueryCache().findAll({ predicate: (q) => matchesWork(q) && q.isActive() }).some((q) => q.state.fetchStatus === 'fetching');
      await queryClient.invalidateQueries({ predicate: matchesWork }, { cancelRefetch: false });
      if (wasFetching) liveQueue.request();
    }, LIVE_THROTTLE_MS);
    const refreshWork = liveQueue.request;
    // Realtime sync (features/live/realtimeSync.ts): each change marks exactly the reads it touches; versions make the catch-up exact.
    const sync = createSync({
      client: queryClient, wid, me,
      ownRecent: () => committedHereRecently(),
      onForeign: () => window.dispatchEvent(new Event(CHECK_NOTIFICATIONS)),   // someone else's change may have notified me
      onScope: () => { if (connection.state === hub.HubConnectionState.Connected) void connection.invoke('RefreshScope').catch(() => undefined); },
      onReset: refreshWork,
      load: (since) => get<{ version: number; reset: boolean; changes: SyncEvent[] }>('/realtime/changes', { since }),
    });
    liveSync = sync;
    connection.on('sync', (events: SyncEvent[]) => { markLatency(events); sync.apply(events); });
    // The older, coarser event (still sent for apps that have not updated): covered by "sync" above.
    connection.on('changed', () => { /* superseded by "sync" */ });
    connection.on('viewing', (e: ViewingEvent) => emitViewing(e));
    connection.on('sheetFocus', (e: SheetFocusEvent) => emitSheetFocus(e));
    connection.on('reminder', (e: ReminderEvent[]) => emitReminders(e));
    // Calls: one ringing for me, one that stopped ringing (ended, missed, or declined on another device), my call turned down.
    connection.on('call.incoming', (e: { callId: string; title?: string; fromName?: string; startedAt?: string }) => emitCallEvent({ event: 'incoming', ...e }));
    connection.on('call.stopped', (e: { callId: string; reason?: string }) => emitCallEvent({ event: 'stopped', ...e }));
    // "Single active session": a new device of mine asks to sign in; the question was answered; this session was replaced.
    connection.on('sessionApproval', (p: unknown) => window.dispatchEvent(new CustomEvent('pm:session-approval', { detail: p })));
    connection.on('sessionApprovalClosed', (p: unknown) => window.dispatchEvent(new CustomEvent('pm:session-approval-closed', { detail: p })));
    connection.on('sessionEnded', (p: unknown) => window.dispatchEvent(new CustomEvent('pm:session-ended', { detail: p })));
    connection.on('call.declined', (e: { callId: string; name?: string }) => emitCallEvent({ event: 'declined', ...e }));

    const refreshLists = () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.conversations(wid) });
      void queryClient.invalidateQueries({ queryKey: chatKeys.unread(wid) });
      void queryClient.invalidateQueries({ queryKey: chatKeys.projectUnread(wid) });
      void queryClient.invalidateQueries({ queryKey: [wid, 'chat', 'project'] });   // the open project chats (their unread numbers)
    };

    const putInThread = (conversationId: string, message: ChatMessage, replace: boolean) =>
      queryClient.setQueryData<ChatThread>(chatKeys.thread(wid, conversationId), (old) => {
        if (!old) return old;                                   // that thread is not loaded: it will be fetched fresh when opened
        const exists = old.items.some((m) => m.id === message.id);
        if (exists) return replace ? { ...old, items: old.items.map((m) => (m.id === message.id ? message : m)) } : old;
        return replace ? old : { ...old, items: [...old.items, message] };
      });

    // Do not disturb: no toasts or system pop-ups for messages (they are still in the list and the bell).
    const quiet = () => !!queryClient.getQueryData<{ dnd?: boolean }>(chatKeys.myStatus(wid))?.dnd;
    const notify = (conversationId: string, message: ChatMessage, mentioned: boolean) => {
      if (quiet()) return;
      const conversation = queryClient.getQueryData<Conversation[]>(chatKeys.conversations(wid))?.find((c) => c.id === conversationId);
      if (conversation?.isMuted && !mentioned) return;   // a muted chat stays silent - unless it @mentions me
      // A private message never shows its words outside the conversation (an in-app toast can be seen over a shoulder or on a shared screen).
      const text = message.cipher ? '🔒 New private message' : message.body.length > 120 ? `${message.body.slice(0, 119)}…` : message.body;
      const title = conversation && conversation.type === 'Group' ? `${message.senderName} in ${conversation.name}` : (message.senderName ?? 'New message');
      const open = () => { window.focus(); navigate.current(`/messages/${conversationId}`); };
      if (!firstTime(`chat-${message.id}`)) return;
      const p = getAlertPrefs();
      getAttention({ kind: 'message', cue: mentioned ? 'mention' : 'message', mention: mentioned, mutedChat: !!conversation?.isMuted, dnd: p.dnd, muted: isMuted(p), categoryOn: p.cats.messages.sound && maySound('messages', p) });
      // DesktopNotifier uses the server notice id and channel preference for coordinated OS delivery.
      if (away()) window.dispatchEvent(new Event(CHECK_NOTIFICATIONS));
      else if (!appPath(useAuth.getState().ctx?.current?.slug).startsWith('/messages')) {
        toast(`${title}: ${text}`, 'info', { label: 'Open', onClick: open });
      }
    };

    // A message in a project's team chat only raises an alert when it @mentions you (the icon on the project shows the unread count either way).
    const notifyMention = (projectId: string, projectName: string, message: ChatMessage) => {
      if (quiet()) return;
      const text = plainText(message.body).length > 120 ? `${plainText(message.body).slice(0, 119)}…` : plainText(message.body);
      const title = `${message.senderName ?? 'Someone'} mentioned you in ${projectName}`;
      const open = () => { window.focus(); useProjectChat.getState().openChat(projectId, projectName); };
      if (!firstTime(`chat-${message.id}`)) return;
      const p = getAlertPrefs();
      getAttention({ kind: 'message', cue: 'mention', mention: true, dnd: p.dnd, muted: isMuted(p), categoryOn: maySound('messages', p) });
      if (away()) window.dispatchEvent(new Event(CHECK_NOTIFICATIONS));
      else toast(`${title}: ${text}`, 'info', { label: 'Open', onClick: open });
    };

    // Private chats: the envelope is opened on this device before anything (thread, list, notification) sees the message.
    type MessageEvent = { conversationId: string; message: ChatMessage; projectId?: string | null; conversationName?: string | null; mentioned?: string[] };
    connection.on('message', (raw: MessageEvent) => { void openMessage(raw.message).then((message) => onMessage({ ...raw, message })); });
    const onMessage = (e: MessageEvent) => {
      // A reply inside a thread goes to that thread (its first message's count comes as an update); the conversation itself is unchanged.
      if (e.message.threadRootId) {
        putMessage(wid, e.message);
        if (e.message.senderId) useChat.getState().clearTyping(e.conversationId, e.message.senderId);
        if (e.message.senderId === me) markAnswered(wid, e.message);   // my reply (from here or another device) answers what came before it
        else void queryClient.invalidateQueries({ queryKey: chatKeys.questions(wid) });
        return;
      }
      putInThread(e.conversationId, e.message, false);
      // A question to me adds to "Waiting for your answer"; my own message (sent here or on another device) answers what came before it.
      if (e.message.senderId === me) markAnswered(wid, e.message);
      else void queryClient.invalidateQueries({ queryKey: chatKeys.questions(wid) });
      if (e.message.senderId) useChat.getState().clearTyping(e.conversationId, e.message.senderId);
      const viewing = useChat.getState().openConversation === e.conversationId && !away();
      // The Messages badge moves now (docs/badges.md); the refetch below settles it. Muted chats only count @mentions of me.
      if (!e.projectId && e.message.kind === 'User' && e.message.senderId !== me && !viewing) {
        const conv = queryClient.getQueryData<Conversation[]>(chatKeys.conversations(wid))?.find((c) => c.id === e.conversationId);
        bumpUnread(wid, conv?.isMuted && !e.mentioned?.includes(me) ? 'dot' : 'count');
        queryClient.setQueryData<Conversation[]>(chatKeys.conversations(wid), (old) => old?.map((c) => (c.id === e.conversationId ? { ...c, unread: c.unread + 1 } : c)));
      }
      refreshLists();
      if (e.message.kind !== 'User' || e.message.senderId === me || viewing) return;
      if (e.projectId) { if (e.mentioned?.includes(me)) notifyMention(e.projectId, e.conversationName ?? 'a project', e.message); return; }
      notify(e.conversationId, e.message, !!e.mentioned?.includes(me));
    };
    // Somebody just created a notification for me (a mention): refresh the bell now instead of at the next poll.
    // A WhatsApp support chat changed (a message came in or went out, someone took it): the desk refreshes at once.
    connection.on('support', () => { void queryClient.invalidateQueries({ queryKey: [wid, 'support'] }); });
    // Or some were read (opened here, on another tab or another device): they leave the centre, the badges and the OS notifications now.
    // Also every new notification for me (the server announces each one once it is saved: approvals, assignments, mentions, reminders...):
    // the bell and tab badges recount now, and the banner / sound / desktop notice run (CHECK_NOTIFICATIONS) instead of waiting for a poll.
    connection.on('notification', (e?: { read?: string[]; links?: string[]; created?: string[]; types?: string[] }) => {
      if (e?.read?.length) readFromServer(wid, e.read, e.links ?? []);
      void queryClient.invalidateQueries({ queryKey: [wid, 'notifications'] });
      // An approval waiting on me (or a decision on mine): the Approvals badge and list are separate counts, so they refresh too.
      if (e?.types?.includes('Approval')) void queryClient.invalidateQueries({ queryKey: [wid, 'approvals'] });
      if (e?.types?.some((t) => t === 'TaskAssigned' || t === 'Mention' || t === 'Comment')) void queryClient.invalidateQueries({ queryKey: [wid, 'inbox'] });
      if (!e?.read?.length) window.dispatchEvent(new Event(CHECK_NOTIFICATIONS));
    });
    connection.on('message.updated', (raw: { conversationId: string; message: ChatMessage }) => { void openMessage(raw.message).then((message) => onUpdated({ ...raw, message })); });
    const onUpdated = (e: { conversationId: string; message: ChatMessage }) => {
      putMessage(wid, e.message);
      putInThread(e.conversationId, e.message, true);
      refreshLists();
    };
    connection.on('conversation', () => refreshLists());   // also my own mute / unmute from another device: the badge recounts
    connection.on('read', (e: { conversationId: string; userId: string; at: string }) => {
      if (e.userId === me) {
        // I read it - in this tab, another tab or on another device: its unread leaves every badge now, then the server's numbers settle it.
        const conv = queryClient.getQueryData<Conversation[]>(chatKeys.conversations(wid))?.find((c) => c.id === e.conversationId);
        if (conv) dropUnread(wid, conv.unread, conv.isMuted);
        queryClient.setQueryData<Conversation[]>(chatKeys.conversations(wid), (old) => old?.map((c) => (c.id === e.conversationId ? { ...c, unread: 0, unreadMentions: 0 } : c)));
        void queryClient.invalidateQueries({ queryKey: chatKeys.unread(wid) });
        void queryClient.invalidateQueries({ queryKey: [wid, 'talk'] });
        void queryClient.invalidateQueries({ queryKey: [wid, 'notifications'] });
        return;
      }
      queryClient.setQueryData<Conversation[]>(chatKeys.conversations(wid), (old) => old?.map((c) => c.id !== e.conversationId ? c
        : { ...c, members: c.members.map((m) => (m.userId === e.userId ? { ...m, lastReadAt: e.at } : m)) }));
    });
    connection.on('typing', (e: { conversationId: string; userId: string; name: string | null }) => useChat.getState().markTyping(e.conversationId, e.userId, e.name ?? 'Someone'));
    // Someone changed their status line or do-not-disturb: their member rows show it at once.
    connection.on('status', (e: { userId: string; emoji: string | null; text: string | null; dnd: boolean }) => {
      queryClient.setQueryData<Conversation[]>(chatKeys.conversations(wid), (old) => old?.map((c) => ({ ...c,
        members: c.members.map((m) => (m.userId === e.userId ? { ...m, statusEmoji: e.emoji, statusText: e.text, dnd: e.dnd } : m)) })));
    });
    connection.on('presence', (e: { userId: string; online: boolean; status?: PresenceStatus }) => useChat.getState().setOnline(e.userId, e.online, e.status));

    connection.onreconnecting(() => useChat.getState().setLink('reconnecting'));
    connection.onreconnected(() => {
      useChat.setState({ link: 'connected', online: {}, status: {} });         // presence may have changed while offline
      if (idle.isIdle()) sendIdle(true);
      if (chatOn) void queryClient.invalidateQueries({ queryKey: chatKeys.all(wid) });    // and so may chat
      notifyLiveConnected();                                                  // open tasks announce their viewers again
      void sync.catchUp();                                                    // exactly what was missed while the link was down
    });
    connection.onclose(() => {
      if (stopped) return;
      useChat.getState().setLink('reconnecting');
      // The server closes the connection when the access token runs out, and automatic reconnect only handles errors: open it again
      // with a fresh token (this also covers automatic reconnect giving up: a failed attempt then backs off to RETRY_MS).
      retry = window.setTimeout(() => void start(), REOPEN_MS);
    });

    const start = async () => {
      if (stopped) return;
      try {
        useChat.getState().setLink('connecting');
        await connection.start();
        if (stopped) return;
        useChat.getState().setLink('connected');
        if (idle.isIdle()) sendIdle(true);
        notifyLiveConnected();
        void sync.catchUp();   // the starting version, or (after the app slept or was closed) what changed meanwhile
        if (chatOn) void queryClient.prefetchQuery({ queryKey: chatKeys.myStatus(wid), queryFn: () => chatApi.status(), staleTime: 60_000 });   // do not disturb
        // Catch up on anything sent before the live link was up - but not data that was fetched a moment ago (no double requests on load).
        if (chatOn) void queryClient.invalidateQueries({ queryKey: chatKeys.all(wid), predicate: (q) => Date.now() - q.state.dataUpdatedAt > 5000 });
      } catch {
        if (stopped) return;
        useChat.getState().setLink('offline');
        retry = window.setTimeout(() => void start(), RETRY_MS);
      }
    };
    void start();

    // Waking up: a phone brought back to the front, a laptop opened, the network back. The socket may have died silently while the app was
    // in the background (the push brought the alerts meanwhile): catch up at once, and reconnect if the link is gone.
    const wake = () => {
      if (document.visibilityState === 'hidden') return;
      void sync.catchUp();
      if (connection.state === hub.HubConnectionState.Disconnected) { window.clearTimeout(retry); void start(); }
    };
    document.addEventListener('visibilitychange', wake);
    document.addEventListener('resume', wake);   // Capacitor / Cordova: the app came back from the background
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    // Heartbeat: the transport's keep-alive covers a dead socket; this also notices a link that is up but stalled (a sleeping proxy).
    const beat = window.setInterval(() => {
      if (document.visibilityState === 'hidden' || connection.state !== hub.HubConnectionState.Connected) return;
      const t = window.setTimeout(() => { void connection.stop(); }, 10_000);   // onclose opens it again
      void connection.invoke('Ping').then(() => window.clearTimeout(t), () => window.clearTimeout(t));
    }, 30_000);
    // The slow safety net (instead of each screen polling every 30-60 s): every 5 minutes, the catch-up and the project groups.
    const safety = window.setInterval(() => {
      void sync.catchUp();
      if (connection.state === hub.HubConnectionState.Connected) void connection.invoke('RefreshScope').catch(() => undefined);
    }, 5 * 60_000);

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', wake);
      document.removeEventListener('resume', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      window.clearInterval(beat);
      window.clearInterval(safety);
      sync.dispose();
      if (liveSync === sync) liveSync = null;
      window.clearTimeout(retry);
      liveQueue.dispose();
      idle.stop();
      if (current === connection) { current = null; setLiveConnection(null); }
      void connection.stop();
    };
  }, [wid, me, hub, chatOn]);

  return null;
}

