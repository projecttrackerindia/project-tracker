import type { SectionLink } from '../../components/ui';
import { useAuth, useIsPersonal, useModule } from '../../stores/auth';

export type WorkspaceSection = 'general' | 'access' | 'security' | 'sso' | 'billing' | 'audit' | 'data'
  | 'project-groups' | 'timeline-templates' | 'labels' | 'priorities' | 'custom-fields' | 'work-types' | 'automation' | 'reminders' | 'api-keys' | 'webhooks' | 'email' | 'git';

interface SectionDef extends SectionLink { id: WorkspaceSection; group: 'Workspace' | 'Configuration' | 'Integrations' }

/** The Workspace settings sections the signed-in person may open, in menu order. Empty when they administer nothing. */
export function useWorkspaceSections(): SectionDef[] {
  const ctx = useAuth((s) => s.ctx);
  const personal = useIsPersonal();
  const can = useAuth((s) => s.ctx?.current?.permissions ?? []);
  const has = (p: string) => can.includes(p);
  const [mProjects, mTasks, mWork, mBilling, mAudit] = [useModule('projects'), useModule('tasks'), useModule('work'), useModule('billing'), useModule('audit')];
  if (!ctx?.current || ctx.user.isPlatformAdmin) return [];
  const isAdmin = ctx.current.role === 'Owner' || ctx.current.role === 'Admin';
  const all: (SectionDef & { show: boolean })[] = [
    { id: 'general', group: 'Workspace', to: '/settings/general', label: 'General', icon: 'building', show: true },
    { id: 'access', group: 'Workspace', to: '/settings/access', label: 'Roles & access', icon: 'shield', show: !personal && (has('org.manage') || has('access.manage') || has('permissions.manage')) },
    { id: 'security', group: 'Workspace', to: '/settings/security', label: 'Security', icon: 'lock', show: !personal && has('org.manage') },
    { id: 'sso', group: 'Workspace', to: '/settings/sso', label: 'Single sign-on', icon: 'key', show: !personal && isAdmin },
    { id: 'billing', group: 'Workspace', to: '/settings/billing', label: 'Billing', icon: 'card', show: mBilling > 0 },
    { id: 'audit', group: 'Workspace', to: '/settings/audit', label: 'Audit log', icon: 'activity', show: !personal && has('audit.view') && mAudit > 0 },
    { id: 'data', group: 'Workspace', to: '/settings/data', label: 'Data & retention', icon: 'database', show: isAdmin },
    { id: 'project-groups', group: 'Configuration', to: '/settings/project-groups', label: 'Project groups', icon: 'layers', show: has('projectgroups.manage') && mProjects > 0 },
    { id: 'timeline-templates', group: 'Configuration', to: '/settings/timeline-templates', label: 'Timeline templates', icon: 'flag', show: has('workflow.manage') && mProjects > 0 },
    { id: 'labels', group: 'Configuration', to: '/settings/labels', label: 'Labels', icon: 'tag', show: has('labels.manage') && mTasks > 0 },
    { id: 'priorities', group: 'Configuration', to: '/settings/priorities', label: 'Priorities', icon: 'alert', show: has('workflow.manage') },
    { id: 'custom-fields', group: 'Configuration', to: '/settings/custom-fields', label: 'Custom fields', icon: 'list', show: has('workflow.manage') && mTasks > 0 },
    { id: 'work-types', group: 'Configuration', to: '/settings/work-types', label: 'Work types', icon: 'bolt', show: has('work.types.manage') && mWork > 0 },
    { id: 'automation', group: 'Configuration', to: '/settings/automation', label: 'Automation', icon: 'refresh', show: has('workflow.manage') && mProjects > 0 },
    { id: 'reminders', group: 'Configuration', to: '/settings/reminders', label: 'Reminders', icon: 'alarm', show: !personal && isAdmin },
    { id: 'api-keys', group: 'Integrations', to: '/settings/api-keys', label: 'API keys', icon: 'lock', show: isAdmin },
    { id: 'webhooks', group: 'Integrations', to: '/settings/webhooks', label: 'Webhooks, Slack & Teams', icon: 'send', show: isAdmin },
    { id: 'email', group: 'Integrations', to: '/settings/email', label: 'Email to work', icon: 'mail', show: isAdmin && mWork > 0 },
    { id: 'git', group: 'Integrations', to: '/settings/git', label: 'GitHub & Azure DevOps', icon: 'git', show: isAdmin },
  ];
  const visible = all.filter((s) => s.show);
  // General on its own is just the workspace's name: not worth a settings area for someone who administers nothing.
  return visible.length === 1 && !has('org.manage') ? [] : visible;
}

