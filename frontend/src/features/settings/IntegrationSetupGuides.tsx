import { Link } from 'react-router-dom';
import type { WebhookFormat } from '../../api/types';
import { Icon } from '../../components/Icon';
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
  return <section className="card mb-22" aria-labelledby="integration-setup-title">
    <div className="card-head"><div><h3 id="integration-setup-title">Connect your tools</h3><p>Follow a setup guide, choose which events to share, then verify a delivery.</p></div></div>
    <div className="card-body integration-guides">
      <p className="integration-guide-note">Owners and administrators manage connections for the selected workspace. Channel notifications require a plan with webhook access; Slack workspace installation has its own plan eligibility.</p>
      {(['Json', 'Slack', 'Teams'] as const).map((format) => <details className="integration-guide" key={format}>
        <summary><span className="integration-guide-icon"><Icon name={format === 'Json' ? 'send' : format === 'Slack' ? 'message' : 'workflow'} size={19} /></span><span className="integration-guide-title"><b>{format === 'Json' ? 'Webhooks' : format === 'Slack' ? 'Slack' : 'Microsoft Teams'}</b><small>{format === 'Json' ? 'Send signed events to your own system' : format === 'Slack' ? 'Channel notifications and workspace setup' : 'Post notifications with Teams Workflows'}</small></span><Icon name="chevronD" size={16} /></summary>
        <div className="integration-guide-body">
          <h4>{format === 'Json' ? 'Set up a signed webhook' : 'Set up channel notifications'}</h4>
          <WebhookSetupSteps format={format} />
          <div className="integration-guide-actions">{included ? <button type="button" className="btn btn-primary btn-sm" onClick={() => onCreate(format)}><Icon name="plus" size={14} />{format === 'Json' ? 'Create webhook' : format === 'Slack' ? 'Connect Slack channel' : 'Connect Teams channel'}</button> : <Link className="btn btn-sm" to="/settings/billing">Review plans for webhooks</Link>}</div>
          {format === 'Slack' && !personal && <div className="integration-slack-install"><h4>Connect your organization's Slack workspace</h4><SlackInstallSteps /><Link className="btn btn-sm" to="/settings/slack">Open Slack workspace setup <Icon name="chevronR" size={14} /></Link></div>}
          {format === 'Slack' && personal && <p className="integration-guide-note">Workspace installation is available in organization workspaces. Your personal workspace can use channel webhooks when included in its plan.</p>}
        </div>
      </details>)}
      <details className="integration-guide integration-troubleshooting"><summary><span className="integration-guide-title"><b>Connection help</b><small>Plan access, failed deliveries and disconnecting</small></span><Icon name="chevronD" size={16} /></summary><div className="integration-guide-body"><ul>
        <li><b>Setup button unavailable:</b> review your plan or ask the workspace owner. If Slack says platform setup is pending, contact Project Tracker support.</li>
        <li><b>Test queued:</b> check Deliveries after a few seconds. A successful HTTP delivery should also be checked in the receiving channel or system.</li>
        <li><b>Delivery failed:</b> inspect the recorded error, check the receiver URL and app or workflow permissions, then retry after correcting the cause.</li>
        <li><b>Stop notifications:</b> turn off or delete the saved webhook. Manage Slack workspace installation separately using Disconnect workspace.</li>
      </ul></div></details>
    </div>
  </section>;
}
