import '../settings/settings-ds.css';
import './people.css';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { CalmHero, CalmPills } from '../../components/calm';
import { CalmOrgChart } from './CalmOrgChart';
import { useMembers, useTeams } from './peopleData';
import './calm-people.css';
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
  return <PeopleBody section={section} sections={sections} />;
}

const HERO: Record<PeopleSection, string> = { directory: 'People.', person: '', org: 'Org chart.', roles: 'Roles & access.', invitations: 'Invitations.', teams: 'Teams.' };

function PeopleBody({ section, sections }: { section: PeopleSection; sections: ReturnType<typeof usePeopleSections> }) {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const members = useMembers();
  const teams = useTeams();
  const classicOrg = section === 'org' && !!params.get('view');
  const people = members.data?.length ?? 0;
  const teamCount = teams.data?.length ?? 0;
  const main = (['org', 'teams', 'directory'] as const).filter((id) => sections.some((s) => s.id === id));
  const others = sections.filter((s) => !main.includes(s.id as typeof main[number]));
  if (section !== 'person' && !classicOrg) return (
    <div className="cp-page">
      <div className="calm-page-crumb"><Link to="/people">People</Link>{section !== 'directory' && <> › {HERO[section].replace('.', '')}</>}</div>
      <CalmHero title={HERO[section]} second={people ? `${people} ${people === 1 ? 'person' : 'people'}${teamCount ? ` across ${teamCount} ${teamCount === 1 ? 'team' : 'teams'}` : ''}.` : undefined} />
      <div className="cp-bar">
        {main.length > 1 && <CalmPills label="People views" value={(main as readonly string[]).includes(section) ? section : 'directory'}
          options={main.map((id) => ({ value: id, label: id === 'org' ? 'Org chart' : id === 'teams' ? 'Teams' : 'People' }))}
          onChange={(v) => nav(sections.find((s) => s.id === v)!.to)} />}
        {others.map((s) => <Link key={s.id} className="calm-link" to={s.to}>{s.label} ›</Link>)}
        {section === 'org' && <Link className="calm-link" to="/people/org?view=lines">Job roles &amp; lines ›</Link>}
      </div>
      {section === 'org' ? <CalmOrgChart /> : (
        <Embedded>
          {section === 'directory' && <Directory />}
          {section === 'roles' && <RolesPage />}
          {section === 'invitations' && <InvitationsPanel />}
          {section === 'teams' && <TeamsPage />}
        </Embedded>
      )}
    </div>
  );
  return (
    <div className="pr-page">
      {section !== 'person' && <PageHead title="People & Roles" sub="Who is in this workspace, how they are organised, and what each role can do." />}
      {section !== 'person' && sections.length > 1 && <RouteTabs label="People & Roles" tabs={sections} />}
      <Embedded>
        {section === 'person' && <PersonPage />}
        {section === 'org' && <OrgTreePage />}
      </Embedded>
    </div>
  );
}
