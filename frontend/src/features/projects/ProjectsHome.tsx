import { PlaceTabs } from '../../components/v2/PlaceTabs';
import { useTabParam } from '../../components/v2/state';
import { ProjectsPage } from './ProjectsPage';
import { ProjectStatusPage } from './ProjectStatusPage';

/**
 * PLACEHOLDER (v2 shell, wave 1): Projects with its Projects · Portfolio switch, showing today's pages until wave 2 replaces this file.
 * Contract: export `ProjectsHome`; `/work/projects?view=portfolio`.
 */
export function ProjectsHome() {
  const [view, setView] = useTabParam(['projects', 'portfolio'] as const, 'projects', 'view');
  return (
    <>
      <PlaceTabs label="Projects" options={[{ id: 'projects', label: 'Projects' }, { id: 'portfolio', label: 'Portfolio' }]} value={view} onChange={setView} link={{ to: '/work', label: 'Work' }} />
      {view === 'portfolio' ? <ProjectStatusPage /> : <ProjectsPage />}
    </>
  );
}
