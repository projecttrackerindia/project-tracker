import type { Workspace } from '../api/types';
import { useAuth } from '../stores/auth';

/**
 * Every signed-in page lives under its organization: /acme-bank/projects/…, /acme-bank/ai. The first part of the address says which
 * organization a link belongs to, so a link opened by someone who last used another organization still lands in the right one.
 *
 * Names the app uses at the top level. An organization is never given one of these as its address (the server keeps them back), so
 * "/projects" is always an older link without an organization, never an organization called "projects".
 * Keep in step with WorkspaceSlugs.Reserved on the server.
 */
export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set([
  'login', 'register', 'verify-email', 'forgot-password', 'reset-password', 'invite', 'auth', 'security', 'r', 'dev', 'logout', 'sso',
  'my-work', 'ai', 'reminders', 'timesheet', 'calendar', 'chat', 'projects', 'portfolio', 'operations', 'workload', 'reports', 'activity', 'people',
  'settings', 'account', 'notifications', 'admin', 'work', 'my-team', 'project-status', 'project-groups', 'members', 'teams', 'organization', 'billing', 'audit',
  'dashboard', 'home', 'tasks', 'issues', 'api', 'hubs', 'scim', 'health', 'assets', 'icons', 'static',
]);

export const firstSegment = (pathname: string) => pathname.split('/')[1]?.toLowerCase() ?? '';

/** The organization (one the person belongs to) that an address points into, if any. */
export function orgFromPath(pathname: string, workspaces: readonly Workspace[]): Workspace | undefined {
  const first = firstSegment(pathname);
  if (!first || RESERVED_SEGMENTS.has(first)) return undefined;
  return workspaces.find((w) => w.slug.toLowerCase() === first);
}

/** "/projects/1" in an organization → "/acme/projects/1". */
export const inOrg = (slug: string, path: string) => `/${slug}${path.startsWith('/') ? path : `/${path}`}`;

/** For code outside the router (an operating-system notification, a hard navigation): the full address of a page of the active organization. */
export function orgHref(path: string): string {
  const slug = useAuth.getState().ctx?.current?.slug;
  return !slug || !path.startsWith('/') || path.startsWith('/r/') ? path : inOrg(slug, path);
}

/** The path of the page being shown, without the organization part (for code that looks at window.location directly). */
export function appPath(slug: string | undefined | null): string {
  const p = window.location.pathname;
  return slug && firstSegment(p) === slug.toLowerCase() ? p.slice(slug.length + 1) || '/' : p;
}
