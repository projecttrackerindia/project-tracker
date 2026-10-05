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

/** One page per thing people search for, written to stand on its own. Every statement here describes what the product does today. */
export interface DetailPage extends StaticPage { sections: { title: string; text: string; points: string[] }[]; related: string[] }
export const DETAILS: DetailPage[] = [
  {
    path: '/features/portfolio/', title: 'Project Portfolio Management and Risk Forecasting | Project Tracker', h1: 'See which projects will miss their dates, and why',
    lead: 'A portfolio view that works out risk, forecasts the real finish date and remembers every date that moved, so leaders can act before a deadline is missed.',
    description: 'Rank every project by risk with the reasons, forecast the real finish date from the pace of the last four weeks, track date changes and try what-if scenarios.',
    sections: [
      { title: 'Risk ranked, with reasons', text: 'Every active project gets a risk level made from facts you can check, never a hidden score.',
        points: ['Overdue and blocked tasks, and tasks waiting on unfinished work', 'Overdue action items and delivery dates that already moved', 'Time used against work done, and projects past their due date'] },
      { title: 'A forecast from the real pace', text: 'The plan says when work should finish. The forecast says when it will, at the pace the team has actually been finishing tasks.',
        points: ['Remaining tasks divided by tasks finished in the last 28 days', 'A confidence level, so a thin history is not presented as certainty', 'Shown as days early or late against the due date'] },
      { title: 'What if, before you decide', text: 'Try a later start, more people or fewer tasks and see the new finish date next to today\'s plan.',
        points: ['See what it would take to still meet the due date', 'Added people count for less than a full person, because new people take time to get up to speed', 'Nothing in the project changes while you explore'] },
      { title: 'A history of every moved date', text: 'Each change to a delivery date keeps its reason and what it was waiting on, so a slip is explained, not just noticed.',
        points: ['Original and current dates side by side', 'Reasons and dependencies recorded at the time', 'A weekly portfolio brief for owners and admins, and one on demand for anyone'] },
    ],
    related: ['/features/ai-assistant/', '/features/teams-and-access/'],
  },
  {
    path: '/features/ai-assistant/', title: 'AI Assistant for Project Management | Project Tracker', h1: 'An assistant that answers from your own projects',
    lead: 'Ask in plain words. It reads only what you are allowed to see, and prepares changes for you to review before anything happens.',
    description: 'Ask about your projects, workload and risks in plain language. The assistant answers from your own data and proposes changes that you confirm first. Business plan and above.',
    sections: [
      { title: 'Grounded in your work', text: 'Answers come from your projects, tasks and people, with the figures worked out by the product rather than guessed by the model.',
        points: ['Portfolio risk, forecasts and what-if questions', 'Workload, who has room and who is stretched', 'Find work by person, project, date or status'] },
      { title: 'You stay in control', text: 'The assistant proposes; you decide.',
        points: ['Changes to tasks, assignees, dates and reminders are shown first and only happen when you confirm', 'Text hidden inside a task or file can never make it change anything on its own', 'It follows your access: it cannot see what you cannot'] },
      { title: 'Built for teams', text: 'Part of the same workspace, with the same permissions.',
        points: ['Understands attached pictures and documents', 'Follows the team you are viewing', 'Usage shown to the workspace, with limits set by plan'] },
    ],
    related: ['/features/portfolio/', '/pricing/'],
  },
  {
    path: '/features/teams-and-access/', title: 'Teams, Roles and Access Control | Project Tracker', h1: 'Everyone sees what they should, and nothing more',
    lead: 'Five access levels, job-role profiles and teams, with the choice between an open organization and team-only visibility.',
    description: 'Owner, admin, manager, member and guest roles, job-role profiles, teams and team-only project visibility, enforced in the data layer so each person sees only their own work.',
    sections: [
      { title: 'Roles and job-role profiles', text: 'Start from five access levels and fine-tune what each job role can do, module by module.',
        points: ['Owner, Admin, Manager, Member and Guest', 'Per-module access levels set by job role', 'An access preview shows what a person can actually reach'] },
      { title: 'Open or team-only', text: 'Choose whether everyone sees every project or each team sees only its own.',
        points: ['People see projects of their teams, plus ones they own or were added to', 'Owners and admins see everything; other roles can be granted that', 'Guests only ever see the projects they are added to'] },
      { title: 'One team at a time', text: 'Switch the whole app to a single team, and the dashboard, reports and assistant follow.',
        points: ['Team picker in the top bar', 'Reports and portfolio narrow to that team', 'Separate organizations never share data'] },
      { title: 'Enforced where the data lives', text: 'Visibility is applied in the data layer, so screens, reports, search and the assistant narrow the same way.',
        points: ['Automated tests crawl every screen as a member of one team while another team\'s data exists', 'Removing someone takes effect on their very next request'] },
    ],
    related: ['/security/', '/features/portfolio/'],
  },
  {
    path: '/features/timesheets-and-workload/', title: 'Timesheets, Workload and Capacity Planning | Project Tracker', h1: 'Share the work out before people are overloaded',
    lead: 'Timesheets with approvals, workload by person and weekly capacity, in the same workspace as the tasks.',
    description: 'Track time on tasks, approve timesheets, see workload by person and plan weekly capacity so work is shared out before anyone is overloaded.',
    sections: [
      { title: 'Timesheets people will fill in', text: 'Log time against tasks and see the week at a glance.',
        points: ['Timesheets with an approval step for managers', 'Time stays with the person who logged it', 'Reports by person, project and period'] },
      { title: 'Workload and capacity', text: 'See open, overdue and due-this-week work for each person against the hours they have.',
        points: ['Estimated hours left against weekly capacity', 'Who is overloaded and who has room', 'Resource management on Business and above'] },
      { title: 'Reminders that respect working hours', text: 'Due-date reminders, a daily briefing and push or e-mail delivery in each person\'s own time zone.',
        points: ['Done and Snooze from the notification itself', 'A briefing at the time each person chooses', 'Escalation on Business and above'] },
    ],
    related: ['/features/portfolio/', '/pricing/'],
  },
];

