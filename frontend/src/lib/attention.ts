/**
 * Getting the person's attention when something arrives: a sound that tells the kinds of alert apart, a flashing tab title, a buzz on
 * phones, and (in the desktop app) a flashing taskbar button. Everything here is generated in the browser - there are no sound files.
 *
 *  - "message": a quick two-note pop - chat messages and @mentions.
 *  - "update":  a rising three-note chime - assignments, comments, approvals, documents and the like.
 *  - "urgent":  the beacon, three bursts of a two-tone alarm - reminders, overdue work, SLA breaches and security alerts.
 */
import { desktopAttention } from './desktop';

export type AttentionKind = 'message' | 'update' | 'urgent';

// ------------------------------------------------------------------ settings

const SOUND_KEY = 'pm_reminder_sound';   // the name the Reminders screen already used, so an existing choice carries over
export const soundOn = () => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; } };
export const setSoundOn = (on: boolean) => { try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* storage unavailable */ } };

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

/** Browsers only allow sound after the person has touched the page once: get ready on the first click, key press or tap. */
export function primeSound() {
  const once = () => {
    void context()?.resume().catch(() => undefined);
    window.removeEventListener('pointerdown', once);
    window.removeEventListener('keydown', once);
  };
  window.addEventListener('pointerdown', once);
  window.addEventListener('keydown', once);
}

interface Note { freq: number; at: number; length: number; type: OscillatorType; volume: number }

/** Two tones of the same pitch on top of each other would sound thin; every note is a pair slightly apart for a fuller sound. */
function play(notes: Note[]) {
  const c = context();
  if (!c) return;
  void c.resume().catch(() => undefined);
  const start = c.currentTime + 0.02;
  for (const n of notes) {
    for (const detune of [-6, 6]) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = n.type;
      osc.frequency.value = n.freq;
      osc.detune.value = detune;
      gain.gain.setValueAtTime(0.0001, start + n.at);
      gain.gain.exponentialRampToValueAtTime(n.volume / 2, start + n.at + 0.015);
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
}

/** True when a sound would actually be heard right now: switched on, and the browser has let this page make sound. */
export const canPlaySound = () => soundOn() && audio?.state === 'running';

/**
 * Gets the person's attention: sound (if they have it on), a buzz on phones, and a flashing title / taskbar button when they are elsewhere.
 * Returns whether the sound was played, so a caller that also shows a system notification knows whether that one has to make a sound itself.
 */
export function getAttention({ kind, silent }: AttentionOptions): boolean {
  listenForReturn();
  const sound = !silent && canPlaySound();
  if (!silent && soundOn()) playSound(kind);
  if (away()) {
    flashTitle();
    desktopAttention(kind === 'urgent');
    try { navigator.vibrate?.(BUZZ[kind]); } catch { /* not supported */ }
  }
  return sound;
}

const URGENT = new Set(['Reminder', 'Nudge', 'DueSoon', 'Overdue', 'ServiceLevel', 'Security', 'SignInRequest']);
const CHAT = new Set(['Message', 'Mention']);

/** Which sound a kind of notification gets. */
export const kindForType = (type: string): AttentionKind => (URGENT.has(type) ? 'urgent' : CHAT.has(type) ? 'message' : 'update');
