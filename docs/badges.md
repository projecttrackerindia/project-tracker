# Badges: how unread works

One model, one server number, every surface reads it. This page is the contract; the code points back here.

## The model

**Per conversation (direct and group chats):** unread = messages from *other people* created after *my read pointer*
(`ConversationMember.LastReadAt`), not counting system lines, deleted messages and thread replies (those raise a notice in the
bell instead). Project team chats keep their own counter (`/chat/projects/unread`, the icon on the project) and are not in the
Messages badge.

**The Messages total** (`GET /api/v1/chat/unread`):

| Conversation state | Adds to the number | Shows |
|---|---|---|
| Normal | every unread message | red number |
| Muted | only messages that **@mention me** | grey dot when it has other news and nothing else counts |
| Hidden ("until something new arrives") | nothing: hiding marks it read; the next message brings it back and counts | - |
| Left / removed | nothing (no membership) | - |

Response: `{ count, conversations, mutedMentions, mutedActivity }`. Two grouped SQL queries whatever the number of conversations
(unread per conversation and mute state, then mentions only for the muted ones).

The number is shown as `1`…`99`, then `99+`. No number and `mutedActivity` → a small grey dot.

## Where it shows

| Surface | Source |
|---|---|
| Sidebar, Together → Messages (desktop) | `useChatUnread()` (`features/chat/unreadBadge.ts`) → `Rail.tsx` |
| Phone tab bar, Messages | the same hook |
| Messages list rows (blue dot, "Unread N" filter) | `conversation.unread` from `/chat/conversations` |
| Bell, tab title `(3) …`, favicon dot, PWA `navigator.setAppBadge`, Electron dock/taskbar (`ptDesktop.setBadge`) | `totalBadge()` (`notifications/centre/model.ts`) via `BadgeSync` → `applyBadge()` |

`totalBadge` = the other notification categories (reminders, meetings, work) + for messages `max(message notices, chat unread)`.
Chat notices are one per conversation, so using the chat number makes the bell, the title and the app icon agree with the
Messages badge; the `max` keeps project-chat mentions and thread replies (notices that are not chat-unread) visible.

## Every notification on one sidebar place

Each unread notification counts on exactly **one** place in the sidebar (and the phone tab bar), so the places add up to the bell, the tab
title `(3)`, the PWA icon (`navigator.setAppBadge`) and the Electron dock / taskbar badge. The server decides
(`NotificationDestinations.Of` in `NotificationService.cs`) and sends `tabs` with `/notifications/counts`: unread per
`"destination:category"`; the client keeps the same rules in `features/notifications/centre/tabBadges.ts` (for optimistic updates and
older servers). Both are pinned by tests with the same table.

| Notification (type, link) | Place (sidebar `data-badge`) | Shows |
|---|---|---|
| `Meeting` (invites, changes, started), a `Reminder` linking `/meet?open=`, `/meetings?open=`, `/calls/meeting/` (starting soon) | Meetings (`meetings`) | red number |
| any link under `/mail` | Mail (`mail`) | red number; with none, the calm grey unread-mail count |
| a link to `/?tab=calendar` or `/calendar` | Calendar (`calendar`) | red number |
| `Message`, `Call`; a `Mention` in a chat (`/chat/…`, `/messages`, `?chat=1`) | Messages (`talk`) | `max(notices, unread chat messages)`; a muted chat adds only a grey dot unless it @mentions you |
| `Document`; any link under `/documents` or `/library` (shares, comments, reviews) | Library (`library`) | red number |
| `PortfolioDigest`; a link under `/portfolio` or with `view=portfolio` (action items needing review) | Portfolio (`portfolio`) | red number |
| `ServiceLevel`, `Support`; a link under `/desk` or `/operations` | Desk (`desk`) | red number; with none, the calm open-ticket count |
| `TaskAssigned`, `TaskUpdated` (change alerts), `Comment`, `Mention` elsewhere, `Issue`, `ProjectUpdated` | My Work (`work`) | red number; with none, the calm open-work count |
| everything else: `DueSoon`, `Overdue`, `Reminder`, `Nudge`, `Approval`, `TimesheetReminder`, `Security`, `Invitation`, `Subscription`, `ReportReady`, `Briefing`, agent alerts | Today (`home`) - the inbox | red number; with none, the calm "waiting on you" count |
| (the bell, Inbox) | all of the above | the sum |

