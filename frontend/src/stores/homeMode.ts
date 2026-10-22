import { create } from 'zustand';

/**
 * Which Home the person sees: AI-first by default, where Home is the assistant itself (ask, answers and history on Home; the other agent
 * pages under Agents), or Classic (the tabs) once they choose it. The choice is remembered in this browser. Workspaces without AI always
 * get Classic (the page checks that).
 */
const KEY = 'pm_home_mode';
const read = () => { try { return localStorage.getItem(KEY) !== 'classic'; } catch { return true; } };

export const useHomeMode = create<{ aiFirst: boolean; setAiFirst: (on: boolean) => void }>((set) => ({
  aiFirst: read(),
  setAiFirst: (on) => { try { localStorage.setItem(KEY, on ? 'ai' : 'classic'); } catch { /* private window: this visit only */ } set({ aiFirst: on }); },
}));
