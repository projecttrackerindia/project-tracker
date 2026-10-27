import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { chatApi, insightApi, projectApi } from '../../api/endpoints';
import type { Project } from '../../api/types';
import { usePins, useContextMenu } from './pins';
import { Icon, type IconName } from '../Icon';
import { BrandMark } from '../BrandMark';
import { useAvatarUrl } from '../ui';
import { initials } from '../../lib/format';
import { haptic } from '../../lib/mobile';
import { setTitleParts } from '../../lib/title';
import { useWsQuery } from '../../lib/hooks';
import { inboxApi } from '../../features/home/inboxApi';
import { useAuth, useIsPersonal } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { chatKeys } from '../../features/chat/chatStore';
import { RunningTimer } from '../../features/time/RunningTimer';
import { inRail, useMainNav, type NavDef } from '../../layouts/navigation';
import { CreateOrganizationModal } from '../../layouts/parts';
import { supportMailto } from '../../lib/support';
import { openNew } from './state';
import { useMailUnread } from '../../features/mail/useMail';
import './v2.css';

/** Unread chat messages (the badge on Talk, and in the tab title so it shows when the app is in the background). */
function useTalkUnread() {
  const ctx = useAuth((s) => s.ctx);
  const wid = ctx?.current?.id;
  const canChat = !!ctx?.current && ctx.current.type !== 'Personal' && ctx.current.role !== 'Guest' && !ctx.user.isPlatformAdmin;
  const q = useQuery({ queryKey: chatKeys.unread(wid ?? ''), queryFn: () => chatApi.unread(), enabled: !!wid && canChat, refetchInterval: 90_000, staleTime: 30_000 });
  const n = q.data?.count ?? 0;
  useEffect(() => { setTitleParts({ unread: canChat ? n : 0 }); }, [n, canChat]);
  return canChat ? n : 0;
}

/** Open inbox rows (the badge on Home): the same query Home's inbox uses, so the two agree. Red when any row is urgent. */
function useInboxOpen() {
  const admin = useAuth((s) => !!s.ctx?.user.isPlatformAdmin);
  const q = useWsQuery(['inbox', 'rows', 'all'], () => inboxApi.list('all'), { enabled: !admin, refetchInterval: 90_000, staleTime: 30_000 });
  const rows = q.data?.rows ?? [];
  return { count: q.data?.counts?.all ?? rows.length, urgent: rows.some((r) => r.urgent), tickets: rows.filter((r) => r.kind === 'ticket').length };
}

const isOn = (i: NavDef, path: string) => (i.match ? i.match(path) : i.end ? path === i.to : path === i.to || path.startsWith(`${i.to}/`));

/** The five places (or the administration places), each with what it holds in the badge. */
function usePlaces() {
  const groups = useMainNav();
  const talk = useTalkUnread();
  const inbox = useInboxOpen();
  return groups.flatMap((g) => g.items).filter(inRail)
    .map((i) => (i.id === 'talk' ? { ...i, badge: talk } : i.id === 'home' ? { ...i, badge: inbox.count, calm: !inbox.urgent } : i)) as (NavDef & { calm?: boolean })[];
}

type SideItem = { key: string; to: string; label: string; icon: IconName; tint: string; on: boolean; badge?: number; calm?: boolean; hint?: string };
type SideGroup = { title: string | null; items: SideItem[] };

