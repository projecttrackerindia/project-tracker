# FiveStar Workspace v2: Complete Redesign Spec

> Source: a full walk-through of **projecttracker.in / FIVESTAR BUSINESS FINANCE LTD** on 26 Oct 2026, covering every sidebar page, all 11 project tabs, the ticket view, DocTracker, Vault, Timesheet, People, ~30 settings pages and My account.
> Goal: **the simplest possible app that is still the most powerful one**: AI-first, 5 places, one way to do each thing.
> Designs: canvas row **"FiveStar v2 — complete simplified, AI-first app"** (13 screens, all clickable).

---

## 1. Core rules

1. **Five places**: Home · Work · Talk · Library · Insights. People and Settings sit behind your avatar.
2. **One way to do each thing.** If two buttons do the same job, one goes.
3. **One "+ New"** creates anything, from plain words.
4. **AI floats everywhere** as a bottom **Ask bar (⌘K)** that knows what's on screen. It also shows up inline as small ✦ suggestion cards, never as a separate page.
5. **Nothing covers content.** Hover actions sit beside messages and rows, never on top.
6. **Side panels, not pop-up forms.** Items open in a right panel; changes save as you go (no Save/Cancel/Delete footer).
7. **A tab never takes you to another section.** If it must, it's a link with ›.
8. **Filters appear only when needed** (more than about 10 items).
9. **AI asks before it acts** on dates, people or messages; every AI action is logged in Activity.

---

## 2. Shell (every screen)

| Element | Design |
|---|---|
| Left rail (84px) | Logo · **+ New** (blue circle) · Home · Work · Talk · Library · Insights · avatar at the bottom (Settings, People) |
| Page header | Blue eyebrow (context) · big title · one segmented tab control on the right |
| Ask bar | Floating glass pill at the bottom centre. On a project page it becomes a pill at the bottom right ("Ask about Razor pay") that opens a copilot panel |
| Theme | Apple style: `#F5F5F7` canvas, white 20–24px cards, one blue accent `#0071E3`, violet `#5E5CE6` for AI only, Inter |

---

## 3. Module by module

### 3.1 Home *(was: Home, Agents › Ask/Proposals, Reminders, approval queues)*
**Today:** a chat box, chips, "Today at a glance", Needs you and My work as separate blocks, and the Agents › Ask tab jumps back here.
**v2 (V2Home):**
- **AI briefing banner**: "6 things need you", followed by the reasons.
- **One inbox** with filters *All · Assigned · Decisions · Mentions*. Rows are tickets, AI decisions (e.g. "SIA 2 Nov → 19 Dec?"), approvals, overdue tasks, mentions and due reminders. Each row has **one action + Later**, and done rows fade.
- Right column: tomorrow's agenda plus 4 tappable numbers (delayed projects, overdue, hours logged, team open).
- Tabs: **For you · Calendar**.

### 3.2 Calendar *(was: Calendar + Meet › Upcoming)*
**Today:** month grid with 7 view controls, a person filter dropdown and Subscribe.
**v2 (V2Calendar):** a week view with a **Me / Team** switch. Three colours only: meeting, deadline, stage. An AI card suggests things like "Thursday is clear, block it for SIA". Subscribe is a link.

### 3.3 Work *(was: Operations tickets, project tasks/issues/action items lists, Workload drill-down)*
**Today:** tickets live in Operations with their own list. Opening a ticket shows a **pop-up edit form with 6 tabs** (Details, Time, Comments, Resolution, Files, History) and Delete/Cancel/Save.
**v2 (V2Work):**
- Tabs: **My work · Team · Tickets · Projects ›**.
- **One list** with a kind chip (Task, Issue, Action, Ticket), priority dot, owner avatar and due date (red if overdue).
- Clicking a row opens a **side panel**: status, priority, owner and due as 4 tiles; a ✦ Copilot card with one suggested action; **one Activity stream** for comments, time ("log 2h"), files and history. Saves as you go.
- Tickets keep SLA, channel and resolution as fields on the same item.

