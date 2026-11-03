/**
 * Getting the person's attention when something arrives: a sound that tells the kinds of alert apart, a flashing tab title, a buzz on
 * phones, and (in the desktop app) a flashing taskbar button. Everything here is generated in the browser - there are no sound files.
 *
 *  - "message": a quick two-note pop - chat messages and @mentions.
 *  - "update":  a rising three-note chime - assignments, comments, approvals, documents and the like.
 *  - "urgent":  the beacon, three bursts of a two-tone alarm - reminders, overdue work, SLA breaches and security alerts.
 */
import { desktopAttention } from './desktop';
import { gainOf, inQuietHours, shouldPlay } from './soundPolicy';

export type AttentionKind = 'message' | 'update' | 'urgent';

// ------------------------------------------------------------------ settings

const SOUND_KEY = 'pm_reminder_sound';   // the name the Reminders screen already used, so an existing choice carries over
export const soundOn = () => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; } };
export const setSoundOn = (on: boolean) => { try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* storage unavailable */ } };

/** The master volume for every cue on this device, 0–1 (Settings › Notifications › Sounds & alerts). */
const VOLUME_KEY = 'pm_sound_volume';
export const soundVolume = () => { try { const v = Number(localStorage.getItem(VOLUME_KEY)); return localStorage.getItem(VOLUME_KEY) === null || !Number.isFinite(v) ? 0.7 : Math.max(0, Math.min(1, v)); } catch { return 0.7; } };
export const setSoundVolume = (v: number) => { try { localStorage.setItem(VOLUME_KEY, String(Math.max(0, Math.min(1, v)))); } catch { /* storage unavailable */ } };

/** Quiet hours (Settings › Notifications › Schedule), told to us by the shell once they are loaded: no sounds inside them. */
let quietHours: { start: string | null; end: string | null; zone: string | null } = { start: null, end: null, zone: null };
export function setQuietHours(start: string | null, end: string | null, zone: string | null) { quietHours = { start, end, zone }; }
export function isQuietNow(now = new Date()): boolean {
  if (!quietHours.start || !quietHours.end) return false;
  let h = now.getHours(), m = now.getMinutes();
  try {
    if (quietHours.zone) {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: quietHours.zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
      h = Number(parts.find((p) => p.type === 'hour')?.value ?? h); m = Number(parts.find((p) => p.type === 'minute')?.value ?? m);
    }
  } catch { /* unknown zone: the device clock */ }
  return inQuietHours(quietHours.start, quietHours.end, h * 60 + m);
}

/** When a cue last played on this device - in any tab, so two open tabs do not double a burst. */
const LAST_KEY = 'pm_sound_last';
let lastLocal: number | null = null;
const lastPlayed = () => { try { const v = Number(localStorage.getItem(LAST_KEY)); return Number.isFinite(v) && v > 0 ? Math.max(v, lastLocal ?? 0) : lastLocal; } catch { return lastLocal; } };
const markPlayed = (at: number) => { lastLocal = at; try { localStorage.setItem(LAST_KEY, String(at)); } catch { /* storage unavailable */ } };

// ------------------------------------------------------------------ sound

let audio: AudioContext | null = null;
const context = () => {
  if (!audio) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    audio = new AC();
  }
  return audio;
};

const GESTURES = ['pointerdown', 'keydown', 'touchend', 'click'] as const;
let priming = false;

/**
 * Browsers only allow sound after the person has touched the page: get ready on a click, key press or tap. It keeps listening until the
 * sound is really allowed (a first tap that the browser did not count, or iOS suspending the sound when the app went to the background,
 * would otherwise leave a later ringtone silent), and gets ready again whenever the browser suspends it.
 */
export function primeSound() {
  if (priming || typeof window === 'undefined') return;
  priming = true;
  let listening = false;
  const off = () => { for (const g of GESTURES) window.removeEventListener(g, unlock, true); listening = false; };
  const on = () => { if (listening) return; listening = true; for (const g of GESTURES) window.addEventListener(g, unlock, { capture: true, passive: true }); };
  function unlock() {
    const c = context();
    if (!c) { off(); return; }
    // A silent, one-sample sound inside the gesture: Safari only lets a context make sound once it has played something from a gesture.
    try { const b = c.createBuffer(1, 1, 22050); const s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0); } catch { /* not needed elsewhere */ }
    void c.resume().then(() => { if (c.state === 'running') off(); }).catch(() => undefined);
    c.onstatechange = () => { if (c.state !== 'running') on(); };
  }
  on();
}

interface Note { freq: number; at: number; length: number; type: OscillatorType; volume: number; /** Glide to this pitch over the note (a whoosh). */ to?: number }

