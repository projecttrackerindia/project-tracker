# Video calls on our own server

Project Tracker's calls run on our own media server (LiveKit, open source), on a machine of our own in Mumbai. Nothing goes through Google
Meet, Zoom or Teams, so the project agent joins **without the blockers** those have: no lobby, no "ask to join", no browser pretending to
be a person. Our server writes the agent its own pass into that one room, and it simply joins.

## What people get

- **Start a call** from a project (with the project's people, and optionally the agent) or from a chat (everyone in the chat is notified).
  A bar at the top of the app shows calls you can join.
- **Before joining**: a camera and microphone check, and a plain notice when the agent is in the call taking notes.
- **In the call**, laid out like Google Meet:
  - video tiles, or the person's initials in a coloured circle when their camera is off, with a ring around whoever is speaking
  - a muted-microphone mark by each name
  - round controls: microphone and camera, each with a device menu; present; raise hand; reactions; messages; red hang-up
- **Present your screen**: it takes the stage and everyone else moves to a strip beside it. The presenter sees "You are presenting to
  everyone" and a Stop button, not their own screen inside their screen.
- **Raise hand**:
  - hands show on the tile and in a list, numbered in the order they went up
  - your hand is lowered for you once you speak for a moment, as in Meet
  - the host can lower one hand or all of them
  - people who join later see hands that are already up
- **Reactions** 💖 👍 🎉 👏 😂 😮 😢 🤔 👎 float up the side with the sender's name. If one person sends a burst, only a few are shown.
- **Messages** in a panel beside the call. The agent reads them, so you can tell it things, and it can answer there.
- **The agent** has its own tile, marked "Taking notes". After the call its notes, minutes and follow-ups are in the project's Agent tab.
- **Host controls**: "End for everyone", which disconnects everyone; the agent then writes up its notes.
- **Phones**:
  - the app asks for the camera and microphone the first time (Android builds made after this change)
  - the screen stays awake during a call
  - resizing or turning the device does not drop the call

## How it fits together

```
 browser / app ──HTTPS──► projecttracker.in (API)      ◄──signed webhook── calls.<domain>
      │                     │  starts/ends rooms (signed API calls)               ▲
      │                     │  writes each person a pass for one room (6 h)       │
      └──WebSocket + UDP/TCP media────────────────────────────────────────────────┘
                                                                                  ▲
 meeting bot (agent) ──────── its own pass (identity agent:…) ────────────────────┘
```

- **Passes** are short-lived signed tokens for one room only. People join as `user:<id>` and the agent as `agent:<id>`; the agent is
  marked by that identity, which nobody can choose for themselves.
- **Webhook**: the media server tells the API who joined and left, signed with the shared key. Unsigned or altered requests are refused.
- **Hands and reactions** are small messages over the call. The media server stamps each with its real sender, so nobody can raise a
  hand as someone else. Nobody gets the right to rename themselves inside a call, which would let them put words in another person's
  mouth in the agent's notes.
- **The agent** (`apps/meetbot`, `src/livekit.mjs`):
  - listens to each person separately, so it knows exactly who said what
  - turns speech into text
  - posts and reads the call's messages
  - leaves when everyone else has gone
  - uses about 60 MB per call, against about 550 MB for a browser-based bot

## Setting it up

Once, in Cloud Shell, after the app is running:

```bash
cd ~/project-tracker/deploy/gcp && ./calls.sh
```

It asks for one DNS record, `calls.<domain>` → the address it prints, and does the rest:
- creates the server `pt-calls` (it has no Google account and no access to anything else in the project)
- creates the keys and keeps them in `~/.pt-gcp`
- sets up HTTPS, the media server, and the app's settings, then restarts the API and website

It is safe to run again. If you ever run `./3-env.sh` again, run `./calls.sh` after it.

**Firewall openings on `pt-calls`:**

| Port | What it is for |
| --- | --- |
| TCP 80, 443 | HTTPS: certificate and signalling |
| UDP 50000–60000 | the video and audio themselves |
| TCP 7881 | media over TCP, for networks that block UDP |
| UDP 3478, TCP 5349 | TURN, for the strictest networks |
| UDP 30000–40000 | TURN relays |

The media server's control port (7880) listens only on the machine itself, behind HTTPS.

## Running it

- **Logs**:
  - from Cloud Shell: `gcloud compute ssh pt-calls --zone asia-south1-a`
  - on the server: `sudo journalctl -u livekit -f` (media server) and `cd /opt/calls && sudo docker compose logs -f caddy` (HTTPS)
- **Certificate**: Caddy renews it by itself. A nightly check at 03:30 IST picks up the renewed one for TURN over TLS.
- **New media server version**:
  1. Change `LK_VERSION` and `LK_SHA256` in `deploy/gcp/calls/vm-startup.sh`. Use version 1.11 or later: older servers miss the end of
     a shared screen with current browsers.
  2. Run `./calls.sh`.

  CI tests the same version (`.github/workflows/ci.yml`), so change it there too.
- **Settings**: people per call (`MAX_PARTICIPANTS`, default 50) and server size (`CALLS_VM_TYPE`). Set them as variables before
  `./calls.sh`.

## Growing with more users

- **One server goes a long way.** The media server forwards streams; it does not mix them. Its load grows with streams forwarded:
  people in calls × the people each one sees. Small video calls with adaptive quality, where nobody receives more than they display, are
  light. Watch CPU for `pt-calls` in Cloud Monitoring and move up a size before it stays above about 70%:

  ```bash
  gcloud compute instances stop pt-calls --zone asia-south1-a
  gcloud compute instances set-machine-type pt-calls --zone asia-south1-a --machine-type e2-standard-4   # or c3-standard-4/8
  gcloud compute instances start pt-calls --zone asia-south1-a
  ```

  Calls in progress drop during the change, so do it at night.
- **Several servers.** LiveKit spreads rooms across servers that share a Redis. Add servers behind the same `calls.<domain>` and point
  them at one Redis (Memorystore). The app needs no change: it only knows the address.
- **The agent scales separately.** Each call with the agent takes one meeting-bot slot. Raise `MEETBOT_MAX_BOTS`, or run more
  meeting-bot workers: they all take jobs from the same queue (`apps/meetbot/README.md`).
- **Bandwidth is the main running cost.** Each person receives the streams they are shown. As a rough guide, a five-person video call
  sends a little under a gigabyte per person per hour, and audio-only far less. Check Google Cloud's current network pricing for Mumbai
  before planning.

## When something goes wrong

| What people see | What to check |
| --- | --- |
| No Call button | `Calls__Url`, `Calls__ApiKey` and `Calls__ApiSecret` (32+ characters) in the API settings: run `./calls.sh`. |
| "Could not join" | `https://calls.<domain>` must answer; `sudo systemctl status livekit` on `pt-calls`. |
| Joins, but no video or audio | Firewall rule `pt-calls`, especially UDP 50000–60000. On a strict office network, TCP 7881 or TURN 5349 is used instead. |
| Agent never appears | The meeting bot's `MEETBOT_LIVEKIT_HOSTS` must contain `calls.<domain>`; check the bot's log. |
| Who joined or left is not updated | The webhook: the media server log shows its calls to `https://<domain>/api/v1/calls/livekit`; the keys must match. |
| Website blocks the connection | `CALLS_ORIGIN` in `/opt/pt/.env` on `pt-app` (the website's security policy): run `./calls.sh`. |
