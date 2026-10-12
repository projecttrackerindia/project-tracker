import { Link, useSearchParams } from 'react-router-dom';
import type { WebhookFormat } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { useIsPersonal } from '../../stores/auth';
import './integrationGuides.css';

const SLACK_HELP = 'https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/';
const TEAMS_HELP = 'https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook';

/** Customer instructions for the existing outgoing delivery adapter; opening a guide never sends a message. */
export function WebhookSetupSteps({ format }: { format: WebhookFormat }) {
  return <>
    <ol className="integration-steps">
      {format === 'Json' ? <>
        <li><b>Prepare your receiver.</b> Use a public HTTPS endpoint in your own system that accepts JSON POST requests.</li>
        <li><b>Create a webhook here.</b> Choose Your own system, give it a name, and paste the receiver address.</li>
        <li><b>Select events.</b> Choose the changes your system needs, then create the webhook. Store the signing secret shown once and use it to verify incoming requests.</li>
        <li><b>Check delivery.</b> Use Send test on the saved webhook, then open Deliveries and confirm your receiver processed it.</li>
      </> : format === 'Slack' ? <>
        <li><b>Prepare a Slack app.</b> Ask your Slack administrator for an approved incoming webhook, or create an app for your workspace at <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">Slack app settings</a>.</li>
        <li><b>Choose the destination.</b> Enable Incoming Webhooks in that app, add a webhook to your workspace, and authorize the channel that should receive updates.</li>
        <li><b>Connect the channel here.</b> Copy its webhook URL. Create a webhook, choose A Slack channel, paste the URL, and select events before saving.</li>
        <li><b>Check the result.</b> Use Send test, confirm the message in Slack, and review Deliveries here.</li>
      </> : <>
        <li><b>Create a Teams workflow.</b> Open Workflows from your destination channel and choose a template for posting webhook alerts to a channel.</li>
        <li><b>Set up the trigger.</b> Use the Anyone authentication option for this connection, select the team and channel, and save. Project Tracker sends to the secret workflow URL without a Microsoft sign-in token.</li>
        <li><b>Connect the channel here.</b> Copy the workflow URL. Create a webhook, choose A Microsoft Teams channel, paste the URL, and select events before saving.</li>
        <li><b>Check the result.</b> Use Send test, confirm the card in Teams, and review Deliveries here. Add a workflow co-owner so it can be maintained if its creator leaves.</li>
      </>}
    </ol>
    {format === 'Json' ? <p className="integration-guide-note">Your receiver should verify X-PM-Signature and use X-PM-Delivery to avoid processing the same delivery twice. Private or internal network addresses cannot be used.</p>
      : <p className="integration-guide-note">Keep the webhook URL private and choose a channel whose members may see the selected workspace events. Messages contain links back to Project Tracker; opening them still requires permission.</p>}
    {format !== 'Json' && <a className="integration-help-link" href={format === 'Slack' ? SLACK_HELP : TEAMS_HELP} target="_blank" rel="noopener noreferrer">{format === 'Slack' ? 'Slack setup reference' : 'Microsoft Teams setup reference'} <Icon name="chevronR" size={13} /></a>}
    {format === 'Teams' && <p className="integration-guide-note">If Workflows or the required trigger option is unavailable, ask your Microsoft 365 administrator. Use a workflow URL for new connections.</p>}
  </>;
}

export function SlackInstallSteps() {
  return <>
    <ol className="integration-steps">
      <li><b>Select your organization.</b> Sign in as its owner or administrator. An active subscription with Slack integration included is required.</li>
      <li><b>Start the connection.</b> Select Connect Slack workspace on this organization's Slack settings page.</li>
      <li><b>Approve in Slack.</b> Select the correct workspace, review the requested permissions, and allow installation. Your Slack administrator may need to approve the app.</li>
      <li><b>Verify the workspace.</b> Return to Project Tracker and check that the expected workspace is shown as Connected. Use Disconnect workspace to remove access.</li>
    </ol>
    <p className="integration-guide-note">You do not need to enter bot tokens or client secrets. Workspace installation is available; chat queries, task actions and notifications through this installation are not yet enabled. For channel notifications now, use the Slack webhook guide.</p>
  </>;
}

