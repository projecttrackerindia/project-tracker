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
  { label: 'Download', href: '/download/' },
];

/** Where the apps are published (GitHub releases of the repository: free, and "latest/download/<name>" always points at the newest version). A company hosting its own copy can set SITE_DOWNLOAD_BASE. */
export const DOWNLOAD_BASE = (process.env.SITE_DOWNLOAD_BASE || 'https://github.com/projecttrackerindia/project-tracker/releases/latest/download').replace(/\/$/, '');
export const DOWNLOAD_FILES = {
  windows: 'ProjectTracker-Setup.exe', macArm: 'ProjectTracker-arm64.dmg', macIntel: 'ProjectTracker-x64.dmg',
  linuxAppImage: 'ProjectTracker.AppImage', linuxDeb: 'ProjectTracker.deb', android: 'ProjectTracker.apk', checksums: 'SHA256SUMS.txt',
} as const;


export interface Feature { title: string; text: string; icon: string }
export const FEATURES: Feature[] = [
  { icon: 'kanban', title: 'Projects and delivery timelines', text: 'Boards, lists, stages, sprints and milestones with task dependencies, so every project shows what is next and what is blocked.' },
  { icon: 'monitor', title: 'A portfolio view for leaders', text: 'Every project ranked by risk with the reasons, a forecast of when it will really finish, and the history of every delivery date that moved.' },
  { icon: 'users', title: 'Teams that stay separate', text: 'Five access levels, job-role profiles and teams. Choose whether everyone sees every project or each team sees only its own, and switch the whole app to one team.' },
  { icon: 'sparkle', title: 'An assistant that knows your work', text: 'Ask in plain words. It answers from your own projects and prepares changes you review and confirm before anything happens. Every plan includes a taste of it; Pro adds 60 credits per person a month, Business 200 with deep reasoning.' },
  { icon: 'note', title: 'Documents linked to the work', text: 'Write requirement documents, API documentation and test plans from templates, keep them next to the project, and link each one to the tasks that build it and the tests that check it. Publish versions, compare any two and go back to an earlier one, send a document through the approvals you set up, list its requirements and see which are built and tested, document an API endpoint by endpoint, import and export OpenAPI and Postman files and see which changes between versions will break callers, and choose exactly who can open each document and why.' },
  { icon: 'alarm', title: 'Reminders that arrive on time', text: 'Automatic due-date reminders, a daily briefing, a weekly portfolio brief and push or e-mail delivery, in each person\'s own working hours.' },
  { icon: 'clock', title: 'Time, workload and capacity', text: 'Timesheets with approvals, workload by person and weekly capacity, so work is shared out before people are overloaded.' },
  { icon: 'bolt', title: 'Operational work with service levels', text: 'Bugs, support and requests with response and resolution targets that warn before they are missed. Business plan and above.' },
  { icon: 'message', title: 'Team chat and files', text: 'Direct, group and project conversations with attachments, live delivery and unread counts that stay accurate.' },
  { icon: 'key', title: 'A mobile app and passwordless sign-in', text: 'Install it on Android or iPhone, sign in with a passkey, or approve a sign-in by tapping a number on your phone. Mobile app and phone sign-in from the Pro plan.' },
  { icon: 'git', title: 'Connects to what you already use', text: 'GitHub and Azure DevOps links, Slack and Teams webhooks, an API, single sign-on (OIDC and SAML) and SCIM provisioning.' },
];

export interface Plan { name: string; price: string; unit?: number; perUser?: boolean; blurb: string; points: string[]; cta: string; featured?: boolean }
/**
 * Starting prices in INR, per person per month for Pro and Business; the live price list (Admin > Plans) replaces them when the page opens.
 * Keep in step with DatabaseInitializer (the plan catalog) and docs/PRICING.md.
 */
