import { useState } from 'react';
import type { ReportKind } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { PageHead } from '../../components/ui';
import { ExportList, KIND_INFO, ReportGenerator } from './Exports';

const TABS: [ReportKind, IconName][] = [['Project', 'folder'], ['Workload', 'users'], ['Timesheet', 'clock']];

/** Reports, dedicated to generating them: pick a type, set filters, generate, then download once it's ready
 *  below. Live charts and summaries moved to the Dashboard. */
export function ReportsPage() {
  const [kind, setKind] = useState<ReportKind>('Project');
  const [exportKey, setExportKey] = useState(0);

  return (
    <>
      <PageHead title="Reports" sub="Generate a project, workload or timesheet report" />
      <div className="seg mb-18" role="group" aria-label="Report type">
        {TABS.map(([k, icon]) => (
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
