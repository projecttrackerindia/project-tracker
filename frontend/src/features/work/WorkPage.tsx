import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PlaceTabs } from '../../components/v2/PlaceTabs';
import { useTabParam } from '../../components/v2/state';
import { useAuth, useIsPersonal, useModule } from '../../stores/auth';
import { MyWorkPage } from '../workitems/MyWorkPage';
import { WorkloadPage } from '../workitems/WorkloadPage';
import { WorkTasksPage } from './WorkTasksPage';

/**
 * PLACEHOLDER (v2 shell, wave 1): Work with its tabs, My work · Team · Tickets · Projects ›, showing today's pages until wave 2's one list
 * and side panel replace this file. Contract: export `WorkPage`; `/work?tab=tickets`; `/work?item=<id>` opens that item.
 */
export function WorkPage() {
  const mWork = useModule('work') > 0, mProjects = useModule('projects') > 0;
  const personal = useIsPersonal();
  const broad = useAuth((s) => (s.ctx?.current?.permissions ?? []).includes('reports.broad'));
  const hasReports = (useAuth((s) => s.ctx?.current?.reportCount) ?? 0) > 0;
  const tabs = [
    { id: 'mine' as const, label: 'My work' },
    ...(!personal && (hasReports || broad) ? [{ id: 'team' as const, label: 'Team' }] : []),
    ...(mWork ? [{ id: 'tickets' as const, label: 'Tickets' }] : []),
  ];
  const [tab, setTab] = useTabParam(tabs.map((t) => t.id), 'mine');
  // The v2 deep link (?item=) for tickets, until the side panel reads it: the tickets list opens ?task=.
  const [params, setParams] = useSearchParams();
  const item = params.get('item');
  useEffect(() => {
    if (tab === 'tickets' && item && !params.get('task')) { const n = new URLSearchParams(params); n.set('task', item); setParams(n, { replace: true }); }
  }, [tab, item, params, setParams]);
  return (
    <>
      <PlaceTabs label="Work" options={tabs} value={tab} onChange={setTab} link={mProjects ? { to: '/work/projects', label: 'Projects' } : undefined} />
      {tab === 'tickets' ? <WorkTasksPage /> : tab === 'team' ? <WorkloadPage /> : <MyWorkPage />}
    </>
  );
}
