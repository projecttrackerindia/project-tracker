# Quick actions on notifications

People can act on a notice without opening ProjectTracker. Only urgent notices get prominent buttons. When smart priority (PR #147) marks a notice `normal`, it stays quiet and just opens when tapped.

| Notice | Buttons |
|---|---|
| Approvals (requests, documents, timesheets) | Approve · Reject (Reject asks for a reason) |
| Messages and mentions | Reply (inline) · Mark read |
| Tasks and action items (assigned, due, overdue, nudges) | Done · Snooze 1h · Open |
| Reminders | Done · Snooze (keeps its own `/r/` key) |
| "Starts in N min" | Join · Running late (tells the other attendees) |
| Meeting invites | Accept · Decline · Maybe |
| Minutes or action items found | Review |
| Date extensions | Accept · Discuss |
| Incoming call | Answer · Decline · Message |
| Missed call | Call back · Message |

The rules live in `QuickActionService.cs` (`QuickActions.For`). The frontend mirrors them in `features/notifications/quick/quickActions.ts`, and the in-app banner uses that copy.

## How a button works with the app closed

1. When the push worker sends a notice that has buttons, it adds `qa` (a key) and `actions` to the payload. The key is HMAC-signed with a key derived from the JWT signing key for the purpose `notification-action`. It names the notification, the person and the workspace, plus a random key id, and it expires after 24 hours.
2. Pressing a button sends `POST /api/v1/notification-actions/{qa}` with `{ action, text?, preset? }` and no cookies or bearer token.
3. `CurrentContextMiddleware` signs that request in as the key's person in the key's workspace only. The same checks as a normal sign-in still apply: the account must be active, membership is required, suspended members are blocked, and the workspace's two-step and IP-allowlist rules are enforced. If any check fails, the server answers `403 QUICK_ACTION_REAUTH`. An expired or forged key gets `401 QUICK_ACTION_EXPIRED`. In both cases the client opens the app at the notice.
4. The action then runs through the same services the app uses (`NotificationActionService`, `ApprovalService`, `MeetingService`), so permissions are checked again at that point.
5. Each use writes an audit row (`notification.quick_action`, entity `QuickActionKey`, id = key id). That row is also what makes a key single-use: pressing again returns `200 { alreadyDone: true }` and does nothing a second time, which makes retries idempotent.

Signed-in clients use two more endpoints:

- `POST /api/v1/notifications/{id}/quick-key`: the desktop app calls this to get a key for a native toast.
- `POST /api/v1/notifications/{id}/quick`: in-app banners call this. It runs the same actions and writes the same audit row, with no key needed.

## Surfaces

- **Web Push** (`public/sw.js`): shows up to `Notification.maxActions` buttons. Reply and Reject use inline text where the browser supports it, and open the app otherwise.
- **Desktop app** (`apps/desktop/src/quick.js`, `main.js`):
  - macOS: notification actions plus the native inline reply.
  - Windows: toast buttons through the `projecttracker://quick/<action>/<tag>` protocol. Reply and Reject open the app there, because a protocol activation cannot carry typed text.
  - The tray or menu-bar icon opens the mini window (`/mini`): Today, the next meeting with Join, a check-in ring with In/Out, and quick add or "ask Aura".
  - Ctrl/Cmd+Shift+Space opens the mini window from anywhere.
  - The unread badge shows on the dock or taskbar, as before.
- **In-app banners**: urgent notices show at most two pills. Reject asks for a reason inline. You can turn buttons off in Settings › Notifications › Quick actions.
- **Android** (`apps/android/native/quick`, opt-in with `PT_QUICK_NATIVE=1` in `build.sh`):
  - action buttons with RemoteInput reply
  - a full-screen incoming call (full-screen intent) with Answer, Decline and quick replies
  - the Today widget
  - an ongoing timer notification (`LiveTimer.start({ kind, title, since, link })`)
- **iOS** (`apps/ios/native/quick`, scaffold):
  - notification categories `QA_<BUTTONS>` (the server sets `aps.category`)
  - CallKit with PushKit
  - a WidgetKit Today widget
  - a Live Activity timer

## Owner steps

**Android**

1. Build once with `PT_QUICK_NATIVE=1 ./build.sh` and try it on a device:
   - Approve, Reply and Done from the shade
   - a call over the lock screen
   - the widget
2. When it works, make `PT_QUICK_NATIVE=1` the default in CI.
3. Notices that carry `qa` must arrive as **data-only** FCM messages, so the app's own service draws the buttons. Today the server also sends a `notification` block, which the system shows by itself while the app is in the background, and that copy has no buttons. Change `FcmSender.BuildMessage` to drop the `notification` block when `qa` is present, once the new APK is out.
4. On Android 14 and later, the user must allow "Full-screen notifications" for the call screen to appear (Settings › Apps › ProjectTracker).

**iOS** (needs the Apple Developer account)

1. Add `QuickActions.swift` to the App target. Call `QuickActions.register()` in `didFinishLaunching`, and route `userNotificationCenter(_:didReceive:)` to `QuickActions.handle`.
2. CallKit:
   - Enable the Voice over IP background mode.
   - Create a VoIP services key.
   - Register `CallKitProvider.shared`.
   - On the server, send VoIP pushes for ringing calls. This needs a new `voip:` device endpoint and is not built yet.
3. Widgets:
   - Add a Widget Extension with `TodayWidget.swift` and `LiveTimerActivity.swift`.
   - Add the App Group `group.in.projecttracker.shared`.
   - Set `NSSupportsLiveActivities = YES`.

**Desktop**

- Windows toasts need the app installed (AppUserModelID `in.projecttracker.desktop`, already set) for buttons to show.
- macOS shows more than one action only when notifications are set to the "Alerts" style.

## Not done yet

- The phone web layer does not yet feed `WidgetBridge.set` or `LiveTimer.start`. The mini window shows the snapshot shape they expect.
- Windows inline reply needs a COM activator.
- "Ask Aura" opens the assistant tab with `?q=`. Prefilling the question from it is not wired.
