import { create } from 'zustand';

export type CelebrationKind = 'signin' | 'verified' | 'register';

export interface Celebration {
  id: number;
  kind: CelebrationKind;
  /** Who to greet (first name). */
  name?: string;
  /** One line of real context: the workspace being opened, or the address a verification link went to. */
  detail?: string;
  /** Viewport point the curtain opens from (the button that was pressed); the screen centre when absent. */
  origin?: { x: number; y: number };
  /**
   * Called exactly once, while the curtain fully covers the screen: swap the page underneath here (navigate into the
   * app, show the next step). The curtain then lifts to reveal it.
   */
  onHandoff: () => void;
}

interface CelebrationState {
  current: Celebration | null;
  start: (c: Omit<Celebration, 'id'>) => void;
  finish: (id: number) => void;
}

let seq = 0;

/**
 * The full-screen success moment after signing in or creating an account (rendered once, at the app root, by
 * SuccessCurtain). It lives outside the auth pages on purpose: those pages unmount the moment the route changes, and the
 * curtain has to stay up across that change so the app can load underneath it and be revealed, not jump-cut to.
 */
export const useCelebration = create<CelebrationState>((set, get) => ({
  current: null,
  start: (c) => set({ current: { ...c, id: ++seq } }),
  finish: (id) => { if (get().current?.id === id) set({ current: null }); },
}));

export const celebrate = (c: Omit<Celebration, 'id'>) => useCelebration.getState().start(c);

/** Centre of the first element matching `selector`, in viewport pixels, for `origin`. */
export function originOf(selector: string): { x: number; y: number } | undefined {
  const el = document.querySelector(selector);
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** "Prasanna Krishna" -> "Prasanna"; empty when there is nothing usable. */
export const firstName = (displayName?: string | null) => (displayName ?? '').trim().split(/\s+/)[0] ?? '';
