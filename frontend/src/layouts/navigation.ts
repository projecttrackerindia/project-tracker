import type { IconName } from '../components/Icon';
import { useAuth, useCan, useIsPersonal } from '../stores/auth';
import { useVisibleKinds } from '../features/workitems/workItems';
import { usePeopleSections } from '../features/people/sections';
import { useAi } from '../features/ai/Assistant';
import { AI_NAME } from '../features/ai/aiBrand';

/** `match`: the item is active for these addresses instead of just its own (for items that lead into a section with tabs). */
export interface NavDef {
  to: string; label: string; icon: IconName; end?: boolean; show?: boolean; badge?: number; match?: (path: string) => boolean;
  /** Stable key for the person's own layout (order, pinned, hidden); the address when not given. */
  id?: string;
  /** Only in the command palette (a place inside a hub), not in the sidebar, the phone menu or its tab bar. */
  paletteOnly?: boolean;
  /** One line on what it is, for the palette and the sidebar's tooltip in edit mode. */
  hint?: string;
}
export const navKey = (i: NavDef) => i.id ?? i.to;
/** The places shown in the sidebar and the phone menu (hub sub-pages are reached from inside their hub). */
export const inSidebar = (i: NavDef) => i.show !== false && !i.paletteOnly;
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
      { to: '/admin/payments', label: 'UPI payments', icon: 'coin' },
      { to: '/admin/usage', label: 'Usage', icon: 'building' },
      { to: '/admin/ai', label: 'AI usage', icon: 'sparkle' },
      { to: '/admin/plans', label: 'Plans', icon: 'card' },
      { to: '/admin/health', label: 'System health', icon: 'activity' },
      { to: '/admin/settings', label: 'Platform settings', icon: 'settings' },
      { to: '/admin/audit', label: 'Audit log', icon: 'shield' },
    ] },
  ];

  // Home: my own day. Work: the work itself. Insights: how it is going. Organization: the people. Places that belong together are one hub
  // with tabs (the Command Center holds my work; Agents holds the assistant, proposals, workflows and the tracker) - the old addresses still work.
  const isGuest = ctx?.current?.role === 'Guest';
  const isAdmin = ctx?.current?.role === 'Owner' || ctx?.current?.role === 'Admin';
  const command = lv('projects') > 0 && !isGuest;
  const proposals = lv('projects') > 0 && !personal && ai && !isGuest;
  const agentsTo = ai ? '/ai' : proposals ? '/project-agent' : '/agent-tracker';
  const agentsPath = (p: string) => p === '/ai' || p.startsWith('/ai/') || p === '/project-agent' || p.startsWith('/project-agent/') || p === '/agent-tracker';
  return [
    { title: 'Home', items: [
      { to: '/', label: 'Dashboard', icon: 'dashboard', end: true, hint: 'Your day at a glance' },
      { to: '/command-center', label: 'Command Center', icon: 'radar', show: command, hint: 'What needs you today, your work, meetings and decisions',
        match: (p) => p === '/command-center' },
      { id: 'agents', to: agentsTo, label: 'Agents', icon: 'agent', show: ai || proposals || isAdmin, match: agentsPath, hint: 'The assistant, proposals, workflows and the agent tracker' },
      { to: '/calendar', label: 'Calendar', icon: 'calendar', show: lv('calendar') > 0 },
      { to: '/chat', label: 'Chat', icon: 'message', show: canChat },
      { to: '/mailbox', label: 'Mailbox', icon: 'mail', hint: 'Gmail, Outlook and Rediffmail in one inbox, with the mail agent' },
      { to: '/reminders', label: 'Reminders', icon: 'alarm' },
    ] },
    { title: 'Work', items: [
      { to: '/projects', label: 'Projects', icon: 'folder', show: lv('projects') > 0 },
      { to: '/portfolio', label: 'Portfolio', icon: 'monitor', show: lv('projects') > 0 },
      { to: '/operations', label: 'Operations', icon: 'bolt', show: lv('work') > 0, hint: 'Support and operational work, queues and service levels' },
      { to: '/timesheet', label: 'Timesheet', icon: 'clock', show: lv('tasks') > 0 || lv('work') > 0 },
      { to: '/documents', label: 'Documents', icon: 'note', show: lv('documents') > 0, match: (p) => p === '/documents' || p.startsWith('/documents/') },
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
    // Inside the hubs: found by searching (Ctrl K), not listed twice in the sidebar.
    { title: 'Go to', items: [
      { to: command ? '/command-center?tab=work' : '/my-work', id: 'my-work', label: 'My work', icon: 'inbox', show: kinds.length > 0, paletteOnly: true },
      { to: '/ai', label: AI_NAME, icon: 'agent', show: ai, paletteOnly: true },
      { to: '/project-agent', label: 'Agent proposals', icon: 'sparkle', show: proposals, paletteOnly: true },
      { to: '/ai/operations', label: 'Agent workflows', icon: 'workflow', show: ai, paletteOnly: true },
      { to: '/agent-tracker', label: 'Agent Tracker', icon: 'workflow', show: isAdmin, paletteOnly: true },
    ] },
  ];
}
