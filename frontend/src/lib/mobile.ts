import { useSyncExternalStore } from 'react';

/** Phones get the app's own mobile shell (tab bar, sheets); everything wider keeps the desktop layout. */
const PHONE = '(max-width: 768px), (pointer: coarse) and (max-height: 500px)';

export const isMobileNow = () => typeof matchMedia !== 'undefined' && matchMedia(PHONE).matches;

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    (notify) => { const m = matchMedia(PHONE); m.addEventListener('change', notify); return () => m.removeEventListener('change', notify); },
    isMobileNow,
    () => false,
  );
}

/** A short tick under the finger where the device supports it (Android browsers); nowhere else does anything. */
export function haptic(ms: number | number[] = 8) {
  try { navigator.vibrate?.(ms); } catch { /* not supported */ }
}

/** A phone held upright (599px and narrower): the screens drawn for the phone (apple/s-mobile, s-phone) replace the desk layouts. */
const SMALL_PHONE = '(max-width: 599px)';
export function useIsSmallPhone(): boolean {
  return useSyncExternalStore(
    (notify) => { const m = matchMedia(SMALL_PHONE); m.addEventListener('change', notify); return () => m.removeEventListener('change', notify); },
    () => typeof matchMedia !== 'undefined' && matchMedia(SMALL_PHONE).matches,
    () => false,
  );
}
