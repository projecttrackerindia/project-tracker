import type { SectionLink } from '../../components/ui';
import { useAuth, useIsPersonal, useModule } from '../../stores/auth';

export type WorkspaceSection = 'general' | 'members' | 'access' | 'visibility' | 'security' | 'sso' | 'billing' | 'audit' | 'data'
  | 'project-groups' | 'timeline-templates' | 'labels' | 'priorities' | 'custom-fields' | 'work-types' | 'automation'
  | 'notifications' | 'reminders' | 'ai' | 'api-keys' | 'connected-apps' | 'webhooks' | 'slack' | 'whatsapp' | 'email' | 'git';

/**
 * The ten sections of Settings (v2): two about you, eight about the workspace. Each workspace section holds one or more of the pages above
 * (its "subs", shown as tabs); the first one is what the section opens on. Old addresses (/settings/sso, /account/security …) land on the
 * section and tab that now hold them.
 */
export type SettingsPlace = 'profile' | 'notifications' | 'general' | 'people' | 'fields' | 'timelines' | 'security' | 'integrations' | 'ai' | 'billing';
export const PLACE_LEAVES: Record<Exclude<SettingsPlace, 'profile'>, WorkspaceSection[]> = {
  notifications: ['notifications', 'reminders'],
  general: ['general'],
  people: ['members', 'visibility'],
  fields: ['custom-fields', 'labels', 'priorities', 'work-types'],
  timelines: ['timeline-templates', 'project-groups', 'automation'],
  security: ['security', 'sso', 'access', 'audit', 'data'],
  integrations: ['slack', 'whatsapp', 'git', 'webhooks', 'api-keys', 'email', 'connected-apps'],
  ai: ['ai'],
  billing: ['billing'],
};
export const PLACE_OF = Object.fromEntries(Object.entries(PLACE_LEAVES).flatMap(([place, leaves]) => leaves.map((l) => [l, place]))) as Record<WorkspaceSection, SettingsPlace>;
/** Where a workspace page lives now: its section, and its tab unless it is the one the section opens on. */
export function leafHref(leaf: WorkspaceSection): string {
  const place = PLACE_OF[leaf];
  const first = place === 'notifications' ? null : PLACE_LEAVES[place as Exclude<SettingsPlace, 'profile'>][0];
  return first === leaf ? `/settings/${place}` : `/settings/${place}?sub=${leaf}`;
}

