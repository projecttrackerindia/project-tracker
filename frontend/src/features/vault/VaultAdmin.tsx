import { useState, type ReactNode } from 'react';
import { ApiError } from '../../api/client';
import { workspaceApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { ErrorState, Modal, Spinner } from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { toast } from '../../stores/ui';
import { ACCESS_LABEL, HEALTH_LABEL, vaultApi, type VaultHealth, type VaultHealthFlag, type VaultPolicy } from './api';
import { useStepUp } from './stepUpContext';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** The vault's health: one score and what is pulling it down, each a click away from the items concerned. */
export function HealthView({ health, onFilter, extra }: { health: VaultHealth; onFilter: (flag: VaultHealthFlag | 'any') => void; extra?: ReactNode }) {
  const rows: [VaultHealthFlag, number, string][] = [
    ['breached', health.breached, 'Change these first: the password is on lists attackers use.'],
    ['rotate', health.toRotate, 'Someone who could read them left, or they were flagged.'],
    ['expired', health.expired, 'Past the date they were due to be changed.'],
    ['reused', health.reused, 'The same password on more than one item: one leak opens both.'],
    ['weak', health.weak, 'Easy to guess. Generate a new one.'],
    ['old', health.old, 'Not changed in over a year.'],
  ];
  const tone = health.score >= 85 ? 'good' : health.score >= 60 ? 'fair' : 'poor';
  return (
    <div className="vlt-health">
      <div className={`vlt-score ${tone}`} style={{ ['--p' as string]: String(health.score / 100) }} role="img" aria-label={`Vault health ${health.score} out of 100`}>
        <b>{health.score}</b><span>health</span>
      </div>
      <div className="vlt-health-text">
        <h3>{health.total === 0 ? 'Nothing stored yet' : health.score >= 85 ? 'In good shape' : health.score >= 60 ? 'Some things to fix' : 'Needs attention'}</h3>
        <p className="muted">{health.total} item{health.total === 1 ? '' : 's'} you can open. Breach checks run when a password is saved and again every month (only the first five characters of its hash are sent).</p>
        {extra}
      </div>
      <ul className="vlt-health-list">
        {rows.map(([flag, n, hint]) => (
          <li key={flag} className={n > 0 ? 'has' : ''}>
            <button type="button" disabled={n === 0} onClick={() => onFilter(flag)}>
              <span className={`vlt-health-dot ${flag}`} aria-hidden="true" />
              <span><b>{HEALTH_LABEL[flag]}</b><span className="muted">{hint}</span></span>
              <span className="vlt-health-n">{n}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** For vault admins: the workspace's rules, and who can open what (and what they used), with announced 24-hour access when someone is away. */
export function AdminView({ policy, onPolicy }: { policy: VaultPolicy; onPolicy: () => void }) {
  const [stepUpAlways, setStepUpAlways] = useState(policy.stepUpAlways);
  const [clipboard, setClipboard] = useState(policy.clipboardSeconds);
  const [adminsOnly, setAdminsOnly] = useState(policy.sharedAdminsOnly);
  const [saving, setSaving] = useState(false);
  const [person, setPerson] = useState('');
  const members = useWsQuery(['vault', 'members'], () => workspaceApi.members(), { staleTime: 300_000, retry: false });
  const review = useWsQuery(['vault', 'review', person], () => vaultApi.accessReview(person), { enabled: !!person, staleTime: 0 });
  const [breakGlass, setBreakGlass] = useState<{ id: string; name: string } | null>(null);
  const dirty = stepUpAlways !== policy.stepUpAlways || clipboard !== policy.clipboardSeconds || adminsOnly !== policy.sharedAdminsOnly;
  return (
    <div className="vlt-admin">
      <section className="card">
        <div className="card-head"><div><h3>Vault rules</h3><p>For everyone in this workspace.</p></div></div>
        <div className="card-body vlt-rules">
          <label className="vlt-check-row"><input type="checkbox" checked={stepUpAlways} onChange={(e) => setStepUpAlways(e.target.checked)} /> <span><b>Two-step check for every reveal, copy and code</b><br /><span className="muted">Not only for confidential items. People without an authenticator app will be asked to set one up.</span></span></label>
          <label className="vlt-check-row"><input type="checkbox" checked={adminsOnly} onChange={(e) => setAdminsOnly(e.target.checked)} /> <span><b>Only vault admins make shared collections</b><br /><span className="muted">Everyone keeps their own vault.</span></span></label>
          <label className="field vlt-inline-field"><span>Clear the clipboard after</span>
            <select className="input" value={clipboard} onChange={(e) => setClipboard(Number(e.target.value))} aria-label="Clipboard seconds">
              {[10, 20, 30, 45, 60, 90, 120].map((s) => <option key={s} value={s}>{s} seconds</option>)}
            </select></label>
          <p className="vlt-small muted">Revealed values hide again after {policy.revealSeconds} seconds (Settings → Documents → Security sets that for the whole workspace).</p>
          <div><button className="btn btn-primary btn-sm" disabled={!dirty || saving} onClick={async () => {
            setSaving(true);
            try { await vaultApi.savePolicy({ stepUpAlways, clipboardSeconds: clipboard, sharedAdminsOnly: adminsOnly }); toast('Vault rules saved.'); onPolicy(); }
            catch (e) { toast(errText(e, 'Could not save.'), 'error'); } finally { setSaving(false); }
          }}>{saving && <span className="spinner" />}Save rules</button></div>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><div><h3>Access review</h3><p>Which shared collections a person can open, and what they used in the last 90 days. Personal vaults are never shown.</p></div></div>
        <div className="card-body">
          <label className="field vlt-inline-field"><span>Person</span>
            <select className="input" value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Person to review">
              <option value="">Choose someone…</option>
              {(members.data ?? []).map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
            </select></label>
          {person && (review.isLoading ? <Spinner /> : review.error ? <ErrorState error={review.error} retry={() => review.refetch()} /> : review.data && (
            <div className="vlt-review">
              <h4>Can open ({review.data.collections.length})</h4>
              {review.data.collections.length === 0 ? <p className="muted">No shared collections.</p> : (
                <ul>{review.data.collections.map((c) => (
                  <li key={c.id}><b>{c.name}</b> <span className="badge badge-neutral">{ACCESS_LABEL[c.access]}</span> <span className="muted">{c.items} item{c.items === 1 ? '' : 's'}</span>
                    <button className="btn btn-ghost btn-xs" onClick={() => setBreakGlass({ id: c.id, name: c.name })}>Take 24-hour access</button></li>
                ))}</ul>
              )}
              <h4>Used in the last 90 days ({review.data.used.length})</h4>
              {review.data.used.length === 0 ? <p className="muted">Nothing.</p> : (
                <ul>{review.data.used.map((u) => <li key={u.itemId}><b>{u.title}</b> <span className="muted">{u.collection} · {u.times}× · last {timeAgo(u.last)}</span></li>)}</ul>
              )}
            </div>
          ))}
        </div>
      </section>
      {breakGlass && <BreakGlassModal collection={breakGlass} onClose={() => setBreakGlass(null)} />}
    </div>
  );
}

function BreakGlassModal({ collection, onClose }: { collection: { id: string; name: string }; onClose: () => void }) {
  const step = useStepUp();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`Take access to ${collection.name}`} subtitle="For 24 hours, to manage it while the people who do are away." size="sm" onClose={onClose} className="vlt-scope"
      onSubmit={async (e) => {
        e.preventDefault(); setError(null); setBusy(true);
        try {
          const r = await step.run((t) => vaultApi.adminAccess(collection.id, reason.trim(), t ?? ''), true);
          if (r) { toast(`You can manage ${collection.name} until ${formatDateTime(new Date(Date.now() + 24 * 3600_000))}. Its managers were told.`, 'warning'); onClose(); }
        } catch (err) { setError(errText(err, 'Could not take access.')); }
        finally { setBusy(false); }
      }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || reason.trim().length < 10}>{busy && <span className="spinner" />}Take access</button></>}>
      <label className="field"><span>Why (the people who manage it will read this)</span>
        <textarea className="textarea" rows={3} value={reason} maxLength={500} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="Kavya is on leave and the firewall is down" /></label>
      <p className="vlt-small muted"><Icon name="shield" size={12} /> Needs a fresh two-step check, ends by itself, and is recorded in the audit trail.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
    </Modal>
  );
}
