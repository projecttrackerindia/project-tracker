import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { platformApi } from '../../api/endpoints';
import type { AdminUsage, BillingSettings, ConsentDocument, GoLive, PasswordPolicy, PlatformSettings } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Badge, EmptyState, ErrorState, Field, Modal, PageLoader, StatCard } from '../../components/ui';
import { currencySymbol, formatDate, formatMoney, timeAgo } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { confirmDialog, toast } from '../../stores/ui';
import { Select } from '../../components/Select';

const err = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);

// ------------------------------------------------------------------ billing
export function BillingTab() {
  const q = useWsQuery(['admin', 'billing'], platformApi.billing);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const b = q.data;
  return (
    <>
      <div className="stat-grid">
        <StatCard icon="card" tone="green" value={formatMoney(b.mrr, b.currency)} label="Monthly recurring revenue" foot={`${formatMoney(b.arr, b.currency)} per year`} />
        <StatCard icon="building" tone="purple" value={b.payingOrganizations} label="Paying organizations" foot={`${b.cancellingAtPeriodEnd} cancelling`} />
        <StatCard icon="clock" tone="blue" value={b.trials} label="On trial" />
        <StatCard icon="alert" tone="amber" value={b.pastDue} label="Past due" foot={`${b.failedPaymentsLast30Days} failed payments (30 d)`} />
        <StatCard icon="chart" tone="green" value={formatMoney(b.revenueLast30Days, b.currency)} label="Collected, last 30 days" />
      </div>
      <div className="grid-2 mb-18">
        <div className="card">
          <div className="card-head"><h3>Revenue by plan</h3></div>
          <div className="card-body">
            {b.byPlan.length === 0 ? <p className="muted">No paying organizations yet.</p> : (
              <div className="table-wrap"><table>
                <thead><tr><th>Plan</th><th>Organizations</th><th>MRR</th></tr></thead>
                <tbody>{b.byPlan.map((p) => <tr key={p.planCode}><td><b>{p.planName}</b></td><td>{p.organizations}</td><td>{formatMoney(p.mrr, b.currency)}</td></tr>)}</tbody>
              </table></div>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Trials ending in the next 7 days</h3></div>
          <div className="card-body">
            {b.trialsEndingSoon.length === 0 ? <p className="muted">None.</p> : b.trialsEndingSoon.map((t) => (
              <div className="row" key={t.tenantId} style={{ justifyContent: 'space-between', padding: '6px 0' }}><span><b>{t.organization}</b> <Badge tone="purple">{t.planCode}</Badge></span><span className="muted">{formatDate(t.trialEnd)}</span></div>
            ))}
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h3>Recent invoices</h3></div>
        <div className="card-body">
          {b.recentInvoices.length === 0 ? <EmptyState icon="card" title="No invoices yet" /> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Invoice</th><th>Organization</th><th>Plan</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead>
              <tbody>{b.recentInvoices.map((i) => (
                <tr key={i.number}><td>{i.number}</td><td>{i.organization}</td><td><Badge tone="purple">{i.planCode}</Badge></td><td>{formatMoney(i.amount, i.currency)}</td>
                  <td><Badge tone={i.status === 'Paid' ? 'success' : i.status === 'Failed' ? 'danger' : 'neutral'}>{i.status}</Badge></td><td>{formatDate(i.issuedAt)}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ usage
export function UsageTab() {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('tasks');
  const [warnOnly, setWarnOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [exceptions, setExceptions] = useState<AdminUsage | null>(null);
  const q = useWsQuery(['admin', 'usage', search, sort, warnOnly, page], () => platformApi.usage({ q: search || undefined, sort, warningsOnly: warnOnly, page }), { placeholderData: (p) => p });
  const d = q.data;
  const pages = d ? Math.max(1, d.totalPages) : 1;

  return (
    <>
      <div className="card mb-22">
        <div className="toolbar">
          <input className="input" style={{ maxWidth: 260 }} placeholder="Search organizations…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          <Select className="select" value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }} aria-label="Sort by">
            <option value="tasks">Most tasks</option><option value="projects">Most projects</option><option value="members">Most members</option><option value="storage">Most storage</option>
            <option value="activity">Most recent activity</option><option value="quiet">Quietest first</option><option value="name">Name</option>
          </Select>
          <label className="check" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={warnOnly} onChange={(e) => { setWarnOnly(e.target.checked); setPage(1); }} /> Near a plan limit only</label>
        </div>
        {q.isLoading ? <PageLoader /> : q.isError || !d ? <ErrorState error={q.error} retry={() => q.refetch()} /> : d.items.length === 0 ? <EmptyState icon="building" title="Nothing matches" /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Organization</th><th>Plan</th><th>Members</th><th>Projects</th><th>Tasks</th><th>Storage</th><th>Keys / hooks</th><th>Last activity</th><th /></tr></thead>
            <tbody>{d.items.map((r) => (
              <tr key={r.tenantId}>
                <td><b>{r.name}</b> {r.type === 'Personal' && <Badge>Personal</Badge>}
                  {r.warnings.length > 0 && <div style={{ marginTop: 4 }}>{r.warnings.map((w) => <Badge key={w.metric} tone={w.percent >= 100 ? 'danger' : 'warning'}>{w.metric} {w.percent}%</Badge>)}</div>}</td>
                <td><Badge tone="purple">{r.planCode}</Badge></td><td>{r.members}</td><td>{r.projects}</td><td>{r.tasks}</td><td>{r.storageMb} MB</td><td>{r.apiKeys} / {r.webhooks}</td>
                <td>{r.lastActivityAt ? timeAgo(r.lastActivityAt) : <span className="muted">never</span>}</td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => setExceptions(r)}>Plan exceptions</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {d && pages > 1 && (
          <div className="row" style={{ justifyContent: 'center', gap: 10, padding: 12 }}>
            <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
            <span className="muted">Page {page} of {pages}</span>
            <button className="btn btn-ghost btn-sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        )}
      </div>
      <p className="muted" style={{ fontSize: 12.5 }}>Only counts are shown. Customer projects, tasks and files are never visible on this page.</p>
      {exceptions && <ExceptionsModal org={exceptions} onClose={() => setExceptions(null)} />}
    </>
  );
}

const FEATURES: { key: string; label: string; flag: boolean }[] = [
  { key: 'PROJECT_LIMIT', label: 'Projects', flag: false }, { key: 'TASK_LIMIT', label: 'Tasks', flag: false }, { key: 'MAX_MEMBERS', label: 'Members', flag: false },
  { key: 'MAX_TEAMS', label: 'Teams', flag: false }, { key: 'STORAGE_LIMIT_MB', label: 'Storage (MB)', flag: false },
  { key: 'ADVANCED_REPORTS', label: 'Advanced reports', flag: true }, { key: 'CUSTOM_WORKFLOWS', label: 'Custom workflows', flag: true }, { key: 'ADVANCED_PERMISSIONS', label: 'Advanced permissions', flag: true },
  { key: 'AUDIT_LOG', label: 'Audit log', flag: true }, { key: 'AUTOMATION', label: 'Automation', flag: true }, { key: 'CUSTOM_FIELDS', label: 'Custom fields', flag: true }, { key: 'API_ACCESS', label: 'API keys & webhooks', flag: true },
  { key: 'ADVANCED_SECURITY', label: 'SSO & security rules', flag: true }, { key: 'RESOURCE_MANAGEMENT', label: 'Approvals, capacity & budgets', flag: true }, { key: 'SERVICE_LEVELS', label: 'Service levels (SLA)', flag: true },
  { key: 'REMINDER_LIMIT', label: 'Open reminders per person', flag: false }, { key: 'RECURRING_REMINDER_LIMIT', label: 'Repeating reminders per person', flag: false },
  { key: 'REMINDER_ESCALATION', label: 'Reminder escalation', flag: true },
  { key: 'AI_ASSISTANT', label: 'AI assistant', flag: true }, { key: 'AI_MODEL_TIER', label: 'AI model level (1 Quick, 2 Standard, 3 Deep)', flag: false },
  { key: 'AI_MONTHLY_CREDITS', label: 'AI credits per month', flag: false }, { key: 'AI_ATTACHMENTS', label: 'AI: read images & documents', flag: true },
  { key: 'AI_ACTIONS', label: 'AI: take actions & send reports', flag: true },
];

function ExceptionsModal({ org, onClose }: { org: AdminUsage; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useWsQuery(['admin', 'overrides', org.tenantId], () => platformApi.overrides(org.tenantId));
  const [key, setKey] = useState('API_ACCESS');
  const [value, setValue] = useState('1');
  const [reason, setReason] = useState('');
  const [days, setDays] = useState('30');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const feature = FEATURES.find((f) => f.key === key)!;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin'] });

  const add = async () => {
    setBusy(true); setError(null);
    try { await platformApi.setOverride(org.tenantId, key, { value: Number(value), reason: reason.trim(), expiresInDays: days === '' ? null : Number(days) }); toast('Exception saved.'); setReason(''); refresh(); }
    catch (e) { setError(err(e, 'Could not save the exception.')); }
    finally { setBusy(false); }
  };
  const remove = async (k: string) => {
    if (!(await confirmDialog({ title: 'Remove exception?', message: 'The organization goes back to what its plan gives.', confirmText: 'Remove' }))) return;
    try { await platformApi.removeOverride(org.tenantId, k); refresh(); } catch (e) { toast(err(e, 'Could not remove it.'), 'error'); }
  };

  return (
    <Modal size="lg" title={`Plan exceptions · ${org.name}`} subtitle="Give this organization more (or less) than its plan for a while. Every change is written to the audit log." onClose={onClose}
      footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}>
      {q.isLoading ? <PageLoader /> : (q.data ?? []).length === 0 ? <p className="muted" style={{ marginTop: 0 }}>No exceptions. This organization gets exactly what the {org.planCode} plan includes.</p> : (
        <div className="cf-list" style={{ marginBottom: 14 }}>
          {q.data!.map((o) => (
            <div className="cf-row" key={o.featureKey}>
              <div className="cf-main"><b>{FEATURES.find((f) => f.key === o.featureKey)?.label ?? o.featureKey}</b> <Badge tone="warning">{o.value === -1 ? 'Unlimited' : o.value}</Badge> <span className="muted">(plan: {o.planValue === -1 ? 'unlimited' : o.planValue})</span>
                <div className="muted" style={{ fontSize: 12 }}>{o.reason} · {o.expiresAt ? `ends ${formatDate(o.expiresAt)}` : 'no end date'}</div></div>
              <button type="button" className="btn-icon danger" aria-label="Remove exception" onClick={() => void remove(o.featureKey)}><Icon name="trash" /></button>
            </div>
          ))}
        </div>
      )}
      <h4 style={{ margin: '4px 0 8px' }}>Add or change an exception</h4>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="grid-2">
        <Field label="Feature"><Select className="select" value={key} onChange={(e) => { setKey(e.target.value); setValue(FEATURES.find((f) => f.key === e.target.value)!.flag ? '1' : '100'); }}>{FEATURES.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</Select></Field>
        <Field label={feature.flag ? 'Switch' : 'Limit'} hint={feature.flag ? undefined : '-1 means unlimited'}>
          {feature.flag ? <Select className="select" value={value} onChange={(e) => setValue(e.target.value)}><option value="1">On</option><option value="0">Off</option></Select>
            : <input className="input" type="number" min={-1} value={value} onChange={(e) => setValue(e.target.value)} />}
        </Field>
      </div>
      <div className="grid-2">
        <Field label="Reason" required><input className="input" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="30 day evaluation" /></Field>
        <Field label="Lasts"><Select className="select" value={days} onChange={(e) => setDays(e.target.value)}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="">No end date</option></Select></Field>
      </div>
      <button type="button" className="btn btn-primary" disabled={busy || !reason.trim()} onClick={() => void add()}>Save exception</button>
    </Modal>
  );
}

// ------------------------------------------------------------------ platform switches
export function SettingsTab() {
  const qc = useQueryClient();
  const q = useWsQuery(['admin', 'settings'], platformApi.settings);
  const [draft, setDraft] = useState<PlatformSettings | null>(null);
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const s = draft ?? q.data;
  const set = (patch: Partial<PlatformSettings>) => setDraft({ ...s, ...patch });
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(q.data);

  const save = async () => {
    if (s.maintenanceMode && !q.data!.maintenanceMode && !(await confirmDialog({ title: 'Turn on maintenance mode?', message: 'Everyone except platform administrators will be unable to change anything until you turn it off. They can still read and sign in.', confirmText: 'Turn on' }))) return;
    if (!s.signupsEnabled && q.data!.signupsEnabled && !(await confirmDialog({ title: 'Close sign-ups?', message: 'New people will not be able to create accounts unless they were invited to a workspace.', confirmText: 'Close sign-ups' }))) return;
    setBusy(true);
    try { await platformApi.setSettings(s); toast('Platform settings saved.'); setDraft(null); void qc.invalidateQueries({ queryKey: ['platform-status'] }); void q.refetch(); }
    catch (e) { toast(err(e, 'Could not save the settings.'), 'error'); }
    finally { setBusy(false); }
  };

  return (
    <>
    <div className="card">
      <div className="card-head"><h3>Platform switches</h3></div>
      <div className="card-body">
        <div className="setting-row">
          <div className="setting-info"><h4>Open sign-ups</h4><p>When off, only people invited to a workspace can create an account.</p></div>
          <label className="switch-line"><input type="checkbox" checked={s.signupsEnabled} onChange={(e) => set({ signupsEnabled: e.target.checked })} /> {s.signupsEnabled ? 'Open' : 'Closed'}</label>
        </div>
        <div className="setting-row">
          <div className="setting-info"><h4>Maintenance mode</h4><p>Pauses changes for everyone except platform administrators, so an upgrade can run safely. Reading and signing in keep working.</p></div>
          <label className="switch-line"><input type="checkbox" checked={s.maintenanceMode} onChange={(e) => set({ maintenanceMode: e.target.checked })} /> {s.maintenanceMode ? 'On' : 'Off'}</label>
        </div>
        <div className="setting-row" style={{ alignItems: 'flex-start' }}>
          <div className="setting-info" style={{ flex: 1 }}>
            <h4>Announcement banner</h4><p>Shown to everyone at the top of the app and on the sign-in page. Leave empty for none.</p>
            <div className="grid-2" style={{ marginTop: 8 }}>
              <input className="input" maxLength={300} value={s.announcement ?? ''} onChange={(e) => set({ announcement: e.target.value })} placeholder="Planned upgrade tonight at 22:00 UTC" aria-label="Announcement" />
              <Select className="select" value={s.announcementLevel} onChange={(e) => set({ announcementLevel: e.target.value })} aria-label="Banner style"><option value="info">Information</option><option value="warning">Warning</option><option value="danger">Urgent</option></Select>
            </div>
          </div>
        </div>
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary" disabled={!dirty || busy} onClick={() => void save()}>Save settings</button>
          {dirty && <button className="btn btn-ghost" onClick={() => setDraft(null)}>Discard</button>}
        </div>
      </div>
    </div>
    <BillingCurrencyCard />
    <PasswordPolicyCard />
    <ConsentDocumentsCard />
    </>
  );
}

// ------------------------------------------------------------------ billing currency
/** The one currency every plan is priced in (INR unless changed). Prices are set per plan under Plans; switching does not convert them. */
function BillingCurrencyCard() {
  const qc = useQueryClient();
  const q = useWsQuery(['admin', 'billing-settings'], platformApi.billingSettings);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const s: BillingSettings = q.data;
  const chosen = pick ?? s.currency;
  const dirty = chosen !== s.currency;

  const save = async () => {
    const to = s.currencies.find((c) => c.code === chosen);
    if (!(await confirmDialog({
      title: `Bill in ${to?.name ?? chosen}?`, confirmText: 'Switch currency', danger: false,
      message: `Every plan will be priced in ${chosen} from now on. The amounts are NOT converted: a plan that costs 999 will cost 999 ${chosen} until you change its price under Plans. Invoices already issued keep their currency.`,
    }))) return;
    setBusy(true);
    try { await platformApi.setBillingSettings({ currency: chosen }); toast(`Plans are now priced in ${chosen}. Review each plan's price.`); setPick(null); await qc.invalidateQueries({ queryKey: ['admin'] }); }
    catch (e) { toast(err(e, 'Could not change the currency.'), 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ marginTop: 22 }}>
      <div className="card-head"><div><h3>Billing currency</h3><p>The currency plans are priced and invoiced in. Set each plan's price under Plans.</p></div></div>
      <div className="card-body">
        <div className="setting-row">
          <div className="setting-info"><h4>Currency</h4><p>Currently {currencySymbol(s.currency)} {s.currency}. Example: a plan priced at 999 shows as {formatMoney(999, chosen)} a month.</p></div>
          <Select className="select" style={{ maxWidth: 260 }} value={chosen} onChange={(e) => setPick(e.target.value)} aria-label="Billing currency">
            {s.currencies.map((c) => <option key={c.code} value={c.code}>{currencySymbol(c.code) === c.code ? c.code : `${currencySymbol(c.code)} ${c.code}`} — {c.name}</option>)}
          </Select>
        </div>
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary" disabled={!dirty || busy} onClick={() => void save()}>Save currency</button>
          {dirty && <button className="btn btn-ghost" onClick={() => setPick(null)}>Discard</button>}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ password policy
const RULE_SWITCHES: { key: keyof PasswordPolicy; title: string; text: string }[] = [
  { key: 'requireLetter', title: 'A letter', text: 'At least one letter of any kind.' },
  { key: 'requireUppercase', title: 'An uppercase letter', text: 'At least one capital letter (A-Z and other scripts).' },
  { key: 'requireLowercase', title: 'A lowercase letter', text: 'At least one small letter.' },
  { key: 'requireDigit', title: 'A number', text: 'At least one digit.' },
  { key: 'requireSymbol', title: 'A symbol', text: 'At least one character that is neither a letter nor a digit, such as ! # or ?' },
  { key: 'blockCommon', title: 'Refuse common passwords', text: 'Blocks the most-used passwords, including disguised ones such as P@ssw0rd or Welcome2026.' },
  { key: 'blockPersonalInfo', title: 'Refuse personal details', text: "Blocks passwords that contain the person's name or the first part of their email address." },
];

function PasswordPolicyCard() {
  const q = useWsQuery(['admin', 'password-policy'], platformApi.passwordPolicy);
  const [draft, setDraft] = useState<PasswordPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const p = draft ?? q.data;
  const set = (patch: Partial<PasswordPolicy>) => setDraft({ ...p, ...patch });
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(q.data);
  const lengthOk = p.minLength >= 8 && p.minLength <= 64;
  const historyOk = p.historyCount >= 0 && p.historyCount <= 10;

  const save = async () => {
    setBusy(true);
    try { await platformApi.setPasswordPolicy(p); toast('Password policy saved. It applies to passwords chosen from now on.'); setDraft(null); void q.refetch(); }
    catch (e) { toast(err(e, 'Could not save the password policy.'), 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="card-head">
        <div><h3>Password policy</h3><p>For every account on the platform. Checked when someone chooses a password (sign-up, reset, change), so existing passwords keep working until they are changed.</p></div>
      </div>
      <div className="card-body">
        <div className="setting-row">
          <div className="setting-info"><h4>Minimum length</h4><p>Between 8 and 64 characters. Length matters more than any other rule.</p></div>
          <input className="input" type="number" min={8} max={64} style={{ width: 90 }} value={p.minLength} aria-label="Minimum length"
            onChange={(e) => set({ minLength: Number(e.target.value) })} />
        </div>
        {RULE_SWITCHES.map((r) => (
          <div className="setting-row" key={r.key}>
            <div className="setting-info"><h4>{r.title}</h4><p>{r.text}</p></div>
            <label className="switch-line"><input type="checkbox" checked={p[r.key] as boolean} onChange={(e) => set({ [r.key]: e.target.checked })} /> {p[r.key] ? 'Required' : 'Off'}</label>
          </div>
        ))}
        <div className="setting-row">
          <div className="setting-info"><h4>Remember previous passwords</h4><p>How many recent passwords (including the current one) can't be chosen again. 0 turns this off; at most 10.</p></div>
          <input className="input" type="number" min={0} max={10} style={{ width: 90 }} value={p.historyCount} aria-label="Previous passwords remembered"
            onChange={(e) => set({ historyCount: Number(e.target.value) })} />
        </div>
        {(!lengthOk || !historyOk) && <div className="form-error" role="alert">{!lengthOk ? 'Minimum length must be between 8 and 64.' : 'Remember between 0 and 10 previous passwords.'}</div>}
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary" disabled={!dirty || busy || !lengthOk || !historyOk} onClick={() => void save()}>Save policy</button>
          {dirty && <button className="btn btn-ghost" onClick={() => setDraft(null)}>Discard</button>}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ consent documents (Terms of Service, Privacy Policy)
function ConsentDocumentEditor({ doc, onSaved }: { doc: ConsentDocument; onSaved: () => void }) {
  const [title, setTitle] = useState(doc.title);
  const [body, setBody] = useState(doc.body);
  const [busy, setBusy] = useState(false);
  const dirty = title !== doc.title || body !== doc.body;

  const publish = async () => {
    if (!(await confirmDialog({
      title: `Publish this ${doc.title}?`,
      message: `Everyone who already accepted the current version will be asked to accept this one before they can change anything again. This can't be undone.`,
      confirmText: 'Publish',
    }))) return;
    setBusy(true);
    try { await platformApi.publishConsentDocument({ type: doc.type, title, body }); toast(`${doc.title} published.`); onSaved(); }
    catch (e) { toast(err(e, `Could not publish the ${doc.title}.`), 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="setting-row" style={{ alignItems: 'flex-start' }}>
      <div className="setting-info" style={{ flex: 1 }}>
        <h4>{doc.title} <Badge>{doc.publishedAt ? `v${doc.version}` : 'not published yet'}</Badge></h4>
        <p>{doc.publishedAt ? `Published ${formatDate(doc.publishedAt)}. Publishing again asks everyone to accept it once more.` : 'Placeholder text is shown until you publish the real document.'}</p>
        <Field label="Title"><input className="input" maxLength={150} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Document text">
          <textarea className="input" rows={8} maxLength={50_000} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary btn-sm" disabled={!dirty || busy || title.trim().length < 2 || body.trim().length < 20} onClick={() => void publish()}>Publish</button>
          {dirty && <button className="btn btn-ghost btn-sm" onClick={() => { setTitle(doc.title); setBody(doc.body); }}>Discard</button>}
        </div>
      </div>
    </div>
  );
}

function ConsentDocumentsCard() {
  const q = useWsQuery(['admin', 'consent'], platformApi.consentDocuments);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="card-head">
        <div><h3>Legal documents</h3><p>Terms of Service and Privacy Policy, shown at sign-up and from Settings. Publishing a new version asks existing members to accept it again before they can change anything.</p></div>
      </div>
      <div className="card-body">
        {q.data.map((d) => <ConsentDocumentEditor key={d.type} doc={d} onSaved={() => void q.refetch()} />)}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ health
const tone = (s: string) => (s === 'ok' ? 'success' : s === 'degraded' || s === 'stalled' ? 'warning' : 'danger');
const uptime = (sec: number) => { const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };

export function HealthTab() {
  const q = useWsQuery(['admin', 'health'], platformApi.health, { refetchInterval: 15_000 });
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const h = q.data;
  return (
    <>
      <GoLiveCard />
      <div className="stat-grid">
        <StatCard icon="activity" tone={h.status === 'ok' ? 'green' : h.status === 'down' ? 'red' : 'amber'} value={h.status === 'ok' ? 'Healthy' : h.status === 'down' ? 'Down' : 'Degraded'} label="Overall" foot={`v${h.version} · ${h.runtime}`} />
        <StatCard icon="clock" tone="blue" value={uptime(h.uptimeSeconds)} label="Uptime" foot={`since ${formatDate(h.startedAt)}`} />
        <StatCard icon="chart" tone="purple" value={h.traffic.requests.toLocaleString()} label="Requests since start" foot={`${h.traffic.serverErrors} server errors`} />
        <StatCard icon="paperclip" tone="blue" value={`${h.attachmentStorageMb} MB`} label="Uploaded files" />
      </div>
      <div className="grid-2 mb-18">
        <div className="card">
          <div className="card-head"><h3>Database</h3></div>
          <div className="card-body">
            <p style={{ marginTop: 0 }}><Badge tone={h.database.reachable ? 'success' : 'danger'}>{h.database.reachable ? 'Reachable' : 'Unreachable'}</Badge> {h.database.provider} · answered in {h.database.latencyMs} ms</p>
            <p className="muted" style={{ marginBottom: 0 }}>{h.database.pendingMigrations > 0 ? `${h.database.pendingMigrations} schema update(s) waiting to be applied.` : 'Schema is up to date.'}{h.database.error ? ` (${h.database.error})` : ''}</p>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Cache</h3></div>
          <div className="card-body">
            <p style={{ marginTop: 0 }}><Badge tone={h.cache.reachable ? 'success' : 'danger'}>{h.cache.reachable ? 'Reachable' : 'Unreachable'}</Badge> {h.cache.provider} · round trip {h.cache.latencyMs} ms</p>
            <p className="muted" style={{ marginBottom: 0 }}>{h.cache.provider === 'Redis' ? 'Shared by every API server: plans are remembered between requests and rate limits are counted once, not per server.' : 'Each server remembers plans on its own. Set REDIS_URL to share the cache and rate limits across several API servers.'}{h.cache.error ? ` (${h.cache.error})` : ''}</p>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Queues</h3></div>
          <div className="card-body">
            <div className="table-wrap"><table><tbody>
              <tr><td>Notification e-mails</td><td>{h.queues.emailsWaiting} waiting</td><td>{h.queues.emailsStuck > 0 ? <Badge tone="danger">{h.queues.emailsStuck} stuck</Badge> : <span className="muted">none stuck</span>}</td></tr>
              <tr><td>Report exports</td><td>{h.queues.reportsWaiting} waiting</td><td>{h.queues.reportsFailed > 0 ? <Badge tone="warning">{h.queues.reportsFailed} failed</Badge> : <span className="muted">none failed</span>}</td></tr>
              <tr><td>Webhook deliveries</td><td>{h.queues.webhooksWaiting} waiting</td><td>{h.queues.webhooksFailed > 0 ? <Badge tone="warning">{h.queues.webhooksFailed} failed</Badge> : <span className="muted">none failed</span>}</td></tr>
              {h.reminders && <tr><td>Reminders</td><td>{h.reminders.waiting} waiting · {h.reminders.sentSinceStart} sent (this server)</td>
                <td>{h.reminders.late > 0 ? <Badge tone="warning">{h.reminders.late} late</Badge> : <span className="muted">on time · p95 {h.reminders.lagP95Seconds}s</span>}</td></tr>}
            </tbody></table></div>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h3>Background workers</h3></div>
        <div className="card-body">
          {h.workers.length === 0 ? <p className="muted">No worker has reported yet (they start a few seconds after the server).</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Worker</th><th>Status</th><th>Last round</th><th>Every</th></tr></thead>
              <tbody>{h.workers.map((w) => (
                <tr key={w.name}><td><b>{w.name}</b></td><td><Badge tone={tone(w.status)}>{w.status}</Badge>{w.lastError && <span className="muted"> {w.lastError}</span>}</td><td>{w.lastRunAt ? timeAgo(w.lastRunAt) : '—'}</td><td>{w.intervalSeconds >= 60 ? `${Math.round(w.intervalSeconds / 60)} min` : `${w.intervalSeconds} s`}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          {h.traffic.lastServerErrorAt && <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>Last server error {timeAgo(h.traffic.lastServerErrorAt)}. Counters reset when the server restarts.</p>}
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ go-live checklist
const checkTone = (s: string) => (s === 'ok' ? 'success' : s === 'warn' ? 'warning' : 'danger');
const checkLabel = (s: string) => (s === 'ok' ? 'OK' : s === 'warn' ? 'Attention' : 'Fix first');

/** Are we safe to open this to real people? Read from the running configuration; never shows a secret. */
export function GoLiveCard() {
  const q = useWsQuery(['admin', 'go-live'], platformApi.goLive, { refetchInterval: 60_000 });
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ sent: boolean; text: string } | null>(null);
  const g: GoLive | undefined = q.data;

  const sendTest = async () => {
    setTesting(true); setResult(null);
    try {
      const r = await platformApi.testEmail();
      setResult({
        sent: r.sent && r.provider.toLowerCase() !== 'log',
        text: !r.sent ? `Sending failed: ${r.error}` : r.provider.toLowerCase() === 'log'
          ? 'The mail provider is “Log”: the message was only written to the server log and nobody received it. Switch EMAIL_PROVIDER to Smtp to really send e-mail.'
          : `A test message was handed to “${r.provider}” for ${r.to}. Check that inbox (and spam).`,
      });
    } catch (e) { setResult({ sent: false, text: err(e, 'Could not send the test.') }); }
    finally { setTesting(false); }
  };

  return (
    <div className="card mb-22">
      <div className="card-head">
        <div><h3>Go-live checklist</h3><p>{g ? (g.verdict === 'ready' ? 'Everything checks out.' : g.verdict === 'almost' ? `${g.warnings} thing${g.warnings === 1 ? '' : 's'} worth a look.` : `${g.failing} thing${g.failing === 1 ? '' : 's'} to fix before real people use this.`) : 'Checking…'}</p></div>
        <button className="btn btn-ghost btn-sm" disabled={testing} onClick={() => void sendTest()}>{testing ? 'Sending…' : 'Send test email to me'}</button>
      </div>
      <div className="card-body">
        {result && <div className={result.sent ? 'notice' : 'form-error'} role="status" style={{ marginBottom: 12 }}>{result.text}</div>}
        {q.isLoading ? <PageLoader /> : q.isError || !g ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
          <div className="cf-list">
            {[...g.checks].sort((a, b) => ({ fail: 0, warn: 1, ok: 2 }[a.status] - { fail: 0, warn: 1, ok: 2 }[b.status])).map((c) => (
              <div className="cf-row" key={c.id}>
                <div className="cf-main">
                  <b>{c.title}</b> <Badge tone={checkTone(c.status)}>{checkLabel(c.status)}</Badge>
                  <div className="muted" style={{ fontSize: 12.5 }}>{c.detail}</div>
                  {c.fix && <div style={{ fontSize: 12.5, marginTop: 3 }}><b>To fix:</b> {c.fix}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A short warning at the top of the admin overview while the deployment is not ready for real people. */
export function GoLiveNotice() {
  const q = useWsQuery(['admin', 'go-live'], platformApi.goLive, { refetchInterval: 60_000 });
  if (!q.data || q.data.failing === 0) return null;
  return (
    <div className="form-error" role="alert" style={{ marginBottom: 16 }}>
      <b>Not ready for real users:</b> {q.data.failing} setting{q.data.failing === 1 ? '' : 's'} must be fixed first ({q.data.checks.filter((c) => c.status === 'fail').map((c) => c.title).join(', ')}). <a className="link" href="/admin/health">Open the checklist</a>
    </div>
  );
}
