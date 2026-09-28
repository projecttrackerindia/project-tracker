import type { IssueStatus } from '../../api/types';

export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = {
  Observed: 'Observed / Failed', InProgress: 'In progress', Fixed: 'Fixed · retest', Resolved: 'Resolved',
};

const CLASS: Record<IssueStatus, string> = { Observed: 'badge-danger', InProgress: 'badge-info', Fixed: 'badge-warning', Resolved: 'badge-success' };

export function IssueStatusBadge({ status }: { status: IssueStatus }) {
  return <span className={`badge ${CLASS[status]}`}><span className="dot" />{ISSUE_STATUS_LABEL[status]}</span>;
}

/** What each move is called on its button, depending on where the issue is now. */
export function moveLabel(from: IssueStatus, to: IssueStatus): string {
  if (to === 'InProgress') return 'Start fixing';
  if (to === 'Fixed') return 'Mark as fixed';
  if (to === 'Resolved') return from === 'Fixed' ? 'Confirm fix · resolve' : 'Resolve';
  return from === 'InProgress' ? 'Not started · back to failed' : 'Still fails · reopen';
}

/** Whether moving to this status needs a note saying why (a fix that failed the retest). */
export const needsNote = (from: IssueStatus, to: IssueStatus) => to === 'Observed' && (from === 'Fixed' || from === 'Resolved');

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'] as const;

/** Stages where testing findings are expected; they show the issues row on the timeline even before the first issue is reported. */
export const isTestingStage = (name: string) => /test|qa|uat|quality|accept|review|verif|validat/i.test(name);
