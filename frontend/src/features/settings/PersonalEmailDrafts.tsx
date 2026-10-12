import { continueConnectionInBrowser } from '../../lib/personalConnection';
import { useEffect, useRef, useState } from 'react';
import './PersonalEmailDrafts.css';
import { ApiError } from '../../api/client';
import { integrationsApi, microsoftApi, personalEmailApi } from '../../api/endpoints.platform';
import type { EmailRewriteReceipt, GoogleConnectionStatus, MicrosoftConnectionStatus, PersonalEmailDraft } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Field, PageLoader } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

const blank = { recipient: '', subject: '', body: '', provider: 'google' as 'google' | 'microsoft' };
const errorText = (e: unknown) => e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'The request could not be completed. Reload the saved record to check its status.';
const connectionKey = (s?: GoogleConnectionStatus | MicrosoftConnectionStatus) => s ? JSON.stringify([s.connected, s.connectedAt, 'googleEmail' in s ? s.googleEmail : 'email' in s ? s.email : null, s.mailSendAccess, s.inboxEnabled, s.inboxAccess, 'mailEnabled' in s ? s.mailEnabled : null, 'enabled' in s ? s.enabled : null, 'configured' in s ? s.configured : null]) : '';
const label = (draft: PersonalEmailDraft) => draft.status === 'accepted' ? 'Provider accepted' : ['sending', 'unknown'].includes(draft.status) ? 'Check provider Sent' : 'Draft';

export function PersonalEmailDrafts({ google, googleState = 'ready' }: { google?: GoogleConnectionStatus; googleState?: 'loading' | 'error' | 'ready' }) {
  const wid = useWorkspaceId();
  const uid = useAuth(s => s.ctx?.user.id);
  const microsoft = useWsQuery(['account', 'microsoft-status'], microsoftApi.status);
  // A new grant (even for the same address) retires edits, confirmations and late responses.
  const context = `${wid}:${uid}:${connectionKey(google)}:${googleState}:${connectionKey(microsoft.data)}:${microsoft.isError}`;
  return <EmailStudio key={context} google={google} googleState={googleState} microsoft={microsoft.data} microsoftState={microsoft.isLoading ? 'loading' : microsoft.isError ? 'error' : 'ready'} retryMicrosoft={() => void microsoft.refetch()} />;
}

