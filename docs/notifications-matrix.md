# Notifications matrix

What each event delivers on each channel after the `notify-speed` change, and which test proves it. All channels go through one
pipeline:

```
event (service)  ->  NotificationService.AddAsync / ReminderEngine  ->  NotificationRouter.ApplyAsync (the person's settings)
                 ->  Notification row saved (InApp, Browser, PushPending, EmailPending, DeliverAfter)
                 ->  AppDbContext.SaveChangesAsync, after commit  ->  INotificationFeed.Announce          (new)
                 ->  SignalR "notification" { created, types } to the recipient's user group                (new)
                 ->  browser: ChatRealtime  ->  bell/tab counts and Approvals counts refetch, CHECK_NOTIFICATIONS
                 ->  LiveBanners (banner + sound via announce())  /  DesktopNotifier (OS notification)
                 ->  NotificationEmailService.SendPendingAsync (e-mail)  /  PushService (web push)  /  Slack
```

## What was broken

| Symptom | Cause | Fix |
|---|---|---|
| Approver got no badge, no sound and no pop-up when a request was raised; the requester heard nothing after approve or reject | The rows were created, but nothing told open tabs. Only chat and calls sent the SignalR `notification` event. The bell counts were polled every 60 s, the Approvals tab badge (`/approvals/counts`) every 60 s, the desktop check ran every 15 s, and the banner and sound (`LiveBanners`) only ran on that event, which never came for approvals | New `INotificationFeed` (`SignalRNotificationFeed`). Every `Notification` row with `InApp` that is saved through `AppDbContext` is announced to its recipient after commit (after the transaction commits when inside one). `ChatRealtime` now also refreshes the Approvals counts and list when an `Approval` arrives |
| Some people had switched approval e-mails off without meaning to | The settings label for `NotificationType.Approval` read "Timesheet approvals" | Renamed to "Approvals", with a description that covers every request type |
| Approval deadlines in the bell and e-mail were in UTC | `ApprovalService` formatted `ExpiresAt` with a literal "UTC" | Written in the recipient's zone: their own zone, then the workspace's, then the platform's (`AppClock.ZoneIdFor`, the same order reminders use), with the zone abbreviation, e.g. "07 Nov 22:30 EST" |
| Same lag for task assignment, mentions, comments, reminders, due/overdue and everything else that is not chat | Same cause: no live announce | Covered by the same feed, since every kind goes through `AppDbContext` |

## Matrix

Legend: **Y** = works, delivered at once. **Held** = held by quiet hours, do-not-disturb or digest, then delivered. **-** = not applicable
or not offered. **Gap** = not delivered (see Gaps). "Badge" means the bell count, the sidebar or tab-bar destination badge, the app-icon
badge (push `badge` field) and, for approvals, the Approvals count.

| Event | In-app (bell) | Badge | Sound | Desktop (OS) | E-mail | Push (closed app / phone) | Proven by |
|---|---|---|---|---|---|---|---|
| Approval raised -> approver | Y | Y (live) | Y | Y | Y (default on) | Y | `NotificationPipelineTests.Raising_an_approval_...` |
| Approval step approved -> requester; next approver | Y | Y (live) | Y | Y | Y | Y | `ApprovalsTests`, pipeline test |
| Approval approved / rejected -> requester | Y | Y (live) | Y | Y | Y | Y | `NotificationPipelineTests.Approving_and_rejecting_...` |
| Approval comment / remind / expired | Y | Y (live) | Y | Y | Y | Y | `ApprovalsTests` (rows); same pipeline |
| Task assigned | Y | Y (live) | Y | Y | Y | Y | `NotificationPipelineTests.Assigning_a_task_...`, `NotificationTests` |
| @mention (task comment, project chat) | Y | Y (live) | Y (mention cue) | Y | Y | Y | `InboxTests`, `ProjectChatTests` (rows); same pipeline |
| Chat message (DM or group) | Y (one per conversation) | Y (live, unchanged) | Y | Y | Opt-in, only if still unread after a few minutes | Y | existing chat tests |
| Comment / task updated (updates) | Y | Y (live) | Y (update cue) | Y | Y, or digest when digest mode is on | Digest: not pushed | `NotificationTests.In_digest_mode_...` |
| Personal reminder fires | Y | Y (live) | Y (reminder card) | Y | Y | Y (never held) | `NotificationPipelineTests.A_reminder_that_fires_...`, `DayFixTests` |
| Due soon / overdue / nudge | Y | Y (live) | Y | Y | Y | Y | `ReminderEngine` tests; same pipeline |
| Meeting starts / invitation | Y | Y (live) | Y | Y | Y | Y | existing meeting tests |
| Security alert | Y (locked on) | Y | Y | Y | Y (locked on) | Y | `NotificationTests` |
| New mail in a connected mailbox | Gap | Y (client-side unread count from the mailbox list) | Gap | Gap | - (it is e-mail) | Gap | - |

### Settings that suppress (all enforced server-side in `NotificationRouter.ApplyAsync`)

| Setting | Effect | Proven by |
|---|---|---|
| Per kind: in-app / e-mail / desktop toggles (yours, else the workspace default, else the catalog) | Off = that channel is not set on the row. All off = no row and no announce | `NotificationPipelineTests.Channels_switched_off_...`, `NotificationTests` |
| Do not disturb (chat status) | Row and badge at once; no pop-up; e-mail and push wait until DND ends (`DeliverAfter`) | `NotificationPipelineTests.Channels_switched_off_...` |
| Quiet hours (Notifications > Schedule) in the person's zone | E-mail and push wait until quiet hours end; reminders the person set, security, SLA, invitations and calls are never held | `QuietHoursTests` (CI runs with `HoldNotificationsInQuietHours=false` so timing does not depend on the hour) |
| Digest time | Updates (not "needs you") are not pushed and are e-mailed in one digest at the digest time, in the person's zone | `NotificationTests.In_digest_mode_...` |
| This device: mute, sound per category, DND | Browser-side: `announce()` and `DesktopNotifier` skip sound or pop-up; the badge still moves | `features/notifications/centre/*.test.ts` |
| Time zone / region | Reminder times, quiet hours, digest, and now approval deadlines use the person's zone, then the workspace's, then Asia/Kolkata | `NotificationPipelineTests.Approval_deadlines_...`, reminder tests |

## Gaps (not fixed in this PR)

- **New-mail alerts.** The mailbox is read live from IMAP/Gmail/Graph when the Mail page or the rail asks. There is no server-side sync,
  so no notification row, sound, desktop alert or push is made for new mail. The rail badge is computed in the browser from the mailbox
  list. Adding alerts needs a background poller per connected account (or provider push: Gmail watch, Graph subscriptions).
- **A snooze that ends** brings a notification back without a live announce. It shows at the next poll (60 s) or push.
- **Notifications saved with the synchronous `SaveChanges()`** are not announced. Only test seeding uses it today.
- **Personal workspaces and guests** do not open the realtime connection (`chatOn`), so they still rely on the 15 s and 60 s polls.
