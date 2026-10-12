import { useEffect, useRef, useState } from 'react';
import { OutlookAvailability } from './OutlookAvailability';
import { PersonalCalendarProposals } from './PersonalCalendarProposals';
import { PersonalEmailDrafts } from './PersonalEmailDrafts';
import { MicrosoftIntegrationSection } from './MicrosoftIntegration';
import { PersonalInbox } from './PersonalInbox';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { integrationsApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { Field, PageHead, PageLoader } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import './PersonalProductivity.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);

/** My account > Google Workspace (spec section 15): connect once, every Google Meet this person starts or schedules from any project
 * goes through this grant. Calendar/Meet access and optional send-only email consent remain separate capabilities. */
export function GoogleIntegrationSection() {
  const wid = useWorkspaceId();
  const uid = useAuth(s => s.ctx?.user.id);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const active = () => alive.current && useAuth.getState().ctx?.user.id === uid && useAuth.getState().ctx?.current?.id === wid;
  const [params, setParams] = useSearchParams();
  const q = useWsQuery(['account', 'google-status'], integrationsApi.googleStatus);
  const outcome = params.get('google');   // 'connected' | 'declined' | 'error', dropped back from the OAuth callback redirect

  useEffect(() => {
    if (!outcome) return;
    if (outcome === 'connected') toast('Google account connected.');
    else if (outcome === 'declined') toast('Google sign-in was not completed.', 'info');
    else if (outcome === 'error') toast('Could not connect your Google account. Please try again.', 'error');
    void invalidateWorkspace(wid, 'account', 'google-status');
    const n = new URLSearchParams(params); n.delete('google'); setParams(n, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);

  const connect = async () => {
    if (!active()) return;
    setBusy(true);
    try { const { url } = await integrationsApi.googleConnectUrl('/account/integrations'); if (active()) window.location.assign(url); }
    catch (e) { if (active()) { toast(errText(e, 'Could not start the Google connection.'), 'error'); setBusy(false); } }
  };
  const disconnect = async () => {
    if (!(await confirmDialog({ title: 'Disconnect Google account?', message: 'Meetings you have already scheduled keep working. You will need to reconnect before starting or scheduling another Google Meet.', confirmText: 'Disconnect' })) || !active()) return;
    setBusy(true);
    try { await integrationsApi.googleDisconnect(); if (active()) { toast('Google account disconnected.'); await invalidateWorkspace(wid, 'account', 'google-status'); } }
    catch (e) { if (active()) toast(errText(e, 'Could not disconnect the Google account.'), 'error'); }
    finally { if (active()) setBusy(false); }
  };

  return (
    <>
      <PageHead title="Google Workspace" sub="Your connected accounts, private inbox and reviewed email. Each permission stays under your control." />
      <nav className="personal-productivity-nav" aria-label="Personal email sections"><a href="#personal-accounts"><Icon name="link" size={15} /> Accounts</a><a href="#private-inbox-title"><Icon name="mail" size={15} /> Private inbox</a><a href="#private-drafts-title"><Icon name="edit" size={15} /> Email studio</a><span><Icon name="lock" size={13} /> Your personal space</span></nav>
      <div className="personal-account-grid" id="personal-accounts">
      <div className="personal-account-card">
        <header><span className="personal-account-symbol"><Icon name="video" size={19} /></span><div><span className="studio-eyebrow">CONNECTED ACCOUNT</span><h2>Google</h2></div></header>
        {q.isLoading ? <PageLoader /> : q.isError ? <p role="alert">Could not verify your Google connection. <button className="btn btn-sm" onClick={() => void q.refetch()}>Retry Google check</button></p> : (
          <Field label="Google Calendar & Meet">
            {q.data?.connected ? (
              <div className="personal-account-actions">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="dl-facts" style={{ display: 'grid', placeItems: 'center', width: 36, height: 36, borderRadius: 10, background: 'var(--success-soft, #e9f9ef)', color: 'var(--success, #16a34a)' }}><Icon name="checkCircle" size={18} /></span>
                  <div>
                    <b>{q.data.calendarAccess===false?'Calendar permission needed':'Google connected'}</b>
                    <div className="muted" style={{ fontSize: 13 }}>{q.data.googleEmail || 'Connected account'}</div>
                    {q.data.lastError && <div className="form-error" style={{ marginTop: 4 }}>{q.data.lastError}</div>}
                  </div>
                </div>
                <div style={{display:'flex',gap:8,flexWrap:'wrap'}}><button type="button" className="btn btn-sm" disabled={busy} onClick={() => void connect()}>Reconnect</button><button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void disconnect()}>Disconnect</button></div>
              </div>
            ) : (
              <div className="personal-account-actions">
                <span className="muted">Not connected</span>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void connect()}><Icon name="video" size={14} /> Connect Google account</button>
              </div>
            )}
          </Field>
        )}
        <p className="muted" style={{ fontSize: 12.5, marginTop: 14 }}>Calendar and Meet permissions are requested for meetings. Gmail sending and inbox reading have separate, optional consent steps. Drive access is not requested.</p>
      </div>
      <MicrosoftIntegrationSection key={`microsoft-${wid}-${uid}`} />
      </div>
      <PersonalInbox key={`inbox-${wid}-${uid}`} google={q.data} googleState={q.isLoading ? 'loading' : q.isError ? 'error' : 'ready'} />
      <PersonalEmailDrafts key={`${wid}-${uid}`} google={q.data} googleState={q.isLoading ? 'loading' : q.isError ? 'error' : 'ready'} />
      <OutlookAvailability key={`outlook-availability-${wid}-${uid}`} />
      <PersonalCalendarProposals key={`calendar-${wid}-${uid}`} />
    </>
  );
}
