import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import type { ReportKind } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { Embedded, PageHead, RouteTabs } from '../../components/ui';
import { useCan, useModule } from '../../stores/auth';
import { WorkReportsPage } from '../work/WorkReportsPage';
import { ExportList, KIND_INFO, ReportGenerator } from './Exports';

const TABS: [ReportKind, IconName][] = [['Project', 'folder'], ['Workload', 'users'], ['Timesheet', 'clock'], ['WorkTasks', 'bolt']];

/**
 * Every downloadable report in one place: pick a type, set filters, generate, then download once it is ready below. The files are built
 * in the background, so a large report never holds this page waiting. Live charts are on the Dashboard, Workload and Operations analytics.
 */
export function ReportGenerateSection() {
  const [params] = useSearchParams();
  const seeWork = useModule('work') > 0;
  const kinds = TABS.filter(([k]) => k !== 'WorkTasks' || seeWork);
  const wanted = params.get('kind') as ReportKind | null;
  const [kind, setKind] = useState<ReportKind>(wanted && kinds.some(([k]) => k === wanted) ? wanted : 'Project');
  const [exportKey, setExportKey] = useState(0);

  return (
    <>
      <PageHead title="Generate a report" sub="CSV, Excel or PDF, built in the background and kept for 7 days." />
      <div className="seg mb-18" role="group" aria-label="Report type">
        {kinds.map(([k, icon]) => (
          <button key={k} type="button" className={kind === k ? 'active' : ''} aria-pressed={kind === k} title={KIND_INFO[k].label} onClick={() => setKind(k)}>
            <Icon name={icon} size={14} /><span>{KIND_INFO[k].label}</span>
          </button>
        ))}
      </div>
      <ReportGenerator kind={kind} onRequested={() => setExportKey((k) => k + 1)} />
      <ExportList refreshKey={exportKey} />
    </>
  );
}

/** Reports: generate files of any kind, and (with Work management) the operations analytics. Each is its own address. */
export function ReportsPage({ section }: { section: 'generate' | 'operations' }) {
  const permReports = useCan('reports.view'), modReports = useModule('reports');
  const canReports = permReports && modReports > 0;
  const seeWork = useModule('work') > 0;
  const tabs = [
    ...(canReports ? [{ to: '/reports', label: 'Generate reports', icon: 'download' as const }] : []),
    ...(seeWork ? [{ to: '/reports/operations', label: 'Operations analytics', icon: 'bolt' as const }] : []),
  ];
  if (section === 'generate' && !canReports && seeWork) return <Navigate to="/reports/operations" replace />;
  return (
    <>
      <PageHead title="Reports" sub="Every export in one place, and the analytics that go with them." />
      {tabs.length > 1 && <RouteTabs label="Reports" tabs={tabs} />}
      <Embedded>{section === 'operations' ? <WorkReportsPage /> : <ReportGenerateSection />}</Embedded>
    </>
  );
}
