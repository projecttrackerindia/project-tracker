import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { timeApi } from '../../api/endpoints';
import type { ApprovalRow, TimesheetStatus, TimesheetWeek } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Avatar, EmptyState, ErrorState, Modal, PageLoader, StatCard } from '../../components/ui';
import { dateOffset, formatDateTime, timeAgo, toISODate } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { formatMinutes } from './time';

/** Monday of the week containing the ISO date (or today). */
export function mondayOf(iso?: string) {
  const d = iso ? new Date(`${iso}T00:00:00`) : new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toISODate(d);
}
export const addDaysIso = (iso: string, days: number) => dateOffset(days, new Date(`${iso}T00:00:00`));

/** "22 – 28 Sep 2026" (or across months, "29 Sep – 5 Oct 2026"). */
export function weekLabel(monday: string) {
  const a = new Date(`${monday}T00:00:00`), b = new Date(`${addDaysIso(monday, 6)}T00:00:00`);
  const month = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' });
  return a.getMonth() === b.getMonth()
    ? `${a.getDate()} – ${b.getDate()} ${month(b)} ${b.getFullYear()}`
    : `${a.getDate()} ${month(a)} – ${b.getDate()} ${month(b)} ${b.getFullYear()}`;
}

const STATUS: Record<TimesheetStatus, { label: string; tone: string; icon: 'clock' | 'checkCircle' | 'alert' | 'edit' }> = {
  NotSubmitted: { label: 'Not submitted', tone: 'draft', icon: 'edit' },
  Submitted: { label: 'Waiting for approval', tone: 'pending', icon: 'clock' },
  Approved: { label: 'Approved', tone: 'approved', icon: 'checkCircle' },
  Rejected: { label: 'Returned', tone: 'returned', icon: 'alert' },
};

export function TimesheetStatusChip({ status }: { status: TimesheetStatus }) {
  const s = STATUS[status];
  return <span className={`ts-chip ${s.tone}`}><Icon name={s.icon} size={13} />{s.label}</span>;
}

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);

/** Asks for the reason a week is being returned (required) or an optional remark when approving / submitting. */
function NoteModal({ title, subtitle, label, required, confirm, danger, onClose, onConfirm }: {
  title: string; subtitle?: string; label: string; required?: boolean; confirm: string; danger?: boolean; onClose: () => void; onConfirm: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (required && !note.trim()) return setError('Say what needs to change, so they know what to fix.');
    setBusy(true); setError(null);
    try { await onConfirm(note.trim()); onClose(); } catch (e) { setError(errText(e, 'Something went wrong. Please try again.')); } finally { setBusy(false); }
  };
  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose} onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="submit" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy}>{confirm}</button></>}>
      <div className="field">
        <label htmlFor="ts-note">{label}{required && <span className="req"> *</span>}</label>
        <textarea id="ts-note" className="input" rows={3} maxLength={500} autoFocus value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
    </Modal>
  );
}

/**
 * The approval state of one week on the timesheet: submit it (yours), withdraw a pending one, or - as the person's manager - approve or
 * return it. A submitted or approved week is locked.
 */
