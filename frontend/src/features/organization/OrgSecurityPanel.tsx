import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { workspaceApi } from '../../api/endpoints';
import { ErrorState, PageLoader } from '../../components/ui';
import { Select } from '../../components/Select';
import { useWsQuery } from '../../lib/hooks';
import { useAuth, useCan } from '../../stores/auth';
import { toast } from '../../stores/ui';

interface Draft { requireMfa: boolean; ipAllowlistEnabled: boolean; ipText: string; minPasswordLength: number; sessionHours: number; allowedSignIn: string[] }
const METHODS: { id: string; label: string }[] = [
  { id: 'password', label: 'Password' }, { id: 'passkey', label: 'Passkey' }, { id: 'google', label: 'Google' }, { id: 'microsoft', label: 'Microsoft' },
  { id: 'github', label: 'GitHub' }, { id: 'apple', label: 'Apple' }, { id: 'sso', label: 'Single sign-on' },
];
const SESSION_CHOICES = [{ v: 0, l: 'Platform default' }, { v: 8, l: 'Every 8 hours' }, { v: 12, l: 'Every 12 hours' }, { v: 24, l: 'Every day' }, { v: 168, l: 'Every week' }, { v: 720, l: 'Every 30 days' }];
const err = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const rangesOf = (text: string) => text.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

