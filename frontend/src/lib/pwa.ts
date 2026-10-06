import { useEffect, useState } from 'react';
import { isNativeApp } from './native';

/** The browser's "install this app" offer (Android Chrome, Edge, desktop Chrome), kept from the moment it arrives until it is used. */
interface InstallEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
let offer: InstallEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); offer = e as InstallEvent; tell(); });
  window.addEventListener('appinstalled', () => { installed = true; offer = null; tell(); });
}

export const isStandalone = () => typeof matchMedia !== 'undefined' && (matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true);
export type Platform = 'android' | 'ios' | 'desktop';
export const platform = (): Platform => /android/i.test(navigator.userAgent) ? 'android' : /iphone|ipad|ipod/i.test(navigator.userAgent) ? 'ios' : 'desktop';

/** What can be done about installing the app on this device right now. */
export function useInstall() {
  const [, force] = useState(0);
  useEffect(() => { const l = () => force((n) => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  return {
    platform: platform(),
    installed: installed || isStandalone() || isNativeApp(),
    canPrompt: offer !== null,
    install: async () => {
      if (!offer) return false;
      await offer.prompt();
      const { outcome } = await offer.userChoice;
      if (outcome === 'accepted') { offer = null; tell(); }
      return outcome === 'accepted';
    },
  };
}
