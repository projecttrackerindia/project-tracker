import { useState } from 'react';
import { del, get, post } from '../../api/client';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/ui';
import { formatDate, todayISO } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import './plannedLeave.css';

interface Leave { id: string; userId: string; date: string; note: string | null; status: string }
export function PlannedLeavePanel({ userId, name, from, to, dates, onSaved }: { userId: string; name: string; from: string; to: string; dates: Set<string> | null; onSaved?: (date: string) => void }) {
  const wid = useWorkspaceId();
  const me = useAuth(s => s.ctx?.user.id);
  const role = useAuth(s => s.ctx?.current?.role);
  const levels = useAuth(s => s.ctx?.current?.modules);
  const canWrite = role !== 'Guest' && Math.max(levels?.tasks ?? 0, levels?.work ?? 0) >= 2;
  const q = useWsQuery(['timesheet', 'leave', userId, from, to], () => get<Leave[]>(`/time/leave?${new URLSearchParams({ userId, from, to })}`));
  const [form, setForm] = useState(false), [review, setReview] = useState(false), [busy, setBusy] = useState(false);
  const [start, setStart] = useState(todayISO()), [end, setEnd] = useState(todayISO()), [note, setNote] = useState('');
  const [cancel, setCancel] = useState<Leave | null>(null), [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const valid = start >= todayISO() && end >= start && (new Date(end).getTime() - new Date(start).getTime()) / 86400000 <= 30;
  const rows = q.data?.filter(l => !dates || dates.has(l.date)) ?? [];
  const changed = () => { setReview(false); setRequestId(crypto.randomUUID()); setError(null); };
  const save = async () => {
    if (!valid || busy) return;
    setBusy(true); setError(null);
    try { await post('/time/leave', { userIds: [userId], from: start, to: end, note: note.trim() || null, requestId }); await q.refetch(); setForm(false); setReview(false); onSaved?.(start); }
    catch (e) { setError(e instanceof Error ? e.message : 'Leave could not be saved.'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!cancel || busy) return; setBusy(true); setError(null);
    try { await del(`/time/leave/${cancel.id}`); await q.refetch(); setCancel(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Leave could not be cancelled.'); }
    finally { setBusy(false); }
  };
  // Remounting on workspace/person change prevents submitting one person's form to another.
  return <section className="card planned-leave" data-workspace={wid} aria-labelledby="planned-leave-heading">
    <header className="card-head"><div><span className="leave-eyebrow">Availability</span><h3 id="planned-leave-heading">Planned leave</h3><p>Visible in your timesheet. HR approval remains separate; leave adds no worked or billable hours.</p></div>{canWrite && <button className="btn btn-soft" onClick={() => { setForm(true); setReview(false); setError(null); setRequestId(crypto.randomUUID()); }}><Icon name="plus" size={16}/>Plan leave</button>}</header>
    <div className="card-body">
      {q.isLoading ? <p role="status">Loading planned leave…</p> : q.isError ? <div role="alert"><p>{q.error.message}</p><button className="btn" onClick={() => void q.refetch()}>Try again</button></div> : rows.length ? <ul className="leave-list">{rows.map(l => <li key={l.id}><span className="leave-day"><Icon name="calendar" size={17}/><strong>{formatDate(l.date)}</strong></span><div><span className="leave-status">Planned</span>{l.note && <p>{l.note}</p>}</div>{canWrite && <button className="btn btn-ghost btn-sm" aria-label={`Cancel leave on ${formatDate(l.date)}`} onClick={() => { setCancel(l); setError(null); }}>Cancel</button>}</li>)}</ul> : <p className="muted">No planned leave in this date range.</p>}
    </div>
    {form && <Modal title={review ? 'Confirm planned leave' : 'Plan leave'} subtitle={`${name}${userId === me ? ' (you)' : ''}`} onClose={() => { if (!busy) { setForm(false); setReview(false); } }} footer={<><button className="btn btn-ghost" disabled={busy} onClick={() => review ? setReview(false) : setForm(false)}>{review ? 'Edit' : 'Cancel'}</button><button className="btn btn-primary" disabled={busy || !valid} onClick={() => review ? void save() : setReview(true)}>{busy ? 'Saving…' : review ? 'Confirm planned leave' : 'Review leave'}</button></>}>
      {review ? <div className="leave-review"><Icon name="calendar" size={28}/><strong>{formatDate(start)} – {formatDate(end)}</strong><p>{note || 'No note added.'}</p><p>This records planned absence for {name}. It does not approve an HR request or notify anyone by email.</p></div> : <div className="leave-fields"><label htmlFor="leave-from">First day<input id="leave-from" className="input" type="date" min={todayISO()} value={start} onChange={e => { setStart(e.target.value); changed(); }}/></label><label htmlFor="leave-to">Last day<input id="leave-to" className="input" type="date" min={start} value={end} onChange={e => { setEnd(e.target.value); changed(); }}/></label><label htmlFor="leave-note">Note (optional)<textarea id="leave-note" className="textarea" maxLength={1000} value={note} onChange={e => { setNote(e.target.value); changed(); }} placeholder="Add a handover or leave note"/></label><p className="muted">Choose up to 31 consecutive days. Submitted or approved weeks cannot be changed.</p></div>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </Modal>}
    {cancel && <Modal title="Cancel planned leave?" onClose={() => { if (!busy) setCancel(null); }} footer={<><button className="btn btn-ghost" disabled={busy} onClick={() => setCancel(null)}>Keep leave</button><button className="btn btn-primary" disabled={busy} onClick={() => void remove()}>Confirm cancellation</button></>}><p>{name} · {formatDate(cancel.date)}</p>{error && <p role="alert">{error}</p>}</Modal>}
  </section>;
}
