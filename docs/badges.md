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

- API (`ChatTests.cs`): arrive → +1 and own messages never count; muted → dot only, mention in muted counts, unmute counts all;
  hide (read) clears and the next message returns; read on one device sends `read` to my other connection and clears the count;
  mute is pushed to my other connections.
- Unit (`model.test.ts`): `totalBadge`.
- Screen (`scripts/verify-chat-stable-ui.mjs`): a message over a mocked SignalR hub puts `1` on the phone tab bar / `2` on the
  desktop sidebar and `(n)` in the title without reload; a muted chat adds only the dot; opening the chat clears it; a `read`
  event from another device clears the dot.
