import type { SectionLink } from '../../components/ui';
import { useAuth, useCan, useIsPersonal, useModule } from '../../stores/auth';

export type PeopleSection = 'directory' | 'invitations' | 'org-chart' | 'teams';

/** The People sections the signed-in person may open. */
export function usePeopleSections(): (SectionLink & { id: PeopleSection })[] {
  const personal = useIsPersonal();
  const isGuest = useAuth((s) => s.ctx?.current?.role === 'Guest');
  const canInvite = useCan('members.invite');
  const [mMembers, mOrg, mTeams] = [useModule('members'), useModule('organization'), useModule('teams')];
  if (personal) return [];
  return [
    ...(mMembers > 0 ? [{ id: 'directory' as const, to: '/people', label: 'Directory', icon: 'users' as const }] : []),
    ...(mMembers > 0 && canInvite ? [{ id: 'invitations' as const, to: '/people/invitations', label: 'Invitations', icon: 'mail' as const }] : []),
    ...(mOrg > 0 && !isGuest ? [{ id: 'org-chart' as const, to: '/people/org-chart', label: 'Org chart', icon: 'org' as const }] : []),
    ...(mTeams > 0 ? [{ id: 'teams' as const, to: '/people/teams', label: 'Teams', icon: 'layers' as const }] : []),
  ];
}

