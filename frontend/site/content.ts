/**
 * What the public pages say. One place, so the landing page inside index.html, the Features / Pricing / Security pages, the sitemap and the
 * search-engine descriptions never disagree. Everything here must stay true of the product: change it together with the product.
 */
export const SITE = {
  name: 'Project Tracker',
  tagline: 'Projects, operations and an AI employee for teams that deliver',
  description: 'Plan projects, run your support desk, document every API and let an AI employee answer calls and WhatsApp in your customers\' language. One secure workspace for teams that deliver.',
  alternateNames: ['ProjectTracker', 'projecttracker.in'],
  /** The one address for every question: sales, billing, help and security reports. */
  supportEmail: 'support@projecttracker.in',
  securityEmail: 'support@projecttracker.in',
  themeColor: '#7c3aed',
};

export interface NavLink { label: string; href: string }
export const NAV: NavLink[] = [
  { label: 'Features', href: '/features/' },
  { label: 'AI employee', href: '/features/ai-employee/' },
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
  { icon: 'phone', title: 'An AI employee on your support line', text: 'It picks up calls and WhatsApp messages, speaks your customers\' language, checks who is calling, answers from what your team has taught it and hands over to a person whenever it should. Every conversation becomes a ticket with the full record.' },
  { icon: 'bolt', title: 'An operations desk with service levels', text: 'Tickets, bugs and requests in one queue and on a board, with response and resolution targets that warn before they are missed, insights on what keeps coming back and suggestions for who should take each one.' },
  { icon: 'message', title: 'WhatsApp support, team by team', text: 'Each team connects its own business number. Answers come first from what you already know; people step in from a shared inbox when it matters, and nothing is lost between a chat, a call and a ticket.' },
  { icon: 'layers', title: 'DocTracker for APIs and documents', text: 'Every project\'s APIs, architecture and documents in one place, with a score that shows what is missing, diagrams drawn on a canvas, sensitive values masked by default and a record of everyone who looked.' },
  { icon: 'mic', title: 'A notetaker in every meeting', text: 'Send it to the call and get clear minutes afterwards: what was decided, who does what and by when.' },
  { icon: 'link', title: 'Works inside Claude and ChatGPT', text: 'Connect your workspace to the AI assistant you already use. Ask about projects and your work, and let it create tasks or update status when you allow it, signed in as you with your own permissions.' },
  { icon: 'kanban', title: 'Projects and delivery timelines', text: 'Boards, lists, stages, sprints and milestones with task dependencies, so every project shows what is next and what is blocked.' },
  { icon: 'monitor', title: 'A portfolio view for leaders', text: 'Every project ranked by risk with the reasons, a forecast of when it will really finish, and the history of every delivery date that moved.' },
  { icon: 'sparkle', title: 'An assistant that knows your work', text: 'Ask in plain words. It answers from your own projects and prepares changes you review and confirm before anything happens.' },
  { icon: 'users', title: 'Teams that stay separate', text: 'Five access levels, job-role profiles and teams. Choose whether everyone sees every project or each team sees only its own.' },
  { icon: 'clock', title: 'Time, workload and capacity', text: 'Timesheets with approvals, workload by person and weekly capacity, so work is shared out before people are overloaded.' },
  { icon: 'alarm', title: 'Reminders and one notification centre', text: 'Due dates, a daily briefing, support alerts and your own reminders in one place, delivered in each person\'s working hours. The browser asks once, never again.' },
  { icon: 'key', title: 'Apps and passwordless sign-in', text: 'Desktop and mobile apps, passkeys, and sign-in on a computer by tapping a number on your phone.' },
  { icon: 'git', title: 'Connects to what you already use', text: 'GitHub and Azure DevOps, Slack and Teams, single sign-on and provisioning, signed webhooks and an API.' },
];

