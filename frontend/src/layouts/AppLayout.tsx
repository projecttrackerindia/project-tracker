import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { chatApi, insightApi, notificationApi } from '../api/endpoints';
import { Icon, type IconName } from '../components/Icon';
import { BrandMark } from '../components/BrandMark';
import { PageLoader, ToastRoot, ConfirmRoot } from '../components/ui';
import { timeAgo } from '../lib/format';
import { setTitleParts } from '../lib/title';
import { queryClient, useAuth, useIsPersonal } from '../stores/auth';
import { toast, useUi } from '../stores/ui';
import { RunningTimer } from '../features/time/RunningTimer';
import { AccessWatcher } from './AccessWatcher';
import { ChatRealtime } from '../features/chat/ChatRealtime';
import { ProjectChatHost } from '../features/chat/ProjectChat';
import { chatKeys } from '../features/chat/chatStore';
import { PlatformBanner } from '../components/PlatformBanner';
import { ThemeSwitch } from '../components/ThemeSwitch';
import { TeamLensPicker } from '../components/TeamLensPicker';
import { LensSync } from '../lib/teamLens';
import { AccountDock, TopbarMe } from './AccountDock';
import { CreateOrganizationModal, NOTIF_ICON } from './parts';
import { MobileTopBar, TabBar } from './MobileChrome';
import { PullToRefresh } from '../components/PullToRefresh';
import { useIsMobile } from '../lib/mobile';
import { useMainNav } from './navigation';
import { SignInIsland } from '../components/SignInIsland';
import { CommandPalette, openPalette, searchHitLink } from '../components/CommandPalette';
import { AssistantButton, AssistantPanel } from '../features/ai/Assistant';
import { ReminderAlerts } from '../features/reminders/ReminderAlerts';
import { AlertsSetup } from '../features/notifications/AlertsSetup';
import { CHECK_NOTIFICATIONS } from '../features/notifications/events';
import { firstTime, getAttention, kindForType } from '../lib/attention';
import { pushCoversThisDevice, systemNotification } from '../features/reminders/device';
import { useReminderComposer, useReminderCounts } from '../features/reminders/store';

const ReminderComposerHost = lazy(() => import('../features/reminders/Composer').then((m) => ({ default: m.ReminderComposerHost })));

// ------------------------------------------------------------------ helpers
function useClickOutside(ref: React.RefObject<HTMLElement | null>, onOutside: () => void) {
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onOutside(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  });
}

