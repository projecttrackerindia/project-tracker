# Meeting bot

Project Tracker's own bot for the project agent's live meetings. The API asks it to join a project's Google Meet or Microsoft Teams meeting; it joins as a guest
("Project Tracker Agent"), switches on Meet's live captions, sends who-said-what to the API as it is spoken, and posts the agent's
reminders in the meeting chat. It leaves when the call ends, when it has been alone for five minutes, or at the meeting's end + 30 minutes.

- The host has to **admit** the bot when it asks to join (Google requires that for guests).
- The transcript comes from Meet's captions, in the language the meeting's captions are set to.
- Everything that depends on the Meet page is in `src/meet.mjs`; `test/fake-meet.html` mirrors what it relies on. If Google changes the
  Meet screen, update the selectors there and the synthetic page with them.
- Microsoft Teams works the same way from `src/teams.mjs` and `test/fake-teams.html` (browser join as a guest, lobby, live captions from
  More › Language and speech, chat). `src/platform.mjs` picks the page from the link. `MEETBOT_ALLOWED_HOSTS` defaults to Meet and Teams
  (`meet.google.com,teams.microsoft.com,teams.live.com,teams.cloud.microsoft`); if you set it, include the Teams hosts.

## Our own calls (LiveKit)

For calls on our own media server (Project Tracker's built-in video calls) the API hands the worker the server's address and a pass for that
room in the agent's own name (`liveKitUrl`, `liveKitToken` on the job). There is no browser and no lobby: `src/livekit.mjs` joins with
`@livekit/rtc-node`, hears each person on their own audio track (so who said what is exact), cuts their speech at pauses and sends each piece
to the API (`/api/v1/agent/bot/<token>/speech`), which writes it down with the speech service. Without a speech service the pieces are kept
in one recording and transcribed with Whisper after the call. It reads and writes the call's chat (`lk.chat`) and leaves when the call ends,
when it is alone for five minutes, or at its time limit. Such a call needs about 60 MB and very little CPU, against about 550 MB for a
browser in a Meet or Teams call.

| Variable | Meaning |
| --- | --- |
| `MEETBOT_LIVEKIT_HOSTS` | Media servers the worker may join, e.g. `calls.projecttracker.in` (empty = any `wss://` address the API sends). |

`npm test` includes a real call against `livekit-server --dev` when `LIVEKIT_TEST_URL` is set (CI downloads the server).

## Speaking (voice suggestions)

A meeting scheduled with "Transcription + voice suggestions" sends the bot short lines to say out loud ("Before we wrap up: nobody owns the
release date yet."), each with its voice already made by the API's speech service (a WAV file). They come with the worker's poll
(`bots[].say: [{ text, audio }]`, at most four waiting); the written line is posted in the chat as well.

- **Our own calls:** the agent publishes its own microphone track the first time it speaks (a quiet notetaker never shows one) and plays
  the voice into it.
- **Google Meet and Teams:** with `voice` on the job, the page is given a microphone fed by a sound mixer (`VOICE_HOOK` in `src/voice.mjs`).
  The bot stays muted; to speak it turns the microphone on, plays the line and turns it off again. If the microphone cannot be switched
  on, the line stays in the chat only.
- A bot whose meeting chose "Transcription" refuses lines to say. `POST /bots/{id}/say { text, audio }` does the same outside worker mode.

## Run

| Variable | Meaning |
| --- | --- |
| `MEETBOT_SECRET` | Shared secret (16+ characters). The API sends it as `Authorization: Bearer …` (`Agent__MeetingBotSecret`). |
| `PORT` | HTTP port (8080). |
| `MEETBOT_WEBHOOK_HOSTS` | Hosts the bot may send transcripts to, e.g. `api.projecttracker.in` (empty = any https host). |
| `MEETBOT_MAX_BOTS` | Meetings at the same time (4). Each one is a Chromium, about 400 MB of memory. |
| `MEETBOT_ADMIT_TIMEOUT_MS` | How long to wait to be let in (10 minutes). |

Then point the API at it: `Agent__MeetingBotUrl=https://<bot service>` and `Agent__MeetingBotSecret=<same secret>`.

## Test

`npm test` runs a real bot against the synthetic Meet page (set `MEETBOT_CHROMIUM` to a Chromium binary, or `npx playwright install chromium`).

## Transcripts from audio (Whisper)

Besides the live captions, each bot records the call's incoming audio (WebRTC tracks mixed in the page, Opus/WebM on disk) and, when the
call ends, transcribes it with [faster-whisper](https://github.com/SYSTRAN/faster-whisper) on the CPU. Speakers are named from the captions
by time. The result is sent as `transcript.final` and replaces the caption transcript (meeting-chat lines are kept). The recording is
deleted right after.

| Variable | Meaning |
| --- | --- |
| `MEETBOT_WHISPER_MODEL` | `small` (default, built into the image), `base` (faster), `medium` (more accurate, slower), or `off`. |
| `MEETBOT_WHISPER_LANGUAGE` | Force a language (`en`, `hi`, `te`); empty = detect. |
| `MEETBOT_WHISPER_THREADS` | CPU threads for transcription (2). Calls are transcribed one at a time per worker. |
