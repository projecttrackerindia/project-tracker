# FiveStar v2 — implementation plan (one release)

Source of truth for *what*: `docs/V2-SPEC.md` (the redesign spec) and the v2 screen PDF. This file is the *how*: the contracts every
builder works to, so parallel work fits together. Decisions taken by the owner (27 Oct 2026):

- Everything ships in **one release**.
- Removed pages: **Agents, Meet, Mailbox, Reminders, Resume studio, Customize sidebar** (their useful parts move as the spec says).
- **Full table migration**: tasks, issues, action items and tickets become **one physical table `WorkItems`**.
- **One AI model for the workspace: the organisation's own Claude key** (Gemini only as the fallback when the key cannot answer).

## 1. Navigation and routes

Left rail (84px, icon above a short label, fixed — no customize): logo · **+ New** (blue circle) · Home · Work · Talk · Library ·
Insights · avatar at the bottom (menu: Profile, Settings, People, Sign out, theme). Phone: bottom tab bar with the same five + New.

| Place | Route | Tabs (segmented, top right) | Replaces |
|---|---|---|---|
| Home | `/` | For you · Calendar | Home, Command center, Agents › Ask/Proposals, Reminders page, Calendar |
| Work | `/work` | My work · Team · Tickets · Projects › | My work, Operations, project task lists, Workload drill-down |
| Projects | `/work/projects` | Projects · Portfolio | Projects, Portfolio |
| Project | `/work/projects/:id` | Overview · Work · Docs · Time · Activity | 11 project tabs |
| Talk | `/talk` | filters All · Chat · Mail · Meetings | Chat, Mailbox, Meet, Notetaker |
| Library | `/library` | Docs · Vault | DocTracker, Documents, project Docs/Files, Vault |
| Insights | `/insights` | Overview · Time · Reports | Workload, Reports, Operations › Insights, Timesheet, Agents › Workflows |
| People | `/people` | Directory · Teams · Org chart | People, Teams, Org chart |
| Settings | `/settings/:section` | 10 sections (below) | ~30 settings pages + My account |

Item deep links: `/work?item=<id>` opens the Work side panel; `/talk/:conversationId`; `/library/docs/:id`; `/library/vault/:id`.
Every old route redirects (client `Navigate` with `replace`, keeping query and hash): `/projects*` → `/work/projects*`,
`/operations*` → `/work?tab=tickets`, `/my-work` → `/work`, `/chat*` → `/talk*`, `/mailbox` → `/talk?f=mail`, `/meet*` → `/talk?f=meetings`,
`/calendar` → `/?tab=calendar`, `/reminders` → `/`, `/ai*`, `/agents*`, `/project-agent*` → `/` (Workflows → `/insights`,
Tracker → `/settings/ai`), `/doctracker*` and `/documents*` → `/library/docs*`, `/vault*` → `/library/vault*`, `/timesheet*` → `/insights?tab=time`,
`/workload`, `/reports*`, `/portfolio*` → `/insights` / `/work/projects?view=portfolio`, `/account*` → `/settings/profile`,
`/account/resumes` → `/settings/profile`, `/notifications*` → `/settings/notifications`. Old links in e-mails, notifications and the AI
keep working through these redirects; new links use the new routes.

Settings sections: **You** — `profile` (Profile & sign-in, mobile app, connected accounts, assistant preferences), `notifications`.
**Workspace** — `general`, `people`, `fields` (fields & types, labels, priorities, work types), `timelines` (timeline templates,
project groups, automation), `security` (sign-in rules, SSO, roles & access, audit), `integrations` (Slack, WhatsApp, GitHub, webhooks,
API keys, mail servers, MCP address), `ai` (AI control centre), `billing`.

## 2. Unified WorkItem (backend)

