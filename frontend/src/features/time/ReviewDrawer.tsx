import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { timeApi } from '../../api/endpoints';
import type { TimesheetIssue, TimesheetReview, TimesheetTarget } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Sheet } from '../../components/Sheet';
import { Term } from '../../components/Term';
import { SidePanel } from '../../components/v2/SidePanel';
import { ErrorState, PageLoader } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useIsMobile } from '../../lib/mobile';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { formatMinutes } from './time';
import './reviewDrawer.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);

/** The week's review (GET /time/review), cached with the rest of the time data. */
export function useTimesheetReview(week: string, enabled = true) {
  return useWsQuery(['time', 'review', week], () => timeApi.review(week), { enabled, staleTime: 15_000 });
}

/**
 * "40h = your weekly capacity, set by … in People": the target with where it comes from, as a small button whose popover explains it and links
 * to the person's capacity in People.
 */
export function TargetExplain({ target, label }: { target: TimesheetTarget | undefined; label: string }) {
  const [open, setOpen] = useState(false);
  const me = useAuth((s) => s.ctx?.user.id);
  if (!target) return <span>{label}</span>;
  return (
    <span className="trv-target">
      <button type="button" className="trv-target-btn" aria-expanded={open} title={target.explanation} onClick={() => setOpen((o) => !o)} data-testid="target-explain">
        {label}<Icon name="info" size={12} />
      </button>
      {open && (
        <span className="trv-pop" role="dialog" aria-label="Where the target comes from">
          <b>{formatMinutes(target.targetMinutes)} expected this week</b>
          <span>{target.explanation}</span>
          <span className="trv-pop-row"><Term k="target">How the target works</Term>{me && <Link to={`/people/${me}`}>Capacity in People ›</Link>}</span>
        </span>
      )}
    </span>
  );
}

const GROUP: Record<string, string> = { error: 'Must fix before submitting', warning: 'Check before submitting' };

/**
 * The pre-submit review: the target explained, then what to fix (errors block Submit) and what to check (warnings: Submit once acknowledged),
 * each with its own fix. A side drawer on a desk, a bottom sheet on a phone.
 */
export function ReviewDrawer({ week, onClose, onLog, onSubmitted }: { week: string; onClose: () => void; onLog: (date: string | null) => void; onSubmitted: () => void }) {
  const phone = useIsMobile();
  const wid = useWorkspaceId();
  const nav = useNavigate();
  const q = useTimesheetReview(week);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [noting, setNoting] = useState<{ id: string; text: string } | null>(null);
  const r = q.data;
  const refresh = () => { void invalidateWorkspace(wid, 'time'); void q.refetch(); };

  const fix = async (i: TimesheetIssue) => {
    const key = `${i.code}:${i.entryId ?? i.date}`;
    if (i.fix === 'log') { onLog(i.date); return; }
    if ((i.fix === 'open' || i.fix === 'link') && i.href) { onClose(); nav(i.href); return; }
    if (i.fix === 'note' && i.entryId) { setNoting({ id: i.entryId, text: i.note ?? '' }); return; }
    setBusy(key);
    try {
      if (i.fix === 'billable' && i.entryId && i.date) { await timeApi.update(i.entryId, { minutes: i.minutes ?? 0, workDate: i.date, note: i.note ?? null, billable: true }); toast('Marked billable.'); }
      if (i.fix === 'stop') { await timeApi.stop(); toast('Timer stopped.'); }
      refresh();
    } catch (e) { toast(errText(e, 'Could not fix that here.'), 'error'); }
    finally { setBusy(null); }
  };
  const saveNote = async (i: TimesheetIssue) => {
    if (!noting || !noting.text.trim() || !i.date) return;
    setBusy(`note:${i.entryId}`);
    try { await timeApi.update(noting.id, { minutes: i.minutes ?? 0, workDate: i.date, note: noting.text.trim() }); setNoting(null); toast('Comment added.'); refresh(); }
    catch (e) { toast(errText(e, 'Could not add the comment.'), 'error'); }
    finally { setBusy(null); }
  };
  const submit = async () => {
    setBusy('submit');
    try { await timeApi.submitWeek(week); toast('Week submitted for approval.'); void invalidateWorkspace(wid, 'inbox'); onSubmitted(); }
    catch (e) { toast(errText(e, 'Could not submit the week.'), 'error'); refresh(); }
    finally { setBusy(null); }
  };

  const body = q.isLoading ? <PageLoader /> : q.isError || !r?.target ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : (
    <div className="trv" data-testid="review-drawer">
      <section className="trv-sum">
        <div className="trv-big"><b>{formatMinutes(r.totalMinutes)}</b><span>of {formatMinutes(r.target.targetMinutes)} <Term k="target">target</Term></span></div>
        <p className="trv-why">{r.target.explanation}</p>
      </section>
      {r.issues.length === 0 ? (
        <p className="trv-clean"><Icon name="checkCircle" size={18} /> Everything checks out. Ready to submit.</p>
      ) : (['error', 'warning'] as const).map((sev) => {
        const list = r.issues.filter((i) => i.severity === sev);
        if (list.length === 0) return null;
        return (
          <section key={sev} className={`trv-group ${sev}`} aria-label={GROUP[sev]}>
            <h3>{GROUP[sev]} <em>{list.length}</em></h3>
            <ul>
              {list.map((i, n) => {
                const key = `${i.code}:${i.entryId ?? i.date}`;
                const editing = i.fix === 'note' && noting?.id === i.entryId;
                return (
                  <li key={`${key}:${n}`} className="trv-issue" data-testid={`issue-${i.code}`}>
                    <span className={`trv-dot ${sev}`} aria-hidden="true" />
                    <div className="trv-issue-main">
                      <span>{i.message}</span>
                      {editing && (
                        <form className="trv-note" onSubmit={(e) => { e.preventDefault(); void saveNote(i); }}>
                          <input className="input" autoFocus aria-label="Comment" placeholder="What was done" value={noting!.text} onChange={(e) => setNoting({ id: noting!.id, text: e.target.value })} />
                          <button type="submit" className="btn btn-primary btn-sm" disabled={!noting!.text.trim() || busy === `note:${i.entryId}`}>Save</button>
                        </form>
                      )}
                    </div>
                    {!editing && <button type="button" className="btn btn-soft btn-sm trv-fix" disabled={busy === key} onClick={() => void fix(i)}>{i.fixLabel}</button>}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );

  const foot = r?.target && (
    <div className="trv-foot">
      {r.errors > 0 ? <span className="trv-block"><Icon name="lock" size={14} /> Fix {r.errors} issue{r.errors === 1 ? '' : 's'} above to submit.</span>
        : r.warnings > 0 ? (
          <label className="trv-ack"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="review-ack" /> I checked {r.warnings === 1 ? 'this warning' : `these ${r.warnings} warnings`}; submit anyway.</label>
        ) : <span className="trv-ok">No issues.</span>}
      <button type="button" className="btn btn-primary trv-submit" data-testid="review-submit"
        disabled={busy === 'submit' || !r.canSubmit || r.errors > 0 || (r.warnings > 0 && !ack)} onClick={() => void submit()}>Submit week</button>
    </div>
  );

  if (phone) return <Sheet title="Review your week" onClose={onClose} footer={foot}>{body}</Sheet>;
  return (
    <SidePanel title="Review your week" eyebrow={`Week of ${week}`} width={480} onClose={onClose} label="Review your week">
      {body}
      {foot}
    </SidePanel>
  );
}

export type { TimesheetReview };
