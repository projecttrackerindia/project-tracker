import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { insightApi, projectApi } from '../../api/endpoints';
import type { Project } from '../../api/types';
import { usePins } from './pins';
import { Icon, type IconName } from '../Icon';
import { Logo, BRAND } from '../Logo';
import { reminderApi } from '../../features/reminders/api';
import { useAvatarUrl } from '../ui';
import { initials } from '../../lib/format';
import { haptic } from '../../lib/mobile';
import { setTitleParts } from '../../lib/title';
import { useWsQuery } from '../../lib/hooks';
import { inboxApi } from '../../features/home/inboxApi';
import { useAuth, useIsPersonal } from '../../stores/auth';
import { toast, useUi } from '../../stores/ui';
import { badgeOf, useCanChat, useChatUnread } from '../../features/chat/unreadBadge';
import { RunningTimer } from '../../features/time/RunningTimer';
import { inRail, useMainNav, type NavDef } from '../../layouts/navigation';
import { CreateOrganizationModal } from '../../layouts/parts';
import { supportMailto } from '../../lib/support';
import { Sheet } from '../Sheet';
import { useMailUnread } from '../../features/mail/useMail';
import { get } from '../../api/client';
import { Popover } from '../../lib/popover';
import { PALETTES, avatarBg, meshOf, themeOf, type PersonThemeId } from '../../lib/personTheme';
import { useTabBadges } from '../../features/notifications/centre/NotificationCentre';
import type { Destination } from '../../features/notifications/centre/tabBadges';
import './v2.css';

/** The cache key of my /me/ui/profile (the card theme); the theme picker writes it too. */
export const MY_PROFILE_UI = ['me', 'ui', 'profile'] as const;

/**
 * Unread chat messages (the badge on Messages in the sidebar and the phone tab bar, and the number in the tab title). docs/badges.md:
 * a red number (99+), or a grey dot when only muted conversations have news.
 */
function useTalkUnread(): { n: number; dot: boolean } {
  const u = useChatUnread();
  const canChat = useCanChat();
  const { n, dot } = badgeOf(u);
  useEffect(() => { setTitleParts({ unread: canChat ? n : 0 }); }, [n, canChat]);
  return canChat ? { n, dot } : { n: 0, dot: false };
}

/** Open inbox rows (the badge on Home): the same query Home's inbox uses, so the two agree. Red when any row is urgent. */
function useInboxOpen() {
  const admin = useAuth((s) => !!s.ctx?.user.isPlatformAdmin);
  const q = useWsQuery(['inbox', 'rows', 'all'], () => inboxApi.list('all'), { enabled: !admin, refetchInterval: 90_000, staleTime: 30_000 });
  const rows = q.data?.rows ?? [];
  return { count: q.data?.counts?.all ?? rows.length, urgent: rows.some((r) => r.urgent), tickets: rows.filter((r) => r.kind === 'ticket').length,
    approvals: rows.filter((r) => r.kind === 'approval' || r.kind === 'access' || r.kind === 'decision' || r.kind === 'review').length };
}

const isOn = (i: NavDef, path: string) => (i.match ? i.match(path) : i.end ? path === i.to : path === i.to || path.startsWith(`${i.to}/`));

/** The five places (or the administration places), each with what it holds in the badge. */
function usePlaces() {
  const groups = useMainNav();
  const talk = useTalkUnread();
  const inbox = useInboxOpen();
  return groups.flatMap((g) => g.items).filter(inRail)
    .map((i) => (i.id === 'talk' ? { ...i, badge: talk.n, dot: talk.dot } : i.id === 'home' ? { ...i, badge: inbox.count, calm: !inbox.urgent } : i)) as (NavDef & { calm?: boolean; dot?: boolean })[];
}

type SideItem = { key: string; to: string; label: string; icon: IconName; tint: string; on: boolean; badge?: number; calm?: boolean; /** The blue count (Approvals). */ blue?: boolean; hint?: string; /** No number, but something new (muted chats): a grey dot. */ dot?: boolean };
type SideGroup = { title: string | null; items: SideItem[] };

const PIN_DOTS = ['#5856d6', '#ff9500', '#30b0c7'];

