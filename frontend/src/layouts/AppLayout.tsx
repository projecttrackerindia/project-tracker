import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react';
import { prefetchPages } from '../lib/prefetchPages';
import { Outlet, useLocation, useSearchParams } from 'react-router-dom';
import { openNew } from '../components/v2/state';
import { notificationApi } from '../api/endpoints';
import { PageLoader, ToastRoot, ConfirmRoot } from '../components/ui';
import { useAuth } from '../stores/auth';
import { AccessWatcher } from './AccessWatcher';
import { ChatRealtime } from '../features/chat/ChatRealtime';
import { ProjectChatHost } from '../features/chat/ProjectChat';
import { PlatformBanner } from '../components/PlatformBanner';
import { LensSync } from '../lib/teamLens';
import { MobileTopBar } from './MobileChrome';
import { PullToRefresh } from '../components/PullToRefresh';
import { useIsMobile } from '../lib/mobile';
import { useConversationViewport } from '../lib/conversationViewport';
import { NetworkPill } from '../components/AppSplash';
import { SignInIsland } from '../components/SignInIsland';
import { CommandPalette } from '../components/CommandPalette';
import { ReminderAlerts } from '../features/reminders/ReminderAlerts';
import { AlertsSetup } from '../features/notifications/AlertsSetup';
import { CHECK_NOTIFICATIONS } from '../features/notifications/events';
import { firstTime, kindForType } from '../lib/attention';
import { announce } from '../features/notifications/centre/announce';
import { getAlertPrefs, isMuted } from '../features/notifications/centre/prefs';
import { BadgeSync, NotificationBell, NotificationCentreHost } from '../features/notifications/centre/NotificationCentre';
import { pushCoversThisDevice, systemNotification } from '../features/reminders/device';
import { useReminderComposer } from '../features/reminders/store';
import { LiveCallsBar } from '../features/calls/LiveCallsBar';
import { CallHost } from '../features/calls/CallHost';
import { IncomingCallHost } from '../features/calls/IncomingCall';
import { isRingNotice } from '../features/calls/incomingCalls';
import { AskBar, AskPanelHost, CopilotHost, LiveBanners, NewSheetHost, PhoneBar, Rail, Toolbar } from '../components/v2';
import { MotionConfig } from 'framer-motion';

const ReminderComposerHost = lazy(() => import('../features/reminders/Composer').then((m) => ({ default: m.ReminderComposerHost })));

const REMINDER_TYPES = new Set(['Reminder', 'Nudge', 'DueSoon', 'Overdue']);

// ------------------------------------------------------------------ desktop notifications
/**
 * Shows a system notification (and plays the alert sound) for new items the user opted into (Settings › Notifications › Delivery) while
 * the app is open - also when they are in another tab, window or app. Looks every 15 seconds, and straight away when the live connection
 * says someone else changed something or a mention arrived. When push is on for this device, the push already brings the notification
 * (and the page plays the sound when it arrives), so this only covers devices without push.
 * Nothing is shown for older items on first run, and nothing works until the browser permission has been granted.
 */
