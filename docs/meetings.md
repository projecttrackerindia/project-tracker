# Meetings connected everywhere · action items are just work

What this branch (`meet-connect`) found, changed and added. Design: `apple2/design.md` §6 (meetings as connected objects), §7 (action items as work items) and §2 (action item review, rebased onto work items).

## Inventory: what existed before

| Area | Where | State before this branch |
|---|---|---|
| Project meetings | `Domain/Entities/ProjectMeetings.cs` (`ProjectMeeting`, `MeetingParticipant`), `MeetingService` | Scheduled in Google Meet, Teams or our own call (`MeetingCalendar`), always linked to a project. Start now, schedule, reschedule, cancel, invite/remove, RSVP, stand-up summary. |
| Workspace meetings | `WorkspaceMeeting`, `WorkspaceMeetingAttendee` | Same, without a project ("No project"). |
| Recurrence | `MeetingRecurrence` | Daily / Weekdays / Weekly with a session count, stored as an RRULE and expanded on the server (meeting zone, DST-safe). No monthly, custom or end date. A series could only be moved as a whole (our calls) or in Google/Outlook. |
| Meet feed | `MeetFeedService` (`GET /meet`, `/meet/series`) | Sessions in a window and series with their next session. |
| Calendar / timeline | `CalendarService` in `InsightsServices.cs` | Meetings expanded into sessions on the Calendar. |
| Reminders | `MeetingReminders` | One reminder per session per person, 10 minutes before. |
| Notetaker | `MeetNotetaker`, `NotetakerService` | Per-meeting notetaker choice; minutes with task proposals. |
| Action items | `ActionItemService`, `/projects/{id}/action-items` | **Already work items**: `WorkTask` rows with `Kind = ActionItem` in the one `WorkItems` table (numbered AI-n), shown in My Work, workload and search. No source meeting. |
| Portfolio action items | `PortfolioBoardService` | Reads the same action-item work tasks (there is no separate `PortfolioActionItems` table). |
| Work items | `WorkItemService`, `WorkItemApiService` (`/work-items`) | One list over tasks, issues, action items and tickets. |
| Time | `TimeService` | Entries on a task or a work task (check constraint: exactly one). Overlaps are warnings. |
| Aura | `AiToolbox` (`propose_schedule_meeting`), `AiPowerTools` (reschedule/update meeting) | Plan → confirm cards. |
| Front end | `features/meet/ScheduleMeeting.tsx` (one long form), `MeetingDetail.tsx`, `MeetPage.tsx`, `features/work/MyWork.tsx`, `features/calendar/YourDay.tsx`, Time pages | — |

## Changed

