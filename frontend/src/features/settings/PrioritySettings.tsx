import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { priorityApi } from '../../api/endpoints';
import type { PriorityInfo } from '../../api/types';
import { usePriorities } from '../priorities/usePriorities';
import { useCan, useEntitlement, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

/** Settings → Priorities: rename and recolour Critical / High / Medium / Low for the whole workspace. */
export function PrioritySettings() {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const { list } = usePriorities();
  const canManage = useCan('workflow.manage');
  const included = useEntitlement('CUSTOM_WORKFLOWS') > 0;
  const [rows, setRows] = useState<PriorityInfo[]>(list);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setRows(list), [list]);
  const editable = canManage && included;
  const dirty = rows.some((r, i) => r.name !== list[i]?.name || r.color !== list[i]?.color);

  const set = (i: number, patch: Partial<PriorityInfo>) => setRows((r) => r.map((x, n) => (n === i ? { ...x, ...patch } : x)));
  const refresh = () => void qc.invalidateQueries({ queryKey: [wid, 'priorities'] });

  const save = async () => {
    setBusy(true); setError(null);
    try { await priorityApi.set(rows.map((r) => ({ level: r.level, name: r.name.trim(), color: r.color }))); toast('Priorities saved.'); refresh(); }
    catch (e) { setError(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save the priorities.'); }
    finally { setBusy(false); }
  };
  const reset = async () => {
    if (!(await confirmDialog({ title: 'Reset priorities?', message: 'Names and colours go back to Critical, High, Medium and Low. Tasks keep their priority level.', confirmText: 'Reset' }))) return;
    try { await priorityApi.reset(); toast('Priorities reset.'); refresh(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not reset.', 'error'); }
  };

  return (
    <div className="card mb-22">
      <div className="card-head"><div><h3>Priorities</h3><p>How this workspace names and colours its four priority levels.</p></div></div>
      <div className="card-body">
        {!included && <div className="notice">Custom priority names and colours are part of the Pro plan and above. <Link className="link" to="/billing">See plans</Link></div>}
        <div className="priority-rows">
          {rows.map((r, i) => (
            <div className="priority-row" key={r.level}>
              <span className="muted priority-level">{r.level}</span>
              <input className="input" aria-label={`Name for ${r.level}`} maxLength={20} value={r.name} disabled={!editable} onChange={(e) => set(i, { name: e.target.value })} />
              <input type="color" className="color-input" aria-label={`Colour for ${r.level}`} value={r.color} disabled={!editable} onChange={(e) => set(i, { color: e.target.value })} />
              <PreviewBadge info={r} />
            </div>
          ))}
        </div>
        {error && <div className="form-error" role="alert" style={{ marginTop: 10 }}>{error}</div>}
        {editable && (
          <div className="row" style={{ gap: 8, marginTop: 14 }}>
            <button className="btn btn-primary" disabled={!dirty || busy} onClick={() => void save()}>Save priorities</button>
            {list.some((p) => p.isCustom) && <button className="btn btn-ghost" onClick={() => void reset()}>Reset to defaults</button>}
          </div>
        )}
        {!canManage && included && <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>Only people who can manage workflows can change these.</p>}
      </div>
    </div>
  );
}

/** Same look as PriorityBadge, but for unsaved values. */
function PreviewBadge({ info }: { info: PriorityInfo }) {
  const c = info.color;
  return (
    <span className="badge badge-custom" style={{ '--c': c } as CSSProperties}>
      <span className="dot" />{info.name || '…'}
    </span>
  );
}
