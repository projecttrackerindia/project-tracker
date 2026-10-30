import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { ErrorState, PageLoader } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { connectApi, type Review, type ReviewItem } from '../meet/meetApi';
import { addDays, dm } from './planSheet';
import { Av, Floating } from './planSheetParts';
import type { Colour } from './planSheetTabs';

type Group = 'meeting' | 'owner' | 'project';
const REVIEW_DAYS = 7;
const isDone = (i: ReviewItem) => i.state === 'done' || i.state === 'cancelled';
/** Needs review: raised in the last week (by a meeting or its notes) and nobody has decided on it yet. */
export const needsReview = (i: ReviewItem, now = Date.now()) => !isDone(i) && !i.decision && now - Date.parse(i.createdAt) < REVIEW_DAYS * 86_400_000;
const STATE: Record<ReviewItem['state'], string> = { open: 'Not started', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', cancelled: 'Dropped' };
const dot = (i: ReviewItem) => (i.state === 'done' ? 'done' : i.isOverdue ? 'late' : i.state === 'in_progress' ? 'prog' : i.state === 'blocked' ? 'late' : 'todo');

export function useActionReview() {
  return useWsQuery(['meet', 'review', 'plansheet'], () => connectApi.openReview({ scope: 'all' }), { staleTime: 30_000, retry: false });
}

/**
 * The Action items tab (design plansheet6/04–07, plansheet8/04): every meeting's action items, grouped by meeting, owner or project, each with
 * its owner, due date, project and status; tick to finish one. New ones that nobody has looked at carry "Needs review": Review walks them one at a
 * time — A accept, R reassign, S snooze a day, ⌫ discard, J/K next and previous.
 */
export function ActionItemsTab({ review, colourOfProject, colours, text, people, command }: {
  review: ReturnType<typeof useActionReview>; colourOfProject: (id: string | null) => Colour | null; colours: Colour[]; text: string;
  people: { id: string; name: string }[]; command: React.ReactNode;
}) {
  const nav = useNavigate();
  const wid = useWorkspaceId();
  const [group, setGroup] = useState<Group>('meeting');
  const [reviewing, setReviewing] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [reassign, setReassign] = useState<{ item: ReviewItem; anchor: HTMLElement | null } | null>(null);
  const d: Review | undefined = review.data;
  const items = useMemo(() => (d?.items ?? []).filter((i) => (!colours.length || colours.includes(colourOfProject(i.projectId) ?? 'blue'))
    && (!text.trim() || `${i.title} ${i.key} ${i.owner?.name ?? ''} ${i.projectName ?? ''} ${i.sourceTitle ?? ''}`.toLowerCase().includes(text.trim().toLowerCase()))), [d, colours, text, colourOfProject]);
  const queue = items.filter((i) => needsReview(i));
  const groups = useMemo(() => {
    const m = new Map<string, { title: string; when: string | null; projectId: string | null; items: ReviewItem[] }>();
    for (const i of items) {
      const k = group === 'meeting' ? i.seriesRef ?? i.sourceTitle ?? 'none' : group === 'owner' ? i.owner?.id ?? 'none' : i.projectId ?? 'none';
      const title = group === 'meeting' ? i.sourceTitle ?? 'Not from a meeting' : group === 'owner' ? i.owner?.name ?? 'No owner' : i.projectName ?? 'No project';
      if (!m.has(k)) m.set(k, { title, when: group === 'meeting' ? i.sourceOccurrence : null, projectId: i.projectId, items: [] });
      m.get(k)!.items.push(i);
    }
    return [...m.entries()].map(([k, g]) => ({ k, ...g, items: g.items.sort((a, b) => Number(isDone(a)) - Number(isDone(b)) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')) }));
  }, [items, group]);

  const decide = async (i: ReviewItem, decision: 'done' | 'carry' | 'replan' | 'drop', extra: { ownerId?: string; dueDate?: string } = {}, label?: string) => {
    if (!d?.sessionId) { toast('Open the meeting review to decide on this item.', 'info'); return; }
    try {
      await connectApi.decide(d.sessionId, { workItemId: i.id, decision, ...extra });
      await review.refetch(); void invalidateWorkspace(wid, 'action-items');
      toast(label ?? `${i.key} updated`);
    } catch (e) { toast(e instanceof ApiError ? e.message : 'That could not be saved.', 'error'); }
  };
  const cur = reviewing != null ? queue[Math.min(reviewing, queue.length - 1)] : null;
  useEffect(() => {
    if (reviewing == null) return;
    if (!cur) { setReviewing(null); return; }
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea') || e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (k === 'a') { e.preventDefault(); void decide(cur, 'carry', {}, `Accepted ${cur.key}`); }
      else if (k === 'r') { e.preventDefault(); setReassign({ item: cur, anchor: document.querySelector<HTMLElement>('.rvcard') }); }
      else if (k === 's' && !e.shiftKey) { e.preventDefault(); void decide(cur, 'replan', { dueDate: addDays(cur.dueDate ?? new Date().toISOString().slice(0, 10), 1) }, `Snoozed ${cur.key} a day`); }
      else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); void decide(cur, 'drop', {}, `Discarded ${cur.key}`); }
      else if (k === 'j') setReviewing((x) => Math.min(queue.length - 1, (x ?? 0) + 1));
      else if (k === 'k') setReviewing((x) => Math.max(0, (x ?? 0) - 1));
      else if (e.key === 'Escape') setReviewing(null);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  if (review.isLoading) return <PageLoader />;
  if (review.isError) return <ErrorState error={review.error} retry={() => void review.refetch()} />;
  const row = (i: ReviewItem) => {
    const c = colourOfProject(i.projectId);
    const today = new Date().toISOString().slice(0, 10);
    return (
      <div key={i.id} className={`ai-row ${isDone(i) ? 'done' : ''} ${cur?.id === i.id ? 'sel' : ''}`} role="row">
        <button type="button" role="checkbox" aria-checked={i.state === 'done'} className={`cb ${i.state === 'done' ? 'on' : ''}`} aria-label={`Done: ${i.title}`} disabled={!i.canEdit || isDone(i)}
          onClick={() => void decide(i, 'done', {}, `${i.key} done`)}>{i.state === 'done' ? '✓' : ''}</button>
        <button type="button" className="t" onClick={() => i.projectId && nav(`/work/projects/${i.projectId}?tab=work&kind=action&action=${i.id}`)}>{i.title}{needsReview(i) && <span className="rv">Needs review</span>}</button>
        <span className="ps3-own">{i.owner ? <><Av id={i.owner.id} name={i.owner.name} />{i.owner.name}</> : <span className="ps3-dim">No owner</span>}</span>
        <span className={`ps3-num ${i.isOverdue && !isDone(i) ? 'late' : ''}`}>{i.dueDate ? (i.dueDate === today ? 'Today' : dm(i.dueDate)) : <span className="ps3-dim">No date</span>}{i.dueDate && <i className="cg" aria-hidden="true" />}</span>
        <span>{i.projectName && <span className={`pchip pc-${c ?? 'blue'}`}><b />{i.projectName}</span>}</span>
        <span className="ps3-st"><span className={`ps3-gl ${dot(i)}`} aria-hidden="true" />{i.isOverdue && !isDone(i) ? 'Late' : STATE[i.state]}</span>
      </div>
    );
  };
  return (
    <div className="ps4-ai">
      <div className="ps3-cmdrow">{command}</div>
      <div className="ps4-aibar">
        <div className="ps3-vsw" role="tablist" aria-label="Group action items">{(['meeting', 'owner', 'project'] as Group[]).map((g) => <button key={g} type="button" role="tab" aria-selected={group === g} onClick={() => setGroup(g)}>By {g}</button>)}</div>
        <span className="ps3-dim" style={{ fontSize: 12 }}>{items.filter((i) => !isDone(i)).length} open · {items.length} items</span>
        <span className="ps3-sp" />
        {queue.length > 0 && <button type="button" className="ps3-qc pri" onClick={() => setReviewing(0)}>Review {queue.length} new</button>}
      </div>
      {cur && (
        <div className={`rvcard pc-${colourOfProject(cur.projectId) ?? 'blue'}`} role="dialog" aria-label={`Review ${cur.title}`}>
          <div className="ps3-dim" style={{ fontSize: 12 }}>Needs review · {Math.min(reviewing ?? 0, queue.length - 1) + 1} of {queue.length}{cur.sourceTitle ? ` · from ${cur.sourceTitle}` : ''}</div>
          <div style={{ fontWeight: 600, fontSize: 15, margin: '4px 0 2px' }}>{cur.title}</div>
          <div className="ps3-dim" style={{ fontSize: 12.5 }}>{cur.owner?.name ?? 'No owner'} · {cur.dueDate ? `due ${dm(cur.dueDate)}` : 'no due date'}{cur.projectName ? ` · ${cur.projectName}` : ''}</div>
          {cur.latestNote && <div className="quote">“{cur.latestNote}”</div>}
          <div className="kbs">
            <button type="button" className="kb on" onClick={() => void decide(cur, 'carry', {}, `Accepted ${cur.key}`)}><kbd>A</kbd> Accept</button>
            <button type="button" className="kb" onClick={(e) => setReassign({ item: cur, anchor: e.currentTarget })}><kbd>R</kbd> Reassign</button>
            <button type="button" className="kb" onClick={() => void decide(cur, 'replan', { dueDate: addDays(cur.dueDate ?? new Date().toISOString().slice(0, 10), 1) }, `Snoozed ${cur.key} a day`)}><kbd>S</kbd> Snooze</button>
            <button type="button" className="kb" onClick={() => void decide(cur, 'drop', {}, `Discarded ${cur.key}`)}><kbd>⌫</kbd> Discard</button>
            <span className="ps3-sp" /><span className="ps3-dim" style={{ fontSize: 11.5 }}><kbd>J</kbd> <kbd>K</kbd> next / previous</span>
            <button type="button" className="ps3-link" onClick={() => setReviewing(null)}>Done</button>
          </div>
        </div>
      )}
      <div className="ps4-aigrid">
        <div className="colh ai" role="row"><span /><span>Action item</span><span>Owner</span><span>Due</span><span>Project</span><span>Status</span></div>
        {groups.length === 0 && <p className="ps3-empty">No action items{text || colours.length ? ' match the filter' : ' yet — those agreed in meetings show up here'}.</p>}
        {groups.map((g) => {
          const c = group === 'project' || group === 'meeting' ? colourOfProject(g.projectId) : null;
          const open = g.items.filter((i) => !isDone(i)).length;
          return (
            <section key={g.k} className={`ps4-card pc-${c ?? 'none'}`} aria-label={g.title}>
              <div className="gh">
                <button type="button" className="tw" aria-expanded={!collapsed.has(g.k)} aria-label={`${collapsed.has(g.k) ? 'Expand' : 'Collapse'} ${g.title}`}
                  onClick={() => setCollapsed((s) => { const n = new Set(s); if (n.has(g.k)) n.delete(g.k); else n.add(g.k); return n; })}>{collapsed.has(g.k) ? '▸' : '▾'}</button>
                {group === 'meeting' && <span className="dia" aria-hidden="true">◆</span>}<b>{g.title}</b>
                {g.when && <span className="ps3-dim">{new Date(g.when).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} · {new Date(g.when).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>}
                <span className="ps3-sp" /><span className="ps3-dim">{g.items.length} items ·</span><b style={{ fontWeight: 600 }}>{open} open</b>
              </div>
              {!collapsed.has(g.k) && <div className="rows">{g.items.map(row)}</div>}
            </section>
          );
        })}
      </div>
      {reassign && (
        <Floating anchor={reassign.anchor} onClose={() => setReassign(null)} width={260} label="Reassign to" style={{ padding: '6px 0', maxHeight: 320, overflow: 'auto' }}>
          <div className="ph">Reassign {reassign.item.key} to</div>
          {people.slice(0, 40).map((p) => <button key={p.id} type="button" className="it" onClick={() => { const it = reassign.item; setReassign(null); void decide(it, 'replan', { ownerId: p.id }, `Gave ${it.key} to ${p.name}`); }}>
            <Av id={p.id} name={p.name} />{p.name}</button>)}
        </Floating>
      )}
    </div>
  );
}
