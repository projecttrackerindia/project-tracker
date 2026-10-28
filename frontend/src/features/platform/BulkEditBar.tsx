import { useState } from 'react';
import { ApiError } from '../../api/client';
import { labelApi, projectApi, workspaceApi } from '../../api/endpoints';
import { bulkApi, type BulkWorkInput } from '../../api/platformApi';
import type { Priority } from '../../api/types';
import type { WorkRow } from '../../api/workItemsApi';
import { Icon } from '../../components/Icon';
import { useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { refreshWork } from '../work/workUi';
import './platform.css';

const STATUSES: { id: NonNullable<BulkWorkInput['status']>; label: string }[] = [
  { id: 'todo', label: 'To do' }, { id: 'active', label: 'In progress' }, { id: 'done', label: 'Done' }, { id: 'cancelled', label: 'Cancelled' },
];

/**
 * The bar that appears when rows are selected in a Work list or the Desk queue: set status, owner, priority, due date or labels, move tickets
 * to a project, or delete - one request for all of them (POST /work-items/bulk). Each item is checked on its own; what could not be changed
 * is listed by key with the reason. Floating at the bottom on a desktop, a sheet on a phone.
 */
export function BulkEditBar({ rows, onClear, onDone }: { rows: WorkRow[]; onClear: () => void; onDone?: () => void }) {
  const wid = useWorkspaceId();
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<{ key: string | null; reason: string }[]>([]);
  const members = useWsQuery(['members'], () => workspaceApi.members(), { staleTime: 5 * 60_000, enabled: rows.length > 0 });
  const hasTasks = rows.some((r) => r.kind === 'task');
  const hasTickets = rows.some((r) => r.kind === 'ticket');
  const labels = useWsQuery(['labels'], labelApi.list, { staleTime: 5 * 60_000, enabled: hasTasks });
  const projects = useWsQuery(['projects', 'bulk-move'], () => projectApi.list({ pageSize: 100 }), { staleTime: 5 * 60_000, enabled: hasTickets });
  if (rows.length === 0) return null;
  const ids = rows.map((r) => r.id);

  const run = async (change: Omit<BulkWorkInput, 'ids'>, what: string) => {
    setBusy(true); setProblems([]);
    try {
      const r = await bulkApi.run({ ids, ...change });
      refreshWork(wid);
      if (r.failed.length === 0) { toast(`${what}: ${r.changed} ${r.changed === 1 ? 'item' : 'items'} changed.`); onClear(); onDone?.(); }
      else {
        toast(`${what}: ${r.changed} changed, ${r.failed.length} left as they were.`, r.changed ? 'warning' : 'error');
        setProblems(r.failed.map((f) => ({ key: f.key, reason: f.reason })));
      }
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not change them.', 'error'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    const ok = await confirmDialog({ title: `Delete ${rows.length} ${rows.length === 1 ? 'item' : 'items'}?`, danger: true, confirmText: 'Delete',
      message: 'Tasks and tickets can be restored by an admin for a while; issues and action items are removed for good. Anything you may not delete is left as it is.' });
    if (ok) await run({ delete: true }, 'Delete');
  };

  return (
    <div className="pv-bulk" role="toolbar" aria-label="Change the selected items">
      <div className="pv-bulk-top">
        <b>{rows.length} selected</b>
        <button type="button" className="pv-bulk-clear" onClick={onClear} disabled={busy}>Clear</button>
      </div>
      <div className="pv-bulk-acts">
        <label className="pv-bulk-pick"><span>Status</span>
          <select aria-label="Set status" value="" disabled={busy} onChange={(e) => e.target.value && void run({ status: e.target.value as BulkWorkInput['status'] }, 'Status')}>
            <option value="">Status…</option>{STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select></label>
        <label className="pv-bulk-pick"><span>Owner</span>
          <select aria-label="Set owner" value="" disabled={busy} onChange={(e) => e.target.value && void run(e.target.value === '-' ? { unassign: true } : { assigneeId: e.target.value }, 'Owner')}>
            <option value="">Owner…</option><option value="-">Nobody</option>
            {members.data?.filter((m) => m.role !== 'Guest' && m.isActive !== false).map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
          </select></label>
        <label className="pv-bulk-pick"><span>Priority</span>
          <select aria-label="Set priority" value="" disabled={busy} onChange={(e) => e.target.value && void run({ priority: e.target.value as Priority }, 'Priority')}>
            <option value="">Priority…</option>{(['Critical', 'High', 'Medium', 'Low'] as Priority[]).map((p) => <option key={p} value={p}>{p}</option>)}
          </select></label>
        <label className="pv-bulk-pick date"><span>Due</span>
          <input type="date" aria-label="Set due date" disabled={busy} onChange={(e) => e.target.value && void run({ dueDate: e.target.value }, 'Due date')} /></label>
        {hasTasks && (labels.data?.length ?? 0) > 0 && (
          <label className="pv-bulk-pick"><span>Label</span>
            <select aria-label="Add label" value="" disabled={busy} onChange={(e) => e.target.value && void run({ labelIds: [e.target.value] }, 'Label')}>
              <option value="">Add label…</option>{labels.data!.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select></label>
        )}
        {hasTickets && (projects.data?.items.length ?? 0) > 0 && (
          <label className="pv-bulk-pick"><span>Project</span>
            <select aria-label="Move to project" value="" disabled={busy} onChange={(e) => e.target.value && void run({ projectId: e.target.value }, 'Move')}>
              <option value="">Move to…</option>{projects.data!.items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
        )}
        <button type="button" className="pv-bulk-del" disabled={busy} onClick={() => void remove()}><Icon name="trash" size={14} />Delete</button>
        {busy && <span className="spinner" aria-label="Saving" />}
      </div>
      {problems.length > 0 && (
        <ul className="pv-bulk-problems" role="status">
          {problems.slice(0, 5).map((p, i) => <li key={i}><b>{p.key ?? 'An item'}</b> {p.reason}</li>)}
          {problems.length > 5 && <li>and {problems.length - 5} more</li>}
        </ul>
      )}
    </div>
  );
}
