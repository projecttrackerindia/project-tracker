import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { chatApi, insightApi, notificationApi, workspaceApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { Icon, type IconName } from '../components/Icon';
import { BrandMark } from '../components/BrandMark';
import { Field, Modal, PageLoader, SubmitButton, ToastRoot, ConfirmRoot } from '../components/ui';
import { timeAgo } from '../lib/format';
import { queryClient, useAuth, useCan, useIsPersonal } from '../stores/auth';
import { toast, useUi } from '../stores/ui';
import { RunningTimer } from '../features/time/RunningTimer';
import { AccessWatcher } from './AccessWatcher';
import { ChatRealtime } from '../features/chat/ChatRealtime';
import { ProjectChatHost } from '../features/chat/ProjectChat';
import { chatKeys } from '../features/chat/chatStore';
import { PlatformBanner } from '../components/PlatformBanner';
import { ThemeSwitch } from '../components/ThemeSwitch';
import { AccountDock, TopbarMe } from './AccountDock';
import { useVisibleKinds } from '../features/workitems/workItems';
import { usePeopleSections } from '../features/people/sections';

// ------------------------------------------------------------------ helpers
function useClickOutside(ref: React.RefObject<HTMLElement | null>, onOutside: () => void) {
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onOutside(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  });
}

const NOTIF_ICON: Record<string, string> = {
  TaskAssigned: '📌', Mention: '💬', Comment: '🗨️', DueSoon: '⏰', Overdue: '⚠️', Invitation: '✉️', Subscription: '💳', Security: '🔒', Issue: '🐞', Approval: '✅', ServiceLevel: '⏱️',
};

// ------------------------------------------------------------------ sidebar
/** `match`: the item is active for these addresses instead of just its own (for items that lead into a section with tabs). */
interface NavDef { to: string; label: string; icon: IconName; end?: boolean; show?: boolean; badge?: number; match?: (path: string) => boolean }

