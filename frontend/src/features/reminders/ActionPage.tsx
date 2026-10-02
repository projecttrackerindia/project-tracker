import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { BrandMark } from '../../components/BrandMark';
import { Icon } from '../../components/Icon';
import { useAuth } from '../../stores/auth';
import { reminderApi, type ReminderActionInfo, type SnoozePreset } from './api';
import { describeInstant } from './time';

/**
 * Where the links in reminder e-mails and push notifications lead: done or snooze with one press, no sign-in needed - the link's
 * one-time key is enough, and it works once. Signed in, the reminder (and its work) is one more click away.
 */
export function ReminderActionPage() {
  const { token = '' } = useParams();
  const signedIn = useAuth((s) => !!s.ctx);
  const [info, setInfo] = useState<ReminderActionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    reminderApi.actionInfo(token).then(setInfo).catch(() => setInfo({ valid: false } as ReminderActionInfo));
  }, [token]);

  const act = async (action: 'done' | 'snooze', preset?: SnoozePreset) => {
    setBusy(true); setError(null);
    try {
      const next = await reminderApi.act(token, action, preset);
      setInfo(next);
      setMessage(action === 'done' ? 'Done. Nice work.' : `Snoozed until ${next.nextFireAt ? describeInstant(next.nextFireAt) : 'later'}.`);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'That did not work. Try again in the app.'); }
    finally { setBusy(false); }
  };

  const state = info?.state;
  return (
    <div className="auth-shell"><div className="auth-card ra-page">
      <div className="ra-page-brand"><span className="brand-mark"><BrandMark /></span> Project Tracker{info?.workspace && <span className="muted"> · {info.workspace}</span>}</div>
      {!info ? <div className="ra-page-loading"><span className="spinner" /></div> : !info.title ? (
        <>
          <div className="ra-page-ico off"><Icon name="alarm" size={28} /></div>
          <h1 className="auth-title">This link is no longer valid</h1>
          <p className="auth-sub">Reminder links work once and for a week. Your reminders are all in the app.</p>
        </>
      ) : (
        <>
          <div className={`ra-page-ico ${state === 'Done' ? 'done' : ''}`}><Icon name={state === 'Done' ? 'checkCircle' : 'alarm'} size={28} /></div>
          <h1 className="auth-title">{info.title}</h1>
          {(info.note || info.targetKey) && <p className="auth-sub">{info.note ?? info.targetKey}</p>}
          {!message && <p className="ra-page-state">
            {state === 'Done' ? 'Finished.' : state === 'Cancelled' ? 'Dismissed.' : info.isSnoozed && info.nextFireAt ? `Snoozed until ${describeInstant(info.nextFireAt)}.` : state === 'Fired' ? 'Waiting for you now.' : info.nextFireAt ? `Next: ${describeInstant(info.nextFireAt)}.` : ''}
          </p>}
          {message && <div className="form-success" role="status">{message}</div>}
          {error && <div className="form-error" role="alert">{error}</div>}
          {info.valid && state !== 'Done' && state !== 'Cancelled' && (
            <div className="ra-page-actions">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act('done')}><Icon name="tick" size={15} /> Mark done</button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void act('snooze', '1h')}>Snooze 1 hour</button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void act('snooze', 'tomorrow')}>Tomorrow morning</button>
            </div>
          )}
          {!info.valid && !message && state !== 'Done' && <p className="auth-sub">This link has been used. Open the app to change the reminder.</p>}
        </>
      )}
      <div className="ra-page-foot">
        {signedIn ? <Link className="btn btn-ghost btn-sm" to={info?.link ?? '/reminders'}>{info?.link ? `Open ${info.targetKey ?? 'the work'}` : 'Open my reminders'}</Link>
          : <Link className="link" to="/login">Sign in to see all your reminders</Link>}
      </div>
    </div></div>
  );
}
