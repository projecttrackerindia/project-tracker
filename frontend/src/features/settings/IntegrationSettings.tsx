import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { exportApi, integrationsApi, workApi } from '../../api/endpoints';
import type { DevLink, GitConnection, GitProvider, Priority } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Badge, EmptyState, ErrorState, Field, Modal, PageLoader, PriorityOptions } from '../../components/ui';
import { formatDate, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { ExportList } from '../reports/Exports';
import { CopyRow, copy } from './SsoSettings';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);

// ------------------------------------------------------------------ email to work task

/** Settings → Email to work: a mailbox address whose mail from members becomes operational work. */
export function InboundEmailSettings() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['integrations', 'mailbox'], integrationsApi.mailbox);
  const types = useWsQuery(['work', 'types', 'all'], () => workApi.types(true));
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const m = q.data;
  const save = async (b: { enabled: boolean; workTypeId: string | null; priority: Priority }) => {
    setBusy(true);
    try { await integrationsApi.saveMailbox(b); toast(m.configured ? 'Mailbox saved.' : 'Mailbox created.'); void invalidateWorkspace(wid, 'integrations'); }
    catch (e) { toast(errText(e, 'Could not save the mailbox.'), 'error'); } finally { setBusy(false); }
  };
  const reset = async () => {
    if (!(await confirmDialog({ title: 'Give the mailbox a new address?', message: 'Mail sent to the old address will be refused. Update your email provider’s forwarding rule.', confirmText: 'New address' }))) return;
    try { await integrationsApi.resetMailbox(); toast('New address ready.'); void invalidateWorkspace(wid, 'integrations'); } catch (e) { toast(errText(e, 'Could not reset it.'), 'error'); }
  };

  return (
    <>
      <div className="card mb-22">
        <div className="card-head">
          <div><h3>Work mailbox {m.configured && <Badge tone={m.enabled ? 'success' : 'neutral'}>{m.enabled ? 'Receiving' : 'Off'}</Badge>}</h3>
            <p>Email sent here becomes operational work, raised by the sender. Only members of this workspace who may create work are accepted.</p></div>
          {m.canManage && m.configured && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void reset()}><Icon name="refresh" size={14} /> New address</button>}
        </div>
        <div className="card-body">
          {!m.configured ? (
            m.canManage ? (
              <EmptyState icon="mail" title="No work mailbox yet" text="Create one, then point your email provider (Mailgun, SendGrid, Postmark…) at it."
                action={<button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save({ enabled: true, workTypeId: null, priority: 'Medium' })}><Icon name="plus" size={14} /> Create the mailbox</button>} />
            ) : <p className="muted">An owner or admin can set up a mailbox for this workspace.</p>
          ) : (
            <>
              {m.address ? <CopyRow label="Address" value={m.address} hint="send or forward mail here" />
                : <p className="sso-note">No receiving domain is configured on this installation (<code>InboundEmail:Domain</code>). Use the provider address below in a forwarding rule.</p>}
              {m.webhookUrl && <CopyRow label="Provider webhook" value={m.webhookUrl} hint="Mailgun route / SendGrid Inbound Parse / Postmark" />}
              <div className="mailbox-stats">
                <span><b>{m.received}</b> received</span>
                <span>{m.lastReceivedAt ? `last ${timeAgo(m.lastReceivedAt)}` : 'nothing yet'}</span>
                {m.lastError && <span className="warn"><Icon name="alert" size={13} /> {m.lastError}</span>}
              </div>
              {m.canManage && (
                <div className="sso-switches">
                  <div className="setting-row">
                    <div className="setting-info"><h4>Receive mail</h4><p>When off, mail to the address is refused.</p></div>
                    <button type="button" className={`switch ${m.enabled ? 'on' : ''}`} role="switch" aria-checked={m.enabled} aria-label="Receive mail" disabled={busy}
                      onClick={() => void save({ enabled: !m.enabled, workTypeId: m.workTypeId, priority: m.priority })} />
                  </div>
                  <div className="setting-row">
                    <div className="setting-info"><h4>New work is raised as</h4><p>The subject becomes the title; the message the description.</p></div>
                    <div className="row" style={{ gap: 8 }}>
                      <Select className="select" style={{ minWidth: 190 }} value={m.workTypeId ?? ''} aria-label="Work type" disabled={busy}
                        onChange={(e) => void save({ enabled: m.enabled, workTypeId: e.target.value || null, priority: m.priority })}>
                        <option value="">First work type</option>
                        {(types.data ?? []).filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </Select>
                      <Select className="select" style={{ minWidth: 130 }} value={m.priority} aria-label="Priority" disabled={busy}
                        onChange={(e) => void save({ enabled: m.enabled, workTypeId: m.workTypeId, priority: e.target.value as Priority })}><PriorityOptions /></Select>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {m.configured && m.canManage && (
        <div className="card">
          <div className="card-head"><div><h3>Connecting your email provider</h3><p>Any of these works; the address token keeps each workspace’s mail apart.</p></div></div>
          <div className="card-body how-to">
            <p><b>Mailgun</b> · Receiving → Create route → expression <code>match_recipient("work\+.*@your-domain")</code> → action <i>Forward</i> to the provider webhook above.</p>
            <p><b>SendGrid</b> · Settings → Inbound Parse → add your receiving domain and paste the provider webhook as the destination URL.</p>
            <p><b>Postmark</b> · Inbound stream → Settings → Webhook URL = the provider webhook.</p>
            <p className="muted">If the installation sets <code>InboundEmail:Key</code>, add <code>?key=…</code> to the URL.</p>
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ GitHub and Azure DevOps

const PROVIDER_LABEL: Record<GitProvider, string> = { GitHub: 'GitHub', AzureDevOps: 'Azure DevOps' };

/** Settings → GitHub & Azure DevOps: repository connections whose commits and pull requests link to tasks. */
export function GitSettings() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['integrations', 'git'], integrationsApi.git);
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<{ connection: GitConnection; secret: string } | null>(null);
  const refresh = () => void invalidateWorkspace(wid, 'integrations', 'git');
  const remove = async (c: GitConnection) => {
    if (!(await confirmDialog({ title: `Disconnect ${c.name}?`, message: 'Links already made stay on their tasks; new commits are no longer linked.', confirmText: 'Disconnect', danger: true }))) return;
    try { await integrationsApi.removeGit(c.id); toast('Disconnected.'); refresh(); } catch (e) { toast(errText(e, 'Could not disconnect.'), 'error'); }
  };
  const toggleClose = async (c: GitConnection) => {
    try { await integrationsApi.updateGit(c.id, { provider: c.provider, name: c.name, closeOnKeyword: !c.closeOnKeyword }); refresh(); } catch (e) { toast(errText(e, 'Could not change it.'), 'error'); }
  };

  return (
    <>
      <div className="card mb-22">
        <div className="card-head">
          <div><h3>Repositories</h3><p>Commits and pull requests that mention a task key (WEB-12, WT-5, AI-7) are linked to that task. “Fixes WEB-12” on the default branch, or a merged pull request, completes it.</p></div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Connect</button>
        </div>
        <div className="card-body">
          {q.isLoading ? <PageLoader /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : (q.data ?? []).length === 0 ? (
            <EmptyState icon="git" title="No repositories connected" text="Connect GitHub or Azure DevOps to see commits and pull requests on the tasks they touch." />
          ) : (
            <div className="cf-list">
              {q.data!.map((c) => (
                <div className="cf-row" key={c.id}>
                  <div className="cf-main">
                    <b>{c.name}</b> <Badge tone="purple">{PROVIDER_LABEL[c.provider]}</Badge>
                    <div className="muted" style={{ fontSize: 12 }}>{c.received} event{c.received === 1 ? '' : 's'} received{c.lastReceivedAt ? ` · last ${timeAgo(c.lastReceivedAt)}` : ''} · connected {formatDate(c.createdAt)}</div>
                    {c.lastError && <div className="form-error" style={{ marginTop: 6 }}>{c.lastError}</div>}
                    <CopyRow label="Payload URL" value={c.webhookUrl} />
                  </div>
                  <div className="td-actions" style={{ flexWrap: 'wrap' }}>
                    <label className="check" style={{ display: 'flex', gap: 6, fontSize: 12.5 }} title="Complete tasks on “fixes KEY” / merged pull requests">
                      <input type="checkbox" checked={c.closeOnKeyword} onChange={() => void toggleClose(c)} /> Close on “fixes”
                    </label>
                    <button type="button" className="btn-icon danger" title="Disconnect" aria-label={`Disconnect ${c.name}`} onClick={() => void remove(c)}><Icon name="trash" /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {adding && <GitModal onClose={() => setAdding(false)} onCreated={(r) => { setAdding(false); setCreated(r); refresh(); }} />}
      {created && <GitSecretModal created={created} onClose={() => setCreated(null)} />}
    </>
  );
}

function GitModal({ onClose, onCreated }: { onClose: () => void; onCreated: (r: { connection: GitConnection; secret: string }) => void }) {
  const [provider, setProvider] = useState<GitProvider>('GitHub');
  const [name, setName] = useState('');
  const [closeOnKeyword, setClose] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!name.trim()) return setError('Name the connection, for example after the repository.');
    setBusy(true); setError(null);
    try { onCreated(await integrationsApi.createGit({ provider, name: name.trim(), closeOnKeyword })); }
    catch (e) { setError(errText(e, 'Could not connect.')); } finally { setBusy(false); }
  };
  return (
    <Modal title="Connect a repository" onClose={onClose} onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy}>Connect</button></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="field">
        <label>Provider</label>
        <div className="seg" role="group" aria-label="Provider">
          {(['GitHub', 'AzureDevOps'] as const).map((p) => <button key={p} type="button" className={provider === p ? 'active' : ''} aria-pressed={provider === p} onClick={() => setProvider(p)}>{PROVIDER_LABEL[p]}</button>)}
        </div>
      </div>
      <Field label="Name" required hint="Shown here only, e.g. acme/web or the Azure DevOps project."><input className="input" maxLength={60} autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <label className="check" style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={closeOnKeyword} onChange={(e) => setClose(e.target.checked)} /> Complete tasks on “fixes KEY” in the default branch or a merged pull request</label>
    </Modal>
  );
}

function GitSecretModal({ created, onClose }: { created: { connection: GitConnection; secret: string }; onClose: () => void }) {
  const c = created.connection;
  return (
    <Modal title={`Finish connecting ${c.name}`} subtitle="The secret is shown only now." onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
      {c.provider === 'GitHub' ? (
        <p className="sso-note">In GitHub: repository (or organization) <b>Settings → Webhooks → Add webhook</b>. Payload URL and secret below, content type <code>application/json</code>, events <i>Pushes</i> and <i>Pull requests</i>.</p>
      ) : (
        <p className="sso-note">In Azure DevOps: <b>Project settings → Service hooks → Web Hooks</b>, once for <i>Code pushed</i> and once for <i>Pull request merge attempted</i> / <i>updated</i>. URL below; Basic authentication with any user name and the secret as password.</p>
      )}
      <CopyRow label="Payload URL" value={c.webhookUrl} />
      <CopyRow label={c.provider === 'GitHub' ? 'Secret' : 'Password'} value={created.secret} />
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(created.secret, 'Secret')} style={{ marginTop: 8 }}>Copy secret</button>
    </Modal>
  );
}

/** Commits and pull requests linked to a task or work task (nothing is shown when there are none). */
export function DevLinks({ taskId, workTaskId }: { taskId?: string; workTaskId?: string }) {
  const q = useWsQuery(['dev-links', taskId ?? workTaskId], () => (taskId ? integrationsApi.taskLinks(taskId) : integrationsApi.workTaskLinks(workTaskId!)));
  const links: DevLink[] = q.data ?? [];
  if (links.length === 0) return null;
  return (
    <div className="dev-links">
      <h4><Icon name="git" size={14} /> Development</h4>
      {links.map((l) => (
        <a key={l.id} className="dev-link" href={l.url} target="_blank" rel="noreferrer noopener">
          <span className={`dev-kind ${l.kind === 'commit' ? 'commit' : l.state ?? 'open'}`}>{l.kind === 'commit' ? l.externalId.slice(0, 7) : `#${l.externalId}`}</span>
          <span className="dev-title">{l.title}</span>
          <span className="dev-meta">{l.kind === 'pull_request' && l.state ? `${l.state} · ` : ''}{l.repository ? `${l.repository} · ` : ''}{l.author ? `${l.author} · ` : ''}{timeAgo(l.occurredAt)}</span>
        </a>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ data and retention

/** Settings → Data & retention: how long history is kept, and (for the owner) a full export. */
export function DataSettings() {
  const wid = useWorkspaceId();
  const isOwner = useAuth((s) => s.ctx?.current?.role === 'Owner');
  const q = useWsQuery(['integrations', 'data-policy'], integrationsApi.dataPolicy);
  const [v, setV] = useState({ activity: '', notifications: '', chat: '', audit: '' });
  const [busy, setBusy] = useState(false);
  const [exportKey, setExportKey] = useState(0);
  useEffect(() => {
    if (q.data) setV({ activity: q.data.activityRetentionDays?.toString() ?? '', notifications: q.data.notificationRetentionDays?.toString() ?? '', chat: q.data.chatRetentionDays?.toString() ?? '', audit: q.data.auditRetentionDays?.toString() ?? '' });
  }, [q.data]);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const n = (s: string) => (s.trim() === '' ? null : Number(s));
  const save = async () => {
    setBusy(true);
    try {
      await integrationsApi.saveDataPolicy({ activityRetentionDays: n(v.activity), notificationRetentionDays: n(v.notifications), chatRetentionDays: n(v.chat), auditRetentionDays: n(v.audit) });
      toast('Retention saved. Older records are removed by the next maintenance run.'); void invalidateWorkspace(wid, 'integrations', 'data-policy');
    } catch (e) { toast(errText(e, 'Could not save.'), 'error'); } finally { setBusy(false); }
  };
  const exportAll = async () => {
    try { await exportApi.request({ kind: 'WorkspaceExport', format: 'Zip' }); toast('Export started. You will be notified when the zip is ready.'); setExportKey((k) => k + 1); }
    catch (e) { toast(errText(e, 'Could not start the export.'), 'error'); }
  };
  const rows: { key: keyof typeof v; label: string; hint: string; min: number }[] = [
    { key: 'activity', label: 'Activity history', hint: `What happened on projects and tasks.${q.data.planActivityDays > 0 ? ` Your plan shows up to ${q.data.planActivityDays} days.` : ''}`, min: 30 },
    { key: 'notifications', label: 'Notifications', hint: 'The bell and its history.', min: 7 },
    { key: 'chat', label: 'Chat messages', hint: 'Project, group and direct chats.', min: 30 },
    { key: 'audit', label: 'Audit log', hint: 'Sign-ins, permission and security changes. At least a year.', min: 365 },
  ];
  return (
    <>
      <div className="card mb-22">
        <div className="card-head"><div><h3>Retention</h3><p>Records older than this are deleted for good. Leave a box empty to keep everything.{q.data.lastPurgedAt ? ` Last applied ${timeAgo(q.data.lastPurgedAt)}.` : ''}</p></div></div>
        <div className="card-body">
          <div className="retention-grid">
            {rows.map((r) => (
              <div className="retention-row" key={r.key}>
                <div><b>{r.label}</b><span>{r.hint}</span></div>
                <div className="row" style={{ gap: 6 }}>
                  <input className="input" type="number" min={r.min} max={3650} placeholder="Keep all" aria-label={`${r.label} days`} value={v[r.key]} onChange={(e) => setV({ ...v, [r.key]: e.target.value })} />
                  <span className="muted" style={{ fontSize: 12.5 }}>days</span>
                </div>
              </div>
            ))}
          </div>
          <button type="button" className="btn btn-primary" style={{ marginTop: 14 }} disabled={busy} onClick={() => void save()}>Save retention</button>
        </div>
      </div>
      <div className="card mb-22">
        <div className="card-head">
          <div><h3>Export all data</h3><p>Everything the workspace holds - members, projects, tasks, comments, operational work, time, files and history - as JSON files in one zip. Secrets and private chats are never included.</p></div>
          {isOwner && <button type="button" className="btn btn-primary btn-sm" onClick={() => void exportAll()}><Icon name="download" size={14} /> Export workspace</button>}
        </div>
        {!isOwner && <div className="card-body"><p className="muted">Only the workspace owner can export all of its data.</p></div>}
      </div>
      {isOwner && <ExportList refreshKey={exportKey} />}
    </>
  );
}

// ------------------------------------------------------------------ calendar subscription

/** Calendar → Subscribe: a private iCalendar address for Outlook, Google Calendar or Apple Calendar. */
export function CalendarSubscribe() {
  const wid = useWorkspaceId();
  const [open, setOpen] = useState(false);
  const q = useWsQuery(['calendar-feed'], integrationsApi.calendarFeed, { enabled: open });
  const [busy, setBusy] = useState(false);
  const refresh = () => void invalidateWorkspace(wid, 'calendar-feed');
  const create = async () => { setBusy(true); try { await integrationsApi.resetCalendarFeed(); refresh(); } catch (e) { toast(errText(e, 'Could not create the address.'), 'error'); } finally { setBusy(false); } };
  const reset = async () => {
    if (!(await confirmDialog({ title: 'Make a new address?', message: 'Calendars subscribed to the old address stop updating. Subscribe again with the new one.', confirmText: 'New address' }))) return;
    await create();
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: 'Stop the subscription?', message: 'The address stops working.', confirmText: 'Stop', danger: true }))) return;
    try { await integrationsApi.removeCalendarFeed(); refresh(); toast('Subscription stopped.'); } catch (e) { toast(errText(e, 'Could not stop it.'), 'error'); }
  };
  const f = q.data;
  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)} title="See your due dates in Outlook, Google Calendar or Apple Calendar"><Icon name="calendar" /> Subscribe</button>
      {open && (
        <Modal title="Subscribe in your calendar" subtitle="Your work with a due date, kept up to date in Outlook, Google Calendar or Apple Calendar." onClose={() => setOpen(false)}
          footer={<button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>Done</button>}>
          {q.isLoading ? <PageLoader /> : !f?.enabled ? (
            <EmptyState icon="calendar" title="No subscription yet" text="Create a private address, then add it to your calendar app."
              action={<button type="button" className="btn btn-primary" disabled={busy} onClick={() => void create()}>Create my calendar address</button>} />
          ) : (
            <>
              <CopyRow label="Calendar address" value={f.url!} hint="keep it private" />
              <div className="how-to" style={{ marginTop: 10 }}>
                <p><b>Outlook</b> · Calendar → Add calendar → Subscribe from web → paste the address.</p>
                <p><b>Google Calendar</b> · Other calendars → + → From URL → paste the address.</p>
                <p><b>Apple Calendar</b> · File → New Calendar Subscription → paste the address.</p>
                <p className="muted">Calendar apps refresh it every few hours.{f.lastUsedAt ? ` Last fetched ${timeAgo(f.lastUsedAt)}.` : ' Not fetched yet.'}</p>
              </div>
              <div className="row" style={{ gap: 8, marginTop: 12 }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void reset()}><Icon name="refresh" size={14} /> New address</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void remove()}><Icon name="trash" size={14} /> Stop</button>
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
