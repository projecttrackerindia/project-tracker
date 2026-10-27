import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { integrationsApi, microsoftApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { PageLoader, Spinner } from '../../components/ui';
import { invalidateWorkspace } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { CompanyConnect, CompanyMailDialog, ConnectModal, KIND_COLOR, errText, reconnect, useMailAccounts } from '../mailbox/MailParts';
import { mailboxApi } from '../mailbox/mailboxApi';
import { SGroup, SPaneHead, SRow, STile } from './Grouped';

const HERE = '/settings/integrations/mail';

/**
 * Settings › Integrations › Mail: the one place mail is connected. Your own accounts (Gmail, Outlook, Rediffmail and other IMAP mail,
 * your company mailbox) for everyone; the organisation's mail server (IMAP/POP + SMTP, set once) for owners and admins.
 */
export function MailIntegrationSettings() {
  const wid = useWorkspaceId();
  const { google, ms, imap, accounts, loading } = useMailAccounts();
  const [connect, setConnect] = useState<null | { guide: 'gmail' | 'outlook' | null }>(null);
  const [company, setCompany] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const refresh = () => { void invalidateWorkspace(wid, 'mailbox'); void invalidateWorkspace(wid, 'account'); };

  // Back from Google or Microsoft.
  useEffect(() => {
    const g = params.get('google'), m = params.get('microsoft');
    if (!g && !m) return;
    const outcome = g ?? m;
    toast(outcome === 'connected' ? `${g ? 'Gmail' : 'Outlook'} connected.` : outcome === 'declined' ? 'The connection was cancelled.' : 'The mail account could not be connected. Try again.', outcome === 'connected' ? 'success' : 'info');
    refresh();
    const n = new URLSearchParams(params); n.delete('google'); n.delete('microsoft'); setParams(n, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <PageLoader />;
  const data = imap.data;
  const g = google.data, o = ms.data;
  const gmailAvailable = g?.inboxEnabled !== false && g?.configured !== false;
  const outlookAvailable = !!(o?.enabled && o.configured && o.inboxEnabled !== false);
  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try { await fn(); toast(done); refresh(); } catch (e) { toast(errText(e, 'That did not work. Please try again.'), 'error'); } finally { setBusy(null); }
  };
  const off = async (name: string, fn: () => Promise<unknown>) => {
    if (!(await confirmDialog({ title: `Stop using ${name} for mail?`, message: 'Mail stops reading and sending from this account. Calendar, meetings and anything else you connected keep working.', confirmText: 'Turn off' }))) return;
    await run(name, fn, `${name}: mail off.`);
  };
  const mineIsCompany = !!data?.company && data.imap.some((a) => data.company!.domains.some((d) => a.email.toLowerCase().endsWith(`@${d}`)));

  return (
    <div className="sg-pane" data-setting="integrations.mail" data-testid="mail-integration">
      <SPaneHead icon="✉" color="#0071e3" title="Mail" sub="Connect your mailboxes once. Read, reply and let the assistant turn mail into work in Mail." />

      <SGroup label="Your mail accounts">
        <SRow icon={<STile color={KIND_COLOR.gmail}>M</STile>} title="Gmail" sub={g?.connected ? `${g.googleEmail ?? 'Connected'}${g.inboxAccess && g.mailSendAccess ? ' · read and send' : g.inboxAccess ? ' · read only' : ' · mail not allowed yet'}` : gmailAvailable ? 'Not connected' : 'Gmail is not set up on this installation.'}>
          {g?.connected && (g.inboxAccess || g.mailSendAccess)
            ? <button type="button" className="btn btn-sm btn-ghost" disabled={busy !== null} data-testid="mail-gmail-off" onClick={() => void off('Gmail', async () => { if (g.inboxAccess) await integrationsApi.googleFeatureOff('inbox'); if (g.mailSendAccess) await integrationsApi.googleFeatureOff('mail'); })}>Turn off</button>
            : gmailAvailable && <button type="button" className="btn btn-sm btn-primary" data-testid="mail-gmail-connect" onClick={() => void reconnect('gmail', HERE)}>{g?.connected ? 'Allow mail' : 'Connect'}</button>}
        </SRow>
        <SRow icon={<STile color={KIND_COLOR.outlook}>O</STile>} title="Outlook" sub={o?.connected ? `${o.email ?? 'Connected'}${o.inboxAccess ? ' · read and send' : ' · mail not allowed yet'}` : outlookAvailable ? 'Not connected' : 'Microsoft is not set up on this installation yet.'}>
          {o?.connected && (o.inboxAccess || o.mailSendAccess)
            ? <button type="button" className="btn btn-sm btn-ghost" disabled={busy !== null} onClick={() => void off('Outlook', async () => { if (o.inboxAccess) await microsoftApi.featureOff('inbox'); if (o.mailSendAccess) await microsoftApi.featureOff('mail'); })}>Turn off</button>
            : outlookAvailable && <button type="button" className="btn btn-sm btn-primary" onClick={() => void reconnect('outlook', HERE)}>{o?.connected ? 'Allow mail' : 'Connect'}</button>}
        </SRow>
        {(data?.imap ?? []).map((a) => (
          <SRow key={a.id} icon={<STile color={KIND_COLOR.imap}>{a.name[0]}</STile>} title={a.name} sub={<>{a.email}{a.lastError ? <span className="danger"> · {a.lastError}</span> : a.lastSyncedAt ? ' · syncing' : ''}</>}>
            <button type="button" className="btn btn-sm btn-ghost danger" disabled={busy !== null} onClick={async () => {
              if (!(await confirmDialog({ title: `Disconnect ${a.email}?`, message: 'Its stored password is deleted. Mail stays in the mailbox itself.', confirmText: 'Disconnect', danger: true }))) return;
              await run(a.id, () => mailboxApi.disconnectImap(a.id), 'Mailbox disconnected.');
            }}>{busy === a.id ? <Spinner /> : 'Disconnect'}</button>
          </SRow>
        ))}
        <SRow icon={<STile color="#8e8e93"><Icon name="plus" size={14} /></STile>} title="Add an account" sub="Rediffmail, Zoho, Yahoo, Gmail with an app password, or any IMAP mail.">
          <button type="button" className="btn btn-sm" onClick={() => setConnect({ guide: null })} data-testid="mail-add">Add</button>
        </SRow>
      </SGroup>

      {data?.company && !mineIsCompany && (
        <SGroup label={`Your ${data.company.name} mailbox`}>
          <div className="mail-int-company"><CompanyConnect accounts={data} onConnected={refresh} /></div>
        </SGroup>
      )}

      {data?.canManageCompany && (
        <SGroup label="Organisation mail server">
          <SRow icon={<STile color="#636366"><Icon name="building" size={14} /></STile>}
            title={data.company ? `${data.company.name} · ${data.company.domains.join(', ')}` : 'Not set up'}
            sub={data.company ? `${data.company.incoming.toUpperCase()} ${data.company.incomingHost}:${data.company.incomingPort} · SMTP ${data.company.smtpHost}:${data.company.smtpPort}. Members connect with just their password.`
              : 'Set the company’s incoming (IMAP or POP) and SMTP servers once; everyone on your domains then connects with just their password.'}>
            <button type="button" className="btn btn-sm" onClick={() => setCompany(true)} data-testid="mail-company-setup">{data.company ? 'Edit' : 'Set up'}</button>
          </SRow>
        </SGroup>
      )}

      <SGroup>
        <SRow icon={<STile color="linear-gradient(180deg,#3a9bff,#0071e3)"><Icon name="mail" size={14} /></STile>} title="Open Mail" sub={`${accounts.length} account${accounts.length === 1 ? '' : 's'} connected. Private to you; stored encrypted.`}>
          <Link className="btn btn-sm" to="/mail">Open</Link>
        </SRow>
      </SGroup>

      {connect && <ConnectModal accountsData={data} presets={data?.presets ?? []} google={g} microsoft={o} imapAccounts={data?.imap ?? []} guide={connect.guide}
        onClose={() => setConnect(null)} onConnected={refresh} />}
      {company && data && <CompanyMailDialog accounts={data} onClose={() => setCompany(false)} onSaved={() => { setCompany(false); refresh(); }} />}
    </div>
  );
}
