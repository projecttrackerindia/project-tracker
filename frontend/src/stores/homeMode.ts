import { create } from 'zustand';

/**
 * Which Home the person chose: Classic (the tabs) or AI-first, where Home is the assistant itself (ask, answers and history on Home; the
 * other agent pages under Agents). Remembered in this browser; Classic when storage is unavailable.
 */
const KEY = 'pm_home_mode';
const read = () => { try { return localStorage.getItem(KEY) === 'ai'; } catch { return false; } };

export const useHomeMode = create<{ aiFirst: boolean; setAiFirst: (on: boolean) => void }>((set) => ({
  aiFirst: read(),
  setAiFirst: (on) => { try { localStorage.setItem(KEY, on ? 'ai' : 'classic'); } catch { /* private window: this visit only */ } set({ aiFirst: on }); },
}));
