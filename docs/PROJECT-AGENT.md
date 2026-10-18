# Project agent

The project agent reads a project's email, chat, Slack channel, WhatsApp messages and meetings, and turns what it reads into **proposals**:
new tasks, action items and tickets, updates to existing tasks and tickets, delays, points nobody picked up, suggestions and decisions — each
with the words it came from. **Nothing in the project changes until someone who may edit the project approves it.** Approved work is created
with the approver's own rights, through the same services the screens use.

Code: `backend/src/ProjectManagement.Application/Features/Agent/`, the meeting bot in `apps/meetbot/`, the screens in
`frontend/src/features/agent/`. Tests: `ProjectAgentTests.cs`, `ProjectAgentAccuracyTests.cs`, `apps/meetbot/test/`, `frontend/scripts/verify-agent-ui.mjs`.

## What it reads

| Source | How it arrives | When it is read |
|---|---|---|
| Project mailbox | Mail to `agent+<token>@<InboundEmail:Domain>` (copy it on client threads, or forward) | a few minutes after a burst of mail settles |
| A member's own inbox | Opt-in per person (Project agent › My inbox): Gmail or Outlook, only mail that names one of their projects | every 30 minutes |
| Project chat | The project's conversation in the app | once it has been quiet for 10 minutes |
| Slack channel | A channel linked in the project's Agent tab (needs the Slack app with channel reading, see below) | polled every 2 minutes, read with chat |
| WhatsApp | A text from a member's **verified** number that starts with the project key: `PAY: refunds are blocked` (off by default, see below) | read with chat |
| Google Meet transcripts | Fetched with the organizer's Google account after each project meeting | right away |
| Live meeting bot | Our own bot joins the meeting and follows Meet's captions | when the session ends |
| Pasted transcripts / notes | Agent tab › Add transcript (text, `.txt`, `.vtt`, `.srt`) | right away |

Everything read is stored **encrypted** and erased `Agent:SignalRetentionDays` (default 30) days after it was read; the proposals and
their short quotes stay. Anyone can write to the project mailbox, so mail is only ever treated as information, never as instructions, and
the `From:` address is marked as not verified.

## Accuracy

Each reading goes through these steps (`AgentAnalysisService`):

1. **Context.** The model gets the project's open tasks (with a line of description and the latest comment), open tickets, work done this
   week, what was already proposed, the summary of the last meeting, and the workspace's people.
2. **The lead's notes.** *Notes for the agent* (Agent tab › Accuracy › Notes and names): terms and abbreviations, who usually owns what,
   what to ignore. They come first in the prompt.
3. **Who is who.** *Names in calls and chat*: one `name heard = person's email` per line, for nicknames and names captions misspell.
4. **Learning from decisions.** The last 45 days of the team's decisions are part of the prompt: what was dismissed, what was approved
   only after changing its title/owner/date (and how), and work an assignee said was not theirs.
5. **Grounding.** Every quote is checked against the source it names, word for word or nearly. A proposal whose quote is not in the
   source is kept, marked **Check the source**, and its confidence capped at 35%.
6. **A second look.** With `Agent:VerifyFindings` (default on), a quick second model call checks each proposal against the sources:
   unsupported proposals are dropped, an owner or date the sources do not make clear is removed, and the confidence becomes the checker's.
   If that call fails, the proposals stay as they were. It costs one quick-tier reading.
7. **Meeting language.** The bot switches Meet's captions to the project's *Meeting language* (when Meet offers it), so a Hindi or Tamil
   stand-up is not captioned as English gibberish.

Proposals are ordered: grounded first, then by confidence.

### Measuring it

`evaluation/project-agent/` holds synthetic stand-ups, mail and chat with the expected proposals (`cases.v1.json`), including small talk
that must produce nothing and a prompt-injection mail that must not update anything. Run it against a sandbox project with the agent on:

```
PT_API=https://<api host> PT_TOKEN=<access token> PT_PROJECT=<sandbox project id> node evaluation/project-agent/evaluate.mjs
```

It prints recall (expected items found) and precision (proposals that are not forbidden), writes `report.json`, and dismisses what it
created (`--keep` leaves it). CI runs `--self-test` (the scoring only). Run the full evaluation after changing the prompt or the model.

## Usefulness

- **Agenda in the meeting.** After its hello, the bot posts what is due today, what is overdue and how many items are still open from the
  last meeting — by key and first name only, because people from outside the company may be in the call.
- **Reminders during the meeting** (workspace setting): when something important is being missed — overdue work nobody mentioned, a
  commitment with no owner or date, an unanswered question — the bot posts a short note in the chat (at most 8 per meeting, 4 minutes apart).
- **Calls on the calendar.** With *Calls on my calendar* on, the bot also joins Google Meet calls on the acting person's calendar whose
  title has the project's key or name (and that are not already project meetings).
- **Minutes.** When everything proposed from a meeting has been decided, the people in it (the meeting's invitees, or the project's
  people) get the minutes: summary, decisions, actions with owners, updates, delays, points not picked up, ideas. Bell and e-mail, by
  each person's notification settings. *Meeting minutes* switch in the Agent tab.
