import { useState } from 'react';
import { ApiError, fetchBlobUrl } from '../../api/client';
import { teamApi, workspaceApi } from '../../api/endpoints';
import { flagApi, problemApi, type FeatureFlagRow, type ProblemReport } from '../../api/endpoints.notifySmart';
import { useWsQuery } from '../../lib/hooks';
import { flagsKey } from '../../lib/flags';
import { queryClient, useAuth } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { SGroup, SPaneHead, SPop, SRow, SSwitch, STile } from './Grouped';
import '../../styles/notify-smart.css';

/**
 * Settings › General › Feature flags (owners and admins): each feature's switch for the whole workspace, and exceptions for a team or a
 * person (the most specific wins: person, then team, then workspace). Unfinished features are off until someone turns them on.
 */
export function FeatureFlagsSection() {
  const wid = useAuth((s) => s.ctx?.current?.id ?? null);
  const key = ['feature-flags', 'admin'];
  const q = useWsQuery(key, flagApi.list, { retry: false });
  const teams = useWsQuery(['teams'], teamApi.list, { retry: false });
  const members = useWsQuery(['workspace-members'], workspaceApi.members, { retry: false });
  const rows = Array.isArray(q.data) ? q.data : [];
  const [adding, setAdding] = useState<{ key: string; scope: 'team' | 'user'; target: string; on: 'on' | 'off' } | null>(null);

  const set = async (k: string, scope: 'workspace' | 'team' | 'user', targetId: string | null, enabled: boolean | null) => {
    const before = q.data;
    if (scope === 'workspace' && before) queryClient.setQueryData([wid, ...key], before.map((r) => (r.key === k ? { ...r, workspace: enabled, effective: enabled ?? r.default } : r)));
    try {
      queryClient.setQueryData([wid, ...key], await flagApi.set(k, { scope, targetId, enabled }));
      void queryClient.invalidateQueries({ queryKey: [wid, ...flagsKey] });
      toast('✓ Saved', 'success');
    } catch (e) { queryClient.setQueryData([wid, ...key], before); toast(e instanceof ApiError ? e.message : 'Could not change the feature.', 'error'); }
  };

  const teamOpts = (Array.isArray(teams.data) ? teams.data : []).map((t) => ({ id: t.id, label: t.name }));
  const memberOpts = (Array.isArray(members.data) ? members.data : []).filter((m) => m.isActive !== false).map((m) => ({ id: m.userId, label: m.displayName }));

  return (
    <div className="sg-pane" data-setting="workspace.features">
      <SPaneHead icon="⚑" color="linear-gradient(180deg,#7d7aff,#5856d6)" title="Feature flags" sub="Turn features on for everyone, one team or one person. New things stay off until you choose." />
      <SGroup label="Features">
        {rows.map((f: FeatureFlagRow) => (
          <div key={f.key}>
            <SRow icon={<STile color={f.effective ? '#34c759' : '#8e8e93'}>⚑</STile>} title={f.label}
              sub={`${f.description}${f.workspace === null ? ` · Default: ${f.default ? 'on' : 'off'}` : ''}`}>
              {f.workspace !== null && <button type="button" className="sg-btn" onClick={() => void set(f.key, 'workspace', null, null)}>Reset</button>}
              <SSwitch on={f.effective} label={`${f.label} for everyone`} onChange={(v) => void set(f.key, 'workspace', null, v)} />
            </SRow>
            {f.overrides.length > 0 && (
              <div className="ff-over" aria-label={`${f.label} exceptions`}>
                {f.overrides.map((o) => (
                  <span key={`${o.scope}:${o.targetId}`} className="ff-chip">
                    <b>{o.name}</b> {o.scope === 'team' ? 'team' : ''} · {o.enabled ? 'on' : 'off'}
                    <button type="button" aria-label={`Remove the exception for ${o.name}`} onClick={() => void set(f.key, o.scope, o.targetId, null)}>×</button>
                  </span>
                ))}
              </div>
            )}
            {adding?.key === f.key ? (
              <div className="ff-add">
                <SPop label="Exception for" value={adding.scope} options={[{ id: 'team', label: 'A team' }, { id: 'user', label: 'A person' }]}
                  onChange={(v) => setAdding({ ...adding, scope: v, target: '' })} />
                <SPop label="Who" value={adding.target} options={[{ id: '', label: 'Choose…' }, ...(adding.scope === 'team' ? teamOpts : memberOpts)]}
                  onChange={(v) => setAdding({ ...adding, target: v })} />
                <SPop label="On or off" value={adding.on} options={[{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }]} onChange={(v) => setAdding({ ...adding, on: v })} />
                <button type="button" className="sg-btn" disabled={!adding.target}
                  onClick={() => { void set(f.key, adding.scope, adding.target, adding.on === 'on'); setAdding(null); }}>Add</button>
                <button type="button" className="sg-btn" onClick={() => setAdding(null)}>Cancel</button>
              </div>
            ) : (
              <div className="ff-add"><button type="button" className="sg-btn" onClick={() => setAdding({ key: f.key, scope: 'team', target: '', on: f.effective ? 'off' : 'on' })}>Add exception</button></div>
            )}
          </div>
        ))}
        {!q.data && <SRow title="Loading…" />}
      </SGroup>
    </div>
  );
}

