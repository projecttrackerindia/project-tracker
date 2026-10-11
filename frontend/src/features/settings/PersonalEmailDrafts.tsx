import { useState } from 'react';
import './PersonalEmailDrafts.css';
import { ApiError } from '../../api/client';
import { integrationsApi, microsoftApi, personalEmailApi } from '../../api/endpoints.platform';
import type { GoogleConnectionStatus, PersonalEmailDraft } from '../../api/types';
import { Field, PageLoader } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

const blank = { recipient: '', subject: '', body: '', provider: 'google' as 'google' | 'microsoft' };
const errorText = (e: unknown) => e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'The request could not be completed. Reload to check its status.';

export function PersonalEmailDrafts({ google }: { google?: GoogleConnectionStatus }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['account', 'email-drafts'], personalEmailApi.list);
  const microsoft = useWsQuery(['account', 'microsoft-status'], microsoftApi.status);

  const [selected, setSelected] = useState<PersonalEmailDraft | null>(null);
  const [fields, setFields] = useState(blank);
  const isMicrosoft = fields.provider === 'microsoft';
  const providerName = isMicrosoft ? 'Microsoft' : 'Gmail';
  const senderEmail = isMicrosoft ? microsoft.data?.email : google?.googleEmail;
  const ready = isMicrosoft ? !!(microsoft.data?.enabled && microsoft.data.configured && microsoft.data.mailSendAccess) : !!(google?.mailEnabled && google.mailSendAccess);
  const [busy, setBusy] = useState(false);
  const [style, setStyle] = useState('concise');
  const ai = useWsQuery(['account', 'email-options'], personalEmailApi.options);
  const dirty = !selected || Object.entries(fields).some(([k, v]) => v !== selected[k as keyof typeof fields]);
  const readOnly = busy || (!!selected && selected.status !== 'draft');
  const refresh = () => invalidateWorkspace(wid, 'account', 'email-drafts');
  const pick = (draft: PersonalEmailDraft | null) => {
    setSelected(draft ? { ...draft, provider: draft.provider ?? 'google' } : null); setFields(draft ? { recipient: draft.recipient, subject: draft.subject, body: draft.body, provider: draft.provider ?? 'google' } : blank);
  };
  const choose = async (draft: PersonalEmailDraft | null) => {
    if (dirty && [fields.recipient, fields.subject, fields.body].some(Boolean) && !(await confirmDialog({ title: 'Discard unsaved edits?', message: 'Your last saved draft will remain available.', confirmText: 'Discard edits' }))) return;
    if (!draft) { pick(null); return; }
    setBusy(true);
    try { pick(await personalEmailApi.get(draft.id)); }
    catch (e) { toast(errorText(e), 'error'); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try {
      const saved = selected ? await personalEmailApi.save(selected.id, { ...fields, version: selected.version }) : await personalEmailApi.create(fields);
      pick(saved); await refresh(); toast('Private draft saved.');
    } catch (e) { toast(errorText(e), 'error'); await refresh(); }
    finally { setBusy(false); }
  };
  const send = async () => {
    if (!selected || dirty || !senderEmail || !ready) return;
    const snapshot = selected; const sender = senderEmail; setBusy(true);
    try {
      if (!(await confirmDialog({ title: 'Send this saved email?', message: 'From: ' + sender + '\nTo: ' + snapshot.recipient + '\nSubject: ' + snapshot.subject + '\n\n' + snapshot.body + '\n\nYou are approving saved version ' + snapshot.version + '. Sending cannot be undone.', confirmText: 'Confirm and send' }))) return;
      const result = await personalEmailApi.send(snapshot.id, { version: snapshot.version, confirmed: true, senderEmail: sender });
      pick(result);
      toast(result.status === 'accepted' ? providerName + ' accepted the email. This does not confirm recipient delivery.' : 'Send outcome unknown. Check your provider Sent folder before taking any further action.', result.status === 'accepted' ? 'success' : 'warning');
    } catch (e) { toast(errorText(e), 'error'); }
    finally {
      await refresh();
      try { const latest = await personalEmailApi.get(snapshot.id); if (latest.status !== 'draft') pick(latest); } catch { /* Receipt remains available from the reload controls. */ }
      setBusy(false);
    }
  };
  const improve = async () => {
    if (!selected || dirty || !ai.data?.available) return;
    const snapshot = selected; const operationId = crypto.randomUUID(); setBusy(true);
    try {
      if (!(await confirmDialog({ title: 'Rewrite this draft with AI?', message: 'Your saved subject and message will be shared with your organization\'s configured AI provider. This uses ' + ai.data.credits + ' AI credits. Review the resulting wording and facts before sending. No email will be sent.', confirmText: 'Generate draft' }))) return;
      pick(await personalEmailApi.improve(snapshot.id, { operationId, version: snapshot.version, style, confirmed: true }));
      await refresh(); toast('AI draft saved. Review the wording and facts before sending.');
    } catch (e) { toast(errorText(e), 'error'); await refresh(); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!selected || !(await confirmDialog({ title: 'Remove this private draft?', message: 'Removing a receipt does not retract an email accepted by your mail provider.', confirmText: 'Remove', danger: true }))) return;
    setBusy(true);
    try { await personalEmailApi.remove(selected.id); pick(null); await refresh(); }
    catch (e) { toast(errorText(e), 'error'); }
    finally { setBusy(false); }
  };
  const connect = async () => {
    setBusy(true);
    try { const { url } = isMicrosoft ? await microsoftApi.connect() : await integrationsApi.googleConnectUrl('/account/integrations', true); window.location.assign(url); }
    catch (e) { toast(errorText(e), 'error'); setBusy(false); }
  };
  return <section className="card" style={{ padding: 22, marginTop: 20 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
      <div><h2 style={{ margin: 0 }}>Private email drafts</h2><p className="muted">Save and review your message before sending from your own connected account.</p></div>
      <button className="btn" disabled={busy} onClick={() => void choose(null)}>New draft</button>
    </div>
    <p className="muted" style={{ fontSize: 13 }}>Only you can access these drafts in this workspace. Email permission is optional and does not provide inbox access.</p>
    <Field label="Sending account">
      <select aria-label="Sending account" className="input" style={{ maxWidth: 280 }} value={fields.provider} disabled={readOnly} onChange={e => setFields({ ...fields, provider: e.target.value as 'google' | 'microsoft' })}>
        <option value="google">Google Gmail</option><option value="microsoft">Microsoft Outlook</option>
      </select>
    </Field>
    {(isMicrosoft ? !microsoft.data?.enabled || !microsoft.data.configured : !google?.mailEnabled) ?
      <p className="muted">{providerName} sending is awaiting administrator setup. You can still write and save drafts.</p> :
      !ready ? <button className="btn" disabled={busy} onClick={() => void connect()}>Enable {providerName} sending</button> :
      <p className="muted">Connected sender: <b>{senderEmail || 'Reconnect to verify your sender'}</b></p>}
    <div className="personal-email-layout">
      <div aria-label="Saved private drafts">
        {q.isLoading ? <PageLoader /> : q.isError ? <p role="alert">Could not load drafts. <button className="btn btn-sm" onClick={() => void q.refetch()}>Reload</button></p> :
          !q.data?.length ? <p className="muted">Your saved drafts will appear here.</p> :
            <div style={{ display: 'grid', gap: 8 }}>{q.data.map(d => <button key={d.id} className={'btn ' + (selected?.id === d.id ? 'btn-primary' : '')} style={{ textAlign: 'left', display: 'grid', justifyItems: 'start', gap: 4, height: 'auto', minHeight: 64, padding: 12, whiteSpace: 'normal', overflowWrap: 'anywhere' }} disabled={busy} onClick={() => void choose(d)}>
              <b>{d.subject}</b><span style={{ fontSize: 12 }}>{d.recipient} · {d.status === 'accepted' ? 'Accepted by ' + (d.provider === 'microsoft' ? 'Microsoft' : 'Gmail') : d.status === 'sending' || d.status === 'unknown' ? 'Check provider Sent' : 'Draft'}</span>
            </button>)}</div>}
      </div>
      <div style={{ minWidth: 0 }}>
        <Field label="Recipient"><input aria-label="Recipient" className="input" type="email" maxLength={254} value={fields.recipient} disabled={readOnly} onChange={e => setFields({ ...fields, recipient: e.target.value })} /></Field>
        <Field label="Subject"><input aria-label="Subject" className="input" maxLength={200} value={fields.subject} disabled={readOnly} onChange={e => setFields({ ...fields, subject: e.target.value })} /></Field>
        <Field label="Message"><textarea aria-label="Message" className="input" style={{ minHeight: 180, resize: 'vertical' }} rows={10} maxLength={20000} value={fields.body} disabled={readOnly} onChange={e => setFields({ ...fields, body: e.target.value })} /></Field>
        {selected && ['sending', 'unknown'].includes(selected.status) && <p role="alert" className="form-error">The email may have reached your mail provider. Check your Sent folder. Automatic retry and deletion are blocked to prevent duplicate sending.</p>}
        {selected && selected.status !== 'draft' && <p className="muted">Sender at confirmation: {selected.confirmedSenderEmail || 'Not recorded on this older receipt'}</p>}
        {selected?.status === 'accepted' && <p className="muted">Accepted by {providerName} {selected.acceptedAt ? new Date(selected.acceptedAt).toLocaleString() : ''}. Recipient delivery is not verified.</p>}
        {(!selected || selected.status === 'draft') && ai.data?.available && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <select className="input" aria-label="AI writing style" style={{ width: 'auto' }} value={style} disabled={busy} onChange={e => setStyle(e.target.value)}>
            <option value="concise">Concise</option><option value="formal">Formal</option><option value="friendly">Friendly</option>
          </select>
          <button className="btn" disabled={busy || dirty || !selected || fields.body.length > ai.data.maxBodyCharacters} onClick={() => void improve()}>Rewrite with AI · {ai.data.credits} credits</button>
        </div>}
        {ai.data?.available && fields.body.length > ai.data.maxBodyCharacters && <p className="muted">Shorten the message to {ai.data.maxBodyCharacters.toLocaleString()} characters to use AI editing.</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {(!selected || selected.status === 'draft') && <button className="btn" disabled={busy || !dirty || !fields.recipient.trim() || !fields.subject.trim() || !fields.body.trim()} onClick={() => void save()}>Save draft</button>}
          {selected?.status === 'draft' && <button className="btn btn-primary" disabled={busy || dirty || !ready || !senderEmail} onClick={() => void send()}>Review and send</button>}
          {selected && !['unknown', 'sending'].includes(selected.status) && <button className="btn btn-ghost" disabled={busy} onClick={() => void remove()}>Remove</button>}
        </div>
        {selected?.status === 'draft' && dirty && <p className="muted" style={{ fontSize: 12 }}>Save your changes before reviewing the email for sending.</p>}
      </div>
    </div>
  </section>;
}
