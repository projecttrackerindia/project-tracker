/** Transport emits success facts; the workspace cache decides how to refresh. No auth/UI dependency here. */
export const MUTATION_COMMITTED = 'pm:mutation-committed';
export interface MutationCommitted { workspaceId: string; families: string[] }
const WORK_ONLY = ['work', 'work-items', 'my-work', 'tasks', 'task', 'projects', 'project', 'workload', 'dashboard', 'dashboard-report', 'portfolio', 'plan-sheet', 'timeline', 'calendar', 'inbox', 'activity', 'issues', 'action-items', 'sprint-tasks', 'capacity'];
/** Time entries, the week grid and the running timer ('time' also keys the meeting time proposals). */
const TIME = ['time', 'timesheet', 'timer'];
const WORK = [...WORK_ONLY, ...TIME];
export function mutationFamilies(method: string, path: string): string[] {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) return [];
  const route = path.split('?')[0];
  if (/\/(search|preview|parse|words|options)$/.test(route)) return [];
  if (/^\/(tasks|projects|work-tasks|work-items|action-items|issues|sprints)(\/|$)/.test(route)) {
    // Editing or creating work does not change logged time, so the time views (and every open timer and proposal list) are left alone.
    // Deleting work removes its time entries, and the work's own time routes (/tasks/{id}/time, the timer) change time directly.
    const touchesTime = method.toUpperCase() === 'DELETE' || /\/(time|timer|time-entries)(\/|$)/.test(route);
    return touchesTime ? WORK : WORK_ONLY;
  }
  if (/^\/load(\/|$)/.test(route)) return WORK_ONLY; // Load: moves and the self-signal
  if (/^\/(time|timer)(\/|$)/.test(route)) return WORK; // time affects costs, capacity and work summaries too
  if (/^\/(reminders)(\/|$)/.test(route)) return ['reminders', 'notifications', 'timeline', 'inbox'];
  if (/^\/(meetings|calls|attendance)(\/|$)/.test(route)) return ['meet', 'meetings', 'calls', 'attendance', 'timeline', 'calendar'];
  if (/^\/ai\/.*\/(confirm|undo)$/.test(route)) return [...WORK, 'reminders'];
  return [];
}
let lastCommitAt = 0;
/**
 * True when this tab saved a work change in the last few seconds. The live feed echoes that same save back to every tab of the person;
 * this tab has already refreshed for it (MutationSync), so it skips the echo instead of reading every open view a second time.
 * Other tabs, other people and AI or server-side changes still refresh.
 */
export function committedHereRecently(now = Date.now(), windowMs = 4000) { return now - lastCommitAt < windowMs; }
export function mutationCommitted(method: string, path: string, workspaceId: string | null) {
  const families = mutationFamilies(method, path);
  if (families.length) lastCommitAt = Date.now();
  if (workspaceId && families.length && typeof window !== 'undefined') {
    try { window.dispatchEvent(new CustomEvent<MutationCommitted>(MUTATION_COMMITTED, { detail: { workspaceId, families } })); }
    catch { /* A cache listener must never turn a committed save into an apparent failed request. */ }
  }
}
