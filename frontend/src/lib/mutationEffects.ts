/** Transport emits success facts; the workspace cache decides how to refresh. No auth/UI dependency here. */
export const MUTATION_COMMITTED = 'pm:mutation-committed';
export interface MutationCommitted { workspaceId: string; families: string[] }
const WORK = ['work', 'work-items', 'my-work', 'tasks', 'task', 'projects', 'project', 'workload', 'dashboard', 'dashboard-report', 'portfolio', 'plan-sheet', 'timeline', 'calendar', 'inbox', 'activity', 'issues', 'action-items', 'sprint-tasks', 'capacity', 'time', 'timesheet', 'timer'];
export function mutationFamilies(method: string, path: string): string[] {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) return [];
  const route = path.split('?')[0];
  if (/\/(search|preview|parse|words|options)$/.test(route)) return [];
  if (/^\/(tasks|projects|work-tasks|work-items|action-items|issues|sprints)(\/|$)/.test(route)) return WORK;
  if (/^\/(time|timer)(\/|$)/.test(route)) return WORK; // time affects costs, capacity and work summaries too
  if (/^\/(reminders)(\/|$)/.test(route)) return ['reminders', 'notifications', 'timeline', 'inbox'];
  if (/^\/(meetings|calls|attendance)(\/|$)/.test(route)) return ['meet', 'meetings', 'calls', 'attendance', 'timeline', 'calendar'];
  if (/^\/ai\/.*\/(confirm|undo)$/.test(route)) return [...WORK, 'reminders'];
  return [];
}
export function mutationCommitted(method: string, path: string, workspaceId: string | null) {
  const families = mutationFamilies(method, path);
  if (workspaceId && families.length && typeof window !== 'undefined') {
    try { window.dispatchEvent(new CustomEvent<MutationCommitted>(MUTATION_COMMITTED, { detail: { workspaceId, families } })); }
    catch { /* A cache listener must never turn a committed save into an apparent failed request. */ }
  }
}