export function WeekApprovalBar({ weekStart, userId }: { weekStart: string; userId?: string }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['timesheet', 'week', weekStart, userId ?? ''], () => timeApi.week(weekStart, userId || undefined));
  const [asking, setAsking] = useState<'submit' | 'approve' | 'reject' | null>(null);
  const [busy, setBusy] = useState(false);
  const w = q.data;
  if (!w) return null;
  const refresh = () => { void invalidateWorkspace(wid, 'timesheet'); void invalidateWorkspace(wid, 'approvals'); };
  const act = async (fn: () => Promise<TimesheetWeek>, ok: string) => { await fn(); toast(ok); refresh(); };
  const withdraw = async () => {
    setBusy(true);
    try { await act(() => timeApi.withdrawWeek(w.weekStart), 'Submission withdrawn. You can change this week again.'); }
    catch (e) { toast(errText(e, 'Could not withdraw.'), 'error'); } finally { setBusy(false); }
  };
  const mine = !userId;
  const s = STATUS[w.status];
  return (
    <div className={`ts-week ${s.tone}`}>
      <div className="ts-week-icon"><Icon name={w.locked ? 'lock' : s.icon} size={18} /></div>
      <div className="ts-week-main">
        <div className="ts-week-title"><b>Week of {weekLabel(w.weekStart)}</b><TimesheetStatusChip status={w.status} /></div>
        <div className="ts-week-sub">
          {formatMinutes(w.totalMinutes)} logged · {formatMinutes(w.billableMinutes)} billable
          {w.status === 'Submitted' && w.submittedAt && <> · sent {timeAgo(w.submittedAt)}</>}
          {w.status === 'Approved' && w.reviewer && <> · approved by {w.reviewer.name} {timeAgo(w.reviewedAt)}</>}
          {w.status === 'Rejected' && w.reviewer && <> · returned by {w.reviewer.name} {timeAgo(w.reviewedAt)}</>}
        </div>
        {w.status === 'Rejected' && w.reviewNote && <div className="ts-week-note"><Icon name="message" size={13} /> “{w.reviewNote}”</div>}
        {w.status !== 'Rejected' && w.note && <div className="ts-week-note"><Icon name="note" size={13} /> {w.note}</div>}
        {w.locked && mine && <div className="ts-week-lock">Locked: time in this week cannot change{w.status === 'Submitted' ? ' unless you withdraw it' : ''}.</div>}
        {!w.entitled && mine && <div className="ts-week-lock">Timesheet approval comes with the Business plan.</div>}
      </div>
      <div className="ts-week-actions">
        {w.canSubmit && <button type="button" className="btn btn-primary btn-sm" onClick={() => setAsking('submit')}><Icon name="send" size={14} /> {w.status === 'Rejected' ? 'Submit again' : 'Submit for approval'}</button>}
        {w.canWithdraw && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void withdraw()}><Icon name="undo" size={14} /> Withdraw</button>}
        {w.canReview && w.status === 'Submitted' && <button type="button" className="btn btn-primary btn-sm" onClick={() => setAsking('approve')}><Icon name="tick" size={14} /> Approve</button>}
        {w.canReview && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAsking('reject')}><Icon name="undo" size={14} /> {w.status === 'Approved' ? 'Reopen' : 'Return'}</button>}
      </div>

      {asking === 'submit' && (
        <NoteModal title="Submit this week for approval?" subtitle={`${weekLabel(w.weekStart)} · ${formatMinutes(w.totalMinutes)} logged. The week is locked while it is reviewed.`}
          label="Note for your manager (optional)" confirm="Submit" onClose={() => setAsking(null)}
          onConfirm={(note) => act(() => timeApi.submitWeek(w.weekStart, note), 'Submitted. Your manager has been told.')} />
      )}
      {asking === 'approve' && w.id && (
        <NoteModal title="Approve this week?" subtitle={`${weekLabel(w.weekStart)} · ${formatMinutes(w.totalMinutes)}`} label="Remark (optional)" confirm="Approve"
          onClose={() => setAsking(null)} onConfirm={(note) => act(() => timeApi.approve(w.id!, note), 'Approved.')} />
      )}
      {asking === 'reject' && w.id && (
        <NoteModal title={w.status === 'Approved' ? 'Reopen this week?' : 'Return this week?'} subtitle="It unlocks so it can be corrected and submitted again." label="What needs to change" required
          confirm={w.status === 'Approved' ? 'Reopen' : 'Return'} danger onClose={() => setAsking(null)} onConfirm={(note) => act(() => timeApi.reject(w.id!, note), 'Returned with your note.')} />
      )}
    </div>
  );
}

