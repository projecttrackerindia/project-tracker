/**
 * What the public pages say. One place, so the landing page inside index.html, the Features / Pricing / Security pages, the sitemap and the
 * search-engine descriptions never disagree. Everything here must stay true of the product: change it together with the product.
 */
export const SITE = {
  name: 'Project Tracker',
    tagline: 'Project management for teams that deliver',
  description: 'Plan projects, track tasks and time, see portfolio risk at a glance and get answers from an AI assistant. Secure project management for every team.',
  alternateNames: ['ProjectTracker', 'projecttracker.in'],
  securityEmail: 'security@projecttracker.in',
  themeColor: '#7c3aed',
};

export interface NavLink { label: string; href: string }
export const NAV: NavLink[] = [
  { label: 'Features', href: '/features/' },
  { label: 'Pricing', href: '/pricing/' },
  { label: 'Security', href: '/security/' },
];

export interface Feature { title: string; text: string; icon: string }
export const FEATURES: Feature[] = [
  { icon: 'kanban', title: 'Projects and delivery timelines', text: 'Boards, lists, stages, sprints and milestones with task dependencies, so every project shows what is next and what is blocked.' },
  { icon: 'monitor', title: 'A portfolio view for leaders', text: 'Every project ranked by risk with the reasons, a forecast of when it will really finish, and the history of every delivery date that moved.' },
  { icon: 'users', title: 'Teams that stay separate', text: 'Five access levels, job-role profiles and teams. Choose whether everyone sees every project or each team sees only its own, and switch the whole app to one team.' },
  { icon: 'sparkle', title: 'An assistant that knows your work', text: 'Ask in plain words. It answers from your own projects and prepares changes you review and confirm before anything happens. Business plan and above.' },
  { icon: 'alarm', title: 'Reminders that arrive on time', text: 'Automatic due-date reminders, a daily briefing, a weekly portfolio brief and push or e-mail delivery, in each person\'s own working hours.' },
  { icon: 'clock', title: 'Time, workload and capacity', text: 'Timesheets with approvals, workload by person and weekly capacity, so work is shared out before people are overloaded.' },
  { icon: 'bolt', title: 'Operational work with service levels', text: 'Bugs, support and requests with response and resolution targets that warn before they are missed. Business plan and above.' },
  { icon: 'message', title: 'Team chat and files', text: 'Direct, group and project conversations with attachments, live delivery and unread counts that stay accurate.' },
  { icon: 'git', title: 'Connects to what you already use', text: 'GitHub and Azure DevOps links, Slack and Teams webhooks, an API, single sign-on (OIDC and SAML) and SCIM provisioning.' },
];

export interface Plan { name: string; price: string; blurb: string; points: string[]; cta: string; featured?: boolean }
/** Starting prices in INR per month. Keep in step with Admin > Plans; the app shows the live price at checkout. */
export const PLANS: Plan[] = [
  { name: 'Free', price: '₹0', blurb: 'For one person getting started.', cta: 'Start free', points: ['1 member and 1 team', '5 projects and 500 tasks', '500 MB of files', 'Reminders, calendar and timesheets', 'Portfolio view'] },
  { name: 'Pro', price: '₹999', blurb: 'For freelancers and small teams.', cta: 'Start with Pro', featured: true, points: ['Up to 10 members and 5 teams', 'Unlimited projects and tasks', '10 GB of files', 'Custom workflows, fields and automation', 'Advanced reports and workload'] },
  { name: 'Business', price: '₹2,499', blurb: 'For growing teams and departments.', cta: 'Start with Business', points: ['Up to 100 members, unlimited teams', 'AI assistant and file understanding', 'Audit log, API access and advanced permissions', 'Single sign-on, two-step verification rules, IP allowlist', 'Resource management and service levels'] },
  { name: 'Enterprise', price: 'Custom', blurb: 'Unlimited scale and governance.', cta: 'Get started', points: ['Unlimited members, storage and AI use', 'Everything in Business', 'Longest history and audit retention', 'Priority onboarding and support'] },
];

