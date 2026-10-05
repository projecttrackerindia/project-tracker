import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { chatApi, notificationApi } from '../api/endpoints';
import { Icon, type IconName } from '../components/Icon';
import { BrandMark } from '../components/BrandMark';
import { Sheet } from '../components/Sheet';
import { ThemeSwitch } from '../components/ThemeSwitch';
import { openPalette } from '../components/CommandPalette';
import { initials, timeAgo } from '../lib/format';
import { haptic } from '../lib/mobile';
import { useTeamLens } from '../lib/teamLens';
import { queryClient, useAuth, useCan, useModule } from '../stores/auth';
import { toast } from '../stores/ui';
import { chatKeys } from '../features/chat/chatStore';
import { openReminderComposer, useReminderCounts } from '../features/reminders/store';
import { useWorkspaceSections } from '../features/settings/sections';
import { useAi, useAssistant } from '../features/ai/Assistant';
import { useMainNav } from './navigation';
import { CreateOrganizationModal, NOTIF_ICON } from './parts';
import { planStatus } from './AccountDock';

const TaskModal = lazy(() => import('../features/tasks/TaskModal').then((m) => ({ default: m.TaskModal })));
const ProjectFormModal = lazy(() => import('../features/projects/ProjectFormModal').then((m) => ({ default: m.ProjectFormModal })));
const WorkTaskModal = lazy(() => import('../features/work/WorkTaskModal').then((m) => ({ default: m.WorkTaskModal })));

const hue = (name: string) => { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

// ------------------------------------------------------------------ the top bar

/** Unread notifications for the bell. Shares its query with nothing else on a phone, so it is read here. */
function useUnread() {
  const wid = useAuth((s) => s.ctx?.current?.id);
  const q = useQuery({ queryKey: [wid, 'notifications', 'unread'], queryFn: notificationApi.unread, refetchInterval: 60_000, enabled: !!wid });
  return q.data?.count ?? 0;
}

/**
 * The phone's top bar: where you are (the organization, tap to switch) and the three things you reach for from anywhere: search, the team
 * you are looking at, and notifications. Page titles are not repeated here; they are the large title at the top of each screen.
 */
export function MobileTopBar() {
  const ctx = useAuth((s) => s.ctx)!;
  const admin = ctx.user.isPlatformAdmin;
  const [scrolled, setScrolled] = useState(false);
  const [sheet, setSheet] = useState<'org' | 'lens' | 'notes' | null>(null);
  const unread = useUnread();
  const { teams, team, ready } = useTeamLens();
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 4);
    on(); window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  const cur = ctx.current;
  return (
    <header className={`m-top ${scrolled ? 'scrolled' : ''}`}>
      <button type="button" className="m-org" onClick={() => { haptic(); setSheet('org'); }} aria-label="Switch workspace">
        <span className="m-org-mark">{admin ? <BrandMark size={16} /> : (cur?.name ?? '?')[0].toUpperCase()}</span>
        <span className="m-org-text"><b>{admin ? 'Platform' : cur?.name ?? 'Workspace'}</b><small>{admin ? 'Administration' : cur?.type === 'Personal' ? 'Personal' : cur?.role}</small></span>
        {!admin && <Icon name="chevronD" size={14} />}
      </button>
      <div className="m-top-actions">
        {!admin && ready && teams.length > 0 && (
          <button type="button" className={`m-icon ${team ? 'on' : ''}`} onClick={() => { haptic(); setSheet('lens'); }} aria-label={team ? `Team view: ${team.name}` : 'Team view: all teams'}>
            {team ? <span className="lens-chip" style={{ '--h': hue(team.name) } as React.CSSProperties}>{initials(team.name)}</span> : <Icon name="users" size={21} />}
          </button>
        )}
        <button type="button" className="m-icon" onClick={() => { haptic(); openPalette(); }} aria-label="Search"><Icon name="search" size={21} /></button>
        {!admin && (
          <button type="button" className="m-icon" onClick={() => { haptic(); setSheet('notes'); }} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
            <Icon name="bell" size={21} />{unread > 0 && <em className="m-badge">{unread > 9 ? '9+' : unread}</em>}
          </button>
        )}
      </div>
      {sheet === 'org' && !admin && <OrgSheet onClose={() => setSheet(null)} />}
      {sheet === 'lens' && <LensSheet onClose={() => setSheet(null)} />}
      {sheet === 'notes' && <NotificationsSheet onClose={() => setSheet(null)} />}
    </header>
  );
}

