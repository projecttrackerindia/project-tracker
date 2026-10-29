import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { EmptyState, ErrorState, PageLoader } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { refreshWork } from '../work/workUi';
import { connectApi, type OwnerSignal, type ReviewItem } from './meetApi';
import './connect.css';

type Tab = 'needs' | 'week' | 'waiting' | 'done';
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const dueText = (i: ReviewItem) => {
  if (!i.dueDate) return 'No due date';
  const d = new Date(`${i.dueDate}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `Due ${d}${i.isOverdue && i.daysOverdue > 0 ? ` · ${i.daysOverdue}d overdue` : ''}`;
};
export const STATE_LABEL: Record<ReviewItem['state'], string> = { open: 'Not started', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', cancelled: 'Dropped' };
export const stateChip = (i: ReviewItem) => (i.state === 'done' ? 'done' : i.state === 'cancelled' ? 'gray' : i.isOverdue ? 'late' : i.noUpdate ? 'quiet' : i.state === 'blocked' ? 'late' : i.state === 'in_progress' ? 'blue' : 'gray');
export const stateText = (i: ReviewItem) => (i.state === 'done' || i.state === 'cancelled' ? STATE_LABEL[i.state] : i.isOverdue ? 'Overdue' : i.noUpdate ? 'No update' : STATE_LABEL[i.state]);

/**
 * My action items (design: review-my): the person's own items from meetings, to update before the meeting - Needs my update, Due this
 * week, Waiting on others and Done, grouped by meeting. Each takes a one-line update with On track / Need help / Ask to move date / Done,
 * and the update shows in everyone's review.
 */
export function MyActionItems() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['meet', 'my-action-items'], connectApi.mine, { staleTime: 30_000 });
  const [tab, setTab] = useState<Tab>('needs');
  const d = q.data;
  const lists: Record<Tab, ReviewItem[]> = { needs: d?.needsUpdate ?? [], week: d?.dueThisWeek ?? [], waiting: d?.waitingOnOthers ?? [], done: d?.done ?? [] };
  const list = lists[tab];
  const series = new Map((d?.series ?? []).map((s) => [s.seriesRef, s]));
  const groups = [...list.reduce((m, i) => { const k = i.seriesRef ?? 'other'; m.set(k, [...(m.get(k) ?? []), i]); return m; }, new Map<string, ReviewItem[]>()).entries()];
  const refresh = () => { void invalidateWorkspace(wid, 'meet'); refreshWork(wid); };
  return (
    <div className="mai" data-testid="my-action-items">
      <Link className="wk-back" to="/work">‹ My Work</Link>
      <h1 className="mai-h1">My action items</h1>
      <p className="mai-sub">Review your own before the meeting — your updates show up in everyone’s review.</p>
      <div className="mai-bar">
        <div className="ms-seg" role="tablist" aria-label="My action items">
          {([['needs', 'Needs my update'], ['week', 'Due this week'], ['waiting', 'Waiting on others'], ['done', 'Done']] as const).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l} · {lists[k].length}</button>
          ))}
        </div>
        <span className="mai-group">Group: Meeting</span>
      </div>
      {q.isLoading ? <PageLoader /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : list.length === 0 ? (
        <EmptyState icon="checkCircle" title={tab === 'needs' ? 'Nothing needs your update' : tab === 'waiting' ? 'Nothing waiting on others' : 'Nothing here'}
          text="Action items agreed in meetings show up here, grouped by the meeting they came from." />
      ) : groups.map(([key, items]) => {
        const s = series.get(key);
        const first = items[0];
        const when = s?.nextSession ?? first.sourceOccurrence;
        return (
          <section key={key} className="mai-grp" aria-label={s?.title ?? first.sourceTitle ?? 'Other'}>
            <h2>{s?.title ?? first.sourceTitle ?? 'Other'}{when && <> · {new Date(when).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</>}
              {s?.cadence && s.cadence !== 'Ad hoc' && <span className={`mai-cad c-${s.cadence.toLowerCase()}`}>{s.cadence}</span>}</h2>
            <div className="mai-card">{items.map((i) => <UpdateRow key={i.id} i={i} mine={tab !== 'waiting'} onDone={refresh} />)}</div>
          </section>
        );
      })}
    </div>
  );
}

function UpdateRow({ i, mine, onDone }: { i: ReviewItem; mine: boolean; onDone: () => void }) {
  const [note, setNote] = useState(i.latestNote ?? '');
  const [busy, setBusy] = useState<OwnerSignal | null>(null);
  const send = async (signal: OwnerSignal) => {
    setBusy(signal);
    try { await connectApi.update(i.id, note === i.latestNote ? '' : note, signal); toast(signal === 'done' ? 'Done. It shows in the review.' : 'Update shared with the review.'); onDone(); }
    catch (e) { toast(errText(e, 'Could not save the update.'), 'error'); }
    finally { setBusy(null); }
  };
  const nudge = async () => {
    setBusy('note');
    try { await connectApi.nudge(i.id); toast(`Asked ${i.owner?.name.split(' ')[0] ?? 'the owner'} for an update.`); }
    catch (e) { toast(errText(e, 'Could not nudge.'), 'error'); }
    finally { setBusy(null); }
  };
  return (
    <div className="mai-row" data-testid="my-action-item">
      <div className="mai-row-top">
        <div><Link to={`/work?item=${i.id}`} className="mai-t">{i.title}</Link><small className={i.isOverdue ? 'late' : ''}>{dueText(i)}{!mine && i.owner ? ` · ${i.owner.name}` : ''}</small></div>
        <span className={`rv-chip ${stateChip(i)}`}>{stateText(i)}</span>
      </div>
      {i.state !== 'done' && i.state !== 'cancelled' && (mine ? (
        <div className="mai-upd">
          <input aria-label={`Update on ${i.title}`} placeholder="Add a one-line update…" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && note.trim()) void send('note'); }} />
          <button type="button" className="mai-b" disabled={!!busy} onClick={() => void send('on_track')}>On track</button>
          <button type="button" className="mai-b" disabled={!!busy} onClick={() => void send('need_help')}>Need help</button>
          <button type="button" className="mai-b" disabled={!!busy} onClick={() => void send('move_date')}>Ask to move date</button>
          <button type="button" className="btn btn-primary btn-sm mai-done" disabled={!!busy} onClick={() => void send('done')}>Done</button>
        </div>
      ) : (
        <div className="mai-upd waiting">
          <span>{i.latestNote ? `“${i.latestNote}”` : `No update in ${i.noUpdateDays} day${i.noUpdateDays === 1 ? '' : 's'}.`}</span>
          <button type="button" className="mai-b" disabled={!!busy} onClick={() => void nudge()}>Nudge</button>
        </div>
      ))}
    </div>
  );
}