/** The projects this person opened most recently on this device (newest first, at most 10), per workspace. */
const recentKey = (wid: string) => `pt_recent_projects:${wid}`;
export function readRecentProjects(wid: string): string[] {
  try { const v = JSON.parse(localStorage.getItem(recentKey(wid)) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 10) : []; } catch { return []; }
}
function rememberProject(wid: string, id: string) {
  try { localStorage.setItem(recentKey(wid), JSON.stringify([id, ...readRecentProjects(wid).filter((x) => x !== id)].slice(0, 10))); } catch { /* storage blocked: pins fall back to recently updated */ }
}
/** Recent projects: the ones opened most recently here first, then the most recently updated, open projects only (minus `skip`). */
export function pickPinned(items: Project[], recent: string[], n = 3, skip: string[] = []): Project[] {
  const live = items.filter((p) => p.status !== 'Completed' && p.status !== 'Cancelled' && p.status !== 'Archived' && !skip.includes(p.id));
  const byId = new Map(live.map((p) => [p.id, p]));
  const first = recent.map((id) => byId.get(id)).filter(Boolean) as Project[];
  const rest = live.filter((p) => !recent.includes(p.id)).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return [...first, ...rest].slice(0, n);
}

/**
 * The sidebar's project list: only the projects this person pinned, in their order. Nothing is filled in automatically, so an unpinned
 * project leaves and nothing takes its place (recent projects are in Projects and in ⌘K instead).
 */
export function sidebarProjects(items: Project[], _recent: string[], pinned: string[], _hidden: string[]): { project: Project; pinned: boolean }[] {
  const byId = new Map(items.map((p) => [p.id, p]));
  return (pinned.map((id) => byId.get(id)).filter(Boolean) as Project[]).map((project) => ({ project, pinned: true }));
}

/** The sidebar's sections, built only from places and pages the person may open (the same definitions as the palette). */
function useSideGroups(): SideGroup[] {
  const { pathname, search } = useLocation();
  const groups = useMainNav();
  const talk = useTalkUnread();
  const inbox = useInboxOpen();
  const admin = useAuth((s) => !!s.ctx?.user.isPlatformAdmin);
  const mailUnread = useMailUnread(!admin);
  const canProjects = (useAuth((s) => s.ctx?.current?.modules?.projects) ?? 0) > 0;
  const dash = useWsQuery(['dashboard', null], () => insightApi.dashboard(null), { staleTime: 60_000, retry: false, enabled: !admin });
  const projectList = useWsQuery(['projects', 'health'], () => projectApi.list({ pageSize: 100 }), { staleTime: 60_000, retry: false, enabled: !admin && canProjects });
  const reminders = useWsQuery(['reminders', 'list'], reminderApi.list, { staleTime: 60_000, retry: false, enabled: !admin });
  const myOpen = dash.data?.counts?.myOpen ?? 0;
  const deskOpen = inbox.tickets;
  const projectCount = (projectList.data?.items ?? []).filter((p) => p.status !== 'Completed' && p.status !== 'Cancelled' && p.status !== 'Archived').length;
  const all = groups.flatMap((g) => g.items).filter((i) => i.show !== false);
  const has = (to: string) => all.find((i) => i.to === to);
  const q = new URLSearchParams(search);
  const tab = q.get('tab');
  const under = (root: string) => pathname === root || pathname.startsWith(`${root}/`);
  const onProjects = under('/work/projects');
  const portfolio = onProjects && q.get('view') === 'portfolio';
  const insights = under('/insights');
  const mk = (to: string, key: string, label: string, icon: IconName, on: boolean, extra?: Partial<SideItem>): SideItem | null => {
    const d = has(to);
    return d ? { key, to, label, icon, tint: '', on, hint: d.hint, ...extra } : null;
  };
  const clean = (g: SideGroup) => ({ ...g, items: g.items.filter(Boolean) as SideItem[] });
  const home = (pathname === '/' || pathname === '/dashboard') && tab !== 'calendar' && tab !== 'reminders';
  // docs/badges.md: a red number = unread notifications that belong to this place (they add up to the bell); with none, a place may keep
  // a calm grey count of what is open there (not a notification, not in the total). Approvals is the one blue count (the demo).
  const tabs = useTabBadges();
  const red = (d: Destination, calm?: number): Partial<SideItem> => (tabs[d] > 0 ? { badge: tabs[d], calm: false } : calm ? { badge: calm, calm: true } : {});
  const remindersOpen = reminders.data?.open?.length ?? 0;
  return [
    clean({ title: null, items: [
      mk('/', 'home', 'Today', 'sun', home, red('today')),
      mk('/approvals', 'approvals', 'Approvals', 'checkCircle', under('/approvals') || pathname.startsWith('/approve/'), inbox.approvals ? { badge: inbox.approvals, blue: true } : {}),
      mk('/work', 'work', 'My work', 'inbox', pathname === '/work', red('work', myOpen)),
      mk('/reminders', 'reminders', 'Reminders', 'alarm', under('/reminders') || (pathname === '/' && tab === 'reminders'), remindersOpen ? { badge: remindersOpen, calm: true } : {}),
      mk('/notes', 'notes', 'Notes', 'note', under('/notes')),
    ] as SideItem[] }),
    // The demo's order (scratchpad/demo shots 01, 32): the spec.
    clean({ title: 'Work', items: [
      mk('/work/projects', 'projects', 'Projects', 'folder', onProjects && !portfolio, projectCount ? { badge: projectCount, calm: true } : {}),
      mk('/work/projects?view=portfolio', 'portfolio', 'Portfolio', 'grid', portfolio, red('portfolio')),
      mk('/desk', 'desk', 'Desk', 'target', under('/desk'), red('desk', deskOpen)),
      mk('/quality', 'quality', 'Quality', 'shield', under('/quality')),
      mk('/?tab=calendar', 'calendar', 'Calendar', 'calendar', pathname === '/' && tab === 'calendar', red('calendar')),
      mk('/meetings', 'meetings', 'Meetings', 'video', under('/meetings') || pathname.startsWith('/calls/'), red('meetings')),
    ] as SideItem[] }),
    clean({ title: 'Communicate', items: [
      mk('/messages', 'talk', 'Messages', 'message', under('/messages'), { ...red('messages'), dot: tabs.messages === 0 && talk.dot }),
      mk('/mail', 'mail', 'Mail', 'mail', under('/mail'), red('mail', mailUnread)),
    ] as SideItem[] }),
    clean({ title: 'Know', items: [
      mk('/library', 'library', 'Library', 'layers', under('/library'), red('library')),
      mk('/insights?tab=reports', 'reports', 'Reports', 'list', insights && tab === 'reports'),
      mk('/insights', 'insights', 'Insights', 'chart', insights && tab !== 'reports' && tab !== 'time'),
      mk('/activity', 'activity', 'Activity', 'activity', pathname === '/activity'),
      mk('/people', 'people', 'People', 'users', under('/people')),
      mk('/insights?tab=time', 'time', 'Time', 'clock', insights && tab === 'time'),
    ] as SideItem[] }),
  ].filter((g) => g.items.length > 0);
}

