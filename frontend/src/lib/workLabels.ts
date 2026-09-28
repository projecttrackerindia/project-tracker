import type { ProjectType, WorkTaskStatus } from '../api/types';

/** What a project is for. The order is the order they are offered in. */
export const PROJECT_TYPES: { id: ProjectType; label: string; hint: string }[] = [
  { id: 'NewProject', label: 'New Project', hint: 'A completely new application, system, product or major initiative.' },
  { id: 'ChangeRequest', label: 'Change Request (CR)', hint: 'A formally requested change to an existing application or system.' },
  { id: 'Enhancement', label: 'Enhancement', hint: 'An improvement or addition to an existing feature or functionality.' },
  { id: 'Migration', label: 'Migration', hint: 'Data, application, platform or system migration.' },
  { id: 'Integration', label: 'Integration', hint: 'Integration with another application, API, service or third-party system.' },
  { id: 'Upgrade', label: 'Upgrade', hint: 'Framework, application, database, infrastructure or platform upgrade.' },
  { id: 'Maintenance', label: 'Maintenance', hint: 'Planned or technical maintenance that needs project-level planning.' },
  { id: 'Compliance', label: 'Compliance / Regulatory', hint: 'Work required for audit, security, compliance or regulatory requirements.' },
  { id: 'Other', label: 'Other', hint: 'Any project that does not fit the other types.' },
];
export const projectTypeLabel = (t: ProjectType | null | undefined) => PROJECT_TYPES.find((x) => x.id === t)?.label ?? 'Other';

/** Work tasks have their own simple flow (they never go through a project's workflow). */
export const WORK_STATUSES: { id: WorkTaskStatus; label: string; badge: string }[] = [
  { id: 'ToDo', label: 'To Do', badge: 'badge-neutral' },
  { id: 'InProgress', label: 'In Progress', badge: 'badge-info' },
  { id: 'OnHold', label: 'On Hold', badge: 'badge-warning' },
  { id: 'Completed', label: 'Completed', badge: 'badge-success' },
  { id: 'Cancelled', label: 'Cancelled', badge: 'badge-neutral' },
];
export const workStatusLabel = (s: WorkTaskStatus) => WORK_STATUSES.find((x) => x.id === s)?.label ?? s;
export const isWorkOpen = (s: WorkTaskStatus) => s === 'ToDo' || s === 'InProgress' || s === 'OnHold';
