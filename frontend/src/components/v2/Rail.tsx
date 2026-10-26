import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { chatApi, notificationApi } from '../../api/endpoints';
import { Icon } from '../Icon';
import { BrandMark } from '../BrandMark';
import { useAvatarUrl } from '../ui';
import { TeamLensPicker } from '../TeamLensPicker';
import { ThemeSwitch } from '../ThemeSwitch';
import { initials } from '../../lib/format';
import { haptic } from '../../lib/mobile';
import { setTitleParts } from '../../lib/title';
import { useAuth, useIsPersonal } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { chatKeys } from '../../features/chat/chatStore';
import { RunningTimer } from '../../features/time/RunningTimer';
import { inRail, useMainNav, type NavDef } from '../../layouts/navigation';
import { CreateOrganizationModal } from '../../layouts/parts';
import { supportMailto } from '../../lib/support';
import { openNew } from './state';
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

function useNotificationsUnread() {
  const wid = useAuth((s) => s.ctx?.current?.id);
  const admin = useAuth((s) => !!s.ctx?.user.isPlatformAdmin);
  const q = useQuery({ queryKey: [wid, 'notifications', 'unread'], queryFn: notificationApi.unread, refetchInterval: 60_000, enabled: !!wid && !admin });
  return q.data?.count ?? 0;
}

const isOn = (i: NavDef, path: string) => (i.match ? i.match(path) : i.end ? path === i.to : path === i.to || path.startsWith(`${i.to}/`));

/** The five places (or the administration places), each with what it holds in the badge. */
function usePlaces() {
  const groups = useMainNav();
  const talk = useTalkUnread();
  return groups.flatMap((g) => g.items).filter(inRail).map((i) => (i.id === 'talk' ? { ...i, badge: talk } : i));
}

/**
 * The v2 left rail (84px): the logo, + New, the five places with the icon above a short label, and the avatar at the bottom whose menu holds
 * Profile, Settings, People, the theme, the workspace and Sign out. Fixed: no customising, the same for everyone who may use each place.
 */
export function Rail() {
  const { pathname } = useLocation();
  const nav = useNavigate();
  const places = usePlaces();
  const admin = useAuth((s) => !!s.ctx?.user.isPlatformAdmin);
  return (
    <aside className="v2-rail" aria-label="Main">
      <button type="button" className="v2-rail-logo" aria-label="Home" title="Home" onClick={() => nav(admin ? '/admin' : '/')}><BrandMark size={20} /></button>
      {!admin && <button type="button" className="v2-new" aria-label="New" title="New (N)" onClick={() => openNew()}><Icon name="plus" size={20} /></button>}
      <nav className="v2-rail-nav">
        {places.map((i) => (
          <NavLink key={i.id ?? i.to} to={i.to} end={i.end} className={() => `v2-rail-item ${isOn(i, pathname) ? 'on' : ''}`} aria-current={isOn(i, pathname) ? 'page' : undefined} title={i.hint ?? i.label}>
            <Icon name={i.icon} size={20} />
            <span>{i.label}</span>
            {!!i.badge && <em className="v2-badge" aria-label={`${i.badge} unread`}>{i.badge > 99 ? '99+' : i.badge}</em>}
          </NavLink>
        ))}
      </nav>
      <div className="v2-rail-foot">
        {!admin && <RunningTimer />}
        <AvatarMenu />
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
  const unread = useNotificationsUnread();
  const [open, setOpen] = useState(false);
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
        {unread > 0 && <em className="v2-badge" aria-hidden="true">{unread > 9 ? '9+' : unread}</em>}
      </button>
      {open && (
        <div className="v2-menu" role="menu" aria-label="Account" ref={menu} onKeyDown={onKey}>
          <div className="v2-menu-head">
            <span className="v2-avatar lg" aria-hidden="true">{photo ? <img src={photo} alt="" /> : initials(user.displayName)}</span>
            <div><b>{user.displayName}</b><span>{user.email}</span><span>{admin ? 'Platform administrator' : `${current?.name ?? ''} · ${current?.role ?? ''}`}</span></div>
          </div>
          <button type="button" role="menuitem" className="v2-menu-item" onClick={() => go('/settings/profile')}><Icon name="user" size={16} /><span className="grow">Profile</span></button>
          {!admin && <button type="button" role="menuitem" className="v2-menu-item" onClick={() => go('/settings/notifications')}><Icon name="bell" size={16} /><span className="grow">Notifications</span>{unread > 0 && <em className="v2-badge">{unread > 99 ? '99+' : unread}</em>}</button>}
          {!admin && <button type="button" role="menuitem" className="v2-menu-item" onClick={() => go('/settings/general')}><Icon name="settings" size={16} /><span className="grow">Settings</span></button>}
          {!admin && !personal && <button type="button" role="menuitem" className="v2-menu-item" onClick={() => go('/people')}><Icon name="users" size={16} /><span className="grow">People</span></button>}
          <div className="v2-menu-sep" />
          <div className="v2-menu-row"><Icon name="moon" size={16} /><span className="grow">Dark mode</span><ThemeSwitch className="theme-toggle" /></div>
          {!admin && <div className="v2-menu-row v2-lens"><Icon name="users" size={16} /><span className="grow">Team view</span><TeamLensPicker /></div>}
          {!admin && (
            <>
              <div className="v2-menu-sep" />
              <div className="v2-menu-label">Workspaces</div>
              {ctx.workspaces.map((w) => (
                <button key={w.id} type="button" role="menuitem" className="v2-menu-item" aria-current={w.id === current?.id ? 'true' : undefined} onClick={() => void pick(w.id)}>
                  <span className="v2-ws">{w.name[0]?.toUpperCase()}</span><span className="grow">{w.name}</span>{w.id === current?.id && <Icon name="tick" size={15} />}
                </button>
              ))}
              <button type="button" role="menuitem" className="v2-menu-item" onClick={() => { close(false); setCreating(true); }}><Icon name="plus" size={16} /><span className="grow">Create organization</span></button>
            </>
          )}
          <div className="v2-menu-sep" />
          <a role="menuitem" className="v2-menu-item" href={supportMailto('Help with Project Tracker')} onClick={() => close(false)}><Icon name="mail" size={16} /><span className="grow">Help &amp; support</span></a>
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
  const tab = (i: NavDef) => (
    <NavLink key={i.id ?? i.to} to={i.to} end={i.end} className={() => `v2-phone-tab ${isOn(i, pathname) ? 'on' : ''}`} aria-label={i.label} onClick={() => haptic(6)}>
      <Icon name={i.icon} size={22} /><span>{i.label}</span>
      {!!i.badge && <em className="v2-badge">{i.badge > 99 ? '99+' : i.badge}</em>}
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
