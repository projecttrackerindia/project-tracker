import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { notificationApi } from '../api/endpoints';
import { NotificationActions } from '../features/notifications/NotificationActions';
import { Icon } from '../components/Icon';
import { BrandMark } from '../components/BrandMark';
import { Sheet } from '../components/Sheet';
import { openPalette } from '../components/CommandPalette';
import { AvatarMenu } from '../components/v2';
import { initials, timeAgo } from '../lib/format';
import { haptic } from '../lib/mobile';
import { useTeamLens } from '../lib/teamLens';
import { queryClient, useAuth } from '../stores/auth';
import { toast } from '../stores/ui';
import { CreateOrganizationModal, NotifIcon } from './parts';

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
        <AvatarMenu />
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
              <NotifIcon type={n.type} className="m-row-ico" />
              <span className="m-row-main"><b>{n.title}</b>{n.body && <small>{n.body}</small>}<em>{timeAgo(n.shownAt ?? n.createdAt)}</em></span>
              {!n.isRead && <i className="m-dot" aria-label="Unread" />}
            </button>
            <div className="m-note-acts"><NotificationActions n={n} /></div></li>
          ))}
        </ul>
      )}
      <button type="button" className="m-text-btn center" onClick={() => { onClose(); nav('/settings/notifications/history'); }}>See all notifications</button>
    </Sheet>
  );
}