function DesktopNotifier() {
  const wid = useAuth((s) => s.ctx?.current?.id);
  useEffect(() => {
    if (!wid) return;
    const key = `pm_desktop_seen_${wid}`;
    const read = () => { try { return Number(localStorage.getItem(key) ?? 0); } catch { return 0; } };
    const write = (v: number) => { try { localStorage.setItem(key, String(v)); } catch { /* storage unavailable */ } };
    let running = false;
    const tick = async () => {
      if (running || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      running = true;
      try {
        const page = await notificationApi.list(1, true);
        const times = page.items.map((n) => Date.parse(n.createdAt));
        const last = read();
        const newest = Math.max(last, ...times, 0);
        if (last === 0) { write(newest || Date.now()); return; } // first run: do not replay history
        const fresh = page.items.filter((x) => x.browser && Date.parse(x.createdAt) > last && !REMINDER_TYPES.has(x.type) && !isRingNotice(x) && firstTime(`dn-${x.id}`, 120_000)).reverse();
        for (const n of fresh) {
          const kind = kindForType(n.type);
          announce(n);
          if (isMuted() || getAlertPrefs().dnd) continue;   // muted here: it waits in the Notification Centre
          if (!pushCoversThisDevice()) void systemNotification(n.title, n.body, n.id, n.link ?? '/', { sticky: kind === 'urgent' });
        }
        write(newest);
      } catch { /* offline or signed out: try again next time */ }
      finally { running = false; }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, 15_000);
    const now = () => { void tick(); };
    window.addEventListener(CHECK_NOTIFICATIONS, now);
    return () => { clearInterval(timer); window.removeEventListener(CHECK_NOTIFICATIONS, now); };
  }, [wid]);
  return null;
}

/** The reminder form, loaded the first time someone opens it. */
function ComposerSlot() {
  const open = useReminderComposer((s) => !!s.draft);
  return open ? <Suspense fallback={null}><ReminderComposerHost /></Suspense> : null;
}

/**
 * The v2 shell: the 84px rail on the left (the phone bar at the bottom of a phone), the page, the Ask bar floating at the bottom, and the
 * things every page can open: + New, the copilot panel, the command palette, calls, reminders and toasts.
 */
export function AppLayout({ children }: { children?: ReactNode }) {
  const loc = useLocation();
  const main = useRef<HTMLElement>(null);
  const phone = useIsMobile();
  const shell = useRef<HTMLDivElement>(null);
  // A conversation fills the screen on a phone: a chat, or the assistant's conversation on Home (?c=…).
  const homeChat = (loc.pathname === '/' || loc.pathname === '') && new URLSearchParams(loc.search).has('c');   // paths are inside the workspace's basename
  // Talk (its list and an open conversation) is a conversation on a phone: its composer stays above the tab bar.
  const conversation = homeChat || /^\/messages(?:\/[^/]+)?\/?$/.test(loc.pathname);
  useConversationViewport(phone && conversation, shell);
  // The live chat connection runs for people who can chat: organization workspaces, not guests, not platform administrators.
  const chatOn = useAuth((s) => !!s.ctx?.current && s.ctx.current.type !== 'Personal' && s.ctx.current.role !== 'Guest' && !s.ctx.user.isPlatformAdmin);
  const admin = useAuth((s) => !!s.ctx?.user.isPlatformAdmin);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [loc.pathname]);
  // Every page's code, fetched quietly once the app is idle, so a click shows the next page at once instead of a blank pause.
  useEffect(() => { prefetchPages(); }, []);
  // The page content fades in when the place changes (the rail and the Ask bar stay put). A class on the existing main element, not a
  // wrapper: an extra box would break the phone layout's height chain, and a transform would trap position:fixed panels inside it.
  useEffect(() => {
    const el = main.current;
    if (!el) return;
    el.classList.remove('v2-enter'); void el.offsetWidth; el.classList.add('v2-enter');
  }, [loc.pathname]);
  const page = <><LiveCallsBar /><Suspense fallback={<PageLoader />}>{children ?? <Outlet />}</Suspense></>;
  return (
    <MotionConfig reducedMotion="user">
    <div ref={shell} className={`app-shell v2-shell ${phone ? 'm-shell' : ''} ${phone && conversation ? 'm-conversation' : ''}`}>
      <a href="#main-content" className="skip-link" onClick={(e) => { e.preventDefault(); main.current?.focus(); }}>Skip to content</a>
      <LensSync />
      <ShortcutNew />
      {phone ? (
        <div className="main m-main">
          <PlatformBanner />
          <MobileTopBar />
          <main id="main-content" className="content" ref={main} tabIndex={-1}>{page}</main>
          <PhoneBar />
          {!conversation && <PullToRefresh />}
        </div>
      ) : (
        <>
          <Rail />
          <div className="main v2-main">
            <PlatformBanner />
            {!admin && <Toolbar />}
            {!admin && <NotificationBell variant="float" />}
            <main id="main-content" className="content" ref={main} tabIndex={-1}>{page}</main>
          </div>
        </>
      )}
      {!admin && !(phone && conversation) && <AskBar />}
      {!admin && <NewSheetHost />}
      {!admin && <AskPanelHost />}
      {!admin && <CopilotHost />}
      <SignInIsland />
      <NetworkPill />
      <CallHost />
      {!admin && <IncomingCallHost />}
      <ToastRoot />
      <ConfirmRoot />
      <DesktopNotifier />
      <AccessWatcher />
      <CommandPalette />
      <ReminderAlerts />
      <AlertsSetup />
      <ComposerSlot />
      {chatOn && <ChatRealtime />}
      {chatOn && <ProjectChatHost />}
      {!admin && <LiveBanners />}
      {!admin && <BadgeSync />}
      {!admin && <NotificationCentreHost />}
    </div>
    </MotionConfig>
  );
}

/** Home-screen shortcuts (long-press the app icon on iPhone or Android): /?new=task opens + New on that kind, once. */
function ShortcutNew() {
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const kind = params.get('new');
    if (!kind || !['task', 'ticket', 'bug', 'meeting', 'reminder', 'time', 'doc'].includes(kind)) return;
    openNew(kind as Parameters<typeof openNew>[0]);
    setParams((p) => { const n = new URLSearchParams(p); n.delete('new'); return n; }, { replace: true });
  }, [params, setParams]);
  return null;
}
