import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { canPlaySound, playSound, unlockSound, type AttentionKind } from '../../lib/attention';
import type { NotificationCategory, NotificationType } from '../../api/types';
import { announce } from './centre/announce';
import { isDesktopApp } from '../../lib/desktop';
import { useAuth } from '../../stores/auth';
import { deviceAlerts, enableDeviceAlerts, type DeviceAlerts } from '../reminders/device';

const ASKED_KEY = 'pm_alerts_prompt';   // "asked and answered" - the card is shown once per browser, not on every visit

/** A push the service worker just received while this page is open: it asks the page to play the sound and answers whether it did. */
interface PushMessage { type: 'pm-push'; kind?: AttentionKind; notificationType?: string; tag?: string; call?: string | null; category?: NotificationCategory; link?: string }

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
      if (e.data.call) return;   // a ringing call: the incoming-call card rings and answers the worker itself
      // Its own cue, unless this category is muted here; the same alert can also arrive from the live connection or the check: ring once.
      const type = (e.data.notificationType || (e.data.kind === 'message' ? 'Message' : e.data.kind === 'urgent' ? 'Reminder' : 'TaskUpdated')) as NotificationType;
      const played = canPlaySound() ? announce({ id: e.data.tag || null, type, link: e.data.link ?? null, category: e.data.category }) : false;
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

  // Asked once per browser, on the first sign-in here. Allowed: never asked again. "Not now": never nagged again either - the switch stays
  // in Notification Center › Devices. Blocked or unsupported browsers are not asked at all.
  const canAsk = typeof Notification !== 'undefined' && Notification.permission === 'default';
  if (!enabled || asked || !canAsk || state === null || state === 'unsupported' || state === 'blocked' || state === 'on') return null;
  return (
    <div className="alerts-overlay" role="presentation">
      <div className="alerts-pop" role="dialog" aria-modal="true" aria-labelledby="alerts-title">
        <div className="alerts-pop-ico"><Icon name="bell" size={26} /></div>
        <h2 id="alerts-title">Turn on notifications?</h2>
        <p>Get a pop-up and a sound on this {isDesktopApp() ? 'computer' : 'browser'} - even in other apps - when something needs you:</p>
        <ul className="alerts-list">
          <li><Icon name="alarm" size={15} /> Your reminders and due dates</li>
          <li><Icon name="bolt" size={15} /> Operations: tickets assigned to you, SLA warnings, WhatsApp chats waiting for your team</li>
          <li><Icon name="message" size={15} /> Messages, mentions and meetings</li>
        </ul>
        <small>We ask only once on this browser. You can change it any time in Notification Center.</small>
        <div className="alerts-actions">
          <button type="button" className="btn btn-ghost" onClick={remember}>Not now</button>
          <button type="button" className="btn btn-primary" autoFocus onClick={() => void turnOn()}><Icon name="bell" size={15} /> Turn on</button>
        </div>
      </div>
    </div>
  );
}