export const PLANS: Plan[] = [
  { name: 'Free', price: '₹0', blurb: 'For one person getting started.', cta: 'Start free', points: ['One person, free for good', '5 projects and 500 tasks', '500 MB of files', 'Reminders, calendar and timesheets', 'Portfolio view', 'Up to 10 documents, linked to your work', 'Try the AI assistant: 10 quick answers a month'] },
  { name: 'Pro', price: '₹349', unit: 349, perUser: true, blurb: 'For teams that plan and deliver together.', cta: 'Start with Pro', featured: true, points: ['Add as many people as you need', 'Unlimited projects, tasks and teams', '5 GB of files per person', 'Custom workflows, fields and automation', 'Advanced reports and workload', 'Unlimited documents with approval workflows, shared with your teams', 'Mobile app with phone sign-in', 'AI assistant: 60 credits per person every month'] },
  { name: 'Business', price: '₹699', unit: 699, perUser: true, blurb: 'For growing teams and departments.', cta: 'Start with Business', points: ['Everything in Pro', '25 GB of files per person', 'AI with deep reasoning, file understanding and confirmed actions: 200 credits per person', 'Audit log, API access and advanced permissions, with document approvals per type', 'Single sign-on, two-step rules, IP allowlist', 'Resource management and service levels'] },
  { name: 'Enterprise', price: 'Custom', blurb: 'Unlimited scale and governance.', cta: 'Talk to us', points: ['Unlimited members and storage', 'A large shared AI pool, sized to your contract', 'Everything in Business', 'Longest history and audit retention', 'Priority onboarding and support'] },
];

/** The discounts, as the live price list states them (/api/v1/public/pricing); these are what shows before it loads. */
export const OFFERS = {
  annualPercent: 20, maxPercent: 30, trialDays: 14, trialPeople: 5,
  volume: [{ min: 10, percent: 10 }, { min: 25, percent: 15 }, { min: 100, percent: 20 }],
  credits: { quick: 1, standard: 4, deep: 20 },
};

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
    'Passkeys: sign in with a fingerprint, face or screen lock. They only work on this site, so a look-alike page gets nothing, and they count as two-step verification.',
    'Two-step verification with authenticator apps and recovery codes, which an organization can require.',
    'Sign in on a computer by approving on your phone: pick the matching number, so a prompt you did not expect is not approved by reflex.',
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
    'Writes can carry an idempotency key, so a retry from a weak mobile connection is answered again instead of done twice.',
    'Webhooks are signed, and cannot point at private or internal networks.',
    'Defences against cross-site request forgery and clickjacking, and strict security headers.',
    'Continuous integration builds and tests every change and checks dependencies for known vulnerabilities.',
  ] },
];

