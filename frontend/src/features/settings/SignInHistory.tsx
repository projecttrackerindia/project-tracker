import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { meApi } from '../../api/endpoints';
import type { SignIn } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Badge, PageLoader } from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

const METHOD: Record<string, string> = {
  password: 'Password', 'password+mfa': 'Password + code', passkey: 'Passkey', device: 'Approved on phone', sso: 'Single sign-on',
  google: 'Google', microsoft: 'Microsoft', github: 'GitHub', apple: 'Apple',
};

/**
 * My sign-ins over the last 90 days: where each came from (browser and network), how, and whether it is still signed in. A new browser or
 * network is marked (an alert went out for it); "This wasn't me" ends that sign-in at once and takes me to change my password.
 */
export function SignInHistory() {
  const wid = useWorkspaceId();
  const nav = useNavigate();
  const q = useWsQuery(['sign-ins'], meApi.signIns);
  const [busy, setBusy] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  if (q.isLoading) return <PageLoader />;
  const rows = q.data ?? [];
  const shown = all ? rows : rows.slice(0, 8);

  const notMe = async (s: SignIn) => {
    if (!(await confirmDialog({ title: 'This wasn\'t you?', confirmText: 'End it and secure my account', danger: true,
      message: `${s.device}${s.network ? ` on network ${s.network}` : ''} will be signed out at once. Then change your password.` }))) return;
    setBusy(s.id);
    try {
      await meApi.notMe(s.id);
      toast('That sign-in was ended. Change your password now.', 'warning', { label: 'Change password', onClick: () => nav('/settings/profile?sub=security&change-password=1') });
      invalidateWorkspace(wid, 'sign-ins'); invalidateWorkspace(wid, 'sessions');
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not end that sign-in.', 'error'); }
    finally { setBusy(null); }
  };

  return (
    <div className="sih" role="list" aria-label="Sign-in history">
      {rows.length === 0 && <p className="muted">No sign-ins in the last 90 days.</p>}
      {shown.map((s) => (
        <div key={s.id} role="listitem" className={`sih-row ${s.reportedAt ? 'reported' : ''}`}>
          <span className={`sih-dot ${s.active ? 'on' : ''}`} aria-hidden />
          <div className="sih-main">
            <b>{s.device}{s.current && <Badge tone="success">This device</Badge>}{s.newDevice && !s.reportedAt && <Badge tone="warning">New</Badge>}{s.reportedAt && <Badge tone="danger">Reported</Badge>}</b>
            <small>
              <time dateTime={s.at} title={formatDateTime(s.at)}>{formatDateTime(s.at)}</time>
              {s.network ? ` · network ${s.network}` : ''} · {METHOD[s.authMethod ?? ''] ?? 'Password'} · {s.active ? `active ${timeAgo(s.lastSeenAt)}` : 'signed out'}
            </small>
          </div>
          {!s.current && !s.reportedAt && (
            <button type="button" className="btn btn-ghost btn-sm sih-notme" disabled={busy === s.id} onClick={() => void notMe(s)}>
              <Icon name="alert" size={13} /> This wasn't me
            </button>
          )}
        </div>
      ))}
      {rows.length > 8 && <button type="button" className="link-btn" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${rows.length}`}</button>}
    </div>
  );
}
