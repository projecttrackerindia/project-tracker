import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { canPlaySound, firstTime, getAttention, kindForType, playSound, unlockSound, type AttentionKind } from '../../lib/attention';
import { isDesktopApp } from '../../lib/desktop';
import { useAuth } from '../../stores/auth';
import { deviceAlerts, enableDeviceAlerts, type DeviceAlerts } from '../reminders/device';

const ASKED_KEY = 'pm_alerts_prompt';   // "asked and answered" - the card is shown once per browser, not on every visit

/** A push the service worker just received while this page is open: it asks the page to play the sound and answers whether it did. */
interface PushMessage { type: 'pm-push'; kind?: AttentionKind; notificationType?: string; tag?: string }

/**
 * Makes sure the person actually gets notifications while they are in another tab or app:
 *  - when the browser already allows notifications, this device is signed up for push by itself (no need to find the setting);
 *  - otherwise a small card, once, asks them to turn notifications on (the click also lets the page play its alert sound);
 *  - when a push arrives and the page is open, the page plays the alert sound and flashes the tab, and tells the service worker so the
 *    system notification does not add a second sound.
 */
export function AlertsSetup() {
  const user = useAuth((s) => s.ctx?.user);
  const enabled = !!user && !user.isPlatformAdmin;
  const [state, setState] = useState<DeviceAlerts | null>(null);
  const [asked, setAsked] = useState(() => { try { return localStorage.getItem(ASKED_KEY) === '1'; } catch { return true; } });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void deviceAlerts().then(async (s) => {
      // Allowed, but not signed up for push yet (a new device, or an older version): sign up quietly.
      if (!cancelled && s === 'tab-only' && !isDesktopApp()) s = await enableDeviceAlerts();
      if (!cancelled) setState(s);
    });
    return () => { cancelled = true; };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent<PushMessage>) => {
      if (e.data?.type !== 'pm-push') return;
      const kind = e.data.kind ?? kindForType(e.data.notificationType ?? '');
      // The same alert can also arrive from the live connection or the check: ring once.
      const fresh = !e.data.tag || firstTime(`push-${e.data.tag}`, 30_000);
      const played = fresh && canPlaySound() ? getAttention({ kind }) : false;
      e.ports[0]?.postMessage({ played });
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [enabled]);

  const remember = () => { try { localStorage.setItem(ASKED_KEY, '1'); } catch { /* storage unavailable */ } setAsked(true); };
  const turnOn = async () => {
    unlockSound();
    remember();
    const s = await enableDeviceAlerts();
    setState(s);
    if (s === 'on' || s === 'tab-only') playSound('message');   // so they hear what an alert sounds like
  };

  const canAsk = typeof Notification !== 'undefined' && Notification.permission === 'default';
  if (!enabled || asked || !canAsk || state === 'unsupported' || state === 'blocked') return null;
  return (
    <div className="alerts-card" role="dialog" aria-label="Turn on notifications">
      <div className="alerts-ico"><Icon name="bell" size={18} /></div>
      <div className="alerts-main">
        <b>Don't miss messages and reminders</b>
        <span>Get a pop-up and a sound when something arrives while you are in another tab or app.</span>
        <div className="alerts-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void turnOn()}>Turn on</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={remember}>Not now</button>
        </div>
      </div>
    </div>
  );
}
