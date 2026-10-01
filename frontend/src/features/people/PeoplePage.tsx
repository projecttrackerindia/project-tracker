import { Navigate } from 'react-router-dom';
import { Embedded, PageHead, RouteTabs, type SectionLink } from '../../components/ui';
import { useAuth, useCan, useIsPersonal, useModule } from '../../stores/auth';
import { DirectoryPanel, InvitationsPanel } from '../members/MembersPage';
import { OrgPage } from '../organization/OrgPage';
import { TeamsPage } from '../teams/TeamsPage';

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

/**
 * People: everyone in the workspace (with invitations), the org chart (job roles and reporting lines) and teams, in one place.
 * What people can access is decided in Workspace settings → Roles & access.
 */
export function PeoplePage({ section }: { section: PeopleSection }) {
  const sections = usePeopleSections();
  if (!sections.length) return <Navigate to="/" replace />;
  if (!sections.some((s) => s.id === section)) return <Navigate to={sections[0].to} replace />;
  return (
    <>
      <PageHead title="People" sub="Who is in this workspace, how they are organised, and the teams they work in." />
      {sections.length > 1 && <RouteTabs label="People" tabs={sections} />}
      <Embedded>
        {section === 'directory' && <DirectoryPanel />}
        {section === 'invitations' && <InvitationsPanel />}
        {section === 'org-chart' && <OrgPage />}
        {section === 'teams' && <TeamsPage />}
      </Embedded>
    </>
  );
}
