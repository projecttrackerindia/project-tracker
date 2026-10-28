import type { SectionLink } from '../../components/ui';
import { useAuth, useCan, useIsPersonal, useModule } from '../../stores/auth';

export type PeopleSection = 'directory' | 'person' | 'org' | 'roles' | 'invitations' | 'teams';

/** The People & Roles sections the signed-in person may open. */
export function usePeopleSections(): (SectionLink & { id: PeopleSection })[] {
  const personal = useIsPersonal();
  const isGuest = useAuth((s) => s.ctx?.current?.role === 'Guest');
  const canInvite = useCan('members.invite');
  const canAccess = useCan('access.manage');
  const canPermissions = useCan('permissions.manage');
  const canLevels = useCan('org.manage');
  const [mMembers, mOrg, mTeams] = [useModule('members'), useModule('organization'), useModule('teams')];
  if (personal) return [];
  return [
    ...(mMembers > 0 ? [{ id: 'directory' as const, to: '/people', label: 'People', icon: 'users' as const }] : []),
    ...((mOrg > 0 || mMembers > 0) && !isGuest ? [{ id: 'org' as const, to: '/people/org', label: 'Organization', icon: 'org' as const }] : []),
    ...(canAccess || canPermissions || canLevels ? [{ id: 'roles' as const, to: '/people/roles', label: 'Roles & access', icon: 'shield' as const }] : []),
    ...(mMembers > 0 && canInvite ? [{ id: 'invitations' as const, to: '/people/invitations', label: 'Invitations', icon: 'mail' as const }] : []),
    ...(mTeams > 0 ? [{ id: 'teams' as const, to: '/people/teams', label: 'Teams', icon: 'layers' as const }] : []),
  ];
}
