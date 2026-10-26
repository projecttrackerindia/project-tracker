import { useSearchParams } from 'react-router-dom';
import { PlaceTabs } from '../../components/v2/PlaceTabs';
import { ProjectsPage } from './ProjectsPage';
import { ProjectStatusPage } from './ProjectStatusPage';

/**
 * PLACEHOLDER (v2 shell, wave 1): Projects with its Projects · Portfolio switch, showing today's pages until wave 2 replaces this file.
 * Contract: export `ProjectsHome`; `/work/projects?view=portfolio` (the portfolio's own timeline view is `view=timeline`).
 */
export function ProjectsHome() {
  const [params, setParams] = useSearchParams();
  const v = params.get('view');
  const view = v === 'portfolio' || v === 'timeline' ? 'portfolio' : 'projects';
  return (
    <>
      <PlaceTabs label="Projects" options={[{ id: 'projects', label: 'Projects' }, { id: 'portfolio', label: 'Portfolio' }]} value={view}
        onChange={(t) => setParams(t === 'portfolio' ? { view: 'portfolio' } : {})} link={{ to: '/work', label: 'Work' }} />
      {view === 'portfolio' ? <ProjectStatusPage /> : <ProjectsPage />}
    </>
  );
}
