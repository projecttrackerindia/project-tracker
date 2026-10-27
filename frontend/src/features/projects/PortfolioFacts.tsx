import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { actionItemApi, projectApi, statusApi, taskApi } from '../../api/endpoints';
import type { StatusTask } from '../../api/types';
import { Face } from '../../components/Face';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { dayMonth } from './projectParts';

const SHOWN = 5;
const isOpen = (t: StatusTask) => t.statusCategory !== 'Done' && t.statusCategory !== 'Cancelled';
/** Problems first: blocked, then most overdue, then most delayed, then nearest due. */
const rank = (a: StatusTask, b: StatusTask) =>
  (b.blockedBy.length > 0 ? 1 : 0) - (a.blockedBy.length > 0 ? 1 : 0) || b.overdueDays - a.overdueDays || b.delayedDays - a.delayedDays
  || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999');

/**
 * The right side of a project slide in Present: who leads it, when it started and is due (and how far it moved), how far along it is,
 * the open work that matters with who is on it, its dates and what it waits on, the latest date changes with their reasons — and what the
 * room can do on the spot: finish a task, add a remark to it, or agree a follow-up with an owner and a date. Every change is saved at once.
 */
export function ProjectFacts({ projectId, active }: { projectId: string; active: boolean }) {
  const wid = useWorkspaceId();
  const report = useWsQuery(['project-status', projectId], () => statusApi.report(projectId), { enabled: active, staleTime: 30_000, retry: false });
  const detail = useWsQuery(['projects', projectId], () => projectApi.get(projectId), { enabled: active, staleTime: 60_000, retry: false });
  const [remarkFor, setRemarkFor] = useState<string | null>(null);
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [follow, setFollow] = useState({ title: '', owner: '', due: '' });
  const tab = active ? 0 : -1;

  if (!active) return <aside className="pf-facts" aria-hidden="true" />;
  if (report.isLoading) return <aside className="pf-facts" aria-busy="true"><p className="pf-facts-wait">Loading the project…</p></aside>;
  if (!report.data) return <aside className="pf-facts"><p className="pf-facts-wait">The project details could not be loaded. <Link to={`/work/projects/${projectId}`} tabIndex={tab}>Open the project ›</Link></p></aside>;

  const { project: p, tasks, changes } = report.data;
  const open = tasks.filter((t) => isOpen(t) && !t.parentTaskId && !done.has(t.id)).sort(rank);
  const doneStatus = detail.data?.statuses.find((s) => s.category === 'Done') ?? null;
  const members = detail.data?.members ?? [];
  const refresh = () => { void report.refetch(); void invalidateWorkspace(wid, 'projects'); };
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); toast(ok, 'success'); refresh(); return true; }
    catch (e) { toast(e instanceof ApiError ? e.message : 'That could not be saved.', 'error'); return false; }
    finally { setBusy(null); }
  };
  const finish = async (t: StatusTask) => {
    if (!doneStatus) return;
    if (await run(`done:${t.id}`, () => taskApi.move(t.id, { statusId: doneStatus.id }), `${t.key} marked done.`)) setDone((s) => new Set(s).add(t.id));
  };
  const sendRemark = async (t: StatusTask) => {
    const body = remark.trim();
    if (!body) return;
    if (await run(`remark:${t.id}`, () => taskApi.addComment(t.id, { body: `Portfolio review: ${body}` }), `Remark added to ${t.key}.`)) { setRemark(''); setRemarkFor(null); }
  };
  const addFollowUp = async () => {
    if (!follow.title.trim()) return;
    if (await run('follow', () => actionItemApi.create(projectId, { title: follow.title.trim(), assigneeId: follow.owner || null, dueDate: follow.due || null, priority: 'High' }), 'Follow-up added to the project.'))
      setFollow({ title: '', owner: '', due: '' });
  };
  const moved = p.originalDueDate && p.dueDate && p.originalDueDate !== p.dueDate;
  const recent = changes.slice(0, 3);

  return (
    <aside className="pf-facts" aria-label={`${p.name} details`}>
      <dl className="pf-facts-grid">
        <div><dt>Lead</dt><dd>{p.owner ? <><Face byName name={p.owner.name} className="pf-own-av" />{p.owner.name}</> : <em>No lead</em>}</dd></div>
        <div><dt>Started</dt><dd>{p.startDate ? dayMonth(p.startDate) : <em>Not set</em>}</dd></div>
        <div><dt>Due</dt><dd>{p.dueDate ? dayMonth(p.dueDate) : <em>Not set</em>}{moved && <small> · was {dayMonth(p.originalDueDate)}</small>}</dd></div>
        <div><dt>Done</dt><dd><span className="pf-facts-bar" aria-hidden="true"><i style={{ width: `${Math.round(p.progress)}%` }} /></span>{Math.round(p.progress)}%</dd></div>
      </dl>

      <section aria-label="Open work">
        <h3>Open work <span>{open.length} open · {report.data.delayedTasks} delayed · {report.data.blockedTasks} blocked</span></h3>
        {open.length === 0 ? <p className="pf-facts-none">Nothing open.</p> : (
          <ul className="pf-facts-tasks">
            {open.slice(0, SHOWN).map((t) => (
              <li key={t.id}>
                <div className="pf-ft-top">
                  <Link to={`/work?item=${t.id}`} tabIndex={tab} title="Open the task"><b>{t.key}</b> {t.title}</Link>
                  <span className="pf-ft-acts">
                    {doneStatus && <button type="button" tabIndex={tab} className="pf-mini" disabled={busy !== null} onClick={() => void finish(t)} aria-label={`Mark ${t.key} done`}>{busy === `done:${t.id}` ? '…' : '✓ Done'}</button>}
                    <button type="button" tabIndex={tab} className="pf-mini" aria-expanded={remarkFor === t.id} onClick={() => { setRemarkFor(remarkFor === t.id ? null : t.id); setRemark(''); }}>Remark</button>
                  </span>
                </div>
                <div className="pf-ft-meta">
                  <span>{t.assignee ? t.assignee.name : <em>Unassigned</em>}</span>
                  <span>{t.startDate ? dayMonth(t.startDate) : '—'} → {t.dueDate ? dayMonth(t.dueDate) : 'no date'}</span>
                  <span className="pf-ft-st" style={{ color: t.statusColor }}>{t.statusName}</span>
                  {t.overdueDays > 0 && <span className="late">{t.overdueDays}d overdue</span>}
                  {t.overdueDays === 0 && t.delayedDays > 0 && <span className="risk">moved {t.delayedDays}d</span>}
                </div>
                {t.blockedBy.length > 0 && <p className="pf-ft-dep">Waiting on {t.blockedBy.map((b) => `${b.key} ${b.title} (${b.statusName})`).join(', ')}</p>}
                {remarkFor === t.id && (
                  <form className="pf-ft-remark" onSubmit={(e) => { e.preventDefault(); void sendRemark(t); }}>
                    <input autoFocus tabIndex={tab} value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="What was agreed — saved as a comment on the task" aria-label={`Remark on ${t.key}`}
                      onKeyDown={(e) => e.stopPropagation()} />
                    <button type="submit" tabIndex={tab} className="pf-mini pri" disabled={!remark.trim() || busy !== null}>Save</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        {open.length > SHOWN && <Link className="pf-facts-more" tabIndex={tab} to={`/work/projects/${projectId}?tab=status`}>All {open.length} open items ›</Link>}
      </section>

      {recent.length > 0 && (
        <section aria-label="Date changes">
          <h3>Date changes</h3>
          <ul className="pf-facts-changes">
            {recent.map((c) => (
              <li key={c.id}><b>{c.taskKey ?? 'Project'}</b> {c.previous ? dayMonth(c.previous) : '—'} → {c.revised ? dayMonth(c.revised) : '—'}
                {c.reason && <> · {c.reason}</>}{c.dependency && <> · waits on {c.dependency}</>}{c.changedBy && <small> — {c.changedBy.name}</small>}</li>
            ))}
          </ul>
        </section>
      )}

      <form className="pf-follow" aria-label="Add a follow-up" onSubmit={(e) => { e.preventDefault(); void addFollowUp(); }}>
        <h3>Agree a follow-up</h3>
        <input tabIndex={tab} value={follow.title} onChange={(e) => setFollow((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Confirm the bank sandbox date" aria-label="Follow-up" onKeyDown={(e) => e.stopPropagation()} />
        <div className="pf-follow-row">
          <select tabIndex={tab} value={follow.owner} onChange={(e) => setFollow((f) => ({ ...f, owner: e.target.value }))} aria-label="Owner">
            <option value="">Owner…</option>
            {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
          </select>
          <input tabIndex={tab} type="date" value={follow.due} onChange={(e) => setFollow((f) => ({ ...f, due: e.target.value }))} aria-label="Due date" onKeyDown={(e) => e.stopPropagation()} />
          <button type="submit" tabIndex={tab} className="pf-mini pri" disabled={!follow.title.trim() || busy !== null}>{busy === 'follow' ? 'Adding…' : 'Add'}</button>
        </div>
      </form>
    </aside>
  );
}
