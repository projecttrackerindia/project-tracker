# Reminder Timezone Fix & Stale "Team Strength" Fix

## 1. Reminders not firing at the set time

### Timezone it was following
Two different, incompatible formats were being compared as plain strings:
- The frontend sends `remind_at` via `Date.prototype.toISOString()`, which is
  always **UTC**, suffixed `Z` (e.g. `2026-09-11T14:30:00.000Z`).
- The server's "now" came from `ts()` / `now_ist()`, which is **IST**
  (`Asia/Kolkata`, UTC+5:30), suffixed `+05:30` (e.g.
  `2026-09-11T20:00:00+05:30`).

`due_reminders()` compared these two directly with `<=` as raw strings — no
datetime parsing at all. `Z` and `+05:30` don't sort the way real instants
compare, so the check was effectively comparing the reminder's UTC clock
digits against the server's IST clock digits as if they were the same
timezone. Simulating it end-to-end: a reminder set for **8:00 PM IST**
started showing up as "due" from around **3:30 PM IST** — roughly 4.5 hours
early. (The exact gap varies a little through the day because of how the `Z`
vs `+05:30` suffix characters sort, but it is always several hours early,
never on time.)

### Fix
Added `_parse_reminder_dt()` / `_reminder_is_due()` (app.py, near
`due_reminders()`) which actually parses `remind_at` into an aware datetime,
converts to UTC, and compares against `datetime.now(timezone.utc)`. Applied
to both the appdata-cache path and the DB-fallback path in `due_reminders()`
— the fallback path now fetches un-fired reminders and filters in Python
instead of doing a raw SQL string comparison, since `remind_at` isn't stored
in a single fixed format.

Reminders created going forward will fire at the actual clock time you pick,
regardless of the browser's local timezone. Existing reminders already
sitting in the `reminders` table are unaffected by this fix (their stored
`remind_at` was always correct — only the *comparison* was wrong), so nothing
needs to be re-created.

## 2. "Assign to Team" showing 4 members when there's only 1

### Root cause
Deleting a user (`DELETE /api/users/<uid>`) only removed their row from the
`users` table. It never touched:
- `teams.member_ids` (a JSON array column) — the deleted user's id stayed in
  every team they'd been added to, forever.
- `teams.lead_id` — if they were a team lead, the team kept pointing at a
  now-nonexistent user.
- `projects.members` (same kind of JSON array) — same staleness.

The "Assign to Team" dropdown's member count (`t.name (N members)`) is just
`parseIdList(t.member_ids).length` — it has no way to know 3 of those 4 ids
no longer correspond to real users, so it kept showing the old headcount.

### Fix
- **Backend** (`del_user` in app.py): now also prunes the deleted user's id
  out of every team's `member_ids`, clears `lead_id` if they were the lead,
  and prunes them out of every project's `members` array — so counts derived
  from these columns self-correct the moment a user is deleted.
- **Frontend** (`template.html`, `main.js`, `frontend.js`): both "Assign to
  Team" dropdowns now filter `member_ids` against the live, current user list
  before counting, as a second line of defense — so any team record that's
  already stale (created before this fix) displays the correct count
  immediately too, with no data migration needed.
