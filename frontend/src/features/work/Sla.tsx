import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { workApi } from '../../api/endpoints';
import type { Priority, SlaClock, SlaState, SlaTarget, WorkSla } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { ErrorState, PageLoader, PriorityBadge } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useModule, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { useNow } from '../time/time';

const PRIORITIES: Priority[] = ['Critical', 'High', 'Medium', 'Low'];
const SUGGESTED: SlaTarget[] = [
  { priority: 'Critical', responseMinutes: 30, resolutionMinutes: 4 * 60 }, { priority: 'High', responseMinutes: 2 * 60, resolutionMinutes: 24 * 60 },
  { priority: 'Medium', responseMinutes: 8 * 60, resolutionMinutes: 3 * 24 * 60 }, { priority: 'Low', responseMinutes: 24 * 60, resolutionMinutes: 7 * 24 * 60 },
];

/** 90 → "1h 30m", 1440 → "1d", 2160 → "1d 12h", 30 → "30m". */
export function formatTarget(min: number | null): string {
  if (min === null) return '';
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '0m';
}
/** "30m", "4h", "1.5h", "3d", "1d 4h" → minutes; empty → null; anything else → NaN. */
export function parseTarget(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const re = /(\d+(?:\.\d+)?)\s*(d|h|m)/g;
  let total = 0, used = '';
  for (let m = re.exec(t); m; m = re.exec(t)) { total += Number(m[1]) * (m[2] === 'd' ? 1440 : m[2] === 'h' ? 60 : 1); used += m[0]; }
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 60);   // a bare number is hours
  return used.replace(/\s/g, '') === t.replace(/\s/g, '') && total > 0 ? Math.round(total) : NaN;
}

