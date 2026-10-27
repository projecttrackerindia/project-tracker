import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { create } from 'zustand';

// ------------------------------------------------------------------ + New

/** The eight things + New makes. Task, Ticket (and in wave 2 every work kind) go to work items; the rest to their own places. */
export type NewType = 'task' | 'ticket' | 'bug' | 'project' | 'doc' | 'secret' | 'meeting' | 'reminder' | 'time';

/**
 * The project + New adds to when it was opened from one ("+ Add work" on a project page), and optionally which kind of project work it
 * starts on (a task, an issue, an action item).
 */
export interface NewProject { id: string; name: string; kind?: 'task' | 'issue' | 'action' }
export const useNewSheet = create<{ open: boolean; type: NewType | null; text: string; project: NewProject | null; show: (type?: NewType | null, text?: string, project?: NewProject | null) => void; close: () => void }>((set) => ({
  open: false, type: null, text: '', project: null,
  show: (type = null, text = '', project = null) => set({ open: true, type, text, project }),
  close: () => set({ open: false }),
}));
/** Opens + New from anywhere (the rail, the phone bar, the command palette, a page's own "New" button), optionally on a type, with words, and in a project. */
export const openNew = (type?: NewType | null, text?: string, project?: NewProject | null) => useNewSheet.getState().show(type ?? null, text ?? '', project ?? null);

/** What kind of thing the words describe, when nobody picked a type: the cheap rules first; the person can always tap another tile. */
export function guessType(text: string, allowed: (t: NewType) => boolean): NewType | null {
  const t = text.toLowerCase();
  if (!t.trim()) return null;
  const rules: [NewType, RegExp][] = [
    ['reminder', /\b(remind|reminder|don'?t forget|remember to)\b/],
    ['time', /\b(log(ged)?|spent|worked)\b.*\b\d+(\.\d+)?\s*(h|hrs?|hours?|m|mins?|minutes?)\b|\b\d+(\.\d+)?\s*(h|hrs?|hours?)\s+on\b/],
    ['meeting', /\b(meeting|meet with|call with|sync|stand-?up|catch-?up|schedule a|review call)\b/],
    ['secret', /\b(password|secret|api key|token|credential|ssh key|pin)\b/],
    ['project', /^\s*(new |start a |kick ?off )?project\b|\bproject for\b/],
    ['doc', /\b(doc|document|spec|brd|frd|policy|sop|runbook|write-?up|note on)\b/],
    ['bug', /\b(bug|defect|crash(es|ing)?|regression)\b/],
    ['ticket', /\b(down|outage|incident|broken|error|fails?|failing|bug|ticket|issue|request|not working|disconnected|timeout|critical|urgent|p1|sla)\b/],
  ];
  for (const [type, re] of rules) if (re.test(t) && allowed(type)) return type;
  return allowed('task') ? 'task' : allowed('ticket') ? 'ticket' : null;
}

// ------------------------------------------------------------------ Ask (⌘K)

/** The Spotlight-style Ask panel: the question, where the person was, and the toolbar field it springs from. */
export interface AskFrom { left: number; top: number; width: number; height: number }
export const useAskPanel = create<{ open: boolean; question: string; context: string | null; from: AskFrom | null; show: (question: string, context: string | null, from: AskFrom | null) => void; close: () => void }>((set) => ({
  open: false, question: '', context: null, from: null,
  show: (question, context, from) => set({ open: true, question, context, from }),
  close: () => set({ open: false }),
}));

// ------------------------------------------------------------------ the copilot

/** The copilot panel: open or not, and what it is about (a project, or the page it was opened on). */
export const useCopilot = create<{ open: boolean; about: string | null; show: (about?: string | null) => void; close: () => void }>((set) => ({
  open: false, about: null,
  show: (about = null) => set({ open: true, about }),
  close: () => set({ open: false }),
}));

const PLACE: [RegExp, string][] = [
  [/^\/work\/projects\/?$/, 'Projects'], [/^\/work/, 'Work'], [/^\/messages/, 'Messages'], [/^\/library\/vault/, 'the Vault'], [/^\/library/, 'Library'],
  [/^\/insights/, 'Insights'], [/^\/people/, 'People'], [/^\/settings/, 'Settings'], [/^\/$/, 'Home'],
];
const TAB: Record<string, string> = { tickets: 'Tickets', team: 'Team', calendar: 'Calendar', time: 'Time', reports: 'Reports', portfolio: 'Portfolio', mail: 'Mail', meetings: 'Meetings', chat: 'Chat' };

/** Where the person is, in words the assistant understands ("Work › Tickets"), so "what is overdue here?" means the right thing. */
export function pageContext(pathname: string, search: string): string | null {
  const place = PLACE.find(([re]) => re.test(pathname))?.[1];
  if (!place) return null;
  const q = new URLSearchParams(search);
  const tab = TAB[q.get('tab') ?? ''] ?? TAB[q.get('f') ?? ''] ?? TAB[q.get('view') ?? ''];
  return tab ? `${place} › ${tab}` : place;
}

// ------------------------------------------------------------------ tabs in the address

/**
 * A place's tab in the address (?tab=…), so Back, a reload and a shared link land on it. Switching tabs starts the tab afresh: the other
 * query values belong to the tab that was open.
 */
export function useTabParam<T extends string>(ids: readonly T[], fallback: T, param = 'tab'): [T, (t: T) => void] {
  const [params, setParams] = useSearchParams();
  const asked = params.get(param) as T | null;
  const tab = asked && ids.includes(asked) ? asked : fallback;
  return [tab, (t: T) => setParams(t === fallback ? {} : { [param]: t })];
}

// ------------------------------------------------------------------ saving as you go

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Saving as you go: `run(save)` shows "Saving…", then "Saved" for a moment (or "Not saved" when it failed and rethrows), for a SidePanel's
 * `state`. Several quick changes in a row show one "Saving…".
 */
export function useSaveState() {
  const [state, setState] = useState<SaveState>('idle');
  const pending = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const run = async <T,>(save: () => Promise<T>): Promise<T> => {
    pending.current++; setState('saving'); window.clearTimeout(timer.current);
    try {
      const r = await save();
      if (--pending.current === 0) { setState('saved'); timer.current = window.setTimeout(() => setState('idle'), 1800); }
      return r;
    } catch (e) { pending.current--; setState('error'); throw e; }
  };
  return { state, run };
}
