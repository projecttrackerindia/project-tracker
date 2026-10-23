import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { projectApi, webhookApi } from '../../api/endpoints';
import type { Priority, Webhook, WebhookDelivery, WebhookFormat } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Badge, EmptyState, ErrorState, Field, Modal, SubmitButton } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useAuth, useEntitlement, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { IntegrationSetupGuides, WebhookSetupSteps } from './IntegrationSetupGuides';
import { IncomingWebhooks } from './IncomingWebhooks';
import { Select } from '../../components/Select';

/** Settings → Webhooks: tell another system, with a signed request, when something happens here. Owners and admins only. */
export function WebhookSettings() {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const role = useAuth((s) => s.ctx?.current?.role);
  const included = useEntitlement('API_ACCESS') > 0;
  const isAdmin = role === 'Owner' || role === 'Admin';
  const q = useWsQuery(['webhooks'], webhookApi.list, { enabled: isAdmin && included });
  const [modal, setModal] = useState<{ hook?: Webhook; format?: WebhookFormat } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [log, setLog] = useState<Webhook | null>(null);
  const hooks = q.data ?? [];
  const projects = useWsQuery(['projects', 'webhook-filters'], () => projectApi.list({ pageSize: 200 }), { enabled: isAdmin && included && hooks.some(hasFilters), staleTime: 300_000 });
  const projectNames = Object.fromEntries((projects.data?.items ?? []).map((p) => [p.id, p.name]));
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
    try { await webhookApi.update(h.id, { name: h.name, url: h.url, events: h.events, isActive: !h.isActive, format: h.format }); refresh(); } catch (e) { fail(e, 'Could not change the webhook.'); }
  };

  return (
    <>
    <IntegrationSetupGuides included={included} onCreate={(format) => setModal({ format })} />
    <div className="card mb-22">
      <div className="card-head">
        <div><h3>Saved connections</h3><p>Manage destinations, choose events and review delivery history.</p></div>
        {included && <button className="btn btn-primary btn-sm" onClick={() => setModal({})}><Icon name="plus" size={14} /> New webhook</button>}
      </div>
      <div className="card-body">
        {!included && <div className="notice">Your current plan does not include webhook access. <Link className="link" to="/settings/billing">See plans</Link></div>}
        {included && q.isLoading && <p className="muted" role="status">Loading saved connections…</p>}
        {included && q.isError && <ErrorState error={q.error} retry={() => void q.refetch()} />}
        {included && hooks.length === 0 && !q.isLoading && !q.isError && <EmptyState icon="bolt" title="No webhooks" text="Add one to be told about new tasks, status changes, sprints and more." />}
        {!q.isError && hooks.length > 0 && (
          <div className="cf-list">
            {hooks.map((h) => (
              <div className="cf-row" key={h.id}>
                <div className="cf-main">
                  <b>{h.name}</b> <Badge tone={h.isActive ? 'success' : 'danger'}>{h.isActive ? 'On' : 'Off'}</Badge>{' '}
                  {h.format !== 'Json' && <Badge tone="purple">{h.format === 'Slack' ? 'Slack' : 'Teams'}</Badge>}{' '}
                  {h.events.includes('audit.logged') && <Badge tone="info">Audit stream</Badge>}{' '}
                  {h.lastStatus && <Badge tone={h.lastStatus === 'ok' ? 'success' : 'warning'}>{h.lastStatus === 'ok' ? 'Last delivery ok' : 'Last delivery failed'}</Badge>}
                  <div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{h.url}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{h.events.join(', ')}{h.lastDeliveryAt ? ` · last sent ${timeAgo(h.lastDeliveryAt)}` : ' · nothing sent yet'}</div>
                  {h.health && h.health.total > 0 && (
                    <div className={`hook-health ${h.health.successRate != null && h.health.successRate < 90 ? 'bad' : ''}`} aria-label={`Health of ${h.name}`}>
                      <b>{h.health.successRate}% delivered</b> · {h.health.total} in 7 days{h.health.failed ? ` · ${h.health.failed} failed` : ''}{h.health.averageMs != null ? ` · ${h.health.averageMs} ms on average` : ''}
                    </div>
                  )}
                  {hasFilters(h) && <div className="muted" style={{ fontSize: 12 }}>Filtered: {filterText(h, projectNames)}</div>}
                  {h.isActive && h.consecutiveFailures > 0 && <div className="form-error" style={{ marginTop: 6 }}>{h.consecutiveFailures} deliveries in a row failed; it switches off after {h.disableAfter ?? 10}.</div>}
                  {h.disabledReason && <div className="form-error" style={{ marginTop: 6 }}>{h.disabledReason}</div>}
                </div>
                <div className="td-actions" style={{ flexWrap: 'wrap' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setLog(h)}>Deliveries & health</button>
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
      {modal && <HookModal hook={modal.hook} initialFormat={modal.format} onClose={() => setModal(null)} onSaved={(s) => { setModal(null); refresh(); if (s) setSecret(s); }} />}
      {secret && (
        <Modal size="sm" title="Copy the signing secret now" onClose={() => setSecret(null)} footer={<button type="button" className="btn btn-primary" onClick={() => setSecret(null)}>I've stored it</button>}>
          <p className="muted" style={{ marginTop: 0 }}>Your receiver uses this to check that requests really come from here: the <code>X-PM-Signature</code> header is <code>t=&lt;time&gt;,v1=&lt;HMAC-SHA256 of "time.body"&gt;</code>. It is shown only once.</p>
          <div className="secret-box"><code>{secret}</code></div>
          <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => { void navigator.clipboard?.writeText(secret); toast('Secret copied.'); }}>Copy secret</button>
        </Modal>
      )}
      {log && <DeliveriesModal hook={log} onClose={() => setLog(null)} />}
    </div>
    {included && hooks.length > 0 && <EventExplorer hooks={hooks} />}
    {included && <IncomingWebhooks />}
    </>
  );
}

const hasFilters = (h: Webhook) => (h.filterProjects?.length ?? 0) + (h.filterPriorities?.length ?? 0) + (h.filterStatuses?.length ?? 0) > 0;
function filterText(h: Webhook, names: Record<string, string>) {
  const parts: string[] = [];
  if (h.filterProjects?.length) parts.push(`projects ${h.filterProjects.map((p) => names[p] ?? 'a removed project').join(', ')}`);
  if (h.filterPriorities?.length) parts.push(`priority ${h.filterPriorities.join(' or ')}`);
  if (h.filterStatuses?.length) parts.push(`status changes to ${h.filterStatuses.join(' or ')}`);
  return parts.join(' · ');
}
const PRIORITIES: Priority[] = ['Low', 'Medium', 'High', 'Critical'];

function HookModal({ hook, initialFormat, onClose, onSaved }: { hook?: Webhook; initialFormat?: WebhookFormat; onClose: () => void; onSaved: (secret?: string) => void }) {
  const catalogue = useWsQuery(['webhook-events'], webhookApi.events);
  const [name, setName] = useState(hook?.name ?? '');
  const [url, setUrl] = useState(hook?.url ?? '');
  const [all, setAll] = useState(!hook || hook.events.includes('*'));
  const [picked, setPicked] = useState<string[]>(hook?.events.filter((e) => e !== '*' && (hook.events.includes('*') ? e !== 'audit.logged' : true)) ?? []);
  const [format, setFormat] = useState<WebhookFormat>(hook?.format ?? initialFormat ?? 'Json');
  const [audit, setAudit] = useState(!!hook?.events.includes('*') && hook.events.includes('audit.logged'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filterOpen, setFilterOpen] = useState(!!hook && hasFilters(hook));
  const [fProjects, setFProjects] = useState<string[]>(hook?.filterProjects ?? []);
  const [fPriorities, setFPriorities] = useState<Priority[]>(hook?.filterPriorities ?? []);
  const [fStatuses, setFStatuses] = useState((hook?.filterStatuses ?? []).join(', '));
  const projects = useWsQuery(['projects', 'webhook-filters'], () => projectApi.list({ pageSize: 200 }), { enabled: filterOpen, staleTime: 300_000 });
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
      const events = all ? (audit ? ['*', 'audit.logged'] : ['*']) : picked;
      const filters = { filterProjects: fProjects, filterPriorities: fPriorities, filterStatuses: fStatuses.split(',').map((x) => x.trim()).filter(Boolean) };
      if (hook) { await webhookApi.update(hook.id, { name: name.trim(), url: url.trim(), events, isActive: hook.isActive, format, ...filters }); toast('Webhook updated.'); onSaved(); }
      else {
        const r = await webhookApi.create({ name: name.trim(), url: url.trim(), events, format, ...filters });
        toast(format === 'Json' ? 'Webhook created.' : `Connected. Send a test to see it in the ${format === 'Slack' ? 'Slack' : 'Teams'} channel.`);
        onSaved(format === 'Json' ? r.secret : undefined);   // chat channels do not check signatures
      }
    } catch (e) { setError(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save the webhook.'); }
    finally { setBusy(false); }
  };

  return (
    <Modal size="lg" title={hook ? 'Edit webhook' : 'New webhook'} onClose={onClose} onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={busy}>{hook ? 'Save webhook' : 'Create webhook'}</SubmitButton></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="hook-form">
      <div className="field">
        <label>Send to</label>
        <div className="method-picker hook-formats" role="radiogroup" aria-label="Send to">
          {([['Json', 'Your own system', 'Signed JSON events (X-PM-Signature).'], ['Slack', 'A Slack channel', 'A readable message with a link back.'], ['Teams', 'A Microsoft Teams channel', 'An Adaptive Card with a link back.']] as const).map(([id, label, hint]) => (
            <button key={id} type="button" role="radio" aria-checked={format === id} className={`method-option ${format === id ? 'on' : ''}`} onClick={() => setFormat(id)}><b>{label}</b><span>{hint}</span></button>
          ))}
        </div>
      </div>
      <Field label="Name" required><input className="input" maxLength={60} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={format === 'Json' ? 'Billing system' : format === 'Slack' ? '#delivery in Slack' : 'Delivery channel in Teams'} /></Field>
      <Field label="Address" required hint={format === 'Slack' ? 'Paste the incoming webhook URL generated for your Slack channel. Expand the setup steps below for help.'
        : format === 'Teams' ? 'Paste your Teams Workflows URL. Use the Anyone trigger option for this connection; setup steps are below.'
        : 'Must start with https://. Addresses on private or internal networks are refused.'}>
        <input className="input" maxLength={500} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={format === 'Slack' ? 'https://hooks.slack.com/services/…' : format === 'Teams' ? 'https://….logic.azure.com/workflows/…' : 'https://example.com/hooks/project-management'} />
      </Field>
      </div>
      <details className="integration-inline-guide"><summary>Setup steps for {format === 'Json' ? 'your own system' : format === 'Slack' ? 'Slack' : 'Microsoft Teams'}</summary><WebhookSetupSteps format={format} /></details>
      <label className="check" style={{ display: 'flex', gap: 8, margin: '6px 0 10px' }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Send every event</label>
      {all && format === 'Json' && <label className="check" style={{ display: 'flex', gap: 8, margin: '-4px 0 10px' }}><input type="checkbox" checked={audit} onChange={(e) => setAudit(e.target.checked)} /> Also stream the audit log (sign-ins, permission and security changes) to this address</label>}
      {!all && (
        <div className="event-picker">
          {groups.map((g) => (
            <div key={g} className="event-group">
              <button type="button" className="link" onClick={() => toggleGroup(g)}><b>{g === 'audit' ? 'audit log (for a SIEM)' : g}</b></button>
              {(catalogue.data ?? []).filter((e) => e.startsWith(g + '.')).map((e) => (
                <label key={e} className="check"><input type="checkbox" checked={picked.includes(e)} onChange={() => toggleEvent(e)} /> {e.slice(g.length + 1).replace(/_/g, ' ')}</label>
              ))}
            </div>
          ))}
        </div>
      )}
      <details className="hook-filters" open={filterOpen} onToggle={(e) => setFilterOpen((e.target as HTMLDetailsElement).open)}>
        <summary>Filters {fProjects.length + fPriorities.length + (fStatuses.trim() ? 1 : 0) > 0 ? <Badge tone="info">On</Badge> : <span className="muted">(optional: fewer, more useful calls)</span>}</summary>
        <div className="hook-filter-grid">
          <fieldset>
            <legend>Only these projects</legend>
            {projects.isLoading ? <span className="muted">Loading projects…</span> : (projects.data?.items ?? []).length === 0 ? <span className="muted">No projects yet.</span> : (
              <div className="hook-filter-list">
                {(projects.data?.items ?? []).map((p) => (
                  <label key={p.id} className="hook-check"><input type="checkbox" checked={fProjects.includes(p.id)} onChange={() => setFProjects((x) => (x.includes(p.id) ? x.filter((y) => y !== p.id) : [...x, p.id]))} /> {p.name}</label>
                ))}
              </div>
            )}
          </fieldset>
          <fieldset>
            <legend>Only these priorities</legend>
            {PRIORITIES.map((p) => <label key={p} className="hook-check"><input type="checkbox" checked={fPriorities.includes(p)} onChange={() => setFPriorities((x) => (x.includes(p) ? x.filter((y) => y !== p) : [...x, p]))} /> {p}</label>)}
            <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>Tasks, tickets and issues. Events without a priority still go.</p>
          </fieldset>
          <Field label="Status changes only to" hint="Comma-separated, e.g. Done, Blocked. “Done” also matches Completed and Resolved. Other events are not affected.">
            <input className="input" maxLength={300} value={fStatuses} onChange={(e) => setFStatuses(e.target.value)} placeholder="Done" aria-label="Status changes only to" />
          </Field>
        </div>
      </details>
    </Modal>
  );
}

function DeliveriesModal({ hook, onClose }: { hook: Webhook; onClose: () => void }) {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [event, setEvent] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const health = useWsQuery(['webhooks', hook.id, 'health'], () => webhookApi.health(hook.id, 7), { refetchInterval: 10_000 });
  const q = useWsQuery(['webhooks', hook.id, 'history', page, status, event], () => webhookApi.history(hook.id, { page, pageSize: 25, status: status || undefined, event: event.trim() || undefined }),
    { refetchInterval: 4000, placeholderData: (p) => p });
  const rows = q.data?.items ?? [];
  const pages = Math.max(1, Math.ceil((q.data?.total ?? 0) / 25));
  const refresh = () => void qc.invalidateQueries({ queryKey: [wid, 'webhooks', hook.id] });
  const replay = async (d: WebhookDelivery) => {
    try { await webhookApi.replay(hook.id, d.id); refresh(); toast('Queued to send again.'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not send it again.', 'error'); }
  };
  const h = health.data;
  const max = Math.max(1, ...(h?.series ?? []).map((x) => x.total));
  return (
    <Modal size="xl" title={`Deliveries · ${hook.name}`} subtitle="Every event sent in the last 30 days, its health, and sending again after a fix" onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}>
      {h && (
        <section className="hook-health-panel" aria-label="Health in the last 7 days">
          <div className="hook-kpis">
            <div><span>Delivered</span><b>{h.successRate == null ? '—' : `${h.successRate}%`}</b><small>{h.succeeded} of {h.total} in 7 days</small></div>
            <div><span>Failed</span><b>{h.failed}</b><small>{h.pending} waiting</small></div>
            <div><span>Response</span><b>{h.averageMs == null ? '—' : `${h.averageMs} ms`}</b><small>{h.p95Ms == null ? 'average' : `95% under ${h.p95Ms} ms`}</small></div>
            <div><span>Failed in a row</span><b>{h.consecutiveFailures}</b><small>warned at {h.warnAfter}, off at {h.disableAfter}</small></div>
          </div>
          <div className="hook-bars" role="img" aria-label="Deliveries per day, failed in red">
            {h.series.map((d) => (
              <div key={d.day} className="hook-bar" title={`${d.day}: ${d.total} sent, ${d.failed} failed${d.averageMs != null ? `, ${d.averageMs} ms` : ''}`}>
                <div className="hook-bar-stack">
                  {d.failed > 0 && <i className="f" style={{ height: `${(d.failed / max) * 100}%` }} />}
                  <i style={{ height: `${((d.total - d.failed) / max) * 100}%` }} />
                </div>
                <span>{d.day.slice(8)}</span>
              </div>
            ))}
          </div>
          {h.lastError && <p className="muted" style={{ fontSize: 12, margin: 0 }}>Last problem{h.lastFailureAt ? ` ${timeAgo(h.lastFailureAt)}` : ''}: {h.lastError}</p>}
        </section>
      )}
      <ReplayWindow hook={hook} onQueued={refresh} />
      <div className="hook-history-filters">
        <div className="hook-status-pick"><Select className="select" value={status} aria-label="Status" onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">Every status</option><option value="Succeeded">Delivered</option><option value="Failed">Failed</option><option value="Pending">Waiting</option>
        </Select></div>
        <input className="input" value={event} onChange={(e) => { setEvent(e.target.value); setPage(1); }} placeholder="Event, e.g. task.* or task.created" aria-label="Event" />
        <span className="muted">{q.data?.total ?? 0} in all</span>
      </div>
      {rows.length === 0 ? <EmptyState icon="bolt" title={status || event ? 'Nothing matches' : 'Nothing sent yet'} text="Events appear here a few seconds after they happen." /> : (
        <div className="cf-list" role="list" aria-label="Deliveries">
          {rows.map((d) => (
            <div className="cf-row" role="listitem" key={d.id}>
              <div className="cf-main">
                <code>{d.eventType}</code> <Badge tone={d.status === 'Succeeded' ? 'success' : d.status === 'Failed' ? 'danger' : 'info'}>{d.status === 'Pending' ? 'Waiting' : d.status === 'Succeeded' ? 'Delivered' : 'Failed'}</Badge>
                {d.replayOf && <> <Badge tone="purple">Sent again</Badge></>}
                <div className="muted" style={{ fontSize: 12 }}>
                  {timeAgo(d.createdAt)} · {d.attempts} attempt{d.attempts === 1 ? '' : 's'}{d.responseStatus ? ` · answered ${d.responseStatus}` : ''}{d.durationMs != null ? ` in ${d.durationMs} ms` : ''}{d.error ? ` · ${d.error}` : ''}
                  {d.nextAttemptAt && d.status === 'Pending' && d.attempts > 0 ? ` · next try ${timeAgo(d.nextAttemptAt).includes('ago') ? 'shortly' : 'later'}` : ''}
                </div>
                {open === d.id && <DeliveryDetail hookId={hook.id} id={d.id} />}
              </div>
              <div className="td-actions">
                <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open === d.id} onClick={() => setOpen(open === d.id ? null : d.id)}>{open === d.id ? 'Hide' : 'View'}</button>
                {d.status !== 'Pending' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void replay(d)}>Send again</button>}
              </div>
            </div>
          ))}
        </div>
      )}
      {pages > 1 && (
        <div className="hook-pager">
          <button type="button" className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</button>
          <span className="muted">Page {page} of {pages}</span>
          <button type="button" className="btn btn-ghost btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Older</button>
        </div>
      )}
    </Modal>
  );
}

function DeliveryDetail({ hookId, id }: { hookId: string; id: string }) {
  const q = useWsQuery(['webhooks', hookId, 'delivery', id], () => webhookApi.delivery(hookId, id));
  if (q.isLoading) return <p className="muted" role="status">Loading…</p>;
  if (!q.data) return null;
  let pretty = q.data.payload;
  try { pretty = JSON.stringify(JSON.parse(q.data.payload), null, 2); } catch { /* not JSON */ }
  return (
    <div className="hook-detail">
      <div><b>Sent</b><pre>{pretty}</pre></div>
      <div><b>Answer</b><pre>{q.data.responseSnippet || (q.data.delivery.responseStatus ? `HTTP ${q.data.delivery.responseStatus}` : 'No answer yet.')}</pre></div>
    </div>
  );
}

const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** Sends every failed (or every) delivery in a time window again, after the receiver was fixed. */
function ReplayWindow({ hook, onQueued }: { hook: Webhook; onQueued: () => void }) {
  const [from, setFrom] = useState(() => localInput(new Date(Date.now() - 24 * 3_600_000)));
  const [to, setTo] = useState(() => localInput(new Date()));
  const [onlyFailed, setOnlyFailed] = useState(true);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await webhookApi.replayMany(hook.id, { from: new Date(from).toISOString(), to: new Date(to).toISOString(), onlyFailed });
      toast(r.queued === 0 ? 'Nothing to send again in that window.' : `${r.queued} event${r.queued === 1 ? '' : 's'} queued to send again.`); onQueued();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not send them again.', 'error'); } finally { setBusy(false); }
  };
  return (
    <details className="hook-replay">
      <summary>Send events again after fixing the receiver</summary>
      <div className="hook-replay-row">
        <label>From <input className="input" type="datetime-local" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input className="input" type="datetime-local" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="hook-check"><input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} /> Only the failed ones</label>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !hook.isActive} onClick={() => void go()}>Send these again</button>
      </div>
      {!hook.isActive && <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>Turn the webhook on first.</p>}
    </details>
  );
}

/** Every event with a sample of what it sends, and a test of one event to a chosen webhook. */
function EventExplorer({ hooks }: { hooks: Webhook[] }) {
  const q = useWsQuery(['webhook-catalogue'], webhookApi.catalogue, { staleTime: 3_600_000 });
  const [picked, setPicked] = useState('task.status_changed');
  const [target, setTarget] = useState(hooks[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const all = q.data ?? [];
  const current = all.find((e) => e.event === picked) ?? all[0];
  const groups = [...new Set(all.map((e) => e.group))];
  const send = async () => {
    if (!current) return;
    setBusy(true);
    try { await webhookApi.test(target, current.event); toast(`A test of ${current.event} is on its way. See “Deliveries & health”.`); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not send the test.', 'error'); } finally { setBusy(false); }
  };
  if (all.length === 0) return null;
  return (
    <div className="card mb-22" data-testid="event-explorer">
      <div className="card-head"><div><h3>Event explorer</h3><p>What each event sends. Pick one to see a sample, then send a test of it to your receiver.</p></div></div>
      <div className="card-body explorer">
        <nav className="explorer-list" aria-label="Events">
          {groups.map((g) => (
            <div key={g}>
              <h4>{all.find((e) => e.group === g)?.groupLabel}</h4>
              {all.filter((e) => e.group === g).map((e) => (
                <button key={e.event} type="button" className={e.event === current?.event ? 'on' : ''} aria-pressed={e.event === current?.event} onClick={() => setPicked(e.event)}>{e.event.slice(g.length + 1).replace(/_/g, ' ')}</button>
              ))}
            </div>
          ))}
        </nav>
        {current && (
          <div className="explorer-sample">
            <div className="explorer-head"><code>{current.event}</code>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {hooks.length > 1 && (
                  <Select className="select" value={target} aria-label="Send the test to" onChange={(e) => setTarget(e.target.value)}>
                    {hooks.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                  </Select>
                )}
                <button type="button" className="btn btn-primary btn-sm" disabled={busy || !target} onClick={() => void send()}>Send a test of this event</button>
              </div>
            </div>
            <pre aria-label="Sample payload">{JSON.stringify({ id: '…', event: current.event, occurredAt: '2026-10-23T10:00:00Z', workspaceId: '…', test: true, data: current.sample }, null, 2)}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
