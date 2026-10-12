import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, post } from '../../api/client';
import { useWsQuery, invalidateWorkspace } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast, confirmDialog } from '../../stores/ui';
import { useMutation } from '@tanstack/react-query';
import { SlackInstallSteps } from './IntegrationSetupGuides';
import { Icon } from '../../components/Icon';

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
  return <section className="integration-studio" aria-labelledby="slack-setup-title"><div className="integration-studio-head">
    <div><span className="integration-eyebrow">Organization integration</span><h3 id="slack-setup-title">Connect your Slack workspace.</h3><p>Install Project Tracker in your organization's own Slack workspace.</p></div>
    <span className="integration-access"><Icon name="shield" size={15} /> Organization access controls</span>
  </div><div className="slack-setup-grid">
    <div><h4>How to connect Slack</h4><SlackInstallSteps /><Link className="integration-help-link" to="/settings/webhooks?guide=slack">Set up Slack channel notifications <Icon name="chevronR" size={14} /></Link></div>
    <div className="slack-connection-panel">
    <span className="integration-eyebrow">Connection status</span>
    {q.isLoading && <p role="status">Checking connection...</p>}
    {q.error && <><p role="alert">Could not check your Slack connection. {q.error.message}</p><button type="button" className="btn" onClick={() => void q.refetch()}>Try again</button></>}
    {status && !q.isError && <>
      <p className="slack-connection-state"><Icon name={status.connected ? 'check' : status.teamId ? 'alert' : 'link'} size={17} />{status.connected ? 'Connected' : status.teamId ? 'Needs attention' : !status.eligible ? 'Plan upgrade required' : !status.configured ? 'Awaiting platform setup' : 'Ready to connect'}</p>
      {status.teamId && <><strong>{status.teamName || 'Slack workspace'}</strong><p>Workspace ID: {status.teamId}</p></>}
      {!status.eligible && <p>An active subscription with Slack integration is required. <Link className="link" to="/settings/billing">Review plans</Link></p>}
      {!status.configured && <p>Platform setup is pending. Ask your platform administrator to complete Slack setup.</p>}
      {status.lastError && <p role="alert">The installation needs attention. Disconnect and install again to restore access.</p>}
      <p>Interactive queries, actions and automated notifications through this installation are not yet enabled. Installing Slack does not grant members access to project data.</p>
      {status.teamId ? <button type="button" className="btn" disabled={disconnect.isPending} onClick={async () => {
        if (await confirmDialog({ title: 'Disconnect Slack?', message: 'Remove this organization’s stored Slack credentials and revoke the bot token.', confirmText: 'Disconnect' })) disconnect.mutate();
      }}>{disconnect.isPending ? 'Disconnecting…' : 'Disconnect workspace'}</button> : <button type="button" className="btn btn-primary" disabled={!status.eligible || !status.configured || connect.isPending} onClick={() => connect.mutate()}><Icon name="link" size={15} />{connect.isPending ? 'Opening Slack…' : 'Connect Slack workspace'}</button>}
    </>}
  </div></div></section>;
}
