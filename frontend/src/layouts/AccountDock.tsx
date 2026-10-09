import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { PlanSummary, PresenceStatus } from '../api/types';
import { Icon } from '../components/Icon';
import { RoleBadge, useAvatarUrl } from '../components/ui';
import { formatDate, initials } from '../lib/format';
import { useAuth, useModule } from '../stores/auth';
import { useUi } from '../stores/ui';
import { useWorkspaceSections } from '../features/settings/sections';
import { PRESENCE_LABEL, useChat } from '../features/chat/chatStore';

type Tone = 'ok' | 'info' | 'warn' | 'bad';

/** The plan's tier, for its colours: free, pro, business, enterprise (anything else looks like pro). */
const tierOf = (code: string) => {
  const c = code.toLowerCase();
  return c.includes('enterprise') ? 'enterprise' : c.includes('business') ? 'business' : c.includes('free') ? 'free' : 'pro';
};

/** What is worth knowing about the plan right now, short (for the sidebar) and in full (for the menu). */
export function planStatus(plan: PlanSummary): { short: string; long: string; tone: Tone } {
  const now = Date.now();
  if (plan.status === 'Trial' && plan.trialEnd) {
    const days = Math.max(0, Math.ceil((Date.parse(plan.trialEnd) - now) / 86_400_000));
    return days === 0
      ? { short: 'Trial ends today', long: 'Trial ends today', tone: 'warn' }
      : { short: `Trial · ${days}d left`, long: `Trial · ${days} day${days === 1 ? '' : 's'} left`, tone: days <= 3 ? 'warn' : 'info' };
  }
  if (plan.status === 'PastDue') return { short: 'Payment due', long: 'Payment overdue', tone: 'bad' };
  if (plan.status === 'Expired') return { short: 'Expired', long: 'Plan expired', tone: 'bad' };
  if (plan.status === 'Cancelled') return { short: 'Cancelled', long: 'Plan cancelled', tone: 'bad' };
  if (plan.downgraded) return { short: 'Limited', long: 'Running on reduced limits', tone: 'warn' };
  if (plan.cancelAtPeriodEnd && plan.periodEnd) return { short: `Ends ${formatDate(plan.periodEnd)}`, long: `Ends ${formatDate(plan.periodEnd)}`, tone: 'warn' };
  if (plan.periodEnd) return { short: 'Active', long: `Renews ${formatDate(plan.periodEnd)}`, tone: 'ok' };
  return { short: 'Active', long: 'Active', tone: 'ok' };
}

/**
 * The signed-in person, at the foot of the sidebar: who they are, the plan of the workspace they are in and how it stands, and a menu
 * for their account, the workspace settings (when they administer something) and signing out. When the sidebar is collapsed only the
 * avatar shows and the menu opens beside it.
 */
/** My own dot: green while I am active, amber once this tab has been idle for 5 minutes, grey while the live connection is down. */
function useMyPresence(): PresenceStatus {
  const me = useAuth((s) => s.ctx?.user.id);
  const link = useChat((s) => s.link);
  const mine = useChat((s) => (me ? s.status[me] : undefined));
  return link === 'reconnecting' || link === 'offline' ? 'offline' : mine ?? 'active';
}

