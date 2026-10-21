/**
 * The Help Center (/docs/) and the Blog (/blog/): plain pages search engines index and people can link to. Every statement describes what
 * the product does today; change a guide together with the feature it explains.
 */
import type { StaticPage } from './content';

export interface Block { h?: string; p?: string; list?: string[]; steps?: string[]; tip?: string }
export interface LibraryPage extends StaticPage { kind: 'guide' | 'article'; date: string; minutes: number; topic: string; blocks: Block[]; related: string[] }

const D = '2026-10-21';

export const GUIDES: LibraryPage[] = [
  {
    kind: 'guide', topic: 'Getting started', date: D, minutes: 4, path: '/docs/getting-started/',
    title: 'Getting Started with Project Tracker | Help Center', h1: 'Getting started in ten minutes',
    lead: 'Create your workspace, invite your team and run your first project.',
    description: 'Set up Project Tracker: create an organization workspace, invite people with the right role, create your first project and tasks, and install the app on your phone.',
    blocks: [
      { h: '1. Create your account and workspace', steps: ['Go to projecttracker.in and choose Create your free account.', 'Confirm your e-mail address from the message we send you.', 'Create an organization workspace for your company. Your personal workspace stays separate.'] },
      { h: '2. Invite your team', steps: ['Open People and choose Invite member.', 'Enter their e-mail address and pick a role: Admin, Manager, Member or Guest.', 'If you use job roles, pick the person\'s job role and who they report to; their access applies from their first sign-in.'],
        tip: 'Invitations are tied to the e-mail address and expire, so a forwarded link cannot be used by someone else.' },
      { h: '3. Create your first project', steps: ['Open Projects and create a project. Choose a project group (every project belongs to one).', 'Add tasks with an owner, priority and due date, or import them from a spreadsheet.', 'Switch between the list, board and timeline views; the project status page shows progress at a glance.'] },
      { h: '4. Stay on top of the work', list: ['Home shows what is due today and your open work across projects.', 'Reminders understand plain words such as "call Priya tomorrow 3pm".', 'On Pro and above, install the app on your phone from Account, Mobile app, to get alerts when it is closed.'] },
    ],
    related: ['/docs/import-from-spreadsheet/', '/docs/secure-your-workspace/'],
  },
  {
    kind: 'guide', topic: 'Projects', date: D, minutes: 3, path: '/docs/import-from-spreadsheet/',
    title: 'Import Tasks from Excel or CSV | Help Center', h1: 'Import tasks from a spreadsheet',
    lead: 'Bring an existing plan from Excel or Google Sheets into a project, and see every problem before anything is saved.',
    description: 'Import tasks into Project Tracker from a CSV file exported from Excel or Google Sheets: match columns, check every row before saving, and choose all-or-nothing or skip bad rows.',
    blocks: [
      { h: 'Prepare the file', list: ['Save your sheet as CSV (comma, semicolon or tab separated, UTF-8). Up to 5,000 rows or 2 MB.', 'Useful columns: Title, Description, Status, Priority, Assignee, Start date, Due date, Estimated hours, Labels and Milestone.', 'Assignees are matched by e-mail address or full name; priorities can use your own custom names.'] },
      { h: 'Import it', steps: ['Open the project and choose Import.', 'Pick the file. Columns are matched from their header names; adjust any that are wrong.', 'Choose whether dates are day-first (21/10/2026) or month-first.', 'Review the check: how many rows are ready, and exactly which rows have which problem.', 'Import all or nothing, or skip the rows with problems and import the rest.'] },
      { tip: 'Nothing is written until you confirm, so you can fix the sheet and try again as often as you like.' },
    ],
    related: ['/docs/getting-started/', '/solutions/free-project-tracker/'],
  },
  {
    kind: 'guide', topic: 'Time', date: D, minutes: 4, path: '/docs/timesheets/',
    title: 'Track Time and Submit Timesheets | Help Center', h1: 'Track time and submit your timesheet',
    lead: 'Log time against tasks, keep billable hours separate and get your week approved.',
    description: 'How to track time in Project Tracker: start a timer or log time by hand, mark time billable, submit a weekly timesheet and approve or return timesheets as a manager.',
    blocks: [
      { h: 'Log time', list: ['Start the timer on any task, or type the time by hand: "1h 30m", "45m" or "1.5h".', 'One timer runs at a time; starting another stops the first. The running timer stays visible in the top bar.', 'A task\'s actual hours always equal the time tracked on it.'] },
      { h: 'Billable time', p: 'Every entry is billable or not. It starts from the project\'s Billable to a client setting and you can change it per entry.' },
      { h: 'Submit your week', steps: ['Open Timesheet, then My time.', 'Check the Monday to Sunday week and add a note if needed.', 'Submit. Your manager is told; if nobody is above you, the owner and admins are.'] },
      { h: 'Approve as a manager', list: ['Timesheet, Approvals lists everyone you review for a week with their hours and status.', 'Approve, or return the week with a reason. An approved week can be reopened.', 'A submitted or approved week is locked, so hours cannot change after approval.'] },
    ],
    related: ['/features/timesheets-and-workload/', '/blog/timesheets-people-actually-fill-in/'],
  },
  {
    kind: 'guide', topic: 'Operations', date: D, minutes: 4, path: '/docs/service-levels/',
    title: 'Set Up Service Levels (SLA) | Help Center', h1: 'Set up service levels for support work',
    lead: 'Give every ticket a response and resolution target, and see what is at risk before it is breached.',
    description: 'Configure SLA targets in Project Tracker: first-response and resolution targets by priority and work type, how the clocks run, on-hold time, and reports on compliance.',
    blocks: [
      { h: 'Set the targets', steps: ['Open Settings, Work types, Service levels.', 'Enter first-response and resolution targets for each priority, such as "30m", "4h" or "3d".', 'Optionally set different targets for a work type, such as incidents or access requests.'] },
      { h: 'How the clocks run', list: ['Targets are fixed when a ticket is raised, and again if its priority or type changes.', 'Response is met when someone moves it out of To Do, or comments when they did not raise it.', 'Resolution is met when it is completed. On Hold stops the resolution clock and the time is added back.', 'Cancelled work counts neither way.'] },
      { h: 'Watch and report', list: ['Operations shows a live SLA column, with filters for at risk and breached.', 'Each ticket shows both clocks.', 'Operations analytics shows compliance over time.'] },
      { tip: 'Service levels are part of the Business plan.' },
    ],
    related: ['/features/operations/', '/blog/sla-targets-for-support-teams/'],
  },
  {
    kind: 'guide', topic: 'AI', date: D, minutes: 3, path: '/docs/connect-claude-chatgpt/',
    title: 'Connect Claude or ChatGPT | Help Center', h1: 'Connect Claude or ChatGPT to your workspace',
    lead: 'Ask about your projects in the AI assistant you already use, with your own permissions.',
    description: 'Step-by-step: add Project Tracker as a connector in Claude or ChatGPT, choose read-only or read-and-change access, and disconnect it any time from Connected apps.',
    blocks: [
      { h: 'In Claude', steps: ['Open Settings, Connectors, and add a custom connector.', 'Use the address https://projecttracker.in/api/v1/mcp', 'Sign in to Project Tracker when asked, choose the workspace and the access.'] },
      { h: 'In ChatGPT', steps: ['Open Settings, Apps and connectors, and add a connector with sign-in.', 'Use the same address: https://projecttracker.in/api/v1/mcp', 'Sign in, choose the workspace and the access.'] },
      { h: 'Read only, or read and change', p: 'Read only lets it find and summarise projects, tasks, your work, support tickets and API documentation. Read and change also lets it create tasks and work items, change status, comment and log time. It always acts as you, with your role and permissions.' },
      { h: 'Turn it off', p: 'Settings, Connected apps lists every app you connected. Disconnect stops it at once.' },
    ],
    related: ['/features/connect-ai/', '/blog/use-ai-assistants-with-project-data-safely/'],
  },
  {
    kind: 'guide', topic: 'Security', date: D, minutes: 4, path: '/docs/secure-your-workspace/',
    title: 'Secure Your Workspace | Help Center', h1: 'Secure your workspace',
    lead: 'Passkeys, two-step verification, roles and single sign-on: the settings worth turning on first.',
    description: 'A security checklist for Project Tracker admins: passkeys and two-step verification, requiring them for everyone, roles and team-only visibility, single sign-on, IP allowlists and the audit log.',
    blocks: [
      { h: 'For everyone', list: ['Add a passkey (fingerprint, face or screen lock) in Account, Sign-in and security. It cannot be phished.', 'Or turn on two-step verification with an authenticator app, and keep the recovery codes safe.', 'Review the devices you are signed in on and sign out the ones you do not recognise.'] },
      { h: 'For admins', list: ['Require two-step verification for the whole organization.', 'Give people the lowest role that lets them work: Guest, Member, Manager, Admin.', 'Use team-only project visibility so teams see their own projects.', 'On Business: single sign-on (OpenID Connect or SAML), SCIM provisioning, an IP allowlist, and the audit log of sign-ins and permission changes.'] },
      { h: 'Your data', list: ['Hosted in India on Google Cloud (Mumbai), with daily backups kept 14 days.', 'Owners can export everything as files at any time.', 'Anyone can ask for their account to be deleted from Account, Profile.'] },
    ],
    related: ['/security/', '/delete-account/'],
  },
];