/** Two tones of the same pitch on top of each other would sound thin; every note is a pair slightly apart for a fuller sound. */
function play(notes: Note[], volume = soundVolume()) {
  const c = context();
  if (!c) return;
  const gainScale = gainOf(volume);
  if (gainScale <= 0) return;
  void c.resume().catch(() => undefined);
  const start = c.currentTime + 0.02;
  for (const n of notes) {
    for (const detune of [-6, 6]) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = n.type;
      osc.frequency.value = n.freq;
      if (n.to) { osc.frequency.setValueAtTime(n.freq, start + n.at); osc.frequency.exponentialRampToValueAtTime(n.to, start + n.at + n.length); }
      osc.detune.value = detune;
      gain.gain.setValueAtTime(0.0001, start + n.at);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, (n.volume / 2) * gainScale), start + n.at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + n.at + n.length);
      osc.connect(gain).connect(c.destination);
      osc.start(start + n.at);
      osc.stop(start + n.at + n.length + 0.05);
    }
  }
}

export const SOUNDS: Record<AttentionKind, Note[]> = {
  message: [
    { freq: 784, at: 0, length: 0.14, type: 'triangle', volume: 0.3 },
    { freq: 1318.51, at: 0.11, length: 0.28, type: 'triangle', volume: 0.3 },
  ],
  update: [
    { freq: 659.25, at: 0, length: 0.25, type: 'sine', volume: 0.26 },
    { freq: 880, at: 0.14, length: 0.25, type: 'sine', volume: 0.26 },
    { freq: 1174.66, at: 0.28, length: 0.5, type: 'sine', volume: 0.26 },
  ],
  // Three bursts of two alternating tones (low-high-low-high), like a siren: nothing else in the app sounds like it.
  urgent: [0, 0.6, 1.2].flatMap((burst) => [
    { freq: 1046.5, at: burst, length: 0.12, type: 'square' as const, volume: 0.22 },
    { freq: 1568, at: burst + 0.13, length: 0.12, type: 'square' as const, volume: 0.22 },
    { freq: 1046.5, at: burst + 0.26, length: 0.12, type: 'square' as const, volume: 0.22 },
    { freq: 1568, at: burst + 0.39, length: 0.12, type: 'square' as const, volume: 0.22 },
  ]),
};

/**
 * The Notification Centre's cues: short, quiet and told apart by shape, not loudness. All generated here (no audio files, nothing copyrighted).
 *  - message:  a soft three-note pop, rising (chat messages)
 *  - mention:  two bright notes, higher (someone @mentioned you)
 *  - meeting:  a gentle four-note chime (a meeting is starting)
 *  - reminder: two notes, falling (a reminder went off)
 *  - critical: two short bursts of a two-tone alert (a critical ticket, an SLA breach, a security alert)
 *  - task:     one soft, low note (work assigned to you)
 *  - sent:     a short upward whoosh (your reply went)
 */
export type Cue = 'message' | 'mention' | 'meeting' | 'reminder' | 'critical' | 'task' | 'sent';
export const CUES: Record<Cue, Note[]> = {
  message: [
    { freq: 880, at: 0, length: 0.09, type: 'triangle', volume: 0.2 },
    { freq: 1108.73, at: 0.075, length: 0.09, type: 'triangle', volume: 0.2 },
    { freq: 1318.51, at: 0.15, length: 0.22, type: 'triangle', volume: 0.2 },
  ],
  mention: [
    { freq: 1318.51, at: 0, length: 0.12, type: 'sine', volume: 0.28 },
    { freq: 1975.53, at: 0.1, length: 0.3, type: 'sine', volume: 0.26 },
  ],
  meeting: [
    { freq: 523.25, at: 0, length: 0.5, type: 'sine', volume: 0.18 },
    { freq: 659.25, at: 0.16, length: 0.5, type: 'sine', volume: 0.18 },
    { freq: 783.99, at: 0.32, length: 0.5, type: 'sine', volume: 0.18 },
    { freq: 1046.5, at: 0.48, length: 0.8, type: 'sine', volume: 0.18 },
  ],
  reminder: [
    { freq: 987.77, at: 0, length: 0.22, type: 'sine', volume: 0.26 },
    { freq: 783.99, at: 0.22, length: 0.4, type: 'sine', volume: 0.26 },
  ],
  critical: [0, 0.5].flatMap((burst) => [
    { freq: 1046.5, at: burst, length: 0.11, type: 'square' as const, volume: 0.18 },
    { freq: 1568, at: burst + 0.12, length: 0.11, type: 'square' as const, volume: 0.18 },
    { freq: 1046.5, at: burst + 0.24, length: 0.11, type: 'square' as const, volume: 0.18 },
  ]),
  task: [
    { freq: 587.33, at: 0, length: 0.16, type: 'sine', volume: 0.14 },
    { freq: 739.99, at: 0.09, length: 0.26, type: 'sine', volume: 0.12 },
  ],
  sent: [{ freq: 380, at: 0, length: 0.2, type: 'sine', volume: 0.12, to: 1400 }],
};

/** Plays one cue now, whatever the settings say (the settings' preview buttons; callers check the settings first). */
export function playCue(cue: Cue, volume?: number) { play(CUES[cue], volume); }