export interface Pillar { icon: string; title: string; points: string[] }
export const SECURITY: Pillar[] = [
  { icon: 'lock', title: 'Encryption', points: [
    'All traffic is HTTPS, with HTTP Strict Transport Security.',
    'Passwords are stored only as salted PBKDF2 hashes; earlier passwords cannot be reused.',
    'Authenticator secrets, webhook secrets, sign-on client secrets and similar are encrypted at rest with AES-256-GCM.',
    'API keys, SCIM tokens and calendar addresses are stored as one-way hashes and shown only once.',
  ] },
  { icon: 'key', title: 'Identity and sign-in', points: [
    'Single sign-on with OpenID Connect or SAML 2.0 (signed assertions only), on domains you prove you own.',
    'Automatic provisioning and de-provisioning with SCIM 2.0.',
    'Two-step verification with authenticator apps and recovery codes, which an organization can require.',
    'Sign-in from Google, Microsoft, GitHub or Apple joins an account only through a verified e-mail address.',
    'Sessions can be reviewed and revoked; organizations can restrict access to their own IP ranges.',
  ] },
  { icon: 'shield', title: 'Access control and isolation', points: [
    'Every record belongs to one workspace, and every request is checked against the caller\u2019s current membership, role and access, not just their token.',
    'Roles, per-module access levels, job-role profiles and team-only visibility decide who can see and change what.',
    'Removing someone, or disabling their account, takes effect on their very next request.',
  ] },
  { icon: 'activity', title: 'Audit and monitoring', points: [
    'An audit log of sign-ins, permission, security and configuration changes.',
    'Audit records can be streamed to your SIEM through a webhook.',
    'Application tracing and metrics (OpenTelemetry) and health checks on every component.',
  ] },
  { icon: 'database', title: 'Your data', points: [
    'Workspace owners can export everything as JSON files in one zip, at any time.',
    'Retention you control: activity, notifications, chat and the audit log can be deleted after a period you choose.',
    'Files are kept in object storage with checksums; deleted projects\u2019 files are purged.',
  ] },
  { icon: 'bug', title: 'Building it safely', points: [
    'Rate limiting on every endpoint, with stricter limits on sign-in.',
    'Webhooks are signed, and cannot point at private or internal networks.',
    'Defences against cross-site request forgery and clickjacking, and strict security headers.',
    'Continuous integration builds and tests every change and checks dependencies for known vulnerabilities.',
  ] },
];

/** Pages that exist as static files (and so are indexed with their own title and description). */
export interface StaticPage { path: string; title: string; description: string; h1: string; lead: string }
export const PAGES: StaticPage[] = [
  { path: '/features/', title: 'Features | Project Tracker', h1: 'Everything a delivery team needs, in one workspace', lead: 'From the first task to the portfolio review, without stitching tools together.',
    description: 'Projects and timelines, a portfolio view with risk and forecasts, team-separated access, reminders, timesheets, chat and an AI assistant. See what Project Tracker does.' },
  { path: '/pricing/', title: 'Pricing | Project Tracker', h1: 'Simple plans that grow with your teams', lead: 'Start free. Move up when you need more people, teams, reports or governance.',
    description: 'Free, Pro, Business and Enterprise plans for Project Tracker. Compare members, teams, storage, the AI assistant, audit log and single sign-on.' },
  { path: '/security/', title: 'Security | Project Tracker', h1: 'Security and privacy built into the foundations', lead: 'How we keep each organization\'s work separate, controlled and recoverable.',
    description: 'How Project Tracker protects your data: organization isolation, role-based access, two-step verification, single sign-on, audit log, encrypted traffic and nightly backups.' },
];

export const HOME = { path: '/', title: `${SITE.name} | Project Management Software for Teams`, description: SITE.description, h1: 'Plan the work. Track it across every team.', lead: 'Projects, tasks, timesheets and portfolio reporting in one secure workspace, with an assistant that works from your real data.' };
