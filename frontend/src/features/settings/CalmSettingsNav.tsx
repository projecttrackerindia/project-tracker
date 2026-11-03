import { Link, useLocation } from 'react-router-dom';
import { useAuth, useModule } from '../../stores/auth';
import { approvalPoliciesEnabled } from './ApprovalPolicies';
import { leafHref, useWorkspaceSections, type WorkspaceSection } from './sections';
import { SettingsSearch } from './SettingsCenter';
import './calm-settings.css';

type Item = { label: string; to: string; match?: (path: string) => boolean };

/**
 * The calm settings list (shots 54, 55, 56d), gated by the signed-in person's real role and permissions:
 * Personal for everyone; Workspace for admins and owners (each row only where its permission allows); Billing for owners only;
 * My teams for anyone who manages people or leads a team. Every older section stays reachable from its group.
 */
export function CalmSettingsNav({ places, isPlatformAdmin }: { places: readonly string[]; isPlatformAdmin: boolean }) {
  const { pathname } = useLocation();
  const ws = useAuth((s) => s.ctx?.current);
  const leaves = new Set(useWorkspaceSections().map((l) => l.id));
  const mTeams = useModule('teams');
  const role = ws?.role;
  const admin = role === 'Owner' || role === 'Admin';
  const owner = role === 'Owner';
  const manager = !admin && ((ws?.reportCount ?? 0) > 0 || role === 'Manager');
  const leaf = (id: WorkspaceSection, label: string): Item | null => (leaves.has(id) ? { label, to: leafHref(id) } : null);

  const personal: Item[] = [
    { label: 'Profile', to: '/settings/profile', match: (p) => p.startsWith('/settings/profile') },
    ...(!isPlatformAdmin ? [{ label: 'Notifications', to: '/settings/notifications', match: (p: string) => p.startsWith('/settings/notifications') }] : []),
    { label: 'Appearance', to: '/settings/appearance' },
    { label: 'Security & sessions', to: '/settings/security/account' },
    ...(!isPlatformAdmin ? [{ label: 'Connected apps', to: '/settings/profile/accounts' }] : []),
  ];
  const workspace: Item[] = admin ? [
    places.includes('general') ? { label: 'General', to: '/settings/general', match: (p: string) => /^\/settings\/(general|fields|timelines)/.test(p) } : null,
    leaf('members', 'Members & invites'),
    mTeams > 0 ? { label: 'Teams', to: '/people/teams' } : null,
    { label: 'Roles & permissions', to: '/people/roles' },
    approvalPoliciesEnabled() ? { label: 'Approval policies', to: '/settings/approvals' } : null,
    leaf('attendance', 'Attendance & leave'),
    places.includes('integrations') ? { label: 'Integrations', to: '/settings/integrations', match: (p: string) => p.startsWith('/settings/integrations') && !p.endsWith('/mail') } : null,
    owner && places.includes('billing') ? { label: 'Billing', to: '/settings/billing' } : null,
    leaf('audit', 'Audit log'),
    leaf('security', 'Security policy') && { label: 'Security policy', to: leafHref('security'), match: (p: string) => p.startsWith('/settings/security') && !p.endsWith('/account') },
  ].filter((x): x is Item => !!x) : [];
  const teams: Item[] = manager ? [
    { label: 'My team', to: '/insights?tab=team' },
    ...(mTeams > 0 ? [{ label: 'Teams I lead', to: '/people/teams' }] : []),
    { label: 'Org chart', to: '/people/org' },
  ] : [];

  const group = (title: string, items: Item[]) => items.length > 0 && (
    <div className="cs-grp" role="group" aria-label={title}>
      <span className="cs-grp-t">{title}</span>
      {items.map((it) => {
        const on = it.match ? it.match(pathname) : pathname === it.to.split('?')[0];
        return <Link key={it.to + it.label} to={it.to} className={`cs-item${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined}>{it.label}</Link>;
      })}
    </div>
  );
  return (
    <nav className="set-mac-nav cs-nav" aria-label="Settings sections" data-testid="settings-nav">
      <SettingsSearch compact />
      {group('Personal', personal)}
      {group('My teams', teams)}
      {group('Workspace', workspace)}
    </nav>
  );
}