function OrgSheet({ onClose }: { onClose: () => void }) {
  const ctx = useAuth((s) => s.ctx)!;
  const switchWorkspace = useAuth((s) => s.switchWorkspace);
  const [creating, setCreating] = useState(false);
  const pick = async (id: string) => {
    if (id === ctx.current?.id) { onClose(); return; }
    haptic();
    try { await switchWorkspace(id); toast('Workspace switched.', 'info'); onClose(); } catch { toast('Could not switch workspace.', 'error'); }
  };
  return (
    <>
      <Sheet title="Workspaces" onClose={onClose}>
        <ul className="m-list">
          {ctx.workspaces.map((w) => (
            <li key={w.id}>
              <button type="button" className={`m-row ${w.id === ctx.current?.id ? 'on' : ''}`} onClick={() => void pick(w.id)}>
                <span className="m-org-mark lg">{w.name[0].toUpperCase()}</span>
                <span className="m-row-main"><b>{w.name}</b><small>{w.type} · {w.role} · {w.planCode}</small></span>
                {w.id === ctx.current?.id && <Icon name="tick" size={18} />}
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="m-row add" onClick={() => setCreating(true)}><span className="m-row-ico"><Icon name="plus" size={18} /></span><span className="m-row-main"><b>Create organization</b><small>A separate workspace for another team</small></span></button>
      </Sheet>
      {creating && <CreateOrganizationModal onClose={() => { setCreating(false); onClose(); }} />}
    </>
  );
}

function LensSheet({ onClose }: { onClose: () => void }) {
  const { teams, teamId, setTeam } = useTeamLens();
  const choose = (id: string | null) => { haptic(); setTeam(id); onClose(); };
  return (
    <Sheet title="Team view" onClose={onClose}>
      <p className="m-hint">Everything you see follows this choice: the dashboard, projects, reports and the assistant.</p>
      <ul className="m-list">
        <li><button type="button" className={`m-row ${!teamId ? 'on' : ''}`} onClick={() => choose(null)}>
          <span className="m-row-ico"><Icon name="layers" size={18} /></span><span className="m-row-main"><b>All teams</b><small>Everything you can see</small></span>{!teamId && <Icon name="tick" size={18} />}
        </button></li>
        {teams.map((t) => (
          <li key={t.id}><button type="button" className={`m-row ${teamId === t.id ? 'on' : ''}`} onClick={() => choose(t.id)}>
            <span className="lens-chip lg" style={{ '--h': hue(t.name) } as React.CSSProperties}>{initials(t.name)}</span>
            <span className="m-row-main"><b>{t.name}</b><small>{t.projects} project{t.projects === 1 ? '' : 's'} · {t.members} {t.members === 1 ? 'person' : 'people'}</small></span>{teamId === t.id && <Icon name="tick" size={18} />}
          </button></li>
        ))}
      </ul>
    </Sheet>
  );
}

function NotificationsSheet({ onClose }: { onClose: () => void }) {
  const wid = useAuth((s) => s.ctx?.current?.id);
  const nav = useNavigate();
  const list = useQuery({ queryKey: [wid, 'notifications', 'recent'], queryFn: () => notificationApi.list(1, true), enabled: !!wid });
  const refresh = () => queryClient.invalidateQueries({ queryKey: [wid, 'notifications'] });
  const readAll = useMutation({ mutationFn: notificationApi.readAll, onSuccess: refresh });
  const items = list.data?.items ?? [];
  const open = async (n: { id: string; link: string | null; isRead: boolean }) => {
    onClose();
    if (!n.isRead) { await notificationApi.read(n.id); void refresh(); }
    if (n.link) nav(n.link);
  };
  return (
    <Sheet title="Notifications" onClose={onClose}>
      {items.some((n) => !n.isRead) && <button type="button" className="m-text-btn" onClick={() => readAll.mutate()}>Mark all as read</button>}
      {list.isLoading ? <p className="m-hint">Loading…</p> : items.length === 0 ? <div className="m-empty"><Icon name="bell" size={26} /><b>You're all caught up</b><span>New activity shows up here.</span></div> : (
        <ul className="m-list">
          {items.slice(0, 20).map((n) => (
            <li key={n.id}><button type="button" className={`m-row note ${n.isRead ? '' : 'unread'}`} onClick={() => void open(n)}>
              <span className="m-row-ico emoji">{NOTIF_ICON[n.type] ?? '🔔'}</span>
              <span className="m-row-main"><b>{n.title}</b>{n.body && <small>{n.body}</small>}<em>{timeAgo(n.createdAt)}</em></span>
              {!n.isRead && <i className="m-dot" aria-label="Unread" />}
            </button></li>
          ))}
        </ul>
      )}
      <button type="button" className="m-text-btn center" onClick={() => { onClose(); nav('/notifications'); }}>See all notifications</button>
    </Sheet>
  );
}

// ------------------------------------------------------------------ the tab bar

interface Tab { to: string; label: string; icon: IconName; end?: boolean; badge?: number; match?: (p: string) => boolean }

/**
 * The bar at the bottom of a phone: the four places used most, a raised button to create something, and More for everything else. Which
 * places appear follows what this person may use, so nobody gets a tab that leads to a refusal.
 */
export function TabBar() {
  const ctx = useAuth((s) => s.ctx)!;
  const { pathname } = useLocation();
  const groups = useMainNav();
  const admin = ctx.user.isPlatformAdmin;
  const wid = ctx.current?.id;
  const canChat = !admin && ctx.current?.type !== 'Personal' && ctx.current?.role !== 'Guest';
  const chat = useQuery({ queryKey: chatKeys.unread(wid ?? ''), queryFn: () => chatApi.unread(), enabled: !!wid && canChat, refetchInterval: 90_000, staleTime: 30_000 });
  const reminders = useReminderCounts(!!wid && !admin);
  const [more, setMore] = useState(false);
  const [create, setCreate] = useState(false);

  const all = useMemo(() => groups.flatMap((g) => g.items).filter((i) => i.show !== false), [groups]);
  const find = (to: string) => all.find((i) => i.to === to);
  const badgeOf = (to: string) => (to === '/chat' ? chat.data?.count : to === '/reminders' ? reminders.data?.now : undefined);

  const tabs: Tab[] = useMemo(() => {
    if (admin) return all.slice(0, 3).map((i) => ({ to: i.to, label: i.label === 'Organizations' ? 'Orgs' : i.label, icon: i.icon, end: i.end }));
    const picks = ['/my-work', '/projects', '/chat', '/reminders', '/calendar'].map(find).filter(Boolean).slice(0, 2) as typeof all;
    const label: Record<string, string> = { '/': 'Home' };
    return [{ to: '/', label: 'Home', icon: 'dashboard' as IconName, end: true }, ...picks.map((i) => ({ to: i.to, label: label[i.to] ?? i.label, icon: i.icon, badge: badgeOf(i.to), match: i.match }))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, admin, chat.data?.count, reminders.data?.now]);

  // Something in the menu needs attention that no tab shows: a dot on More says so.
  const hidden = !admin && ['/chat', '/reminders'].filter((to) => !tabs.some((t) => t.to === to) && find(to) && (badgeOf(to) ?? 0) > 0).length > 0;
  const left = tabs.slice(0, 2), right = tabs.slice(2);
  const isOn = (t: Tab) => (t.match ? t.match(pathname) : t.end ? pathname === t.to : pathname === t.to || pathname.startsWith(`${t.to}/`));

  const tab = (t: Tab) => (
    <NavLink key={t.to} to={t.to} end={t.end} className={`m-tab ${isOn(t) ? 'on' : ''}`} onClick={() => haptic(6)} aria-label={t.label}>
      <span className="m-tab-ico"><Icon name={t.icon} size={22} />{!!t.badge && <em className="m-badge">{t.badge > 99 ? '99+' : t.badge}</em>}</span>
      <span className="m-tab-label">{t.label}</span>
    </NavLink>
  );

  return (
    <>
      {/* A floating capsule: the open place shows its name, the others are just their icons; Create floats beside it. */}
      <nav className="m-tabs" aria-label="Main">
        <div className="m-pill">
          {[...left, ...right].map(tab)}
          <button type="button" className={`m-tab ${more ? 'on' : ''}`} onClick={() => { haptic(6); setMore(true); }} aria-label="More">
            <span className="m-tab-ico"><span className="m-me">{initials(ctx.user.displayName)}</span>{hidden && <i className="m-dot top" />}</span>
            <span className="m-tab-label">More</span>
          </button>
        </div>
        {!admin && <button type="button" className={`m-fab ${create ? 'open' : ''}`} onClick={() => { haptic(12); setCreate(true); }} aria-label="Create"><Icon name="plus" size={26} /></button>}
      </nav>
      {more && <MoreSheet onClose={() => setMore(false)} badgeOf={badgeOf} />}
      {create && <CreateSheet onClose={() => setCreate(false)} />}
    </>
  );
}

// ------------------------------------------------------------------ more

function MoreSheet({ onClose, badgeOf }: { onClose: () => void; badgeOf: (to: string) => number | undefined }) {
  const ctx = useAuth((s) => s.ctx)!;
  const logout = useAuth((s) => s.logout);
  const groups = useMainNav();
  const sections = useWorkspaceSections();
  const seeBilling = useModule('billing') > 0;
  const ai = useAi();
  const askAi = useAssistant((s) => s.ask);
  const nav = useNavigate();
  const { user, current } = ctx;
  const admin = user.isPlatformAdmin;
  const plan = !admin ? current?.plan : undefined;
  const status = plan ? planStatus(plan) : null;
  const go = (to: string) => () => { onClose(); nav(to); };

  return (
    <Sheet title="Menu" onClose={onClose}>
      <button type="button" className="m-me-card" onClick={go('/account')}>
        <span className="m-me lg">{initials(user.displayName)}</span>
        <span className="m-row-main"><b>{user.displayName}</b><small>{user.email}</small>
          {plan && <em className="m-plan">{plan.name} plan{status && status.short !== 'Active' ? ` · ${status.short}` : ''}</em>}
          {admin && <em className="m-plan">Platform administrator</em>}</span>
        <Icon name="chevronR" size={18} />
      </button>

      {groups.map((g) => {
        const items = g.items.filter((i) => i.show !== false);
        if (!items.length) return null;
        return (
          <section key={g.title} className="m-group">
            <h4>{g.title}</h4>
            <div className="m-tiles">
              {items.map((i) => {
                const b = badgeOf(i.to);
                return (
                  <NavLink key={i.to} to={i.to} end={i.end} className="m-tile" onClick={() => { haptic(6); onClose(); }}>
                    <span className="m-tile-ico"><Icon name={i.icon} size={22} />{!!b && <em className="m-badge">{b > 99 ? '99+' : b}</em>}</span>
                    <span>{i.label}</span>
                  </NavLink>
                );
              })}
            </div>
          </section>
        );
      })}

      <section className="m-group">
        <h4>Account</h4>
        <ul className="m-list flat">
          {ai && !admin && <li><button type="button" className="m-row" onClick={() => { onClose(); askAi(); }}><span className="m-row-ico"><Icon name="sparkle" size={18} /></span><span className="m-row-main"><b>Ask the assistant</b></span><Icon name="chevronR" size={16} /></button></li>}
          <li><div className="m-row static"><span className="m-row-ico"><Icon name="moon" size={18} /></span><span className="m-row-main"><b>Appearance</b><small>Light or dark</small></span><ThemeSwitch className="theme-toggle" /></div></li>
          {!admin && <li><button type="button" className="m-row" onClick={go('/account/notifications')}><span className="m-row-ico"><Icon name="bell" size={18} /></span><span className="m-row-main"><b>Notification preferences</b></span><Icon name="chevronR" size={16} /></button></li>}
          {!admin && <li><button type="button" className="m-row" onClick={go('/account/mobile')}><span className="m-row-ico"><Icon name="bell" size={18} /></span><span className="m-row-main"><b>Mobile app &amp; phone sign-in</b></span><Icon name="chevronR" size={16} /></button></li>}
          <li><button type="button" className="m-row" onClick={go('/account/security')}><span className="m-row-ico"><Icon name="lock" size={18} /></span><span className="m-row-main"><b>Sign-in &amp; security</b></span><Icon name="chevronR" size={16} /></button></li>
          {sections.length > 0 && <li><button type="button" className="m-row" onClick={go('/settings')}><span className="m-row-ico"><Icon name="settings" size={18} /></span><span className="m-row-main"><b>Workspace settings</b></span><Icon name="chevronR" size={16} /></button></li>}
          {seeBilling && plan && <li><button type="button" className="m-row" onClick={go('/settings/billing')}><span className="m-row-ico"><Icon name="card" size={18} /></span><span className="m-row-main"><b>Plan and billing</b><small>{plan.name}{status ? ` · ${status.long}` : ''}</small></span><Icon name="chevronR" size={16} /></button></li>}
        </ul>
      </section>
      <button type="button" className="m-signout" onClick={() => { onClose(); void logout(); }}><Icon name="logout" size={18} /> Sign out</button>
    </Sheet>
  );
}

// ------------------------------------------------------------------ create

type Making = 'task' | 'project' | 'work' | null;

function CreateSheet({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const canTask = useCan('tasks.create') && useModule('tasks') > 0 && useModule('projects') > 0;
  const canProject = useCan('projects.create') && useModule('projects') >= 2;
  const canWork = useCan('work.create') && useModule('work') >= 2;
  const [making, setMaking] = useState<Making>(null);
  const done = () => { setMaking(null); onClose(); };

  const Action = ({ icon, title, sub, onClick, tone }: { icon: IconName; title: string; sub: string; onClick: () => void; tone: string }) => (
    <button type="button" className="m-make" onClick={() => { haptic(10); onClick(); }}>
      <span className={`m-make-ico ${tone}`}><Icon name={icon} size={22} /></span><span className="m-row-main"><b>{title}</b><small>{sub}</small></span>
    </button>
  );
  const hold = (node: ReactNode) => <Suspense fallback={null}>{node}</Suspense>;

  return (
    <>
      {!making && (
        <Sheet title="Create" onClose={onClose}>
          <div className="m-makes">
            {canTask && <Action icon="check" tone="violet" title="Task" sub="Add work to a project" onClick={() => setMaking('task')} />}
            <Action icon="alarm" tone="amber" title="Reminder" sub="Be nudged at the right time" onClick={() => { onClose(); openReminderComposer(); }} />
            {canProject && <Action icon="folder" tone="blue" title="Project" sub="Start something new" onClick={() => setMaking('project')} />}
            {canWork && <Action icon="bolt" tone="orange" title="Work task" sub="Support, bugs and requests" onClick={() => setMaking('work')} />}
          </div>
        </Sheet>
      )}
      {making === 'task' && hold(<TaskModal onClose={done} />)}
      {making === 'project' && hold(<ProjectFormModal onClose={done} onSaved={(id: string) => { done(); nav(`/projects/${id}`); }} />)}
      {making === 'work' && hold(<WorkTaskModal onClose={done} />)}
    </>
  );
}
