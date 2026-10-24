import type { SectionLink } from '../../components/ui';
import { useAuth, useIsPersonal, useModule } from '../../stores/auth';

export type WorkspaceSection = 'general' | 'members' | 'access' | 'visibility' | 'security' | 'sso' | 'billing' | 'audit' | 'data'
  | 'project-groups' | 'timeline-templates' | 'labels' | 'priorities' | 'custom-fields' | 'work-types' | 'automation'
  | 'notifications' | 'reminders' | 'ai' | 'api-keys' | 'connected-apps' | 'webhooks' | 'slack' | 'whatsapp' | 'email' | 'git';

/** The seven groups of Workspace settings, in menu order. */
export const SETTINGS_GROUPS = ['Workspace', 'People and access', 'Security', 'Notifications', 'Integrations', 'AI', 'Billing'] as const;
export type SettingsGroup = typeof SETTINGS_GROUPS[number];

export const GROUP_INFO: Record<SettingsGroup, { icon: SectionLink['icon']; blurb: string }> = {
  Workspace: { icon: 'building', blurb: 'Name, logo, time zone, and the lists every project uses: groups, labels, priorities, fields, work types, automation.' },
  'People and access': { icon: 'users', blurb: 'Who is in the workspace, what each person can do, and who sees which projects.' },
  Security: { icon: 'lock', blurb: 'Sign-in rules, single sign-on, how long data is kept, and the audit log.' },
  Notifications: { icon: 'bell', blurb: 'What members get until they choose for themselves, and escalation of overdue work.' },
  Integrations: { icon: 'link', blurb: 'Slack, WhatsApp, email, GitHub, webhooks and API keys.' },
  AI: { icon: 'sparkle', blurb: 'The assistant, what it knows about you, its credits, and the AI apps connected to this workspace.' },
  Billing: { icon: 'card', blurb: 'Plan, seats, invoices and payment.' },
};

export interface SectionDef extends SectionLink { id: WorkspaceSection; group: SettingsGroup; blurb: string }

