import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { deviceLoginApi } from '../api/endpoints';
import { useAuth, useEntitlement } from '../stores/auth';
import { queryClient } from '../stores/auth';
import { ApprovePrompt } from '../features/auth/PhoneSignIn';
import { Icon } from './Icon';
import { haptic } from '../lib/mobile';

/**
 * A request to sign in somewhere else, shown at the top of the screen like a phone's live alert: a capsule that drops in and opens to the question,
 * with the three numbers right there. It only looks for requests for people whose plan includes the mobile app (nobody else can receive them), and
 * only while the app is visible; a notification brings the same question to a closed app.
 */
export function SignInIsland() {
  const wid = useAuth((s) => s.ctx?.current?.id);
  const admin = useAuth((s) => !!s.ctx?.user.isPlatformAdmin);
  const entitled = useEntitlement('MOBILE_APP') > 0;
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => { const f = () => setVisible(document.visibilityState === 'visible'); document.addEventListener('visibilitychange', f); return () => document.removeEventListener('visibilitychange', f); }, []);
  const q = useQuery({ queryKey: ['device-login', 'pending'], queryFn: deviceLoginApi.pending, enabled: !!wid && !admin && entitled && visible, refetchInterval: 6000, refetchIntervalInBackground: false });
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [open, setOpen] = useState(true);
  const item = (q.data ?? []).find((p) => !dismissed.includes(p.id));
  const [left, setLeft] = useState(0);
  useEffect(() => { if (!item) return; haptic([30, 60, 30]); setOpen(true); }, [item?.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!item) return;
    const tick = () => setLeft(Math.max(0, Math.round((Date.parse(item.expiresAt) - Date.now()) / 1000)));
    tick(); const t = setInterval(tick, 1000); return () => clearInterval(t);
  }, [item]);
  if (!item || left <= 0) return null;
  const finish = (id: string) => { setDismissed((d) => [...d, id]); void queryClient.invalidateQueries({ queryKey: ['device-login'] }); };
  return (
    <div className={`island ${open ? 'open' : ''}`} role="alertdialog" aria-label="Sign-in request">
      <button type="button" className="island-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="island-ico"><Icon name="shield" size={17} /></span>
        <span className="island-title"><b>Sign-in request</b><small>{item.device}</small></span>
        <span className="island-time">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>
      </button>
      {open && <div className="island-body"><ApprovePrompt item={item} compact onDone={() => finish(item.id)} /></div>}
    </div>
  );
}
