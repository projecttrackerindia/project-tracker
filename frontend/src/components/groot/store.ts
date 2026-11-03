import { create } from 'zustand';
import type { AiAction, AiMessage, AiPlanStep } from '../../features/ai/aiApi';

/** One step Aura took while answering ("Reading WT-12…", "Creating ticket…"), from the stream's tool events. */
export interface GrootStep { id: string; label: string; state: 'running' | 'done' | 'failed' }
export interface GrootTurn {
  id: string; q: string; text: string; message: AiMessage | null; actions: AiAction[]; steps: GrootStep[]; plan: AiPlanStep[];
  error: string | null; streaming: boolean;
}

/**
 * The Aura chat: open or not, what it is about (a project or the page), the conversation of this session (kept while the panel is closed
 * and opened again), and a question waiting to be asked when it opens.
 */
interface GrootStore {
  open: boolean; /** Opened from the floating capsule: the answer card above it, not the side panel. */ card: boolean; about: string | null; context: string | null; conversationId: string | null; turns: GrootTurn[];
  pending: { text: string; ts: number } | null;
  show: (question?: string | null, context?: string | null, about?: string | null, card?: boolean) => void;
  close: () => void;
  reset: () => void;
  take: () => string | null;
  setConversation: (id: string | null) => void;
  update: (fn: (turns: GrootTurn[]) => GrootTurn[]) => void;
}

export const useGroot = create<GrootStore>((set, get) => ({
  open: false, card: false, about: null, context: null, conversationId: null, turns: [], pending: null,
  show: (question, context = null, about = null, card = false) => set((s) => ({
    open: true, card, context, about,
    pending: question?.trim() ? { text: question.trim(), ts: Date.now() } : s.pending,
  })),
  close: () => set({ open: false }),
  reset: () => set({ turns: [], conversationId: null, pending: null }),
  take: () => { const p = get().pending; if (p) set({ pending: null }); return p?.text ?? null; },
  setConversation: (id) => set({ conversationId: id }),
  update: (fn) => set((s) => ({ turns: fn(s.turns) })),
}));

/** Opens Aura from anywhere, optionally with a question to ask straight away. */
export const openGroot = (question?: string | null, context?: string | null, about?: string | null) => useGroot.getState().show(question, context, about);

/**
 * Aura invoked (⌘K, the "Aura ⌘K" hint, the phone's orb): the edge glow and the floating capsule are up. Nothing of Aura takes space at
 * rest; this is the only switch.
 */
export const useAuraInvoke = create<{ open: boolean; draft: string | null; show: (draft?: string) => void; hide: () => void; takeDraft: () => string | null }>((set, get) => ({
  open: false, draft: null,
  show: (draft) => set({ open: true, ...(draft != null ? { draft } : {}) }),
  hide: () => set({ open: false }),
  takeDraft: () => { const d = get().draft; if (d != null) set({ draft: null }); return d; },
}));
export const invokeAura = () => useAuraInvoke.getState().show();
/** Puts Aura away: the capsule, the glow and the answer card (the side panel, when that is what is open, stays). */
export const dismissAura = () => { useAuraInvoke.getState().hide(); if (useGroot.getState().card) useGroot.getState().close(); };
