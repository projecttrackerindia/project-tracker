import { deliveryTime } from '../features/notifications/deliveryTime';
import { lazy, Suspense, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { isViewing } from '../features/notifications/centre/readSync';
import { prefetchPages } from '../lib/prefetchPages';
import { MutationSync } from '../lib/MutationSync';
import { Outlet, useLocation, useSearchParams } from 'react-router-dom';
import { openNew } from '../components/v2/state';
import { notificationApi } from '../api/endpoints';
import { PageLoader, ToastRoot, ConfirmRoot } from '../components/ui';
import { useAuth } from '../stores/auth';
import { AccessWatcher } from './AccessWatcher';
import { PlatformBanner } from '../components/PlatformBanner';
import { LensSync } from '../lib/teamLens';
import { MobileTopBar } from './MobileChrome';
import { PullToRefresh } from '../components/PullToRefresh';
import { useIsMobile } from '../lib/mobile';
import { useConversationViewport } from '../lib/conversationViewport';
import { SignInIsland } from '../components/SignInIsland';
// "Single active session": a new device of mine asking to sign in (loaded beside the app, not in its first bundle).
// Hosts that only matter once something happens (a call, a due reminder, a sign-in to approve, a change to undo): their code follows the
// first screen instead of holding it up.
const ProjectChatHost = lazy(() => import('../features/chat/ProjectChat').then((m) => ({ default: m.ProjectChatHost })));
const ReminderAlerts = lazy(() => import('../features/reminders/ReminderAlerts').then((m) => ({ default: m.ReminderAlerts })));
const AlertsSetup = lazy(() => import('../features/notifications/AlertsSetup').then((m) => ({ default: m.AlertsSetup })));
const IncomingCallHost = lazy(() => import('../features/calls/IncomingCall').then((m) => ({ default: m.IncomingCallHost })));
const ChangeUndoPrompt = lazy(() => import('../features/projects/ChangeUndoPrompt').then((m) => ({ default: m.ChangeUndoPrompt })));
const SessionApprovalHost = lazy(() => import('../features/auth/SessionApproval').then((m) => ({ default: m.SessionApprovalHost })));
import { CHECK_NOTIFICATIONS } from '../features/notifications/events';
import { firstTime, kindForType } from '../lib/attention';
import { announce, isQuiet } from '../features/notifications/centre/announce';
import { getAlertPrefs, isMuted } from '../features/notifications/centre/prefs';
import { BadgeSync, NotificationCentreHost } from '../features/notifications/centre/NotificationCentre';
import { pushCoversThisDevice, systemNotification } from '../features/reminders/device';
import { useReminderComposer } from '../features/reminders/store';
import { LiveCallsBar } from '../features/calls/LiveCallsBar';
import { CallHost } from '../features/calls/CallHost';
import { isRingNotice } from '../features/calls/incomingCalls';
import { AuraKeys, CopilotHost, LiveBanners, PhoneBar, Rail, Toolbar, useNewSheet } from '../components/v2';
import { useScheduleSheet } from '../features/meet/scheduleStore';
import { useGroot } from '../components/groot/store';
import { AfterFirstPaint, WhenFirstOpened } from '../lib/afterFirstPaint';
import { Fab } from '../components/shell/Fab';
import { ApprovalRequestHost } from '../features/approvals/host';
import '../components/shell/shell.css';
import { MotionConfig } from 'framer-motion';
import { AttendanceHost } from '../features/attendance/AttendanceHost';
import { AuraWatcher } from '../components/aura/AuraWatcher';
import { AuraSearchHost } from '../components/aura/AuraSearch';
import { ExtensionReasonHost } from '../features/dates/ExtensionReason';
import { OfflineSync } from '../features/offline/OfflineSync';

// The calm create sheets (New task / New project from the + menu), mounted once for every page. Loaded through a glob so the shell
// builds before that feature lands and wires it up by itself once features/calm/createSheets.tsx exists.
const calmCreate = import.meta.glob<{ CalmCreateHost: ComponentType }>('../features/calm/createSheets.tsx');
const calmCreateLoad = Object.values(calmCreate)[0];
const CalmCreateHost = calmCreateLoad ? lazy(() => calmCreateLoad().then((m) => ({ default: m.CalmCreateHost }))) : null;

// Sheets (their code arrives the first time they open) and background hosts (mounted once the page has painted): kept out of the
// shell's first download so a phone on a slow network shows the page sooner. Each reads its state from a store, so nothing is missed.
const NewSheetHost = lazy(() => import('../components/v2/NewSheet').then((m) => ({ default: m.NewSheetHost })));
const ScheduleHost = lazy(() => import('../features/meet/ScheduleSheet').then((m) => ({ default: m.ScheduleHost })));
const GrootChatHost = lazy(() => import('../components/groot/GrootChat').then((m) => ({ default: m.GrootChatHost })));
const MeetTimePrompt = lazy(() => import('../features/meet/MeetTime').then((m) => ({ default: m.MeetTimePrompt })));
const ChatRealtime = lazy(() => import('../features/chat/ChatRealtime').then((m) => ({ default: m.ChatRealtime })));

const CommandPalette = lazy(() => import('../components/CommandPalette').then((m) => ({ default: m.CommandPalette })));

/**
 * ⌘K / Ctrl K and every "open the palette" button: the palette's code is fetched on the first ask, then the ask is passed on to it (it
 * listens for the same signal once mounted).
 */
function PaletteLauncher() {
  const [wanted, setWanted] = useState(false);
  useEffect(() => {
    if (wanted) return;
    const ask = () => setWanted(true);
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ask(); } };
    window.addEventListener('pm:palette', ask);
    document.addEventListener('keydown', key);
    return () => { window.removeEventListener('pm:palette', ask); document.removeEventListener('keydown', key); };
  }, [wanted]);
  return wanted ? <Suspense fallback={null}><CommandPalette /><PassOn /></Suspense> : null;
}
/** Mounted right after the palette, so its listener is in place: re-sends the first ask. */
function PassOn() {
  useEffect(() => { window.dispatchEvent(new Event('pm:palette')); }, []);
  return null;
}

