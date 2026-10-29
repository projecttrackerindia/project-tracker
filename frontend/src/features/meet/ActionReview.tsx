import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { meetingApi } from '../../api/endpoints';
import { Avatar, ErrorState, PageLoader } from '../../components/ui';
import { useIsSmallPhone } from '../../lib/mobile';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { refreshWork } from '../work/workUi';
import { connectApi, type Minutes, type MinutesLine, type Review, type ReviewDecisionKind, type ReviewItem } from './meetApi';
import { stateChip, stateText } from './MyActionItems';
import './connect.css';

type Scope = 'series' | 'all' | 'mine';
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const dm = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
const dmw = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const dOnly = (d: string | null | undefined) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
const dOnlyW = (d: string | null | undefined) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
const isoDay = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const plusDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const first = (n?: string | null) => (n ?? '').split(' ')[0];

const KEYS: { k: string; label: string }[] = [{ k: 'D', label: 'done' }, { k: 'C', label: 'carry over' }, { k: 'R', label: 'change owner/date' }, { k: 'T', label: 'convert to task' }, { k: 'X', label: 'drop' }, { k: 'U', label: 'undo' }];
const DECIDED_LABEL: Record<ReviewDecisionKind, string> = { done: 'Marked done', carry: 'Carried over', replan: 'Re-planned', convert: 'Made a task', drop: 'Dropped' };
const REPLAN_REASONS = ['Owner changed', 'Waiting on external', 'Scope changed'];
const DROP_REASONS = ['No longer needed', 'Replaced', 'Duplicate'];

/**
 * Review action items (design: review, review-pop, review-summary, review-phone): the series' items since its last session - work items
 * whose source is this meeting - grouped by owner, with one-key decisions (J/K, D, C, R, T, X, U), the minutes drafting live beside them,
 * and Finish & write minutes. On a phone, one card at a time with big buttons; swipe right for Done, left to carry over.
 */
