import { leafHref, type WorkspaceSection } from './sections';

/**
 * Every setting by name, so typing "MFA", "logo", "Slack" or "retention" jumps straight to the switch (Settings search and Ctrl+K).
 * `id` is the anchor on the page (`data-setting`) and, where the setting is audited, the key of its "last changed" line.
 * Settings outside Workspace settings (My account, the Notification Center, the DocTracker Security Center) carry their own `to`.
 */
export interface SettingEntry {
  id: string;
  label: string;
  /** Workspace settings section the setting lives in; null for one that lives elsewhere (then `to` is required). */
  section: WorkspaceSection | null;
  keywords: string;
  /** One line under the label in results. */
  hint: string;
  /** Text on the page to look for when the row carries no `data-setting` anchor. */
  find?: string;
  to?: string;
  /** Personal (My account and the Notification Center): shown to everyone. */
  personal?: boolean;
}

export const SETTINGS_INDEX: SettingEntry[] = [
  // Workspace
  { id: 'workspace.name', section: 'general', label: 'Workspace name', keywords: 'name rename title company organisation organization', hint: 'What everyone sees in the top bar and in e-mails' },
  { id: 'workspace.description', section: 'general', label: 'Workspace description', keywords: 'about description', hint: 'A line about what this workspace is for' },
  { id: 'workspace.logo', section: 'general', label: 'Logo', keywords: 'logo brand branding image picture icon colours', hint: 'Shown in the top bar, e-mails and the sign-in page' },
  { id: 'workspace.timeZone', section: 'general', label: 'Workspace time zone', keywords: 'time zone timezone tz ist india hours clock utc', hint: 'For digests, SLA clocks and people without their own zone' },
  { id: 'workspace.costCurrency', section: null, to: '/insights?s=capacity', label: 'Currency for costs and budgets', keywords: 'currency inr rupee usd dollar rates cost budget money', hint: 'Insights › Capacity' },
  { id: 'config.projectGroups', section: 'project-groups', label: 'Project groups', keywords: 'folders portfolio programmes programs categories', hint: 'Folders for related projects', find: 'Project groups' },
  { id: 'config.timelines', section: 'timeline-templates', label: 'Timeline templates', keywords: 'stages phases milestones template sdlc', hint: 'Stages a new project can start from', find: 'Timeline templates' },
  { id: 'config.labels', section: 'labels', label: 'Labels', keywords: 'labels tags colours', hint: 'Tags for tasks', find: 'Labels' },
  { id: 'config.priorities', section: 'priorities', label: 'Priorities', keywords: 'priority urgent high low critical colours', hint: 'Names and colours of the four levels', find: 'Priorities' },
  { id: 'config.customFields', section: 'custom-fields', label: 'Custom fields', keywords: 'fields custom attributes columns dropdown', hint: 'Extra fields on every task', find: 'Custom fields' },
  { id: 'config.workTypes', section: 'work-types', label: 'Work types and service levels', keywords: 'work types sla service level response resolution tickets operations helpdesk', hint: 'Kinds of operational work and how fast to answer', find: 'Work types' },
  { id: 'config.automation', section: 'automation', label: 'Automation rules', keywords: 'automation rules triggers workflow when then schedule', hint: 'When something happens, do something', find: 'Automation' },

  // People and access
  { id: 'members.invite', section: 'members', label: 'Invite members', keywords: 'invite add people user users seat onboard join', hint: 'Send invitations or create accounts' },
  { id: 'members.roles', section: 'members', label: "Change a member's access level", keywords: 'role admin owner manager member guest promote demote access level', hint: 'Owner, Admin, Manager, Member or Guest' },
  { id: 'members.remove', section: 'members', label: 'Remove a member', keywords: 'remove delete offboard leave deactivate', hint: 'They lose access to the workspace', find: 'Members' },
  { id: 'members.invitations', section: 'members', label: 'Pending invitations', keywords: 'invitations resend revoke pending', hint: 'Invitations not accepted yet' },
  { id: 'access.jobRoles', section: 'access', label: 'Access by job role', keywords: 'permissions rbac job role access matrix modules', hint: 'What each job role can see and do', find: 'Roles & access' },
  { id: 'access.levels', section: 'access', label: 'Access level permissions', keywords: 'permissions manager member guest defaults', hint: 'The defaults of each access level', find: 'Roles & access' },
  { id: 'access.projectVisibility', section: 'visibility', label: 'Who sees which projects', keywords: 'visibility private projects teams see hide confidential', hint: 'Everyone, or each team its own' },

  // Security
  { id: 'security.requireMfa', section: 'security', label: 'Require two-step sign-in', keywords: 'mfa 2fa two factor two-step 2-step otp authenticator totp passkey require', hint: 'Everyone must use a second step to enter' },
  { id: 'security.ipAllowlist', section: 'security', label: 'Allowed networks (IP allow-list)', keywords: 'ip whitelist allowlist allow-list network vpn office cidr address restrict', hint: 'Only these addresses may open the workspace' },
  { id: 'security.minPasswordLength', section: 'security', label: 'Minimum password length', keywords: 'password length strength characters strong', hint: 'Stricter than the platform' },
  { id: 'security.sessionHours', section: 'security', label: 'Sign in again after', keywords: 'session timeout expire logout idle length hours', hint: 'How long a sign-in lasts' },
  { id: 'security.allowedSignIn', section: 'security', label: 'Allowed ways to sign in', keywords: 'login methods google microsoft github apple passkey sso password social', hint: 'Which sign-in methods open this workspace' },
  { id: 'security.members', section: 'security', label: "Members' account security", keywords: 'weak passwords old passwords who lacks two-step remind members security overview', hint: 'Who has no two-step sign-in; remind them' },
  { id: 'security.revealSeconds', section: null, to: '/library/security', label: 'How long a revealed secret stays visible', keywords: 'reveal secret seconds masking pii timeout', hint: 'Library › Security Center' },
  { id: 'data.masking', section: null, to: '/library/security', label: 'Masking of personal data in documents', keywords: 'masking pii aadhaar pan personal data redact hide', hint: 'Library › Security Center' },
  { id: 'sso.connection', section: 'sso', label: 'Single sign-on (SAML / OpenID)', keywords: 'sso saml oidc openid okta azure ad entra google workspace idp identity provider', hint: 'Sign in with your company identity provider', find: 'Single sign-on' },
  { id: 'sso.domains', section: 'sso', label: 'Verified domains', keywords: 'domain dns verify txt email domain', hint: 'Your company e-mail domains', find: 'domain' },
  { id: 'sso.scim', section: 'sso', label: 'User provisioning (SCIM)', keywords: 'scim provisioning sync users deprovision directory', hint: 'Add and remove people from your directory', find: 'SCIM' },
  { id: 'data.activity', section: 'data', label: 'Keep activity for', keywords: 'retention history delete purge activity gdpr dpdp days', hint: 'How long project and task history is kept' },
  { id: 'data.notifications', section: 'data', label: 'Keep notifications for', keywords: 'retention notifications delete purge days', hint: 'How long the bell keeps its history' },
  { id: 'data.chat', section: 'data', label: 'Keep chat messages for', keywords: 'retention chat messages delete purge days', hint: 'How long chats are kept' },
  { id: 'data.audit', section: 'data', label: 'Keep the audit log for', keywords: 'retention audit log delete purge compliance days', hint: 'At least a year' },
  { id: 'security.dataLocation', section: 'data-location', label: 'Data location', keywords: 'data location residency region india mumbai backups where stored localisation localization sovereignty', hint: 'Where data and backups are kept; keep data in India' },
  { id: 'workspace.holidays', section: 'holidays', label: 'Public holidays', keywords: 'holidays holiday public festival leave capacity diwali calendar india', hint: 'Days off for everyone in Capacity' },
  { id: 'integrations.statusPage', section: 'status-page', label: 'API status page', keywords: 'status page uptime incidents public api health outage', hint: 'A public page showing whether your APIs are up' },
  { id: 'data.export', section: 'data', label: 'Export all data', keywords: 'export backup download zip json data portability', hint: 'Everything the workspace holds, in one zip' },
  { id: 'audit.log', section: 'audit', label: 'Audit log', keywords: 'audit trail log history who changed tamper evidence compliance', hint: 'Every security-relevant change', find: 'Audit log' },

  // Notifications
  { id: 'notifications.defaults', section: 'notifications', label: 'Notification defaults for members', keywords: 'notifications email push desktop phone channels default bell', hint: 'What members get until they choose' },
  { id: 'notifications.quiet', section: 'notifications', label: 'Quiet hours for members', keywords: 'quiet hours dnd do not disturb night silent', hint: 'Nothing automatic arrives between these' },
  { id: 'notifications.digest', section: 'notifications', label: 'Daily digest for members', keywords: 'digest summary batch once a day email updates', hint: 'Updates e-mailed together once a day' },
  { id: 'reminders.escalation', section: 'reminders', label: 'Escalate overdue work', keywords: 'escalation overdue manager owner reminders nudge late', hint: 'Who hears about work that stays overdue', find: 'Escalation' },

  // Integrations
  { id: 'integrations.slack', section: 'slack', label: 'Slack', keywords: 'slack channel chat app install workspace', hint: 'Connect a Slack workspace', find: 'Slack' },
  { id: 'integrations.slackChannel', section: 'webhooks', label: 'Post to a Slack or Teams channel', keywords: 'slack teams microsoft teams channel incoming webhook post message', hint: 'A webhook in Slack or Teams format', find: 'Webhooks' },
  { id: 'integrations.whatsapp', section: 'whatsapp', label: 'WhatsApp Business number', keywords: 'whatsapp meta wa business api number phone support customers', hint: 'Support desk and notifications', find: 'WhatsApp' },
  { id: 'integrations.whatsappTemplates', section: 'whatsapp', label: 'WhatsApp message templates', keywords: 'whatsapp templates approval meta messages 24 hours', hint: 'Approved messages for outside 24 hours', find: 'template' },
  { id: 'integrations.email', section: 'email', label: 'Email to work', keywords: 'inbound email mailbox forward tickets helpdesk support address', hint: 'Emails to your team become work', find: 'Email to work' },
  { id: 'integrations.git', section: 'git', label: 'GitHub App', keywords: 'github git pull request pr commits branch repository azure devops code', hint: 'Pull requests move tasks', find: 'GitHub' },
  { id: 'integrations.gitRules', section: 'git', label: 'Status rules from pull requests', keywords: 'github rules pull request opened approved merged reverted status', hint: 'PR opened → In review, merged → Done', find: 'rules' },
  { id: 'integrations.webhooks', section: 'webhooks', label: 'Outgoing webhooks', keywords: 'webhook callback http https events integration notify url', hint: 'Tell other systems when something changes', find: 'Webhooks' },
  { id: 'integrations.incoming', section: 'webhooks', label: 'Incoming webhooks', keywords: 'incoming webhook alert monitoring grafana prometheus form receive create tickets', hint: 'Alerts and forms become tickets', find: 'Incoming' },
  { id: 'integrations.signing', section: 'webhooks', label: 'Webhook signing secret', keywords: 'hmac signature secret signing verify rotate', hint: 'Prove a request came from here', find: 'secret' },
  { id: 'integrations.apiKeys', section: 'api-keys', label: 'API keys', keywords: 'api key token script rest automation integration access', hint: 'Access for scripts and other tools', find: 'API keys' },

  // AI
  { id: 'ai.enabled', section: 'ai', label: 'AI assistant on or off', keywords: 'ai gemini assistant disable enable turn off artificial intelligence', hint: 'For everyone in this workspace' },
  { id: 'ai.instructions', section: 'ai', label: 'What the assistant knows about the organization', keywords: 'ai instructions context prompt company about knowledge', hint: 'Facts it uses in every answer' },
  { id: 'ai.budget', section: 'ai', label: 'AI credits and budget', keywords: 'ai credits usage limit cost budget tokens', hint: 'How many credits are used and by whom' },
  { id: 'ai.ownKey', section: 'ai', label: 'Use your own Claude or ChatGPT key', keywords: 'ai own key api key byok anthropic claude openai chatgpt gpt provider model bring your own', hint: 'Answers on your organization\'s account, no AI credits' },
  { id: 'apps.connected', section: 'connected-apps', label: 'Connected AI apps (Claude, ChatGPT)', keywords: 'mcp claude chatgpt openai oauth connected apps assistants', hint: 'AI assistants working in this workspace', find: 'Connected' },

  // Billing
  { id: 'billing.plan', section: 'billing', label: 'Plan', keywords: 'plan upgrade downgrade pricing subscription business pro free enterprise trial', hint: 'Your plan and what it includes', find: 'Plan' },
  { id: 'billing.seats', section: 'billing', label: 'Seats', keywords: 'seats users licenses members add seats', hint: 'How many people the plan covers', find: 'Seats' },
  { id: 'billing.invoices', section: 'billing', label: 'Invoices', keywords: 'invoice receipt gst tax bill download', hint: 'Download past invoices', find: 'Invoices' },
  { id: 'billing.payment', section: 'billing', label: 'Payment', keywords: 'payment card upi razorpay pay method renew', hint: 'How the plan is paid', find: 'Pay' },

  // Personal: My account and the Notification Center
  { id: 'account.profile', section: null, personal: true, to: '/settings/profile', label: 'My name and photo', keywords: 'profile name photo avatar picture my account', hint: 'Settings › Profile' },
  { id: 'account.theme', section: null, personal: true, to: '/settings/appearance', label: 'Dark mode', keywords: 'dark mode light theme appearance colours', hint: 'Settings › Appearance', find: 'Dark mode' },
  { id: 'account.timeZone', section: null, personal: true, to: '/settings/profile', label: 'My time zone', keywords: 'my time zone timezone', hint: 'Settings › Profile', find: 'Time zone' },
  { id: 'account.ai', section: null, personal: true, to: '/settings/profile/assistant', label: 'How the assistant works with me', keywords: 'ai learned private notes assistant personal', hint: 'Settings › Profile', find: 'How the assistant works with you' },
  { id: 'account.password', section: null, personal: true, to: '/settings/security/account', label: 'Change my password', keywords: 'password change reset my', hint: 'Settings › Security', find: 'Password' },
  { id: 'account.twoStep', section: null, personal: true, to: '/settings/security/account', label: 'My two-step sign-in', keywords: 'mfa 2fa two-step authenticator otp my account', hint: 'Settings › Security', find: 'Two-step' },
  { id: 'account.passkeys', section: null, personal: true, to: '/settings/security/account', label: 'My passkeys', keywords: 'passkey fingerprint face id touch id windows hello', hint: 'Settings › Security', find: 'Passkeys' },
  { id: 'account.sessions', section: null, personal: true, to: '/settings/security/account', label: 'Devices I am signed in on', keywords: 'sessions devices sign out everywhere logout', hint: 'Settings › Security', find: 'Active sessions' },
  { id: 'account.notifications', section: null, personal: true, to: '/settings/notifications/delivery', label: 'My notifications', keywords: 'my notifications email push whatsapp preferences mute', hint: 'Settings › Notifications › Delivery' },
  { id: 'account.schedule', section: null, personal: true, to: '/settings/notifications/schedule', label: 'My quiet hours, working days and digest', keywords: 'my quiet hours dnd working days digest briefing schedule', hint: 'Settings › Notifications › Schedule' },
  { id: 'account.mail', section: null, personal: true, to: '/settings/integrations/mail', label: 'My mail accounts', keywords: 'mail email gmail outlook rediffmail imap smtp pop mailbox connect company mail server', hint: 'Settings › Integrations › Mail' },
  { id: 'account.delete', section: null, personal: true, to: '/settings/profile', label: 'Delete my account', keywords: 'delete account close remove gdpr', hint: 'Settings › Profile', find: 'Delete my account' },
];

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Ranks the settings a person may open against what they typed. The label counts most, then the words people use for it. */
export function searchSettings(query: string, entries: SettingEntry[], limit = 8): SettingEntry[] {
  const q = norm(query);
  if (q.length < 2) return [];
  const words = q.split(' ').filter(Boolean);
  const scored = entries.map((e) => {
    const label = norm(e.label);
    const keys = ` ${norm(`${e.keywords} ${e.hint}`)} `;
    let s = 0;
    if (label === q) s += 120;
    else if (label.startsWith(q)) s += 90;
    else if (` ${label} `.includes(` ${q} `)) s += 75;
    else if (label.includes(q)) s += 55;
    if (keys.includes(` ${q} `)) s += 50;
    for (const w of words) {
      if (` ${label} `.includes(` ${w}`)) s += 12;
      else if (keys.includes(` ${w} `)) s += 10;
      else if (w.length >= 3 && keys.includes(` ${w}`)) s += 6;
      else s -= 25;   // every word should match something
    }
    if (e.personal) s -= 4;   // workspace settings first when both match
    return { e, s };
  });
  return scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.e);
}

/** Where a result goes: its section with the setting as the anchor, or its own page. */
export function settingHref(e: SettingEntry): string {
  const base = e.to ?? leafHref(e.section!);
  return `${base}${base.includes('#') ? '' : `#s-${e.id}`}`;
}

/** The index narrowed to what this person may open. */
export function visibleSettings(sections: { id: string }[], hasSettings: boolean): SettingEntry[] {
  const open = new Set(sections.map((s) => s.id));
  return SETTINGS_INDEX.filter((e) => e.personal || (e.section ? open.has(e.section) : hasSettings));
}