/** An organization's own access rules on top of the platform's: required two-step verification and an IP allowlist. Business plan and above. */
export function OrgSecurityPanel() {
  const canManage = useCan('org.manage');
  const myMfa = useAuth((s) => s.ctx?.user.mfaEnabled ?? false);
  const q = useWsQuery(['org', 'security'], workspaceApi.security);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;

  const data = q.data;
  const allMethods = METHODS.map((m) => m.id);
  const saved = { requireMfa: data.requireMfa, ipAllowlistEnabled: data.ipAllowlistEnabled, ipText: data.ipRanges.join('\n'),
    minPasswordLength: data.minPasswordLength ?? 0, sessionHours: data.sessionHours ?? 0, allowedSignIn: data.allowedSignIn ?? allMethods };
  const s = draft ?? saved;
  const set = (patch: Partial<Draft>) => setDraft({ ...s, ...patch });
  const dirty = draft !== null;
  const ranges = rangesOf(s.ipText);
  const savedRanges = data.ipRanges.join('\n');
  const isDirty = dirty && (s.requireMfa !== data.requireMfa || s.ipAllowlistEnabled !== data.ipAllowlistEnabled || s.ipText.trim() !== savedRanges.trim()
    || s.minPasswordLength !== saved.minPasswordLength || s.sessionHours !== saved.sessionHours || [...s.allowedSignIn].sort().join() !== [...saved.allowedSignIn].sort().join());
  const platformMin = data.platformMinPasswordLength ?? 8;

  const save = async () => {
    if (s.requireMfa && !myMfa) { toast('Turn on two-step verification for your own account first (Settings → Security).', 'error'); return; }
    if (s.ipAllowlistEnabled && ranges.length === 0) { toast('Add at least one address or range.', 'error'); return; }
    setBusy(true);
    try {
      if (s.allowedSignIn.length === 0) { toast('Allow at least one way to sign in.', 'error'); setBusy(false); return; }
      await workspaceApi.setSecurity({ requireMfa: s.requireMfa, ipAllowlistEnabled: s.ipAllowlistEnabled, ipRanges: ranges,
        minPasswordLength: s.minPasswordLength, sessionHours: s.sessionHours, allowedSignIn: s.allowedSignIn });
      toast('Security settings saved.');
      setDraft(null);
      void q.refetch();
    } catch (e) { toast(err(e, 'Could not save the security settings.'), 'error'); }
    finally { setBusy(false); }
  };

  const addMyAddress = () => {
    if (!data.myIp || ranges.includes(data.myIp)) return;
    set({ ipText: [...ranges, data.myIp].join('\n') });
  };

  return (
    <div className="card">
      <div className="card-head"><div><h3>Security</h3><p>Extra access rules for this organization, on top of everyone's own account security.</p></div></div>
      <div className="card-body">
        {!data.entitled && (
          <div className="form-warn">
            Organization security rules are available on the Business plan and above. <Link className="link" to="/settings/billing">View plans</Link>
            {(s.requireMfa || s.ipAllowlistEnabled) && ' Your saved settings are kept but not enforced until you upgrade.'}
          </div>
        )}

        <div className="setting-row">
          <div className="setting-info">
            <h4>Require two-step verification</h4>
            <p>Everyone must turn on two-step verification (Settings → Security) to use this workspace.</p>
            {s.requireMfa && !myMfa && <p style={{ color: 'var(--danger)', fontWeight: 650, marginTop: 4 }}>Turn it on for your own account first, or you would be locked out.</p>}
          </div>
          <label className="switch-line"><input type="checkbox" disabled={!canManage} checked={s.requireMfa} onChange={(e) => set({ requireMfa: e.target.checked })} /> {s.requireMfa ? 'Required' : 'Off'}</label>
        </div>

        <div className="setting-row" style={{ alignItems: 'flex-start' }}>
          <div className="setting-info" style={{ flex: 1 }}>
            <h4>Restrict by network address</h4>
            <p>Only allow signing in to this workspace from the addresses or ranges below (one per line — a plain address like 203.0.113.9, or a range like 10.0.0.0/8).</p>
            {s.ipAllowlistEnabled && (
              <>
                <textarea className="input" rows={4} style={{ marginTop: 8, fontFamily: 'monospace', resize: 'vertical' }} value={s.ipText}
                  disabled={!canManage} onChange={(e) => set({ ipText: e.target.value })} placeholder={'203.0.113.9\n10.0.0.0/8'} aria-label="Allowed addresses and ranges" />
                {data.myIp && (
                  <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                    Your current address is {data.myIp}.{' '}
                    {!ranges.includes(data.myIp) && canManage && <button type="button" className="link-btn" onClick={addMyAddress}>Add it</button>}
                  </p>
                )}
              </>
            )}
          </div>
          <label className="switch-line"><input type="checkbox" disabled={!canManage} checked={s.ipAllowlistEnabled} onChange={(e) => set({ ipAllowlistEnabled: e.target.checked })} /> {s.ipAllowlistEnabled ? 'On' : 'Off'}</label>
        </div>

        <div className="setting-row">
          <div className="setting-info">
            <h4>Password length</h4>
            <p>Stricter than the platform's {platformMin} characters. Members with a shorter password are asked to change it before they continue (single sign-on and passkeys are not affected).</p>
          </div>
          <Select className="select" aria-label="Minimum password length" disabled={!canManage} value={s.minPasswordLength}
            onChange={(e) => set({ minPasswordLength: Number(e.target.value) })}>
            <option value={0}>Platform ({platformMin})</option>
            {[10, 12, 14, 16, 20].filter((n) => n > platformMin).map((n) => <option key={n} value={n}>At least {n}</option>)}
          </Select>
        </div>

        <div className="setting-row">
          <div className="setting-info"><h4>Sign in again</h4><p>How long a sign-in lasts before members must sign in again to use this workspace.</p></div>
          <Select className="select" aria-label="Session length" disabled={!canManage} value={s.sessionHours} onChange={(e) => set({ sessionHours: Number(e.target.value) })}>
            {SESSION_CHOICES.map((c) => <option key={c.v} value={c.v}>{c.l}</option>)}
          </Select>
        </div>

        <div className="setting-row" style={{ alignItems: 'flex-start' }}>
          <div className="setting-info" style={{ flex: 1 }}>
            <h4>Ways to sign in</h4><p>Only these open this workspace. Keep the one you use, or you would be locked out.</p>
            <div className="oss-methods" role="group" aria-label="Allowed ways to sign in">
              {METHODS.map((m) => (
                <label key={m.id} className="oss-method">
                  <input type="checkbox" disabled={!canManage} checked={s.allowedSignIn.includes(m.id)}
                    onChange={(e) => set({ allowedSignIn: e.target.checked ? [...s.allowedSignIn, m.id] : s.allowedSignIn.filter((x) => x !== m.id) })} /> {m.label}
                </label>
              ))}
            </div>
          </div>
        </div>

        {canManage && (
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn btn-primary" disabled={!isDirty || busy} onClick={() => void save()}>Save security settings</button>
            {dirty && <button className="btn btn-ghost" onClick={() => setDraft(null)}>Discard</button>}
          </div>
        )}
      </div>
    </div>
  );
}
