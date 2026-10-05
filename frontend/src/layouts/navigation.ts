import type { IconName } from '../components/Icon';
import { useAuth, useCan, useIsPersonal } from '../stores/auth';
import { useVisibleKinds } from '../features/workitems/workItems';
import { usePeopleSections } from '../features/people/sections';
import { useAi } from '../features/ai/Assistant';

/** `match`: the item is active for these addresses instead of just its own (for items that lead into a section with tabs). */
export interface NavDef { to: string; label: string; icon: IconName; end?: boolean; show?: boolean; badge?: number; match?: (path: string) => boolean }
export interface NavGroup { title: string; items: NavDef[] }

/**
 * The main navigation the signed-in person may use, in sidebar order. One definition for the sidebar and the command palette, so the two
 * always offer the same places. Platform administrators get the administration menus instead.
 */
export function useMainNav(): NavGroup[] {
  const ctx = useAuth((s) => s.ctx);
  const personal = useIsPersonal();
  const lv = (m: string) => ctx?.current?.modules?.[m] ?? 0;
  const permReports = useCan('reports.view'), broad = useCan('reports.broad');
  const canReports = permReports && lv('reports') > 0;
  const canChat = !personal && ctx?.current?.role !== 'Guest' && !ctx?.user.isPlatformAdmin;
  const kinds = useVisibleKinds();
  const people = usePeopleSections();
  const hasReports = (ctx?.current?.reportCount ?? 0) > 0;
  const ai = useAi();

  if (ctx?.user.isPlatformAdmin) return [
    { title: 'Platform', items: [
      { to: '/admin', label: 'Overview', icon: 'dashboard', end: true },
      { to: '/admin/tenants', label: 'Organizations', icon: 'building' },
      { to: '/admin/users', label: 'Users', icon: 'users' },
      { to: '/admin/billing', label: 'Billing', icon: 'chart' },
      { to: '/admin/usage', label: 'Usage', icon: 'building' },
      { to: '/admin/ai', label: 'AI usage', icon: 'sparkle' },
      { to: '/admin/plans', label: 'Plans', icon: 'card' },
      { to: '/admin/health', label: 'System health', icon: 'activity' },
      { to: '/admin/settings', label: 'Platform settings', icon: 'settings' },
      { to: '/admin/audit', label: 'Audit log', icon: 'shield' },
    ] },
  ];

  // Home: my own day. Delivery: the work itself. Insights: how it is going. Organization: the people.
  return [
    { title: 'Home', items: [
      { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
      { to: '/ai', label: 'AI assistant', icon: 'sparkle', show: ai, match: (p) => p === '/ai' || p.startsWith('/ai/') },
      { to: '/my-work', label: 'My work', icon: 'inbox', show: kinds.length > 0 },
      { to: '/reminders', label: 'Reminders', icon: 'alarm' },
      { to: '/timesheet', label: 'Timesheet', icon: 'clock', show: lv('tasks') > 0 || lv('work') > 0 },
      { to: '/calendar', label: 'Calendar', icon: 'calendar', show: lv('calendar') > 0 },
      { to: '/chat', label: 'Chat', icon: 'message', show: canChat },
    ] },
    { title: 'Delivery', items: [
      { to: '/projects', label: 'Projects', icon: 'folder', show: lv('projects') > 0 },
      { to: '/portfolio', label: 'Portfolio', icon: 'monitor', show: lv('projects') > 0 },
      { to: '/operations', label: 'Operations', icon: 'bolt', show: lv('work') > 0 },
    ] },
    { title: 'Insights', items: [
      { to: '/workload', label: 'Workload', icon: 'users', show: !personal && (hasReports || broad) },
      { to: '/reports', label: 'Reports', icon: 'chart', end: false, show: canReports || lv('work') > 0 },
      { to: '/activity', label: 'Activity', icon: 'activity', show: lv('activity') > 0 },
    ] },
    { title: 'Organization', items: [
      // One entry: the directory, the org chart and the teams are tabs inside it.
      { to: people[0]?.to ?? '/people', label: 'People', icon: 'user', show: people.length > 0, match: (p) => p === '/people' || p.startsWith('/people/') },
    ] },
  ];
}
