import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { integrationsApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { Field, PageHead, PageLoader } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);

/** My account > Google Workspace (spec section 15): connect once, every Google Meet this person starts or schedules from any project
 * goes through this grant. Minimal scopes only - Calendar events and Meet space creation, nothing else. */
export function GoogleIntegrationSection() {
  const wid = useWorkspaceId();
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
    try { const { url } = await integrationsApi.googleConnectUrl('/account/integrations'); window.location.assign(url); }
    catch (e) { toast(errText(e, 'Could not start the Google connection.'), 'error'); }
  };
  const disconnect = async () => {
    if (!(await confirmDialog({ title: 'Disconnect Google account?', message: 'Meetings you have already scheduled keep working. You will need to reconnect before starting or scheduling another Google Meet.', confirmText: 'Disconnect' }))) return;
    try { await integrationsApi.googleDisconnect(); toast('Google account disconnected.'); await invalidateWorkspace(wid, 'account', 'google-status'); }
    catch (e) { toast(errText(e, 'Could not disconnect the Google account.'), 'error'); }
  };

  return (
    <>
      <PageHead title="Google Workspace" sub="Connect your Google account to start or schedule Google Meet meetings from your projects." />
      <div className="card" style={{ padding: 22, maxWidth: 560 }}>
        {q.isLoading ? <PageLoader /> : (
          <Field label="Google Calendar & Meet">
            {q.data?.connected ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="dl-facts" style={{ display: 'grid', placeItems: 'center', width: 36, height: 36, borderRadius: 10, background: 'var(--success-soft, #e9f9ef)', color: 'var(--success, #16a34a)' }}><Icon name="checkCircle" size={18} /></span>
                  <div>
                    <b>Google connected</b>
                    <div className="muted" style={{ fontSize: 13 }}>{q.data.googleEmail || 'Connected account'}</div>
                    {q.data.lastError && <div className="form-error" style={{ marginTop: 4 }}>{q.data.lastError}</div>}
                  </div>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void disconnect()}>Disconnect</button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span className="muted">Not connected</span>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void connect()}><Icon name="video" size={14} /> Connect Google account</button>
              </div>
            )}
          </Field>
        )}
        <p className="muted" style={{ fontSize: 12.5, marginTop: 14 }}>Only Calendar event creation and Google Meet conference creation are requested - never Gmail, Drive or your full calendar.</p>
      </div>
    </>
  );
}