function EmailStudio({ google, googleState, microsoft, microsoftState, retryMicrosoft }: {
  google?: GoogleConnectionStatus; googleState: 'loading' | 'error' | 'ready'; microsoft?: MicrosoftConnectionStatus;
  microsoftState: 'loading' | 'error' | 'ready'; retryMicrosoft: () => void;
}) {
  const wid = useWorkspaceId();
  const uid = useAuth(s => s.ctx?.user.id);
  const timeZone = useAuth(s => s.ctx?.user.timeZone) || 'UTC';
  const q = useWsQuery(['account', 'email-drafts', uid], personalEmailApi.list);
  const ai = useWsQuery(['account', 'email-options', uid], personalEmailApi.options);
  const [selected, setSelected] = useState<PersonalEmailDraft | null>(null);
  const [fields, setFields] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [style, setStyle] = useState('concise');
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [accessLost, setAccessLost] = useState(false);
  const [rewriteReceipt, setRewriteReceipt] = useState<EmailRewriteReceipt | null>(null);
  const [lastOperation, setLastOperation] = useState<string | null>(null);
  const history = useWsQuery(['account', 'email-rewrites', uid, selected?.id], () => personalEmailApi.rewrites(selected!.id), { enabled: !!selected && !accessLost });
  const alive = useRef(true);
  const blocked = useRef(false);
  const running = useRef(false);
  const accessEpoch = useRef(0);
  const operationEpoch = useRef(0);
  const read = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; read.current?.abort(); }; }, []);
  useEffect(() => {
    const denied = q.error instanceof ApiError && [401, 403].includes(q.error.status) ? q.error : history.error instanceof ApiError && [401, 403, 404].includes(history.error.status) ? history.error : null;
    if (denied) {
      if (!blocked.current) accessEpoch.current++;
      blocked.current = true; read.current?.abort(); setSelected(null); setFields(blank); setRewriteReceipt(null); setLastOperation(null); setRecovery(false); setAccessLost(true); setError(errorText(denied));
    }
  }, [q.error, history.error]);
  const inContext = () => alive.current && useAuth.getState().ctx?.user.id === uid && useAuth.getState().ctx?.current?.id === wid;
  // A successful library reload restores access, but cannot revive an operation
  // started before a denial. Its durable result must be reopened explicitly.
  const active = () => inContext() && !blocked.current && (!running.current || operationEpoch.current === accessEpoch.current);
  const start = () => { if (running.current || blocked.current || !inContext()) return false; operationEpoch.current = accessEpoch.current; running.current = true; setBusy(true); setError(''); return true; };
  const finish = () => { if (inContext()) { running.current = false; setBusy(false); } };
  const isMicrosoft = fields.provider === 'microsoft';
  const providerName = isMicrosoft ? 'Microsoft' : 'Gmail';
  const senderEmail = isMicrosoft ? microsoft?.email : google?.googleEmail;
  const statusState = isMicrosoft ? microsoftState : googleState;
  const enabled = isMicrosoft ? !!(microsoft?.enabled && microsoft.configured) : !!google?.mailEnabled;
  const ready = statusState === 'ready' && enabled && !!(isMicrosoft ? microsoft?.connected && microsoft.mailSendAccess : google?.connected && google.mailSendAccess);
  const readReady = statusState === 'ready' && !!(isMicrosoft ? microsoft?.enabled && microsoft.configured && microsoft.connected && microsoft.inboxEnabled && microsoft.inboxAccess : google?.connected && google.inboxEnabled && google.inboxAccess);
  const dirty = !selected || Object.entries(fields).some(([k, v]) => v !== selected[k as keyof typeof fields]);
  const readOnly = busy || accessLost || (!!selected && selected.status !== 'draft');
  const refresh = () => active() ? invalidateWorkspace(wid, 'account', 'email-drafts') : Promise.resolve();
  const pick = (draft: PersonalEmailDraft | null) => {
    if (!inContext() || (draft && !active())) return;
    setSelected(draft ? { ...draft, provider: draft.provider ?? 'google' } : null);
    setFields(draft ? { recipient: draft.recipient, subject: draft.subject, body: draft.body, provider: draft.provider ?? 'google' } : blank);
    setRecovery(false);
    setRewriteReceipt(null); setLastOperation(null);
  };
  const failure = (e: unknown, uncertain = false) => {
    if (!active()) return;
    if (e instanceof ApiError && [401, 403, 404].includes(e.status)) { accessEpoch.current++; blocked.current = true; read.current?.abort(); pick(null); setAccessLost(true); }
    else if (uncertain) setRecovery(true);
    setError(errorText(e));
  };
  const choose = async (draft: PersonalEmailDraft | null) => {
    if (!start()) return;
    try {
      if (dirty && [fields.recipient, fields.subject, fields.body].some(Boolean) && !(await confirmDialog({ title: 'Discard unsaved edits?', message: 'Your last saved draft will remain available.', confirmText: 'Discard edits' }))) return;
      if (!active()) return;
      if (!draft) { pick(null); return; }
      read.current = new AbortController(); pick(await personalEmailApi.get(draft.id, read.current.signal));
    } catch (e) { failure(e); }
    finally { finish(); }
  };
  const reload = async () => {
    if (!selected || !start()) return;
    try {
      if (dirty && !(await confirmDialog({ title: 'Reload the saved version?', message: 'Unsaved edits will be discarded. Reloading checks the recorded status; it never sends an email or starts AI.', confirmText: 'Reload saved record' }))) return;
      if (!active()) return;
      read.current = new AbortController(); pick(await personalEmailApi.get(selected.id, read.current.signal)); await refresh();
    } catch (e) { failure(e); }
    finally { finish(); }
  };
  const save = async () => {
    if (recovery || !start()) return;
    try {
      const saved = selected ? await personalEmailApi.save(selected.id, { ...fields, version: selected.version }) : await personalEmailApi.create(fields);
      if (!active()) return;
      pick(saved); await refresh(); if (active()) toast('Private draft saved.');
    } catch (e) { failure(e, true); await refresh(); }
    finally { finish(); }
  };
  const send = async () => {
    if (!selected || dirty || !senderEmail || !ready || recovery || !start()) return;
    const snapshot = selected; const sender = senderEmail; let submitted = false;
    try {
      if (!(await confirmDialog({ title: 'Send this saved email?', message: 'From: ' + sender + '\nTo: ' + snapshot.recipient + '\nSubject: ' + snapshot.subject + '\n\n' + snapshot.body + '\n\nYou are approving saved version ' + snapshot.version + '. Sending cannot be undone.', confirmText: 'Confirm and send' })) || !active()) return;
      submitted = true;
      const result = await personalEmailApi.send(snapshot.id, { version: snapshot.version, confirmed: true, senderEmail: sender });
      if (!active()) return;
      pick(result);
      toast(result.status === 'accepted' ? providerName + ' accepted the email. This does not confirm recipient delivery.' : 'Send outcome unknown. Check your provider Sent folder before taking any further action.', result.status === 'accepted' ? 'success' : 'warning');
    } catch (e) { failure(e, submitted); }
    finally {
      if (submitted && active()) {
        await refresh();
        try { if (active()) { const latest = await personalEmailApi.get(snapshot.id); if (active() && latest.status !== 'draft') pick(latest); } }
        catch (e) { failure(e, true); }
      }
      finish();
    }
  };
  const improve = async () => {
    if (!selected || dirty || !ai.data?.available || recovery || !start()) return;
    const snapshot = selected; const credits = ai.data.credits;
    try {
      if (!(await confirmDialog({ title: 'Rewrite this draft with AI?', message: 'Your saved subject and message will be shared with your organization\'s configured AI provider. This uses ' + ai.data.credits + ' AI credits. Review the resulting wording and facts before sending. No email will be sent.', confirmText: 'Generate draft' })) || !active()) return;
      const operationId = crypto.randomUUID(); setLastOperation(operationId);
      const result = await personalEmailApi.rewrite(snapshot.id, { operationId, version: snapshot.version, style, confirmed: true, credits });
      if (!active()) return;
      if (result.status === 'completed' && result.draft && !result.draftChanged) pick(result.draft);
      else { setRecovery(true); setError('Check the saved rewrite result before starting another operation.'); }
      setLastOperation(operationId); setRewriteReceipt(result); await history.refetch();
      await refresh(); if (active()) toast(result.status === 'completed' ? 'AI draft saved. Review the wording and facts before sending.' : 'Rewrite receipt recorded. Check its saved result before continuing.');
    } catch (e) { failure(e, true); await refresh(); }
    finally { finish(); }
  };
  const checkRewrite = async (operation: string) => {
    if (!selected || !start()) return;
    try {
      read.current = new AbortController();
      const receipt = await personalEmailApi.rewriteReceipt(selected.id, operation, read.current.signal);
      if (!active()) return;
      if (receipt.status === 'completed' && receipt.draft && !receipt.draftChanged && !dirty && selected.status === 'draft') pick(receipt.draft);
      setRewriteReceipt(receipt); setLastOperation(operation);
      if (receipt.status === 'pending') { setRecovery(true); setError('This rewrite is still pending. Check its saved result later; a temporary credit hold may remain until recovery.'); }
      else if (recovery && !dirty) { read.current = new AbortController(); const current = await personalEmailApi.get(selected.id, read.current.signal); if (!active()) return; pick(current); setRewriteReceipt(receipt); setLastOperation(operation); }
      await refresh(); if (active()) await history.refetch();
      if (active()) toast('Saved rewrite checked. No new AI request or charge was started.');
    } catch (e) { failure(e); }
    finally { finish(); }
  };
  const reconcile = async () => {
    if (!selected || !readReady || !selected.canReconcile || !start()) return;
    try {
      const result = await personalEmailApi.reconcile(selected.id);
      if (!active()) return;
      pick(result); await refresh();
      if (active()) toast(result.reconciledAt ? 'Matching Sent copy verified. Recipient delivery is not verified.' : 'No conclusive matching Sent copy found. The send remains uncertain; do not resend.', result.reconciledAt ? 'success' : 'warning');
    } catch (e) { failure(e); }
    finally { finish(); }
  };
  const remove = async () => {
    if (!selected || !start()) return;
    try {
      if (!(await confirmDialog({ title: 'Remove this private draft?', message: 'Removing a receipt does not retract an email accepted by your mail provider.', confirmText: 'Remove', danger: true })) || !active()) return;
      await personalEmailApi.remove(selected.id); pick(null); await refresh();
    } catch (e) { failure(e); }
    finally { finish(); }
  };
  const connect = async () => {
    if (continueConnectionInBrowser()) return;
    if (!start()) return;
    try { const { url } = isMicrosoft ? await microsoftApi.connect() : await integrationsApi.googleConnectUrl('/account/integrations', true); if (active()) window.location.assign(url); }
    catch (e) { failure(e); finish(); }
  };
  const acceptedDate = () => {
    if (!selected?.acceptedAt) return '';
    const date = new Date(selected.acceptedAt); if (!Number.isFinite(date.getTime())) return '';
    try { return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }); } catch { return date.toISOString(); }
  };
  const reloadLibrary = async () => { const epoch = accessEpoch.current; const result = await q.refetch(); if (inContext() && epoch === accessEpoch.current && !result.isError) { blocked.current = false; setAccessLost(false); } };
  return <section className="personal-email-studio" aria-labelledby="private-drafts-title" aria-busy={busy}>
    <header className="email-studio-heading"><span className="email-studio-symbol" aria-hidden="true"><Icon name="edit" size={22} /></span><div><span className="studio-eyebrow">WRITE WITH INTENTION</span><h2 id="private-drafts-title">Private email drafts</h2><p>A focused space to write, refine and review.</p></div><button className="btn btn-sm" disabled={busy} onClick={() => void choose(null)}><Icon name="plus" size={15} /> New draft</button></header>
    <div className="email-studio-trust"><span><Icon name="lock" size={13} /> Private to you</span><span>AI only with consent</span><span>Review every send</span></div>
    <div className="personal-email-layout">
      <aside className="email-library" aria-label="Saved private drafts"><div className="email-pane-heading"><h3>Saved drafts & receipts</h3><button className="btn btn-ghost btn-sm" disabled={busy || q.isFetching} onClick={() => void reloadLibrary()} aria-label="Refresh saved drafts"><Icon name="refresh" size={14} /></button></div>
        {q.isLoading ? <PageLoader /> : q.isError || accessLost ? <div className="email-library-empty" role="alert">Could not load drafts. Verify access before reopening private content.<button className="btn btn-sm" onClick={() => void reloadLibrary()}>Reload</button></div> :
          !q.data?.length ? <div className="email-library-empty"><Icon name="note" size={26} /><b>Your writing starts here</b><p>Save a draft to return to it later. Send receipts stay alongside your messages.</p></div> :
            <div className="email-draft-list">{q.data.map(d => <button key={d.id} className="email-draft-item" aria-pressed={selected?.id === d.id} disabled={busy} onClick={() => void choose(d)}><span className={'email-record-status email-status-' + d.status}>{label(d)}</span><strong>{d.subject}</strong><span className="email-draft-recipient">{d.recipient}</span><small>{d.provider === 'microsoft' ? 'Outlook' : 'Gmail'} <span aria-hidden="true">·</span> Version {d.version}</small></button>)}</div>}
      </aside>
      <div className="email-compose">
        <div className="email-pane-heading"><h3>{selected?.status === 'accepted' ? 'Send receipt' : selected && ['sending', 'unknown'].includes(selected.status) ? 'Send status' : 'Compose message'}</h3><span className="email-save-state" role="status">{busy ? 'Working…' : selected && !dirty ? `Saved · v${selected.version}` : 'Unsaved draft'}</span></div>
        <div className="email-compose-content">
          <div className="email-sender"><Field label="Sending account"><select aria-label="Sending account" className="input" value={fields.provider} disabled={readOnly} onChange={e => setFields({ ...fields, provider: e.target.value as 'google' | 'microsoft' })}><option value="google">Google Gmail</option><option value="microsoft">Microsoft Outlook</option></select></Field>
            <div className="email-connection" role="status">{statusState === 'loading' ? 'Checking your connection…' : statusState === 'error' ? <><span>Could not verify the sending account. Sending is disabled.</span><button className="btn btn-sm" onClick={() => isMicrosoft ? retryMicrosoft() : void invalidateWorkspace(wid, 'account', 'google-status')}>Retry connection check</button></> : !enabled ? <span>{providerName} sending is awaiting administrator setup. You can still save drafts.</span> : !ready ? <button className="btn btn-sm" disabled={busy} onClick={() => void connect()}>Enable {providerName} sending</button> : <><span className="email-connected-dot" aria-hidden="true" /><span>{senderEmail || 'Reconnect to verify your sender'}</span></>}</div>
          </div>
          {error && <div className="email-recovery" role="alert"><Icon name="info" size={17} /><div><strong>Check before continuing</strong><p>{error}</p>{recovery && <p>Refresh saved drafts and inspect the saved record before repeating an interrupted action. Reloading never sends an email or starts AI.</p>}</div></div>}
          {selected && ['sending', 'unknown'].includes(selected.status) && <div className="email-recovery" role="alert"><Icon name="clock" size={18} /><div><strong>Check your provider Sent folder</strong><p>The email may have reached your mail provider. Automatic retry and deletion are blocked to prevent duplicate sending.</p>{selected.canReconcile ? readReady ? <button className="btn btn-sm email-check-sent" disabled={busy} onClick={() => void reconcile()}>Check provider Sent</button> : <p>Enable optional inbox read access in your connected account to check Sent here. You can also inspect Sent directly in {providerName}.</p> : <p>This older receipt requires a manual check in your provider.</p>}<p>A matching Sent copy confirms provider acceptance. It does not confirm recipient delivery.</p></div></div>}
          {selected && selected.status !== 'draft' && <div className="email-receipt"><Icon name={selected.status === 'accepted' ? 'checkCircle' : 'clock'} size={18} /><div><strong>{selected.reconciledAt ? 'Sent copy verified' : selected.status === 'accepted' ? `Accepted by ${providerName}` : 'Recorded send attempt'}</strong><p>Sender at confirmation: {selected.confirmedSenderEmail || 'Not recorded on this older receipt'}</p>{selected.status === 'accepted' && <p>{acceptedDate()} · {timeZone}. Recipient delivery is not verified.</p>}</div></div>}
          <Field label="Recipient"><input aria-label="Recipient" className="input" type="email" maxLength={254} value={fields.recipient} disabled={readOnly} onChange={e => setFields({ ...fields, recipient: e.target.value })} /></Field>
          <Field label="Subject"><input aria-label="Subject" className="input" maxLength={200} value={fields.subject} disabled={readOnly} onChange={e => setFields({ ...fields, subject: e.target.value })} /></Field>
          <Field label="Message"><textarea aria-label="Message" className="input email-message" rows={10} maxLength={20000} value={fields.body} disabled={readOnly} onChange={e => setFields({ ...fields, body: e.target.value })} /></Field>
          <div className="email-message-meta"><span>Plain text · one recipient</span><span>{fields.body.length.toLocaleString()} / 20,000</span></div>
          {(!selected || selected.status === 'draft') && <div className="email-ai-tools"><span><Icon name="agent" size={17} /><b>Refine with Agent</b></span>{ai.isLoading ? <small>Checking AI availability…</small> : ai.isError ? <><small>AI availability could not be checked.</small><button className="btn btn-sm" disabled={busy} onClick={() => void ai.refetch()}>Retry AI check</button></> : ai.data?.available ? <><select className="input" aria-label="AI writing style" value={style} disabled={busy} onChange={e => setStyle(e.target.value)}><option value="concise">Concise</option><option value="formal">Formal</option><option value="friendly">Friendly</option></select><button className="btn btn-sm" disabled={busy || recovery || dirty || !selected || fields.body.length > ai.data.maxBodyCharacters} onClick={() => void improve()}>Rewrite with AI · {ai.data.credits} credits</button></> : <small>Manual editing is available. AI awaits administrator setup.</small>}</div>}
          {ai.data?.available && fields.body.length > ai.data.maxBodyCharacters && <p className="email-editor-note">Shorten the message to {ai.data.maxBodyCharacters.toLocaleString()} characters to use AI editing.</p>}
          {selected && !accessLost && <div className="email-rewrite-history" aria-label="Saved AI rewrites"><div className="email-rewrite-heading"><span><Icon name="agent" size={15} /><b>Saved rewrites</b></span><small>Private · retained for 24 hours</small></div><p>Check an interrupted rewrite without starting AI again.</p>{lastOperation && <button className="btn btn-sm" disabled={busy} onClick={() => void checkRewrite(lastOperation)}>Check rewrite result</button>}{history.isLoading ? <small>Loading saved rewrite receipts…</small> : history.isError ? <div role="alert">Rewrite receipts could not be loaded.<button className="btn btn-sm" disabled={busy} onClick={() => void history.refetch()}>Retry receipts</button></div> : history.data?.length ? <div className="email-rewrite-list">{history.data.map(r => <button className="email-rewrite-item" key={r.operationId} disabled={busy} onClick={() => void checkRewrite(r.operationId)}><span>{r.style} · source v{r.sourceVersion}</span><span>{r.status === 'completed' ? `${r.credits} credits · saved` : r.status}</span><Icon name="chevronR" size={13} /></button>)}</div> : <small>No saved rewrites for this draft yet.</small>}{rewriteReceipt && <div className="email-rewrite-result" role="status"><b>{rewriteReceipt.status === 'completed' ? 'Rewrite receipt verified' : `Rewrite ${rewriteReceipt.status}`}</b><p>{rewriteReceipt.status === 'completed' ? `${rewriteReceipt.credits} credits recorded. Opening this receipt does not charge again.` : 'No completed rewrite charge is recorded. Pending holds are recovered after expiry.'}</p>{rewriteReceipt.draft && (rewriteReceipt.draftChanged || dirty || selected.status !== 'draft') && <details><summary>Review earlier wording · source v{rewriteReceipt.sourceVersion}</summary><p>The saved draft has newer changes. This earlier result will not replace them.</p><strong>{rewriteReceipt.draft.subject}</strong><pre>{rewriteReceipt.draft.body}</pre></details>}</div>}</div>}
          <div className="email-compose-actions">
            {(!selected || selected.status === 'draft') && <button className="btn" disabled={busy || recovery || !dirty || !fields.recipient.trim() || !fields.subject.trim() || !fields.body.trim()} onClick={() => void save()}>Save draft</button>}
            {selected?.status === 'draft' && <button className="btn btn-primary" disabled={busy || recovery || dirty || !ready || !senderEmail} onClick={() => void send()}>Review and send</button>}
            {selected && <button className="btn btn-sm" disabled={busy} onClick={() => void reload()}>Reload saved record</button>}
            {selected && !['unknown', 'sending'].includes(selected.status) && <button className="btn btn-ghost btn-sm email-remove" disabled={busy} onClick={() => void remove()}>Remove</button>}
          </div>
          <p className="email-editor-note">{selected?.status === 'draft' && dirty ? 'Save your changes before reviewing the email for sending.' : 'AI wording is a suggestion. Verify names, dates and commitments before sending.'}</p>
        </div>
      </div>
    </div>
  </section>;
}
