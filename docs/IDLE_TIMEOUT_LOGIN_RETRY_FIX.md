# Idle-Timeout Bypass & Login-Retry Fix

## Symptoms
- The 30-minute inactivity auto-logout was unreliable — sessions sometimes
  stayed "logged in" well past 30 minutes of no real activity.
- Right after being logged out, submitting correct credentials often failed
  or appeared stuck, requiring 2-3 attempts before login succeeded.

## Root cause 1 — fast-path guards bypassed login_required's inactivity check
`login_required` (app.py) is the only place that checked `last_activity` and
the remote-logout (`logged_out_at`) invalidation. But three things sat in
front of it and answered requests before it ever ran:

- `_ultra_early_realtime_499_guard` — fast-pathed `GET/POST /api/presence`,
  `GET /api/poll` (on cache hit), `/api/reminders/due`, `/api/calls/incoming`.
- `_ultra_fast_identity_profile_guard` — fast-pathed `GET /api/auth/me` (the
  SPA's "am I logged in" bootstrap call) straight from the `me:{uid}` cache.
- The real `/api/auth/me` route itself had no `@login_required` at all — only
  a bare `"user_id" not in session` check.

These are exactly the endpoints the SPA polls continuously in the background
(poll every ~25-45s, presence beat every 30s, reminders every 45s). As long as
a tab only received background responses from these, the server never
independently re-validated the session — enforcement relied entirely on the
client-side idle timer, which doesn't fire if the tab is throttled/backgrounded
across the 30-minute mark.

**Fix:** factored the inactivity + remote-logout checks out of `login_required`
into `_session_is_expired_and_clear()` and call it at the top of both
before_request guards (and defensively inside `me()` itself), so an expired
session is cleared and falls through to a normal 401 no matter which endpoint
touches it first.

## Root cause 2 — `api._abort()` didn't actually cancel anything
`logout()` calls `api._abort()` first, intending to cancel every in-flight
request before clearing the session. But `_apiRequest` built its own private
`AbortController` per call and never read the shared `_apiAbortCtrl` at all —
`_abort()` was aborting a controller nothing listened to.

Because the session cookie is `permanent=True` with Flask's default
`SESSION_REFRESH_EACH_REQUEST=True`, a straggling authenticated request
(poll/presence/reminders) that resolved *after* the logout response reached
the browser could re-issue a Set-Cookie that resurrected the just-cleared
session. With several polling channels typically in flight at once, this was
common enough that a fresh login attempt would get clobbered by a straggler
moments later, requiring a retry or two before nothing left in flight could
interfere.

**Fix:** `_apiRequest` now subscribes to `_apiAbortCtrl.signal` and aborts its
own per-call controller when the shared one fires, in `template.html`,
`main.js`, and `frontend.js` (this fix already existed in `main.js` from
earlier work; it was missing from the other two near-duplicate files).

## Expected behavior
- A session idle for 30+ minutes is now rejected by *every* endpoint,
  including the background-polled and `/api/auth/me` fast paths — not just
  the ones that were already going through `login_required` directly.
- `logout()` (idle-triggered or manual) actually cancels in-flight requests,
  so a straggling background response can no longer resurrect a cleared
  session and the very next login attempt sticks.
