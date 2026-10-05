import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { ApiError } from '../../api/client';
import { pushApi } from '../../api/endpoints';
import { Badge, PageLoader } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { deviceAlerts, enableDeviceAlerts, onDeviceAlerts, type DeviceAlerts } from '../reminders/device';
import { useInstall } from '../../lib/pwa';
import { queryClient, useAuth, useEntitlement } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { orgHref } from '../../lib/orgPath';

/** This browser's push endpoint, which is how the server knows which device is being talked about. */
async function myEndpoint(): Promise<string | null> {
  try { const reg = await navigator.serviceWorker?.getRegistration(); return (await reg?.pushManager.getSubscription())?.endpoint ?? null; } catch { return null; }
}

function useAlerts() {
  const [state, setState] = useState<DeviceAlerts | null>(null);
  useEffect(() => { void deviceAlerts().then(setState); return onDeviceAlerts(setState); }, []);
  return [state, setState] as const;
}

function Qr({ url }: { url: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => { QRCode.toDataURL(url, { margin: 1, width: 220, color: { dark: '#1e1b4b', light: '#ffffff' } }).then(setSrc).catch(() => setSrc('')); }, [url]);
  return src ? <img className="ma-qr" src={src} width={132} height={132} alt="QR code that opens Project Tracker on a phone" /> : null;
}

/** Account → Mobile app: install on an Android phone, turn on push, and let the phone approve sign-ins. The whole page needs the Pro plan or above. */
export function MobileAppSection() {
  const allowed = useEntitlement('MOBILE_APP') > 0;
  const admin = useAuth((s) => !!s.ctx?.user.isPlatformAdmin);
  const inst = useInstall();
  const [alerts, setAlerts] = useAlerts();
  const [endpoint, setEndpoint] = useState<string | null>(null);
  useEffect(() => { void myEndpoint().then(setEndpoint); }, [alerts]);
  const status = useQuery({ queryKey: ['push-sign-in', endpoint], queryFn: () => pushApi.signInStatus(endpoint), enabled: allowed });
  const toggle = useMutation({
    mutationFn: (on: boolean) => pushApi.setSignIn(endpoint!, on),
    onSuccess: (d) => { queryClient.setQueryData(['push-sign-in', endpoint], d); toast(d.enabled ? 'This phone can now approve sign-ins.' : 'This phone no longer approves sign-ins.'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not change that.', 'error'),
  });
  const enable = async () => {
    const s = await enableDeviceAlerts(); setAlerts(s);
    setEndpoint(await myEndpoint());
    if (s === 'blocked') toast('Notifications are blocked for this site. Allow them in the browser settings.', 'warning');
  };
  const open = `${location.origin}${orgHref('/')}`;
  const d = status.data;

  if (admin) return null;
  return (
    <>
      <div className="card ma-hero mb-22">
        <div className="ma-hero-main">
          <span className="ma-app-icon"><img src="/icons/icon-192.png" alt="" width={56} height={56} /></span>
          <div>
            <h3>Project Tracker on your phone <Badge tone={allowed ? 'success' : 'warning'}>{allowed ? 'Included' : 'Pro plan'}</Badge></h3>
            <p>A full-screen app with its own icon, alerts that reach you when it is closed, and sign-in by tapping your phone. Free of charge on Pro, Business and Enterprise.</p>
          </div>
        </div>
        {!allowed && (
          <div className="ma-lock"><Icon name="lock" size={18} />
            <span>The mobile app starts on the <b>Pro</b> plan. Upgrade to install it and approve sign-ins from your phone.</span>
            <Link className="btn btn-primary btn-sm" to={orgHref('/settings/billing')}>See plans</Link></div>
        )}
      </div>

      <div className={`ma-steps ${allowed ? '' : 'locked'}`} aria-disabled={!allowed}>
        <section className="card ma-step">
          <span className="ma-n">1</span>
          <div className="ma-body">
            <h4>Install the app</h4>
            {inst.installed ? <p className="ok"><Icon name="checkCircle" size={16} /> Installed: you are using the app on this device.</p>
              : inst.platform === 'android' ? <>
                <p>{inst.canPrompt ? 'One tap adds Project Tracker to your home screen.' : 'In Chrome open the ⋮ menu and choose “Install app” (or “Add to Home screen”).'}</p>
                <button type="button" className="btn btn-primary" disabled={!allowed || !inst.canPrompt} onClick={() => void inst.install()}><Icon name="download" size={16} />Install on Android</button></>
              : inst.platform === 'ios' ? <p>In Safari tap <b>Share</b>, then <b>Add to Home Screen</b>. Alerts need iOS 16.4 or later and the app opened from the home screen.</p>
              : <><p>Scan this code with your Android phone to open Project Tracker, then choose “Install app”.</p><div className="ma-qr-row"><Qr url={open} /><code>{open}</code></div></>}
          </div>
        </section>

        <section className="card ma-step">
          <span className="ma-n">2</span>
          <div className="ma-body">
            <h4>Turn on alerts</h4>
            {alerts === 'on' ? <p className="ok"><Icon name="checkCircle" size={16} /> Alerts reach this device even when the app is closed.</p>
              : alerts === 'unsupported' ? <p>This browser cannot show alerts. Use Chrome on Android.</p>
              : alerts === 'blocked' ? <p>Alerts are blocked for this site. Allow notifications in the browser's site settings, then come back.</p>
              : <><p>Reminders, mentions and sign-in requests arrive as notifications.</p><button type="button" className="btn btn-primary" disabled={!allowed} onClick={() => void enable()}><Icon name="bell" size={16} />Allow alerts</button></>}
          </div>
        </section>

        <section className="card ma-step">
          <span className="ma-n">3</span>
          <div className="ma-body">
            <h4>Sign in with this phone</h4>
            <p>On a computer choose <b>Approve on my phone instead</b>, then tap the matching number here. No password to type.</p>
            {!allowed ? null : status.isLoading ? <PageLoader /> : !endpoint ? <p className="muted">Turn on alerts above first so this phone can receive the request.</p> : (
              <label className="ma-switch">
                <input type="checkbox" role="switch" checked={!!d?.enabled} disabled={toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} />
                <span className="ma-track"><i /></span><span>Approve sign-ins on this phone</span>
              </label>)}
            {allowed && d && d.signInDevices > 0 && <p className="muted ma-count">{d.signInDevices} {d.signInDevices === 1 ? 'device approves' : 'devices approve'} your sign-ins.</p>}
          </div>
        </section>
      </div>
    </>
  );
}