- **The owner confirms.** Work the agent found and someone approved for another person asks that person: *Is PAY-31 yours?*
  (Project agent › Given to me). *It's mine* closes it; *Not mine* needs a word on whose it is, tells the approver and the project
  owner, and comments on the task. The next reading learns from it.
- **Morning updates.** Each person with work in the project gets their own update at 9:00 (workspace time): due today, slipping, new,
  still open, and the team's delays and missed points approved since yesterday.
- **One place to decide.** Project agent › To review shows what waits across all projects a person may edit; *Approve all* creates new
  items and notes in one go, while changes to existing work (status, owner, dates) are approved one by one.

## Setting it up

Per project (Agent tab, anyone who may edit the project): switch it on — it then acts as that person in the background (their rights,
the workspace's AI credits) — choose the sources, and fill *Notes and names*.

Per workspace (Project agent › Meeting bot, owners and admins): the bot's name and whether it reminds people during meetings.

Per installation (environment variables):

| Setting | What it does |
|---|---|
| `Agent__WorkerEnabled` | the background worker (default `true`) |
| `Agent__IntervalSeconds` | how often it looks (default 60) |
| `Agent__VerifyFindings` | the second look (default `true`) |
| `Agent__SignalRetentionDays` | erase what was read after this many days (default 30; 0 keeps it) |
| `Agent__SlackPollMinutes` | how often a linked Slack channel is read (default 2) |
| `Agent__DailyUpdateHour` | the morning update's hour (default 9) |
| `Agent__MeetingBotUrl`, `Agent__MeetingBotSecret` | the meeting bot service (see [DEPLOY.md](../deploy/DEPLOY.md)) |
| `InboundEmail__Domain`, `InboundEmail__Key` | the project mailbox addresses (see below) |
| `Slack__AgentChannels` | ask Slack for channel reading when the Slack app is installed |
| `WhatsApp__AgentMessagesEnabled` | let project-addressed texts from verified numbers reach the agent |
| `Ops__DeployWebhookToken`, `Ops__AlertEmail` | failed-deploy alerts (see below) |

### Project mailbox (inbound e-mail)

The addresses only appear once `InboundEmail__Domain` is set. Pick a domain or subdomain you control (e.g. `inbound.projecttracker.in`),
then with any inbound-mail provider:

- **Mailgun:** add the domain, set its MX records, create a route *match recipient* `.*@inbound.projecttracker.in` → *forward*
  `https://<api host>/api/v1/inbound/email?key=<InboundEmail__Key>`.
- **SendGrid Inbound Parse:** MX `mx.sendgrid.net` for the subdomain, host `inbound.projecttracker.in`, URL as above.
- **Postmark inbound:** set the inbound webhook to the URL above; forward the domain's mail to the Postmark inbound address.

One route carries every workspace's mail: `agent+<token>@` goes to that project's agent, `work+<token>@` to a person's work inbox.
`InboundEmail__Key` (any long random string) must then be on the webhook URL or in an `X-Inbound-Key` header. Limits: 300 mails per
project per day, 30 per sender.

### Slack channel

Set `Slack__AgentChannels=true`, add the `channels:history` and `groups:history` bot scopes to the Slack app, and connect Slack again
(Settings › Slack) so the installation has them. Then invite the app to the project's channel (`/invite @<app>`) and paste the channel ID
(channel name › About, starts with `C`) into the project's *Notes and names*. Only people's own messages are read (no bots, joins or
topic changes), from the moment the channel is linked. Slack limits how often history may be read, so it is polled every couple of minutes
in small pages.

### WhatsApp

Off by default: the WhatsApp integration otherwise discards all message text. With `WhatsApp__AgentMessagesEnabled=true` (and reception
and contact linking already on), a text from a member's **verified** number (Account › WhatsApp) that starts with a project key —
`PAY: the bank file is late` — is kept, encrypted, for that project's agent, if the member works on the project (owner, member or has work
in it) and the project's *WhatsApp* source is on. At most 200 a day per project. Every other message is still discarded.

## Operations

- **Meeting bot:** `apps/meetbot`, its own Railway service (see DEPLOY.md). Everything that depends on how the Meet page looks is in
  `apps/meetbot/src/meet.mjs`; when Google changes Meet, update that file and `test/fake-meet.html`, and run `npm test` there.
- **Failed deploys:** set `Ops__DeployWebhookToken` (24+ random characters) on the API and add a Railway webhook (project settings ›
  Webhooks) to `https://<api host>/api/v1/inbound/deploy/<token>`. A failed deployment or crash of any service e-mails the platform
  administrators (and `Ops__AlertEmail`), at most once every 15 minutes per service; other events are ignored.
- **Costs:** a reading costs standard-tier credits (more for long transcripts), the second look and each in-call check a quick-tier
  reading. Each project is capped at `MonthlyRunLimit` (300) readings a month.
- **Privacy:** summaries and quotes are shown only to people who may edit the project; a member's own inbox contributes at most a
  200-character quote; the lead's notes and names are visible only to them; what was read is erased after the retention period.