/** Settings › General › Problem reports (owners and admins): what people reported, newest first, with what came along. */
export function ProblemReportsSection() {
  const wid = useAuth((s) => s.ctx?.current?.id ?? null);
  const q = useWsQuery(['problem-reports'], problemApi.list, { retry: false });
  const rows: ProblemReport[] = Array.isArray(q.data) ? q.data : [];
  const [open, setOpen] = useState<string | null>(null);
  const [shot, setShot] = useState<Record<string, string>>({});
  const view = async (r: ProblemReport) => {
    setOpen(open === r.id ? null : r.id);
    if (r.hasScreenshot && !shot[r.id]) { try { const url = await fetchBlobUrl(`/problem-reports/${r.id}/screenshot`); setShot((s) => ({ ...s, [r.id]: url })); } catch { /* not available */ } }
  };
  const close = async (r: ProblemReport) => {
    try { await problemApi.setStatus(r.id, r.status === 'open' ? 'closed' : 'open'); void queryClient.invalidateQueries({ queryKey: [wid, 'problem-reports'] }); }
    catch { toast('Could not change it.', 'error'); }
  };
  return (
    <div className="sg-pane" data-setting="workspace.problem-reports">
      <SPaneHead icon="!" color="linear-gradient(180deg,#ffb340,#ff9500)" title="Problem reports" sub="What people in this workspace reported, with a screenshot and the errors the app saw." />
      <SGroup label={rows.length ? `${rows.filter((r) => r.status === 'open').length} open` : undefined}>
        {rows.map((r) => (
          <div key={r.id}>
            <SRow icon={<STile color={r.status === 'open' ? '#ff9500' : '#8e8e93'}>!</STile>} title={`${r.reference} · ${r.reporter?.name ?? 'Someone'}`}
              sub={`${new Date(r.createdAt).toLocaleString()} · ${r.route}`} onClick={() => void view(r)} />
            {open === r.id && (
              <div style={{ padding: '0 16px 14px 54px' }}>
                <p className="pr-msg">{r.message}</p>
                {r.console.length > 0 && <pre className="pr-tail">{r.console.join('\n')}</pre>}
                {r.network.length > 0 && <pre className="pr-tail">{r.network.join('\n')}</pre>}
                {shot[r.id] && <img className="pr-shot" src={shot[r.id]} alt={`Screenshot from ${r.reference}`} />}
                <p className="prb-facts" style={{ marginTop: 8 }}>Version {r.appVersion}{r.userAgent ? ` · ${r.userAgent}` : ''}</p>
                <div className="prb-actions"><button type="button" className="sg-btn" onClick={() => void close(r)}>{r.status === 'open' ? 'Mark resolved' : 'Reopen'}</button></div>
              </div>
            )}
          </div>
        ))}
        {q.data && rows.length === 0 && <SRow title="No problems reported" sub="When someone uses Report a problem, it shows here." />}
        {!q.data && <SRow title="Loading…" />}
      </SGroup>
    </div>
  );
}
