import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { meApi, pushApi } from '../../api/endpoints';
import type { NotificationPreference, TestEmailResult } from '../../api/types';
import { Icon } from '../../components/Icon';
import { PageLoader } from '../../components/ui';
import { queryClient } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { disableNativePush, enableNativePush, isNativeApp, nativeEndpoint, nativePermission } from '../../lib/native';
import { isDesktopApp } from '../../lib/desktop';

type Permission = 'granted' | 'denied' | 'default' | 'unsupported';
const currentPermission = (): Permission => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

const KEY = ['notification-prefs'];

const keyBytes = (b64: string) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

/**
 * Push on this device: the events ticked in the Desktop column also arrive when the app is closed (an installed app, or this browser),
 * through the browser's push service. Needs the service worker, which production builds register.
 */
function PushRow({ onPermission }: { onPermission: (p: Permission) => void }) {
  const [state, setState] = useState<'checking' | 'on' | 'off' | 'unsupported' | 'desktop-app'>('checking');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (isNativeApp()) { void nativePermission().then((p) => setState(p === 'granted' && nativeEndpoint() ? 'on' : 'off')); return; }
    // The Windows/Mac/Linux app's Chromium has no push service wired up (unlike the Android app's Firebase push), so subscribing here
    // always fails - rather than let someone hit that error, say so up front and point at the one place it does work.
    if (isDesktopApp()) { setState('desktop-app'); return; }
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { setState('unsupported'); return; }
    void navigator.serviceWorker.getRegistration().then(async (reg) => {
      if (!reg) { setState('unsupported'); return; }
      setState((await reg.pushManager.getSubscription()) ? 'on' : 'off');
    });
  }, []);
  const turnOn = async () => {
    setBusy(true);
    if (isNativeApp()) {
      try {
        const r = await enableNativePush((token) => pushApi.subscribeNative(token));
        if (r === 'on') { setState('on'); toast('Push is on for this phone. Events in the Desktop column now arrive even when the app is closed.'); }
        else if (r === 'blocked') toast('Notifications are blocked for this app. Allow them in Android Settings → Apps → Project Tracker → Notifications.', 'warning');
        else toast('Push is not set up in this build of the app.', 'warning');
      } finally { setBusy(false); }
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      onPermission(permission);
      if (permission !== 'granted') { toast('Notifications are blocked for this site. Allow them in the browser settings first.', 'warning'); return; }
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await pushApi.status();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
      const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      await pushApi.subscribe({ endpoint: json.endpoint, keys: json.keys });
      setState('on');
      toast('Push is on for this device. Events in the Desktop column now arrive even when the app is closed.');
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not turn on push for this device.', 'error'); }
    finally { setBusy(false); }
  };
  const turnOff = async () => {
    setBusy(true);
    if (isNativeApp()) { try { await disableNativePush((e) => pushApi.unsubscribe(e)); setState('off'); toast('Push is off for this phone.'); } finally { setBusy(false); } return; }
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) { await pushApi.unsubscribe(sub.endpoint); await sub.unsubscribe(); }
      setState('off');
      toast('Push is off for this device.');
    } catch { toast('Could not turn push off.', 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="setting-row">
      <div className="setting-info"><h4>Push on this device</h4>
        <p>{state === 'desktop-app' ? 'Not available in the installed desktop app yet. Open projecttracker.in in a browser tab on this computer to turn it on there.'
          : state === 'unsupported' ? 'Install the app (or use a browser that supports push) to get notifications while it is closed.'
          : state === 'on' ? 'On. Events ticked in the Desktop column arrive even when the app is closed.'
          : 'Get the events ticked in the Desktop column even when the app is closed.'}</p></div>
      {state === 'off' && <button className="btn btn-ghost" disabled={busy} onClick={() => void turnOn()}><Icon name="bell" /> Turn on</button>}
      {state === 'on' && <button className="btn btn-ghost" disabled={busy} onClick={() => void turnOff()}>Turn off</button>}
    </div>
  );
}

