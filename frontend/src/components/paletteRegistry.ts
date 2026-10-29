import { useSyncExternalStore } from 'react';
import type { IconName } from './Icon';

/** Commands a screen adds to ⌘K while it is open (the Plan sheet's Paste, Export, Present…). Shown first, under the screen's name. */
export interface PaletteExtra { id: string; group: string; label: string; hint?: string; icon: IconName; keywords?: string; run: () => void }
let extras: PaletteExtra[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());
export function registerPaletteCommands(owner: string, list: PaletteExtra[]) {
  extras = [...extras.filter((x) => !x.id.startsWith(`${owner}:`)), ...list.map((x) => ({ ...x, id: `${owner}:${x.id}` }))];
  emit();
  return () => { extras = extras.filter((x) => !x.id.startsWith(`${owner}:`)); emit(); };
}
export const usePaletteExtras = () => useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => extras, () => extras);
