# Meet: every meeting and call in one place

**Meet** in the sidebar is the only place meetings are scheduled, started and managed. Everything else shows meetings and links to
them, but makes none:

- **Calendar** shows meetings and opens them in Meet. It has no "Scrum call" button any more.
- **Reminders** has one reminder per session for everyone invited. It goes off ten minutes before and opens the meeting (a Project
  Tracker call opens the call itself).
- **Notifications** for invitations, replies, moves and cancellations open the meeting in Meet.
- **Chat**: the call button in a one-to-one chat calls that person; in a group or project chat it starts a group call. Both are
  Project Tracker calls. A meeting posted in a project chat has Join and Details (Details opens it in Meet).
- **A project page** has one **Meet** button, which opens Meet filtered to that project. The old Meetings tab and the "Google Meet"
  menu are gone; old links (`?tab=meetings&meeting=…`) open the meeting in Meet.
- **Home**: the Meetings tab is gone. "Coming up" on Today still lists the next day's meetings, with a link to Meet.
- **Agents**: the notetaker's page moved into Meet. `/notetaker` and `/project-agent/meeting-bot` lead to Meet › Notetaker.

## Tabs

| Tab | What it shows |
| --- | --- |
| Upcoming | Sessions in the next 30 days, by day, with what is going on now first. Each shows the service, project, organizer, your reply, the notetaker, and **Join** from 15 minutes before. Then **Also on your calendar**: other Google or Outlook calls, each with **Send notetaker** |
| Series | Repeating meetings (stand-ups and series) with their next session and how many are left |
| Past | The last 30 days, with **Notes** where the notetaker came |
| Notetaker | Send the notetaker to any Google Meet or Teams link, how much it does by itself, every call it attended with its minutes, "My agent" (go when double-booked, briefs, check-ins), and for owners and admins the workspace settings (its name, default chat reminders) |

`?project={id}` filters every tab to one project. `?open=p:{id}` or `?open=w:{id}` opens one meeting (a project meeting or a
workspace meeting); `&at={ISO time}` picks the session. `?new=schedule` opens the schedule form.

## One meeting

Opening a meeting shows:

- When it is, with its zone.
- Who organizes it, and its project.
- The notetaker.
- **Join.** A Project Tracker call opens in the app; Google Meet and Teams open in their own tab.
- **Your reply.** For Project Tracker calls this is Yes, Maybe or No. For Google and Teams you reply from the invitation in your
  calendar, and your reply shows here.
- The agenda, and the people with their replies.
- **Send the agent in my place** and **Brief**.
- For the organizer: Move, Invite, Remove, Post stand-up summary, and Cancel (or Cancel series).

## The schedule form

One form for every meeting:

- **Meeting** or **Stand-up.** A stand-up suggests 15 minutes, weekdays and a short agenda, and its summary is posted after each
  session.
- **Project**, or **No project** for the whole workspace.
- Date, start, duration and repeat (daily, weekdays, weekly; 2 to 120 sessions), read in the zone shown on the form.
- **Meeting service**: Automatic, Google Meet, Microsoft Teams or Project Tracker call, offering only what is connected. Automatic
  is Google when the organizer's Google Calendar is connected, else Teams when Outlook and Teams meetings are on, else a Project
  Tracker call ([CONNECTED-ACCOUNTS.md](CONNECTED-ACCOUNTS.md)).
- **Notetaker**:
  - **Not needed.** Nobody listens, even if the project's agent would otherwise come.
  - **Transcription.** It listens, writes the transcript and the minutes, and stays quiet.
  - **Transcription + voice suggestions.** It also speaks up, briefly, when an agenda point, an owner or a date is being missed,
    and writes the same line in the meeting chat. Five minutes before the planned end it says once what is still open from the
    agenda.
- Agenda (the notetaker checks it) and the people to invite.

The notetaker is the project's agent in the meeting. It needs a project whose agent is on and may read meetings. A choice that is not
possible is shown disabled with the reason: the agent is off (with a link for whoever may switch it on); voice needs the speech
service (Sarvam) and AI. Without a project, the form says to choose one. "Start now" takes the same project, service, people and
notetaker, and the meeting begins at once.

Rediffmail has no calendar or meeting service, so people who use only Rediffmail get Project Tracker calls. Their mail and
invitations still work.

## Replies and reminders

- A Project Tracker call is answered in Meet (Accept or Decline in the list, Yes, Maybe or No in the meeting). The organizer is
  told. Google and Teams keep their own replies, which Project Tracker reads back.
- Everyone invited who has not declined gets a reminder for each session, ten minutes before. This includes the organizer and
  each session of a series. Declining takes it back, accepting brings it back. Moving the meeting moves it. Cancelling or removing
  someone takes it back.
- Reminders are planned for the next two days, every few minutes, and at once when a meeting is created, moved, answered or
  cancelled. Each has the key `meet:{meeting}:{user}:{session}`, so it is never doubled and one that was dismissed is not brought
  back.
- This reminder is the "starts soon" notice. There is no separate one any more.

## Voice suggestions: how they work

1. While a voice meeting is going on, the agent checks every few minutes (at most 8 times, 4 minutes apart) whether something
   important is being missed: overdue or due-soon work nobody mentioned, a commitment with no owner or date, an agenda point not
   covered, or an unanswered question. Five minutes before the planned end it does a wrap-up check on the agenda. Each check is one
   quick AI request.
2. Each line goes to the meeting chat. The speech service also turns it into a voice (WAV), in the meeting's caption language when
   the service knows it (Indian languages and English), else English.
3. The meeting-bot worker collects it with its next poll and says it:
   - in our own calls, on the agent's own microphone track, published only when it first speaks;
   - in Google Meet and Teams, through a microphone given to the page, unmuted only while it speaks.
   See `apps/meetbot/README.md`.

## API

| | |
| --- | --- |
| `GET /api/v1/meet?from&to&projectId` | Sessions in a window (at most 120 days, 400 sessions), with `ref`, join address, your reply, notetaker, notes state and whether it is live |
| `GET /api/v1/meet/series?projectId` | Repeating meetings with their next session and sessions left |
| `GET /api/v1/meet/notetaker?projectId` | Whether the notetaker (and its voice) can come to that project's meetings, and why not |
| `POST /api/v1/meet/p/{id}/rsvp`, `POST /api/v1/meet/w/{id}/rsvp` | `{ response: accepted \| tentative \| declined }` for a Project Tracker call |
| Meeting create bodies | optional `notetaker`: `off`, `transcript` or `voice` (empty: the project agent's settings decide, as before); answers carry `notetaker` |

## Before release

- Project Tracker calls need the calls server (`deploy/gcp/calls.sh`, DNS `calls.projecttracker.in`). Without it, people with no
  Google or Outlook calendar cannot hold meetings, and the form says so.
- Voice suggestions need `Voice__SarvamApiKey` and the meeting-bot worker. Without them, Transcription still works and voice is shown
  disabled with the reason.
- Migration `20261110001000_MeetTab` is additive. Existing meetings keep "project default" as their notetaker, so nothing changes for
  them.
