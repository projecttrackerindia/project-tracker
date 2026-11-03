# Notification sounds: subtle, short, rare

Every sound is synthesised in the browser with the Web Audio API (`lib/attention.ts`, `CUES`): no files, nothing copied, each under a
second. The decision to play is one pure function, `shouldPlay()` in `lib/soundPolicy.ts` (tested in `soundPolicy.test.ts`), asked by
`getAttention()` before every cue.

## The set

| Cue | For | Shape |
|---|---|---|
| `message` | a chat message | three soft rising triangle notes, 0.37 s |
| `mention` | someone @mentioned you (also in a muted chat) | two bright sine notes, higher - a little more distinct |
| `meeting` | a meeting is starting / an invite | a gentle four-note chime |
| `critical` | approval needed, security alert, SLA breach, support waiting, overdue | two short bursts of a two-tone alert - distinct, more urgent |
| `task` | a task assigned to you, other work | one soft low two-note sine, the quietest |
| `reminder` | a reminder went off | two falling notes |

The Work category's sound is off by default; the others are on.

## When a sound plays

1. Never for **your own actions** (your message, from here or another device).
2. Never for the **conversation you are looking at** (that chat open in a visible, focused window: it is read).
3. Never for a **muted chat**, unless it **@mentions you**.
4. Never during **Do Not Disturb**, **Mute all**, or **quiet hours** (Settings › Notifications › Schedule; the shell loads them at start).
5. Never when that **category's Sound** switch is off, or all sounds are off on this device.
6. **Bursts coalesce:** at most one sound every 2.5 s, across all open tabs of this browser (the last play time is shared through
   `localStorage`). Ten messages in a burst are one sound.
7. **One sound per alert:** when the page plays its cue, the system notification it shows is silent; when the page cannot (hidden, sound
   not yet allowed by the browser, or a burst already sounded) the operating system plays its own notification sound instead. The same holds
   for push: the service worker asks the open page, and makes the system notification silent only if the page played.

## Settings (Settings › Notifications › This device › Sounds & alerts)

- Per category: Sound, Banner, Badge (this device) and Push (your account).
- **Volume**: one master volume for every cue (0-100 %, default 70 %, gentle curve), with **Preview**; each cue has its own preview button.
- Mute all (1 hour, until tomorrow, until switched back on) and Do Not Disturb.