export const ARTICLES: LibraryPage[] = [
  {
    kind: 'article', topic: 'Project management', date: D, minutes: 6, path: '/blog/move-projects-off-spreadsheets/',
    title: 'Moving Your Projects Off Spreadsheets: A Practical Guide | Project Tracker Blog', h1: 'Moving your projects off spreadsheets',
    lead: 'Spreadsheets are a fine way to start a plan and a hard way to run one. Here is how to move without stopping the work.',
    description: 'When a project spreadsheet stops working, and how to move to a project tracker in a week: what to import, what to leave behind, and the habits that make the switch stick.',
    blocks: [
      { p: 'Most teams in India run their first projects from a shared Excel or Google Sheet. It is quick, everyone knows it, and it costs nothing. The trouble starts as the team grows: three copies of the file, a date that changed with no record of why, and a Monday meeting spent finding out who is doing what.' },
      { h: 'Signs the spreadsheet has outgrown you', list: ['People ask for status in chat instead of looking it up.', 'Nobody can tell why a due date moved, or who moved it.', 'Different teams need to see different projects, but the file is all or nothing.', 'Reminders and follow-ups live in someone\'s head.'] },
      { h: 'Move in a week, not a quarter', steps: ['Day 1: pick one live project, not the whole portfolio.', 'Day 2: import its open tasks from the sheet. Leave finished rows behind; the sheet stays as the archive.', 'Day 3: agree on statuses and priorities, and give every task one owner and a due date.', 'Day 4: move the weekly status meeting onto the project\'s board.', 'Day 5: add the next project, and stop updating the old sheet.'] },
      { h: 'Habits that make it stick', list: ['Update the task, not the chat. Comments on the task keep the reason with the work.', 'Let reminders do the chasing, in each person\'s own working hours.', 'Look at the portfolio view weekly, not every project every day.'] },
      { p: 'Project Tracker imports a CSV straight from Excel or Google Sheets and checks every row before anything is saved. The Free plan is enough to try it on one project.' },
    ],
    related: ['/docs/import-from-spreadsheet/', '/solutions/free-project-tracker/'],
  },
  {
    kind: 'article', topic: 'Support operations', date: D, minutes: 6, path: '/blog/sla-targets-for-support-teams/',
    title: 'SLA Targets for Support Teams: How to Set Ones That Work | Project Tracker Blog', h1: 'Service level targets that support teams can keep',
    lead: 'A service level is a promise. Set it from what your team can do, measure it honestly, and see the risk before the promise is broken.',
    description: 'How to choose first-response and resolution targets by priority, what should pause the clock, and how to spot tickets at risk before an SLA breach.',
    blocks: [
      { p: 'Service level agreements often start as numbers someone wrote into a contract. Teams then spend their days racing the clock instead of solving problems. Good targets work the other way round: they start from what the team can reliably deliver.' },
      { h: 'Two clocks, not one', list: ['First response: how quickly a person acknowledges the ticket and starts on it.', 'Resolution: how quickly the problem is actually solved.', 'Keep them separate. A fast reply that solves nothing should not count as good service.'] },
      { h: 'Set targets by priority', p: 'Look at the last month of tickets. For each priority, find the time within which most were answered and solved today, then set the target slightly tighter. A target the team misses every day teaches everyone to ignore it.' },
      { h: 'Decide what pauses the clock', p: 'Waiting for the customer to reply is not time the team can use. Put such tickets on hold so the resolution clock stops, and resumes when they come back.' },
      { h: 'Act before the breach', list: ['Review at-risk tickets at the start of each shift, not breached ones at the end of the month.', 'Look at what keeps coming back; repeat tickets are where time is lost.', 'Write the resolution down so the next person solves it faster.'] },
      { p: 'In Project Tracker, the operations desk runs both clocks, pauses resolution on hold and filters at-risk work, as part of the Business plan.' },
    ],
    related: ['/docs/service-levels/', '/features/operations/'],
  },
  {
    kind: 'article', topic: 'Time tracking', date: D, minutes: 5, path: '/blog/timesheets-people-actually-fill-in/',
    title: 'Timesheets People Actually Fill In | Project Tracker Blog', h1: 'Timesheets people actually fill in',
    lead: 'Most timesheets are filled in on Friday evening from memory. A few changes make them accurate without making them a chore.',
    description: 'Why timesheets go wrong and how to fix them: log time against the work itself, keep billable time visible, make the weekly submission short and approval quick.',
    blocks: [
      { h: 'Why timesheets go wrong', list: ['They live apart from the work, so filling them in means remembering the week.', 'Every entry needs too many fields.', 'Nobody looks at them until billing day, so nobody trusts them.'] },
      { h: 'Log time where the work is', p: 'A timer on the task, or a quick "1h 30m" typed against it, takes seconds when it happens and is accurate. The week\'s timesheet then fills itself in.' },
      { h: 'Make billable time obvious', p: 'Decide per project whether time is billable to a client, and let people change it per entry when needed. Then billing is a report, not a negotiation.' },
      { h: 'Keep the weekly step small', steps: ['People check their week and submit it with an optional note.', 'Managers approve, or return it with a reason.', 'Approved weeks are locked, so reports do not change after the fact.'] },
      { p: 'Project Tracker\'s timesheets work this way on every plan, and a weekly reminder ("every Friday 4pm submit timesheet") takes one line to set up.' },
    ],
    related: ['/docs/timesheets/', '/features/timesheets-and-workload/'],
  },
  {
    kind: 'article', topic: 'AI', date: D, minutes: 5, path: '/blog/use-ai-assistants-with-project-data-safely/',
    title: 'Using AI Assistants with Your Project Data, Safely | Project Tracker Blog', h1: 'Using AI assistants with your project data, safely',
    lead: 'Claude and ChatGPT can answer "what is late this week?" in seconds. The question is how to let them see your work without giving away more than you mean to.',
    description: 'How to connect AI assistants like Claude and ChatGPT to project data safely: sign-in instead of shared keys, the assistant acting with your own permissions, read-only by default and a way to switch it off.',
    blocks: [
      { p: 'Copying project updates into a chat window works once. Done every day, it spreads company data across personal chats with no record of what went where. A proper connection is safer and less work.' },
      { h: 'Four things to insist on', list: ['Sign-in, not a shared key: each person connects as themselves and can be switched off alone.', 'Your permissions, never more: the assistant sees only what you could open yourself.', 'Read only by default: allow changes only when you want it to create tasks or update status.', 'A list of connected apps you can review and disconnect at any time.'] },
      { h: 'Good first questions', list: ['"What is overdue for me this week, by project?"', '"Summarise what changed in the Customer portal project since Monday."', '"Which support tickets are close to missing their target?"'] },
      { p: 'Project Tracker connects to Claude and ChatGPT on every plan, including Free, and works this way.' },
    ],
    related: ['/docs/connect-claude-chatgpt/', '/features/connect-ai/'],
  },
  {
    kind: 'article', topic: 'Data and security', date: D, minutes: 5, path: '/blog/project-data-hosted-in-india/',
    title: 'Why We Host Your Project Data in India | Project Tracker Blog', h1: 'Why we host your project data in India',
    lead: 'Project Tracker now runs on Google Cloud in Mumbai. What that means for speed, for your customers\' trust and for your own questionnaires.',
    description: 'Project Tracker is hosted in India on Google Cloud (Mumbai): the app, database, files, backups and AI assistant. What moved, what it means for latency and security reviews, and what stays the same.',
    blocks: [
      { h: 'What runs in Mumbai', list: ['The application and its database, with daily backups kept for 14 days and point-in-time recovery.', 'Uploaded files and call recordings.', 'The AI assistant, which uses Google Gemini in the same region.'] },
      { h: 'Why it matters', list: ['Speed: pages and the mobile app answer from close by for teams in India.', 'Simpler security reviews: "where is our data stored?" has a one-line answer.', 'Trust: many of our customers handle their own customers\' details, and want them kept close to home.'] },
      { h: 'What stays the same', list: ['Your address, sign-in and data: nothing to change on your side.', 'Encrypted connections, workspace isolation and the audit log.', 'Some services you choose to connect, such as e-mail delivery or push notifications, may process data outside India; our privacy policy lists them.'] },
      { p: 'Questions about where your data is kept? Write to support@projecttracker.in.' },
    ],
    related: ['/security/', '/docs/secure-your-workspace/'],
  },
];

export const LIBRARY = [...GUIDES, ...ARTICLES];

export const DOCS_INDEX: StaticPage = { path: '/docs/', title: 'Help Center | Project Tracker', h1: 'Help Center', lead: 'Short, step-by-step guides to get the most out of Project Tracker.',
  description: 'Project Tracker Help Center: getting started, importing tasks, timesheets, service levels, connecting Claude or ChatGPT, and securing your workspace.' };
export const BLOG_INDEX: StaticPage = { path: '/blog/', title: 'Blog | Project Tracker', h1: 'The Project Tracker blog', lead: 'Practical writing on running projects, support and teams, from the people who build Project Tracker.',
  description: 'Articles on project management, support service levels, timesheets, using AI assistants safely and hosting data in India.' };