function Sidebar() {
  const { sidebarCollapsed, sidebarOpen, closeSidebar } = useUi();
  const ctx = useAuth((s) => s.ctx);
  const personal = useIsPersonal();
  const lv = (m: string) => ctx?.current?.modules?.[m] ?? 0;
  const permReports = useCan('reports.view'), broad = useCan('reports.broad');
  const canReports = permReports && lv('reports') > 0;
  const canChat = !personal && ctx?.current?.role !== 'Guest' && !ctx?.user.isPlatformAdmin;
  const kinds = useVisibleKinds();
  const people = usePeopleSections();
  const hasReports = (ctx?.current?.reportCount ?? 0) > 0;
  const { pathname } = useLocation();
  const peopleHas = (id: string) => people.some((s) => s.id === id);
  const wid = ctx?.current?.id;
  // Unread messages: kept current by live events; the slow refresh is only a safety net.
  const unread = useQuery({ queryKey: chatKeys.unread(wid ?? ''), queryFn: () => chatApi.unread(), enabled: !!wid && canChat, refetchInterval: 90_000, staleTime: 30_000 });

  const isPlatformAdmin = !!ctx?.user.isPlatformAdmin;
  // Platform administrators run the product (tenants, users, plans, billing, audit) — they get no workspace menus.
  const adminGroups: { title: string; items: NavDef[] }[] = [
    { title: 'Platform', items: [
      { to: '/admin', label: 'Overview', icon: 'dashboard', end: true },
      { to: '/admin/tenants', label: 'Organizations', icon: 'building' },
      { to: '/admin/users', label: 'Users', icon: 'users' },
      { to: '/admin/billing', label: 'Billing', icon: 'chart' },
      { to: '/admin/usage', label: 'Usage', icon: 'building' },
      { to: '/admin/plans', label: 'Plans', icon: 'card' },
      { to: '/admin/health', label: 'System health', icon: 'activity' },
      { to: '/admin/settings', label: 'Platform settings', icon: 'settings' },
      { to: '/admin/audit', label: 'Audit log', icon: 'shield' },
    ] },
  ];

  // Home: my own day. Delivery: the work itself. Insights: how it is going. Organization: the people.
  // The signed-in person, their plan and Workspace settings are in the account card at the foot of the sidebar.
  const workspaceGroups: { title: string; items: NavDef[] }[] = [
    { title: 'Home', items: [
      { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
      { to: '/my-work', label: 'My work', icon: 'inbox', show: kinds.length > 0 },
      { to: '/timesheet', label: 'Timesheet', icon: 'clock', show: lv('tasks') > 0 || lv('work') > 0 },
      { to: '/calendar', label: 'Calendar', icon: 'calendar', show: lv('calendar') > 0 },
      { to: '/chat', label: 'Chat', icon: 'message', show: canChat, badge: unread.data?.count },
    ] },
    { title: 'Delivery', items: [
      { to: '/projects', label: 'Projects', icon: 'folder', show: lv('projects') > 0 },
      { to: '/portfolio', label: 'Portfolio', icon: 'monitor', show: lv('projects') > 0 },
      { to: '/operations', label: 'Operations', icon: 'bolt', show: lv('work') > 0 },
    ] },
    { title: 'Insights', items: [
      { to: '/workload', label: 'Workload', icon: 'users', show: !personal && (hasReports || broad) },
      { to: '/reports', label: 'Reports', icon: 'chart', end: false, show: canReports || lv('work') > 0 },
      { to: '/activity', label: 'Activity', icon: 'activity', show: lv('activity') > 0 },
    ] },
    { title: 'Organization', items: [
      { to: '/people', label: 'People', icon: 'user', show: peopleHas('directory'), match: (p) => p === '/people' || p === '/people/invitations' },
      { to: '/people/org-chart', label: 'Org chart', icon: 'org', show: peopleHas('org-chart') },
      { to: '/people/teams', label: 'Teams', icon: 'layers', show: peopleHas('teams') },
    ] },
  ];
  const groups = isPlatformAdmin ? adminGroups : workspaceGroups;

  return (
    <>
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''} ${sidebarOpen ? 'open' : ''}`} id="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark"><BrandMark /></div>
          <div className="brand-text"><strong>{isPlatformAdmin ? 'Platform' : 'Projects'}</strong><span>{isPlatformAdmin ? 'Administration' : 'Workspace'}</span></div>
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
                    {!!i.badge && <em className="nav-count" aria-label={`${i.badge} unread`}>{i.badge > 99 ? '99+' : i.badge}</em>}
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
 * Shows a desktop notification for new items the user opted into ("Desktop" in Settings → Notifications) while the app is open.
 * Nothing is shown for older items on first run, and nothing works until the browser permission has been granted.
 */
function DesktopNotifier() {
  const wid = useAuth((s) => s.ctx?.current?.id);
  useEffect(() => {
    if (!wid) return;
    const key = `pm_desktop_seen_${wid}`;
    const read = () => { try { return Number(localStorage.getItem(key) ?? 0); } catch { return 0; } };
    const write = (v: number) => { try { localStorage.setItem(key, String(v)); } catch { /* storage unavailable */ } };
    const tick = async () => {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      try {
        const page = await notificationApi.list(1, true);
        const times = page.items.map((n) => Date.parse(n.createdAt));
        const last = read();
        const newest = Math.max(last, ...times, 0);
        if (last === 0) { write(newest || Date.now()); return; } // first run: do not replay history
        for (const n of page.items.filter((x) => x.browser && Date.parse(x.createdAt) > last).reverse()) {
          const note = new Notification(n.title, { body: n.body ?? undefined, tag: n.id });
          note.onclick = () => { window.focus(); if (n.link) window.location.assign(n.link); note.close(); };
        }
        write(newest);
      } catch { /* offline or signed out: try again next time */ }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, 30_000);
    return () => clearInterval(timer);
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
      const tag = (document.activeElement as HTMLElement | null)?.tagName ?? '';
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) { e.preventDefault(); input.current?.focus(); }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);

  const { data, isFetching } = useQuery({
    queryKey: ['search', debounced], queryFn: () => insightApi.search(debounced), enabled: debounced.length >= 2,
  });

  const go = (h: { type: string; id: string; projectId: string | null; taskId: string | null }) => {
    setOpen(false); setQ('');
    if (h.type === 'file') nav(h.taskId ? `/projects/${h.projectId}?task=${h.taskId}` : `/projects/${h.projectId}?tab=files`);
    else if (h.type === 'task' || h.type === 'comment') nav(`/projects/${h.projectId}?task=${h.taskId}`);
    else if (h.type === 'issue') nav(`/projects/${h.projectId}?tab=issues&issue=${h.id}`);
    else if (h.type === 'action') nav(`/projects/${h.projectId}?tab=actions&action=${h.id}`);
    else if (h.type === 'work') nav(`/operations?task=${h.id}`);
    else if (h.type === 'project') nav(`/projects/${h.id}`);
    else if (h.type === 'team') nav('/people/teams');
    else if (h.type === 'member') nav('/people');
    else if (h.type === 'label') nav('/settings/labels');
    else nav('/projects');
  };
  const groups: Record<string, string> = { task: 'Tasks', issue: 'Test issues', action: 'Action items', work: 'Operational work', project: 'Projects', team: 'Teams', member: 'People', comment: 'Comments', file: 'Files', label: 'Labels' };
  const icons: Record<string, IconName> = { task: 'check', issue: 'bug', action: 'flag', work: 'bolt', project: 'folder', team: 'users', member: 'user', comment: 'message', file: 'paperclip', label: 'tag' };
  const hits = data?.hits ?? [];

  return (
    <div className="global-search" ref={ref}>
      <span className="search-icon"><Icon name="search" /></span>
      <input ref={input} type="search" placeholder="Search work, projects, people… or a key like WT-12" autoComplete="off" aria-label="Global search" value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); input.current?.blur(); } }} />
      {!q && <span className="kbd">/</span>}
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

function CreateOrganizationModal({ onClose }: { onClose: () => void }) {
  const switchWorkspace = useAuth((s) => s.switchWorkspace);
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => workspaceApi.create({ name, description: description || undefined }),
    onSuccess: async (ws) => { await switchWorkspace(ws.id); toast(`Organization “${ws.name}” created.`); onClose(); nav('/'); },
    onError: (e) => setError(e instanceof ApiError ? (e.fieldError('name') ?? e.message) : 'Could not create the organization.'),
  });
  return (
    <Modal title="Create organization" subtitle="A separate workspace for your team, with its own members, projects and plan." onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); if (name.trim().length < 2) { setError('Enter a name (at least 2 characters).'); return; } setError(null); m.mutate(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={m.isPending}>Create organization</SubmitButton></>}>
      {error && <div className="form-error">{error}</div>}
      <div className="form-grid">
        <Field label="Organization name" required full><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Qruize Technologies" maxLength={80} /></Field>
        <Field label="Description" full><textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this team work on?" maxLength={500} /></Field>
      </div>
    </Modal>
  );
}

function WorkspaceSwitcher() {
  const ctx = useAuth((s) => s.ctx)!;
  const switchWorkspace = useAuth((s) => s.switchWorkspace);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  useClickOutside(ref, () => setOpen(false));
  const cur = ctx.current;

  const pick = async (id: string) => {
    setOpen(false);
    if (id === cur?.id) return;
    try { await switchWorkspace(id); nav('/'); toast('Workspace switched.', 'info'); }
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
        {!isPlatformAdmin && <RunningTimer />}
        {!isPlatformAdmin && <WorkspaceSwitcher />}
        <ThemeSwitch className="theme-toggle" />
        {!isPlatformAdmin && <NotificationsMenu />}
        <TopbarMe />
      </div>
    </header>
  );
}

export function AppLayout({ children }: { children?: ReactNode }) {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const loc = useLocation();
  const main = useRef<HTMLElement>(null);
  // The live chat connection runs for people who can chat: organization workspaces, not guests, not platform administrators.
  const chatOn = useAuth((s) => !!s.ctx?.current && s.ctx.current.type !== 'Personal' && s.ctx.current.role !== 'Guest' && !s.ctx.user.isPlatformAdmin);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [loc.pathname]);
  return (
    <div className="app-shell">
      <Sidebar />
      <div className={`main ${collapsed ? 'expanded' : ''}`}>
        <PlatformBanner />
        <Topbar />
        <main className="content" ref={main} tabIndex={-1} key={loc.pathname.split('/')[1]}><Suspense fallback={<PageLoader />}>{children ?? <Outlet />}</Suspense></main>
      </div>
      <ToastRoot />
      <ConfirmRoot />
      <DesktopNotifier />
      <AccessWatcher />
      {chatOn && <ChatRealtime />}
      {chatOn && <ProjectChatHost />}
    </div>
  );
}