export function ActionReview({ seriesRef, at }: { seriesRef: string | null; at: string | null }) {
  const wid = useWorkspaceId();
  const nav = useNavigate();
  const phone = useIsSmallPhone();
  const [scope, setScope] = useState<Scope>(seriesRef ? 'series' : 'all');
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cursor, setCursor] = useState(0);
  const [pop, setPop] = useState<{ kind: 'replan' | 'drop' | 'carry'; item: ReviewItem } | null>(null);
  const [minutes, setMinutes] = useState<Minutes | null>(null);
  const [busy, setBusy] = useState(false);
  const opened = useRef(false);

  const load = useCallback(async (s: Scope) => {
    setError(null);
    try { setReview(await connectApi.openReview({ scope: s, seriesRef: s === 'series' ? seriesRef : null, occurrence: s === 'series' ? at : null })); }
    catch (e) { setError(e); }
  }, [seriesRef, at]);
  useEffect(() => { if (!opened.current) { opened.current = true; void load(scope); } }, [load, scope]);
  const switchScope = (s: Scope) => { setScope(s); setReview(null); setCursor(0); setMinutes(null); void load(s); };

  // Items grouped by owner (no owner, or no source, go last), in the order the keys walk them.
  const groups = useMemo(() => {
    const m = new Map<string, { owner: ReviewItem['owner']; items: ReviewItem[] }>();
    for (const i of review?.items ?? []) {
      const k = i.owner?.id ?? 'nobody';
      if (!m.has(k)) m.set(k, { owner: i.owner, items: [] });
      m.get(k)!.items.push(i);
    }
    return [...m.values()].sort((a, b) => (a.owner ? 0 : 1) - (b.owner ? 0 : 1) || (a.owner?.name ?? '').localeCompare(b.owner?.name ?? ''));
  }, [review]);
  const flat = groups.flatMap((g) => g.items);
  const current = flat[Math.min(cursor, Math.max(0, flat.length - 1))] ?? null;
  const people = useWsQuery(['meetings', 'participants', current?.projectId ?? 'none'], () => meetingApi.participants(current!.projectId!), { enabled: !!current?.projectId, staleTime: 60_000 });

  const after = (r: Review) => { setReview(r); void invalidateWorkspace(wid, 'meet'); refreshWork(wid); };
  const next = () => setCursor((c) => Math.min(c + 1, Math.max(0, flat.length - 1)));
  const decide = async (item: ReviewItem, decision: ReviewDecisionKind, extra: { reason?: string; ownerId?: string; dueDate?: string } = {}) => {
    if (!review?.sessionId || busy) return;
    if (review.sent) { toast('The minutes were sent; this review is closed.', 'warning'); return; }
    if (decision === 'carry' && !review.nextSession && !extra.dueDate) { setPop({ kind: 'carry', item }); return; }
    setBusy(true);
    try {
      after(await connectApi.decide(review.sessionId, { workItemId: item.id, decision, ...extra }));
      setPop(null);
      toast(decision === 'done' ? `Done: ${item.title}` : decision === 'carry' ? `Carried to ${extra.dueDate ? dOnly(extra.dueDate) : dm(review.nextSession)}` : decision === 'convert' ? 'Made into a project task.' : decision === 'drop' ? 'Dropped.' : 'Re-planned.');
      next();
    } catch (e) { toast(errText(e, 'That did not work.'), 'error'); }
    finally { setBusy(false); }
  };
  const undo = async () => {
    if (!review?.sessionId || busy) return;
    setBusy(true);
    try { after(await connectApi.undo(review.sessionId)); toast('Undone.'); }
    catch (e) { toast(errText(e, 'Nothing to undo.'), 'error'); }
    finally { setBusy(false); }
  };
  const finish = async () => {
    if (!review?.sessionId) return;
    setBusy(true);
    try { setMinutes(await connectApi.finish(review.sessionId)); }
    catch (e) { toast(errText(e, 'Could not write the minutes.'), 'error'); }
    finally { setBusy(false); }
  };
  const nudge = async (item: ReviewItem) => {
    try { await connectApi.nudge(item.id); toast(`Asked ${first(item.owner?.name)} for an update.`); }
    catch (e) { toast(errText(e, 'Could not nudge.'), 'error'); }
  };

  // One key per decision, then on to the next item.
  useEffect(() => {
    if (minutes || phone) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (pop || e.metaKey || e.ctrlKey || e.altKey || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) || t?.isContentEditable) return;
      const k = e.key.toLowerCase();
      if (k === 'j') { e.preventDefault(); next(); return; }
      if (k === 'k') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); return; }
      if (k === 'u') { e.preventDefault(); void undo(); return; }
      if (!current) return;
      if (k === 'd') { e.preventDefault(); void decide(current, 'done'); }
      else if (k === 'c') { e.preventDefault(); void decide(current, 'carry'); }
      else if (k === 'r') { e.preventDefault(); setPop({ kind: 'replan', item: current }); }
      else if (k === 't') { e.preventDefault(); void decide(current, 'convert'); }
      else if (k === 'x') { e.preventDefault(); setPop({ kind: 'drop', item: current }); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  useEffect(() => { document.querySelector(`[data-review-row="${current?.id}"]`)?.scrollIntoView({ block: 'nearest' }); }, [current?.id]);

  if (error) return <div className="ar"><ErrorState error={error} retry={() => void load(scope)} /></div>;
  if (!review) return <div className="ar"><PageLoader /></div>;
  if (minutes) return <MinutesView review={review} minutes={minutes} onBack={() => setMinutes(null)} onSent={(m) => { setMinutes(m); void load(scope); }} />;

  const c = review.counts;
  const pct = c.total ? Math.round((c.reviewed / c.total) * 100) : 0;
  const crumbs = (
    <nav className="rv-crumbs" aria-label="Breadcrumb">
      <Link to="/meetings">Meetings</Link><span>›</span>
      {review.seriesRef ? <Link to={`/meetings?open=${encodeURIComponent(review.seriesRef)}`}>{review.title}</Link> : <span>{review.title}</span>}
      {review.occurrence && review.scope === 'series' && <><span>›</span><span>{dmw(review.occurrence)}</span></>}
    </nav>
  );

  if (phone) return (
    <PhoneReview review={review} item={current} index={flat.findIndex((x) => x.id === current?.id)} total={flat.length} busy={busy}
      onBack={() => nav(-1)} onDecide={(d) => (d === 'replan' || d === 'drop' ? current && setPop({ kind: d, item: current }) : current && void decide(current, d))}
      onNext={next} onFinish={() => void finish()} pop={pop} onClosePop={() => setPop(null)}
      people={(people.data ?? []).filter((p) => p.userId).map((p) => ({ id: p.userId!, name: p.name }))} onSubmitPop={(item, d, x) => void decide(item, d, x)} />
  );

  const noUpdate = flat.filter((i) => i.noUpdate && !i.decision).length;
  return (
    <div className="ar" data-testid="action-review">
      {crumbs}
      <header className="rv-head">
        <div>
          <h1>Review action items</h1>
          <p>{review.scope === 'series' ? <>Since last meeting{review.previousSession ? ` on ${dm(review.previousSession)}` : ''} · <span className={`rv-cad c-${review.cadence.toLowerCase().replace(' ', '')}`}>{review.cadence}</span> · {review.attendees} attendees</>
            : review.scope === 'all' ? 'Open action items in every project you can see' : 'Your open action items from every meeting'}</p>
        </div>
        <div className="rv-head-acts">
          <div className="ms-seg" role="radiogroup" aria-label="Scope">
            {([['series', 'This series'], ['all', 'All projects'], ['mine', 'My items']] as const).filter(([k]) => k !== 'series' || seriesRef).map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={scope === k} className={scope === k ? 'on' : ''} onClick={() => switchScope(k)}>{l}</button>
            ))}
          </div>
          <button type="button" className="btn btn-primary rv-finish" disabled={busy} onClick={() => void finish()}>Finish &amp; write minutes</button>
        </div>
      </header>

      <section className="rv-progress" aria-label="Progress">
        <div className="rv-progress-top">
          <b data-testid="review-progress">{c.reviewed} of {c.total} reviewed</b>
          <div className="rv-counts">
            <span className="rv-chip done">{c.done} done</span><span className="rv-chip blue">{c.inProgress} in progress</span>
            <span className="rv-chip late">{c.overdue} overdue</span><span className="rv-chip late">{c.blocked} blocked</span><span className="rv-chip quiet">{c.noUpdate} no update</span>
          </div>
        </div>
        <div className="rv-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Reviewed"><i style={{ width: `${pct}%` }} /></div>
        <div className="rv-keys" aria-label="Keys">
          <span><kbd>J</kbd><kbd>K</kbd> next / previous</span>
          {KEYS.map((k) => <span key={k.k}><kbd>{k.k}</kbd> {k.label}</span>)}
        </div>
      </section>

      <div className="rv-body">
        <div className="rv-list">
          {flat.length === 0 && <p className="rv-empty">No open action items {review.scope === 'series' ? 'from this series' : 'to review'}. Capture them during the meeting with one line.</p>}
          {groups.map((g) => (
            <section key={g.owner?.id ?? 'nobody'} className="rv-grp" aria-label={g.owner?.name ?? 'No owner'}>
              <h2>{g.owner ? <Avatar name={g.owner.name} userId={g.owner.id} size="sm" /> : null}{g.owner?.name ?? 'No owner'} <small>· {g.items.length} item{g.items.length === 1 ? '' : 's'}</small></h2>
              <div className="rv-card">
                {g.items.map((i) => (
                  <ReviewRow key={i.id} i={i} on={current?.id === i.id} onFocus={() => setCursor(flat.findIndex((x) => x.id === i.id))}
                    onDecide={(d) => (d === 'replan' || d === 'drop' ? setPop({ kind: d, item: i }) : void decide(i, d))} onNudge={() => void nudge(i)} busy={busy} />
                ))}
              </div>
            </section>
          ))}
        </div>
        <aside className="rv-rail" aria-label="Minutes, drafting live">
          <div className="rv-rail-h">Minutes · drafting live</div>
          <DraftLines lines={review.draft} />
          {noUpdate > 0 && <p className="rv-aura"><span className="rv-orb" aria-hidden="true" />Aura: {noUpdate} item{noUpdate === 1 ? ' has' : 's have'} no update — ask before deciding?</p>}
        </aside>
      </div>

      {pop && <DecisionPop kind={pop.kind} item={pop.item} review={review} people={(people.data ?? []).filter((p) => p.userId).map((p) => ({ id: p.userId!, name: p.name }))}
        onClose={() => setPop(null)} onSubmit={(d, x) => void decide(pop.item, d, x)} busy={busy} />}
    </div>
  );
}