/** Which events reach me, and where: in the app, by e-mail, or as a desktop notification while the app is open. */
export function NotificationSettings() {
  const q = useQuery({ queryKey: KEY, queryFn: meApi.notificationPrefs });
  const [draft, setDraft] = useState<NotificationPreference[] | null>(null);
  const [permission, setPermission] = useState<Permission>(currentPermission());
  const [test, setTest] = useState<TestEmailResult | null>(null);

  useEffect(() => { if (q.data && !draft) setDraft(q.data); }, [q.data, draft]);
  const dirty = useMemo(() => !!draft && !!q.data && JSON.stringify(draft) !== JSON.stringify(q.data), [draft, q.data]);

  const save = useMutation({
    mutationFn: () => meApi.setNotificationPrefs(draft!.map(({ type, inApp, email, browser }) => ({ type, inApp, email, browser }))),
    onSuccess: (data) => { queryClient.setQueryData(KEY, data); setDraft(data); toast('Notification settings saved.'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not save your notification settings.', 'error'),
  });
  const sendTest = useMutation({
    mutationFn: meApi.testEmail,
    onSuccess: (r) => setTest(r),
    onError: (e) => setTest({ provider: '', delivered: false, message: e instanceof ApiError ? e.message : 'Could not send the test email.' }),
  });

  const change = (type: string, field: 'inApp' | 'email' | 'browser', value: boolean) =>
    setDraft((rows) => rows && rows.map((r) => (r.type === type ? { ...r, [field]: value, ...(field === 'inApp' && !value ? { browser: false } : {}) } : r)));

  const enableDesktop = async () => {
    if (typeof Notification === 'undefined') return;
    const result = await Notification.requestPermission();
    setPermission(result);
    if (result === 'granted') toast('Desktop notifications are allowed for this browser.');
    else if (result === 'denied') toast('Desktop notifications are blocked. Allow them in your browser\'s site settings.', 'warning');
  };

  if (q.isLoading || !draft) return <PageLoader />;
  const desktopReady = permission === 'granted';

  return (
    <div className="card mb-22">
      <div className="card-head"><div><h3>Notifications</h3><p>Choose which events reach you, and where.</p></div>
        <button className="btn btn-primary btn-sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending && <span className="spinner" />}Save changes</button></div>
      <div className="table-wrap"><table className="notif-table">
        <thead><tr><th>Event</th><th>In the app</th><th>Email</th><th>Desktop</th></tr></thead>
        <tbody>{draft.map((p) => (
          <tr key={p.type}>
            <td><div className="td-title">{p.label}</div><div className="td-sub">{p.description}</div></td>
            <td><input type="checkbox" aria-label={`${p.label}: in the app`} checked={p.inApp} disabled={p.locked} onChange={(e) => change(p.type, 'inApp', e.target.checked)} /></td>
            <td><input type="checkbox" aria-label={`${p.label}: email`} checked={p.email} disabled={p.locked} onChange={(e) => change(p.type, 'email', e.target.checked)} /></td>
            <td><input type="checkbox" aria-label={`${p.label}: desktop`} checked={p.browser && p.inApp} disabled={!desktopReady || !p.inApp} onChange={(e) => change(p.type, 'browser', e.target.checked)}
              title={desktopReady ? undefined : 'Allow desktop notifications first'} /></td>
          </tr>
        ))}</tbody>
      </table></div>

      <div className="card-body">
        <div className="setting-row">
          <div className="setting-info"><h4>Desktop notifications</h4>
            <p>{permission === 'unsupported' ? 'This browser does not support desktop notifications.'
              : permission === 'granted' ? 'Allowed. A pop-up appears while the app is open in a tab, for the events ticked in the Desktop column.'
              : permission === 'denied' ? 'Blocked for this site. Change it in your browser\'s site settings, then reload.'
              : 'Get a pop-up when something needs your attention, while the app is open in a tab.'}</p></div>
          {permission === 'default' && <button className="btn btn-ghost" onClick={() => void enableDesktop()}><Icon name="bell" /> Allow desktop notifications</button>}
          {permission === 'granted' && <span className="badge badge-success">Allowed</span>}
        </div>
        <PushRow onPermission={setPermission} />
        <div className="setting-row" style={{ alignItems: 'flex-start' }}>
          <div className="setting-info" style={{ flex: 1 }}><h4>Check that email works</h4>
            <p>Sends a test message to your address right now.</p>
            {test && <div className={test.delivered ? 'form-warn' : 'form-error'} role="status" style={{ marginTop: 10, marginBottom: 0 }}>{test.message}</div>}</div>
          <button className="btn btn-ghost" disabled={sendTest.isPending} onClick={() => { setTest(null); sendTest.mutate(); }}>{sendTest.isPending && <span className="spinner" />}<Icon name="mail" /> Send test email</button>
        </div>
      </div>
    </div>
  );
}
