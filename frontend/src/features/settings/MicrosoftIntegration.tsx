import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { microsoftApi } from '../../api/endpoints.platform';
import { PageLoader } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
export function MicrosoftIntegrationSection() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['account', 'microsoft-status'], microsoftApi.status);
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useSearchParams();
  const outcome = params.get('microsoft');
  useEffect(() => {
    if (!outcome) return;
    toast(outcome === 'connected' ? 'Microsoft account connected.' : outcome === 'permission' ? 'Microsoft email permission was not granted.' : outcome === 'declined' ? 'Microsoft connection was cancelled.' : 'Microsoft connection could not be completed.', outcome === 'connected' ? 'success' : 'info');
    void invalidateWorkspace(wid, 'account', 'microsoft-status');
    const next = new URLSearchParams(params); next.delete('microsoft'); setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);
  const error = (e: unknown) => toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Microsoft request could not be completed.', 'error');
  const connect = async () => {
    setBusy(true);
    try { const { url } = await microsoftApi.connect(); window.location.assign(url); }
    catch (e) { error(e); setBusy(false); }
  };
  const disconnect = async () => {
    if (!(await confirmDialog({ title: 'Disconnect Microsoft?', message: 'Project Tracker will delete its stored Microsoft credentials. To revoke the application consent in Microsoft as well, remove it from your Microsoft account or organization access portal. Previously accepted emails cannot be recalled.', confirmText: 'Disconnect' }))) return;
    setBusy(true);
    try { await microsoftApi.disconnect(); await invalidateWorkspace(wid, 'account', 'microsoft-status'); toast('Stored Microsoft connection removed.'); }
    catch (e) { error(e); }
    finally { setBusy(false); }
  };
  return <section className="card" style={{ padding: 22, marginTop: 20 }}>
    <h2 style={{ marginTop: 0 }}>Microsoft Outlook</h2>
    {q.isLoading ? <PageLoader /> : q.isError ? <p role="alert">Could not load Microsoft status. <button className="btn btn-sm" onClick={() => void q.refetch()}>Reload</button></p> : <>
      <p className="muted">Connect your own Microsoft account for separately confirmed email sending. Inbox and calendar access are not requested.</p>
      {!q.data?.enabled || !q.data.configured ? <p className="muted">Awaiting administrator configuration. Microsoft actions are disabled.</p> :
        <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
          <span>{q.data.connected ? q.data.email || 'Connected Microsoft account' : 'Not connected'}</span>
          <button className="btn" disabled={busy} onClick={() => void connect()}>{q.data.connected ? 'Reconnect Microsoft' : 'Connect Microsoft'}</button>
        </div>}
      {q.data?.connected && <button className="btn btn-ghost" disabled={busy} style={{ marginTop: 10 }} onClick={() => void disconnect()}>Disconnect Microsoft</button>}
    </>}
  </section>;
}