export interface Plan { name: string; price: string; unit?: number; perUser?: boolean; blurb: string; points: string[]; cta: string; featured?: boolean }
/**
 * Starting prices in INR, per person per month for Pro and Business; the live price list (Admin > Plans) replaces them when the page opens.
 * Keep in step with DatabaseInitializer (the plan catalog) and docs/PRICING.md.
 */
export const PLANS: Plan[] = [
  { name: 'Free', price: '₹0', blurb: 'For one person getting started.', cta: 'Start free', points: ['One person, free for good', '5 projects and 500 tasks', '500 MB of files', 'Reminders, calendar and timesheets', 'Portfolio view', 'Up to 10 documents, linked to your work', 'Try the AI assistant: 10 quick answers a month'] },
  { name: 'Pro', price: '₹449', unit: 449, perUser: true, blurb: 'For teams that plan and deliver together.', cta: 'Start with Pro', featured: true, points: ['Add as many people as you need', 'Unlimited projects, tasks and teams', 'DocTracker: 2,000 API endpoints, architecture diagrams, approvals', 'Meeting notetaker with minutes and action items', 'Custom workflows, fields and automation', 'Advanced reports, workload and PDF export', 'Mobile and desktop apps with phone sign-in', '5 GB of files and 80 AI credits per person each month'] },
  { name: 'Business', price: '₹999', unit: 999, perUser: true, blurb: 'For support, operations and growing departments.', cta: 'Start with Business', points: ['Everything in Pro', 'Operations desk with service levels and insights', 'AI employee for calls and WhatsApp, in your customers\' languages', 'DocTracker Security Center: masking, reveal timer, audit trail', '300 AI credits per person, with deep reasoning and confirmed actions', 'Single sign-on, audit log, API access, IP allowlist', '25 GB of files per person, resource management'] },
  { name: 'Enterprise', price: 'Custom', blurb: 'Unlimited scale and governance.', cta: 'Talk to us', points: ['Everything in Business', 'Unlimited members, storage and API endpoints', 'A large shared AI pool for your AI employee, sized to your contract', 'Your own phone numbers and WhatsApp accounts per team', 'Longest history and audit retention', 'Priority onboarding and a named contact'] },
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
    'Hosted in India: the app, its database, your files and the backups run on Google Cloud in Mumbai.',
    'Daily database backups kept for 14 days, with point-in-time recovery.',
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
  { path: '/features/', title: 'Features | Project Tracker', h1: 'Everything a delivery team needs, in one workspace', lead: 'From the first task to the support call, without stitching tools together.',
    description: 'Projects and timelines, an operations desk with service levels, an AI employee for calls and WhatsApp, DocTracker for APIs, a meeting notetaker and an AI assistant. See what Project Tracker does.' },
  { path: '/pricing/', title: 'Pricing | Project Tracker', h1: 'Simple plans that grow with your teams', lead: 'Start free. Move up when you need an operations desk, an AI employee or more governance.',
    description: 'Free, Pro, Business and Enterprise plans for Project Tracker. Per-person pricing with yearly and team discounts. Compare DocTracker, the operations desk, the AI employee, AI credits, audit log and single sign-on.' },
  { path: '/security/', title: 'Security | Project Tracker', h1: 'Security and privacy built into the foundations', lead: 'How we keep each organization\'s work separate, controlled and recoverable.',
    description: 'How Project Tracker protects your data: organization isolation, role-based access, two-step verification, single sign-on, audit log, encrypted traffic and nightly backups.' },
];

export const HOME = { path: '/', title: `${SITE.name} | Projects, Support Desk and AI Employee`, description: SITE.description, h1: 'Plan the work, see risk early, ship on time.', lead: 'Projects, an operations desk, API documentation and an AI employee that answers your customers, in one secure workspace.' };

