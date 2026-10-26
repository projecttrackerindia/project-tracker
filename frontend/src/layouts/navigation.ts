import type { IconName } from '../components/Icon';
import { useAuth, useCan, useIsPersonal } from '../stores/auth';
import { useAi } from '../features/ai/Assistant';
import { AI_NAME } from '../features/ai/aiBrand';

/** `match`: the item is active for these addresses instead of just its own (for places that hold several pages). */
export interface NavDef {
  to: string; label: string; icon: IconName; end?: boolean; show?: boolean; badge?: number; match?: (path: string) => boolean;
  /** Stable key; the address when not given. */
  id?: string;
  /** Only in the command palette (a page inside a place), not in the rail or the phone bar. */
  paletteOnly?: boolean;
  /** One line on what it is, for the palette. */
  hint?: string;
}
export const navKey = (i: NavDef) => i.id ?? i.to;
export const inRail = (i: NavDef) => i.show !== false && !i.paletteOnly;
export interface NavGroup { title: string; items: NavDef[] }

const under = (...roots: string[]) => (p: string) => roots.some((r) => (r === '/' ? p === '/' : p === r || p.startsWith(`${r}/`)));

/**
 * The five places of v2 (Home, Work, Talk, Library, Insights), in rail order, plus the pages inside them for the command palette. People and
 * Settings sit behind the avatar. One definition for the rail, the phone bar and the palette, so they always offer the same places.
 * Platform administrators get the administration places instead.
 */
export function useMainNav(): NavGroup[] {
  const ctx = useAuth((s) => s.ctx);
  const personal = useIsPersonal();
  const lv = (m: string) => ctx?.current?.modules?.[m] ?? 0;
  const permReports = useCan('reports.view'), broad = useCan('reports.broad');
  const canReports = permReports && lv('reports') > 0;
  const isGuest = ctx?.current?.role === 'Guest';
  const isAdmin = ctx?.current?.role === 'Owner' || ctx?.current?.role === 'Admin';
  const canChat = !personal && !isGuest && !ctx?.user.isPlatformAdmin;
  const hasReports = (ctx?.current?.reportCount ?? 0) > 0;
  const ai = useAi();
  const canVault = useCan('vault.use') && !isGuest;

  if (ctx?.user.isPlatformAdmin) return [
    { title: 'Platform', items: [
      { to: '/admin', label: 'Overview', icon: 'dashboard', end: true },
      { to: '/admin/tenants', label: 'Organizations', icon: 'building' },
      { to: '/admin/users', label: 'Users', icon: 'users' },
      { to: '/admin/billing', label: 'Billing', icon: 'chart' },
      { to: '/admin/payments', label: 'UPI payments', icon: 'coin' },
      { to: '/admin/usage', label: 'Usage', icon: 'building' },
      { to: '/admin/ai', label: 'AI usage', icon: 'sparkle' },
      { to: '/admin/plans', label: 'Plans', icon: 'card' },
      { to: '/admin/health', label: 'System health', icon: 'activity' },
      { to: '/admin/settings', label: 'Platform settings', icon: 'settings' },
      { to: '/admin/audit', label: 'Audit log', icon: 'shield' },
    ] },
  ];

  const projects = lv('projects') > 0;
  const work = lv('work') > 0 || lv('tasks') > 0 || projects;
  const library = lv('documents') > 0 || canVault;
  const insights = !personal && (hasReports || broad) || canReports || lv('work') > 0 || lv('tasks') > 0;
  const talk = canChat || projects || lv('calendar') > 0;
  return [
    { title: 'Places', items: [
      { id: 'home', to: '/', label: 'Home', icon: 'radar', end: true, hint: 'What needs you today, and your calendar',
        match: (p) => p === '/' || p === '/dashboard' || p.startsWith('/approve/') },
      { id: 'work', to: '/work', label: 'Work', icon: 'checkCircle', show: work, hint: 'Tasks, issues, actions and tickets in one list, and every project',
        match: under('/work') },
      { id: 'talk', to: '/talk', label: 'Talk', icon: 'message', show: talk, hint: 'Chat, mail and meetings in one list',
        match: (p) => under('/talk')(p) || p.startsWith('/calls/') },
      { id: 'library', to: '/library', label: 'Library', icon: 'note', show: library, hint: 'Documents, API docs, files and the vault',
        match: under('/library') },
      { id: 'insights', to: '/insights', label: 'Insights', icon: 'chart', show: insights, hint: 'How it is going: workload, time and reports',
        match: (p) => under('/insights')(p) || p === '/activity' },
    ] },
    // Pages inside the places: found by searching (Ctrl K), never listed twice.
    { title: 'Go to', items: [
      { to: '/work', label: 'My work', icon: 'inbox', show: work, paletteOnly: true },
      { to: '/work?tab=tickets', label: 'Tickets', icon: 'bolt', show: lv('work') > 0, paletteOnly: true, hint: 'Support and operational work, queues and service levels' },
      { to: '/work/projects', label: 'Projects', icon: 'folder', show: projects, paletteOnly: true },
      { to: '/work/projects?view=portfolio', label: 'Portfolio', icon: 'monitor', show: projects, paletteOnly: true },
      { to: '/?tab=calendar', label: 'Calendar', icon: 'calendar', show: lv('calendar') > 0, paletteOnly: true },
      { to: '/talk?f=meetings', label: 'Meetings', icon: 'video', show: talk, paletteOnly: true, hint: 'Schedule, join and reply; the notetaker and past meetings' },
      { to: '/talk?f=mail', label: 'Mail', icon: 'mail', paletteOnly: true, hint: 'Gmail, Outlook and Rediffmail with the mail agent' },
      { to: '/library/docs', label: 'Docs', icon: 'layers', show: lv('documents') > 0, paletteOnly: true },
      { to: '/library/vault', label: 'Vault', icon: 'key', show: canVault, paletteOnly: true, hint: 'Team passwords, keys and secrets' },
      { to: '/insights?tab=time', label: 'Time', icon: 'clock', show: lv('tasks') > 0 || lv('work') > 0, paletteOnly: true, hint: 'Your timesheet' },
      { to: '/insights?tab=reports', label: 'Reports', icon: 'chart', show: canReports || lv('work') > 0, paletteOnly: true },
      { to: '/activity', label: 'Activity', icon: 'activity', show: lv('activity') > 0, paletteOnly: true },
      { to: '/people', label: 'People', icon: 'user', show: !personal, paletteOnly: true },
      { to: '/settings', label: 'Settings', icon: 'settings', paletteOnly: true },
      { to: '/settings/ai', label: `${AI_NAME} control centre`, icon: 'sparkle', show: isAdmin && ai, paletteOnly: true, hint: 'What the AI knows, may do and costs' },
    ] },
  ];
}
