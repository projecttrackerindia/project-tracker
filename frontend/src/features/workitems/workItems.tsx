import type { ReactNode } from 'react';
import type { PersonWorkItem, Priority, StatusCategory, WorkItem, WorkItemKind } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { Avatar, PriorityBadge, TaskStatusBadge } from '../../components/ui';
import { formatDateShort } from '../../lib/format';
import { useAuth } from '../../stores/auth';

/** How each kind of work is named and drawn everywhere work of several kinds is listed together. */
export const KIND_META: Record<WorkItemKind, { label: string; plural: string; icon: IconName; hint: string }> = {
  Task: { label: 'Project task', plural: 'Project tasks', icon: 'check', hint: 'Tasks on a project’s board, in its workflow.' },
  Issue: { label: 'Issue', plural: 'Issues', icon: 'bug', hint: 'Problems found while testing a project stage.' },
  ActionItem: { label: 'Action item', plural: 'Action items', icon: 'flag', hint: 'Follow-ups agreed for a project.' },
  Operational: { label: 'Operational work', plural: 'Operational work', icon: 'bolt', hint: 'Bug fixes, support, analysis and other work outside projects.' },
};
export const ALL_KINDS: WorkItemKind[] = ['Task', 'Issue', 'ActionItem', 'Operational'];

/** The kinds the signed-in person can open, following the same module rules as the server. */
export function useVisibleKinds(): WorkItemKind[] {
  const modules = useAuth((s) => s.ctx?.current?.modules);
  const lv = (m: string) => modules?.[m] ?? 0;
  return ALL_KINDS.filter((k) => (k === 'Task' ? lv('tasks') > 0 : k === 'Issue' ? lv('tasks') > 0 && lv('projects') > 0 : k === 'ActionItem' ? lv('projects') > 0 : lv('work') > 0));
}

/** Where an item lives: its project's board, Issues or Actions tab, or the Operations list. */
export function workItemLink(i: { kind: WorkItemKind; id: string; projectId: string | null }): string {
  switch (i.kind) {
    case 'Task': return `/projects/${i.projectId}?task=${i.id}`;
    case 'Issue': return `/projects/${i.projectId}?tab=issues&issue=${i.id}`;
    case 'ActionItem': return `/projects/${i.projectId}?tab=actions&action=${i.id}`;
    default: return `/operations?task=${i.id}`;
  }
}

export function KindIcon({ kind }: { kind: WorkItemKind }) {
  return <span className={`wi-kind ${kind}`} title={KIND_META[kind].label} aria-label={KIND_META[kind].label}><Icon name={KIND_META[kind].icon} /></span>;
}

interface RowItem {
  kind: WorkItemKind; id: string; key: string; title: string; projectId: string | null; projectName: string | null;
  status: string; category: StatusCategory; priority: Priority; dueDate: string | null; isOverdue: boolean; typeName?: string | null;
}
export const fromWorkItem = (w: WorkItem): RowItem => w;
export const fromPersonItem = (p: PersonWorkItem): RowItem => ({ ...p, status: p.statusName });

/** One item of any kind: what it is, where it belongs, its status, priority and due date. */
export function WorkItemRow({ item, onOpen, assignee, extra }: { item: RowItem; onOpen: (i: RowItem) => void; assignee?: string | null; extra?: ReactNode }) {
  // Operational work: its work type, and the project it refers to if any. Everything else: what it is, and its project.
  const sub = item.kind === 'Operational'
    ? [item.typeName || KIND_META.Operational.label, item.projectName].filter(Boolean).join(' · ')
    : [KIND_META[item.kind].label, item.projectName].filter(Boolean).join(' · ');
  return (
    <button type="button" className="wi-row" onClick={() => onOpen(item)} aria-label={`Open ${KIND_META[item.kind].label} ${item.key} ${item.title}`}>
      <KindIcon kind={item.kind} />
      <span className="wi-main">
        <span className="wi-title" title={item.title}><span className="task-key">{item.key}</span>{item.title}</span>
        <span className="wi-sub">{sub}</span>
      </span>
      <span className="wi-meta">
        {extra}
        {assignee !== undefined && (assignee ? <span className="row" style={{ gap: 6 }}><Avatar name={assignee} size="sm" />{assignee}</span> : <span className="muted">Unassigned</span>)}
        <PriorityBadge priority={item.priority} />
        <TaskStatusBadge name={item.status} category={item.category} />
        <span className={`wi-due ${item.isOverdue ? 'late' : ''}`}>{item.dueDate ? `${item.isOverdue ? 'Overdue · ' : 'Due '}${formatDateShort(item.dueDate)}` : 'No due date'}</span>
      </span>
    </button>
  );
}

export type { RowItem as WorkRowItem };
