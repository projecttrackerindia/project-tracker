// The small pieces of the v2 Work list and side panel: how each kind, priority, owner and due date is drawn, the shared list query,
// and where an item lives.
import { useInfiniteQuery } from '@tanstack/react-query';
import type { Priority } from '../../api/types';
import { workItemsApi, type WorkKind, type WorkListFilters, type WorkPage, type WorkRow } from '../../api/workItemsApi';
import { Avatar } from '../../components/ui';
import { daysUntil, formatDateShort } from '../../lib/format';
import { queryClient, useAuth, useWorkspaceId } from '../../stores/auth';
import { usePriorities } from '../priorities/usePriorities';

export const KINDS: WorkKind[] = ['task', 'issue', 'action', 'ticket'];
export const KIND_LABEL: Record<WorkKind, string> = { task: 'Task', issue: 'Issue', action: 'Action', ticket: 'Ticket' };
export const KIND_LONG: Record<WorkKind, string> = { task: 'Task', issue: 'Issue', action: 'Action item', ticket: 'Ticket' };
export const PRIORITY_ORDER: Record<Priority, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };

/** The kinds this person may open, by the same module rules as the server (tasks; issues need projects too; actions projects; tickets work). */
export function useWorkKinds(): WorkKind[] {
  const modules = useAuth((s) => s.ctx?.current?.modules);
  const lv = (m: string) => modules?.[m] ?? 0;
  return KINDS.filter((k) => (k === 'task' ? lv('tasks') > 0 : k === 'issue' ? lv('tasks') > 0 && lv('projects') > 0 : k === 'action' ? lv('projects') > 0 : lv('work') > 0));
}

/** The kind as a small coloured chip: Task blue, Issue amber, Action green, Ticket red. */
export function KindChip({ kind }: { kind: WorkKind }) {
  return <span className={`wk-kind k-${kind}`}>{KIND_LABEL[kind]}</span>;
}

/** The priority as a dot (Critical red, High orange, Medium grey, Low a ring), named for screen readers. */
export function PriorityDot({ priority }: { priority: Priority }) {
  const { info } = usePriorities();
  const name = info(priority).name;
  return <span className={`wk-dot p-${priority}`} role="img" aria-label={`${name} priority`} title={`${name} priority`} />;
}

export function Owner({ person, size = 'sm' }: { person: { id: string; name: string } | null; size?: 'sm' }) {
  if (!person) return <span className="wk-owner none" title="Nobody owns this yet" aria-label="No owner">?</span>;
  return <span className="wk-owner" aria-label={`Owner ${person.name}`}><Avatar name={person.name} userId={person.id} size={size} /></span>;
}

/** "Today", "Tomorrow", "2 Nov"; red when overdue ("3d late"); grey "No date". */
export function dueText(due: string | null, late: boolean): string {
  if (!due) return 'No date';
  const d = daysUntil(due) ?? 0;
  if (late && d < 0) return d === -1 ? 'Yesterday' : `${Math.abs(d)}d late`;
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  return formatDateShort(due).replace(/^0/, '');
}
export function Due({ due, late }: { due: string | null; late: boolean }) {
  const today = due ? daysUntil(due) === 0 : false;
  return <span className={`wk-due ${late ? 'late' : ''} ${today ? 'today' : ''} ${due ? '' : 'none'}`} title={due ? `Due ${formatDateShort(due)}${late ? ' · overdue' : ''}` : 'No due date'}>{dueText(due, late)}</span>;
}

// ------------------------------------------------------------------ the list query

const WINDOW = 500, PAGE = 200;

/** The Work list from /work-items, 200 at a time up to the server's window of 500, as one array. */
export function useWorkList(f: WorkListFilters, enabled = true) {
  const wid = useWorkspaceId();
  const q = useInfiniteQuery({
    queryKey: [wid, 'work-items', 'list', f],
    enabled: !!wid && enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => workItemsApi.list({ ...f, offset: pageParam, limit: Math.min(PAGE, WINDOW - pageParam) }),
    getNextPageParam: (last: WorkPage) => (last.hasMore && last.offset + last.limit < WINDOW ? last.offset + last.limit : undefined),
    placeholderData: (p) => p,
  });
  const items: WorkRow[] = q.data?.pages.flatMap((p) => p?.items ?? []) ?? [];
  const more = !!q.data?.pages.at(-1)?.hasMore;
  return { ...q, items, more };
}

/** After any change to work: every list and item of the new API, and the older views that show the same work. */
export function refreshWork(wid: string | null | undefined) {
  if (!wid) return;
  for (const k of ['work-items', 'work', 'my-work', 'workload', 'inbox', 'dashboard']) void queryClient.invalidateQueries({ queryKey: [wid, k] });
  void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === wid && q.queryKey[1] === 'project' && q.queryKey[3] === 'tasks' });
}

/** The pages showing a Work side panel right now ("work", "project:<id>"), so + New can open what it made in place. */
export const panelHosts = new Set<string>();

/** Where an item opens: always the Work side panel. */
export const itemHref = (id: string) => `/work?item=${id}`;
