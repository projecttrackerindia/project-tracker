import { Suspense, lazy, useEffect, useState } from 'react';
import { create } from 'zustand';

/** Open state of the Aura surface (the header ring, the phone ring, ⌘K / Ctrl K). */
export const useAuraSearch = create<{ open: boolean; context: string | null; about: string | null; show: (where?: { context: string | null; about: string | null } | null) => void; hide: () => void }>((set) => ({
  open: false, context: null, about: null,
  show: (where) => set({ open: true, context: where?.context ?? null, about: where?.about ?? null }),
  hide: () => set({ open: false }),
}));
export const toggleAuraSearch = (where?: { context: string | null; about: string | null } | null) => {
  const s = useAuraSearch.getState();
  if (s.open) s.hide(); else s.show(where);
};

const AuraSurface = lazy(() => import('./AuraSurface'));
/** How long the glow and the bar take to fade out after Esc, a tap outside or a swipe down. */
export const AURA_LEAVE_MS = 200;

/**
 * Aura invoked: the edge glow, the blurred page and one "Ask Aura or search…" bar, with answers and results floating above it
 * (AuraSurface, its own lazy chunk: nothing of it loads until the first time Aura is opened). Mounted once in the shell.
 */
export function AuraSearchHost() {
  const open = useAuraSearch((s) => s.open);
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    const t = window.setTimeout(() => setMounted(false), AURA_LEAVE_MS);
    return () => window.clearTimeout(t);
  }, [open]);
  if (!open && !mounted) return null;
  return <Suspense fallback={null}><AuraSurface leaving={!open} /></Suspense>;
}
