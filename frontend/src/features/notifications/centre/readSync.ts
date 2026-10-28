/**
 * Read in one place, gone everywhere: when the person opens a chat (or a task, a reminder, a meeting) the notifications about it leave the
 * Notification Centre at once - the centre's lists, the counts behind the bell, the phone top bar, the tab title and the app-icon badge
 * (all read the counts query) - and the service worker closes the matching OS notifications. The server does the same for real
 * (NotificationService.MarkReadForTargetAsync) and tells every other tab and device; the caches are then refreshed from it.
 */
import type { InfiniteData } from '@tanstack/react-query';
import type { AppNotification, NotificationCategory, NotificationCounts, Paged } from '../../../api/types';
import { queryClient } from '../../../stores/auth';
import { useChat } from '../../chat/chatStore';
import { useProjectChat } from '../../chat/projectChatStore';
import { categoryOf, conversationOf } from './model';

type Pages = InfiniteData<Paged<AppNotification>, number>;

/** The notification is about this conversation (a direct / group chat, a thread in it) or this project's team chat. */
export function isAboutConversation(link: string | null | undefined, conversationId: string, projectId?: string | null): boolean {
  if (!link) return false;
  if (conversationOf(link) === conversationId) return true;
  // Also "/acme/chat/{id}?thread=..." (a push carries the organization's address in front).
  const id = /(?:^|\/)chat\/([0-9a-f-]{36})/i.exec(link)?.[1];
  if (id && id.toLowerCase() === conversationId.toLowerCase()) return true;
  return !!projectId && link.endsWith(`/projects/${projectId}?chat=1`);
}

/** Closes the OS notifications for these ids (their tag) and links on this device. */
export function closeSystemNotifications(ids: string[], links: string[] = []) {
  if (ids.length === 0 && links.length === 0) return;
  try { navigator.serviceWorker?.controller?.postMessage({ type: 'pm-read', tags: ids, links }); } catch { /* no worker */ }
}

/**
 * Marks matching unread notifications read in every loaded Notification Centre list and takes them off the counts (optimistic). Returns
 * what changed; the caller (or the live event) then invalidates so the server's numbers win.
 */
export function markReadLocally(wid: string | null | undefined, match: (n: AppNotification) => boolean): AppNotification[] {
  if (!wid) return [];
  const changed = new Map<string, AppNotification>();
  queryClient.setQueriesData<Pages>({ queryKey: [wid, 'notifications', 'centre'] }, (data) => data && ({
    ...data,
    pages: data.pages.map((p) => ({ ...p, items: p.items.map((n) => {
      if (n.isRead || !match(n)) return n;
      changed.set(n.id, n);
      return { ...n, isRead: true };
    }) })),
  }));
  if (changed.size > 0) {
    const delta: Partial<Record<NotificationCategory, number>> = {};
    for (const n of changed.values()) { const c = categoryOf(n); delta[c] = (delta[c] ?? 0) + 1; }
    queryClient.setQueryData<NotificationCounts>([wid, 'notifications', 'counts'], (c) => {
      if (!c) return c;
      const next = { ...c };
      for (const [k, d] of Object.entries(delta) as [NotificationCategory, number][]) next[k] = Math.max(0, (c[k] ?? 0) - d);
      next.unread = Math.max(0, c.unread - changed.size);
      return next;
    });
    closeSystemNotifications([...changed.keys()], [...new Set([...changed.values()].map((n) => n.link).filter((l): l is string => !!l))]);
  }
  return [...changed.values()];
}

/** The person just read a conversation here: its notifications go now (the caller refreshes from the server once it has answered). */
export function conversationReadLocally(wid: string | null | undefined, conversationId: string, projectId?: string | null) {
  markReadLocally(wid, (n) => isAboutConversation(n.link, conversationId, projectId));
}

/** The server says these were read (here or on another device): the same, by id, plus the OS notifications. */
export function readFromServer(wid: string | null | undefined, ids: string[], links: string[] = []) {
  const set = new Set(ids);
  markReadLocally(wid, (n) => set.has(n.id));
  closeSystemNotifications(ids, links);
}

/**
 * Whether the person is looking at what this notification is about right now (that conversation open in a visible, focused tab, or that
 * project's team chat open): no banner, no sound, no system notification - those messages count as read.
 */
export function isViewing(link: string | null | undefined): boolean {
  if (!link || typeof document === 'undefined' || document.hidden || !document.hasFocus()) return false;
  const open = useChat.getState().openConversation;
  if (open && isAboutConversation(link, open)) return true;
  const project = useProjectChat.getState().target?.projectId;
  return !!project && link.endsWith(`/projects/${project}?chat=1`);
}
