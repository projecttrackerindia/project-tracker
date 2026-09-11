# Comments Sync, Channel Badges/Coverage & Reminder Backgrounding Fix

## 1. Comment shows in the project channel but not in the task's own Comments tab

`addCmt()` correctly `PUT`s the full comments array to `/api/tasks/<id>`, and
the server correctly persists it to `tasks.comments` and inserts the
"commented on" line into the project's channel (`messages` table) in the same
request — so the data was never actually lost.

The bug was in how OTHER open views (and the same task reopened later) learn
about that update. The server's `task_updated` realtime (SSE) event only ever
carried `{id, action, stage, project}`. The client's realtime handler applies
this event as an **in-place field merge** into its cached `tasks[]` array —
copying over only `stage`/`project`/`assignee` — rather than re-fetching the
task. Since `comments` was never in the payload, that merge left the cached
task's `comments` exactly as it was before the edit. Reopening the task later
reads `cmts` from that stale cached `task` prop, so the new comment appears
missing — while the channel line shows up fine because it's fetched fresh
every time you open a channel.

**Fix:** `update_task`'s SSE payload now also includes `comments` and
`assignee`; the client's merge (`template.html`, `main.js`, `frontend.js`)
now copies those fields too when present.

## 2. Channel unread badges showing "1" for channels you'd already read

There were two separate bugs stacking on top of each other here.

**2a — team-scoping never re-ran.** `MessagesView` computes badges by
comparing each project's latest message timestamp (`/api/projects/last-messages`)
against a per-project "last seen" timestamp kept in `localStorage`. In
`template.html`, the effect that fetches those timestamps (and the one that
loads the project list for Channels) had an empty dependency array — they
only ran once, at mount, using whatever `activeTeam` was at that exact
instant. `activeTeam` loads asynchronously, so if it was still `null` on that
first render, the fetch went out **unscoped** (whole workspace) and, because
the effect never re-ran, stayed unscoped for the rest of the session. Any
project from another team — which you'd never opened in Channels and so have
no "last seen" entry for — then permanently showed an unread badge, since any
timestamp looks "newer" than an empty one.

Fixed by making both effects depend on the resolved team id, so they re-run
(and re-scope) once `activeTeam` actually loads or changes. `main.js` and
`frontend.js` never had this team-scoping applied at all (an earlier
divergence) — ported the same `teamIdQS` scoping into both, using their
existing `activeTeam` variable and the `key`-based remount they already do on
team switch.

**2b — every sign-out wiped all read history.** `logout()` explicitly deleted
the `pfLastSeen` localStorage key — the record of what you've already seen in
each channel — on every single logout, treating it like session data. It's
really a per-user preference, the same category as dark mode or sidebar
customization (which the code already deliberately excludes from this wipe
with a comment saying they "should survive sign-out/sign-in"). So every
sign-out + sign-in cycle reset every channel back to "never seen," which is
exactly what showed up in your screenshot: all 15 channels badged right after
logging back in.

Fixed by scoping the key per-user (`pfLastSeen:<user id>` instead of a single
shared `pfLastSeen`) and removing it from logout's wipe list entirely. This
fixes it in both directions: signing back in as the same user keeps your own
read history, and a different user logging into the same browser afterward
no longer inherits someone else's "already read" markers for channels they've
never actually opened.

## 3. Channels not showing every project update (priority, due date, etc.)

`update_task` only ever posted a channel message for two cases: a stage move
and a new comment. A priority change, due-date change, or reassignment
updated the task and notified the assignee personally, but never posted
anything to the shared project channel — so anyone just watching the channel
had no way to see those changes without opening the task directly.

**Fix:** added a consolidated system message, posted whenever any of
priority, due date, or assignee actually changed in a single edit — e.g.
`✎ Prasanna Krishna updated VAPT Fixes in UAT — priority Medium → Critical;
due date 2026-09-10 → 2026-09-15`. Multiple changed fields in one save are
combined into a single message rather than spamming one per field.

(Title/description edits still don't post — happy to add those too if you
want the channel to reflect literally every field.)

## 4. Reminders only playing sound/notification while that tab is focused

The reminder-check loop (`checkDue()` — the thing that plays the sound, shows
the toast, and fires the browser notification) ran on a timer that was
explicitly skipped whenever `document.hidden` was true, i.e. whenever this
browser tab wasn't the one currently in focus (you're in another tab, another
app, or the window's minimized). The reminder itself was never lost — the
next time you switched back to that tab, the timer would run again, see the
reminder was overdue, and fire it then — but nothing happened while you were
actually away, which is exactly when a reminder is supposed to alert you.

**Fix:** removed the `!document.hidden` gate in `template.html`, `main.js`,
and `frontend.js`, so the check keeps running on schedule regardless of tab
focus. (Browsers throttle background-tab timers somewhat — typically to
around once a minute — but that's still a world away from never running.)
