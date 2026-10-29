/**
 * The Messages badge (docs/badges.md). One server number, GET /chat/unread, read by every place that shows it: the sidebar's Messages
 * item, the phone tab bar, the tab title, the app icon (through the Notification Centre's total) and the desktop app's dock / taskbar.
 *
 *  - count: messages from others after my read pointer in direct and group chats; muted chats add only their @mentions of me.
 *  - mutedActivity: something unread sits in a muted chat (no number: a grey dot when nothing else counts).
 *
 * Live: a message, a read (here, in another tab or on another device), a mute or a hide changes the cached number at once and the
 * server's answer settles it; coming back to the app (tab shown, window focused, network back) asks again, because a phone that slept
 * may have missed live events.
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../api/client';
import { queryClient, useAuth } from '../../stores/auth';
import { chatKeys } from './chatStore';

export interface ChatUnread { count: number; conversations?: number; mutedMentions?: number; mutedActivity?: boolean }

/** What the badge shows: a number (99+ past 99), a grey dot for muted-only activity, or nothing. */
export function badgeOf(u: ChatUnread | undefined): { n: number; dot: boolean; text: string } {
  const n = Math.max(0, u?.count ?? 0);
  return { n, dot: n === 0 && !!u?.mutedActivity, text: n > 99 ? '99+' : n > 0 ? String(n) : '' };
}

export function useCanChat() {
  const ctx = useAuth((s) => s.ctx);
  return !!ctx?.current && ctx.current.type !== 'Personal' && ctx.current.role !== 'Guest' && !ctx.user.isPlatformAdmin;
}

export function useChatUnread(): ChatUnread {
  const wid = useAuth((s) => s.ctx?.current?.id);
  const canChat = useCanChat();
  const q = useQuery({
    queryKey: chatKeys.unread(wid ?? ''), queryFn: () => get<ChatUnread>('/chat/unread'),
    enabled: !!wid && canChat, refetchInterval: 90_000, staleTime: 30_000,
  });
  return canChat && q.data ? q.data : { count: 0 };
}

/** A message from someone else just arrived: the number goes up now (the refetch that follows settles it). */
export function bumpUnread(wid: string, by: 'count' | 'dot') {
  queryClient.setQueryData<ChatUnread>(chatKeys.unread(wid), (old) => old && (by === 'count' ? { ...old, count: old.count + 1 } : { ...old, mutedActivity: true }));
}

/** A conversation was read (here or elsewhere) or hidden: take its messages off the number now. */
export function dropUnread(wid: string, conversationUnread: number, muted: boolean) {
  if (muted || conversationUnread <= 0) return;
  queryClient.setQueryData<ChatUnread>(chatKeys.unread(wid), (old) => old && { ...old, count: Math.max(0, old.count - conversationUnread) });
}

/** Coming back to the app re-asks the server (a sleeping phone misses live events). At most once every 2 seconds. */
export function useUnreadCatchUp(wid: string | null | undefined) {
  useEffect(() => {
    if (!wid) return;
    let last = 0;
    const again = () => {
      if (document.hidden || Date.now() - last < 2000) return;
      last = Date.now();
      void queryClient.invalidateQueries({ queryKey: chatKeys.unread(wid) });
      void queryClient.invalidateQueries({ queryKey: chatKeys.conversations(wid) });
      void queryClient.invalidateQueries({ queryKey: [wid, 'notifications', 'counts'] });
    };
    document.addEventListener('visibilitychange', again);
    window.addEventListener('focus', again);
    window.addEventListener('online', again);
    window.addEventListener('pageshow', again);
    return () => {
      document.removeEventListener('visibilitychange', again); window.removeEventListener('focus', again);
      window.removeEventListener('online', again); window.removeEventListener('pageshow', again);
    };
  }, [wid]);
}