const REMINDER_TYPES = new Set(['Reminder', 'Nudge', 'DueSoon', 'Overdue']);
// ------------------------------------------------------------------ sidebar
function Sidebar() {
  const { sidebarCollapsed, sidebarOpen, closeSidebar } = useUi();
  const ctx = useAuth((s) => s.ctx);
  const personal = useIsPersonal();
  const canChat = !personal && ctx?.current?.role !== 'Guest' && !ctx?.user.isPlatformAdmin;
  const { pathname } = useLocation();
  const wid = ctx?.current?.id;
  // Unread messages: kept current by live events; the slow refresh is only a safety net.
  const unread = useQuery({ queryKey: chatKeys.unread(wid ?? ''), queryFn: () => chatApi.unread(), enabled: !!wid && canChat, refetchInterval: 90_000, staleTime: 30_000 });
  // The unread count is also in the tab title, so it shows when the app is in the background.
  const unreadCount = unread.data?.count ?? 0;
  useEffect(() => { setTitleParts({ unread: canChat ? unreadCount : 0 }); }, [unreadCount, canChat]);
  const isPlatformAdmin = !!ctx?.user.isPlatformAdmin;
  const reminders = useReminderCounts(!!wid && !isPlatformAdmin);
  // The sidebar's own identity: a Business/Enterprise workspace is confident enough to show its own name; a Free/Pro workspace (which
  // might still be "My organization" from sign-up) shows the product name instead, and a personal space shows its own name.
  const planCode = ctx?.current?.plan.code?.toUpperCase();
  const brandTitle = isPlatformAdmin ? 'Platform' : personal ? (ctx?.current?.name ?? 'Personal space')
    : planCode === 'BUSINESS' || planCode === 'ENTERPRISE' ? (ctx?.current?.name ?? 'Project Tracker') : 'Project Tracker';
  const brandSub = isPlatformAdmin ? 'Administration' : personal ? 'Personal space' : 'Workspace';
  // The same menu as the command palette; the sidebar adds the unread count to Chat and what needs attention to Reminders.
  const groups = useMainNav().map((g) => ({ ...g, items: g.items.map((i) => (i.to === '/chat' ? { ...i, badge: unread.data?.count }
    : i.to === '/reminders' ? { ...i, badge: reminders.data?.now } : i)) }));

  return (
    <>
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''} ${sidebarOpen ? 'open' : ''}`} id="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark"><BrandMark /></div>
          <div className="brand-text"><strong title={brandTitle}>{brandTitle}</strong><span>{brandSub}</span></div>
        </div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          {groups.map((g) => {
            const items = g.items.filter((i) => i.show !== false);
            if (!items.length) return null;
            return (
              <div className="nav-section" key={g.title}>
                <div className="nav-section-title">{g.title}</div>
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.end} title={i.label} onClick={closeSidebar}
                    className={({ isActive }) => `nav-item ${(i.match ? i.match(pathname) : isActive) ? 'active' : ''}`}>
                    <Icon name={i.icon} /><span>{i.label}</span>
                    {!!i.badge && <em className={`nav-count ${i.to === '/reminders' ? 'nav-count-alarm' : ''}`} aria-label={i.to === '/reminders' ? `${i.badge} need attention` : `${i.badge} unread`}>{i.badge > 99 ? '99+' : i.badge}</em>}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        {ctx && <AccountDock />}
      </aside>
      <div className={`sidebar-overlay ${sidebarOpen ? 'show' : ''}`} onClick={closeSidebar} />
    </>
  );
}

// ------------------------------------------------------------------ desktop notifications
/**
 * Shows a system notification (and plays the alert sound) for new items the user opted into ("Desktop" in Settings → Notifications) while
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
        const fresh = page.items.filter((x) => x.browser && Date.parse(x.createdAt) > last && !REMINDER_TYPES.has(x.type) && firstTime(`n-${x.id}`, 120_000)).reverse();
        for (const n of fresh) {
          const kind = kindForType(n.type);
          getAttention({ kind });
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

// ------------------------------------------------------------------ top bar pieces
function GlobalSearch() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const nav = useNavigate();
  useClickOutside(ref, () => setOpen(false));

  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName ?? '';
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag) && !el?.isContentEditable) { e.preventDefault(); input.current?.focus(); }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);

  const { data, isFetching } = useQuery({
    queryKey: ['search', debounced], queryFn: () => insightApi.search(debounced), enabled: debounced.length >= 2,
  });

  const go = (h: { type: string; id: string; projectId: string | null; taskId: string | null }) => {
    setOpen(false); setQ('');
    nav(searchHitLink(h));
  };
  const groups: Record<string, string> = { task: 'Tasks', issue: 'Issues', action: 'Action items', work: 'Operational work', project: 'Projects', team: 'Teams', member: 'People', comment: 'Comments', file: 'Files', label: 'Labels' };
  const icons: Record<string, IconName> = { task: 'check', issue: 'bug', action: 'flag', work: 'bolt', project: 'folder', team: 'users', member: 'user', comment: 'message', file: 'paperclip', label: 'tag' };
  const hits = data?.hits ?? [];

  return (
    <div className="global-search" ref={ref}>
      <span className="search-icon"><Icon name="search" /></span>
      <input ref={input} type="search" placeholder="Search work, projects, people… or a key like WT-12" autoComplete="off" aria-label="Global search" value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); input.current?.blur(); } }} />
      {!q && <button type="button" className="kbd kbd-btn" title="Command palette (Ctrl K)" onClick={openPalette}>Ctrl K</button>}
      {open && debounced.length >= 2 && (
        <div className="search-results">
          {isFetching && !hits.length ? <div className="sr-empty">Searching…</div>
            : !hits.length ? <div className="sr-empty">No results for “{debounced}”</div>
            : Object.keys(groups).filter((t) => hits.some((h) => h.type === t)).map((t) => (
              <div key={t}>
                <div className="sr-group-title">{groups[t]}</div>
                {hits.filter((h) => h.type === t).map((h) => (
                  <button key={h.id} className="sr-item" onClick={() => go(h)}>
                    <Icon name={icons[t]} />
                    <span className="sr-item-main"><span className="sr-item-title">{h.title}</span>{h.subtitle && <span className="sr-item-sub">{h.subtitle}</span>}</span>
                  </button>
                ))}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function WorkspaceSwitcher() {
  const ctx = useAuth((s) => s.ctx)!;
  const switchWorkspace = useAuth((s) => s.switchWorkspace);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false));
  const cur = ctx.current;

  const pick = async (id: string) => {
    setOpen(false);
    if (id === cur?.id) return;
    try { await switchWorkspace(id); toast('Workspace switched.', 'info'); }
    catch { toast('Could not switch workspace.', 'error'); }
  };

  return (
    <div className="dropdown" ref={ref}>
      <button className="workspace-switch" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <span className="ws-avatar">{(cur?.name ?? '?')[0].toUpperCase()}</span>
        <span className="ws-name">{cur?.name ?? 'Select workspace'}</span>
        <Icon name="chevronD" size={14} />
      </button>
      {open && (
        <div className="dropdown-panel left" role="menu" style={{ width: 300 }}>
          <div className="dp-head"><strong>Workspaces</strong></div>
          {ctx.workspaces.map((w) => (
            <button key={w.id} className={`dp-menu-item ${w.id === cur?.id ? 'active' : ''}`} onClick={() => pick(w.id)} role="menuitem">
              <span className="ws-avatar">{w.name[0].toUpperCase()}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
                <span className="muted" style={{ fontSize: 11 }}>{w.type} · {w.role} · {w.planCode}</span>
              </span>
              {w.id === cur?.id && <Icon name="tick" />}
            </button>
          ))}
          <div className="dp-sep" />
          <button className="dp-menu-item" onClick={() => { setOpen(false); setCreating(true); }}><Icon name="plus" /> Create organization</button>
        </div>
      )}
      {creating && <CreateOrganizationModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function NotificationsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  useClickOutside(ref, () => setOpen(false));
  const wid = useAuth((s) => s.ctx?.current?.id);

  const unread = useQuery({ queryKey: [wid, 'notifications', 'unread'], queryFn: notificationApi.unread, refetchInterval: 60_000, enabled: !!wid });
  const list = useQuery({ queryKey: [wid, 'notifications', 'recent'], queryFn: () => notificationApi.list(1, true), enabled: open && !!wid });
  const refresh = () => queryClient.invalidateQueries({ queryKey: [wid, 'notifications'] });
  const readAll = useMutation({ mutationFn: notificationApi.readAll, onSuccess: refresh });
  const count = unread.data?.count ?? 0;

  const openItem = async (n: { id: string; link: string | null; isRead: boolean }) => {
    setOpen(false);
    if (!n.isRead) { await notificationApi.read(n.id); refresh(); }
    if (n.link) nav(n.link);
  };

  return (
    <div className="dropdown" ref={ref}>
      <button className="icon-btn" title="Notifications" aria-label={`Notifications${count ? `, ${count} unread` : ''}`} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>
        <Icon name="bell" />
        {count > 0 && <span className="notif-dot">{count > 9 ? '9+' : count}</span>}
      </button>
      {open && (
        <div className="dropdown-panel">
          <div className="dp-head">
            <strong>Notifications</strong>
            {count > 0 && <button className="link" style={{ fontSize: 12 }} onClick={() => readAll.mutate()}>Mark all read</button>}
          </div>
          {list.isLoading ? <div className="sr-empty">Loading…</div>
            : !list.data?.items.length ? <div className="sr-empty">You're all caught up.</div>
            : list.data.items.slice(0, 8).map((n) => (
              <button key={n.id} className={`dp-item ${n.isRead ? '' : 'unread'}`} onClick={() => openItem(n)}>
                <span className="dp-ico">{NOTIF_ICON[n.type] ?? '🔔'}</span>
                <span className="dp-main"><b>{n.title}</b>{n.body && <span>{n.body}</span>}<span className="muted" style={{ display: 'block', fontSize: 11 }}>{timeAgo(n.createdAt)}</span></span>
              </button>
            ))}
          <div className="dp-sep" />
          <button className="dp-menu-item" onClick={() => { setOpen(false); nav('/notifications'); }}>View all notifications</button>
        </div>
      )}
    </div>
  );
}

function Topbar() {
  const { toggleSidebar } = useUi();
  const isPlatformAdmin = useAuth((s) => !!s.ctx?.user.isPlatformAdmin);
  return (
    <header className="topbar">
      <button className="icon-btn" onClick={toggleSidebar} title="Toggle sidebar" aria-label="Toggle sidebar"><Icon name="menu" /></button>
      {isPlatformAdmin ? null : <GlobalSearch />}
      <div className="topbar-actions">
        {!isPlatformAdmin && <AssistantButton />}
        {!isPlatformAdmin && <RunningTimer />}
        {!isPlatformAdmin && <TeamLensPicker />}
        {!isPlatformAdmin && <WorkspaceSwitcher />}
        <ThemeSwitch className="theme-toggle" />
        {!isPlatformAdmin && <NotificationsMenu />}
        <TopbarMe />
      </div>
    </header>
  );
}

/** The reminder form, loaded the first time someone opens it. */
function ComposerSlot() {
  const open = useReminderComposer((s) => !!s.draft);
  return open ? <Suspense fallback={null}><ReminderComposerHost /></Suspense> : null;
}

export function AppLayout({ children }: { children?: ReactNode }) {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const loc = useLocation();
  const main = useRef<HTMLElement>(null);
  const phone = useIsMobile();
  // The live chat connection runs for people who can chat: organization workspaces, not guests, not platform administrators.
  const chatOn = useAuth((s) => !!s.ctx?.current && s.ctx.current.type !== 'Personal' && s.ctx.current.role !== 'Guest' && !s.ctx.user.isPlatformAdmin);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [loc.pathname]);
  const page = <Suspense fallback={<PageLoader />}>{children ?? <Outlet />}</Suspense>;
  return (
    <div className={`app-shell ${phone ? 'm-shell' : ''}`}>
      <LensSync />
      {phone ? (
        <div className="main m-main">
          <PlatformBanner />
          <MobileTopBar />
          <main className="content" ref={main} tabIndex={-1} key={loc.pathname.split('/')[1]}>{page}</main>
          <TabBar />
          <PullToRefresh />
        </div>
      ) : (
        <>
          <Sidebar />
          <div className={`main ${collapsed ? 'expanded' : ''}`}>
            <PlatformBanner />
            <Topbar />
            <main className="content" ref={main} tabIndex={-1} key={loc.pathname.split('/')[1]}>{page}</main>
          </div>
        </>
      )}
      <SignInIsland />
      <ToastRoot />
      <ConfirmRoot />
      <DesktopNotifier />
      <AccessWatcher />
      <CommandPalette />
      <AssistantPanel />
      <ReminderAlerts />
      <AlertsSetup />
      <ComposerSlot />
      {chatOn && <ChatRealtime />}
      {chatOn && <ProjectChatHost />}
    </div>
  );
}
