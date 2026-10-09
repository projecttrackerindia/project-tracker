import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { HubConnection, HubConnectionBuilder, HubConnectionState, LogLevel } from '@microsoft/signalr';
import { getAccessToken, refreshSession } from '../../api/client';
import type { ChatMessage, ChatThread, Conversation, PresenceStatus } from '../../api/types';
import { appPath } from '../../lib/orgPath';
import { firstTime, getAttention } from '../../lib/attention';
import { trackIdle } from '../../lib/idle';
import { CHECK_NOTIFICATIONS } from '../notifications/events';
import { pushCoversThisDevice, systemNotification } from '../reminders/device';
import { queryClient, useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { plainText } from './chatFormat';
import { chatKeys, useChat } from './chatStore';
import { useProjectChat } from './projectChatStore';
import { emitReminders, emitViewing, notifyLiveConnected, setLiveConnection, type ReminderEvent, type ViewingEvent } from '../live/bus';

/** Screens that show work: refreshed (if open) when someone else changes something. Chat, settings and the like have their own events or none. */
const LIVE_KEYS = new Set(['action-items', 'activity', 'approvals', 'calendar', 'dashboard', 'dashboard-report', 'dev-links', 'issues', 'milestones', 'my-work',
  'project', 'project-status', 'projects', 'sprint-tasks', 'sprints', 'task', 'timesheet', 'work', 'workload', 'capacity']);
const LIVE_THROTTLE_MS = 1200;

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

/** Tells the others in a conversation that the signed-in person is typing (the server ignores it unless they are in it). */
export function sendTyping(conversationId: string) {
  if (current?.state === HubConnectionState.Connected) void current.invoke('Typing', conversationId).catch(() => { /* typing is best effort */ });
}

/**
 * Keeps one live connection open while the app is: new messages, edits, read receipts, typing and who is online arrive as events and are
 * written straight into the cached data, so the screen updates without asking the server again. When the connection drops it reconnects
 * by itself and reloads what was missed.
 */
export function ChatRealtime() {
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx?.user.id);
  // Read through a ref: the navigate function can change with the route, and that must not restart the connection.
  const goto = useNavigate();
  const navigate = useRef(goto);
  navigate.current = goto;

  useEffect(() => {
    if (!wid || !me) return;
    const chat = useChat.getState();
    chat.reset();
    let stopped = false;
    let retry: number | undefined;

    const connection = new HubConnectionBuilder()
      .withUrl(`${BASE}/hubs/chat`, { accessTokenFactory: freshToken })
      .withAutomaticReconnect([0, 2000, 5000, 10000, 20000, 30000])
      .configureLogging(LogLevel.None)
      .build();
    current = connection;
    setLiveConnection(connection);

    // Tell the server when this tab goes idle (5 minutes without keyboard, mouse or touch) and when the person is back, so they show as
    // Away instead of Active. A connection starts out active, so after (re)connecting only an idle tab has anything to say.
    const sendIdle = (idle: boolean) => { if (connection.state === HubConnectionState.Connected) void connection.invoke('SetIdle', idle).catch(() => { /* best effort */ }); };
    const idle = trackIdle(sendIdle);

    // Live updates: someone changed something - refresh the work screens that are open (at most about once a second).
    let liveTimer: number | undefined;
    const refreshWork = () => {
      if (liveTimer) return;
      liveTimer = window.setTimeout(() => {
        liveTimer = undefined;
        void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === wid && LIVE_KEYS.has(String(q.queryKey[1])) });
      }, LIVE_THROTTLE_MS);
    };
    connection.on('changed', (changes: { actorId: string | null }[]) => {
      // This tab already refreshed what it changed itself; other people's changes (and my other tabs') are news.
      if (changes.every((c) => c.actorId === me) && !document.hidden) return;
      if (changes.some((c) => c.actorId !== me)) window.dispatchEvent(new Event(CHECK_NOTIFICATIONS));   // someone else's change may have notified me
      refreshWork();
    });
    connection.on('viewing', (e: ViewingEvent) => emitViewing(e));
    connection.on('reminder', (e: ReminderEvent[]) => emitReminders(e));

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

    const notify = (conversationId: string, message: ChatMessage) => {
      const conversation = queryClient.getQueryData<Conversation[]>(chatKeys.conversations(wid))?.find((c) => c.id === conversationId);
      if (conversation?.isMuted) return;
      const text = message.body.length > 120 ? `${message.body.slice(0, 119)}…` : message.body;
      const title = conversation && conversation.type === 'Group' ? `${message.senderName} in ${conversation.name}` : (message.senderName ?? 'New message');
      const open = () => { window.focus(); navigate.current(`/chat/${conversationId}`); };
      if (!firstTime(`chat-${message.id}`)) return;
      getAttention({ kind: 'message' });
      // In another tab, another window or another app (not only a hidden tab): the system shows it. When push is on for this device the
      // server's push already brings it (and respects the person's "Chat messages" choice), so the page does not add a second one.
      if (away()) { if (!pushCoversThisDevice()) void systemNotification(title, text, `chat-${conversationId}`, `/chat/${conversationId}`, { sticky: false }); }
      else if (!appPath(useAuth.getState().ctx?.current?.slug).startsWith('/chat')) {
        toast(`${title}: ${text}`, 'info', { label: 'Open', onClick: open });
      }
    };

    // A message in a project's team chat only raises an alert when it @mentions you (the icon on the project shows the unread count either way).
    const notifyMention = (projectId: string, projectName: string, message: ChatMessage) => {
      const text = plainText(message.body).length > 120 ? `${plainText(message.body).slice(0, 119)}…` : plainText(message.body);
      const title = `${message.senderName ?? 'Someone'} mentioned you in ${projectName}`;
      const open = () => { window.focus(); useProjectChat.getState().openChat(projectId, projectName); };
      if (!firstTime(`chat-${message.id}`)) return;
      getAttention({ kind: 'message' });
      if (away()) { if (!pushCoversThisDevice()) void systemNotification(title, text, `pchat-${projectId}`, '/chat', { sticky: false }); }
      else toast(`${title}: ${text}`, 'info', { label: 'Open', onClick: open });
    };

    connection.on('message', (e: { conversationId: string; message: ChatMessage; projectId?: string | null; conversationName?: string | null; mentioned?: string[] }) => {
      putInThread(e.conversationId, e.message, false);
      if (e.message.senderId) useChat.getState().clearTyping(e.conversationId, e.message.senderId);
      refreshLists();
      const viewing = useChat.getState().openConversation === e.conversationId && !away();
      if (e.message.kind !== 'User' || e.message.senderId === me || viewing) return;
      if (e.projectId) { if (e.mentioned?.includes(me)) notifyMention(e.projectId, e.conversationName ?? 'a project', e.message); return; }
      notify(e.conversationId, e.message);
    });
    // Somebody just created a notification for me (a mention): refresh the bell now instead of at the next poll.
    connection.on('notification', () => { void queryClient.invalidateQueries({ queryKey: [wid, 'notifications'] }); window.dispatchEvent(new Event(CHECK_NOTIFICATIONS)); });
    connection.on('message.updated', (e: { conversationId: string; message: ChatMessage }) => {
      putInThread(e.conversationId, e.message, true);
      refreshLists();
    });
    connection.on('conversation', () => refreshLists());
    connection.on('read', (e: { conversationId: string; userId: string; at: string }) => {
      queryClient.setQueryData<Conversation[]>(chatKeys.conversations(wid), (old) => old?.map((c) => c.id !== e.conversationId ? c
        : { ...c, members: c.members.map((m) => (m.userId === e.userId ? { ...m, lastReadAt: e.at } : m)) }));
    });
    connection.on('typing', (e: { conversationId: string; userId: string; name: string | null }) => useChat.getState().markTyping(e.conversationId, e.userId, e.name ?? 'Someone'));
    connection.on('presence', (e: { userId: string; online: boolean; status?: PresenceStatus }) => useChat.getState().setOnline(e.userId, e.online, e.status));

    connection.onreconnecting(() => useChat.getState().setLink('reconnecting'));
    connection.onreconnected(() => {
      useChat.setState({ link: 'connected', online: {}, status: {} });         // presence may have changed while offline
      if (idle.isIdle()) sendIdle(true);
      void queryClient.invalidateQueries({ queryKey: chatKeys.all(wid) });    // and so may everything else
      notifyLiveConnected();                                                  // open tasks announce their viewers again
      refreshWork();
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
        void queryClient.invalidateQueries({ queryKey: chatKeys.all(wid) });
      } catch {
        if (stopped) return;
        useChat.getState().setLink('offline');
        retry = window.setTimeout(() => void start(), RETRY_MS);
      }
    };
    void start();

    return () => {
      stopped = true;
      window.clearTimeout(retry);
      window.clearTimeout(liveTimer);
      idle.stop();
      if (current === connection) { current = null; setLiveConnection(null); }
      void connection.stop();
    };
  }, [wid, me]);

  return null;
}