/** How long until (or since) a moment, compactly: "3d 4h", "1d", "4h 20m", "2h", "35m". */
function span(ms: number) {
  const m = Math.max(1, Math.round(Math.abs(ms) / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), r = m % 60;
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return r ? `${h}h ${r}m` : `${h}h`;
  return `${m}m`;
}

const STATE: Record<SlaState, { label: string; tone: string; icon: 'timer' | 'alert' | 'xCircle' | 'checkCircle' | 'pause' | 'close' }> = {
  OnTrack: { label: 'On track', tone: 'ok', icon: 'timer' }, AtRisk: { label: 'At risk', tone: 'risk', icon: 'alert' }, Breached: { label: 'Breached', tone: 'bad', icon: 'xCircle' },
  Met: { label: 'Met', tone: 'met', icon: 'checkCircle' }, Missed: { label: 'Missed', tone: 'bad', icon: 'xCircle' }, Paused: { label: 'Paused', tone: 'paused', icon: 'pause' },
  Stopped: { label: 'Stopped', tone: 'paused', icon: 'close' },
};

/** The clock that matters now: an unmet response first, otherwise resolution. */
function current(sla: WorkSla): { clock: SlaClock; which: 'Response' | 'Resolution' } | null {
  if (sla.response && !sla.response.metAt && ['OnTrack', 'AtRisk', 'Breached'].includes(sla.response.state)) return { clock: sla.response, which: 'Response' };
  if (sla.resolution) return { clock: sla.resolution, which: 'Resolution' };
  return sla.response ? { clock: sla.response, which: 'Response' } : null;
}

/** A compact SLA chip for lists: time left, time late, or how it ended. */
export function SlaChip({ sla }: { sla: WorkSla | null }) {
  const live = !!sla && ['OnTrack', 'AtRisk', 'Breached'].includes(sla.state);
  const now = useNowMinute(live);
  if (!sla) return <span className="muted">—</span>;
  const c = current(sla);
  const s = STATE[sla.state];
  let text: string = s.label;
  if (c && live) {
    const left = new Date(c.clock.dueAt).getTime() - now;
    text = left >= 0 ? `${span(left)} left` : `${span(left)} late`;
  }
  return (
    <span className={`sla-chip ${s.tone}`} title={c ? `${c.which} due ${formatDateTime(c.clock.dueAt)} · ${s.label}` : s.label}>
      <Icon name={s.icon} size={12} />{text}{c && live && <i>{c.which === 'Response' ? 'reply' : 'fix'}</i>}
    </span>
  );
}

/** Re-renders once a minute while active (countdowns do not need seconds). */
function useNowMinute(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function ClockRow({ label, hint, clock }: { label: string; hint: string; clock: SlaClock }) {
  const live = ['OnTrack', 'AtRisk', 'Breached'].includes(clock.state);
  const now = useNow(live);
  const s = STATE[clock.state];
  const due = new Date(clock.dueAt).getTime();
  const left = due - now;
  return (
    <div className={`sla-clock ${s.tone}`}>
      <div className="sla-clock-icon"><Icon name={s.icon} size={16} /></div>
      <div className="sla-clock-main">
        <div className="sla-clock-title"><b>{label}</b><span className={`sla-chip ${s.tone}`}>{s.label}</span></div>
        <div className="sla-clock-sub">
          {live ? (left >= 0 ? <>Due in <b>{span(left)}</b> · {formatDateTime(clock.dueAt)}</> : <><b>{span(left)} late</b> · was due {formatDateTime(clock.dueAt)}</>)
            : clock.metAt ? <>Done {formatDateTime(clock.metAt)} · target {formatDateTime(clock.dueAt)}</>
            : clock.state === 'Paused' ? <>On hold: the clock is stopped · due {formatDateTime(clock.dueAt)} when it resumes</>
            : <>Target {formatDateTime(clock.dueAt)}</>}
        </div>
        <div className="sla-clock-hint">{hint}</div>
      </div>
    </div>
  );
}

/** Both clocks of a work task, for its dialog. */
export function SlaPanel({ sla }: { sla: WorkSla }) {
  return (
    <div className="sla-panel">
      {sla.response && <ClockRow label="First response" hint="Met when someone moves it out of To Do, or comments when they did not raise it." clock={sla.response} />}
      {sla.resolution && <ClockRow label="Resolution" hint="Met when it is completed. On Hold stops this clock." clock={sla.resolution} />}
    </div>
  );
}

/**
 * Settings → Work types → Service levels: response and resolution targets per priority for all operational work, and (optionally) a work
 * type's own targets. Targets are typed like "30m", "4h" or "3d".
 */
export function SlaSettings() {
  const wid = useWorkspaceId();
  const seeWork = useModule('work') > 0;
  const q = useWsQuery(['work', 'sla'], workApi.sla, { enabled: seeWork });
  const types = useWsQuery(['work', 'types', 'all'], () => workApi.types(true), { enabled: seeWork });
  const [scope, setScope] = useState('');   // '' = defaults, otherwise a work type id
  const [draft, setDraft] = useState<Record<string, { r: string; s: string }>>({});
  const [busy, setBusy] = useState(false);

  const saved = useMemo(() => {
    if (!q.data) return null;
    const own = q.data.overrides.find((o) => o.workTypeId === scope);
    return scope ? (own?.targets ?? null) : q.data.defaults;
  }, [q.data, scope]);
  const hasOwn = !!scope && !!q.data?.overrides.some((o) => o.workTypeId === scope);
  const base = saved ?? q.data?.defaults ?? [];
  useEffect(() => {
    setDraft(Object.fromEntries(PRIORITIES.map((p) => { const t = base.find((x) => x.priority === p); return [p, { r: formatTarget(t?.responseMinutes ?? null), s: formatTarget(t?.resolutionMinutes ?? null) }]; })));
  }, [q.data, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!seeWork) return null;
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const d = q.data;
  const editable = d.entitled && d.canManage;
  const parsed = PRIORITIES.map((p) => ({ priority: p, responseMinutes: parseTarget(draft[p]?.r ?? ''), resolutionMinutes: parseTarget(draft[p]?.s ?? '') }));
  const invalid = parsed.some((t) => Number.isNaN(t.responseMinutes) || Number.isNaN(t.resolutionMinutes));
  const empty = d.defaults.every((t) => t.responseMinutes === null && t.resolutionMinutes === null);

  const save = async () => {
    setBusy(true);
    try { await workApi.saveSla(scope || null, parsed); toast(scope ? 'Targets saved for this work type.' : 'Service levels saved. New work and priority changes use them.'); void invalidateWorkspace(wid, 'work'); }
    catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save the targets.', 'error'); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    if (!(await confirmDialog({ title: 'Use the default targets?', message: 'This work type stops having targets of its own.', confirmText: 'Use defaults' }))) return;
    try { await workApi.clearSla(scope); toast('This work type now uses the default targets.'); void invalidateWorkspace(wid, 'work'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not change it.', 'error'); }
  };
  const suggest = () => setDraft(Object.fromEntries(SUGGESTED.map((t) => [t.priority, { r: formatTarget(t.responseMinutes), s: formatTarget(t.resolutionMinutes) }])));

  return (
    <div className="card mb-22">
      <div className="card-head">
        <div><h3>Service levels (SLA)</h3><p>How soon operational work must get a first response and be resolved, by priority. Fixed on each work task when it is raised or its priority changes; On Hold stops the clock.</p></div>
      </div>
      <div className="card-body">
        {!d.entitled && <div className="callout mb-18"><Icon name="lock" size={16} /><div><b>Service levels come with the Business plan.</b> Targets are not applied to work tasks until then.</div></div>}
        <div className="row wrap" style={{ gap: 10, marginBottom: 14 }}>
          <Select className="select" style={{ maxWidth: 320 }} value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Targets for">
            <option value="">Default · all work types</option>
            {(types.data ?? []).filter((t) => t.isActive || d.overrides.some((o) => o.workTypeId === t.id)).map((t) => (
              <option key={t.id} value={t.id}>{t.name}{d.overrides.some((o) => o.workTypeId === t.id) ? ' · own targets' : ''}</option>
            ))}
          </Select>
          {scope && !hasOwn && <span className="muted" style={{ fontSize: 12.5 }}>Uses the defaults now. Save to give it targets of its own.</span>}
          {editable && !scope && empty && <button type="button" className="btn btn-ghost btn-sm" onClick={suggest}><Icon name="bolt" size={14} /> Fill in suggested targets</button>}
        </div>
        <div className="table-wrap sla-matrix-wrap">
          <table className="sla-matrix">
            <thead><tr><th>Priority</th><th>First response within</th><th>Resolve within</th></tr></thead>
            <tbody>
              {PRIORITIES.map((p) => {
                const v = draft[p] ?? { r: '', s: '' };
                const badR = Number.isNaN(parseTarget(v.r)), badS = Number.isNaN(parseTarget(v.s));
                return (
                  <tr key={p}>
                    <td><PriorityBadge priority={p} /></td>
                    <td><input className={`input sla-input ${badR ? 'invalid' : ''}`} placeholder="Not measured" aria-label={`${p} response target`} value={v.r} disabled={!editable}
                      onChange={(e) => setDraft({ ...draft, [p]: { ...v, r: e.target.value } })} /></td>
                    <td><input className={`input sla-input ${badS ? 'invalid' : ''}`} placeholder="Not measured" aria-label={`${p} resolution target`} value={v.s} disabled={!editable}
                      onChange={(e) => setDraft({ ...draft, [p]: { ...v, s: e.target.value } })} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="field-hint" style={{ marginTop: 8 }}>Type a duration such as 30m, 4h, 1d 12h or 3d. Calendar time: nights and weekends count.</p>
        {editable && (
          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <button type="button" className="btn btn-primary" disabled={busy || invalid} onClick={() => void save()}>Save targets</button>
            {hasOwn && <button type="button" className="btn btn-ghost" onClick={() => void clear()}>Use the defaults instead</button>}
            {invalid && <span className="form-error" style={{ margin: 0 }}>Check the highlighted durations.</span>}
          </div>
        )}
        {!d.canManage && <p className="muted" style={{ marginTop: 12 }}>Only people who manage work types can change the targets.</p>}
      </div>
    </div>
  );
}