/** Up to three projects (most recently opened here, then most recently updated) from the list Home already loads (shared cache). */
function usePinned(enabled: boolean) {
  const { pathname } = useLocation();
  const wid = useAuth((s) => s.ctx?.current?.id) ?? '';
  const [recent, setRecent] = useState(() => readRecentProjects(wid));
  useEffect(() => {
    const id = /^\/work\/projects\/([0-9a-f-]{8,})/i.exec(pathname)?.[1];
    if (wid && id) rememberProject(wid, id);
    setRecent(readRecentProjects(wid));
  }, [pathname, wid]);
  const q = useWsQuery(['projects', 'health'], () => projectApi.list({ pageSize: 100 }), { staleTime: 60_000, retry: false, enabled });
  const pins = usePins();
  return { list: sidebarProjects(q.data?.items ?? [], recent, pins.pinned, pins.hidden), pins };
}

/** The sidebar collapsed to its icon rail (the toggle at the top; remembered on this device). Below 1100px it is always the rail. */
const COLLAPSE_KEY = 'pt_side_collapsed';
const readCollapsed = () => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } };
export function useSideCollapsed(): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(readCollapsed);
  useEffect(() => {
    document.documentElement.classList.toggle('side-collapsed', v);
    return () => document.documentElement.classList.remove('side-collapsed');
  }, [v]);
  return [v, (n: boolean) => { setV(n); try { localStorage.setItem(COLLAPSE_KEY, n ? '1' : '0'); } catch { /* private window */ } }];
}

/**
 * The calm sidebar (236px; a 68px icon rail when collapsed or below 1100px): the workspace switcher with the ProjectTracker logo and the
 * collapse toggle, the places in captioned sections (fine line icons; the selected one a white raised pill with an accent icon; small pill
 * badges), and at the bottom the profile (its menu holds Profile, Workspaces, Settings, People, Appearance, Help and Sign out) and Settings.
 */