/** One page per thing people search for, written to stand on its own. Every statement here describes what the product does today. */
export interface DetailPage extends StaticPage { sections: { title: string; text: string; points: string[] }[]; related: string[] }
export const DETAILS: DetailPage[] = [
  {
    path: '/features/connect-ai/', title: 'Connect Claude and ChatGPT to Your Projects | Project Tracker', h1: 'Your workspace, inside the AI assistant you already use',
    lead: 'Connect Claude or ChatGPT in a minute. Ask about projects, tasks and support work in plain words, and let it make changes only when you allow it.',
    description: 'Connect Project Tracker to Claude or ChatGPT: a secure sign-in, read-only or read-and-change access, your own permissions, and a list of connected apps you can switch off at any time. Setup steps and example prompts.',
    sections: [
      { title: 'Connect in a minute', text: 'Add Project Tracker as a connector, sign in when asked, choose the workspace and what it may do.',
        points: ['In Claude: Settings, Connectors, then add Project Tracker with the address https://projecttracker.in/api/v1/mcp', 'In ChatGPT: Settings, Apps and connectors, then add the same address with sign-in', 'Pick read only, or read and make changes'] },
      { title: 'Safe by design', text: 'It works as you, never as more than you.',
        points: ['Your own role and permissions decide what it can see and change', 'It never sees your password; access renews itself and can be switched off at once', 'Every connected app is listed in Settings, Connected apps'] },
      { title: 'What it can do', text: 'Find and summarise your work, and keep it moving.',
        points: ['Projects, tasks, your work, support tickets and API documentation', 'Create tasks and work items, change status, comment and log time', 'Works on every plan, including Free'] },
      { title: 'Try asking', text: 'Three things people ask first.',
        points: ['"What is overdue for me this week, by project?" - lists your open work with due dates', '"Create a task in Customer portal to review the login copy, due Friday" - creates it after you allow changes', '"Which support tickets are close to missing their target?" - lists open work items with their service level'] },
    ],
    related: ['/features/ai-assistant/', '/security/'],
  },
  {
    path: '/features/ai-employee/', title: 'AI Employee for Calls and WhatsApp | Project Tracker', h1: 'An AI employee that answers your customers',
    lead: 'It answers calls and WhatsApp messages in your customers\' own language, follows your rules, and hands over to your team the moment a person is needed.',
    description: 'An AI voice and WhatsApp agent for support teams: answers in Telugu, Hindi, Tamil, Kannada and English, checks the caller, raises tickets with the full record and hands over to people. Part of Project Tracker Business.',
    sections: [
      { title: 'Speaks like your best agent', text: 'Natural, short answers in the caller\'s language, with a pause to think that sounds like a person checking, not a machine.',
        points: ['Telugu, Hindi, Tamil, Kannada and English, switching when the caller does', 'Greets with your company name and the agent name you choose', 'Taught by your team in plain words: products, policies, branch hours, common answers'] },
      { title: 'Careful with account details', text: 'It checks who is calling before it shares anything personal, the way your policy says.',
        points: ['The checks you choose, such as date of birth and part of an account number', 'Looks up only what you connect it to', 'Personal values masked in what your team reads later'] },
      { title: 'Every conversation becomes work', text: 'Nothing is lost between a chat, a call and a ticket.',
        points: ['A ticket with a summary, the full conversation and, for calls, the recording', 'Lands in the operations desk with its service level running', 'Your team is alerted when someone asks for a person'] },
      { title: 'WhatsApp, team by team', text: 'Each support team connects its own business number and works its own inbox.',
        points: ['Answers first from what you already know', 'Take over a chat, reply, raise a ticket or close it from one screen', 'Chats are stored encrypted'] },
    ],
    related: ['/features/operations/', '/pricing/'],
  },
  {
    path: '/features/operations/', title: 'Operations Desk with Service Levels | Project Tracker', h1: 'A support desk that warns you before a promise is broken',
    lead: 'Tickets, bugs and requests in one queue, with targets that count working hours, a board for the day\'s work and insights on what keeps coming back.',
    description: 'Run support and operational work in Project Tracker: a queue and board, response and resolution targets in working hours, triage suggestions, insights, CSV and PDF exports, and tickets from calls and WhatsApp.',
    sections: [
      { title: 'One queue, one board', text: 'Everything that needs doing, whichever door it came through.',
        points: ['A queue with quick views, filters and bulk changes', 'A board you drag work across as it moves', 'Tickets from people, from calls and from WhatsApp in the same place'] },
      { title: 'Service levels that count properly', text: 'Response and resolution targets by priority, measured in your working hours and holidays.',
        points: ['A warning before a target is missed, not after', 'Business plan and above'] },
      { title: 'Know what keeps coming back', text: 'Insights show volume, speed and the causes behind repeat work.',
        points: ['Resolution notes that become answers for next time', 'Suggestions for type, priority and who should take it', 'Export to CSV, Excel or PDF'] },
    ],
    related: ['/features/ai-employee/', '/features/timesheets-and-workload/'],
  },
  {
    path: '/features/doctracker/', title: 'DocTracker: API Documentation and Architecture | Project Tracker', h1: 'API documentation your team will actually keep up to date',
    lead: 'Every project\'s APIs, architecture and documents in one place, scored for completeness, drawn on a canvas and protected by default.',
    description: 'DocTracker in Project Tracker: API documentation with a completeness score, OpenAPI and Postman import and export, a read-only Swagger view, architecture diagrams, masked sensitive values with audited reveal, approvals and PDF.',
    sections: [
      { title: 'A score that shows what is missing', text: 'Each endpoint is checked for the things a caller needs, and the gaps are listed so fixing them is quick.',
        points: ['A Control Center across every project', 'The weakest endpoints first', 'Import from OpenAPI, Postman or cURL; export the same'] },
      { title: 'Architecture you can see', text: 'Draw systems and request flows on a canvas with a library of components, and keep them beside the APIs they explain.',
        points: ['Templates to start from', 'Picture and file export', 'Per project, with notes'] },
      { title: 'Protected by default', text: 'Mobile numbers, IDs, account numbers and credentials are hidden before they leave the server.',
        points: ['Reveal for a few seconds with a reason', 'Every reveal recorded', 'Rules you can add for your own fields'] },
      { title: 'Ready for review', text: 'Versions, approvals and a printable copy when someone outside needs it.',
        points: ['Compare any two versions, with breaking changes called out', 'Approvals before publishing', 'PDF with a cover and contents'] },
    ],
    related: ['/features/operations/', '/security/'],
  },
  {
    path: '/features/meeting-notetaker/', title: 'AI Meeting Notetaker and Minutes | Project Tracker', h1: 'Minutes you do not have to write',
    lead: 'Send the notetaker to your call. Afterwards you get the summary, the decisions and the action items with owners and dates.',
    description: 'An AI meeting notetaker in Project Tracker: joins the call, writes minutes with decisions and action items, so nothing agreed is forgotten.',
    sections: [
      { title: 'Joins when you ask', text: 'Send it to the meeting link; it asks to be let in like any guest.',
        points: ['Works with the online meetings your team already holds', 'Shows who it is, so nobody is surprised', 'Leaves when the meeting ends'] },
      { title: 'Minutes worth reading', text: 'Short, concrete and based only on what was said.',
        points: ['Summary, decisions, risks and next meeting', 'Action items with owner and due date', 'Action items ready to become tasks on the project'] },
    ],
    related: ['/features/ai-assistant/', '/pricing/'],
  },
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

/** Pages written for what people search for ("project tracker", "project management software India"). Statements stay true of the product. */
DETAILS.push(
  {
    path: '/solutions/free-project-tracker/', title: 'Free Online Project Tracker for Teams | Project Tracker', h1: 'A free online project tracker that grows with your team',
    lead: 'Track projects, tasks, deadlines and time in one place. Start free in a minute, with no card, and move up only when your team needs more.',
    description: 'Project Tracker is a free online project tracker: projects, tasks, boards, timelines, reminders, a calendar and timesheets. Free for one person forever; Pro and Business for teams, priced per person in rupees.',
    sections: [
      { title: 'Everything you need to track a project', text: 'From the first task to the final hand-over, without spreadsheets.',
        points: ['Projects with tasks, owners, priorities and due dates', 'Boards, lists, timelines and a portfolio view across projects', 'Reminders and a calendar, so nothing is forgotten', 'Timesheets to log time against the work'] },
      { title: 'Free, for good', text: 'The Free plan is for one person and never expires.',
        points: ['5 projects, 500 tasks and 500 MB of files', 'Reminders, calendar, timesheets and the portfolio view', 'Ten quick AI answers a month to try the assistant', 'Passkeys and two-step sign-in included'] },
      { title: 'When your team joins', text: 'Pro and Business add people, unlimited projects and the tools teams rely on.',
        points: ['Pro: unlimited projects and tasks, custom workflows, advanced reports, mobile and desktop apps', 'Business: an operations desk with service levels and an AI employee for calls and WhatsApp', 'A 14-day trial of either, with no payment taken'] },
      { title: 'Safe from day one', text: 'The same protection on every plan.',
        points: ['Each organization\u2019s data kept separate in the data layer', 'Hosted in India on Google Cloud, with daily backups', 'Export everything as files at any time'] },
    ],
    related: ['/pricing/', '/features/'],
  },
  {
    path: '/solutions/project-management-software-india/', title: 'Project Management Software for Indian Teams | Project Tracker', h1: 'Project management software built for teams in India',
    lead: 'Plans in rupees, data kept in India, and an AI employee that speaks your customers\u2019 languages. Projects, support and documentation in one workspace.',
    description: 'Project management software for Indian businesses: priced in rupees with invoices that carry your GSTIN, hosted in Mumbai on Google Cloud, an AI employee that answers in Telugu, Hindi, Tamil, Kannada and English, and an operations desk with service levels.',
    sections: [
      { title: 'Priced and billed for India', text: 'Per-person plans in Indian rupees, with discounts for yearly billing and larger teams.',
        points: ['Pro at \u20b9449 and Business at \u20b9999 per person per month', '20% off yearly, and up to 20% more for teams of 10, 25 or 100 people', 'Prices exclude GST; every payment gets an invoice that can carry your GSTIN'] },
      { title: 'Your data stays in India', text: 'The app, its database, files and backups run on Google Cloud in Mumbai.',
        points: ['The AI assistant runs on Google Gemini in the same region', 'Encrypted traffic, daily backups kept for 14 days', 'Export everything at any time'] },
      { title: 'Speaks your customers\u2019 languages', text: 'The AI employee answers calls and WhatsApp in the language the customer uses.',
        points: ['Telugu, Hindi, Tamil, Kannada and English', 'Checks who is calling before sharing anything personal', 'Every conversation becomes a ticket with the full record'] },
      { title: 'One workspace for delivery and support', text: 'No stitching tools together.',
        points: ['Projects, timelines, timesheets and workload', 'An operations desk with service levels in your working hours and holidays', 'DocTracker for APIs, architecture and documents'] },
    ],
    related: ['/features/ai-employee/', '/pricing/'],
  },
);

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
  { group: 'Support and operations', rows: [
    { label: 'Operations queue and board', v: ['✓', '✓', '✓', '✓'] },
    { label: 'Service levels in working hours', v: ['–', '–', '✓', '✓'] },
    { label: 'AI employee for calls and WhatsApp', v: ['Try it', 'On your credits', '✓', 'Sized to your contract'] },
    { label: 'WhatsApp numbers per team, shared inbox', v: ['✓', '✓', '✓', '✓'] },
    { label: 'Meeting notetaker and minutes', v: ['Try it', '✓', '✓', '✓'] },
    { label: 'DocTracker: score, Swagger view, architecture', v: ['✓', '✓', '✓', '✓'] },
    { label: 'Connect Claude and ChatGPT', v: ['✓', '✓', '✓', '✓'] },
    { label: 'Masked values with a reveal you set', v: ['Masked', 'Masked', 'Reveal timer and audit check', '✓'] },
  ] },
  { group: 'Intelligence', rows: [
    { label: 'AI assistant', v: ['Try it', 'Quick and Standard', 'Quick, Standard and Deep', 'All levels'] },
    { label: 'AI credits each month', v: ['10', '80 per person', '300 per person', 'A shared pool'] },
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
  { q: 'What is an AI credit?', a: 'A unit of AI use. A quick answer costs 1 credit, a standard answer 4 and a deep analysis 20; a spoken reply from the AI employee costs 2, and the notetaker a little for each hour it sits in a call. Each person on Pro brings 80 credits a month and each person on Business 300, pooled across the team and renewed on the 1st. When the pool runs out the AI waits until the next month; nothing else is affected.' },
  { q: 'Can I use Project Tracker from Claude or ChatGPT?', a: 'Yes, on every plan. Add Project Tracker as a connector in Claude or ChatGPT, sign in, choose the workspace and whether it may make changes. It works with your own permissions, and you can disconnect it at any time from Settings, Connected apps.' },
  { q: 'Who pays for phone calls and WhatsApp messages?', a: 'Your phone and WhatsApp providers bill you directly for calls and conversations, at their own rates, on the accounts you connect. We charge only the AI credits the AI employee uses.' },
  { q: 'Can the AI employee speak our customers\' language?', a: 'Yes. It answers in Telugu, Hindi, Tamil, Kannada and English, and follows the caller when they switch. You choose which languages it uses and which one it greets in.' },
  { q: 'Is there a free trial of the paid plans?', a: 'Yes. Start a 14-day trial of Pro or Business from Settings, Billing: up to 5 people and 100 AI credits, no payment taken.' },
  { q: 'Can I change plans or the number of people later?', a: 'Yes. An owner changes the plan, the number of seats and monthly or yearly billing under Settings, Billing. Adding seats works at once; the new amount starts at your next renewal, so nothing is charged twice.' },
  { q: 'Does the assistant change my projects by itself?', a: 'No. It answers from the projects you can open and proposes changes. Nothing happens until you confirm it.' },
  { q: 'Can teams keep their projects private from each other?', a: 'Yes. Choose team-only visibility and each person sees the projects of their teams, plus the ones they own or were added to. Owners and admins see everything; guests only the projects they are added to.' },
  { q: 'How is each organization\'s data kept separate?', a: 'In the data layer itself, not only in the screens, and automated tests check every screen for leaks between organizations, teams and roles.' },
  { q: 'What is a passkey, and do I need a paid plan?', a: 'A passkey lets you sign in with your fingerprint, face or screen lock instead of a password. It works only on this site and cannot be phished. Passkeys are on every plan, including Free.' },
  { q: 'Is there a mobile app?', a: 'Yes, from the Pro plan: install Project Tracker on your phone from Account, Mobile app, get alerts when it is closed, and sign in on a computer by tapping a number on your phone. No password to type.' },
  { q: 'Where is our data stored?', a: 'In India. The app, its database, your files, call recordings and backups run on Google Cloud in Mumbai, and the AI assistant runs on Google Gemini in the same region. Traffic is encrypted, and backups are taken daily and kept for 14 days.' },
  { q: 'Can I take my data with me?', a: 'Yes. Owners can export everything as files in one zip at any time, and set how long history is kept.' },
  { q: 'Does it support single sign-on?', a: 'Yes, on Business and Enterprise: OpenID Connect and SAML 2.0, with SCIM provisioning to add and remove people automatically.' },
];
