import { Navigate } from 'react-router-dom';
import { Embedded, PageHead, RouteTabs } from '../../components/ui';
import { usePeopleSections, type PeopleSection } from './sections';
import { DirectoryPanel, InvitationsPanel } from '../members/MembersPage';
import { OrgPage } from '../organization/OrgPage';
import { TeamsPage } from '../teams/TeamsPage';

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
