import { useState } from 'react';
import { ApiError } from '../../api/client';
import { projectApi } from '../../api/endpoints';
import { Modal } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { dayMonth } from './projectParts';

type H = 'OnTrack' | 'AtRisk' | 'Delayed';
const LABEL: Record<string, string> = { OnTrack: 'On track', AtRisk: 'At risk', Delayed: 'Late', Completed: 'Completed', Cancelled: 'Cancelled', Archived: 'Archived' };
const TONE: Record<string, string> = { OnTrack: 'ok', AtRisk: 'risk', Delayed: 'late' };

/** When a status is set by hand: a quiet line under the header with who set it, why and until when, and Clear for people who may. */
export function HealthBanner({ projectId, canEdit, onEdit }: { projectId: string; canEdit: boolean; onEdit: () => void }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['project', projectId, 'health'], () => projectApi.health(projectId), { staleTime: 30_000, retry: false });
  const h = q.data;
  if (!h?.override) return null;
  const clear = async () => {
    try { await projectApi.setHealth(projectId, { health: null }); toast('Back to the calculated status.', 'success'); for (const k of ['project', 'projects', 'portfolio']) void invalidateWorkspace(wid, k); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not clear it.', 'error'); }
  };
  return (
    <div className={`ph-banner ${TONE[h.override] ?? ''}`} role="status">
      <b>{LABEL[h.override]}</b>
      <span>{h.note}{h.setBy ? ` — ${h.setBy.name}` : ''}{h.until ? ` · until ${dayMonth(h.until)}` : ''}{h.calculated !== h.override ? ` · calculated: ${LABEL[h.calculated] ?? h.calculated}` : ''}</span>
      {canEdit && <><button type="button" className="link-btn" onClick={onEdit}>Change</button><button type="button" className="link-btn" onClick={() => void clear()}>Clear</button></>}
    </div>
  );
}

/** Set the status by hand: On track, At risk or Late, why (required), and until when (optional). */
export function HealthSheet({ projectId, projectName, initial, onClose }: { projectId: string; projectName: string; initial?: H; onClose: () => void }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['project', projectId, 'health'], () => projectApi.health(projectId), { staleTime: 30_000, retry: false });
  const [health, setHealth] = useState<H>(initial ?? ((q.data?.override as H) || 'AtRisk'));
  const [note, setNote] = useState(q.data?.note ?? '');
  const [until, setUntil] = useState(q.data?.until ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await projectApi.setHealth(projectId, { health, note: note.trim(), until: until || null });
      for (const k of ['project', 'projects', 'portfolio', 'insights']) void invalidateWorkspace(wid, k);
      toast(`${projectName} is now ${LABEL[health].toLowerCase()}.`, 'success'); onClose();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not set it.', 'error'); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Set the status" subtitle={`${projectName} · calculated: ${LABEL[q.data?.calculated ?? ''] ?? '…'}`} size="sm" onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !note.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Set status'}</button></>}>
      <div className="ph-seg" role="radiogroup" aria-label="Status">
        {(['OnTrack', 'AtRisk', 'Delayed'] as H[]).map((k) => <button key={k} type="button" role="radio" aria-checked={health === k} className={`${TONE[k]}${health === k ? ' on' : ''}`} onClick={() => setHealth(k)}>{LABEL[k]}</button>)}
      </div>
      <label className="ph-field">Why<textarea rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Bureau sandbox keys not shared yet; UAT cannot start" /></label>
      <label className="ph-field">Until (optional)<input type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></label>
      <p className="ph-hint">Shown instead of the calculated status everywhere — Projects, Portfolio, Present and Insights — until this date or until it is cleared.</p>
    </Modal>
  );
}
