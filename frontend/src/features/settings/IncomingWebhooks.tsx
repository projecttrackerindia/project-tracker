import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { incomingApi, projectApi, workApi, workspaceApi } from '../../api/endpoints';
import type { IncomingMapping, IncomingPreview, IncomingTarget, IncomingWebhook, Priority } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Badge, EmptyState, ErrorState, Field, Modal, PriorityOptions, SubmitButton } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { useDebounced, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const TARGET_LABEL: Record<IncomingTarget, string> = { ticket: 'Operations ticket', task: 'Project task', reminder: 'Reminder' };
const MERGE: [number, string][] = [[0, 'Never merge'], [60, 'Within an hour'], [1440, 'Within a day'], [10080, 'Within a week']];
const copyText = (text: string, what: string) => void navigator.clipboard?.writeText(text).then(() => toast(`${what} copied.`), () => toast('Copy did not work here.', 'error'));

/**
 * Settings → Webhooks → Incoming: a private address per source (a monitoring tool, a website form, a core-banking job). Each request
 * becomes a ticket, a task or a reminder by a mapping set from an example; repeats are merged into the open item; "resolved" closes it.
 */
export function IncomingWebhooks() {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const q = useWsQuery(['incoming-webhooks'], incomingApi.list);
  const [editing, setEditing] = useState<IncomingWebhook | 'new' | null>(null);
  const [mapping, setMapping] = useState<IncomingWebhook | null>(null);
  const [log, setLog] = useState<IncomingWebhook | null>(null);
  const [shown, setShown] = useState<{ hook: IncomingWebhook; secret: string | null } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: [wid, 'incoming-webhooks'] });
  const hooks = q.data ?? [];

  const toggle = async (h: IncomingWebhook) => {
    try { await incomingApi.update(h.id, { isActive: !h.isActive }); refresh(); } catch (e) { toast(errText(e, 'Could not change it.'), 'error'); }
  };
  const rotate = async (h: IncomingWebhook) => {
    if (!(await confirmDialog({ title: 'Give it a new address?', message: 'The old address stops working at once. Update the system that posts to it.', confirmText: 'New address' }))) return;
    try { const r = await incomingApi.rotate(h.id); refresh(); setShown(r); } catch (e) { toast(errText(e, 'Could not change the address.'), 'error'); }
  };
  const remove = async (h: IncomingWebhook) => {
    if (!(await confirmDialog({ title: `Delete “${h.name}”?`, message: 'Requests to its address are refused from now on. Tickets and tasks it raised stay.', confirmText: 'Delete', danger: true }))) return;
    try { await incomingApi.remove(h.id); refresh(); toast('Incoming webhook deleted.', 'warning'); } catch (e) { toast(errText(e, 'Could not delete it.'), 'error'); }
  };

  return (
    <div className="card mb-22 incoming-card" data-testid="incoming-webhooks">
      <div className="card-head">
        <div><h3>Incoming webhooks</h3><p>Let monitoring alerts, website forms or failed jobs raise work here. Repeats of the same thing go into one ticket with a count, not a hundred tickets.</p></div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> New address</button>
      </div>
      <div className="card-body">
        {q.isLoading ? <p className="muted" role="status">Loading…</p> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : hooks.length === 0 ? (
          <EmptyState icon="inbox" title="No incoming addresses" text="Create one, point Grafana, a form or a scheduler at it, and set the mapping from the first request it receives." />
        ) : (
          <div className="cf-list">
            {hooks.map((h) => (
              <div className="cf-row" key={h.id}>
                <div className="cf-main">
                  <b>{h.name}</b> <Badge tone={h.isActive ? 'success' : 'danger'}>{h.isActive ? 'On' : 'Off'}</Badge> <Badge tone="purple">{TARGET_LABEL[h.target]}</Badge>
                  {h.requiresSecret && <> <Badge tone="info">Secret</Badge></>}
                  <div className="muted" style={{ fontSize: 12 }}>
                    {h.target === 'task' ? `Into ${h.projectName ?? 'a project'}` : h.target === 'ticket' ? `${h.workTypeName ?? 'First work type'}${h.projectName ? ` · about ${h.projectName}` : ''}` : `For ${h.assigneeName ?? h.actingName ?? 'the person who set it up'}`}
                    {' · '}{h.received} received · {h.createdCount} raised · {h.mergedCount} merged{h.lastReceivedAt ? ` · last ${timeAgo(h.lastReceivedAt)}` : ''}
                  </div>
                  <div className="incoming-url"><code>{h.url}</code><button type="button" className="btn btn-ghost btn-sm" onClick={() => copyText(h.url, 'Address')}><Icon name="copy" size={13} /> Copy</button></div>
                  {h.lastError && <div className="form-error" style={{ marginTop: 6 }}>{h.lastError}</div>}
                </div>
                <div className="td-actions" style={{ flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMapping(h)}>Mapping</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLog(h)}>Requests</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void toggle(h)}>{h.isActive ? 'Turn off' : 'Turn on'}</button>
                  <button type="button" className="btn-icon" title="Edit" aria-label={`Edit ${h.name}`} onClick={() => setEditing(h)}><Icon name="edit" /></button>
                  <button type="button" className="btn-icon" title="New address" aria-label={`New address for ${h.name}`} onClick={() => void rotate(h)}><Icon name="refresh" /></button>
                  <button type="button" className="btn-icon danger" title="Delete" aria-label={`Delete ${h.name}`} onClick={() => void remove(h)}><Icon name="trash" /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {editing && <IncomingModal hook={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)}
        onSaved={(r, created) => { setEditing(null); refresh(); if (created || r.secret) setShown(r); }} />}
      {shown && <AddressModal hook={shown.hook} secret={shown.secret} onClose={() => setShown(null)} onMap={() => { setMapping(shown.hook); setShown(null); }} />}
      {mapping && <MappingModal hook={mapping} onClose={() => setMapping(null)} onSaved={() => { setMapping(null); refresh(); }} />}
      {log && <RequestsModal hook={log} onClose={() => setLog(null)} />}
    </div>
  );
}

function IncomingModal({ hook, onClose, onSaved }: { hook?: IncomingWebhook; onClose: () => void; onSaved: (r: { hook: IncomingWebhook; secret: string | null }, created: boolean) => void }) {
  const [name, setName] = useState(hook?.name ?? '');
  const [target, setTarget] = useState<IncomingTarget>(hook?.target ?? 'ticket');
  const [projectId, setProjectId] = useState(hook?.projectId ?? '');
  const [workTypeId, setWorkTypeId] = useState(hook?.workTypeId ?? '');
  const [assigneeId, setAssigneeId] = useState(hook?.assigneeId ?? '');
  const [priority, setPriority] = useState<Priority>(hook?.defaultPriority ?? 'Medium');
  const [merge, setMerge] = useState(hook?.mergeMinutes ?? 1440);
  const [secret, setSecret] = useState(hook?.requiresSecret ?? true);
  const [raiseAsMe, setRaiseAsMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const projects = useWsQuery(['projects', 'incoming'], () => projectApi.list({ pageSize: 200 }), { staleTime: 300_000 });
  const types = useWsQuery(['work', 'types', 'all'], () => workApi.types(true), { enabled: target === 'ticket' });
  const members = useWsQuery(['members'], () => workspaceApi.members(), { staleTime: 300_000 });

  const submit = async () => {
    if (!name.trim()) return setError('Name it after what posts to it, e.g. Grafana alerts.');
    if (target === 'task' && !projectId) return setError('Choose the project the tasks go into.');
    setBusy(true); setError(null);
    const body = { name: name.trim(), target, projectId: projectId || null, workTypeId: workTypeId || null, assigneeId: assigneeId || null, defaultPriority: priority,
      mergeMinutes: merge, requireSecret: secret, raiseAsMe: raiseAsMe || undefined };
    try {
      if (hook) { const r = await incomingApi.update(hook.id, body); toast('Saved.'); onSaved(r, false); }
      else onSaved(await incomingApi.create(body), true);
    } catch (e) { setError(errText(e, 'Could not save it.')); } finally { setBusy(false); }
  };

  return (
    <Modal size="lg" title={hook ? `Edit ${hook.name}` : 'New incoming address'} onClose={onClose} onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={busy}>{hook ? 'Save' : 'Create the address'}</SubmitButton></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <Field label="Name" required><input className="input" maxLength={60} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Grafana alerts" /></Field>
      <div className="field">
        <label>Each request becomes</label>
        <div className="method-picker hook-formats" role="radiogroup" aria-label="Each request becomes">
          {(['ticket', 'task', 'reminder'] as const).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={target === t} className={`method-option ${target === t ? 'on' : ''}`} onClick={() => setTarget(t)}>
              <b>{TARGET_LABEL[t]}</b><span>{t === 'ticket' ? 'In Operations, with its SLA clock.' : t === 'task' ? 'On a project’s board.' : 'A reminder for one person.'}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="incoming-grid">
        {target !== 'reminder' && (
          <Field label={target === 'task' ? 'Project' : 'About the project (optional)'} required={target === 'task'}>
            <Select className="select" value={projectId} aria-label="Project" onChange={(e) => setProjectId(e.target.value)}>
              <option value="">{target === 'task' ? 'Choose a project' : 'No project'}</option>
              {(projects.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        )}
        {target === 'ticket' && (
          <Field label="Work type">
            <Select className="select" value={workTypeId} aria-label="Work type" onChange={(e) => setWorkTypeId(e.target.value)}>
              <option value="">First work type</option>
              {(types.data ?? []).filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label={target === 'reminder' ? 'Remind' : 'Assign to'} hint="A request can name a member by e-mail instead (set it in the mapping).">
          <Select className="select" value={assigneeId} aria-label="Assign to" onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">{target === 'reminder' ? 'The person who set it up' : 'Nobody (or the routing rules)'}</option>
            {(members.data ?? []).filter((m) => m.role !== 'Guest').map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
          </Select>
        </Field>
        <Field label="Priority when the request says none">
          <Select className="select" value={priority} aria-label="Default priority" onChange={(e) => setPriority(e.target.value as Priority)}><PriorityOptions /></Select>
        </Field>
        <Field label="Merge repeats" hint="A repeat of something still open adds to its count instead of raising a new one.">
          <Select className="select" value={String(merge)} aria-label="Merge repeats" onChange={(e) => setMerge(Number(e.target.value))}>
            {MERGE.map(([m, l]) => <option key={m} value={m}>{l}</option>)}
          </Select>
        </Field>
      </div>
      <label className="hook-check" style={{ marginTop: 8 }}><input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} />
        Require a secret (an <code>X-Webhook-Secret</code> header or an HMAC-SHA256 <code>X-Signature</code>)</label>
      {hook && <label className="hook-check" style={{ marginTop: 8 }}><input type="checkbox" checked={raiseAsMe} onChange={(e) => setRaiseAsMe(e.target.checked)} />
        Raise the work as me (now: {hook.actingName ?? 'someone who left'})</label>}
    </Modal>
  );
}

function AddressModal({ hook, secret, onClose, onMap }: { hook: IncomingWebhook; secret: string | null; onClose: () => void; onMap: () => void }) {
  const curl = `curl -X POST '${hook.url}' -H 'Content-Type: application/json'${secret ? ` -H 'X-Webhook-Secret: ${secret}'` : ''} -d '{"title":"Disk almost full","severity":"high","host":"db-01"}'`;
  return (
    <Modal title={`Your address for ${hook.name}`} subtitle={secret ? 'The secret is shown only now.' : undefined} onClose={onClose}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Done</button><button type="button" className="btn btn-primary" onClick={onMap}>Set the mapping</button></>}>
      <p className="muted" style={{ marginTop: 0 }}>Point the other system at this address (POST, JSON, a form or plain text). Send one request, then set the mapping from it.</p>
      <div className="secret-box"><code>{hook.url}</code></div>
      <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => copyText(hook.url, 'Address')}>Copy address</button>
      {secret && (
        <>
          <div className="secret-box"><code>{secret}</code></div>
          <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => copyText(secret, 'Secret')}>Copy secret</button>
        </>
      )}
      <details className="integration-inline-guide" style={{ marginTop: 12 }}><summary>Try it from a terminal</summary><pre className="incoming-curl">{curl}</pre></details>
    </Modal>
  );
}

const TEMPLATE_FIELDS: { key: keyof IncomingMapping; label: string; hint: string }[] = [
  { key: 'title', label: 'Title', hint: 'Mix words and values: {{alertname}} on {{host}}' },
  { key: 'description', label: 'Details', hint: '{{$body}} puts the whole request in.' },
  { key: 'priority', label: 'Priority from', hint: 'P1, critical, error, warning and info are understood; map others below.' },
  { key: 'dedupeKey', label: 'What makes a repeat', hint: 'Requests with the same value are merged. Empty: the title.' },
  { key: 'assignee', label: 'Assignee e-mail (optional)', hint: 'A member with this e-mail gets the work.' },
  { key: 'resolveWhen', label: 'Resolved when (optional)', hint: 'For alerts that also send “resolved”.' },
];

/** The mapping, set by example: the last request (or one pasted), every value in it to click into a template, and a live preview. */
function MappingModal({ hook, onClose, onSaved }: { hook: IncomingWebhook; onClose: () => void; onSaved: () => void }) {
  const [m, setM] = useState<IncomingMapping>(hook.mapping ?? {});
  const [sample, setSample] = useState('');
  const [preview, setPreview] = useState<IncomingPreview | null>(null);
  const [focus, setFocus] = useState<keyof IncomingMapping>('title');
  const [mapRows, setMapRows] = useState<[string, Priority][]>(Object.entries(hook.mapping?.priorityMap ?? {}).map(([k, v]) => [k, v as Priority]));
  const [busy, setBusy] = useState(false);
  const inputs = useRef<Partial<Record<keyof IncomingMapping, HTMLInputElement | null>>>({});
  const last = useWsQuery(['incoming-webhooks', hook.id, 'sample'], () => incomingApi.sample(hook.id), { enabled: hook.hasSample });
  useEffect(() => { if (last.data?.sample && !sample) setSample(last.data.sample); }, [last.data, sample]);
  const mapping: IncomingMapping = { ...m, priorityMap: mapRows.length ? Object.fromEntries(mapRows.filter(([k]) => k.trim())) : null };
  const debouncedSample = useDebounced(sample, 400);
  const debouncedMapping = useDebounced(JSON.stringify(mapping), 400);
  useEffect(() => {
    if (!debouncedSample.trim()) { setPreview(null); return; }
    let live = true;
    incomingApi.preview({ mapping: JSON.parse(debouncedMapping) as IncomingMapping, sample: debouncedSample, defaultPriority: hook.defaultPriority })
      .then((p) => { if (live) setPreview(p); }, () => { if (live) setPreview(null); });
    return () => { live = false; };
  }, [debouncedSample, debouncedMapping, hook.defaultPriority]);

  const insert = (placeholder: string) => {
    const el = inputs.current[focus];
    const value = (m[focus] as string | null | undefined) ?? '';
    const at = el?.selectionStart ?? value.length;
    const next = value.slice(0, at) + placeholder + value.slice(el?.selectionEnd ?? at);
    setM({ ...m, [focus]: next });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + placeholder.length, at + placeholder.length); });
  };
  const guess = async () => {
    try { const g = await incomingApi.suggest(sample); setM(g); setMapRows([]); toast('A first mapping from the example. Check the preview.'); }
    catch (e) { toast(errText(e, 'Could not read the example.'), 'error'); }
  };
  const save = async () => {
    setBusy(true);
    try { await incomingApi.update(hook.id, { mapping }); toast('Mapping saved.'); onSaved(); } catch (e) { toast(errText(e, 'Could not save the mapping.'), 'error'); } finally { setBusy(false); }
  };

  return (
    <Modal size="xl" title={`Mapping · ${hook.name}`} subtitle="Click a value from the example to put it where the cursor is." onClose={onClose}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>Save mapping</button></>}>
      <div className="mapping">
        <section className="mapping-example" aria-label="The example">
          <div className="mapping-head"><b>Example request</b>
            <div className="row" style={{ gap: 6 }}>
              {hook.hasSample && <button type="button" className="btn btn-ghost btn-sm" onClick={() => last.data?.sample && setSample(last.data.sample)}>Use the last one received</button>}
              <button type="button" className="btn btn-ghost btn-sm" disabled={!sample.trim()} onClick={() => void guess()}><Icon name="sparkle" size={13} /> Guess the mapping</button>
            </div>
          </div>
          <textarea className="input mapping-sample" value={sample} onChange={(e) => setSample(e.target.value)} aria-label="Example request"
            placeholder={hook.hasSample ? '' : 'Nothing received yet. Paste an example request here (JSON, a form or text).'} />
          <div className="mapping-preview" aria-live="polite" data-testid="mapping-preview">
            <b>Becomes</b>
            {!preview ? <p className="muted">Add an example to see what it becomes.</p> : (
              <>
                <p><Badge tone="purple">{TARGET_LABEL[hook.target]}</Badge> <b>{preview.title}</b> <Badge tone={preview.priority === 'Critical' || preview.priority === 'High' ? 'danger' : 'neutral'}>{preview.priority}</Badge></p>
                {preview.description && <p className="muted mapping-desc">{preview.description}</p>}
                <p className="muted">Repeats share: <code>{preview.dedupeKey}</code>{preview.assignee ? ` · for ${preview.assignee}` : ''}</p>
                {preview.resolves && <p><Badge tone="success">Closes the open item</Badge></p>}
                {preview.problems.map((p) => <p key={p} className="form-error" style={{ margin: '4px 0' }}>{p}</p>)}
              </>
            )}
          </div>
          {preview && preview.fields.length > 0 && (
            <div className="mapping-fields" role="list" aria-label="Values in the example">
              {preview.fields.map((f) => (
                <button key={f.path} type="button" role="listitem" className="mapping-field" onClick={() => insert(f.placeholder)} title={`Insert ${f.placeholder}`}>
                  <code>{f.path}</code><span>{f.value || '—'}</span>
                </button>
              ))}
            </div>
          )}
        </section>
        <section className="mapping-form" aria-label="Templates">
          {TEMPLATE_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <input className="input" ref={(el) => { inputs.current[f.key] = el; }} value={(m[f.key] as string | null | undefined) ?? ''} maxLength={400}
                onFocus={() => setFocus(f.key)} onChange={(e) => setM({ ...m, [f.key]: e.target.value })} aria-label={f.label} />
            </Field>
          ))}
          {m.resolveWhen && (
            <Field label="Resolved values" hint="Comma-separated; any of them closes the open item."><input className="input" value={m.resolveValues ?? ''} maxLength={200} onChange={(e) => setM({ ...m, resolveValues: e.target.value })} aria-label="Resolved values" placeholder="resolved, ok" /></Field>
          )}
          <div className="field">
            <label>Priority map</label>
            {mapRows.map(([k, v], i) => (
              <div className="mapping-map-row" key={i}>
                <input className="input" value={k} placeholder="What the source says, e.g. sev-a" aria-label="Source priority" onChange={(e) => setMapRows(mapRows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
                <Select className="select" value={v} aria-label="Becomes" onChange={(e) => setMapRows(mapRows.map((r, j) => (j === i ? [r[0], e.target.value as Priority] : r)))}><PriorityOptions /></Select>
                <button type="button" className="btn-icon" aria-label="Remove" onClick={() => setMapRows(mapRows.filter((_, j) => j !== i))}><Icon name="trash" /></button>
              </div>
            ))}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMapRows([...mapRows, ['', 'High']])}><Icon name="plus" size={13} /> Add a priority word</button>
          </div>
        </section>
      </div>
    </Modal>
  );
}

const STATUS_TONE: Record<string, 'success' | 'info' | 'neutral' | 'danger' | 'warning' | 'purple'> = { created: 'success', merged: 'info', resolved: 'purple', ignored: 'neutral', rejected: 'danger', failed: 'danger' };

function RequestsModal({ hook, onClose }: { hook: IncomingWebhook; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const q = useWsQuery(['incoming-webhooks', hook.id, 'events', page, status], () => incomingApi.events(hook.id, page, status || undefined), { refetchInterval: 5000, placeholderData: (p) => p });
  const rows = q.data?.items ?? [];
  const pages = Math.max(1, Math.ceil((q.data?.total ?? 0) / 50));
  return (
    <Modal size="lg" title={`Requests · ${hook.name}`} subtitle="What each request became" onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}>
      <div className="hook-history-filters">
        <div className="hook-status-pick"><Select className="select" value={status} aria-label="Status" onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">Everything</option><option value="created">Raised</option><option value="merged">Merged</option><option value="resolved">Resolved</option>
          <option value="ignored">Ignored</option><option value="rejected">Refused</option><option value="failed">Failed</option>
        </Select></div>
        <span className="muted">{q.data?.total ?? 0} in all</span>
      </div>
      {rows.length === 0 ? <EmptyState icon="inbox" title="No requests yet" text="Requests appear here as soon as they arrive." /> : (
        <div className="cf-list" role="list" aria-label="Requests">
          {rows.map((e) => (
            <div className="cf-row" role="listitem" key={e.id}>
              <div className="cf-main">
                <Badge tone={STATUS_TONE[e.status] ?? 'neutral'}>{e.status}</Badge> <b>{e.title ?? '—'}</b>
                <div className="muted" style={{ fontSize: 12 }}>
                  {timeAgo(e.receivedAt)}{e.targetKey && e.targetKey !== 'reminder' ? ` · ${e.targetKey}` : ''}{e.count && e.count > 1 ? ` · seen ${e.count} times` : ''}{e.error ? ` · ${e.error}` : ''}
                </div>
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