function ReviewRow({ i, on, onFocus, onDecide, onNudge, busy }: { i: ReviewItem; on: boolean; onFocus: () => void; onDecide: (d: ReviewDecisionKind) => void; onNudge: () => void; busy: boolean }) {
  const decided = i.decision;
  const ring = i.state === 'done' ? 'done' : i.isOverdue || i.state === 'blocked' ? 'late' : i.noUpdate ? 'quiet' : i.state === 'in_progress' ? 'blue' : 'gray';
  return (
    <div className={`rv-row${on ? ' on' : ''}${decided || i.state === 'done' ? ' decided' : ''}`} data-review-row={i.id} data-testid="review-row" onClick={onFocus}>
      <span className={`rv-ring ${ring}`} aria-hidden="true" />
      <div className="rv-row-main">
        <b>{i.title}</b>
        <small>{[i.sourceTitle ? `From ${i.sourceTitle}${i.sourceOccurrence ? ` · ${dm(i.sourceOccurrence)}` : ''}` : 'Other · no source meeting', i.dueDate ? `Due ${dOnly(i.dueDate)}` : null, i.isOverdue && i.daysOverdue ? `${i.daysOverdue}d overdue` : null].filter(Boolean).join(' · ')}</small>
        {i.latestNote ? <p className="rv-note">“{i.latestNote}”{i.owner ? ` — ${first(i.owner.name)}` : ''}{i.lastUpdateAt ? `, ${ago(i.lastUpdateAt)}` : ''}</p>
          : i.noUpdate ? <p className="rv-note quiet">No update since it was assigned {i.noUpdateDays} days ago. {i.owner && <button type="button" className="rv-nudge" onClick={(e) => { e.stopPropagation(); onNudge(); }}>Nudge {first(i.owner.name)}</button>}</p> : null}
        {i.ownerLeft && <p className="rv-note quiet">The owner has left the workspace: re-plan it to someone else.</p>}
      </div>
      <div className="rv-mid">
        <span className={`rv-chip ${stateChip(i)}`}>{stateText(i)}</span>
        <small>Project</small><span className="rv-proj">{i.projectName ?? '—'}</span>
      </div>
      <div className="rv-acts">
        {decided ? <span className={`rv-decided d-${decided.decision}`}>✓ {DECIDED_LABEL[decided.decision]}{decided.convertedKey ? ` ${decided.convertedKey}` : ''}{decided.by ? <small> · {first(decided.by.name)}</small> : null}</span> : <>
          <button type="button" disabled={busy || !i.canEdit} onClick={(e) => { e.stopPropagation(); onDecide('done'); }}><kbd>D</kbd>Done</button>
          <button type="button" disabled={busy || !i.canEdit} onClick={(e) => { e.stopPropagation(); onDecide('carry'); }}><kbd>C</kbd>Carry</button>
          <button type="button" disabled={busy || !i.canEdit} onClick={(e) => { e.stopPropagation(); onDecide('replan'); }}><kbd>R</kbd>Re-plan</button>
          <button type="button" disabled={busy || !i.canEdit} onClick={(e) => { e.stopPropagation(); onDecide('convert'); }}><kbd>T</kbd>Task</button>
          <button type="button" disabled={busy || !i.canEdit} onClick={(e) => { e.stopPropagation(); onDecide('drop'); }}><kbd>X</kbd>Drop</button>
        </>}
      </div>
    </div>
  );
}

