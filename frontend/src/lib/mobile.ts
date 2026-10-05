import { useSyncExternalStore } from 'react';

/** Phones get the app's own mobile shell (tab bar, sheets); everything wider keeps the desktop layout. */
const PHONE = '(max-width: 768px)';

export const isMobileNow = () => typeof matchMedia !== 'undefined' && matchMedia(PHONE).matches;

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    (notify) => { const m = matchMedia(PHONE); m.addEventListener('change', notify); return () => m.removeEventListener('change', notify); },
    isMobileNow,
    () => false,
  );
}

/** A short tick under the finger where the device supports it (Android browsers); nowhere else does anything. */
export function haptic(ms = 8) {
  try { navigator.vibrate?.(ms); } catch { /* not supported */ }
}