### 3.4 Projects & Portfolio *(was: Projects page + Portfolio page with its own project tree)*
**Today:** Cards/List/Board, 5 filters, and a chat button on every card. Portfolio has a second project sidebar and opens a different project summary.
**v2 (V2Projects):**
- A **Projects / Portfolio** switch on one page.
- Status counts double as filters (All · On track · At risk · Delayed · Completed).
- Simple cards: name, status, group · owner, one bar, % · due.
- Portfolio view shows an AI summary plus decision cards (**old date → new date**) with **Accept**; accepted cards show "✓ team told".
- Flags a likely duplicate: **"Darwin box Api" vs "Darwin Box api"**, offering "merge or close".

### 3.5 Project page *(11 tabs → 5)*
**Today:** Overview · Board · List · Plan · Issues · Action items · Documents · Files · Time · Agent · Activity, plus 6 header buttons. The **Agent tab is a full settings page** (meeting bot with 4 modes, minutes, morning updates, Google account).
**v2 (V2Project):**
- **Overview · Work · Docs · Time · Activity**
- Header: *+ Add work* and *···* (Meet, Chat, Settings, Delay risk).
- **Overview:** AI summary, completion ring, stage chips.
- **Work:** one list with a List / Board / Timeline switch (replaces Board, List, Plan, Issues and Action items).
- **Docs:** documents and files together. Search and filters show only when there are more than 10 items.
- **Activity:** history, plus the **Project agent as one on/off switch**. Bot behaviour is set once in Settings › AI.
- A floating "Ask about Razor pay" copilot.

### 3.6 Talk *(was: Chat + Mailbox + Meet + Notetaker + Agents › Meetings)*
**Today:** three separate pages. In chat, the hover toolbar **covers the message text**.
**v2 (V2Talk):**
- **One list** with filters *All · Chat · Mail · Meetings*; meetings show as rounded-square avatars.
- Header actions: **Start call**, **Call**.
- A ✦ summary strip at the top of each thread, with one action (e.g. "Attach to FSRD‑2").
- Hover actions sit **beside** the bubble: *Reply · Make task · ···*. React, remind and save move into ···.
- Message box: "Message — or ✦ draft a reply".
- Mail appears in the same list once Rediffmail is connected.

### 3.7 Library › Docs *(was: DocTracker + project Documents/Files)*
**Today:** a 20-project tree, 8 template cards and a drafts list on one page. The project Documents tab has 6 filters and 2 view toggles for one document.
**v2 (V2Library):**
- A big **"Search or ask"** bar that answers from your docs.
- **One list** with type chips (API · Doc · Design · File) and one project dropdown.
- Right column: **Needs your review** (AI drafts) and **Start**: *Write with AI* (from a line, a meeting, a **cURL** or a spec) plus 4 templates.

### 3.8 Library › Vault
**Today:** an unlabelled 8-icon rail, Generator/Import/Get the app, a yellow screen-share banner, and Send once/Edit plus 4 tabs. **The detail view has no username or website URL.**
**v2 (V2Vault):**
- **All · Mine · Shared · Requests** switch.
- Detail shows **Username · Website · Password · 2FA · Notes**: copy/open for the first two, reveal for the rest (passkey check, 30s clipboard, logged).
- One **Share** button opens 3 choices: *Person · For a time · One-time link*.
- Generator, Import, Health, One-time links, Bin and "Seal my vault" move into ···. The screen-share notice shows once.

