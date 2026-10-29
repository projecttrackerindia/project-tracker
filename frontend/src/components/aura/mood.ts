import { create } from 'zustand';
import type { AuraMood } from './auraEngine';

/**
 * Aura's mood for the whole app, so any feature can set it. Several things can hold a mood at once (the chat is thinking, a password field
 * is focused, a focus timer runs); the one with the highest priority shows. A flash (done, sorry, good morning) shows for a moment on top.
 *
 * Priorities: 0 ambient (sleep, offline, focus) · 1 attention (alert) · 2 input (listen, privacy) · 3 activity (think, work) · 4 flash.
 */
interface Hold { mood: AuraMood; prio: number; at: number }
interface AuraMoodStore {
  holds: Record<string, Hold>;
  flash: { mood: AuraMood; until: number } | null;
  mood: AuraMood;
  set: (source: string, mood: AuraMood | null, prio?: number) => void;
  flashMood: (mood: AuraMood, ms?: number) => void;
}

const PRIO: Partial<Record<AuraMood, number>> = { sleep: 0, offline: 0, focus: 0, alert: 1, listen: 2, privacy: 2, think: 3, work: 3 };
const pick = (holds: Record<string, Hold>, flash: AuraMoodStore['flash']): AuraMood => {
  if (flash && flash.until > Date.now()) return flash.mood;
  let best: Hold | null = null;
  for (const h of Object.values(holds)) if (!best || h.prio > best.prio || (h.prio === best.prio && h.at > best.at)) best = h;
  return best?.mood ?? 'calm';
};

let flashTimer: number | undefined;
export const useAuraMood = create<AuraMoodStore>((set, get) => ({
  holds: {}, flash: null, mood: 'calm',
  set: (source, mood, prio) => {
    const holds = { ...get().holds };
    if (mood) {
      if (holds[source]?.mood === mood) return;
      holds[source] = { mood, prio: prio ?? PRIO[mood] ?? 1, at: Date.now() };
    } else if (!(source in holds)) return;
    else delete holds[source];
    set({ holds, mood: pick(holds, get().flash) });
  },
  flashMood: (mood, ms = 2200) => {
    const flash = { mood, until: Date.now() + ms };
    set({ flash, mood: mood });
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => set((s) => ({ flash: null, mood: pick(s.holds, null) })), ms);
  },
}));

/** Hold a mood for `source` (null releases it). */
export const setAuraMood = (source: string, mood: AuraMood | null, prio?: number) => useAuraMood.getState().set(source, mood, prio);
/** Show a mood for a moment: done (happy), a milestone (celebrate), an error (sad / warn), check-in (morning), check-out (evening). */
export const flashAura = (mood: AuraMood, ms?: number) => useAuraMood.getState().flashMood(mood, ms);