export function IntegrationSetupGuides({ included, onCreate }: { included: boolean; onCreate: (format: WebhookFormat) => void }) {
  const personal = useIsPersonal();
  const [params, setParams] = useSearchParams();
  const providers: { format: WebhookFormat; name: string; description: string; icon: IconName }[] = [
    { format: 'Slack', name: 'Slack', description: 'Keep your channel in the loop', icon: 'message' },
    { format: 'Teams', name: 'Microsoft Teams', description: 'Deliver updates through Workflows', icon: 'users' },
    { format: 'Json', name: 'Webhooks', description: 'Connect your own systems', icon: 'code' },
  ];
  const selected = providers.find(p => p.format.toLowerCase() === params.get('guide')) ?? providers[0];
  const choose = (format: WebhookFormat) => {
    const next = new URLSearchParams(params); next.set('guide', format.toLowerCase()); setParams(next);
  };
  return <section className="integration-studio mb-22" aria-labelledby="integration-setup-title">
    <div className="integration-studio-head">
      <div><span className="integration-eyebrow">Workspace connections</span><h3 id="integration-setup-title">Connect your tools.</h3><p>Bring project updates to the places your team already works.</p></div>
      <span className="integration-access"><Icon name={included ? 'shield' : 'lock'} size={15} />{included ? 'Webhook access included' : 'Plan upgrade required'}</span>
    </div>
    <div className="integration-studio-grid">
      <nav className="integration-provider-list" aria-label="Integration setup guides">
        {providers.map(p => <button type="button" key={p.format} className={`integration-provider ${selected.format === p.format ? 'selected' : ''}`} aria-pressed={selected.format === p.format} aria-controls="integration-selected-guide" onClick={() => choose(p.format)}>
          <span className={`integration-guide-icon provider-${p.format.toLowerCase()}`}><Icon name={p.icon} size={22} /></span>
          <span><b>{p.name}</b><small>{p.description}</small></span><Icon name="chevronR" size={16} />
        </button>)}
        <div className="integration-boundary"><Icon name="shield" size={17} /><p>Connections belong to this workspace. Share only the events your destination members may see.</p></div>
      </nav>
      <div id="integration-selected-guide" className="integration-selected-guide" aria-labelledby="integration-guide-heading">
        <div className="integration-guide-heading"><div><span className="integration-eyebrow">Setup guide · 4 steps</span><h4 id="integration-guide-heading">{selected.format === 'Json' ? 'Signed event delivery' : `${selected.name} channel notifications`}</h4></div><span className="integration-guide-tag">{selected.format === 'Json' ? 'HTTPS + JSON' : 'Channel webhook'}</span></div>
        <WebhookSetupSteps format={selected.format} />
        <div className="integration-guide-actions">{included ? <button type="button" className="btn btn-primary" onClick={() => onCreate(selected.format)}><Icon name="plus" size={15} />{selected.format === 'Json' ? 'Create webhook' : selected.format === 'Slack' ? 'Connect Slack channel' : 'Connect Teams channel'}</button> : <Link className="btn btn-primary" to="/settings/billing">Review plans for webhooks <Icon name="chevronR" size={15} /></Link>}<span>Save your connection, then verify a test delivery.</span></div>
        {selected.format === 'Slack' && !personal && <details className="integration-slack-install"><summary>Looking for Slack workspace installation? <Icon name="chevronD" size={15} /></summary><div><SlackInstallSteps /><Link className="btn btn-sm" to="/settings/slack">Open Slack workspace setup <Icon name="chevronR" size={14} /></Link></div></details>}
        {selected.format === 'Slack' && personal && <p className="integration-guide-note">Slack workspace installation requires an organization workspace. Channel webhooks follow your current plan.</p>}
      </div>
    </div>
    <div className="integration-studio-footer">
      <p><Icon name="key" size={14} /> Keep webhook addresses and signing secrets private.</p>
      <details className="integration-guide integration-troubleshooting"><summary><span className="integration-guide-title"><b>Connection help</b><small>Plan access, failed deliveries and disconnecting</small></span><Icon name="chevronD" size={16} /></summary><div className="integration-guide-body"><ul>
        <li><b>Setup button unavailable:</b> review your plan or ask the workspace owner. If Slack says platform setup is pending, contact Project Tracker support.</li>
        <li><b>Test queued:</b> check Deliveries after a few seconds. A successful HTTP delivery should also be checked in the receiving channel or system.</li>
        <li><b>Delivery failed:</b> inspect the recorded error, check the receiver URL and app or workflow permissions, then retry after correcting the cause.</li>
        <li><b>Stop notifications:</b> turn off or delete the saved webhook. Manage Slack workspace installation separately using Disconnect workspace.</li>
      </ul></div></details>
    </div>
  </section>;
}