const TINT = {
  blue: 'linear-gradient(180deg,#3a9bff,#0071e3)', orange: 'linear-gradient(180deg,#ffb340,#ff9500)', red: 'linear-gradient(180deg,#ff6b6b,#ff3b30)',
  indigo: 'linear-gradient(180deg,#7d7bff,#5856d6)', teal: 'linear-gradient(180deg,#4fd1e0,#30b0c7)', green: 'linear-gradient(180deg,#5de06f,#28cd41)',
  amber: 'linear-gradient(180deg,#c9a77a,#a2845e)', gray: 'linear-gradient(180deg,#a3a3a8,#636366)', pink: 'linear-gradient(180deg,#ff6482,#ff2d55)',
};
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
  const myOpen = dash.data?.counts?.myOpen ?? 0;
  const deskOpen = inbox.tickets;
  const projectCount = (projectList.data?.items ?? []).filter((p) => p.status !== 'Completed' && p.status !== 'Cancelled' && p.status !== 'Archived').length;
  const all = groups.flatMap((g) => g.items).filter((i) => i.show !== false);
  const has = (to: string) => all.find((i) => i.to === to);
  const q = new URLSearchParams(search);
  const tab = q.get('tab');
  const onProjects = pathname === '/work/projects' || pathname.startsWith('/work/projects/');
  const portfolio = onProjects && q.get('view') === 'portfolio';
  const vault = pathname === '/library/vault' || pathname.startsWith('/library/vault/');
  const mk = (to: string, key: string, label: string, icon: IconName, tint: string, on: boolean, extra?: Partial<SideItem>): SideItem | null => {
    const d = has(to);
    return d ? { key, to, label, icon, tint, on, hint: d.hint, ...extra } : null;
  };
  const clean = (g: SideGroup) => ({ ...g, items: g.items.filter(Boolean) as SideItem[] });
  const home = pathname === '/' || pathname === '/dashboard' || pathname.startsWith('/approve/');
  return [
    clean({ title: null, items: [mk('/', 'home', 'Today', 'sun', TINT.blue, home && tab !== 'calendar', { badge: inbox.count, calm: !inbox.urgent })] as SideItem[] }),
    clean({ title: 'Work', items: [
      mk('/work', 'work', 'My Work', 'checkCircle', TINT.orange, pathname === '/work', { badge: myOpen, calm: true }),
      mk('/desk', 'desk', 'Desk', 'target', TINT.red, pathname === '/desk' || pathname.startsWith('/desk/'), { badge: deskOpen, calm: true }),
      mk('/quality', 'quality', 'Quality', 'bug', 'linear-gradient(180deg,#cf7bf0,#af52de)', pathname === '/quality' || pathname.startsWith('/quality/')),
    ] as SideItem[] }),
    clean({ title: 'Plan', items: [
      mk('/work/projects', 'projects', 'Projects', 'folder', TINT.indigo, onProjects && !portfolio, { badge: projectCount, calm: true }),
      mk('/work/projects?view=portfolio', 'portfolio', 'Portfolio', 'monitor', TINT.teal, portfolio),
      mk('/?tab=calendar', 'calendar', 'Calendar', 'calendar', TINT.red, home && tab === 'calendar'),
    ] as SideItem[] }),
    clean({ title: 'Together', items: [
      mk('/messages', 'talk', 'Messages', 'message', TINT.green, pathname === '/messages' || pathname.startsWith('/messages/') || pathname.startsWith('/calls/'), { badge: talk, calm: true }),
      mk('/mail', 'mail', 'Mail', 'mail', TINT.blue, pathname === '/mail' || pathname.startsWith('/mail/'), { badge: mailUnread, calm: true }),
      mk('/library', 'library', 'Library', 'note', TINT.amber, (pathname === '/library' || pathname.startsWith('/library/')) && !vault),
      mk('/library/vault', 'vault', 'Vault', 'key', TINT.gray, vault),
      mk('/insights', 'insights', 'Insights', 'chart', TINT.pink, pathname === '/insights' || pathname.startsWith('/insights/') || pathname === '/activity'),
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

/**
 * The v2 left sidebar (236px; the 84px icon rail below 1100px): the workspace and role, + New, the places in macOS-style sections with a
 * coloured tile each, pinned projects, and the avatar at the bottom whose menu holds Profile, Workspaces, Settings, People, Help and Sign out.
 */
export function Rail() {
  const { pathname } = useLocation();
  const nav = useNavigate();
  const admin = useAuth((s) => !!s.ctx?.user.isPlatformAdmin);
  const ctx = useAuth((s) => s.ctx);
  const places = usePlaces();
  const groups = useSideGroups();
  const canProjects = (ctx?.current?.modules?.projects ?? 0) > 0;
  const { list: pinned, pins } = usePinned(!admin && canProjects);
  const ctxMenu = useContextMenu();
  const [drag, setDrag] = useState<string | null>(null);
  return (
    <aside className="v2-rail v2-side" aria-label="Main">
      <div className="v2-side-ws">
        <button type="button" className="v2-rail-logo" aria-label="Home" title="Home" onClick={() => nav(admin ? '/admin' : '/')}><BrandMark size={20} /></button>
        <span className="v2-side-ws-text"><b>{admin ? 'Platform' : ctx?.current?.name ?? 'Workspace'}</b><small>{admin ? 'Administrator' : ctx?.current?.role ?? ''}</small></span>
      </div>
      {!admin && <button type="button" className="v2-new v2-rail-new" aria-label="New" title="New (N)" onClick={() => openNew()}><Icon name="plus" size={18} /><span className="v2-side-label">New</span></button>}
      <nav className="v2-rail-nav">
        {admin ? places.map((i) => (
          <NavLink key={i.id ?? i.to} to={i.to} end={i.end} className={() => `v2-rail-item ${isOn(i, pathname) ? 'on' : ''}`} aria-current={isOn(i, pathname) ? 'page' : undefined} title={i.hint ?? i.label}>
            <span className="v2-tile" style={{ background: TINT.gray }}><Icon name={i.icon} size={13} /></span>
            <span className="v2-rail-label">{i.label}</span>
          </NavLink>
        )) : groups.map((g) => (
          <div key={g.title ?? 'top'} className="v2-side-group" role="group" aria-label={g.title ?? 'Today'}>
            {g.title && <div className="v2-side-sl">{g.title}</div>}
            {g.items.map((i) => (
              <Link key={i.key} to={i.to} className={`v2-rail-item ${i.on ? 'on' : ''}`} aria-current={i.on ? 'page' : undefined} title={i.hint ?? i.label} data-place={i.key}>
                <span className="v2-tile" style={{ background: i.tint }}><Icon name={i.icon} size={13} /></span>
                <span className="v2-rail-label">{i.label}</span>
                {!!i.badge && <em className={`v2-badge${i.calm ? ' calm' : ''}`} aria-label={i.key === 'home' ? `${i.badge} waiting on you` : i.key === 'talk' || i.key === 'mail' ? `${i.badge} unread` : `${i.badge} open`}>{i.badge > 99 ? '99+' : i.badge}</em>}
              </Link>
            ))}
          </div>
        ))}
        {canProjects && !admin && pinned.length === 0 && (
          <div className="v2-side-group v2-side-pins" role="group" aria-label="Pinned projects">
            <div className="v2-side-sl">Pinned projects</div>
            <p className="v2-side-pin-empty" data-testid="pins-empty">Pin a project from its ··· menu to keep it here.</p>
          </div>
        )}
        {pinned.length > 0 && (
          <div className="v2-side-group v2-side-pins" role="group" aria-label="Pinned projects">
            <div className="v2-side-sl">Pinned projects</div>
            {pinned.map(({ project: p, pinned: explicit }, n) => (
              <div key={p.id} className={`v2-side-pin-row${drag === p.id ? ' dragging' : ''}`} data-pin={p.id} data-pinned={explicit ? 'true' : 'false'}
                draggable={explicit} onDragStart={(e) => { if (!explicit) return; setDrag(p.id); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDrag(null)}
                onDragOver={(e) => { if (drag && explicit && drag !== p.id) e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); if (drag && explicit) pins.move(drag, pins.pinned.indexOf(p.id)); setDrag(null); }}
                onContextMenu={(e) => ctxMenu.open(e, [explicit ? { label: 'Unpin from sidebar', icon: 'pinOff', onSelect: () => pins.unpin(p.id) } : { label: 'Pin to sidebar', icon: 'pin', onSelect: () => pins.pin(p.id) },
                  ...(!explicit ? [{ label: 'Hide from recents', icon: 'eyeOff' as const, onSelect: () => pins.unpin(p.id) }] : [])])}>
                <Link to={`/work/projects/${p.id}`} className={`v2-side-pin ${pathname === `/work/projects/${p.id}` ? 'on' : ''}`} title={p.name}>
                  <i style={{ background: PIN_DOTS[n % PIN_DOTS.length] }} /><span>{p.name}</span>
                </Link>
                <button type="button" className="v2-side-unpin" aria-label={explicit ? `Unpin ${p.name}` : `Hide ${p.name} from recents`} title={explicit ? 'Unpin' : 'Hide from recents'}
                  onClick={() => pins.unpin(p.id)}><Icon name="pinOff" size={12} /></button>
              </div>
            ))}
            {ctxMenu.menu}
          </div>
        )}
      </nav>
      <div className="v2-rail-foot">
        {!admin && <RunningTimer />}
        <div className="v2-side-me"><AvatarMenu /><span>{ctx?.user.displayName}</span></div>
      </div>
    </aside>
  );
}

/** The avatar and its menu: who you are, the workspace (switch or create one), Profile, Settings, People, theme, help, Sign out. */
export function AvatarMenu() {
  const ctx = useAuth((s) => s.ctx)!;
  const logout = useAuth((s) => s.logout);
  const switchWorkspace = useAuth((s) => s.switchWorkspace);
  const personal = useIsPersonal();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [wsOpen, setWsOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const { user, current } = ctx;
  const photo = useAvatarUrl(user.id, user.hasAvatar);
  const admin = user.isPlatformAdmin;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const close = (refocus = true) => { setOpen(false); if (refocus) trigger.current?.focus(); };
  const go = (to: string) => { close(false); nav(to); };
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => { e.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
  };
  const pick = async (id: string) => {
    close(false);
    if (id === current?.id) return;
    try { await switchWorkspace(id); toast('Workspace switched.', 'info'); } catch { toast('Could not switch workspace.', 'error'); }
  };

  return (
    <div ref={wrap}>
      <button type="button" ref={trigger} className="v2-avatar" aria-haspopup="menu" aria-expanded={open} aria-label={`Account: ${user.displayName}`}
        title={user.displayName} onClick={() => setOpen((o) => !o)}>
        {photo ? <img src={photo} alt="" /> : initials(user.displayName)}
      </button>
      {open && (
        <div className="v2-menu" role="menu" aria-label="Account" ref={menu} onKeyDown={onKey}>
          <div className="v2-menu-head">
            <span className="v2-avatar lg" aria-hidden="true">{photo ? <img src={photo} alt="" /> : initials(user.displayName)}</span>
            <div><b>{user.displayName}</b><span>{user.email}</span><span>{admin ? 'Platform administrator' : `${current?.name ?? ''} · ${current?.role ?? ''}`}</span></div>
          </div>
          <button type="button" role="menuitem" className="v2-menu-item" onClick={() => go('/settings/profile')}><Icon name="user" size={16} /><span className="grow">Profile</span></button>
          {!admin && <button type="button" role="menuitem" className="v2-menu-item" aria-expanded={wsOpen} onClick={() => setWsOpen((o) => !o)}><Icon name="building" size={16} /><span className="grow">Workspaces</span><span style={{ display: 'inline-flex', transform: wsOpen ? 'rotate(180deg)' : undefined }}><Icon name="chevronD" size={14} /></span></button>}
          {!admin && wsOpen && (
            <div className="v2-menu-sub">
              {ctx.workspaces.map((w) => (
                <button key={w.id} type="button" role="menuitem" className="v2-menu-item" aria-current={w.id === current?.id ? 'true' : undefined} onClick={() => void pick(w.id)}>
                  <span className="v2-ws">{w.name[0]?.toUpperCase()}</span><span className="grow">{w.name}</span>{w.id === current?.id && <Icon name="tick" size={15} />}
                </button>
              ))}
              <button type="button" role="menuitem" className="v2-menu-item" onClick={() => { close(false); setCreating(true); }}><Icon name="plus" size={16} /><span className="grow">Create organization</span></button>
            </div>
          )}
          {!admin && <button type="button" role="menuitem" className="v2-menu-item" onClick={() => go('/settings/general')}><Icon name="settings" size={16} /><span className="grow">Settings</span></button>}
          {!admin && !personal && <button type="button" role="menuitem" className="v2-menu-item" onClick={() => go('/people')}><Icon name="users" size={16} /><span className="grow">People</span></button>}
          <div className="v2-menu-sep" />
          <a role="menuitem" className="v2-menu-item" href={supportMailto('Help with Project Tracker')} onClick={() => close(false)}><Icon name="mail" size={16} /><span className="grow">Help</span></a>
          <button type="button" role="menuitem" className="v2-menu-item danger" onClick={() => { close(false); void logout(); }}><Icon name="logout" size={16} /><span className="grow">Sign out</span></button>
        </div>
      )}
      {creating && <CreateOrganizationModal onClose={() => setCreating(false)} />}
    </div>
  );
}

/** The phone's bottom bar: the same five places, and + New in the middle. The avatar (and its menu) sits in the phone's top bar. */
export function PhoneBar() {
  const { pathname } = useLocation();
  const places = usePlaces();
  const admin = useAuth((s) => !!s.ctx?.user.isPlatformAdmin);
  const shown = admin ? places.slice(0, 5) : places;
  const left = shown.slice(0, admin ? 5 : 2), right = admin ? [] : shown.slice(2);
  const tab = (i: NavDef & { calm?: boolean }) => (
    <NavLink key={i.id ?? i.to} to={i.to} end={i.end} className={() => `v2-phone-tab ${isOn(i, pathname) ? 'on' : ''}`} aria-label={i.label} onClick={() => haptic(6)}>
      <Icon name={i.icon} size={22} /><span className="v2-rail-label">{i.label}</span>
      {!!i.badge && <em className={`v2-badge${i.calm ? ' calm' : ''}`}>{i.badge > 99 ? '99+' : i.badge}</em>}
    </NavLink>
  );
  return (
    <nav className="v2-phone-bar m-tabs" aria-label="Main" style={{ gridTemplateColumns: `repeat(${shown.length + (admin ? 0 : 1)}, 1fr)` }}>
      {left.map(tab)}
      {!admin && <button type="button" className="v2-phone-new" aria-label="New" onClick={() => { haptic(12); openNew(); }}><Icon name="plus" size={24} /></button>}
      {right.map(tab)}
    </nav>
  );
}
