import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { integrationsApi, microsoftApi, personalInboxApi } from '../../api/endpoints.platform';
import type { GoogleConnectionStatus, InboxPage, InboxThread } from '../../api/types';
import { Icon } from '../../components/Icon';
import { useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import './PersonalInbox.css';
import { InboxSummary } from './InboxSummary';
import { InboxAttachments } from './InboxAttachments';

export function PersonalInbox({ google }: { google?: GoogleConnectionStatus }) {
  const wid = useWorkspaceId();
  const microsoft = useWsQuery(['account', 'microsoft-status'], microsoftApi.status);
  const timeZone = useAuth(s => s.ctx?.user.timeZone) || 'UTC';
  const [provider, setProvider] = useState<'google' | 'microsoft'>('google');
  const [page, setPage] = useState<InboxPage | null>(null);
  const [thread, setThread] = useState<InboxThread | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const status = provider === 'google' ? { enabled: google?.inboxEnabled, access: google?.inboxAccess, account: google?.googleEmail } : { enabled: microsoft.data?.inboxEnabled, access: microsoft.data?.inboxAccess, account: microsoft.data?.email };
  const allowed = !!status.enabled && !!status.access;
  useEffect(() => {
    sequence.current++; request.current?.abort(); setPage(null); setThread(null); setSelected(null); setError(''); setBusy(false);
    return () => { sequence.current++; request.current?.abort(); };
  }, [wid, provider, status.enabled, status.access, status.account, google?.connectedAt]);
  const failure = (e: unknown) => e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'The mailbox could not be read. Try again.';
  const date = (value: string | null) => {
    if (!value) return '';
    const parsed = new Date(value); if (!Number.isFinite(parsed.getTime())) return '';
    try { return parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }); }
    catch { return parsed.toISOString(); }
  };
  const load = async (cursor?: string) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const current = ++sequence.current; setBusy(true); setError(''); setThread(null); setSelected(null);
    // Retire the previous page immediately; a failed refresh never leaves old content presented as current.
    setPage(null);
    try { const result = await personalInboxApi.list(provider, cursor, controller.signal); if (current === sequence.current) setPage(result); }
    catch (e) { if (current === sequence.current && !controller.signal.aborted) setError(failure(e)); }
    finally { if (current === sequence.current) setBusy(false); }
  };
  const open = async (id: string) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const current = ++sequence.current; setBusy(true); setError(''); setThread(null); setSelected(id);
    try { const result = await personalInboxApi.thread(provider, id, controller.signal); if (current === sequence.current) setThread(result); }
    catch (e) { if (current === sequence.current && !controller.signal.aborted) setError(failure(e)); }
    finally { if (current === sequence.current) setBusy(false); }
  };
  const connect = async () => {
    if (!await confirmDialog({ title: 'Allow private inbox reading?', message: provider === 'google' ? 'Google will ask for read-only Gmail access. Project Tracker reads your own mailbox when you load it or open a thread. This does not grant automatic sending or share email with AI.' : 'Microsoft will ask for Mail.Read alongside the existing profile and sending permissions. Project Tracker reads your own mailbox when you load it or open a thread. Every send still requires confirmation; emails are not automatically shared with AI.', confirmText: 'Continue to consent' })) return;
    setBusy(true);
    try { const { url } = provider === 'google' ? await integrationsApi.googleConnectUrl('/account/integrations', false, true) : await microsoftApi.connect(true); window.location.assign(url); }
    catch (e) { toast(failure(e), 'error'); setBusy(false); }
  };
  return <section className="personal-inbox" aria-labelledby="private-inbox-title">
    <header className="inbox-heading"><div className="inbox-symbol" aria-hidden="true"><Icon name="mail" size={21} /></div><div><span className="studio-eyebrow">YOUR CONNECTED ACCOUNTS</span><h2 id="private-inbox-title">Private inbox</h2><p>Read the conversation. Keep control of what happens next.</p></div><span className="inbox-private"><Icon name="lock" size={13} /> Only you</span></header>
    <div className="inbox-toolbar"><label>Mailbox<select aria-label="Inbox provider" value={provider} onChange={e => setProvider(e.target.value as 'google' | 'microsoft')}><option value="google">Google Gmail</option><option value="microsoft">Microsoft Outlook</option></select></label><span className="inbox-account">{status.account || 'No connected account'}</span>{allowed ? <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void load()}>{page ? 'Refresh inbox' : 'Load inbox'}</button> : status.enabled ? <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void connect()}>Allow inbox access</button> : <span className="inbox-status">Awaiting administrator setup</span>}</div>
    <p className="inbox-consent-note">Mailbox reading is optional. Messages stay in this view and are not automatically sent to AI. Every outgoing email requires a separate confirmation.</p>
    {error && <div role="alert" className="inbox-error">{error}<button className="btn btn-sm" disabled={busy} onClick={() => void (selected ? open(selected) : load())}>Try again</button></div>}
    {allowed && <div className="inbox-workspace" aria-busy={busy}>
      <div className="inbox-list"><div className="inbox-pane-heading"><h3>Recent messages</h3>{page && <span>{page.messages.length} on this page</span>}</div>
        {!page ? <p className="inbox-empty">{busy && !selected ? 'Reading your mailbox…' : 'Load your inbox when you are ready.'}</p> : page.messages.length === 0 ? <p className="inbox-empty">No messages in your inbox.</p> : <div className="inbox-message-list" role="group" aria-label="Inbox messages">{page.messages.map(message => <button type="button" className="inbox-message" key={message.id} aria-pressed={selected === message.id} onClick={() => void open(message.id)}><span className="inbox-message-sender">{message.unread && <i aria-label="Unread" />}{message.sender || 'Unknown sender'}</span><strong>{message.subject || '(No subject)'}</strong><time dateTime={message.receivedAt || undefined}>{date(message.receivedAt)}</time></button>)}</div>}
        {page?.cursor && <button className="btn btn-ghost btn-sm inbox-next" disabled={busy} onClick={() => void load(page.cursor!)}>Next page</button>}
      </div>
      <div className="inbox-reader" role="region" aria-label="Selected email conversation"><div className="inbox-pane-heading"><h3>Conversation</h3>{thread && <span>{thread.messages.length} messages</span>}</div>
        {!thread ? <div className="inbox-empty"><Icon name="mail" size={28} /><p>{busy && selected ? 'Reading this conversation…' : 'Select a message to open its conversation.'}</p></div> : <>
          {thread.truncated && <p className="inbox-truncated" role="status">This is a limited view. Some messages or body content are omitted. Review the complete conversation in your mail provider.</p>}
          {selected && <InboxSummary key={`${wid}:${provider}:${thread.accessContext}:${thread.sourceHash}`} thread={thread} messageId={selected} />}
          {thread.messages.map(message => <article className="inbox-thread-message" key={message.id} id={`inbox-source-${message.id}`} tabIndex={-1}><h4>{message.subject || '(No subject)'}</h4><div className="inbox-thread-meta"><span>{message.sender || 'Unknown sender'}</span><time dateTime={message.receivedAt || undefined}>{date(message.receivedAt)}</time></div><p className="inbox-body">{message.body}</p>{message.hasAttachments && <InboxAttachments key={`${wid}:${provider}:${thread.accessContext}:${message.id}`} provider={provider} messageId={message.id} />}{message.bodyTruncated && <small className="muted">Body content is limited.</small>}</article>)}
        </>}
      </div>
    </div>}
  </section>;
}
