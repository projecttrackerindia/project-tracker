import { useMemo, useState } from 'react';
import { issueApi } from '../../api/endpoints';
import type { Issue, IssueStatus, Stage } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Avatar, EmptyState, ErrorState, PageLoader, PriorityBadge } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { ISSUE_STATUS_LABEL, IssueStatusBadge } from './issueMeta';
import { Select } from '../../components/Select';

type View = 'open' | 'resolved' | 'all';
const VIEWS: { id: View; label: string }[] = [{ id: 'open', label: 'Open' }, { id: 'resolved', label: 'Resolved' }, { id: 'all', label: 'All' }];
const ORDER: IssueStatus[] = ['Observed', 'InProgress', 'Fixed', 'Resolved'];

/**
 * The project's issues: what testers marked as Observed / Failed, who is fixing it and how far along it is. A stage is only completed
 * once every issue found in it is resolved.
 */
export function IssuesPanel({ projectId, stages, canReport, stageFilter, onStageFilter, onOpen, onReport }: {
  projectId: string; stages: Stage[]; canReport: boolean; stageFilter: string; onStageFilter: (stageId: string) => void;
  onOpen: (id: string) => void; onReport: (stageId?: string) => void;
}) {
  const [view, setView] = useState<View>('open');
  const q = useWsQuery(['issues', projectId], () => issueApi.list(projectId));
  const all = useMemo(() => q.data ?? [], [q.data]);
  const inStage = useMemo(() => (stageFilter ? all.filter((i) => i.stageId === stageFilter) : all), [all, stageFilter]);
  const shown = useMemo(() => inStage.filter((i) => view === 'all' || (view === 'open' ? i.status !== 'Resolved' : i.status === 'Resolved')), [inStage, view]);
  const count = (s: IssueStatus) => inStage.filter((i) => i.status === s).length;

  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>Issues</h3>
          <p>Failed tests and problems found while checking each stage. A stage is completed once all of its issues are resolved.</p>
        </div>
        {canReport && <button className="btn btn-primary btn-sm" onClick={() => onReport(stageFilter || undefined)}><Icon name="plus" /> Report issue</button>}
      </div>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Show issues">
          {VIEWS.map((v) => <button key={v.id} type="button" className={view === v.id ? 'active' : ''} aria-pressed={view === v.id} onClick={() => setView(v.id)}><span>{v.label}</span></button>)}
        </div>
        <Select className="select" style={{ maxWidth: 220 }} value={stageFilter} onChange={(e) => onStageFilter(e.target.value)} aria-label="Stage">
          <option value="">All stages</option>
          {stages.map((s) => <option key={s.id} value={s.id}>{s.name}{s.openIssues ? ` (${s.openIssues} open)` : ''}</option>)}
        </Select>
        <div className="issue-counts" aria-label="Issues by status">
          {ORDER.map((s) => <span key={s} className={`issue-count ${count(s) ? '' : 'zero'}`}><b>{count(s)}</b> {ISSUE_STATUS_LABEL[s]}</span>)}
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="card-body">
          <EmptyState icon={view === 'resolved' ? 'inbox' : 'checkCircle'}
            title={all.length === 0 ? 'No issues reported' : view === 'open' ? 'No open issues' : view === 'resolved' ? 'Nothing resolved yet' : 'No issues here'}
            text={all.length === 0
              ? (canReport ? 'When a test fails or something does not work as expected, report it here with the details and any screenshots.' : 'Nothing has been reported for this project.')
              : view === 'open' ? 'Everything found so far has been resolved.' : undefined}
            action={canReport && all.length === 0 ? <button className="btn btn-primary" onClick={() => onReport(stageFilter || undefined)}><Icon name="plus" /> Report issue</button> : undefined} />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="issue-table">
            <thead><tr><th>Issue</th><th>Stage</th><th>Status</th><th>Severity</th><th>Reported by</th><th>Assigned to</th><th>Reported</th></tr></thead>
            <tbody>
              {shown.map((i) => <IssueRow key={i.id} issue={i} onOpen={() => onOpen(i.id)} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function IssueRow({ issue: i, onOpen }: { issue: Issue; onOpen: () => void }) {
  return (
    <tr className="issue-row" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }} aria-label={`${i.key} ${i.title}`}>
      <td>
        <div className="issue-title"><span className="task-key">{i.key}</span> <b>{i.title}</b></div>
        {i.fileCount > 0 && <span className="meta-line" title={`${i.fileCount} supporting file${i.fileCount === 1 ? '' : 's'}`}><Icon name="paperclip" size={12} /> {i.fileCount}</span>}
      </td>
      <td className="cell-muted">{i.stageName ?? '—'}</td>
      <td><IssueStatusBadge status={i.status} /></td>
      <td><PriorityBadge priority={i.severity} /></td>
      <td className="cell-muted">{i.reporter ? <span className="row" style={{ gap: 6 }}><Avatar name={i.reporter.name} size="sm" userId={i.reporter.id} />{i.reporter.name}</span> : '—'}</td>
      <td className="cell-muted">{i.assignee ? <span className="row" style={{ gap: 6 }}><Avatar name={i.assignee.name} size="sm" userId={i.assignee.id} />{i.assignee.name}</span> : <em>Unassigned</em>}</td>
      <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>{timeAgo(i.createdAt)}</td>
    </tr>
  );
}
