/**
 * The Notification Centre: the bell just left of + New (and in the phone's top bar), with an Apple-style red badge, and the panel it opens
 * — a popover on a computer, a full-height sheet on a phone. Notifications, reminders, meeting reminders and messages, filtered (All ·
 * Mentions & messages · Reminders · Meetings · Work), grouped into Today and Earlier and stacked by where they come from. Each one opens
 * what it is about; from the card itself a message can be answered, a meeting joined, a reminder done or snoozed, and anything marked
 * read or unread, snoozed or deleted (hover on a computer, swipe left on a phone).
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { notificationApi } from '../../../api/endpoints';
import type { NotificationCategory } from '../../../api/types';
import { isDesktopApp } from '../../../lib/desktop';
import { haptic } from '../../../lib/mobile';
import { unlockSound } from '../../../lib/attention';
import { queryClient, useAuth } from '../../../stores/auth';
import { chatKeys } from '../../chat/chatStore';
import { useChatUnread } from '../../chat/unreadBadge';
import { CHECK_NOTIFICATIONS } from '../events';
import { applyBadge, clearBadge } from './badge';
import { badgeText, totalBadge } from './model';
import { useAlertPrefs } from './prefs';
import { tabCounts, type TabCounts } from './tabBadges';
import '../../../styles/notification-centre-apple.css';

export type Filter = NotificationCategory | 'all';

export const useCentre = create<{ open: boolean; toggle: () => void; close: () => void; show: () => void }>((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
  show: () => set({ open: true }),
}));
export const openNotificationCentre = () => useCentre.getState().show();

// ------------------------------------------------------------------ counts and the badge

/**
 * Unread by category: the one query every badge reads. Live through the realtime connection (a new notification invalidates it), plus a
 * quiet check every minute while the page is visible — the desktop app keeps checking while it sits in the tray.
 */
export function useNotificationCounts() {
  const wid = useAuth((s) => s.ctx?.current?.id ?? null);
  const admin = useAuth((s) => !!s.ctx?.user.isPlatformAdmin);
  return useQuery({
    queryKey: [wid, 'notifications', 'counts'], queryFn: notificationApi.counts, enabled: !!wid && !admin,
    refetchInterval: 60_000, refetchIntervalInBackground: isDesktopApp(), staleTime: 15_000,
  });
}

export function useBadge(): number {
  const prefs = useAlertPrefs();
  const counts = useNotificationCounts();
  const chat = useChatUnread();
  return totalBadge(counts.data, prefs, chat.count);
}

/** The red number on each sidebar place (and phone tab), from the same answer as the bell: they add up to it (docs/badges.md). */
export function useTabBadges(): TabCounts {
  const prefs = useAlertPrefs();
  const counts = useNotificationCounts();
  const chat = useChatUnread();
  return tabCounts(counts.data, prefs, chat.count);
}

/**
 * Keeps the tab title, favicon, app-icon badge and desktop-app badge on the bell's number, and refreshes the related badges (Messages, Today,
 * Desk) when the live connection says something arrived — once per burst, not once per event.
 */
export function BadgeSync() {
  const wid = useAuth((s) => s.ctx?.current?.id ?? null);
  const n = useBadge();
  useEffect(() => { if (wid) applyBadge(n); }, [n, wid]);
  useEffect(() => () => clearBadge(), []);
  useEffect(() => {
    if (!wid) return;
    let t: number | undefined;
    const burst = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: [wid, 'notifications'] });
        void queryClient.invalidateQueries({ queryKey: chatKeys.unread(wid) });
        void queryClient.invalidateQueries({ queryKey: [wid, 'inbox'] });
      }, 400);
    };
    const back = () => { if (!document.hidden) void queryClient.invalidateQueries({ queryKey: [wid, 'notifications', 'counts'] }); };
    window.addEventListener(CHECK_NOTIFICATIONS, burst);
    document.addEventListener('visibilitychange', back);
    return () => { window.clearTimeout(t); window.removeEventListener(CHECK_NOTIFICATIONS, burst); document.removeEventListener('visibilitychange', back); };
  }, [wid]);
  return null;
}

// ------------------------------------------------------------------ the bell

/** SF Symbols-style bell: rounded dome, flared rim, separate clapper - drawn at 20px with a 1.75 stroke in the text colour. */
function BellGlyph({ size = 20 }: { size?: number }) {
  return (
    <svg className="ncx-bell-glyph" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.25a.9.9 0 0 1 .9.9v.6a5.9 5.9 0 0 1 5 5.83v3.37c0 .78.26 1.54.74 2.15l.86 1.1c.5.64.05 1.57-.76 1.57H5.26c-.81 0-1.26-.93-.76-1.57l.86-1.1c.48-.61.74-1.37.74-2.15v-3.37a5.9 5.9 0 0 1 5-5.83v-.6a.9.9 0 0 1 .9-.9Z" />
      <path d="M9.75 20.1a2.4 2.4 0 0 0 4.5 0" />
    </svg>
  );
}

/**
 * The bell: a 36px round button (no fill until hovered or pressed) with the bell in the primary text colour and Apple's red pill badge just
 * outside the glyph's top-right, ringed in the toolbar's colour so it never runs into the edge. The badge pops when the number changes and
 * the bell rings once when something new arrives (not with reduced motion). `variant="phone"` matches the phone top bar.
 */
export function NotificationBell({ variant = 'toolbar' }: { variant?: 'toolbar' | 'phone' | 'float' }) {
  const n = useBadge();
  const open = useCentre((s) => s.open);
  const toggle = useCentre((s) => s.toggle);
  const [pop, setPop] = useState(false);
  const [ring, setRing] = useState(false);
  const prev = useRef(n);
  useEffect(() => {
    if (n === prev.current) return;
    const up = n > prev.current;
    prev.current = n;
    setPop(true);
    if (up) setRing(true);
    const t = window.setTimeout(() => { setPop(false); setRing(false); }, 900);
    return () => window.clearTimeout(t);
  }, [n]);
  return (
    <button type="button" className={`ncx-bell ${variant}${open ? ' on' : ''}${ring ? ' ring' : ''}`} data-ncx-bell aria-haspopup="dialog" aria-expanded={open}
      aria-label={`Notifications${n ? `, ${n} unread` : ''}`} title="Notifications"
      onClick={() => { haptic(); unlockSound(); toggle(); }}>
      <BellGlyph size={variant === 'phone' ? 22 : 20} />
      {n > 0 && <em className={`ncx-badge${pop ? ' pop' : ''}${n > 9 ? ' wide' : ''}`} data-count={n} aria-hidden="true">{badgeText(n)}</em>}
    </button>
  );
}

// ------------------------------------------------------------------ data


/** The panel itself (the list, cards, swipe actions, reply and snooze) is downloaded the first time the bell opens it. */
const CentrePanel = lazy(() => import('./CentrePanel').then((m) => ({ default: m.Centre })));

export function NotificationCentreHost() {
  const open = useCentre((s) => s.open);
  const close = useCentre((s) => s.close);
  if (!open) return null;
  return <Suspense fallback={null}><CentrePanel onClose={close} /></Suspense>;
}
