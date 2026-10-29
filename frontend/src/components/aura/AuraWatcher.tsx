import { useEffect } from 'react';
import { timeApi } from '../../api/endpoints';
import { useWsQuery } from '../../lib/hooks';
import { useModule } from '../../stores/auth';
import { followCaret, kickAll } from './auraEngine';
import { setAuraMood } from './mood';
import './aura.css';

const IDLE_MS = 2 * 60_000;
const isPrivate = (el: Element | null) => !!el && (el.matches('input[type="password"], [autocomplete="current-password"], [autocomplete="new-password"], [data-vault], [data-secret]') || !!el.closest('[data-vault], [data-secret]'));
const isAuraField = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement => !!el && el.matches('input[data-aura-input], textarea[data-aura-input]');

/**
 * Sets Aura's ambient moods for the whole app, mounted once in the layout: resting after 2 minutes without input (sleep), offline, focus
 * while a timer runs, privacy while a password or vault field is focused, listening (with the highlight on the caret and a pulse per key)
 * while someone types in an Aura field. Also draws the page-edge glow used while Aura changes things (html.aura-acting).
 */
export function AuraWatcher() {
  const [mTasks, mWork] = [useModule('tasks'), useModule('work')];
  const timer = useWsQuery(['timer'], timeApi.running, { enabled: mTasks > 0 || mWork > 0, refetchInterval: 60_000 });
  const running = !!timer.data;
  useEffect(() => { setAuraMood('timer', running ? 'focus' : null); }, [running]);

  useEffect(() => {
    let idle: number | undefined;
    const wake = () => { setAuraMood('idle', null); window.clearTimeout(idle); idle = window.setTimeout(() => setAuraMood('idle', 'sleep'), IDLE_MS); };
    const net = () => setAuraMood('net', navigator.onLine === false ? 'offline' : null);
    const focusIn = (e: FocusEvent) => {
      const el = e.target as Element | null;
      setAuraMood('privacy', isPrivate(el) ? 'privacy' : null);
      if (isAuraField(el)) { setAuraMood('field', 'listen'); followCaret(el); }
    };
    const focusOut = (e: FocusEvent) => {
      const el = e.target as Element | null;
      if (isPrivate(el)) setAuraMood('privacy', null);
      if (isAuraField(el)) { setAuraMood('field', null); followCaret(null); }
    };
    const key = () => {
      wake();
      const el = document.activeElement;
      if (isAuraField(el) && !isPrivate(el)) { kickAll(.25); window.requestAnimationFrame(() => followCaret(el)); }
    };
    const evs: (keyof WindowEventMap)[] = ['pointerdown', 'pointermove', 'wheel', 'touchstart'];
    evs.forEach((n) => window.addEventListener(n, wake, { passive: true }));
    window.addEventListener('keydown', key, true);
    window.addEventListener('online', net); window.addEventListener('offline', net);
    document.addEventListener('focusin', focusIn); document.addEventListener('focusout', focusOut);
    wake(); net();
    return () => {
      window.clearTimeout(idle);
      evs.forEach((n) => window.removeEventListener(n, wake));
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('online', net); window.removeEventListener('offline', net);
      document.removeEventListener('focusin', focusIn); document.removeEventListener('focusout', focusOut);
      ['idle', 'net', 'privacy', 'field', 'timer'].forEach((s) => setAuraMood(s, null));
    };
  }, []);
  return <div className="aura-edge" aria-hidden="true" />;
}
