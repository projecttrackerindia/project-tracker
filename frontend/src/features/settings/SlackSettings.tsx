import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, post } from '../../api/client';
import { useWsQuery, invalidateWorkspace } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast, confirmDialog } from '../../stores/ui';
import { useMutation } from '@tanstack/react-query';
import { SlackInstallSteps } from './IntegrationSetupGuides';

interface SlackStatus { configured: boolean; eligible: boolean; connected: boolean; teamId: string | null; teamName: string | null; connectedAt: string | null; lastError: string | null; interactiveEnabled: boolean }

export function SlackSettings() {
  const wid = useWorkspaceId();
  const [params, setParams] = useSearchParams();
  const q = useWsQuery(['slack', 'status'], () => get<SlackStatus>('/integrations/slack/status'));
  const refresh = () => invalidateWorkspace(wid, 'slack');
  useEffect(() => {
    const result = params.get('slack'); if (!result) return;
    toast(result === 'connected' ? 'Slack workspace connected.' : 'Slack installation was not completed.', result === 'connected' ? 'success' : 'info');
    const next = new URLSearchParams(params); next.delete('slack'); setParams(next, { replace: true });
    void invalidateWorkspace(wid, 'slack');
  }, [params, setParams, wid]);
  const connect = useMutation({ mutationFn: () => post<{ url: string }>('/integrations/slack/connect'),
    onSuccess: ({ url }) => { const target = new URL(url); if (target.protocol === 'https:' && target.hostname === 'slack.com') window.location.assign(url); },
    onError: (e) => toast(e.message, 'error') });
  const disconnect = useMutation({ mutationFn: () => post('/integrations/slack/disconnect'), onSuccess: () => void refresh(),
    onError: (e) => { toast(e.message, 'error'); void refresh(); } });
  const status = q.data;
  return <div className="card"><div className="card-head"><h3>Slack workspace</h3></div><div className="card-body">
    <p>Connect your organization's Slack workspace. Each organization keeps its own installation and credentials.</p>
    <details className="integration-inline-guide" open><summary>How to connect Slack</summary><SlackInstallSteps /></details>
    <p><Link to="/settings/webhooks">Set up Slack channel notifications</Link></p>
    {q.isLoading && <p role="status">Checking connection...</p>}
    {q.error && <p role="alert">{q.error.message}</p>}
    {status && <>
      {!status.eligible && <p>Slack requires an active subscription with Slack integration included. <Link to="/settings/billing">Review plans</Link></p>}
      {!status.configured && <p>Platform setup is pending. Ask your platform administrator to configure Slack OAuth.</p>}
      {status.teamId && <p><b>{status.teamName}</b> ({status.teamId}) — {status.connected ? 'Connected' : 'Access revoked'}</p>}
      {status.lastError && <p role="alert">Slack access was revoked. Disconnect and install again to restore the connection.</p>}
      <p>Installation setup is available. Interactive queries, actions and automated Slack notifications remain off until account linking and delivery checks are ready. Installing Slack does not grant members access to Project Tracker data.</p>
      {status.teamId ? <button className="btn" disabled={disconnect.isPending} onClick={async () => {
        if (await confirmDialog({ title: 'Disconnect Slack?', message: 'Remove this organization’s stored Slack credentials and revoke the bot token.', confirmText: 'Disconnect' })) disconnect.mutate();
      }}>Disconnect workspace</button> : <button className="btn btn-primary" disabled={!status.eligible || !status.configured || connect.isPending} onClick={() => connect.mutate()}>Connect Slack workspace</button>}
    </>}
  </div></div>;
}