/** Pages that exist as static files (and so are indexed with their own title and description). */
export interface StaticPage { path: string; title: string; description: string; h1: string; lead: string }
export const PAGES: StaticPage[] = [
  { path: '/download/', title: 'Download the apps | Project Tracker', h1: 'Project Tracker on every screen', lead: 'Install the app for Windows, macOS, Linux and Android, or add it to your iPhone. Free to download.',
    description: 'Download Project Tracker for Windows, macOS, Linux and Android, or install it on iPhone from your browser. Alerts, a tray icon and sign-in with your phone or a passkey.' },
  { path: '/features/', title: 'Features | Project Tracker', h1: 'Everything a delivery team needs, in one workspace', lead: 'From the first task to the portfolio review, without stitching tools together.',
    description: 'Projects and timelines, a portfolio view with risk and forecasts, team-separated access, reminders, timesheets, chat and an AI assistant. See what Project Tracker does.' },
  { path: '/pricing/', title: 'Pricing | Project Tracker', h1: 'Simple plans that grow with your teams', lead: 'Start free. Move up when you need more people, teams, reports or governance.',
    description: 'Free, Pro, Business and Enterprise plans for Project Tracker. Per-person pricing with yearly and team discounts. Compare storage, the AI assistant and its credits, audit log and single sign-on.' },
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
    description: 'Ask about your projects, workload and risks in plain language. The assistant answers from your own data and proposes changes that you confirm first. Every plan includes a taste; Pro and Business bring credits per person each month.',
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
  {
    path: '/features/mobile-and-sign-in/', title: 'Mobile App, Passkeys and Phone Sign-in | Project Tracker', h1: 'Sign in with your phone. Work from anywhere.',
    lead: 'An installable mobile app built for one hand, passkeys instead of passwords, and sign-in on a computer by tapping a number on your phone.',
    description: 'Install Project Tracker on Android or iPhone, sign in with passkeys or by approving on your phone, and get alerts when the app is closed. Mobile app and phone sign-in from the Pro plan.',
    sections: [
      { title: 'An app, not a shrunken website', text: 'On a phone the product becomes an app: a floating tab bar, bottom sheets, a Home built around your day and pull to refresh.',
        points: ['Install it from your browser on Android or iPhone, with its own icon and full screen', 'Works in portrait and landscape, with tables turned into cards and no sideways scrolling', 'Alerts reach you at the top of the screen, even when the app is closed'] },
      { title: 'Approve a sign-in on your phone', text: 'Type your email on a computer. Your phone shows three numbers; tap the one on the computer and you are in.',
        points: ['The matching number means a prompt you did not expect is not approved by reflex', 'Each request lasts two minutes and works once, only for the screen that asked', 'Counts as the second factor a workspace may require'] },
      { title: 'Passkeys, on every plan', text: 'Sign in with the fingerprint, face or screen lock you already use to unlock your device.',
        points: ['Nothing to type or remember, and nothing to steal in a data breach', 'Bound to this site, so a look-alike page gets nothing', 'See every device you are signed in on, and how each one signed in'] },
      { title: 'Reliable on a weak connection', text: 'Writes can carry an idempotency key, and answers are compressed.',
        points: ['A retried request is answered again, never done twice', 'Smaller responses over mobile data', 'The API description is public, with every call and its errors'] },
    ],
    related: ['/security/', '/pricing/'],
  },
];

