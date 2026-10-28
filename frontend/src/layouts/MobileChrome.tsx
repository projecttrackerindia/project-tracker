import { useEffect, useState } from 'react';
import { NotificationBell } from '../features/notifications/centre/NotificationCentre';
import { Icon } from '../components/Icon';
import { BrandMark } from '../components/BrandMark';
import { Sheet } from '../components/Sheet';
import { openPalette } from '../components/CommandPalette';
import { AvatarMenu } from '../components/v2';
import { openNew } from '../components/v2/state';
import { initials } from '../lib/format';
import { haptic } from '../lib/mobile';
import { useTeamLens } from '../lib/teamLens';
import { useAuth } from '../stores/auth';
import { toast } from '../stores/ui';
import { CreateOrganizationModal } from './parts';

const hue = (name: string) => { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

// ------------------------------------------------------------------ the top bar

/**
 * The phone's top bar: where you are (the organization, tap to switch) and the three things you reach for from anywhere: search, the team
 * you are looking at, and notifications. Page titles are not repeated here; they are the large title at the top of each screen.
 */
export function MobileTopBar() {
  const ctx = useAuth((s) => s.ctx)!;
  const admin = ctx.user.isPlatformAdmin;
  const [scrolled, setScrolled] = useState(false);
  const [sheet, setSheet] = useState<'org' | 'lens' | null>(null);
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
        {!admin && <button type="button" className="m-icon m-new" onClick={() => { haptic(12); openNew(); }} aria-label="New"><Icon name="plus" size={20} /></button>}
        <button type="button" className="m-icon" onClick={() => { haptic(); openPalette(); }} aria-label="Search"><Icon name="search" size={21} /></button>
        {!admin && <NotificationBell variant="phone" />}
        <AvatarMenu />
      </div>
      {sheet === 'org' && !admin && <OrgSheet onClose={() => setSheet(null)} />}
      {sheet === 'lens' && <LensSheet onClose={() => setSheet(null)} />}
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
