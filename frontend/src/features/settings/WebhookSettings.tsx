import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { webhookApi } from '../../api/endpoints';
import type { Webhook } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Badge, EmptyState, Field, Modal, SubmitButton } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useAuth, useEntitlement, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

/** Settings → Webhooks: tell another system, with a signed request, when something happens here. Owners and admins only. */
export function WebhookSettings() {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const role = useAuth((s) => s.ctx?.current?.role);
  const included = useEntitlement('API_ACCESS') > 0;
  const isAdmin = role === 'Owner' || role === 'Admin';
  const q = useWsQuery(['webhooks'], webhookApi.list, { enabled: isAdmin && included });
  const [modal, setModal] = useState<{ hook?: Webhook } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [log, setLog] = useState<Webhook | null>(null);
  const hooks = q.data ?? [];
  const refresh = () => void qc.invalidateQueries({ queryKey: [wid, 'webhooks'] });
  const fail = (e: unknown, m: string) => toast(e instanceof ApiError ? e.message : m, 'error');

  if (!isAdmin) return null;

  const remove = async (h: Webhook) => {
    if (!(await confirmDialog({ title: 'Delete webhook?', message: `“${h.name}” will stop receiving events and its delivery history is removed.`, confirmText: 'Delete' }))) return;
    try { await webhookApi.remove(h.id); toast('Webhook deleted.', 'warning'); refresh(); } catch (e) { fail(e, 'Could not delete the webhook.'); }
  };
  const test = async (h: Webhook) => {
    try { await webhookApi.test(h.id); toast('Test event queued. It is sent within a few seconds; see “Deliveries”.'); refresh(); } catch (e) { fail(e, 'Could not send a test.'); }
  };
  const rotate = async (h: Webhook) => {
    if (!(await confirmDialog({ title: 'Create a new secret?', message: 'The old secret stops being valid for new deliveries. Update the receiver with the new one.', confirmText: 'New secret' }))) return;
    try { const r = await webhookApi.rotate(h.id); setSecret(r.secret); refresh(); } catch (e) { fail(e, 'Could not rotate the secret.'); }
  };
  const toggle = async (h: Webhook) => {
    try { await webhookApi.update(h.id, { name: h.name, url: h.url, events: h.events, isActive: !h.isActive }); refresh(); } catch (e) { fail(e, 'Could not change the webhook.'); }
  };

  return (
    <div className="card mb-22">
      <div className="card-head">
        <div><h3>Webhooks</h3><p>Send a signed HTTPS request to another system whenever something happens in this workspace.</p></div>
        {included && <button className="btn btn-primary btn-sm" onClick={() => setModal({})}><Icon name="plus" size={14} /> New webhook</button>}
      </div>
      <div className="card-body">
        {!included && <div className="notice">Webhooks are part of the Business plan and above. <Link className="link" to="/settings/billing">See plans</Link></div>}
        {included && hooks.length === 0 && !q.isLoading && <EmptyState icon="bolt" title="No webhooks" text="Add one to be told about new tasks, status changes, sprints and more." />}
        {hooks.length > 0 && (
          <div className="cf-list">
            {hooks.map((h) => (
              <div className="cf-row" key={h.id}>
                <div className="cf-main">
                  <b>{h.name}</b> <Badge tone={h.isActive ? 'success' : 'danger'}>{h.isActive ? 'On' : 'Off'}</Badge>{' '}
                  {h.lastStatus && <Badge tone={h.lastStatus === 'ok' ? 'success' : 'warning'}>{h.lastStatus === 'ok' ? 'Last delivery ok' : 'Last delivery failed'}</Badge>}
                  <div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{h.url}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{h.events.join(', ')}{h.lastDeliveryAt ? ` · last sent ${timeAgo(h.lastDeliveryAt)}` : ' · nothing sent yet'}</div>
                  {h.disabledReason && <div className="form-error" style={{ marginTop: 6 }}>{h.disabledReason}</div>}
                </div>
                <div className="td-actions" style={{ flexWrap: 'wrap' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setLog(h)}>Deliveries</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => void test(h)}>Send test</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => void toggle(h)}>{h.isActive ? 'Turn off' : 'Turn on'}</button>
                  <button type="button" className="btn-icon" title="Edit" aria-label={`Edit ${h.name}`} onClick={() => setModal({ hook: h })}><Icon name="edit" /></button>
                  <button type="button" className="btn-icon" title="New secret" aria-label={`New secret for ${h.name}`} onClick={() => void rotate(h)}><Icon name="lock" /></button>
                  <button type="button" className="btn-icon danger" title="Delete" aria-label={`Delete ${h.name}`} onClick={() => void remove(h)}><Icon name="trash" /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {modal && <HookModal hook={modal.hook} onClose={() => setModal(null)} onSaved={(s) => { setModal(null); refresh(); if (s) setSecret(s); }} />}
      {secret && (
        <Modal size="sm" title="Copy the signing secret now" onClose={() => setSecret(null)} footer={<button type="button" className="btn btn-primary" onClick={() => setSecret(null)}>I've stored it</button>}>
          <p className="muted" style={{ marginTop: 0 }}>Your receiver uses this to check that requests really come from here: the <code>X-PM-Signature</code> header is <code>t=&lt;time&gt;,v1=&lt;HMAC-SHA256 of "time.body"&gt;</code>. It is shown only once.</p>
          <div className="secret-box"><code>{secret}</code></div>
          <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => { void navigator.clipboard?.writeText(secret); toast('Secret copied.'); }}>Copy secret</button>
        </Modal>
      )}
      {log && <DeliveriesModal hook={log} onClose={() => setLog(null)} />}
    </div>
  );
}

function HookModal({ hook, onClose, onSaved }: { hook?: Webhook; onClose: () => void; onSaved: (secret?: string) => void }) {
  const catalogue = useWsQuery(['webhook-events'], webhookApi.events);
  const [name, setName] = useState(hook?.name ?? '');
  const [url, setUrl] = useState(hook?.url ?? '');
  const [all, setAll] = useState(!hook || hook.events.includes('*'));
  const [picked, setPicked] = useState<string[]>(hook?.events.filter((e) => e !== '*') ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const groups = [...new Set((catalogue.data ?? []).map((e) => e.split('.')[0]))];

  const toggleEvent = (e: string) => setPicked((p) => (p.includes(e) ? p.filter((x) => x !== e) : [...p, e]));
  const toggleGroup = (g: string) => {
    const all = (catalogue.data ?? []).filter((e) => e.startsWith(g + '.'));
    setPicked((p) => (all.every((e) => p.includes(e)) ? p.filter((e) => !all.includes(e)) : [...new Set([...p, ...all])]));
  };

  const submit = async () => {
    if (!name.trim()) return setError('Give the webhook a name.');
    if (!url.trim()) return setError('Enter the address that should receive events.');
    if (!all && picked.length === 0) return setError('Choose at least one event, or send everything.');
    setBusy(true); setError(null);
    try {
      const events = all ? ['*'] : picked;
      if (hook) { await webhookApi.update(hook.id, { name: name.trim(), url: url.trim(), events, isActive: hook.isActive }); toast('Webhook updated.'); onSaved(); }
      else { const r = await webhookApi.create({ name: name.trim(), url: url.trim(), events }); toast('Webhook created.'); onSaved(r.secret); }
    } catch (e) { setError(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save the webhook.'); }
    finally { setBusy(false); }
  };

  return (
    <Modal size="lg" title={hook ? 'Edit webhook' : 'New webhook'} onClose={onClose} onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={busy}>{hook ? 'Save webhook' : 'Create webhook'}</SubmitButton></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <Field label="Name" required><input className="input" maxLength={60} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Slack bridge" /></Field>
      <Field label="Address" required hint="Must start with https://. Addresses on private or internal networks are refused."><input className="input" maxLength={500} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/project-management" /></Field>
      <label className="check" style={{ display: 'flex', gap: 8, margin: '6px 0 10px' }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Send every event</label>
      {!all && (
        <div className="event-picker">
          {groups.map((g) => (
            <div key={g} className="event-group">
              <button type="button" className="link" onClick={() => toggleGroup(g)}><b>{g}</b></button>
              {(catalogue.data ?? []).filter((e) => e.startsWith(g + '.')).map((e) => (
                <label key={e} className="check"><input type="checkbox" checked={picked.includes(e)} onChange={() => toggleEvent(e)} /> {e.slice(g.length + 1).replace(/_/g, ' ')}</label>
              ))}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function DeliveriesModal({ hook, onClose }: { hook: Webhook; onClose: () => void }) {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const q = useWsQuery(['webhooks', hook.id, 'deliveries'], () => webhookApi.deliveries(hook.id), { refetchInterval: 4000 });
  const rows = q.data ?? [];
  const retry = async (id: string) => {
    try { await webhookApi.retry(hook.id, id); void qc.invalidateQueries({ queryKey: [wid, 'webhooks', hook.id, 'deliveries'] }); toast('Queued to send again.'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not retry.', 'error'); }
  };
  return (
    <Modal size="lg" title={`Deliveries · ${hook.name}`} subtitle="The last 50 events sent to this address" onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}>
      {rows.length === 0 ? <EmptyState icon="bolt" title="Nothing sent yet" text="Events appear here a few seconds after they happen." /> : (
        <div className="cf-list">
          {rows.map((d) => (
            <div className="cf-row" key={d.id}>
              <div className="cf-main">
                <code>{d.eventType}</code> <Badge tone={d.status === 'Succeeded' ? 'success' : d.status === 'Failed' ? 'danger' : 'info'}>{d.status === 'Pending' ? 'Waiting' : d.status}</Badge>
                <div className="muted" style={{ fontSize: 12 }}>
                  {timeAgo(d.createdAt)} · {d.attempts} attempt{d.attempts === 1 ? '' : 's'}{d.responseStatus ? ` · answered ${d.responseStatus}` : ''}{d.error ? ` · ${d.error}` : ''}
                  {d.nextAttemptAt && d.status === 'Pending' && d.attempts > 0 ? ` · next try ${timeAgo(d.nextAttemptAt).includes('ago') ? 'shortly' : 'later'}` : ''}
                </div>
              </div>
              {d.status === 'Failed' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void retry(d.id)}>Retry</button>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
