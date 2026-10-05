/**
 * The team the person is looking at, kept outside React so the API client can read it on every request. Per workspace and remembered on
 * this device. null = every team they can see. It only ever narrows: the server ignores a team the person may not pick.
 */
let current: { wid: string; teamId: string | null } | null = null;

const KEY = (wid: string) => `pm_team_lens_${wid}`;
export const readStoredLens = (wid: string): string | null => { try { return localStorage.getItem(KEY(wid)); } catch { return null; } };
export const writeStoredLens = (wid: string, id: string | null) => { try { if (id) localStorage.setItem(KEY(wid), id); else localStorage.removeItem(KEY(wid)); } catch { /* storage unavailable */ } };

export function setActiveLens(wid: string, teamId: string | null) { current = { wid, teamId }; }
export function activeLens(): string | null { return current?.teamId ?? null; }

/** Reads of lists and figures, and questions to the assistant, follow the lens. Anything addressed to one thing (a project, a task, a team) does not. */
const FOLLOWS = /^\/(dashboard|my-work|workload|calendar|activity|search|action-items|project-status\/groups|ai\/insights|ai\/portfolio\/brief|(projects|tasks|work-tasks|time)|(reports|resources|work)(\/[a-z-]+)*)$/;
const ASKS = /^\/ai\/(conversations\/[0-9a-fA-F-]{36}\/)?ask$/;
export function lensHeaders(method: string, path: string): Record<string, string> {
  const team = activeLens();
  if (!team) return {};
  const route = path.split('?')[0];
  const follows = (method === 'GET' && FOLLOWS.test(route)) || (method === 'POST' && ASKS.test(route));
  return follows ? { 'X-Team-Lens': team } : {};
}
