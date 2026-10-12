import { useEffect, useState } from 'react';
import { useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { microsoftApi } from '../../api/endpoints.platform';
import { Icon } from '../../components/Icon';
import { PageLoader } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
export function MicrosoftIntegrationSection() {
  const wid = useWorkspaceId();
  const uid = useAuth(s => s.ctx?.user.id);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const active = () => alive.current && useAuth.getState().ctx?.user.id === uid && useAuth.getState().ctx?.current?.id === wid;
  const q = useWsQuery(['account', 'microsoft-status'], microsoftApi.status);
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useSearchParams();
  const outcome = params.get('microsoft');
  useEffect(() => {
    if (!outcome) return;
    toast(outcome === 'connected' ? 'Microsoft account connected.' : outcome === 'permission' ? 'The requested Microsoft permissions were not granted.' : outcome === 'declined' ? 'Microsoft connection was cancelled.' : 'Microsoft connection could not be completed.', outcome === 'connected' ? 'success' : 'info');
    void invalidateWorkspace(wid, 'account', 'microsoft-status');
    const next = new URLSearchParams(params); next.delete('microsoft'); setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);
  const error = (e: unknown) => toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Microsoft request could not be completed.', 'error');
  const connect = async () => {
    if (!active()) return;
    setBusy(true);
    try { const { url } = await microsoftApi.connect(); if (active()) window.location.assign(url); }
    catch (e) { if (active()) { error(e); setBusy(false); } }
  };
  const disconnect = async () => {
    if (!(await confirmDialog({ title: 'Disconnect Microsoft?', message: 'Project Tracker will delete its stored Microsoft credentials. To revoke the application consent in Microsoft as well, remove it from your Microsoft account or organization access portal. Previously accepted emails cannot be recalled.', confirmText: 'Disconnect' })) || !active()) return;
    setBusy(true);
    try { await microsoftApi.disconnect(); if (active()) { await invalidateWorkspace(wid, 'account', 'microsoft-status'); if (active()) toast('Stored Microsoft connection removed.'); } }
    catch (e) { if (active()) error(e); }
    finally { if (active()) setBusy(false); }
  };
  return <section className="personal-account-card">
    <header><span className="personal-account-symbol"><Icon name="mail" size={19} /></span><div><span className="studio-eyebrow">CONNECTED ACCOUNT</span><h2>Microsoft Outlook</h2></div></header>
    {q.isLoading ? <PageLoader /> : q.isError ? <p role="alert">Could not load Microsoft status. <button className="btn btn-sm" onClick={() => void q.refetch()}>Reload</button></p> : <>
      <p className="muted">Connect your own Microsoft account for separately confirmed email sending. Inbox reading and calendar access have separate, optional consent steps in the sections below.</p>
      {!q.data?.enabled || !q.data.configured ? <p className="muted">Awaiting administrator configuration. Microsoft actions are disabled.</p> :
        <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
          <span>{q.data.connected ? q.data.email || 'Connected Microsoft account' : 'Not connected'}</span>
          <button className="btn" disabled={busy} onClick={() => void connect()}>{q.data.connected ? 'Reconnect Microsoft' : 'Connect Microsoft'}</button>
        </div>}
      {q.data?.connected && <button className="btn btn-ghost" disabled={busy} style={{ marginTop: 10 }} onClick={() => void disconnect()}>Disconnect Microsoft</button>}
    </>}
  </section>;
}
