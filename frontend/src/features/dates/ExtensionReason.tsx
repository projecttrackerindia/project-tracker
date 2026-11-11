import { lazy, Suspense, useEffect } from 'react';
import { create } from 'zustand';
import { setExtensionReasonHandler, type ExtensionAsk } from '../../api/client';

// The sheet's code (and the calm sheet's styles) load the first time a reason is asked for, so the shell's CSS order is unchanged.
const ReasonSheet = lazy(() => import('./ReasonSheet').then((m) => ({ default: m.ReasonSheet })));

/** Short reasons people pick most; one tap fills the field (still editable). */
export const QUICK_REASONS = ['Waiting on a dependency', 'Scope changed', 'Waiting on the client', 'Not enough people', 'Blocked by a bug'];

export interface Ask { what: string; from?: string | null; to?: string | null; message?: string; resolve: (reason: string | null) => void }
export const useAsk = create<{ ask: Ask | null; set: (a: Ask | null) => void }>((set) => ({ ask: null, set: (ask) => set({ ask }) }));

/**
 * Asks "Reason for extending" in the shared sheet and resolves with the reason, or null when cancelled. Use it before saving any change that
 * moves a start, due or end date later (pulling a date earlier needs no reason). Asks arriving while one is open wait their turn.
 */
let chain: Promise<unknown> = Promise.resolve();
export function askExtensionReason(o: { what?: string; from?: string | null; to?: string | null; message?: string } = {}): Promise<string | null> {
  const next = chain.then(() => new Promise<string | null>((resolve) => useAsk.getState().set({ what: o.what ?? 'date', from: o.from, to: o.to, message: o.message, resolve })));
  chain = next.catch(() => null);
  return next;
}

/** Whether moving `from` to `to` (yyyy-mm-dd) is an extension. A removed date counts only when `removalIsDelay`. */
export const isExtension = (from?: string | null, to?: string | null, removalIsDelay = false) =>
  !!from && (to ? to.slice(0, 10) > from.slice(0, 10) : removalIsDelay);

const dateIn = (b: Record<string, unknown>) => {
  for (const k of ['dueDate', 'endDate', 'startDate', 'plannedEnd', 'plannedStart', 'date', 'due', 'start']) if (typeof b[k] === 'string') return b[k] as string;
  const c = Array.isArray(b.changes) ? (b.changes[0] as Record<string, unknown> | undefined) : undefined;
  return c ? (typeof c.dueDate === 'string' ? c.dueDate : typeof c.startDate === 'string' ? c.startDate : null) : null;
};
const whatOf = (a: ExtensionAsk) => {
  const m = /the (.+?) is moving later|the (.+?) are moving later/i.exec(a.message);
  return m?.[1] ?? m?.[2] ?? 'date';
};

/** Mounted once in the shell: the sheet, and the API client's handler for 422 DATE_EXTENSION_REASON_REQUIRED. */
export function ExtensionReasonHost() {
  const ask = useAsk((s) => s.ask);
  useEffect(() => {
    setExtensionReasonHandler((a) => askExtensionReason({ what: whatOf(a), to: dateIn(a.body) }));
    return () => setExtensionReasonHandler(null);
  }, []);
  return ask ? <Suspense fallback={null}><ReasonSheet key={`${ask.what}:${ask.to ?? ''}`} ask={ask} /></Suspense> : null;
}