export function AccountDock() {
  const presence = useMyPresence();
  const ctx = useAuth((s) => s.ctx)!;
  const logout = useAuth((s) => s.logout);
  const closeSidebar = useUi((s) => s.closeSidebar);
  const sections = useWorkspaceSections();
  const seeBilling = useModule('billing') > 0;
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const { user, current } = ctx;
  const photo = useAvatarUrl(user.id, user.hasAvatar);
  const isAdmin = user.isPlatformAdmin;
  const plan = !isAdmin ? current?.plan : undefined;
  const status = plan ? planStatus(plan) : null;
  const tier = plan ? tierOf(plan.code) : 'admin';

  // Close on a click elsewhere; Escape closes and gives focus back to the card.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const close = (refocus = true) => { setOpen(false); if (refocus) trigger.current?.focus(); };
  const go = (to: string) => { close(false); closeSidebar(); nav(to); };
  // Arrow keys move through the menu, Home / End jump to the ends, Escape closes it.
  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => { e.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(items.length - 1);
    else if (e.key === 'Tab') close(false);
  };

  const subline = isAdmin ? 'Platform administrator' : status && status.short !== 'Active' ? status.short : current?.role ?? '';

  return (
    <div className="sidebar-foot" ref={wrap}>
      {open && (
        <div className={`ad-menu tier-${tier}`} role="menu" aria-label="Account" ref={menu} onKeyDown={onMenuKey}>
          <div className="ad-head">
            <span className="ad-avatar lg" aria-hidden="true">{photo ? <img src={photo} alt="" /> : initials(user.displayName)}<i className={`ad-presence ${presence}`} role="img" aria-label={PRESENCE_LABEL[presence]} title={PRESENCE_LABEL[presence]} /></span>
            <div className="ad-who">
              <b title={user.displayName}>{user.displayName}</b>
              <span title={user.email}>{user.email}</span>
              <span className="ad-badges">{isAdmin ? <span className="badge badge-purple">Platform administrator</span> : current && <><RoleBadge role={current.role} /><em title={current.name}>{current.name}</em></>}</span>
            </div>
          </div>

          {plan && status && (
            <div className={`ad-plan tier-${tier}`}>
              <div className="ad-plan-top">
                <span className="ad-plan-name"><Icon name="star" size={14} />{plan.name} plan</span>
                <span className={`ad-plan-status ${status.tone}`}>{status.long}</span>
              </div>
              <div className="ad-plan-ws">{current?.type === 'Personal' ? 'Personal workspace' : 'Organization'} · {current?.name}</div>
              {seeBilling && (
                <button type="button" role="menuitem" className="ad-plan-cta" onClick={() => go('/settings/billing')}>
                  {plan.status === 'Trial' || tier === 'free' ? 'Compare plans' : status.tone === 'bad' ? 'Fix billing' : 'Manage plan'}<Icon name="arrowRight" size={14} />
                </button>
              )}
            </div>
          )}

          <div className="ad-items">
            <button type="button" role="menuitem" className="dp-menu-item" onClick={() => go('/account')}><Icon name="user" /> My account</button>
            {!isAdmin && <button type="button" role="menuitem" className="dp-menu-item" onClick={() => go('/account/notifications')}><Icon name="bell" /> Notification preferences</button>}
            {!isAdmin && <button type="button" role="menuitem" className="dp-menu-item" onClick={() => go('/account/mobile')}><Icon name="bell" /> Mobile app</button>}
            <button type="button" role="menuitem" className="dp-menu-item" onClick={() => go('/account/security')}><Icon name="lock" /> Sign-in &amp; security</button>
            {sections.length > 0 && <button type="button" role="menuitem" className="dp-menu-item" onClick={() => go('/settings')}><Icon name="settings" /> Workspace settings</button>}
          </div>
          <div className="dp-sep" />
          <button type="button" role="menuitem" className="dp-menu-item danger" onClick={() => { close(false); void logout(); }}><Icon name="logout" /> Sign out</button>
        </div>
      )}

      <button type="button" ref={trigger} className="account-dock" aria-haspopup="menu" aria-expanded={open} title={`${user.displayName} · account menu`}
        onClick={() => setOpen((o) => !o)}>
        <span className="ad-avatar" aria-hidden="true">{photo ? <img src={photo} alt="" /> : initials(user.displayName)}<i className={`ad-presence ${presence}`} role="img" aria-label={PRESENCE_LABEL[presence]} title={PRESENCE_LABEL[presence]} /></span>
        <span className="ad-main">
          <span className="ad-name">{user.displayName}</span>
          <span className="ad-sub">
            <span className={`plan-pill tier-${tier}`}>{isAdmin ? 'Admin' : plan?.name}</span>
            {subline && <span className={`ad-status ${status && status.short !== 'Active' ? status.tone : ''}`}>{subline}</span>}
          </span>
        </span>
        <Icon name="chevronD" size={15} className="ad-caret" />
      </button>
    </div>
  );
}

/** On small screens the sidebar is a drawer, so the top bar keeps a small avatar that opens it (where the account card is). */
export function TopbarMe() {
  const user = useAuth((s) => s.ctx?.user);
  const photo = useAvatarUrl(user?.id, user?.hasAvatar);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  return (
    <button type="button" className="topbar-me" onClick={toggleSidebar} aria-label="Open the menu and your account" title="Your account">
      <span className="ad-avatar sm" aria-hidden="true">{photo ? <img src={photo} alt="" /> : initials(user?.displayName)}</span>
    </button>
  );
}
