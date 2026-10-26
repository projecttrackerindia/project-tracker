import { useSearchParams } from 'react-router-dom';
import { PlaceTabs } from '../../components/v2/PlaceTabs';
import { useTabParam } from '../../components/v2/state';
import { useAuth, useCan, useIsPersonal, useModule } from '../../stores/auth';
import { AgentWorkflowsPage } from '../ai/AgentWorkflowsPage';
import { ReportsPage } from '../reports/ReportsPage';
import { TimesheetPage } from '../time/TimesheetPage';
import { WorkloadPage } from '../workitems/WorkloadPage';

type TimeSection = 'week' | 'approvals' | 'insights' | 'entries';
const TIME: readonly TimeSection[] = ['week', 'approvals', 'insights', 'entries'];

/**
 * PLACEHOLDER (v2 shell, wave 1): Insights with its tabs Overview · Time · Reports, showing today's Workload, Timesheet and Reports until the
 * Insights builder replaces this file. Contract: export `InsightsPage`; `/insights?tab=time|reports`; `&s=` a section of the old page
 * (capacity; approvals | insights | entries; operations); `?tab=time&log=<words>` logs time; `?tab=workflows` the agent workflows.
 */
export function InsightsPage() {
  const [params] = useSearchParams();
  const personal = useIsPersonal();
  const hasReports = (useAuth((s) => s.ctx?.current?.reportCount) ?? 0) > 0;
  const broad = useCan('reports.broad'), viewReports = useCan('reports.view'), mReports = useModule('reports') > 0;
  const canReports = viewReports && mReports;
  const mTasks = useModule('tasks') > 0, mWork = useModule('work') > 0;
  const tabs = [
    ...(!personal && (hasReports || broad) ? [{ id: 'overview' as const, label: 'Overview' }] : []),
    ...(mTasks || mWork ? [{ id: 'time' as const, label: 'Time' }] : []),
    ...(canReports || mWork ? [{ id: 'reports' as const, label: 'Reports' }] : []),
  ];
  const ids = [...tabs.map((t) => t.id), 'workflows' as const];
  const [tab, setTab] = useTabParam(ids, tabs[0]?.id ?? 'workflows');
  const s = params.get('s');
  return (
    <>
      <PlaceTabs label="Insights" options={tabs} value={tab} onChange={setTab} />
      {tab === 'overview' && <WorkloadPage section={s === 'capacity' ? 'capacity' : 'workload'} />}
      {tab === 'time' && <TimesheetPage section={s && TIME.includes(s as TimeSection) ? (s as TimeSection) : 'week'} />}
      {tab === 'reports' && <ReportsPage section={s === 'operations' ? 'operations' : 'generate'} />}
      {tab === 'workflows' && <AgentWorkflowsPage />}
    </>
  );
}
