import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { workspaceApi } from '../../api/endpoints';
import { ErrorState, PageLoader } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { useAuth, useCan } from '../../stores/auth';
import { toast } from '../../stores/ui';

interface Draft { requireMfa: boolean; ipAllowlistEnabled: boolean; ipText: string }
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
  const s = draft ?? { requireMfa: data.requireMfa, ipAllowlistEnabled: data.ipAllowlistEnabled, ipText: data.ipRanges.join('\n') };
  const set = (patch: Partial<Draft>) => setDraft({ ...s, ...patch });
  const dirty = draft !== null;
  const ranges = rangesOf(s.ipText);
  const savedRanges = data.ipRanges.join('\n');
  const isDirty = dirty && (s.requireMfa !== data.requireMfa || s.ipAllowlistEnabled !== data.ipAllowlistEnabled || s.ipText.trim() !== savedRanges.trim());

  const save = async () => {
    if (s.requireMfa && !myMfa) { toast('Turn on two-step verification for your own account first (Settings → Security).', 'error'); return; }
    if (s.ipAllowlistEnabled && ranges.length === 0) { toast('Add at least one address or range.', 'error'); return; }
    setBusy(true);
    try {
      await workspaceApi.setSecurity({ requireMfa: s.requireMfa, ipAllowlistEnabled: s.ipAllowlistEnabled, ipRanges: ranges });
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