/** The plan comparison. From the plan catalog (DatabaseInitializer): keep it in step with that. A tick is true, a dash is not included. */
export const COMPARE: { group: string; rows: { label: string; v: [string, string, string, string] }[] }[] = [
  { group: 'Scale', rows: [
    { label: 'People', v: ['1', 'Pay per person', 'Pay per person', 'Unlimited'] },
    { label: 'Teams', v: ['1', 'Unlimited', 'Unlimited', 'Unlimited'] },
    { label: 'Projects', v: ['5', 'Unlimited', 'Unlimited', 'Unlimited'] },
    { label: 'Tasks', v: ['500', 'Unlimited', 'Unlimited', 'Unlimited'] },
    { label: 'File storage', v: ['500 MB', '5 GB per person', '25 GB per person', 'Unlimited'] },
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
    { label: 'Documents (requirements, API, test plans)', v: ['10', 'Unlimited', 'Unlimited', 'Unlimited'] },
    { label: 'Documents linked to projects and tasks', v: ['✓', '✓', '✓', '✓'] },
    { label: 'Versions, compare and restore', v: ['✓', '✓', '✓', '✓'] },
    { label: 'Share with a person, team or job role', v: ['–', '✓', '✓', '✓'] },
    { label: 'Block someone or end access on a date', v: ['–', '–', '✓', '✓'] },
    { label: 'API documentation: endpoints, import and export', v: ['50 endpoints', '2,000 endpoints', '25,000 endpoints', 'Unlimited'] },
    { label: 'Breaking-change check between versions', v: ['✓', '✓', '✓', '✓'] },
    { label: 'Approval workflow before publishing', v: ['Owner publishes', 'Multi-step', 'A path per document type, with reminders', '✓'] },
    { label: 'Ask for access, with a reason and an end date', v: ['–', '✓', '✓', '✓'] },
    { label: 'Requirement coverage: work built and tested', v: ['✓', '✓', '✓', '✓'] },
    { label: 'Full document audit trail and export', v: ['–', '–', '✓', '✓'] },
    { label: 'Mobile app and phone sign-in', v: ['–', '✓', '✓', '✓'] },
  ] },
  { group: 'Intelligence', rows: [
    { label: 'AI assistant', v: ['Try it', 'Quick and Standard', 'Quick, Standard and Deep', 'All levels'] },
    { label: 'AI credits each month', v: ['10', '60 per person', '200 per person', 'A shared pool'] },
    { label: 'AI reads files and takes confirmed actions', v: ['–', 'Reads files', '✓', '✓'] },
  ] },
  { group: 'Control and security', rows: [
    { label: 'Advanced permissions', v: ['–', '–', '✓', '✓'] },
    { label: 'Audit log', v: ['–', '–', '✓', '✓'] },
    { label: 'API access', v: ['–', '–', '✓', '✓'] },
    { label: 'Passkeys and two-step verification', v: ['✓', '✓', '✓', '✓'] },
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
  { q: 'Is there a free plan?', a: 'Yes. Free is for one person, for good: 5 projects, 500 tasks and 500 MB of files, with reminders, calendar, timesheets, the portfolio view and ten quick AI answers a month to try the assistant.' },
  { q: 'How does per-person pricing work?', a: 'Pro and Business are priced per person per month, and you pay for the people in your workspace. Storage and AI credits grow with each person and are shared by the whole team. Add people any time; the owner chooses the number of seats under Settings, Billing.' },
  { q: 'What discounts are there?', a: 'Paying for a year at once takes 20% off. Teams of 10 or more get 10% off, 25 or more 15%, and 100 or more 20%, automatically. The two add up, to at most 30% off. Prices are in Indian rupees and exclude GST.' },
  { q: 'What is an AI credit?', a: 'A unit of AI use. A quick answer costs 1 credit, a standard answer 4 and a deep analysis 20. Each person on Pro brings 60 credits a month and each person on Business 200, pooled across the team and renewed on the 1st. When the pool runs out the assistant waits until the next month; nothing else is affected.' },
  { q: 'Is there a free trial of the paid plans?', a: 'Yes. Start a 14-day trial of Pro or Business from Settings, Billing: up to 5 people and 100 AI credits, no payment taken.' },
  { q: 'Can I change plans or the number of people later?', a: 'Yes. An owner changes the plan, the number of seats and monthly or yearly billing under Settings, Billing. Adding seats works at once; the new amount starts at your next renewal, so nothing is charged twice.' },
  { q: 'Does the assistant change my projects by itself?', a: 'No. It answers from the projects you can open and proposes changes. Nothing happens until you confirm it.' },
  { q: 'Can teams keep their projects private from each other?', a: 'Yes. Choose team-only visibility and each person sees the projects of their teams, plus the ones they own or were added to. Owners and admins see everything; guests only the projects they are added to.' },
  { q: 'How is each organization\'s data kept separate?', a: 'In the data layer itself, not only in the screens, and automated tests check every screen for leaks between organizations, teams and roles.' },
  { q: 'What is a passkey, and do I need a paid plan?', a: 'A passkey lets you sign in with your fingerprint, face or screen lock instead of a password. It works only on this site and cannot be phished. Passkeys are on every plan, including Free.' },
  { q: 'Is there a mobile app?', a: 'Yes, from the Pro plan: install Project Tracker on your phone from Account, Mobile app, get alerts when it is closed, and sign in on a computer by tapping a number on your phone. No password to type.' },
  { q: 'Can I take my data with me?', a: 'Yes. Owners can export everything as files in one zip at any time, and set how long history is kept.' },
  { q: 'Does it support single sign-on?', a: 'Yes, on Business and Enterprise: OpenID Connect and SAML 2.0, with SCIM provisioning to add and remove people automatically.' },
];