const ReminderComposerHost = lazy(() => import('../features/reminders/Composer').then((m) => ({ default: m.ReminderComposerHost })));

// ------------------------------------------------------------------ desktop notifications
/**
 * Shows a system notification (and plays the alert sound) for new items the user opted into (Settings › Notifications › Delivery) while
 * the app is open - also when they are in another tab, window or app. Looks every 15 seconds, and straight away when the live connection
 * says someone else changed something or a mention arrived. When push is on for this device, the push already brings the notification
 * (and the page plays the sound when it arrives), so a short grace period avoids duplicates; missing delivery still gets a page fallback.
 * Nothing is shown for older items on first run, and nothing works until the browser permission has been granted.
 */
function DesktopNotifier() {
  const wid = useAuth((s) => s.ctx?.current?.id);
  const userId = useAuth((s) => s.ctx?.user.id);
  useEffect(() => {
    if (!wid || !userId) return;
    const key = `pm_desktop_seen_${userId}_${wid}`;
    const read = () => { try { return Number(localStorage.getItem(key) ?? 0); } catch { return 0; } };
    const write = (v: number) => { try { localStorage.setItem(key, String(v)); } catch { /* storage unavailable */ } };
    const openedAt = Date.now();
    let running = false;
    let stopped = false;
    const tick = async () => {
      if (running || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      running = true;
      try {
        const page = await notificationApi.list(1, true);
        if (stopped) return;
        const now = Date.now();
        const times = page.items.map(deliveryTime).filter((at) => Number.isFinite(at) && at <= now);
        const last = read() || openedAt;
        const newest = Math.max(last, ...times, 0);
        const fresh = page.items.filter((x) => x.browser && !isQuiet(x) && deliveryTime(x) > last && deliveryTime(x) <= now && !isRingNotice(x) && !isViewing(x.link) && firstTime(`dn-${x.id}`, 120_000)).reverse();
        for (const n of fresh) {
          const kind = kindForType(n.type);
          const played = announce(n);
          if (isMuted() || getAlertPrefs().dnd) continue;   // muted here: it waits in the Notification Centre
          // The page played its cue: the OS notification stays silent (one sound per alert); otherwise the OS plays its own.
          void systemNotification(n.title, n.body, n.id, n.link ?? '/', {
            sticky: kind === 'urgent', waitForPush: pushCoversThisDevice(), osSound: !played,
            shouldShow: () => !stopped && !isMuted() && !getAlertPrefs().dnd && !isViewing(n.link),
          });
        }
        write(newest);
      } catch { /* offline or signed out: try again next time */ }
      finally { running = false; }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, 15_000);
    const now = () => { void tick(); };
    window.addEventListener(CHECK_NOTIFICATIONS, now);
    return () => { stopped = true; clearInterval(timer); window.removeEventListener(CHECK_NOTIFICATIONS, now); };
  }, [wid, userId]);
  return null;
}

/** The reminder form, loaded the first time someone opens it. */
function ComposerSlot() {
  const open = useReminderComposer((s) => !!s.draft);
  return open ? <Suspense fallback={null}><ReminderComposerHost /></Suspense> : null;
}

/**
 * The calm shell: the sidebar on the left (an icon rail when collapsed; the tab bar at the bottom of a phone), the header (check-in, bell,
 * Aura orb, avatar), the page, the floating + button, and the things every page can open: the create sheet, the Aura panel (⌘K), the
 * command palette, calls, reminders and toasts.
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
  // An open conversation (or meeting) in Messages is a full-screen view on a phone: its own header with Back, no tab bar.
  const thread = phone && (/^\/messages\/[^/]+\/?$/.test(loc.pathname) || (/^\/messages\/?$/.test(loc.pathname) && new URLSearchParams(loc.search).has('meeting')));
  useConversationViewport(phone && conversation, shell);
  // The live chat connection runs for people who can chat: organization workspaces, not guests, not platform administrators.
  const chatOn = useAuth((s) => !!s.ctx?.current && s.ctx.current.type !== 'Personal' && s.ctx.current.role !== 'Guest' && !s.ctx.user.isPlatformAdmin);
  const admin = useAuth((s) => !!s.ctx?.user.isPlatformAdmin);
  // Realtime sync runs for everyone in a workspace (personal workspaces and guests too); chat rides on the same connection.
  const liveOn = useAuth((s) => !!s.ctx?.current && !s.ctx.user.isPlatformAdmin);
  const newOpen = useNewSheet((s) => s.open);
  const scheduleOpen = useScheduleSheet((s) => !!s.open);
  const grootOpen = useGroot((s) => s.open);
  useEffect(() => { window.scrollTo({ top: 0, left: 0 }); }, [loc.pathname]);   // left too: a page never stays shifted sideways
  // Warm likely destinations on hover/focus; unopened features stay off the network.
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
    <div ref={shell} className={`app-shell v2-shell ${phone ? 'm-shell' : ''} ${phone && conversation ? 'm-conversation' : ''} ${thread ? 'm-thread' : ''}`}>
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
            <main id="main-content" className="content" ref={main} tabIndex={-1}>{page}</main>
          </div>
        </>
      )}
      {/* The floating + (bottom right; above the tab bar on a phone) and ⌘K for the Aura panel (the header orb). No bottom Aura capsule. */}
      {!admin && !(phone && conversation) && <Fab />}
      {!admin && <AuraKeys />}
      {!admin && <AuraSearchHost />}
      <ExtensionReasonHost />
      {!admin && <ApprovalRequestHost />}
      {!admin && CalmCreateHost && <Suspense fallback={null}><CalmCreateHost /></Suspense>}
      {!admin && <WhenFirstOpened open={newOpen}><NewSheetHost /></WhenFirstOpened>}
      {!admin && <WhenFirstOpened open={scheduleOpen}><ScheduleHost /></WhenFirstOpened>}
      {!admin && <AfterFirstPaint><MeetTimePrompt /></AfterFirstPaint>}
      {!admin && <WhenFirstOpened open={grootOpen}><GrootChatHost /></WhenFirstOpened>}
      {!admin && <CopilotHost />}
      <OfflineSync phone={phone} />
      <SignInIsland />
      <AfterFirstPaint><SessionApprovalHost /></AfterFirstPaint>
      <CallHost />
      {!admin && <AfterFirstPaint><IncomingCallHost /></AfterFirstPaint>}
      <ToastRoot />
      <ConfirmRoot />
      <MutationSync />
      <DesktopNotifier />
      <AccessWatcher />
      <PaletteLauncher />
      <AfterFirstPaint><ReminderAlerts /></AfterFirstPaint>
      <AfterFirstPaint><AlertsSetup /></AfterFirstPaint>
      <ComposerSlot />
      {!admin && <AttendanceHost />}
      {!admin && <AuraWatcher />}
      {!admin && <AfterFirstPaint><ChangeUndoPrompt /></AfterFirstPaint>}
      {liveOn && <AfterFirstPaint><ChatRealtime chat={chatOn} /></AfterFirstPaint>}
      {chatOn && <AfterFirstPaint><ProjectChatHost /></AfterFirstPaint>}
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