/** The Workspace settings sections the signed-in person may open, in menu order. Empty when they administer nothing. */
export function useWorkspaceSections(): SectionDef[] {
  const ctx = useAuth((s) => s.ctx);
  const personal = useIsPersonal();
  const can = useAuth((s) => s.ctx?.current?.permissions ?? []);
  const has = (p: string) => can.includes(p);
  const [mProjects, mTasks, mWork, mBilling, mAudit, mMembers] = [useModule('projects'), useModule('tasks'), useModule('work'), useModule('billing'), useModule('audit'), useModule('members')];
  if (!ctx?.current || ctx.user.isPlatformAdmin) return [];
  const isAdmin = ctx.current.role === 'Owner' || ctx.current.role === 'Admin';
  const all: (SectionDef & { show: boolean })[] = [
    { id: 'general', group: 'Workspace', to: '/settings/general', label: 'General', icon: 'building', blurb: 'Name, description, logo and time zone.', show: true },
    { id: 'project-groups', group: 'Workspace', to: '/settings/project-groups', label: 'Project groups', icon: 'layers', blurb: 'Folders that hold related projects.', show: has('projectgroups.manage') && mProjects > 0 },
    { id: 'timeline-templates', group: 'Workspace', to: '/settings/timeline-templates', label: 'Timeline templates', icon: 'flag', blurb: 'Stages and dates a new project can start from.', show: has('workflow.manage') && mProjects > 0 },
    { id: 'labels', group: 'Workspace', to: '/settings/labels', label: 'Labels', icon: 'tag', blurb: 'Tags for tasks.', show: has('labels.manage') && mTasks > 0 },
    { id: 'priorities', group: 'Workspace', to: '/settings/priorities', label: 'Priorities', icon: 'alert', blurb: 'Names and colours of the four levels.', show: has('workflow.manage') },
    { id: 'custom-fields', group: 'Workspace', to: '/settings/custom-fields', label: 'Custom fields', icon: 'list', blurb: 'Extra fields on every task.', show: has('workflow.manage') && mTasks > 0 },
    { id: 'work-types', group: 'Workspace', to: '/settings/work-types', label: 'Work types', icon: 'bolt', blurb: 'Kinds of operational work and their service levels.', show: has('work.types.manage') && mWork > 0 },
    { id: 'automation', group: 'Workspace', to: '/settings/automation', label: 'Automation', icon: 'refresh', blurb: 'When something happens, do something.', show: has('workflow.manage') && mProjects > 0 },

    { id: 'members', group: 'People and access', to: '/settings/members', label: 'Members', icon: 'users', blurb: 'Invite people, change access levels, remove members.', show: !personal && mMembers > 0 && (has('members.invite') || has('members.manage')) },
    { id: 'access', group: 'People and access', to: '/settings/access', label: 'Roles & access', icon: 'shield', blurb: 'What each job role and access level can do.', show: !personal && (has('org.manage') || has('access.manage') || has('permissions.manage')) },
    { id: 'visibility', group: 'People and access', to: '/settings/visibility', label: 'Project visibility', icon: 'eye', blurb: 'Everyone sees every project, or teams see their own.', show: !personal && isAdmin },

    { id: 'security', group: 'Security', to: '/settings/security', label: 'Sign-in rules', icon: 'lock', blurb: 'Two-step sign-in, allowed networks, passwords, session length.', show: !personal && has('org.manage') },
    { id: 'sso', group: 'Security', to: '/settings/sso', label: 'Single sign-on', icon: 'key', blurb: 'Sign in with your company identity provider; provisioning.', show: !personal && isAdmin },
    { id: 'data', group: 'Security', to: '/settings/data', label: 'Data & retention', icon: 'database', blurb: 'How long history is kept; a full export.', show: isAdmin },
    { id: 'audit', group: 'Security', to: '/settings/audit', label: 'Audit log', icon: 'activity', blurb: 'Every security-relevant change, tamper-evident.', show: !personal && has('audit.view') && mAudit > 0 },

    { id: 'notifications', group: 'Notifications', to: '/settings/notifications', label: 'Defaults for members', icon: 'bell', blurb: 'Channels, quiet hours and digest until people choose their own.', show: !personal && isAdmin },
    { id: 'reminders', group: 'Notifications', to: '/settings/reminders', label: 'Escalation', icon: 'alarm', blurb: 'What happens when work stays overdue.', show: !personal && isAdmin },

    { id: 'slack', group: 'Integrations', to: '/settings/slack', label: 'Slack', icon: 'message', blurb: 'Connect a Slack workspace; post to channels.', show: !personal && isAdmin },
    { id: 'whatsapp', group: 'Integrations', to: '/settings/whatsapp', label: 'WhatsApp Business', icon: 'phone', blurb: 'Your business number for support and notifications.', show: !personal && isAdmin },
    { id: 'email', group: 'Integrations', to: '/settings/email', label: 'Email to work', icon: 'mail', blurb: 'Emails to your team become operational work.', show: isAdmin && mWork > 0 },
    { id: 'git', group: 'Integrations', to: '/settings/git', label: 'GitHub & Azure DevOps', icon: 'git', blurb: 'Commits and pull requests move tasks.', show: isAdmin },
    { id: 'webhooks', group: 'Integrations', to: '/settings/webhooks', label: 'Webhooks', icon: 'send', blurb: 'Tell other systems (and Teams channels) when something changes; receive alerts as work.', show: isAdmin },
    { id: 'api-keys', group: 'Integrations', to: '/settings/api-keys', label: 'API keys', icon: 'key', blurb: 'Access for scripts and other tools.', show: isAdmin },

    { id: 'ai', group: 'AI', to: '/settings/ai', label: 'Assistant', icon: 'sparkle', blurb: 'On or off, what it knows about the organization, credits, your own Claude or ChatGPT key.', show: isAdmin },
    { id: 'connected-apps', group: 'AI', to: '/settings/connected-apps', label: 'Connected AI apps', icon: 'bolt', blurb: 'Claude, ChatGPT and other assistants working here.', show: true },

    { id: 'billing', group: 'Billing', to: '/settings/billing', label: 'Plan & billing', icon: 'card', blurb: 'Plan, seats, invoices, payment.', show: mBilling > 0 },
  ];
  const visible = all.filter((s) => s.show);
  // General and connected apps alone are not worth a settings area for someone who administers nothing.
  return visible.every((s) => s.id === 'general' || s.id === 'connected-apps') && !has('org.manage') ? [] : visible;
}