function ago(iso: string) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

const GROUPS: [MinutesLine['group'], string, string][] = [['decided', 'Decided', 'g'], ['carried', 'Carried over', 'o'], ['replanned', 'Re-planned', 'b'], ['new', 'New', 'b'], ['dropped', 'Dropped', 'x']];
function DraftLines({ lines }: { lines: MinutesLine[] }) {
  if (!lines.length) return <p className="rv-rail-empty">Decisions appear here as you make them.</p>;
  return (
    <div className="rv-draft">
      {GROUPS.map(([g, label, dot]) => {
        const l = lines.filter((x) => x.group === g);
        if (!l.length) return null;
        return (
          <div key={g} className="rv-draft-g">
            <div className="rv-draft-h"><i className={`dot-${dot}`} aria-hidden="true" /><b>{label}</b><span>{l.length}</span></div>
            {l.slice(0, 6).map((x, k) => <p key={k}>{x.text}{x.owner ? ` (${first(x.owner.name)})` : ''}{x.date ? ` · ${dOnly(x.date)}` : ''}</p>)}
          </div>
        );
      })}
    </div>
  );
}

/** Re-plan (owner and/or date, with a reason - the new owner is told), Drop (with a reason), or Carry when there is no next session (a date). */
function DecisionPop({ kind, item, review, people, onClose, onSubmit, busy }: {
  kind: 'replan' | 'drop' | 'carry'; item: ReviewItem; review: Review; people: { id: string; name: string }[];
  onClose: () => void; onSubmit: (d: ReviewDecisionKind, x: { reason?: string; ownerId?: string; dueDate?: string }) => void; busy: boolean;
}) {
  const [owner, setOwner] = useState<string>(item.owner?.id ?? '');
  const [due, setDue] = useState<string>(item.dueDate ?? '');
  const [chip, setChip] = useState<string | null>(null);
  const [text, setText] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.querySelector<HTMLElement>('select,input,textarea,button')?.focus(); }, []);
  const nextMeeting = review.nextSession ? isoDay(review.nextSession) : null;
  const reason = [chip, text.trim()].filter(Boolean).join(': ');
  const newOwner = people.find((p) => p.id === owner);
  const can = kind === 'carry' ? !!due : !!reason && (kind === 'drop' || owner !== (item.owner?.id ?? '') || due !== (item.dueDate ?? ''));
  const submit = () => {
    if (!can) return;
    if (kind === 'carry') onSubmit('carry', { dueDate: due, reason: reason || undefined });
    else if (kind === 'drop') onSubmit('drop', { reason });
    else onSubmit('replan', { reason, ownerId: owner && owner !== item.owner?.id ? owner : undefined, dueDate: due && due !== item.dueDate ? due : undefined });
  };
  return (
    <div className="rv-pop-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className="rv-pop" role="dialog" aria-modal="true" aria-label={kind === 'replan' ? `Re-plan ${item.title}` : kind === 'drop' ? `Drop ${item.title}` : `Carry ${item.title}`}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement && e.shiftKey)) { e.preventDefault(); submit(); } }}>
        <h3>{kind === 'replan' ? 'Re-plan' : kind === 'drop' ? 'Drop' : 'Carry over'} “{item.title}”</h3>
        <p className="rv-pop-sub">{kind === 'carry' ? 'This meeting has no next session. Choose the date to carry it to.' : 'Changes are logged on the item with the reason.'}</p>
        {kind === 'replan' && (
          <div className="rv-pop-row"><span>Owner</span>
            <div className="rv-pop-val">
              {item.owner && <span className="ms-chip ms-person"><Avatar name={item.owner.name} userId={item.owner.id} size="sm" />{item.owner.name}</span>}
              <span aria-hidden="true">→</span>
              <label className={`ms-chip ms-select${owner !== (item.owner?.id ?? '') ? ' on' : ''}`}><span>{newOwner?.name ?? (owner ? '…' : 'No owner')}</span>
                <select aria-label="New owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
                  <option value="">No owner</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select></label>
            </div>
          </div>
        )}
        {kind !== 'drop' && (
          <div className="rv-pop-row"><span>Due</span>
            <div className="rv-pop-val">
              {item.dueDate && <s className="rv-was">{dOnly(item.dueDate)}</s>}<span aria-hidden="true">→</span>
              <label className="ms-chip ms-field on"><span>{due ? dOnlyW(due) : 'No date'}</span><input type="date" aria-label="New due date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
              {nextMeeting && <button type="button" className="ms-chip" onClick={() => setDue(nextMeeting)}>Next meeting</button>}
              <button type="button" className="ms-chip" onClick={() => setDue(plusDays(due || item.dueDate || isoDay(new Date().toISOString()), 7))}>+1 week</button>
            </div>
          </div>
        )}
        {kind !== 'carry' && (
          <div className="rv-pop-row"><span>Reason</span>
            <div className="rv-pop-val">
              {(kind === 'drop' ? DROP_REASONS : REPLAN_REASONS).map((r) => <button key={r} type="button" className={`ms-chip${chip === r ? ' sel' : ''}`} aria-pressed={chip === r} onClick={() => setChip(chip === r ? null : r)}>{r}</button>)}
            </div>
          </div>
        )}
        {kind !== 'carry' && <textarea className="rv-pop-text" aria-label="Reason" rows={2} placeholder={kind === 'drop' ? 'Why it is dropped' : 'What changed'} value={text} onChange={(e) => setText(e.target.value)} maxLength={400} />}
        <div className="rv-pop-foot">
          <span>{kind === 'replan' && newOwner && owner !== item.owner?.id ? `${first(newOwner.name)} gets notified` : kind === 'drop' ? 'It is cancelled, not deleted' : ''}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Esc</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={!can || busy} onClick={submit}>Save &amp; next ↵</button>
        </div>
      </div>
    </div>
  );
}

