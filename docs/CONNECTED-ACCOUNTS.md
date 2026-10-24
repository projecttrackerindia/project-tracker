# Connected accounts and where meetings go

Each person connects their own accounts in **My account › Connected accounts** (`/account/integrations`). Project Tracker uses only
what they turn on, and each use is switched off on its own: stopping Gmail never stops Calendar and Meet.

## What people get

| Account | Each part, switched on or off on its own | What it does |
| --- | --- | --- |
| Google | Calendar and Google Meet | Meetings go to their Google Calendar with a Meet link; Google sends invitations and keeps replies |
| | Send mail from Gmail | Mail sent from Project Tracker leaves from their own address |
| | Read the Gmail inbox | Mail in Mailbox; the mail agent turns mail into task updates |
| | Meeting transcripts | The project agent reads finished Meet transcripts |
| Microsoft | Outlook calendar and Teams meetings | Meetings go to their Outlook calendar with a Teams link; Outlook sends invitations and keeps replies |
| | Calendar availability | Check free and busy times before planning |
| | Send mail from Outlook, read the Outlook inbox | As for Gmail |
| Slack | Direct messages from the Project Tracker bot | Off, what needs them (assignments, mentions, approvals, reminders…), or everything |
| GitHub | Sign in with GitHub | Their pull requests and review requests are recognised: review queue on Home, reviewer suggestions |

Turning a part off drops that permission in Project Tracker at once. Google and Microsoft keep the grant itself until the whole account
is disconnected (Google is then told to revoke it; for Microsoft, people can also remove the app at myapps.microsoft.com). Reconnecting
for one part never quietly brings back a part that was switched off.

Mailbox's "Stop mail" turns off only mail and inbox; Calendar, Meet and Teams keep working.

## Where meetings go

A meeting (from Meet's Start now and Schedule, or from the assistant) is created in one service and remembers it ([MEET.md](MEET.md)):

1. The service chosen on the meeting form, if any.
2. Otherwise the person's choice in Connected accounts (Automatic, Google Meet, Microsoft Teams, Project Tracker call).
3. Automatic: **Google Meet** when their Google Calendar is connected, else **Microsoft Teams** when their Outlook calendar and Teams
   meetings are on, else a **Project Tracker call** (our own calls, [VIDEO-CALLS.md](VIDEO-CALLS.md)).

Google and Teams meetings are real calendar events: invitations, replies (RSVP), moves and cancellations go through the organizer's own
calendar, and a series is changed there. A Project Tracker call has no outside calendar: invitees are notified in the app, a "starts soon"
notice shortly before opens the call, the first person to open it starts it and everyone after joins the same call, and in a
project with its agent on, the agent joins the call itself (no meeting bot, no lobby). The meeting bot keeps going to Google Meet and
Teams meetings as before; Meet's own transcripts are read only for Google meetings.

## Administrator setup (once per installation)

Nothing extra for Google.

**Microsoft (Teams meetings):** in the Azure app registration used for `MicrosoftProductivity`, add the delegated Microsoft Graph
permission **Calendars.ReadWrite** (API permissions › Add › Microsoft Graph › Delegated). Organizations that require admin consent
grant it once. `MicrosoftProductivity__MeetingsEnabled` is on by default; set it to `false` to hide Teams meetings.

**Slack (each person's direct messages):** in the Slack app (api.slack.com › your app):
- OAuth & Permissions › Redirect URLs: add `https://projecttracker.in/api/v1/integrations/slack/me/callback` (beside the existing install
  callback).
- OAuth & Permissions › User Token Scopes: add `openid`, `email`, `profile` ("Sign in with Slack").
- The bot already has `chat:write` and `im:write`. Workspaces connected earlier keep working; nobody has to reconnect.

People link Slack themselves after an administrator connects the workspace's Slack (Settings › Slack). Only their Slack user id, name
and email are kept; no Slack token of theirs is stored. A person signed in to another Slack workspace is refused, and one Slack person
can be linked by only one Project Tracker person per workspace.

**GitHub:** uses "Sign in with GitHub" (`ExternalAuth__GitHub__ClientId` / `ClientSecret`); install the GitHub App for repositories.

## API

| | |
| --- | --- |
| `GET /api/v1/me/connected-accounts` | Every account, the meeting choice and where the next meeting goes (and why) |
| `PUT /api/v1/me/connected-accounts` | `{ meetingService: auto \| google \| microsoft \| ours, slackMessages: off \| needs \| all }` |
| `POST /api/v1/integrations/google/features/{calendar\|mail\|inbox\|transcripts}/off` | Switch one Google part off |
| `POST /api/v1/integrations/microsoft/features/{meetings\|calendar\|mail\|inbox}/off` | Switch one Microsoft part off |
| `GET /api/v1/integrations/microsoft/connect?meetings=true` | Ask for Outlook calendar and Teams meetings |
| `GET /api/v1/integrations/slack/me/connect`, `DELETE /api/v1/integrations/slack/me` | Link or unlink the person's Slack |
| `POST /api/v1/calls/meeting/{id}`, `POST /api/v1/calls/meeting/w/{id}` | Open the call of a project or workspace meeting held as a Project Tracker call |
| Meeting create bodies | optional `service` (same values as above); answers carry `provider` and `providerName` |