Rules:
- **Red = notifications, grey = context.** A red number is unread notifications for that place and is in the total. A grey (calm) number
  is what is open there (open tasks, unread mail, open tickets); it is not a notification and is never in the total.
- **The total is the sum.** `totalBadge()` = `sumTabs(tabCounts())`. A category whose *Badge* switch is off (Settings › Notifications ›
  Sounds & alerts) leaves every place and the total.
- **Phone:** the four tabs (Today, Work, Messages, Projects) carry their own number; *More* carries the red numbers of the places inside it.
- **Reading clears it everywhere:** opening, marking read, or reading on another device (the hub's `notification` `{ read }` event) takes
  it off its place at once (`markReadLocally` adjusts `tabs` too), then the server's counts settle it.

## Real time

| Event | What happens |
|---|---|
| `message` (hub) from someone else, not the chat I am looking at | the cached number goes +1 (or the dot for a muted chat without a mention of me) and the row's unread +1 at once; then `/chat/unread` and the list are refetched to settle |
| I open a chat and its newest message is on screen (tab visible) | `POST /conversations/{id}/read` moves my pointer; the number drops locally first |
| `read` (hub) with `userId = me` | sent to all my connections when I read on another tab or device: that conversation's unread leaves every badge, then everything refetches |
| mute / unmute | server pushes `conversation` `{ conversationId, muted }` to my other connections; all recount |
| hide | marks the chat read (so it leaves the number) and hides it until something new arrives |
| tab shown, window focused, network back, page restored | `/chat/unread`, the list and the notification counts are asked again (a sleeping phone misses live events); also a 90s poll |

## Why the badge did not show (root causes fixed)

1. Reading on another device sent a `read` event, but the client only used it for read receipts of *other* people, so my own
   other devices never cleared their badge (and never re-counted).
2. Nothing re-asked after the phone woke up: `refetchOnWindowFocus` is off app-wide and an iOS web app's socket dies in the
   background, so a message that arrived meanwhile only showed after the 90s poll.
3. The Messages badge was drawn as a "calm" grey count, easy to miss beside red badges; it is a red number now (grey only for the
   muted-only dot).
4. The bell / title / app icon used the notification count (one notice per conversation) while the sidebar used the message count,
   so they disagreed; they now share `totalBadge`.
5. Muted conversations hid @mentions of me entirely; a mention now always counts.

## Tests

- API (`NotificationBadgeAndPushTestTests.cs`): every kind has one destination; `tabs` adds up to `unread`.
- Unit (`tabBadges.test.ts`): the same table client side, the sum equals the bell, badge switches, older servers, read and mark-all-read.
- Screen (`scripts/verify-notify-badges-ui.mjs`): a notification over the mocked hub lights My Work, Library and Meetings with no reload
  (1440) and the Work tab and More (390); `(3)` in the title; a read event from another device clears it.

- API (`ChatTests.cs`): arrive → +1 and own messages never count; muted → dot only, mention in muted counts, unmute counts all;
  hide (read) clears and the next message returns; read on one device sends `read` to my other connection and clears the count;
  mute is pushed to my other connections.
- Unit (`model.test.ts`): `totalBadge`.
- Screen (`scripts/verify-chat-stable-ui.mjs`): a message over a mocked SignalR hub puts `1` on the phone tab bar / `2` on the
  desktop sidebar and `(n)` in the title without reload; a muted chat adds only the dot; opening the chat clears it; a `read`
  event from another device clears the dot.