### 3.9 Time *(was: Timesheet with Week/Insights/Entries/Approvals)*
**Today:** **7 ways to add time** (plain words, "Say it instead", Ask the assistant, Add row, Last week's rows, Draft my week, Copy last week).
**v2 (V2Time):**
- **One input** ("3h on CIBIL‑2 today", which also takes voice).
- **One AI draft card** ("I drafted your week… Use draft").
- A clean week grid, total vs 40h, and **Submit week**.
- Approvals arrive in the Home inbox.

### 3.10 Insights *(was: Workload, Reports, Operations › Insights, Timesheet › Insights, Agents › Workflows/Tracker)*
**v2 (V2Insights):**
- **Overview · Time · Reports**
- **Overview:** 4 numbers, workload bars (open plus overdue in red), and ✦ "What stands out" with *Suggest a rebalance*.
- **Reports:** "describe a report" input, 4 report types (Excel/CSV/PDF), and a scheduled Monday summary.
- The agent tracker (model, tokens, latency) moves to **Settings › AI**.

### 3.11 + New *(was: New ticket, New project, New document, New item, Add task, Add reminder, Schedule… in each module)*
**v2 (V2New):** one sheet. You type a sentence, the AI shows **"I understood this as a ticket"** with chips (type, priority, owner, SLA), and you tap a chip to change it. There are 8 types: Task · Ticket · Project · Doc · Secret · Meeting · Reminder · Time.

### 3.12 People *(behind the avatar)*
**v2 (V2People):** Directory · Teams · Org chart, an **Invite** button, and a seat banner ("5 of 5 seats used — Add seat"). Role pills: Owner · Manager · Member.

### 3.13 Settings & account *(~30 pages + My account → 10)*
**v2 (V2Settings):**
- **You:** Profile & sign-in, Notifications.
- **Workspace:** General · People · Fields & types · Timelines & automation · Security & audit · Integrations · AI · Billing.
- **AI page:** credits 351/1,500; answer success **79%** (34 of 160 failed); **pick one model** (today the workspace says Gemini while accounts say org Claude); "Teach it about FiveStar" (currently **empty**); per-agent level Off · Suggest · Ask first · Auto; MCP address.
- **Removed:** *Resume studio* from My account.

---

## 4. Removed or merged

| Removed / merged | Why |
|---|---|
| Agents page (Ask, Proposals, Workflows, Tracker, Meetings) | Proposals go to the Home inbox, workflows to Insights, the tracker to Settings › AI, meetings to Talk |
| Separate Meet page, Notetaker tab | Part of Talk and Calendar |
| Separate Mailbox page | Part of Talk |
| Reminders page | Reminders are work items, and due ones appear in the inbox. Stop auto-creating 4 reminders (due, +1, +3, +7 days) for one ticket; use one escalating nudge |
| Portfolio's own project tree and summary page | One project page |
| Project tabs Board, List, Plan, Issues, Action items, Files, Agent | Merged into Work, Docs and Activity |
| Ticket pop-up form with 6 tabs | Side panel with one activity stream |
| Chat button on every project card | Talk has project channels |
| 7 ways to log time | 1 input + 1 AI draft |
| Vault icon rail, extra buttons and banner | One switch, Share and ··· |
| ~30 settings pages | 10 |
| Customize sidebar | A fixed 5-item rail needs none |

---

## 5. Data and API changes

- **`WorkItem`** `{kind: task|issue|action|ticket|reminder, project?, owner, status, priority, due, sla?, channel?}`
- **`Request`** `{kind: approval|proposal|access|review, target, from, action}`: feeds the Home inbox.
- **`Conversation`** `{kind: chat|mail|meeting}`: feeds Talk.
- **AI action log**: `{agent, action, target, approvedBy, at}`, shown in Activity.
- Routes: `/{org}/{section}/{tab}` and `/{org}/{section}/{tab}/{id}`, with 301 redirects from old URLs.

---

## 6. Build order

| Step | Scope | Weeks |
|---|---|---|
| 1 | Shell (5-item rail, + New, Ask bar), redirects | 2 |
| 2 | Home inbox (`Request`), briefing | 3 |
| 3 | Work list and side panel (`WorkItem`), ticket migration | 4 |
| 4 | Project page 5 tabs; Projects/Portfolio switch | 2 |
| 5 | Talk (chat + mail + meetings) | 3 |
| 6 | Library (Docs + Vault fields and Share), Time, Insights | 3 |
| 7 | Settings consolidation, AI control, model choice, org context | 2 |

---

## 7. Notes on the mockups

- Project names, people, ticket numbers, credits, billing and seat numbers are **from your workspace**.
- **Illustrative** (made up to show the layout): some project percentages and statuses on the Projects screen, workload split per person, hours in the Time draft, calendar entries after Monday, document names other than *Razor pay API* and the two AI drafts, org-chart reporting lines, and the VPN username/URL.