/** Minutes are ready (design: review-summary): counts, the lines grouped, editable before Copy / Export PDF / Send to attendees. */
function MinutesView({ review, minutes, onBack, onSent }: { review: Review; minutes: Minutes; onBack: () => void; onSent: (m: Minutes) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(minutes.text);
  const [busy, setBusy] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(text); toast('Minutes copied.'); } catch { toast('Could not copy. Select the text and copy it by hand.', 'warning'); } };
  const send = async () => {
    setBusy(true);
    try { const m = await connectApi.send(minutes.sessionId, text); toast(`Sent to ${m.attendees} attendees.`); onSent(m); }
    catch (e) { toast(errText(e, 'Could not send the minutes.'), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="ar rv-min" data-testid="minutes">
      <nav className="rv-crumbs" aria-label="Breadcrumb"><Link to="/meetings">Meetings</Link><span>›</span><span>{minutes.title}</span><span>›</span><span>{dmw(minutes.occurrence)}</span></nav>
      <header className="rv-head">
        <div>
          <h1>{minutes.sent ? 'Minutes sent' : 'Minutes are ready'}</h1>
          <p>{minutes.reviewed} of {minutes.total} reviewed in {minutes.durationMinutes} min{minutes.nextSession ? ` · Next meeting ${dmw(minutes.nextSession)}, ${new Date(minutes.nextSession).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}</p>
        </div>
        <div className="rv-head-acts">
          {!minutes.sent && <button type="button" className="btn btn-ghost" onClick={onBack}>Back to review</button>}
          <button type="button" className="btn btn-ghost" onClick={() => void copy()}>Copy</button>
          <button type="button" className="btn btn-ghost" onClick={() => window.print()}>Export PDF</button>
          {review.scope === 'series' && !minutes.sent && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void send()}>{busy && <span className="spinner" />}Send to {minutes.attendees} attendees</button>}
        </div>
      </header>
      <div className="rv-stats">
        <div><span>Done</span><b className="g">{minutes.done}</b><small>closed this week</small></div>
        <div><span>Carried over</span><b className="o">{minutes.carried}</b><small>{minutes.nextSession ? `to ${dmw(minutes.nextSession)}` : 'to a new date'}</small></div>
        <div><span>Re-planned</span><b className="b">{minutes.replanned}</b><small>{minutes.reassignedCount} owner · {minutes.redatedCount} date change</small></div>
        <div><span>Dropped</span><b className="x">{minutes.dropped}</b><small>with reasons</small></div>
      </div>
      <section className="rv-mincard">
        {editing ? <textarea className="rv-mintext" aria-label="Minutes" value={text} onChange={(e) => setText(e.target.value)} rows={16} /> : (
          ([['decided', 'Decided'], ['carried', 'Carried over'], ['replanned', 'Re-planned'], ['new', 'New action items'], ['dropped', 'Dropped']] as const).map(([g, label]) => {
            const l = minutes.lines.filter((x) => x.group === g);
            if (!l.length) return null;
            return (
              <div key={g} className="rv-min-g">
                <h3>{label}</h3>
                {l.map((x, k) => <div key={k} className="rv-min-l"><span>{x.text}</span>{x.owner ? <span className="rv-min-who"><Avatar name={x.owner.name} userId={x.owner.id} size="sm" />{x.owner.name}</span> : <span />}<span className="rv-min-d">{x.date ? dOnly(x.date) : '—'}</span></div>)}
              </div>
            );
          })
        )}
        <p className="rv-aura"><span className="rv-orb" aria-hidden="true" />Aura drafted this from your decisions. {minutes.sent ? 'Sent and kept with the review.' : <button type="button" className="rv-nudge" onClick={() => setEditing((v) => !v)}>{editing ? 'Done editing' : 'Edit any line before sending.'}</button>}</p>
      </section>
    </div>
  );
}

/** The phone review (design: review-phone): one card, big buttons, swipe right for Done and left to carry over. */
function PhoneReview({ review, item, index, total, busy, onBack, onDecide, onNext, onFinish, pop, onClosePop, people, onSubmitPop }: {
  review: Review; item: ReviewItem | null; index: number; total: number; busy: boolean; onBack: () => void; onDecide: (d: ReviewDecisionKind) => void; onNext: () => void; onFinish: () => void;
  pop: { kind: 'replan' | 'drop' | 'carry'; item: ReviewItem } | null; onClosePop: () => void; people: { id: string; name: string }[];
  onSubmitPop: (item: ReviewItem, d: ReviewDecisionKind, x: { reason?: string; ownerId?: string; dueDate?: string }) => void;
}) {
  const startX = useRef<number | null>(null);
  const [dx, setDx] = useState(0);
  const c = review.counts;
  const pct = c.total ? Math.round((c.reviewed / c.total) * 100) : 0;
  const ownerItems = item ? review.items.filter((x) => (x.owner?.id ?? null) === (item.owner?.id ?? null)) : [];
  return (
    <div className="rvp" data-testid="action-review-phone">
      <div className="rvp-top"><button type="button" className="rvp-back" onClick={onBack}>‹ Back</button><button type="button" className="rvp-finish" onClick={onFinish}>Minutes</button></div>
      <h1>Review</h1>
      <p className="rvp-sub">{review.title} · {c.reviewed} of {c.total}</p>
      <div className="rv-bar"><i style={{ width: `${pct}%` }} /></div>
      {!item ? <p className="rv-empty">No open action items to review.</p> : <>
        <article className="rvp-card" style={{ transform: dx ? `translateX(${dx}px) rotate(${dx / 40}deg)` : undefined }}
          onPointerDown={(e) => { startX.current = e.clientX; }}
          onPointerMove={(e) => { if (startX.current !== null) setDx(e.clientX - startX.current); }}
          onPointerUp={() => { const d = dx; startX.current = null; setDx(0); if (d > 90) onDecide('done'); else if (d < -90) onDecide('carry'); }}
          onPointerCancel={() => { startX.current = null; setDx(0); }}>
          <div className="rvp-owner">
            {item.owner ? <Avatar name={item.owner.name} userId={item.owner.id} size="lg" /> : null}
            <div><b>{item.owner?.name ?? 'No owner'}</b><small>{ownerItems.findIndex((x) => x.id === item.id) + 1} of {ownerItems.length} items</small></div>
            <span className={`rv-chip ${stateChip(item)}`}>{stateText(item)}</span>
          </div>
          <h2>{item.title}</h2>
          <p className="rvp-from">{item.sourceTitle ? `From ${item.sourceTitle}${item.sourceOccurrence ? ` · ${dm(item.sourceOccurrence)}` : ''}` : 'No source meeting'}</p>
          {item.dueDate && <p className={`rvp-due${item.isOverdue ? ' late' : ''}`}>Due {dOnly(item.dueDate)}{item.isOverdue && item.daysOverdue ? ` · ${item.daysOverdue} days overdue` : ''}</p>}
          {item.latestNote ? <p className="rv-note">“{item.latestNote}”</p> : item.noUpdate ? <p className="rv-note quiet">No update in {item.noUpdateDays} days.{item.projectName ? ` ${item.projectName}.` : ''}</p> : null}
          {item.decision && <p className={`rv-decided d-${item.decision.decision}`}>✓ {DECIDED_LABEL[item.decision.decision]}</p>}
        </article>
        <div className="rvp-btns">
          <button type="button" className="g" disabled={busy || !item.canEdit} onClick={() => onDecide('done')}>✓ Done</button>
          <button type="button" className="o" disabled={busy || !item.canEdit} onClick={() => onDecide('carry')}>↻ Carry over</button>
          <button type="button" className="b" disabled={busy || !item.canEdit} onClick={() => onDecide('replan')}>✎ Owner / date</button>
          <button type="button" className="v" disabled={busy || !item.canEdit} onClick={() => onDecide('convert')}>⇢ Make task</button>
        </div>
        <button type="button" className="rvp-drop" disabled={busy || !item.canEdit} onClick={() => onDecide('drop')}>Drop with reason</button>
        <p className="rvp-hint">Swipe card ← carry · → done{index < total - 1 ? <> · <button type="button" className="rv-nudge" onClick={onNext}>Skip</button></> : null}</p>
      </>}
      {pop && <DecisionPop kind={pop.kind} item={pop.item} review={review} people={people} onClose={onClosePop} onSubmit={(d, x) => onSubmitPop(pop.item, d, x)} busy={busy} />}
    </div>
  );
}
