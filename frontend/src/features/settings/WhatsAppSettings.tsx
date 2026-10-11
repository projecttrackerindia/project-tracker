import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { get, post } from '../../api/client';
import { useWsQuery, invalidateWorkspace } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast, confirmDialog } from '../../stores/ui';
import { loadWhatsAppSdk, launchWhatsAppSignup, type WhatsAppSignupStart } from '../../lib/whatsAppSignup';

interface WhatsAppStatus {
  configured: boolean; receptionEnabled: boolean; eligible: boolean; connected: boolean;
  displayName: string | null; connectedAt: string | null; installationEnabled: boolean; messagingEnabled: boolean;
}
interface Health { checkEnabled:boolean; state:string; checkedAt:string|null; tokenValid:boolean|null; scopesPresent:boolean|null;
  assetsVerified:boolean|null; appSubscribed:boolean|null; phoneVerified:boolean|null; messagingEnabled:boolean }
interface Receipt { id: string; messageType: string; receivedAt: string; outcome: string }

export function WhatsAppSettings() {
  const wid = useWorkspaceId();
  const [prepared, setPrepared] = useState<WhatsAppSignupStart | null>(null);
  const [busy, setBusy] = useState(false);
  const flow = useRef<AbortController | null>(null);
  const currentWorkspace = useRef(wid);
  useEffect(() => {
    currentWorkspace.current = wid; setPrepared(null); setBusy(false); flow.current?.abort();
    return () => { flow.current?.abort(); };
  }, [wid]);
  const prepare = useMutation({
    mutationFn: async (workspaceId: string | null) => {
      const start = await post<WhatsAppSignupStart>('/integrations/whatsapp/connect');
      try { await loadWhatsAppSdk(start); return { start, workspaceId }; }
      catch (error) { await post('/integrations/whatsapp/cancel', { state: start.state }).catch(() => {}); throw error; }
    },
    onSuccess: ({ start, workspaceId }) => { if (currentWorkspace.current === workspaceId) setPrepared(start); },
    onError: (error) => toast(error.message, 'error'),
  });
  const continueWithMeta = () => {
    if (!prepared || busy) return;
    const start = prepared; const controller = new AbortController(); flow.current = controller; setBusy(true);
    // Open synchronously from the click, after the preparation step has finished.
    void launchWhatsAppSignup(start, controller.signal).then(async (result) => {
      if (controller.signal.aborted || currentWorkspace.current !== wid) return;
      await post('/integrations/whatsapp/complete', { state: start.state, ...result });
      if (currentWorkspace.current === wid) { toast('WhatsApp business connection verified.', 'success'); void invalidateWorkspace(wid, 'whatsapp'); }
    }).catch(async (error: Error) => {
      if (currentWorkspace.current !== wid) return;
      await post('/integrations/whatsapp/cancel', { state: start.state }).catch(() => {});
      toast(error.message, 'info');
    }).finally(() => { if (currentWorkspace.current === wid) { setPrepared(null); setBusy(false); } });
  };
  const cancelSetup = () => {
    if (busy) return;
    if (prepared) void post('/integrations/whatsapp/cancel', { state: prepared.state }).catch(() => {});
    setPrepared(null);
  };
  const status = useWsQuery(['whatsapp', 'status'], () => get<WhatsAppStatus>('/integrations/whatsapp/status'));
  const health = useWsQuery(['whatsapp', 'health'], () => get<Health>('/integrations/whatsapp/health'), { enabled: status.data?.connected === true, refetchInterval: q => q.state.data?.state === 'checking' ? 5000 : false });
  const healthCheck = useMutation({
    mutationFn: () => post<Health>('/integrations/whatsapp/health/check'),
    onSuccess: () => { void invalidateWorkspace(wid, 'whatsapp'); },
    onError: (error) => { toast(error.message, 'error'); void invalidateWorkspace(wid, 'whatsapp'); },
  });
  const receipts = useWsQuery(['whatsapp', 'receipts'], () => get<Receipt[]>('/integrations/whatsapp/receipts'),
    { enabled: status.data?.eligible === true && status.data?.connected === true });
  const disconnect = useMutation({
    mutationFn: () => post('/integrations/whatsapp/disconnect'),
    onSuccess: () => { void invalidateWorkspace(wid, 'whatsapp'); toast('Stored WhatsApp credentials removed.', 'success'); },
    onError: (error) => toast(error.message, 'error'),
  });
  const s = status.data;
  return <div className="card">
    <div className="card-head"><div><h3>WhatsApp Business</h3><p>A separate business connection for each organization.</p></div></div>
    <div className="card-body">
      {status.isLoading && <p role="status">Checking integration status...</p>}
      {status.error && <p role="alert">{status.error.message}</p>}
      {s && <>
        {!s.eligible && <p>Your organization needs an active subscription with WhatsApp integration access. <Link to="/settings/billing">Review plans</Link></p>}
        <p role="status">{s.connected ? (s.displayName || 'Business account') + ' connected.'
          : s.installationEnabled ? 'Ready to connect your business through Meta.' : 'WhatsApp setup is being prepared. Customer installations are not available yet.'}</p>
        {!s.configured && <p>Platform provider configuration is pending.</p>}
        <p>Chat replies, notifications and task actions remain disabled. A business connection will not give WhatsApp contacts access to project data.</p>
        {!s.connected && s.installationEnabled && <>
          {prepared ? <div><p>Meta is ready. Review its account and phone selection before allowing access.</p>
            <button className="btn btn-primary" disabled={busy} onClick={continueWithMeta}>Continue with Meta</button>
            <button className="btn" disabled={busy} onClick={cancelSetup}>Cancel setup</button>
            {busy && <p role="status">Complete the Meta window. Close it to cancel before granting access.</p>}
          </div> : <button className="btn btn-primary" disabled={!s.eligible || prepare.isPending} onClick={() => prepare.mutate(wid ?? null)}>{prepare.isPending ? 'Preparing Meta connection...' : 'Connect WhatsApp Business'}</button>}
        </>}
        {s.connected && <button className="btn" disabled={disconnect.isPending} onClick={async () => {
          if (await confirmDialog({ title: 'Disconnect WhatsApp?', message: 'Stop reception and remove usable credentials stored here. Remove the app separately in Meta Business Settings to revoke provider access.', confirmText: 'Disconnect' })) disconnect.mutate();
        }}>Disconnect business account</button>}
      </>}
      <details className="integration-inline-guide" open>
        <summary>Prepare your organization for WhatsApp</summary>
        <ol className="integration-steps">
          <li><b>Choose a business account.</b> An authorized organization administrator should manage the intended Meta business portfolio and WhatsApp Business phone number.</li>
          <li><b>Check plan access.</b> Integration availability is controlled by your organization’s subscription. It is not included automatically in every plan.</li>
          <li><b>Connect securely.</b> When enabled by the platform, select Connect WhatsApp Business, then Continue with Meta. Choose the correct business account and verified phone number in Meta’s sign-in flow. Do not paste access tokens into Project Tracker.</li>
          <li><b>Verify contacts and consent.</b> Messaging will require verified contact links, permission checks and the applicable WhatsApp messaging rules before activation.</li>
        </ol>
        <a href="https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/" target="_blank" rel="noopener noreferrer">Meta business installation reference</a>
      </details>
      {s?.connected && <section aria-labelledby="whatsapp-health-title">
        <h4 id="whatsapp-health-title">Provider health</h4>
        <p>Check the current token, selected business assets and app subscription. This check cannot activate messaging.</p>
        {health.isLoading && <p role="status">Loading provider health...</p>}
        {health.error && <p role="alert">{health.error.message}</p>}
        {health.data && <>
          <p role="status">{({unchecked:'Not checked yet.',checking:'Provider check in progress.',verified:'Read checks passed. Delivery remains disabled.',
            attention:'Setup needs attention. Review the checks below.',unavailable:'Provider checks could not be completed. Try again after a minute.',
            stale:'The previous result is out of date. Run a fresh check.'} as Record<string,string>)[health.data.state] || 'Status is unavailable.'}</p>
          {health.data.checkedAt && <p className="muted">Last check: {new Date(health.data.checkedAt).toLocaleString()}</p>}
          <ul>{([['tokenValid','Token validity'],['scopesPresent','Required business and messaging permissions'],['assetsVerified','Selected business and phone access'],
            ['appSubscribed','App subscribed to this business'],['phoneVerified','Phone ownership verification']] as const).map(([key,label]) =>
            <li key={key}>{label}: {health.data![key] === true ? 'Passed' : health.data![key] === false ? 'Needs attention' : 'Not verified'}</li>)}</ul>
          {!health.data.checkEnabled && <p>Provider checks are awaiting platform activation or an eligible current connection.</p>}
          <button className="btn" disabled={!health.data.checkEnabled || healthCheck.isPending || health.data.state === 'checking'} onClick={() => healthCheck.mutate()}>
            {healthCheck.isPending ? 'Checking provider...' : 'Check provider health'}</button>
        </>}
        <p className="muted">Phone registration, webhook delivery and messaging rules still need validation before sending is available.</p>
      </section>}
      {s?.eligible && s.connected && <section aria-labelledby="whatsapp-receipts-title">
        <h4 id="whatsapp-receipts-title">Recent inbound receipts</h4>
        <p>Metadata only. Message contents and sender phone numbers are not stored. This is a bounded diagnostic sample, not a conversation history.</p>
        {receipts.isLoading && <p role="status">Loading receipts...</p>}
        {receipts.error && <p role="alert">{receipts.error.message}</p>}
        {receipts.data?.length === 0 && <p>No receipts recorded.</p>}
        <ul>{receipts.data?.map((r) => <li key={r.id}>{r.messageType} · {new Date(r.receivedAt).toLocaleString()} · Contact verification required</li>)}</ul>
      </section>}
    </div>
  </div>;
}