import { useEffect, useMemo, useState } from 'react';
import { SiriOrb } from '../../components/aura/SiriOrb';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { ErrorState } from '../../components/ui';
import { workItemsApi, type WorkItemDetail, type WorkItemPatch } from '../../api/workItemsApi';
import { CalmPicker, type PickItem } from '../../components/calm';
import { queryClient } from '../../stores/auth';
import { refreshWork } from '../work/workUi';
import { CalmWorkSheet } from '../tasks/CalmTaskSheet';
import { PortfolioSkeleton } from './portfolioSkeleton';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { connectApi, type Review, type ReviewItem } from '../meet/meetApi';
import { addDays, dm } from './planSheet';
import { Av, Floating } from './planSheetParts';
import type { Colour } from './planSheetTabs';

export type Group = 'meeting' | 'owner' | 'project';
const REVIEW_DAYS = 7;
const isDone = (i: ReviewItem) => i.state === 'done' || i.state === 'cancelled';
/** Needs review: raised in the last week (by a meeting or its notes) and nobody has decided on it yet. */
export const needsReview = (i: ReviewItem, now = Date.now()) => !isDone(i) && !i.decision && now - Date.parse(i.createdAt) < REVIEW_DAYS * 86_400_000;
const STATE: Record<ReviewItem['state'], string> = { open: 'Not started', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', cancelled: 'Dropped' };
const dot = (i: ReviewItem) => (i.state === 'done' ? 'done' : i.isOverdue ? 'late' : i.state === 'in_progress' ? 'prog' : i.state === 'blocked' ? 'late' : 'todo');

export function useActionReview(enabled = true) {
  return useWsQuery(['meet', 'review', 'plansheet'], () => connectApi.openReview({ scope: 'all' }), { staleTime: 30_000, retry: false, enabled });
}

/**
 * The Action items tab (design plansheet6/04–07, plansheet8/04): every meeting's action items, grouped by meeting, owner or project, each with
 * its owner, due date, project and status; tick to finish one. New ones that nobody has looked at carry "Needs review": Review walks them one at a
 * time — A accept, R reassign, S snooze a day, ⇧S snooze to a date you pick, ⌫ discard, J/K next and previous.
 */
export function ActionItemsTab({ review, colourOfProject, colours, text, people, command, layout = 'list', groupBy, reviewSignal }: {
  review: ReturnType<typeof useActionReview>; colourOfProject: (id: string | null) => Colour | null; colours: Colour[]; text: string;
  people: { id: string; name: string }[]; command?: React.ReactNode;
  /** The grouping, when the page holds it (Portfolio › Action items puts it in ⋯). */ groupBy?: Group; /** Bumped to start the review. */ reviewSignal?: number;
  /** `cards` (Portfolio › Action items, design shot 12): one calm card per meeting; `list` the Plan sheet's first folder tab. */ layout?: 'list' | 'cards';
}) {
  const nav = useNavigate();
  const wid = useWorkspaceId();
  const [opened, setOpened] = useState<ReviewItem | null>(null);
  const pickPeople = useMemo<PickItem[]>(() => people.map((p) => ({ id: p.id, label: p.name })), [people]);
  const [ownGroup, setGroup] = useState<Group>('meeting');
  const group = groupBy ?? ownGroup;
  const [reviewing, setReviewing] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [reassign, setReassign] = useState<{ item: ReviewItem; anchor: HTMLElement | null } | null>(null);
  const [snoozeAt, setSnoozeAt] = useState<{ item: ReviewItem; anchor: HTMLElement | null } | null>(null);
  const d: Review | undefined = review.data;
  const items = useMemo(() => dedupe(d?.items ?? []).filter((i) => (!colours.length || colours.includes(colourOfProject(i.projectId) ?? 'blue'))
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
  useEffect(() => { if (reviewSignal) setReviewing(0); }, [reviewSignal]);
  const cur = reviewing != null ? queue[Math.min(reviewing, queue.length - 1)] : null;
  useEffect(() => {
    if (reviewing == null) return;
    if (!cur) { setReviewing(null); return; }
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea') || e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (k === 'a') { e.preventDefault(); void decide(cur, 'carry', {}, `Accepted ${cur.key}`); }
      else if (k === 'r') { e.preventDefault(); setReassign({ item: cur, anchor: document.querySelector<HTMLElement>('.rvcard') }); }
      else if (k === 's' && e.shiftKey) { e.preventDefault(); setSnoozeAt({ item: cur, anchor: document.querySelector<HTMLElement>('.rvcard [data-snooze]') ?? document.querySelector<HTMLElement>('.rvcard') }); }
      else if (k === 's' && !e.shiftKey) { e.preventDefault(); void decide(cur, 'replan', { dueDate: addDays(cur.dueDate ?? new Date().toISOString().slice(0, 10), 1) }, `Snoozed ${cur.key} a day`); }
      else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); void decide(cur, 'drop', {}, `Discarded ${cur.key}`); }
      else if (k === 'j') setReviewing((x) => Math.min(queue.length - 1, (x ?? 0) + 1));
      else if (k === 'k') setReviewing((x) => Math.max(0, (x ?? 0) - 1));
      else if (e.key === 'Escape') setReviewing(null);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  if (review.isLoading) return <PortfolioSkeleton label="Loading action items" />;
  if (review.isError) return <ErrorState error={review.error} retry={() => void review.refetch()} />;
  const row = (i: ReviewItem) => {
    const c = colourOfProject(i.projectId);
    const today = new Date().toISOString().slice(0, 10);
    return (
      <div key={i.id} className={`ai-row ${isDone(i) ? 'done' : ''} ${cur?.id === i.id ? 'sel' : ''}`} role="row">
        <button type="button" role="checkbox" aria-checked={i.state === 'done'} className={`cb ${i.state === 'done' ? 'on' : ''}`} aria-label={`Done: ${i.title}`} disabled={!i.canEdit || isDone(i)}
          onClick={() => void decide(i, 'done', {}, `${i.key} done`)}>{i.state === 'done' ? '✓' : ''}</button>
        <button type="button" className="t" onClick={() => setOpened(i)}>{i.title}{needsReview(i) && <span className="rv">Needs review</span>}</button>
        <ActionCells i={i} people={pickPeople} />
        <span>{i.projectName && <span className={`pchip pc-${c ?? 'blue'}`}><b />{i.projectName}</span>}{today && null}</span>
      </div>
    );
  };
  return (
    <div className="ps4-ai">
      {command && <div className="ps3-cmdrow">{command}</div>}
      {layout !== 'cards' && <div className="ps4-aibar">
        <div className="ps3-vsw" role="tablist" aria-label="Group action items">{(['meeting', 'owner', 'project'] as Group[]).map((g) => <button key={g} type="button" role="tab" aria-selected={group === g} onClick={() => setGroup(g)}>By {g}</button>)}</div>
        <span className="ps3-dim" style={{ fontSize: 12 }}>{items.filter((i) => !isDone(i)).length} open · {items.length} items</span>
        <span className="ps3-sp" />
        {queue.length > 0 && <button type="button" className="ps3-qc pri" onClick={() => setReviewing(0)}>Review {queue.length} new</button>}
      </div>}
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
            <button type="button" className="kb" data-snooze="" aria-haspopup="dialog" onClick={(e) => setSnoozeAt({ item: cur, anchor: e.currentTarget })}><kbd>⇧S</kbd> Snooze to…</button>
            <button type="button" className="kb" onClick={() => void decide(cur, 'drop', {}, `Discarded ${cur.key}`)}><kbd>⌫</kbd> Discard</button>
            <span className="ps3-sp" /><span className="ps3-dim" style={{ fontSize: 11.5 }}><kbd>J</kbd> <kbd>K</kbd> next / previous</span>
            <button type="button" className="ps3-link" onClick={() => setReviewing(null)}>Done</button>
          </div>
        </div>
      )}
      {layout === 'cards' ? (
        <div className="pfa-grid">
          {groups.length === 0 && <p className="ps3-empty">No action items{text || colours.length ? ' match the filter' : ' yet — those agreed in meetings show up here'}.</p>}
          {groups.map((g) => {
            const c = colourOfProject(g.projectId);
            const open = g.items.filter((i) => !isDone(i)).length;
            const quote = g.items.find((i) => i.latestNote)?.latestNote;
            const firstNew = queue.findIndex((q) => g.items.some((i) => i.id === q.id));
            return (
              <section key={g.k} className={`calm-card pfa-card pc-${c ?? 'none'}`} aria-label={g.title}>
                <div className="pfa-h"><b className="pfa-dot" aria-hidden="true" />{g.title}{g.when && <span>{new Date(g.when).toLocaleDateString('en-GB', { weekday: 'short' })} {new Date(g.when).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>}</div>
                <div className="pfa-sub">{open} open · {g.items.length} items{g.items[0]?.projectName && group !== 'project' ? ` · ${g.items[0].projectName}` : ''}</div>
                <div className="pfa-rows">
                  <div className="pfa-colh pfa-row5" aria-hidden="true"><span>Item</span><span>Owner</span><span>Start</span><span>Due</span><span>Status</span></div>
                  {g.items.slice(0, 6).map((i) => {
                    const chip = isDone(i) ? null : i.decision ? ['Accepted', 'green'] : needsReview(i) ? ['New', 'blue'] : null;
                    return (
                      <div key={i.id} className={`pfa-row pfa-row5 ${cur?.id === i.id ? 'sel' : ''}`}>
                        <button type="button" className="pfa-t" onClick={() => setOpened(i)}>{i.title}{chip && <span className={`pfo-chip ${chip[1]}`}>{chip[0]}</span>}</button>
                        <ActionCells i={i} people={pickPeople} />
                      </div>
                    );
                  })}
                  {g.items.length > 6 && <div className="pfa-sub">+{g.items.length - 6} more</div>}
                </div>
                {quote && <div className="pfa-quote"><SiriOrb className="calm-orb" />“{quote}”</div>}
                <div className="pfa-foot">
                  {firstNew >= 0 ? <button type="button" className="pfa-rv" onClick={() => setReviewing(firstNew)}>Review · A / R / S ›</button> : <span className="pfa-sub">All reviewed</span>}
                  <span className="ps3-sp" />
                  {g.projectId && <button type="button" className="pfa-notes" onClick={() => nav(`/work/projects/${g.projectId}?tab=work&kind=action`)}>Notes ›</button>}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
      <div className="ps4-aigrid">
        <div className="colh ai" role="row"><span /><span>Action item</span><span>Owner</span><span>Start</span><span>Due</span><span>Status</span><span>Project</span></div>
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
      )}
      <CalmWorkSheet id={opened?.id ?? null} title={opened?.title} onClose={() => setOpened(null)} />
      {snoozeAt && <SnoozePicker item={snoozeAt.item} anchor={snoozeAt.anchor} onClose={() => setSnoozeAt(null)}
        onPick={(day) => { const it = snoozeAt.item; setSnoozeAt(null); void decide(it, 'replan', { dueDate: day }, `Snoozed ${it.key} to ${dm(day)}`); }} />}
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

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** ⇧S in the review: snooze an action item to a day — Tomorrow, In 3 days, Next Monday, Next week, or any date from the picker. */
function SnoozePicker({ item, anchor, onPick, onClose }: { item: ReviewItem; anchor: HTMLElement | null; onPick: (day: string) => void; onClose: () => void }) {
  const today = iso(new Date());
  const [day, setDay] = useState(() => addDays(today, 1));
  const monday = (() => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return iso(d); })();
  const presets: [string, string][] = [['Tomorrow', addDays(today, 1)], ['In 3 days', addDays(today, 3)], ['Next Monday', monday], ['Next week', addDays(today, 7)]];
  return (
    <Floating anchor={anchor} onClose={onClose} width={268} label={`Snooze ${item.key} to`} style={{ padding: '6px 0' }}>
      <div className="ph">Snooze {item.key} to</div>
      {presets.map(([label, d]) => <button key={label} type="button" className="it" onClick={() => onPick(d)}><span style={{ flex: 1 }}>{label}</span><span className="ps3-dim">{dm(d)}</span></button>)}
      <form className="ps4-snz" onSubmit={(e) => { e.preventDefault(); if (!day || day < today) { toast('Pick today or a later day.', 'error'); return; } onPick(day); }}>
        <input type="date" aria-label="Snooze until" value={day} min={today} onChange={(e) => setDay(e.target.value)} autoFocus />
        <button type="submit" className="ps3-qc pri">Snooze</button>
      </form>
    </Floating>
  );
}

/** The same item listed twice (one row per meeting it came up in) shows once: the newest copy wins. Separate rows in the database are kept. */
function dedupe(list: ReviewItem[]): ReviewItem[] {
  const seen = new Map<string, ReviewItem>();
  for (const i of list) { const had = seen.get(i.id); if (!had || (i.lastUpdateAt ?? i.createdAt) > (had.lastUpdateAt ?? had.createdAt)) seen.set(i.id, i); }
  return [...seen.values()];
}

const ACTION_STATUSES = [{ id: 'Open', label: 'Open' }, { id: 'InProgress', label: 'In progress' }, { id: 'Completed', label: 'Completed' }];

/**
 * Owner, Start, Due and Status of one action item, edited in place like the Plan sheet: the change shows at once (the shared work-item cache
 * the side panel reads too), then saves with the item's version; a failure puts it back. Everything that lists work refreshes after.
 */
function ActionCells({ i, people }: { i: ReviewItem; people: PickItem[] }) {
  const wid = useWorkspaceId();
  const key = [wid, 'work-items', 'item', i.id];
  const q = useWsQuery(['work-items', 'item', i.id], () => workItemsApi.get(i.id), { staleTime: 60_000, retry: false });
  const w = q.data;
  const [saved, setSaved] = useState(false);
  const can = i.canEdit && !!w;
  const save = async (patch: Omit<WorkItemPatch, 'version'>, local: Partial<WorkItemDetail>) => {
    if (!w) return;
    const prev = queryClient.getQueryData<WorkItemDetail>(key);
    queryClient.setQueryData<WorkItemDetail>(key, { ...w, ...local });
    try {
      const next = await workItemsApi.update(i.id, { ...patch, version: w.version });
      queryClient.setQueryData(key, next);
      setSaved(true); window.setTimeout(() => setSaved(false), 1600);
      refreshWork(wid);
    } catch (e) {
      if (prev) queryClient.setQueryData(key, prev);
      toast(e instanceof ApiError ? e.message : 'That could not be saved.', 'error');
    }
  };
  const owner = w?.assignee ?? i.owner;
  const due = w?.dueDate ?? i.dueDate;
  const late = i.isOverdue && !isDone(i);
  const statusId = w ? (w.category === 'Done' ? 'Completed' : w.category === 'Active' ? 'InProgress' : 'Open') : null;
  return (
    <>
      <span className="pfa-c">{can
        ? <CalmPicker label={`Owner of ${i.title}`} placeholder="No owner" className="pfa-pick" recentKey="people" items={people} value={owner?.id ?? null} allowClear
            selected={owner ? { id: owner.id, label: owner.name } : null}
            onChange={(v, it) => { if (v !== (owner?.id ?? null)) void save({ assigneeId: v }, { assignee: v ? { id: v, name: it?.label ?? '' } : null }); }} />
        : <span className="ps3-dim">{owner?.name ?? 'No owner'}</span>}</span>
      <span className="pfa-c"><input type="date" className="pfa-date" aria-label={`Start of ${i.title}`} disabled={!can} value={w?.startDate ?? ''}
        onChange={(e) => void save({ startDate: e.target.value || null }, { startDate: e.target.value || null })} /></span>
      <span className={`pfa-c ${late ? 'late' : ''}`}><input type="date" className="pfa-date" aria-label={`Due of ${i.title}`} disabled={!can} value={due ?? ''}
        onChange={(e) => void save({ dueDate: e.target.value || null }, { dueDate: e.target.value || null })} /></span>
      <span className="pfa-c">{can
        ? <CalmPicker label={`Status of ${i.title}`} className="pfa-pick" value={statusId ?? 'Open'} items={ACTION_STATUSES.map((x) => ({ ...x, sub: late && x.id === statusId ? 'Late' : null }))}
            onChange={(v) => { if (!v || v === statusId) return; void save({ status: v }, { category: v === 'Completed' ? 'Done' : v === 'InProgress' ? 'Active' : 'Todo', status: ACTION_STATUSES.find((x) => x.id === v)?.label ?? v }); }} />
        : <span className="ps3-st"><span className={`ps3-gl ${dot(i)}`} aria-hidden="true" />{late ? 'Late' : STATE[i.state]}</span>}
        {saved && <span className="ps3-saved" role="status">✓ Saved</span>}</span>
    </>
  );
}
