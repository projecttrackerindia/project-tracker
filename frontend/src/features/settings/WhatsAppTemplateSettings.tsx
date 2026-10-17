import { useMutation } from '@tanstack/react-query';
import { get, post } from '../../api/client';
import { useWsQuery, invalidateWorkspace } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { formatDateTime } from '../../lib/format';

interface Template { key: string; name: string; language: string; category: string; body: string; state: string }
interface TemplateStatus { checkEnabled: boolean; state: string; checkedAt: string | null; templates: Template[]; messagingEnabled: boolean }
const labels: Record<string, string> = { unchecked: 'Not checked', checking: 'Checking', approved: 'Approved and matches',
  missing: 'Create this template', pending: 'Awaiting Meta approval', unapproved: 'Not approved for use',
  incompatible: 'Template differs from the required content or category', stale: 'Run a fresh check', unavailable: 'Could not verify' };

export function WhatsAppTemplateSettings() {
  const wid = useWorkspaceId();
  const status = useWsQuery(['whatsapp', 'templates'], () => get<TemplateStatus>('/integrations/whatsapp/templates'),
    { refetchInterval: q => q.state.data?.state === 'checking' ? 5000 : false });
  const check = useMutation({
    mutationFn: () => post<TemplateStatus>('/integrations/whatsapp/templates/check'),
    onSuccess: () => { void invalidateWorkspace(wid, 'whatsapp'); },
    onError: error => { toast(error.message, 'error'); void invalidateWorkspace(wid, 'whatsapp'); },
  });
  return <section aria-labelledby="whatsapp-templates-title">
    <h4 id="whatsapp-templates-title">Notification templates</h4>
    <p>Prepare three short notifications for members who choose to receive them. Project names, task details and ticket contents stay in Project Tracker.</p>
    <details className="integration-inline-guide">
      <summary>Set up approved templates</summary>
      <ol className="integration-steps">
        <li>In Meta WhatsApp Manager, open Message templates for this organization's connected business account.</li>
        <li>Create each template below using its exact name, English (US) language, Utility category and body. Use a plain body without variables, headers or buttons.</li>
        <li>Submit the templates for Meta's review. Approval and the final category are determined by Meta.</li>
        <li>Run a successful provider health check above, then check templates here. Phone registration and a controlled delivery check are also required before notifications can be activated.</li>
      </ol>
      <p>Notifications will use approved templates. Free-form chat replies are not available. Linking a phone alone does not subscribe a member to notifications.</p>
      <a href="https://whatsappbusiness.com/policy/" target="_blank" rel="noopener noreferrer">WhatsApp messaging policy</a>
    </details>
    {status.isLoading && <p role="status">Loading template setup...</p>}
    {status.error && <p role="alert">{status.error.message}</p>}
    {status.data && <>
      <p role="status">{status.data.state === 'verified' ? status.data.messagingEnabled ? 'All template checks passed. Notifications are enabled for eligible recipients.' : 'All template checks passed. Notification delivery remains disabled.'
        : status.data.state === 'attention' ? 'Some templates need attention. Review their status below.'
        : status.data.state === 'checking' ? 'Checking templates with Meta...'
        : status.data.state === 'stale' ? 'The previous checks are out of date. Check provider health and templates again.'
        : status.data.state === 'unavailable' ? 'Meta templates could not be verified. Try again after a minute.' : 'Template approval has not been checked yet.'}</p>
      <div>{status.data.templates.map(template => <details key={template.key} className="integration-inline-guide">
        <summary>{({ task_assignment: 'Task assignments', overdue: 'Overdue tasks', support_update: 'Support updates' } as Record<string,string>)[template.key]}: {labels[template.state] || 'Not verified'}</summary>
        <p>Name: <code style={{ overflowWrap: 'anywhere' }}>{template.name}</code></p>
        <p>Language: English (US) ({template.language}) &middot; Category: {template.category}</p>
        <p><b>Exact template body</b></p><blockquote>{template.body}</blockquote>
      </details>)}</div>
      {status.data.checkedAt && <p className="muted">Last template check: {formatDateTime(status.data.checkedAt)}</p>}
      {!status.data.checkEnabled && <p>Template checks require platform activation, plan access and a successful current provider health check.</p>}
      <button className="btn" disabled={!status.data.checkEnabled || check.isPending || status.data.state === 'checking'} onClick={() => check.mutate()}>
        {check.isPending ? 'Checking templates...' : 'Check templates'}</button>
    </>}
  </section>;
}