export function Rail() {
  const { pathname } = useLocation();
  const admin = useAuth((s) => !!s.ctx?.user.isPlatformAdmin);
  const places = usePlaces();
  const groups = useSideGroups();
  const [collapsed, setCollapsed] = useSideCollapsed();
  const badgeLabel = (i: SideItem) => (!i.calm && !i.blue ? `${i.badge} new` : i.key === 'approvals' ? `${i.badge} waiting on you` : i.key === 'talk' || i.key === 'mail' ? `${i.badge} unread` : `${i.badge} open`);
  return (
    <aside className={`v2-rail v2-side shell-side${collapsed ? ' collapsed' : ''}`} aria-label="Main">
      <div className="v2-side-ws shell-ws">
        <WorkspaceSwitcher />
        <button type="button" className="shell-ib shell-collapse" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-pressed={collapsed} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={() => setCollapsed(!collapsed)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="3" /><path d="M9.5 5v14" /></svg>
        </button>
      </div>
      <nav className="v2-rail-nav shell-nav">
        {admin ? places.map((i) => (
          <NavLink key={i.id ?? i.to} to={i.to} end={i.end} className={() => `v2-rail-item ${isOn(i, pathname) ? 'on' : ''}`} aria-current={isOn(i, pathname) ? 'page' : undefined} title={i.hint ?? i.label}>
            <span className="shell-ico"><Icon name={i.icon} size={17} /></span>
            <span className="v2-rail-label">{i.label}</span>
          </NavLink>
        )) : groups.map((g) => (
          <div key={g.title ?? 'top'} className="v2-side-group" role="group" aria-label={g.title ?? 'Your day'}>
            {g.title && <div className="v2-side-sl">{g.title}</div>}
            {g.items.map((i) => (
              <Link key={i.key} to={i.to} className={`v2-rail-item ${i.on ? 'on' : ''}`} aria-current={i.on ? 'page' : undefined} title={i.hint ?? i.label} data-place={i.key}>
                <span className="shell-ico"><Icon name={i.icon} size={17} /></span>
                <span className="v2-rail-label">{i.label}</span>
                {!!i.badge && <em className={`v2-badge${i.calm ? ' calm' : ''}${i.blue ? ' blue' : ''}`} data-badge={i.key} aria-label={badgeLabel(i)}>{i.badge > 99 ? '99+' : i.badge}</em>}
                {!i.badge && i.dot && <em className="v2-badge-dot" data-badge={i.key} aria-label="New messages in muted conversations" />}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="v2-rail-foot shell-foot">
        {!admin && <RunningTimer />}
        <div className="v2-side-me shell-me">
          <AvatarMenu variant="row" />
          {!admin && <Link to="/settings" className="shell-ib shell-gear" aria-label="Settings" title="Settings"><Icon name="settings" size={17} /></Link>}
        </div>
      </div>
    </aside>
  );
}

/** The workspace switcher at the top of the sidebar: the logo, ProjectTracker and the workspace; a menu to switch or create one. */
function WorkspaceSwitcher() {
  const ctx = useAuth((s) => s.ctx)!;
  const switchWorkspace = useAuth((s) => s.switchWorkspace);
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const admin = ctx.user.isPlatformAdmin;
  const cur = ctx.current;
  const pick = async (id: string) => {
    setOpen(false);
    if (id === cur?.id) return;
    try { await switchWorkspace(id); toast('Workspace switched.', 'info'); } catch { toast('Could not switch workspace.', 'error'); }
  };
  return (
    <>
      <button type="button" ref={trigger} className="shell-ws-btn" aria-haspopup="menu" aria-expanded={open} title={admin ? BRAND : `${BRAND} · ${cur?.name ?? ''}`}
        onClick={() => (admin ? nav('/admin') : setOpen((o) => !o))}>
        <Logo size={28} />
        <span className="v2-side-ws-text shell-wn"><b>{BRAND}</b><small>{admin ? 'Platform administration' : `${cur?.name ?? 'Workspace'} workspace`}</small></span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={trigger} role="menu" aria-label="Workspaces" className="acct-menu shell-ws-menu" side="bottom" align="start" gap={6}>
        <div className="acct-items">
          {ctx.workspaces.map((w) => (
            <button key={w.id} type="button" role="menuitem" className="v2-menu-item" aria-current={w.id === cur?.id ? 'true' : undefined} title={w.name} onClick={() => void pick(w.id)}>
              <span className="v2-ws">{w.name[0]?.toUpperCase()}</span><span className="grow">{w.name}<small className="shell-ws-sub">{w.type === 'Personal' ? 'Personal' : w.role}</small></span>{w.id === cur?.id && <Icon name="tick" size={15} />}
            </button>
          ))}
          <div className="v2-menu-sep" />
          <button type="button" role="menuitem" className="v2-menu-item" onClick={() => { setOpen(false); setCreating(true); }}><Icon name="plus" size={16} /><span className="grow">Create organization</span></button>
          <button type="button" role="menuitem" className="v2-menu-item" onClick={() => { setOpen(false); nav('/settings/general'); }}><Icon name="settings" size={16} /><span className="grow">Workspace settings</span></button>
        </div>
      </Popover>
      {creating && <CreateOrganizationModal onClose={() => setCreating(false)} />}
    </>
  );
}

/** My own card theme (saved at /me/ui/profile as { theme }; a stable default from my id otherwise). */
export function useMyTheme(userId: string | undefined): PersonThemeId {
  const q = useQuery({ queryKey: MY_PROFILE_UI, queryFn: async () => { try { return (await get<{ value: { theme?: string } | null }>('/me/ui/profile'))?.value ?? null; } catch { return null; } },
    staleTime: 5 * 60_000, retry: false, enabled: !!userId });
  return themeOf(userId, q.data?.theme);
}

/**
 * The account control: in the sidebar one whole-row button (photo with my theme ring, name, workspace · role, chevron); on the phone's
 * top bar just the ringed photo. It opens an Apple-style card above the row (the shared popover: flipped and clamped on-screen; a bottom
 * sheet on a phone) headed by my profile-card banner, then Profile, Workspaces, Settings, People, Appearance, Help and Sign out.
 */
export function AvatarMenu({ variant = 'icon' }: { variant?: 'row' | 'icon' }) {
  const ctx = useAuth((s) => s.ctx)!;
  const logout = useAuth((s) => s.logout);
  const switchWorkspace = useAuth((s) => s.switchWorkspace);
  const theme = useUi((s) => s.theme);
  const toggleTheme = useUi((s) => s.toggleTheme);
  const personal = useIsPersonal();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [wsOpen, setWsOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { user, current } = ctx;
  const photo = useAvatarUrl(user.id, user.hasAvatar);
  const admin = user.isPlatformAdmin;
  const mine = useMyTheme(user.id);
  const ring = { '--me-ring': avatarBg(mine), '--me-a': PALETTES[mine].a } as CSSProperties;
  const sub = admin ? 'Platform administrator' : [current?.name, current?.role].filter(Boolean).join(' · ');

  const close = () => setOpen(false);
  const go = (to: string) => { close(); nav(to); };
  const pick = async (id: string) => {
    close();
    if (id === current?.id) return;
    try { await switchWorkspace(id); toast('Workspace switched.', 'info'); } catch { toast('Could not switch workspace.', 'error'); }
  };
  const copyEmail = () => { void navigator.clipboard?.writeText(user.email).then(() => toast('Email copied.', 'info'), () => undefined); };
  const face = (cls: string) => <span className={`v2-avatar acct-face ${cls}`} style={photo ? undefined : { background: avatarBg(mine) }} aria-hidden="true">{photo ? <img src={photo} alt="" /> : initials(user.displayName)}</span>;

  return (
    <>
      {variant === 'row' ? (
        <button type="button" ref={trigger} className={`acct-row${open ? ' open' : ''}`} style={ring} data-theme-id={mine} aria-haspopup="menu" aria-expanded={open}
          aria-label={`Account: ${user.displayName}${sub ? `, ${sub}` : ''}`} title={user.displayName} onClick={() => setOpen((o) => !o)}>
          {face('acct-ringed')}
          <span className="acct-row-text"><b>{user.displayName}</b>{sub && <small>{sub}</small>}</span>
          <span className="acct-row-chev" aria-hidden="true"><Icon name="chevronD" size={13} /></span>
        </button>
      ) : (
        <button type="button" ref={trigger} className="acct-icon" style={ring} data-theme-id={mine} aria-haspopup="menu" aria-expanded={open}
          aria-label={`Account: ${user.displayName}`} title={user.displayName} onClick={() => setOpen((o) => !o)}>
          {face('acct-ringed')}
        </button>
      )}
      <Popover open={open} onClose={close} anchorRef={trigger} role="menu" aria-label="Account" className="acct-menu" side={variant === 'row' ? 'top' : 'bottom'} align={variant === 'row' ? 'start' : 'end'} gap={8}>
        <div className="acct-head" data-testid="acct-head" data-theme-id={mine} style={{ background: `linear-gradient(180deg, rgba(0, 0, 0, .04), rgba(0, 0, 0, .28)), ${meshOf(mine)}` }}>
          {face('lg')}
          <div className="acct-id">
            <b>{user.displayName}</b>
            <button type="button" className="acct-email" title={`${user.email} — click to copy`} onClick={copyEmail}>{user.email}</button>
            {sub && <span className="acct-ws">{sub}</span>}
          </div>
        </div>
        <div className="acct-items">
          <button type="button" role="menuitem" className="v2-menu-item" onClick={() => go('/settings/profile')}><Icon name="user" size={16} /><span className="grow">Profile</span></button>
          {!admin && <button type="button" role="menuitem" className="v2-menu-item" aria-expanded={wsOpen} onClick={() => setWsOpen((o) => !o)}><Icon name="building" size={16} /><span className="grow">Workspaces</span><small className="acct-cur">{ctx.workspaces.length > 1 ? 'Switch' : ''}</small><span style={{ display: 'inline-flex', transform: wsOpen ? 'rotate(180deg)' : undefined }}><Icon name="chevronD" size={14} /></span></button>}
          {!admin && wsOpen && (
            <div className="v2-menu-sub">
              {ctx.workspaces.map((w) => (
                <button key={w.id} type="button" role="menuitem" className="v2-menu-item" aria-current={w.id === current?.id ? 'true' : undefined} title={w.name} onClick={() => void pick(w.id)}>
                  <span className="v2-ws">{w.name[0]?.toUpperCase()}</span><span className="grow">{w.name}</span>{w.id === current?.id && <Icon name="tick" size={15} />}
                </button>
              ))}
              <button type="button" role="menuitem" className="v2-menu-item" onClick={() => { close(); setCreating(true); }}><Icon name="plus" size={16} /><span className="grow">Create organization</span></button>
            </div>
          )}
          {!admin && <button type="button" role="menuitem" className="v2-menu-item" onClick={() => go('/settings/general')}><Icon name="settings" size={16} /><span className="grow">Settings</span></button>}
          {!admin && !personal && <button type="button" role="menuitem" className="v2-menu-item" onClick={() => go('/people')}><Icon name="users" size={16} /><span className="grow">People</span></button>}
          <button type="button" role="menuitem" className="v2-menu-item" data-testid="acct-appearance" aria-label={`Appearance: ${theme === 'dark' ? 'Dark' : 'Light'}. Switch to ${theme === 'dark' ? 'light' : 'dark'}`}
            onClick={() => toggleTheme()}><Icon name="moon" size={16} /><span className="grow">Appearance</span>
            <span className="acct-seg" aria-hidden="true"><i className={theme !== 'dark' ? 'on' : ''}>Light</i><i className={theme === 'dark' ? 'on' : ''}>Dark</i></span></button>
          <div className="v2-menu-sep" />
          <a role="menuitem" className="v2-menu-item" href={supportMailto('Help with Project Tracker')} onClick={close}><Icon name="mail" size={16} /><span className="grow">Help</span></a>
          <button type="button" role="menuitem" className="v2-menu-item danger" onClick={() => { close(); void logout(); }}><Icon name="logout" size={16} /><span className="grow">Sign out</span></button>
        </div>
      </Popover>
      {creating && <CreateOrganizationModal onClose={() => setCreating(false)} />}
    </>
  );
}

/**
 * The phone's tab bar, the same on iPhone and Android: four places (Today, Work, Approvals, Messages) and More, which opens every other
 * place as a grid of app tiles with your pinned projects. + New lives in the top bar, so the tabs stay calm and equal. A solid frosted
 * bar with a hairline: nothing scrolls visibly through it.
 */
export function PhoneBar() {
  const { pathname, search } = useLocation();
  const nav = useNavigate();
  const places = usePlaces();
  const admin = useAuth((s) => !!s.ctx?.user.isPlatformAdmin);
  const groups = useSideGroups();
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [pathname, search]);
  const all = groups.flatMap((g) => g.items);
  const pick = (key: string) => all.find((i) => i.key === key);
  const primary = admin ? [] : (['home', 'work', 'approvals', 'talk'].map(pick).filter(Boolean) as SideItem[]);
  const rest = all.filter((i) => !primary.includes(i));
  const moreOn = !admin && rest.some((i) => i.on);
  const restBadge = rest.reduce((n, i) => n + (i.calm ? 0 : i.badge ?? 0), 0);
  if (admin) {
    return (
      <nav className="v2-phone-bar m-tabs" aria-label="Main" style={{ gridTemplateColumns: `repeat(${Math.min(5, places.length)}, 1fr)` }}>
        {places.slice(0, 5).map((i) => (
          <NavLink key={i.id ?? i.to} to={i.to} end={i.end} className={() => `v2-phone-tab ${isOn(i, pathname) ? 'on' : ''}`} onClick={() => haptic(6)}>
            <Icon name={i.icon} size={24} /><span className="v2-rail-label">{i.label}</span>
          </NavLink>
        ))}
      </nav>
    );
  }
  return (
    <>
      <nav className="v2-phone-bar m-tabs" aria-label="Main" style={{ gridTemplateColumns: `repeat(${primary.length + 1}, 1fr)` }}>
        {primary.map((i) => (
          <Link key={i.key} to={i.to} className={`v2-phone-tab ${i.on && !more ? 'on' : ''}`} aria-current={i.on ? 'page' : undefined} onClick={() => haptic(6)}>
            <span className="v2-phone-ic"><Icon name={i.icon} size={24} />{!!i.badge && <em className={`v2-badge${i.calm ? ' calm' : ''}`} data-badge={i.key} aria-label={i.key === 'talk' ? `${i.badge} unread` : undefined}>{i.badge > 99 ? '99+' : i.badge}</em>}{!i.badge && i.dot && <em className="v2-badge-dot" data-badge={i.key} aria-label="New messages in muted conversations" />}</span>
            <span className="v2-rail-label">{i.key === 'work' ? 'Work' : i.label}</span>
          </Link>
        ))}
        <button type="button" className={`v2-phone-tab ${moreOn || more ? 'on' : ''}`} aria-expanded={more} aria-haspopup="dialog" onClick={() => { haptic(6); setMore(true); }}>
          <span className="v2-phone-ic"><Icon name="grid" size={24} />{restBadge > 0 && <em className="v2-badge">{restBadge > 99 ? '99+' : restBadge}</em>}</span>
          <span className="v2-rail-label">More</span>
        </button>
      </nav>
      {more && (
        <Sheet title="Everything" onClose={() => setMore(false)} label="All places">
          <div className="v2-more-grid">
            {rest.map((i) => (
              <button key={i.key} type="button" className={`v2-more-tile${i.on ? ' on' : ''}`} onClick={() => { haptic(6); setMore(false); nav(i.to); }}>
                <span className="v2-tile lg shell-tile"><Icon name={i.icon} size={22} /></span>
                <span>{i.label}</span>
                {!!i.badge && <em className={`v2-badge${i.calm ? ' calm' : ''}`}>{i.badge > 99 ? '99+' : i.badge}</em>}
              </button>
            ))}
          </div>
          <PinnedInMore onGo={(to) => { setMore(false); nav(to); }} />
        </Sheet>
      )}
    </>
  );
}

/** Your pinned projects at the bottom of More, like the sidebar's. */
function PinnedInMore({ onGo }: { onGo: (to: string) => void }) {
  const admin = useAuth((s) => !!s.ctx?.user.isPlatformAdmin);
  const canProjects = (useAuth((s) => s.ctx?.current?.modules?.projects) ?? 0) > 0;
  const { list } = usePinned(!admin && canProjects);
  if (list.length === 0) return null;
  return (
    <div className="v2-more-pins">
      <div className="v2-side-sl">Pinned projects</div>
      {list.map(({ project: p }, n) => (
        <button key={p.id} type="button" className="v2-more-pin" onClick={() => onGo(`/work/projects/${p.id}`)}><i style={{ background: PIN_DOTS[n % PIN_DOTS.length] }} />{p.name}<Icon name="chevronR" size={14} /></button>
      ))}
    </div>
  );
}