/** The plan comparison. From the plan catalog (DatabaseInitializer): keep it in step with that. A tick is true, a dash is not included. */
export const COMPARE: { group: string; rows: { label: string; v: [string, string, string, string] }[] }[] = [
  { group: 'Scale', rows: [
    { label: 'Members', v: ['1', 'Up to 10', 'Up to 100', 'Unlimited'] },
    { label: 'Teams', v: ['1', 'Up to 5', 'Unlimited', 'Unlimited'] },
    { label: 'Projects', v: ['5', 'Unlimited', 'Unlimited', 'Unlimited'] },
    { label: 'Tasks', v: ['500', 'Unlimited', 'Unlimited', 'Unlimited'] },
    { label: 'File storage', v: ['500 MB', '10 GB', '50 GB', 'Unlimited'] },
    { label: 'Largest file', v: ['10 MB', '100 MB', '250 MB', '512 MB'] },
    { label: 'Activity history', v: ['30 days', '1 year', '2 years', 'Unlimited'] },
  ] },
  { group: 'Work', rows: [
    { label: 'Reminders, calendar and timesheets', v: ['✓', '✓', '✓', '✓'] },
    { label: 'Portfolio view and what-if', v: ['✓', '✓', '✓', '✓'] },
    { label: 'Advanced reports and workload', v: ['–', '✓', '✓', '✓'] },
    { label: 'Custom workflows, fields and automation', v: ['–', '✓', '✓', '✓'] },
    { label: 'Resource management and service levels', v: ['–', '–', '✓', '✓'] },
    { label: 'Reminder escalation', v: ['–', '–', '✓', '✓'] },
  ] },
  { group: 'Intelligence', rows: [
    { label: 'AI assistant with confirmed actions', v: ['–', '–', '✓', '✓'] },
    { label: 'AI use each month', v: ['–', '–', '2,000 credits', 'Unlimited'] },
  ] },
  { group: 'Control and security', rows: [
    { label: 'Advanced permissions', v: ['–', '–', '✓', '✓'] },
    { label: 'Audit log', v: ['–', '–', '✓', '✓'] },
    { label: 'API access', v: ['–', '–', '✓', '✓'] },
    { label: 'Single sign-on, IP allowlist, two-step rules', v: ['–', '–', '✓', '✓'] },
  ] },
];

/** The same work with and without a tracker, for someone who runs projects from spreadsheets and chat today. */
export const VERSUS: { what: string; without: string; with: string }[] = [
  { what: 'When will it really finish?', without: 'A guess in someone\'s head', with: 'Worked out from the pace of the last four weeks' },
  { what: 'Which project is in trouble?', without: 'Whoever notices first', with: 'Every project ranked, with the reasons' },
  { what: 'Why did the date move?', without: 'The cell was overwritten', with: 'Every change kept with its reason' },
  { what: 'Who sees which project?', without: 'Everyone with the file', with: 'Roles, teams and guests, enforced in the data' },
  { what: 'What if we add two people?', without: 'Build another spreadsheet', with: 'A scenario in seconds' },
  { what: 'Chasing people', without: 'Messages and meetings', with: 'Reminders in each person\'s own working hours' },
];

export const INTEGRATIONS = ['GitHub', 'Azure DevOps', 'Slack', 'Microsoft Teams', 'Single sign-on (OIDC, SAML)', 'SCIM provisioning', 'REST API', 'Signed webhooks', 'Google, Microsoft, GitHub and Apple sign-in'];

export const FAQ: { q: string; a: string }[] = [
  { q: 'Is there a free plan?', a: 'Yes. Free is for one person: 1 member and 1 team, 5 projects, 500 tasks and 500 MB of files, with reminders, calendar, timesheets and the portfolio view.' },
  { q: 'Can I change plans later?', a: 'Yes. An owner changes the plan under Settings, Billing, and the price shown at checkout is the one that applies.' },
  { q: 'Does the assistant change my projects by itself?', a: 'No. It answers from the projects you can open and proposes changes. Nothing happens until you confirm it.' },
  { q: 'Can teams keep their projects private from each other?', a: 'Yes. Choose team-only visibility and each person sees the projects of their teams, plus the ones they own or were added to. Owners and admins see everything; guests only the projects they are added to.' },
  { q: 'How is each organization\'s data kept separate?', a: 'In the data layer itself, not only in the screens, and automated tests check every screen for leaks between organizations, teams and roles.' },
  { q: 'Can I take my data with me?', a: 'Yes. Owners can export everything as files in one zip at any time, and set how long history is kept.' },
  { q: 'Does it support single sign-on?', a: 'Yes, on Business and Enterprise: OpenID Connect and SAML 2.0, with SCIM provisioning to add and remove people automatically.' },
];
