/**
 * "Send test notification" (Settings → Notifications → This device): the four links a desktop notification travels, each with a status the
 * person can read and, where it can be fixed here, a fix. Pure, so the wording is unit-tested (pushCheck.test.ts).
 *
 *  1. Permission    - the browser / OS lets Project Tracker show notifications.
 *  2. Subscription  - this browser holds a push sign-up (the desktop app and an open tab do not need one).
 *  3. Server        - the server knows this device and its push keys work.
 *  4. Delivery      - the push service accepted the test and this device showed it.
 */
import type { PushTestResult } from '../../api/endpoints.platform';

export type StepId = 'permission' | 'subscription' | 'server' | 'delivery';
export type StepState = 'ok' | 'fail' | 'warn' | 'skip' | 'wait';
export interface Step { id: StepId; label: string; state: StepState; detail: string; fix?: 'allow' | 'subscribe' | 'os' }

export const STEP_LABEL: Record<StepId, string> = { permission: 'Permission', subscription: 'Subscription', server: 'Server', delivery: 'Delivery' };

export interface CheckInput {
  where: 'browser' | 'desktop' | 'android';
  permission: NotificationPermission | 'unsupported';
  /** This browser holds a push subscription. */
  subscribed: boolean;
  /** No service worker / PushManager here (Safari tab, development build). */
  pushSupported: boolean;
  server: PushTestResult | null;
  /** The server call failed (with this message). */
  serverError?: string | null;
  /** The test arrived on screen here (service worker receipt, or the desktop app / page showed it). */
  shown: boolean | null;
}

export function checkSteps(i: CheckInput): Step[] {
  const steps: Step[] = [];
  const perm = i.permission;
  steps.push(perm === 'granted' ? { id: 'permission', label: STEP_LABEL.permission, state: 'ok', detail: 'Allowed.' }
    : perm === 'denied' ? { id: 'permission', label: STEP_LABEL.permission, state: 'fail', detail: 'Blocked. Allow notifications for this site from the lock icon left of the address, then reload.', fix: 'os' }
    : perm === 'unsupported' ? { id: 'permission', label: STEP_LABEL.permission, state: 'fail', detail: 'This browser cannot show notifications.' }
    : { id: 'permission', label: STEP_LABEL.permission, state: 'fail', detail: 'Not asked yet.', fix: 'allow' });
  const allowed = perm === 'granted';

  if (i.where === 'desktop') steps.push({ id: 'subscription', label: STEP_LABEL.subscription, state: 'skip', detail: 'Not needed: the desktop app shows notifications itself while it runs (also from the tray).' });
  else if (!i.pushSupported) steps.push({ id: 'subscription', label: STEP_LABEL.subscription, state: 'warn', detail: 'No push here, so notifications show only while a Project Tracker tab is open.' });
  else if (!allowed) steps.push({ id: 'subscription', label: STEP_LABEL.subscription, state: 'wait', detail: 'Waiting for permission.' });
  else steps.push(i.subscribed ? { id: 'subscription', label: STEP_LABEL.subscription, state: 'ok', detail: 'This device is signed up for push.' }
    : { id: 'subscription', label: STEP_LABEL.subscription, state: 'fail', detail: 'Not signed up for push.', fix: 'subscribe' });

  const s = i.server;
  if (i.serverError) steps.push({ id: 'server', label: STEP_LABEL.server, state: 'fail', detail: i.serverError });
  else if (!s) steps.push({ id: 'server', label: STEP_LABEL.server, state: 'wait', detail: 'Not checked yet.' });
  else if (!s.keysReady) steps.push({ id: 'server', label: STEP_LABEL.server, state: 'fail', detail: 'The server has no push keys.' });
  else if (i.where === 'desktop') steps.push({ id: 'server', label: STEP_LABEL.server, state: 'ok', detail: s.devices > 0 ? `Push keys ready; ${s.devices} other device${s.devices === 1 ? '' : 's'} signed up.` : 'Push keys ready.' });
  else if (i.subscribed && !s.thisDeviceKnown) steps.push({ id: 'server', label: STEP_LABEL.server, state: 'fail', detail: 'The server does not know this device (it forgot it, or it signed up with an older key).', fix: 'subscribe' });
  else steps.push({ id: 'server', label: STEP_LABEL.server, state: 'ok', detail: s.devices > 0 ? `Push keys ready; ${s.devices} device${s.devices === 1 ? '' : 's'} signed up.` : 'Push keys ready.' });

  const mine = s?.results.find((r) => r.thisDevice);
  if (!allowed) steps.push({ id: 'delivery', label: STEP_LABEL.delivery, state: 'wait', detail: 'Waiting for permission.' });
  else if (i.shown === true) steps.push({ id: 'delivery', label: STEP_LABEL.delivery, state: 'ok', detail: 'Shown on this device.' });
  else if (mine && !mine.accepted) steps.push({ id: 'delivery', label: STEP_LABEL.delivery, state: 'fail', detail: mine.message, fix: mine.status === 401 || mine.status === 403 || mine.status === 404 || mine.status === 410 ? 'subscribe' : undefined });
  else if (i.shown === false) steps.push({ id: 'delivery', label: STEP_LABEL.delivery, state: 'fail', detail: mine?.accepted ? 'The push service accepted it, but nothing appeared. Check Focus / Do Not Disturb and the system notification settings for your browser.' : 'Nothing appeared. Check Focus / Do Not Disturb and the system notification settings.', fix: 'os' });
  else steps.push({ id: 'delivery', label: STEP_LABEL.delivery, state: 'wait', detail: 'Not sent yet.' });
  return steps;
}

/** The one line under the steps: the first thing that is wrong, or that all is well. */
export function verdict(steps: Step[]): string {
  const bad = steps.find((s) => s.state === 'fail');
  if (bad) return `${bad.label}: ${bad.detail}`;
  if (steps.every((s) => s.state === 'ok' || s.state === 'skip' || s.state === 'warn')) return 'Desktop notifications work on this device.';
  return 'Press Send test notification to check every step.';
}
