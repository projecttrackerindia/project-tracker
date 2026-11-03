import { projectApi } from '../../api/endpoints';
import type { WorkRow } from '../../api/workItemsApi';
import { workItemsApi } from '../../api/workItemsApi';
import { DOW, daysUntil, formatDateShort } from '../../lib/format';
import { queryClient } from '../../stores/auth';
import { PRIORITY_ORDER } from './workUi';

/* Shared by My work, the calm My work and Today: the order of open work, its day text, and Done / Start. */

const DOTS = ['#5856d6', '#ff9500', '#30b0c7', '#34c759', '#ff2d55', '#af52de'];
const dueOf = (w: WorkRow) => w.dueDate ?? '9999-12-31';
/** One colour per project, the same everywhere on the page. */
export const projectDot = (id: string | null) => {
  if (!id) return null;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return DOTS[h % DOTS.length];
};
/** Smart: overdue first, then critical, then what is due soonest, then priority. */
export const smart = (a: WorkRow, b: WorkRow) => Number(b.isOverdue) - Number(a.isOverdue)
  || Number(b.priority === 'Critical') - Number(a.priority === 'Critical')
  || dueOf(a).localeCompare(dueOf(b)) || PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.key.localeCompare(b.key, undefined, { numeric: true });
/** "Today", "Tomorrow", "Thu" within the week, else "12 Nov". */
export function dayText(due: string | null): string {
  if (!due) return '';
  const d = daysUntil(due) ?? 0;
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d > 1 && d < 7) return DOW[new Date(`${due}T00:00:00`).getDay()];
  return formatDateShort(due).replace(/^0/, '');
}

/** Done or started: a task moves to its project's first column of that category, the others to their own status. */
export async function moveTo(w: WorkRow, to: 'Done' | 'Active') {
  // The version this row was read with: a change someone made since is refused (409) instead of being silently overwritten.
  const version = w.version ?? (await workItemsApi.get(w.id)).version;
  const d = { version };
  if (w.kind === 'task') {
    const p = w.projectId ? await queryClient.fetchQuery({ queryKey: ['mywork-project', w.projectId], queryFn: () => projectApi.get(w.projectId!), staleTime: 60_000 }) : null;
    const s = [...(p?.statuses ?? [])].sort((a, b) => a.order - b.order).find((x) => x.category === to);
    if (!s) throw new Error(to === 'Done' ? 'This project has no done column.' : 'This project has no in-progress column.');
    return workItemsApi.update(w.id, { version: d.version, statusId: s.id });
  }
  const status = to === 'Active' ? 'InProgress' : w.kind === 'issue' ? 'Resolved' : 'Completed';
  return workItemsApi.update(w.id, { version: d.version, status });
}

