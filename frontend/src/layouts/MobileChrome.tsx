import { useEffect, useState } from 'react';
import { NotificationBell } from '../features/notifications/centre/NotificationCentre';
import { Icon } from '../components/Icon';
import { Logo } from '../components/Logo';
import { Sheet } from '../components/Sheet';
import { AuraPhoneOrb, AvatarMenu } from '../components/v2';
import { haptic } from '../lib/mobile';
import { TeamSwitcher } from '../components/shell/TeamSwitcher';
import { useAuth } from '../stores/auth';
import { toast } from '../stores/ui';
import { AttendanceCapsule } from '../features/attendance/AttendanceCapsule';
import { CreateOrganizationModal } from './parts';


// ------------------------------------------------------------------ the top bar

/**
 * The phone's top bar: where you are (the organization, tap to switch) and the three things you reach for from anywhere: search, the team
 * you are looking at, and notifications. Page titles are not repeated here; they are the large title at the top of each screen.
 */
export function MobileTopBar() {
  const ctx = useAuth((s) => s.ctx)!;
  const admin = ctx.user.isPlatformAdmin;
  const [scrolled, setScrolled] = useState(false);
  const [sheet, setSheet] = useState<'org' | null>(null);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 4);
    on(); window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  // The approved header (header-options-2): logo + workspace ▾ with "Role · Team" (the team switcher), then only Aura (search and ask in
  // one), the bell and the avatar on the right. The check-in is a small ring next to the workspace; tapping it opens the day sheet.
  return (
    <header className={`m-top m-top-r4 ${scrolled ? 'scrolled' : ''}`}>
      {admin ? (
        <button type="button" className="m-org" onClick={() => { haptic(); setSheet('org'); }} aria-label="Platform">
          <span className="m-org-mark"><Logo size={30} /></span>
          <span className="m-org-text"><b>Platform</b><small>Administration</small></span>
        </button>
      ) : <div className="m-top-left"><TeamSwitcher /><AttendanceCapsule ring /></div>}
      <div className="m-top-actions">
        {!admin && <AuraPhoneOrb />}
        {!admin && <NotificationBell variant="phone" />}
        <AvatarMenu />
      </div>
      {sheet === 'org' && admin && <OrgSheet onClose={() => setSheet(null)} />}
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