One physical table **`WorkItems`**, EF Core **table-per-hierarchy**: abstract base `WorkItem` with discriminator column `Kind`
(`Task` | `Issue` | `ActionItem` | `Ticket`). Existing CLR types become subclasses so the ~200 files that use them keep compiling:
`TaskItem : WorkItem` (Task), `StageIssue : WorkItem` (Issue), `WorkTask : WorkItem` with `WorkTaskKind` mapped to `ActionItem` / `Ticket`
(WorkTask's `Operational` = Ticket). Shared columns live on the base: `Id, TenantId, Kind, Number, Key, Title, Description, ProjectId?,
AssigneeId?, ReporterId?, Priority, StartDate?, DueDate?, CompletedAt?, Version, IsDeleted, DeletedAt, DeletedBy, CreatedAt/By,
UpdatedAt/By`. Kind-specific columns stay on the subclass (status representations, SLA fields, resolution fields, stage id, sprint,
estimates); where two kinds hold the same concept with different types, they keep separate columns (named per kind) rather than
being forced together.

Child tables merge the same way where they are per-kind today: comments → `WorkItemComments`, attachments → `WorkItemAttachments`
(each row carries `WorkItemId`). Foreign keys from other tables (dependencies, time entries, reminders, notifications, documents,
AI references, agent findings, meeting links) are re-pointed to `WorkItems(Id)`. IDs are kept, so links, keys (`PAY-12`, `WT-5`,
`FSRD-2`) and history stay valid.

**Migration** (one EF migration, hand-checked SQL, idempotent guards): create `WorkItems` + merged child tables → `INSERT … SELECT`
from `TaskItems`, `WorkTasks`, `StageIssues` and their child tables (IDs preserved, Kind set) → re-point FKs → rename the old tables to
`legacy_TaskItems`, `legacy_WorkTasks`, `legacy_StageIssues` (kept one release for rollback, then dropped by a later migration) →
row-count assertions (the migration fails if counts differ). A Cloud SQL on-demand backup is taken right before the release.
Tests: a migration test seeds all three old shapes, runs the migration, and checks every row, key, comment, attachment, time entry
and link; the full backend suite must pass.

**API** (`/api/v1/work-items`): `GET` list (filters: mine, team, kind, project, status, overdue, q; group/sort; paging), `GET /{id}`
(item + one merged **activity stream**: comments, time logs, files, field changes, AI actions), `POST` (kind + fields; also used by + New),
`PATCH /{id}` (any field, optimistic `version`, saves as you go), `POST /{id}/comments` (a comment like "log 2h" also logs time),
`DELETE /{id}`. Old per-kind endpoints stay as thin wrappers for one release (mobile apps, MCP, integrations).

## 3. Other backend contracts

- **Inbox** `GET /api/v1/inbox?filter=all|assigned|decisions|mentions` → rows `{ id, kind: ticket|decision|approval|task|mention|reminder|access|review,
  title, sub, action: {label, verb}, href, at }`, built from existing sources (assigned/overdue work, agent proposals, timesheet and vault
  access approvals, mentions, due reminders, doc reviews). `POST /api/v1/inbox/{id}/later` snoozes a row; the row's action calls the
  existing endpoint. Briefing `GET /api/v1/inbox/briefing` → `{ count, headline, reasons[], sources }` (rules first; AI only to phrase it).
- **Talk** `GET /api/v1/talk/conversations?f=all|chat|mail|meetings` merges chat conversations, mail threads (when a mailbox is connected)
  and meetings into one list `{ id, kind, title, last, at, unread, avatar }`. Threads keep their existing endpoints.
- **Reminders** stay as data (they are work for the inbox); remove the 4 automatic reminders per ticket (due, +1, +3, +7) in favour of
  **one escalating nudge** (due, then one follow-up when still open the next working day).
- **AI control centre**: per-agent level `Off | Suggest | Ask first | Auto` for Project agent, Meeting notetaker, Mail agent, Ticket triage,
  Timesheet helper (stored per workspace; "Ask first" puts the agent's work in the inbox); **workspace model**: own Claude key for everyone
  who agrees (Gemini only as fallback); **organisation context** ("Teach it about FiveStar", 4,000 chars, with "Draft it from my projects");
  answer-success and credits figures from existing telemetry. The agent tracker moves here.
- **AI action log**: every AI change records `{agent, action, target, approvedBy, at}` and shows in the item's Activity.

## 4. Frontend contracts

Design system: `src/styles/design-system.css` (tokens, components), primitives in `src/components/ui.tsx` (`PageHead` with eyebrow,
`Segmented`, `Kpi`, `Ring`, `StatusBar`). New shared pieces (owned by the shell builder): `Rail`, `NewSheet` (+ New), `AskBar` (⌘K;
on a project it becomes "Ask about <project>" opening a copilot side panel), `SidePanel` (right panel, saves as you go, no Save/Cancel
footer), `InboxRow`, `AiCard` (violet ✦ suggestion with one action). Violet `#5E5CE6` is used **only** for AI. Filters show only when a
list has more than 10 items. Tabs never navigate to another place (a link with › does). Nothing covers content (hover actions sit beside).

## 5. Build waves

1. **Foundations (parallel)**: A) WorkItem table merge + migration + API (backend). B) Shell: rail, + New, Ask bar, side panel, routes and
   redirects, page removals, Settings 10 sections + AI control centre. C) Home inbox + briefing + Calendar week, Time, Insights.
   D) Talk + Library (Docs list, Vault fields + Share).
2. **Work**: Work list + side panel on the new API, Projects/Portfolio, Project page (5 tabs), + New wired to `POST /work-items`.
3. **Integration**: merge, full backend + UI suites, CI, staging check with a copy of production data, backup, release.