/** Timesheet → Approvals: everyone you review, for one week, and everything still waiting for you. */
export function ApprovalsPanel({ initialWeek }: { initialWeek?: string }) {
  const wid = useWorkspaceId();
  const [week, setWeek] = useState<string | undefined>(initialWeek ? mondayOf(initialWeek) : undefined);
  const q = useWsQuery(['approvals', week ?? ''], () => timeApi.approvals(week));
  const [asking, setAsking] = useState<{ row: ApprovalRow; kind: 'approve' | 'reject' } | null>(null);
  const [busy, setBusy] = useState(false);
  const me = useAuth((s) => s.ctx?.user.id);

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const d = q.data;
  const shown = d.weekStart;
  const refresh = () => { void invalidateWorkspace(wid, 'approvals'); void invalidateWorkspace(wid, 'timesheet'); };
  const waiting = d.week.filter((r) => r.status === 'Submitted');
  const otherWeeks = d.pending.filter((r) => r.weekStart !== shown);
  const thisMonday = mondayOf();

  const approveAll = async () => {
    setBusy(true);
    let done = 0;
    try { for (const r of waiting) { await timeApi.approve(r.id!); done++; } toast(`Approved ${done} timesheet${done === 1 ? '' : 's'}.`); }
    catch (e) { toast(errText(e, 'Some timesheets could not be approved.'), 'error'); }
    finally { setBusy(false); refresh(); }
  };

  const row = (r: ApprovalRow, withWeek = false) => (
    <tr key={`${r.user.id}:${r.weekStart}`}>
      <td><span className="row" style={{ gap: 8 }}><Avatar name={r.user.name} size="sm" /><b>{r.user.name}</b></span></td>
      {withWeek && <td className="cell-muted">{weekLabel(r.weekStart)}</td>}
      <td className="num">{formatMinutes(r.totalMinutes)}</td>
      <td className="num cell-muted">{formatMinutes(r.billableMinutes)}</td>
      <td><TimesheetStatusChip status={r.status} />{r.status === 'Rejected' && r.reviewNote && <div className="td-sub" title={r.reviewNote}>“{r.reviewNote}”</div>}{r.note && r.status === 'Submitted' && <div className="td-sub" title={r.note}>{r.note}</div>}</td>
      <td className="cell-muted">{r.submittedAt ? <span title={formatDateTime(r.submittedAt)}>{timeAgo(r.submittedAt)}</span> : '—'}</td>
      <td>
        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
          <Link className="btn btn-ghost btn-sm" to={`/timesheet?user=${r.user.id}&week=${r.weekStart}`} title="Open their timesheet for this week">View</Link>
          {d.entitled && r.id && r.status === 'Submitted' && r.user.id !== me && <button type="button" className="btn btn-primary btn-sm" onClick={() => setAsking({ row: r, kind: 'approve' })}>Approve</button>}
          {d.entitled && r.id && (r.status === 'Submitted' || r.status === 'Approved') && r.user.id !== me && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAsking({ row: r, kind: 'reject' })}>{r.status === 'Approved' ? 'Reopen' : 'Return'}</button>}
        </div>
      </td>
    </tr>
  );

  return (
    <>
      {!d.entitled && (
        <div className="callout mb-18"><Icon name="lock" size={16} /><div><b>Timesheet approval comes with the Business plan.</b> You can still see everyone's hours here; submitting and approving weeks needs the upgrade.</div></div>
      )}
      <div className="toolbar ts-weeknav" style={{ marginBottom: 16 }}>
        <button type="button" className="btn-icon" aria-label="Previous week" onClick={() => setWeek(addDaysIso(shown, -7))}><Icon name="chevronL" /></button>
        <b className="ts-weeknav-label">Week of {weekLabel(shown)}</b>
        <button type="button" className="btn-icon" aria-label="Next week" disabled={shown >= thisMonday} onClick={() => setWeek(addDaysIso(shown, 7))}><Icon name="chevronR" /></button>
        {shown !== addDaysIso(thisMonday, -7) && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setWeek(addDaysIso(thisMonday, -7))}>Last week</button>}
        {d.entitled && waiting.length > 1 && <button type="button" className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => void approveAll()}><Icon name="checks" size={14} /> Approve all {waiting.length}</button>}
      </div>

      <div className="stat-grid">
        <StatCard icon="clock" tone="amber" value={waiting.length} label="Waiting for you" />
        <StatCard icon="checkCircle" tone="green" value={d.week.filter((r) => r.status === 'Approved').length} label="Approved" />
        <StatCard icon="edit" tone="blue" value={d.week.filter((r) => r.status === 'NotSubmitted').length} label="Not submitted" />
        <StatCard icon="alert" tone="red" value={d.week.filter((r) => r.status === 'Rejected').length} label="Returned" />
        <StatCard icon="coin" tone="purple" value={formatMinutes(d.week.reduce((n, r) => n + r.billableMinutes, 0))} label="Billable this week" foot={`of ${formatMinutes(d.week.reduce((n, r) => n + r.totalMinutes, 0))} logged`} />
      </div>

      <div className="card mb-22">
        <div className="card-head"><div><h3>This week</h3><p>Everyone whose timesheet you review. Waiting ones come first.</p></div></div>
        {d.week.length === 0 ? <div className="card-body"><EmptyState icon="users" title="Nobody to review" text="People who report to you in the org chart appear here." /></div> : (
          <div className="table-wrap">
            <table className="ts-table">
              <thead><tr><th>Person</th><th className="num">Logged</th><th className="num">Billable</th><th>Status</th><th>Sent</th><th /></tr></thead>
              <tbody>{d.week.map((r) => row(r))}</tbody>
            </table>
          </div>
        )}
      </div>

      {otherWeeks.length > 0 && (
        <div className="card">
          <div className="card-head"><div><h3>Still waiting from other weeks</h3><p>Oldest first</p></div></div>
          <div className="table-wrap">
            <table className="ts-table">
              <thead><tr><th>Person</th><th>Week</th><th className="num">Logged</th><th className="num">Billable</th><th>Status</th><th>Sent</th><th /></tr></thead>
              <tbody>{otherWeeks.map((r) => row(r, true))}</tbody>
            </table>
          </div>
        </div>
      )}

      {asking?.kind === 'approve' && (
        <NoteModal title={`Approve ${asking.row.user.name}'s week?`} subtitle={`${weekLabel(asking.row.weekStart)} · ${formatMinutes(asking.row.totalMinutes)} logged`} label="Remark (optional)" confirm="Approve"
          onClose={() => setAsking(null)} onConfirm={async (note) => { await timeApi.approve(asking.row.id!, note); toast('Approved.'); refresh(); }} />
      )}
      {asking?.kind === 'reject' && (
        <NoteModal title={`${asking.row.status === 'Approved' ? 'Reopen' : 'Return'} ${asking.row.user.name}'s week?`} subtitle="It unlocks so it can be corrected and submitted again." label="What needs to change" required
          confirm={asking.row.status === 'Approved' ? 'Reopen' : 'Return'} danger onClose={() => setAsking(null)}
          onConfirm={async (note) => { await timeApi.reject(asking.row.id!, note); toast('Returned with your note.'); refresh(); }} />
      )}
    </>
  );
}