/** What kind of setting a page is, shown beside it in search results (the command palette). */
export type SettingsGroup = 'Workspace' | 'People and access' | 'Security' | 'Notifications' | 'Integrations' | 'AI' | 'Billing';

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
    { id: 'general', group: 'Workspace', to: leafHref('general'), label: 'General', icon: 'building', blurb: 'Name, description, logo and time zone.', show: true },
    { id: 'project-groups', group: 'Workspace', to: leafHref('project-groups'), label: 'Project groups', icon: 'layers', blurb: 'Folders that hold related projects.', show: has('projectgroups.manage') && mProjects > 0 },
    { id: 'timeline-templates', group: 'Workspace', to: leafHref('timeline-templates'), label: 'Timeline templates', icon: 'flag', blurb: 'Stages and dates a new project can start from.', show: has('workflow.manage') && mProjects > 0 },
    { id: 'labels', group: 'Workspace', to: leafHref('labels'), label: 'Labels', icon: 'tag', blurb: 'Tags for tasks.', show: has('labels.manage') && mTasks > 0 },
    { id: 'priorities', group: 'Workspace', to: leafHref('priorities'), label: 'Priorities', icon: 'alert', blurb: 'Names and colours of the four levels.', show: has('workflow.manage') },
    { id: 'custom-fields', group: 'Workspace', to: leafHref('custom-fields'), label: 'Custom fields', icon: 'list', blurb: 'Extra fields on every task.', show: has('workflow.manage') && mTasks > 0 },
    { id: 'work-types', group: 'Workspace', to: leafHref('work-types'), label: 'Work types', icon: 'bolt', blurb: 'Kinds of operational work and their service levels.', show: has('work.types.manage') && mWork > 0 },
    { id: 'automation', group: 'Workspace', to: leafHref('automation'), label: 'Automation', icon: 'refresh', blurb: 'When something happens, do something.', show: has('workflow.manage') && mProjects > 0 },

    { id: 'members', group: 'People and access', to: leafHref('members'), label: 'Members', icon: 'users', blurb: 'Invite people, change access levels, remove members.', show: !personal && mMembers > 0 && (has('members.invite') || has('members.manage')) },
    { id: 'access', group: 'People and access', to: leafHref('access'), label: 'Roles & access', icon: 'shield', blurb: 'What each job role and access level can do.', show: !personal && (has('org.manage') || has('access.manage') || has('permissions.manage')) },
    { id: 'visibility', group: 'People and access', to: leafHref('visibility'), label: 'Project visibility', icon: 'eye', blurb: 'Everyone sees every project, or teams see their own.', show: !personal && isAdmin },

    { id: 'security', group: 'Security', to: leafHref('security'), label: 'Sign-in rules', icon: 'lock', blurb: 'Two-step sign-in, allowed networks, passwords, session length.', show: !personal && has('org.manage') },
    { id: 'sso', group: 'Security', to: leafHref('sso'), label: 'Single sign-on', icon: 'key', blurb: 'Sign in with your company identity provider; provisioning.', show: !personal && isAdmin },
    { id: 'data', group: 'Security', to: leafHref('data'), label: 'Data & retention', icon: 'database', blurb: 'How long history is kept; a full export.', show: isAdmin },
    { id: 'audit', group: 'Security', to: leafHref('audit'), label: 'Audit log', icon: 'activity', blurb: 'Every security-relevant change, tamper-evident.', show: !personal && has('audit.view') && mAudit > 0 },

    { id: 'notifications', group: 'Notifications', to: leafHref('notifications'), label: 'Defaults for members', icon: 'bell', blurb: 'Channels, quiet hours and digest until people choose their own.', show: !personal && isAdmin },
    { id: 'reminders', group: 'Notifications', to: leafHref('reminders'), label: 'Escalation', icon: 'alarm', blurb: 'What happens when work stays overdue.', show: !personal && isAdmin },

    { id: 'slack', group: 'Integrations', to: leafHref('slack'), label: 'Slack', icon: 'message', blurb: 'Connect a Slack workspace; post to channels.', show: !personal && isAdmin },
    { id: 'whatsapp', group: 'Integrations', to: leafHref('whatsapp'), label: 'WhatsApp Business', icon: 'phone', blurb: 'Your business number for support and notifications.', show: !personal && isAdmin },
    { id: 'email', group: 'Integrations', to: leafHref('email'), label: 'Email to work', icon: 'mail', blurb: 'Emails to your team become operational work.', show: isAdmin && mWork > 0 },
    { id: 'git', group: 'Integrations', to: leafHref('git'), label: 'GitHub & Azure DevOps', icon: 'git', blurb: 'Commits and pull requests move tasks.', show: isAdmin },
    { id: 'webhooks', group: 'Integrations', to: leafHref('webhooks'), label: 'Webhooks', icon: 'send', blurb: 'Tell other systems (and Teams channels) when something changes; receive alerts as work.', show: isAdmin },
    { id: 'api-keys', group: 'Integrations', to: leafHref('api-keys'), label: 'API keys', icon: 'key', blurb: 'Access for scripts and other tools.', show: isAdmin },

    { id: 'ai', group: 'AI', to: leafHref('ai'), label: 'AI control centre', icon: 'sparkle', blurb: 'What the AI knows, what each agent may do, the model, credits and outside AI apps.', show: isAdmin },
    { id: 'connected-apps', group: 'AI', to: leafHref('connected-apps'), label: 'Connected AI apps', icon: 'bolt', blurb: 'Claude, ChatGPT and other assistants working here.', show: true },

    { id: 'billing', group: 'Billing', to: leafHref('billing'), label: 'Plan & billing', icon: 'card', blurb: 'Plan, seats, invoices, payment.', show: mBilling > 0 },
  ];
  const visible = all.filter((s) => s.show);
  // General and connected apps alone are not worth a settings area for someone who administers nothing.
  return visible.every((s) => s.id === 'general' || s.id === 'connected-apps') && !has('org.manage') ? [] : visible;
}
