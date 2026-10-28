import '../settings/settings-ds.css';
import './people.css';
import { Navigate } from 'react-router-dom';
import { Embedded, PageHead, RouteTabs } from '../../components/ui';
import { usePeopleSections, type PeopleSection } from './sections';
import { InvitationsPanel } from '../members/MembersPage';
import { TeamsPage } from '../teams/TeamsPage';
import { Directory } from './Directory';
import { OrgTreePage } from './OrgTree';
import { PersonPage } from './PersonPage';
import { RolesPage } from './RolesPage';

/**
 * People & Roles: everyone in the workspace, how they are organised (reporting lines, teams, the canvas chart), what each role can do
 * (Roles & access), invitations and teams, in one place. A person opens to their profile.
 */
export function PeoplePage({ section }: { section: PeopleSection }) {
  const sections = usePeopleSections();
  if (!sections.length) return <Navigate to="/" replace />;
  const wanted = section === 'person' ? 'directory' : section;
  if (!sections.some((s) => s.id === wanted)) {
    // A person's profile is open to anyone who shares the workspace, even without the directory.
    if (section !== 'person') return <Navigate to={sections[0].to} replace />;
  }
  return (
    <div className="pr-page">
      {section !== 'person' && <PageHead title="People & Roles" sub="Who is in this workspace, how they are organised, and what each role can do." />}
      {section !== 'person' && sections.length > 1 && <RouteTabs label="People & Roles" tabs={sections} />}
      <Embedded>
        {section === 'directory' && <Directory />}
        {section === 'person' && <PersonPage />}
        {section === 'org' && <OrgTreePage />}
        {section === 'roles' && <RolesPage />}
        {section === 'invitations' && <InvitationsPanel />}
        {section === 'teams' && <TeamsPage />}
      </Embedded>
    </div>
  );
}