- **Recurrence** (`MeetingRecurrence`): adds Monthly, Custom (every 1–4 weeks on chosen days) and an end date (`until`, the form defaults it to the project's due date) next to the session count; cadence (`Daily/Weekly/Monthly/Custom/Ad hoc`) and a sentence ("Every Mon · until 21 Nov"). Old rules read exactly as before.
- **One-off session changes everywhere**: `MeetingSessions.Expand` applies "this occurrence" changes (moved, renamed, cancelled) in the Meet feed, the Calendar, reminders, free/busy, time proposals and reviews.
- **Schedule** (`ScheduleMeetingRequest`): `teamIds` (expanded into members when scheduled; for a project only those who can see it), `video` (`inapp`, `teams`, `meet`, `zoho`, `none`) and `videoUrl` (a pasted link becomes the join link, held as our own call). Additive: old requests behave the same.
- **Work items** carry their source: `SourceMeetingRef`, `SourceSeriesRef`, `SourceMeetingTitle`, `SourceOccurrenceStartUtc`, plus the owner's `LatestNote` / `LastUpdateAt`. `/work-items` rows and detail return `source`; `?fromMeetings=true` and `?sourceSeries=p:{id}` filter.
- **Time entries** may be spent on a project meeting (`MeetingRef`, kind `meeting`): the check constraint now allows "neither a task nor a work task, with a meeting". Timesheet grid rows show them; the grid's copy-forward and suggestions skip them.
- **Aura**: `propose_schedule_meeting` takes Monthly, `until`, `video`, `video_url`; new `propose_capture_action_item` (plan shows title / owner / due as the capture line reads it; confirm uses the same capture service).
- **Front end**: the schedule form is one sheet in the design's layout, opened from the Aura chip, + New, Calendar, a project, My Work and Messages.

## New

| What | Endpoint | Notes |
|---|---|---|
| Sessions of a meeting | `GET /meet/{p\|w}/{id}/sessions?from&to` | Expanded on the server, with changes. |
| Change a session | `POST /meet/{p\|w}/{id}/occurrence` `{occurrenceStart, scope: this\|following\|all, startTime?, endTime?, title?, cancel?}` | Our own calls only (Google/Outlook series stay in that calendar, 409). "Following" ends the series before it and starts a new one carrying `SeriesRootId`. |
| Free/busy | `GET /meet/free-busy?userIds&teamIds&from&to&slotStart&slotEnd` | Times only; meetings across the workspace and planned leave. Guests see only themselves. |
| Time proposals | `GET /meet/time-proposals`, `POST …/{id}/log` `{minutes?, note?, billable?}`, `…/later`, `…/dismiss` | Made when asked for (first visit after a session ended, last 3 days), announced once in the bell; **never logged without the tap**. Log goes through `TimeService.LogOnMeetingAsync` (closed weeks, day limits, overlap warnings). |
| Capture | `POST /meet/{p\|w}/{id}/capture` `{text, occurrenceStart?, projectId?, assigneeId?, dueDate?}`, `…/capture/preview` | Shared parser `QuickLine` (C#) / `quickLine.ts`: `@owner` (meeting people first; ambiguous is refused), `today/tomorrow/fri/next week/7 nov/+3d/in 3 days`. Creates an action item (AI-n) in the meeting's project with this meeting and session as source. |
| Items of a meeting | `GET /meet/{p\|w}/{id}/items?occurrence` | Made here + open count in the series + next/previous session. |
| Review | `POST /meet/review` `{scope: series\|all\|mine, seriesRef?, occurrence?}`; `POST /meet/review/{session}/decide` `{workItemId, decision, reason?, ownerId?, dueDate?}`; `…/undo`; `…/finish`; `…/send` | Decisions: done (status), carry (due → next session's day, history "carried"), replan (owner and/or due, reason required; delayed due uses the due-date reason rule; new owner notified), convert (project task with the same source; action item closed with a link), drop (cancelled with reason). Undo until minutes are sent. Minutes drafted from decisions + items captured in that session; Send notifies attendees and keeps the minutes on the review session. |
| Owner update / nudge / mine | `POST /meet/action-items/{id}/update` `{note, signal: on_track\|need_help\|move_date\|done}`; `…/nudge`; `GET /meet/my-action-items` | Updates set `LatestNote`/`LastUpdateAt` and add a comment; Need help / Ask to move date tell the person who added it. |

Tables: `MeetingOccurrenceChanges`, `MeetingTimeProposals`, `MeetingReviewSessions`, `MeetingReviewDecisions`. Migration `20261122001000_MeetingsConnected`.

### Migration of existing action items

There is nothing to copy: project action items have been work items (`WorkItems`, `ItemType = Work`, `Kind = ActionItem`) since the one-Work migration, with their ids and project. The migration only adds nullable columns, so every existing action item keeps working through both the old endpoints (`/projects/{id}/action-items`) and the new ones; with no source meeting it appears in My Work without a tag and under "Other" in the all-projects review. `Down` drops the new columns and tables (and any meeting-only time entries, which have no task to stay on).

## Front end

- `features/meet/ScheduleSheet.tsx` — the one schedule sheet (title, project, attendees incl. teams, when + duration chips + free/busy, repeats, video, notetaker, agenda). `openSchedule()` opens it from anywhere.
- `features/meet/quickLine.ts` — capture-line and sentence parsing shared by the Aura chip, the capture line and My Work.
- `features/meet/MeetingWork.tsx` — the meeting page's capture line, "Created in this meeting", "Review last time's items" and the this/following/all editor.
- `features/meet/ActionReview.tsx` — Review action items (J/K, D, C, R, T, X, U), re-plan popover, minutes summary; phone card view.
- `features/meet/MeetTime.tsx` — "Log 45m to …?" card (Today, Time) and toast.
- My Work: "◆ From: …" tags, "◆ From meetings" chip, meetings in Today / This week with Join and agenda, "My action items" view; item detail "From meeting" card.

## Gaps against the design

- Duration of the proposal is the session's length, not worked out from join/leave times (no attendance events are kept for meetings yet); "Didn't attend" is the manual opt-out.
- Teams / Meet / Zoho: a pasted link is used as the join link; without one, Teams and Meet use the organizer's connected Outlook/Google calendar (existing integration). No Zoho OAuth.
- Minutes are kept on the review session and sent in the app; no Library document and no PDF export (the summary has Copy).
- Agenda pulling from the Plan sheet is not wired (the Plan sheet is built on another branch); "Review action items since last" is offered as a one-tap agenda line.
- Proposals are created when the attendee next opens Today / Time (and announced then), not pushed by a background job at the exact end time.
- Other places that expand meetings for their own purposes (stand-up summaries, the agent's call autonomy) do not yet apply one-off session changes.