/** The ringtone of an incoming call: a two-tone ring, twice (about 2 seconds; the caller repeats it). */
const RING: Note[] = [0, 0.45].flatMap((at) => [
  { freq: 880, at, length: 0.18, type: 'sine' as const, volume: 0.32 },
  { freq: 1108.73, at: at + 0.2, length: 0.2, type: 'sine' as const, volume: 0.32 },
]);

/** Rings once (if sound is on). Returns whether it could be heard - false until the person has touched the page once. */
export function playRing(): boolean {
  if (!soundOn()) return false;
  play(RING);
  return audio?.state === 'running';
}

/** Lets the page make sound (call it from a click or tap). */
export function unlockSound() { void context()?.resume().catch(() => undefined); }

/** Plays one of the sounds, whatever the sound setting says (for the "test" buttons). */
export function playSound(kind: AttentionKind) { play(SOUNDS[kind]); }

// ------------------------------------------------------------------ title, buzz, taskbar

const BUZZ: Record<AttentionKind, number[]> = { message: [120, 60, 120], update: [160], urgent: [300, 100, 300, 100, 300, 100, 600] };

let pending = 0;
let flasher: number | undefined;
let baseTitle = '';

const away = () => document.hidden || !document.hasFocus();

function stopFlashing() {
  pending = 0;
  if (flasher !== undefined) { window.clearInterval(flasher); flasher = undefined; document.title = baseTitle; }
}

/** The tab title alternates with "🔔 (n) New activity" while the person is somewhere else, and goes back to normal when they return. */
function flashTitle() {
  pending += 1;
  if (flasher !== undefined) return;
  baseTitle = document.title;
  let on = false;
  flasher = window.setInterval(() => {
    if (!away()) { stopFlashing(); return; }
    on = !on;
    document.title = on ? `🔔 (${pending}) New activity` : baseTitle;
  }, 1000);
}

let listening = false;
function listenForReturn() {
  if (listening) return;
  listening = true;
  window.addEventListener('focus', stopFlashing);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && document.hasFocus()) stopFlashing(); });
}

// ------------------------------------------------------------------ one alert, once

const seen = new Map<string, number>();

/** True the first time a key is seen within `ttlMs`. The same event can arrive over the live connection, the poll and a push: it should ring once. */
export function firstTime(key: string, ttlMs = 60_000, now = Date.now()): boolean {
  for (const [k, at] of seen) if (now - at > ttlMs) seen.delete(k);
  if (seen.has(key)) return false;
  seen.set(key, now);
  return true;
}

/** Forgets what `firstTime` has seen (tests). */
export function resetSeen() { seen.clear(); }

export interface AttentionOptions {
  /** What kind of alert this is; decides the sound, the buzz and whether the desktop app flashes until the person comes back. */
  kind: AttentionKind;
  /** Skip the sound (a push that the browser already announces with its own sound). */
  silent?: boolean;
  /** The Notification Centre's cue for it (message, mention, meeting, reminder, critical) instead of the kind's sound. */
  cue?: Cue;
  /** lib/soundPolicy.ts: what the caller knows about it. */
  own?: boolean; viewingSame?: boolean; mutedChat?: boolean; mention?: boolean; dnd?: boolean; muted?: boolean;
  /** This category's Sound switch (default on). */
  categoryOn?: boolean;
}

/** True when a sound would actually be heard right now: switched on, and the browser has let this page make sound. */
export const canPlaySound = () => soundOn() && audio?.state === 'running';

/**
 * Gets the person's attention: sound (if they have it on), a buzz on phones, and a flashing title / taskbar button when they are elsewhere.
 * Returns whether the sound was played, so a caller that also shows a system notification knows whether that one has to make a sound itself.
 */
export function getAttention({ kind, silent, cue, ...why }: AttentionOptions): boolean {
  listenForReturn();
  const now = Date.now();
  const verdict = shouldPlay({ now, lastPlayedAt: lastPlayed(), masterOn: soundOn(), categoryOn: why.categoryOn ?? true, dnd: !!why.dnd, muted: !!why.muted,
    quiet: isQuietNow(), own: why.own, viewingSame: why.viewingSame, mutedChat: why.mutedChat, mention: why.mention });
  const playNow = !silent && verdict.play;
  // "Played" means it was heard: the OS notification then stays silent. A cue swallowed by a burst still counts (one sound for the burst).
  const sound = !silent && (playNow ? canPlaySound() : verdict.play === false && verdict.reason === 'coalesced' && canPlaySound());
  if (playNow) { markPlayed(now); if (cue) playCue(cue); else playSound(kind); }
  if (away()) {
    flashTitle();
    desktopAttention(kind === 'urgent');
    try { navigator.vibrate?.(BUZZ[kind]); } catch { /* not supported */ }
  }
  return sound;
}

const URGENT = new Set(['Reminder', 'Nudge', 'DueSoon', 'Overdue', 'ServiceLevel', 'Support', 'Security', 'SignInRequest']);
const CHAT = new Set(['Message', 'Mention']);

/** Which sound a kind of notification gets. */
export const kindForType = (type: string): AttentionKind => (URGENT.has(type) ? 'urgent' : CHAT.has(type) ? 'message' : 'update');
