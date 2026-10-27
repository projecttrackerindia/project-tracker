import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'framer-motion';
import { ApiError, get, put } from '../../api/client';
import { insightApi, projectApi } from '../../api/endpoints';
import { workItemsApi, type WorkRow } from '../../api/workItemsApi';
import type { PullChip } from '../../api/types';
import { Avatar } from '../../components/ui';
import { openNew } from '../../components/v2/state';
import { DOW, daysUntil, formatDateShort, todayISO } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { spring } from '../../lib/motion';
import { queryClient, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { PRIORITY_ORDER, refreshWork, useWorkList } from './workUi';
import { PrChips, usePrStatus } from '../github/PrChips';
import { SavedViewsBar } from '../platform/SavedViews';

/* ------------------------------------------------------------------ rules */

type Sort = 'smart' | 'due' | 'priority';
const SORT_LABEL: Record<Sort, string> = { smart: 'Smart', due: 'Due', priority: 'Priority' };
const DOTS = ['#5856d6', '#ff9500', '#30b0c7', '#34c759', '#ff2d55', '#af52de'];
/** One colour per project, the same everywhere on the page. */
export const projectDot = (id: string | null) => {
  if (!id) return null;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return DOTS[h % DOTS.length];
};
const isOpen = (w: WorkRow) => w.category === 'Todo' || w.category === 'Active';
const dueOf = (w: WorkRow) => w.dueDate ?? '9999-12-31';
/** Smart: overdue first, then critical, then what is due soonest, then priority. */
const smart = (a: WorkRow, b: WorkRow) => Number(b.isOverdue) - Number(a.isOverdue)
  || Number(b.priority === 'Critical') - Number(a.priority === 'Critical')
  || dueOf(a).localeCompare(dueOf(b)) || PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.key.localeCompare(b.key, undefined, { numeric: true });
const SORTS: Record<Sort, (a: WorkRow, b: WorkRow) => number> = {
  smart,
  due: (a, b) => dueOf(a).localeCompare(dueOf(b)) || PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
  priority: (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || dueOf(a).localeCompare(dueOf(b)),
};
const localDay = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const hm = (h: number) => { const hh = Math.floor(h), mm = Math.round((h - hh) * 60); const t = hh > 12 ? hh - 12 : hh; return mm ? `${t}:${String(mm).padStart(2, '0')}` : `${t}:00`; };
const dur = (min: number) => { const h = Math.floor(min / 60), m = Math.round(min % 60); return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`; };

/** "Today", "Tomorrow", "Thu" within the week, else "12 Nov". */
function dayText(due: string | null): string {
  if (!due) return '';
  const d = daysUntil(due) ?? 0;
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d > 1 && d < 7) return DOW[new Date(`${due}T00:00:00`).getDay()];
  return formatDateShort(due).replace(/^0/, '');
}

/** Why the front card is next, from the item and the rest of the list. */
function reasonFor(w: WorkRow, rest: WorkRow[], focus: { start: number; end: number } | null): string {
  const parts: string[] = [];
  const late = w.isOverdue && w.dueDate ? Math.abs(daysUntil(w.dueDate) ?? 0) : 0;
  if (late) parts.push(`it is ${late} day${late === 1 ? '' : 's'} overdue`);
  else if (w.priority === 'Critical') parts.push('it is critical');
  if (!late && w.dueDate && (daysUntil(w.dueDate) ?? 9) <= 1) parts.push(`it is due ${dayText(w.dueDate).toLowerCase()}`);
  if (w.kind === 'ticket' && w.slaDueAt) parts.push('its service-level clock is running');
  if (!parts.length) parts.push(rest.length ? `it is the most urgent of your ${rest.length + 1} open items` : 'it is the only thing left on your list');
  let s = `Next because ${parts.join(' and ')}`;
  if (focus) s += `, and you have a focus block ${hm(focus.start)} – ${hm(focus.end)} today that fits it`;
  return `${s}.`;
}

/** Free gaps of an hour or more between today's meetings, from now to 7 PM (the same rule as Today's "Your day"). */
function useFocusBlocks() {
  const today = todayISO();
  const q = useWsQuery(['calendar', 'range', today, today, 'me'], () => insightApi.calendar(today, today, undefined, true), { staleTime: 60_000, retry: false });
  return useMemo(() => {
    const hourOf = (d: Date) => d.getHours() + d.getMinutes() / 60;
    const busy = (q.data ?? []).filter((e) => e.type === 'meeting' && e.startsAt && e.status !== 'Cancelled')
      .map((e) => { const h = hourOf(new Date(e.startsAt!)); return [h, h + (e.durationMinutes ?? 30) / 60] as const; }).sort((a, b) => a[0] - b[0]);
    const END = 19;
    let cur = Math.max(9, Math.ceil(hourOf(new Date()) * 4) / 4);
    const blocks: { start: number; end: number }[] = [];
    if (cur >= END) return { blocks, minutes: 0 };
    const gaps: [number, number][] = [];
    for (const [a, b] of busy) { if (a > cur) gaps.push([cur, Math.min(a, END)]); cur = Math.max(cur, b); if (cur >= END) break; }
    if (cur < END) gaps.push([cur, END]);
    for (const [a, b] of gaps) if (b - a >= 1 && blocks.length < 2) blocks.push({ start: a, end: a + Math.min(1.5, b - a) });
    return { blocks, minutes: blocks.reduce((s, b) => s + (b.end - b.start) * 60, 0) };
  }, [q.data]);
}

/** Done or started: a task moves to its project's first column of that category, the others to their own status. */
async function moveTo(w: WorkRow, to: 'Done' | 'Active') {
  const d = await workItemsApi.get(w.id);
  if (w.kind === 'task') {
    const p = w.projectId ? await queryClient.fetchQuery({ queryKey: ['mywork-project', w.projectId], queryFn: () => projectApi.get(w.projectId!), staleTime: 60_000 }) : null;
    const s = [...(p?.statuses ?? [])].sort((a, b) => a.order - b.order).find((x) => x.category === to);
    if (!s) throw new Error(to === 'Done' ? 'This project has no done column.' : 'This project has no in-progress column.');
    return workItemsApi.update(w.id, { version: d.version, statusId: s.id });
  }
  const status = to === 'Active' ? 'InProgress' : w.kind === 'issue' ? 'Resolved' : 'Completed';
  return workItemsApi.update(w.id, { version: d.version, status });
}

/* ------------------------------------------------------------------ the page */

/**
 * "Later": items the person put off, saved with their account (/me/ui/mywork, per workspace) so it follows them to every device, each
 * until a date (a week on) after which it comes back by itself. The old per-browser list is carried over once.
 */
const LATER_KEY = 'pm_mywork_later';
const LATER_DAYS = 7;
type LaterMap = Record<string, string>;   // work item id → ISO date it comes back
type LaterStore = Record<string, { later?: LaterMap }>;
const readOldLater = (): string[] => { try { return JSON.parse(localStorage.getItem(LATER_KEY) ?? '[]') as string[]; } catch { return []; } };
function useLater(wid: string, today: string) {
  const q = useWsQuery(['ui', 'mywork'], async () => { try { return (await get<{ value: LaterStore | null }>('/me/ui/mywork'))?.value ?? {}; } catch { return null; } }, { staleTime: 5 * 60_000, retry: false });
  const until = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
  const mine: LaterMap = q.data?.[wid]?.later ?? Object.fromEntries(readOldLater().map((id) => [id, until(LATER_DAYS)]));
  const ids = Object.entries(mine).filter(([, d]) => d > today).map(([id]) => id);
  const save = (next: LaterMap) => {
    const live = Object.fromEntries(Object.entries(next).filter(([, d]) => d > today).slice(-100));   // the account copy holds 8,000 characters
    const all: LaterStore = { ...(q.data ?? {}), [wid]: { later: live } };
    queryClient.setQueryData([wid, 'ui', 'mywork'], all);
    if (q.data) { void put('/me/ui/mywork', { value: all }).then(() => { try { localStorage.removeItem(LATER_KEY); } catch { /* blocked */ } }).catch(() => toast('Could not save “Later” to your account.', 'error')); }
  };
  return { ids, add: (id: string) => save({ ...mine, [id]: until(LATER_DAYS) }), remove: (id: string) => { const n = { ...mine }; delete n[id]; save(n); } };
}

/**
 * My Work (Mine): the Focus Stack — one "Do this now" card with why it is next and the following items stacked behind it — today's
 * progress ring, one suggestion, and a Reminders-style list in Today / This week / Later. Every item opens the side panel.
 */
export function MyWork({ onOpen }: { onOpen: (id: string) => void }) {
  const wid = useWorkspaceId();
  const reduce = useReducedMotion();
  const today = todayISO();
  const open = useWorkList({ mine: true });
  const closed = useWorkList({ mine: true, status: 'closed' });
  const { blocks, minutes } = useFocusBlocks();
  const [sort, setSort] = useState<Sort>('smart');
  const [filter, setFilter] = useState<'all' | 'overdue' | string>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  /** Ticked here: struck through in the list and flown off the stack before the server's list catches up. */
  const [ticked, setTicked] = useState<Record<string, WorkRow>>({});
  const [drawing, setDrawing] = useState<string | null>(null);
  const laterStore = useLater(wid ?? '', todayISO());
  const later = laterStore.ids;
  const [kept, setKept] = useState<string[]>([]);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const projects = useMemo(() => [...new Map(open.items.filter((w) => w.projectId).map((w) => [w.projectId!, w.projectName ?? ''])).entries()], [open.items]);
  const pass = (w: WorkRow) => filter === 'all' || (filter === 'overdue' ? w.isOverdue : w.projectId === filter);
  const openItems = useMemo(() => open.items.filter((w) => isOpen(w) && !ticked[w.id]).filter(pass).sort(SORTS[sort]), [open.items, ticked, sort, filter]); // eslint-disable-line react-hooks/exhaustive-deps
  const doneToday = useMemo(() => {
    const m = new Map<string, WorkRow>();
    for (const w of closed.items) if (localDay(w.updatedAt) === today) m.set(w.id, w);
    for (const w of Object.values(ticked)) m.set(w.id, w);
    return [...m.values()].filter(pass);
  }, [closed.items, ticked, today, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  const weekEnd = useMemo(() => { const d = new Date(`${today}T00:00:00`); d.setDate(d.getDate() + 7); return localDay(d.toISOString()); }, [today]);
  const bucket = (w: WorkRow) => (later.includes(w.id) ? 'later' : !w.dueDate ? 'later' : w.dueDate <= today ? 'today' : w.dueDate <= weekEnd ? 'week' : 'later');
  const cols = {
    today: [...doneToday, ...openItems.filter((w) => bucket(w) === 'today')],
    week: openItems.filter((w) => bucket(w) === 'week'),
    later: openItems.filter((w) => bucket(w) === 'later'),
  };
  const stack = openItems.filter((w) => !later.includes(w.id) || openItems.every((x) => later.includes(x.id)));
  const front = stack[0] ?? null;
  const overdue = openItems.filter((w) => w.isOverdue).length;
  const todayTotal = cols.today.length;
  const done = doneToday.length;

  // Pull request + checks chips for tasks and tickets on the page (one request for all of them).
  const prs = usePrStatus(openItems.filter((w) => w.kind === 'task' || w.kind === 'ticket').map((w) => w.id));
  const detail = useWsQuery(['work-items', 'detail', front?.id], () => workItemsApi.get(front!.id), { enabled: !!front, staleTime: 60_000, retry: false });
  const est = front && detail.data?.id === front.id ? (detail.data.detail as { estimatedHours?: number | null }).estimatedHours ?? null : null;
  const focus = blocks[0] ?? null;

  // The one suggestion: something this week that can wait (not urgent, not overdue, due 3+ days out), moved to Later on this device.
  const tip = cols.week.filter((w) => !w.isOverdue && PRIORITY_ORDER[w.priority] >= 2 && (daysUntil(w.dueDate) ?? 0) >= 3 && !kept.includes(w.id) && w.id !== front?.id)[0] ?? null;

  const complete = (w: WorkRow) => {
    if (drawing) return;
    setDrawing(w.id);
    const stamp = { ...w, category: 'Done' as const, status: 'Done', updatedAt: new Date().toISOString() };
    timers.current.push(window.setTimeout(() => { setTicked((t) => ({ ...t, [w.id]: stamp })); setDrawing(null); }, reduce ? 0 : 260));
    moveTo(w, 'Done').then(() => refreshWork(wid)).catch((e: unknown) => {
      setTicked((t) => { const n = { ...t }; delete n[w.id]; return n; }); setDrawing(null);
      toast(e instanceof ApiError || e instanceof Error ? e.message : 'Could not complete it.', 'error');
    });
  };
  const tickRow = (w: WorkRow) => { if (front && w.id === front.id) complete(w); else { setTicked((t) => ({ ...t, [w.id]: { ...w, category: 'Done', status: 'Done', updatedAt: new Date().toISOString() } }));
    moveTo(w, 'Done').then(() => refreshWork(wid)).catch((e: unknown) => { setTicked((t) => { const n = { ...t }; delete n[w.id]; return n; }); toast(e instanceof Error ? e.message : 'Could not complete it.', 'error'); }); } };
  const start = (w: WorkRow) => {
    onOpen(w.id);
    if (w.category === 'Todo') moveTo(w, 'Active').then(() => { refreshWork(wid); toast(`Started ${w.key}.`); }).catch((e: unknown) => toast(e instanceof Error ? e.message : 'Could not start it.', 'error'));
  };
  const moveLater = (id: string) => { laterStore.add(id); toast(`Moved to Later for a week. It comes back on its own.`, 'info'); };

  const fly: Transition = reduce ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 26 };
  const POS = [{ y: 0, scale: 1, opacity: 1 }, { y: 17, scale: 0.955, opacity: 0.9 }, { y: 32, scale: 0.91, opacity: 0.7 }];
  const loading = open.isLoading;
  const ringPct = todayTotal ? done / todayTotal : 0;

  return (
    <div className="mw">
      <div className="mw-hd">
        <div>
          <div className="mw-eyebrow">{loading ? ' ' : `${openItems.length} open · ${overdue} overdue`}</div>
          <h1 className="mw-h1">My Work</h1>
        </div>
        <div className="mw-pills">
          <div className="mw-pop-wrap">
            <button type="button" className={`mw-pill ${filter !== 'all' ? 'on' : ''}`} aria-haspopup="menu" aria-expanded={filterOpen} onClick={() => setFilterOpen((v) => !v)}>
              {filter === 'all' ? 'Filter' : filter === 'overdue' ? 'Overdue' : projects.find(([id]) => id === filter)?.[1] ?? 'Filter'}
            </button>
            {filterOpen && (
              <div className="mw-pop" role="menu" aria-label="Filter">
                {[['all', 'Everything'], ['overdue', 'Only overdue'], ...projects].map(([id, name]) => (
                  <button key={id} type="button" role="menuitemradio" aria-checked={filter === id} onClick={() => { setFilter(id); setFilterOpen(false); }}>
                    {projectDot(id === 'all' || id === 'overdue' ? null : id) && <i className="mw-pd" style={{ background: projectDot(id)! }} />}{name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" className="mw-pill" aria-label={`Sort: ${SORT_LABEL[sort]}`} title="Change the order"
            onClick={() => setSort((s) => (s === 'smart' ? 'due' : s === 'due' ? 'priority' : 'smart'))}>Sort: {SORT_LABEL[sort]}</button>
        </div>
      </div>

      <SavedViewsBar scope="mywork" current={{ sort, filter: filter === 'all' ? undefined : filter }}
        onApply={(c) => { setSort((['smart', 'due', 'priority'] as Sort[]).includes(c.sort as Sort) ? (c.sort as Sort) : 'smart'); setFilter(typeof c.filter === 'string' ? c.filter : 'all'); }} />
      <div className="mw-top">
        <section className="mw-stack" aria-label="Do this now">
          <AnimatePresence initial={false}>
            {stack.slice(0, 3).map((w, i) => {
              const isFront = i === 0;
              const ticking = drawing === w.id;
              return (
                <motion.article key={w.id} className={`mw-fc ${isFront ? 'front' : 'behind'} ${ticking ? 'done' : ''}`} style={{ zIndex: 4 - i, transformOrigin: '50% 100%' }}
                  initial={{ opacity: 0, y: 40, scale: 0.86 }}
                  animate={POS[i]}
                  exit={{ y: -140, rotate: -4, opacity: 0, scale: 1.02, zIndex: 5, transition: reduce ? { duration: 0 } : { ...fly, opacity: { duration: 0.32 } } }}
                  transition={reduce ? { duration: 0 } : { ...spring.panel, delay: i * 0.04 }}
                  aria-hidden={isFront ? undefined : true}>
                  {isFront && (
                    <div className="mw-fc-in">
                      <div className="mw-lab"><svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" /></svg>Do this now<PrChips pulls={prs.get(w.id)} compact /></div>
                      <button type="button" className="mw-bigchk" aria-label={`Complete ${w.title}`} onClick={() => complete(w)} disabled={!!drawing}>
                        <svg viewBox="0 0 34 34" width="34" height="34" aria-hidden="true">
                          <circle cx="17" cy="17" r="15" />
                          <motion.path d="M10.5 17.5l4.5 4.5 8.5-9.5" initial={false} animate={{ pathLength: ticking ? 1 : 0 }} transition={reduce ? { duration: 0 } : { duration: 0.22, ease: 'easeOut' }} />
                        </svg>
                      </button>
                      <button type="button" className="mw-ti" onClick={() => onOpen(w.id)}>{w.title}</button>
                      <p className="mw-why">{reasonFor(w, stack.slice(1), focus)}</p>
                      <div className="mw-ft">
                        <button type="button" className="mw-start" onClick={() => start(w)}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1l9 5-9 5z" fill="currentColor" /></svg>{w.category === 'Active' ? 'Continue' : 'Start'}</button>
                        <div className="mw-meta">
                          {w.dueDate && <span>Due <b className={w.isOverdue ? 'late' : ''}>{dayText(w.dueDate)}</b></span>}
                          {w.projectName && <span><i className="mw-pd" style={{ background: projectDot(w.projectId)! }} />{w.projectName}</span>}
                          {est != null && est > 0 && <span>Est. <b>{dur(est * 60)}</b></span>}
                        </div>
                        {w.assignee && <span className="mw-av"><Avatar name={w.assignee.name} userId={w.assignee.id} size="sm" /></span>}
                      </div>
                    </div>
                  )}
                </motion.article>
              );
            })}
          </AnimatePresence>
          {!loading && !front && (
            <div className="mw-fc front mw-clear"><div className="mw-fc-in">
              <div className="mw-lab">All clear</div>
              <div className="mw-ti static">Nothing is waiting on you</div>
              <p className="mw-why">Tasks, issues, action items and tickets given to you show up here, the most important first.</p>
              <div className="mw-ft"><button type="button" className="mw-start" onClick={() => openNew()}>+ New</button></div>
            </div></div>
          )}
          {loading && <div className="mw-fc front mw-skel" aria-busy="true" aria-label="Loading work" />}
        </section>

        <div className="mw-side">
          <div className="mw-card mw-ring" aria-label="Today's progress">
            <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
              <circle cx="32" cy="32" r="26" fill="none" stroke="rgba(255,149,0,.16)" strokeWidth="9" />
              <motion.circle cx="32" cy="32" r="26" fill="none" stroke="#ff9500" strokeWidth="9" strokeLinecap="round" strokeDasharray="163.4" transform="rotate(-90 32 32)"
                initial={false} animate={{ strokeDashoffset: 163.4 * (1 - ringPct) }} transition={reduce ? { duration: 0 } : spring.gentle} style={{ opacity: ringPct ? 1 : 0 }} />
            </svg>
            <div>
              <div className="mw-n">{done} of {todayTotal}</div>
              <div className="mw-faint">Today's items done · {minutes ? `${dur(minutes)} left in focus blocks` : 'no focus blocks left today'}</div>
            </div>
          </div>
          <div className="mw-ai" role="status">
            <div className="mw-ai-line"><span className="mw-orb" aria-hidden="true" />
              <span>{tip ? `${tip.title} can wait — it isn't due till ${dayText(tip.dueDate)}${tip.priority === 'Low' ? ' and it is low priority' : ''}.`
                : overdue ? `${overdue} item${overdue === 1 ? ' is' : 's are'} overdue. Clear ${overdue === 1 ? 'it' : 'them'} first, or give ${overdue === 1 ? 'it' : 'them'} a date you can meet.`
                : 'Your week looks doable. Nothing needs moving.'}</span></div>
            {tip && (
              <div className="mw-ai-act">
                <button type="button" className="mw-pill white" onClick={() => { moveLater(tip.id); toast(`Moved ${tip.key} to Later.`); }}>Move to Later</button>
                <button type="button" className="mw-pill ghost" onClick={() => setKept((k) => [...k, tip.id])}>Keep</button>
              </div>
            )}
          </div>
        </div>
      </div>

      <section className="mw-card mw-lists" aria-label="Work list">
        {([['today', 'Today'], ['week', 'This week'], ['later', 'Later']] as const).map(([id, title]) => (
          <div key={id} className={`mw-grp g-${id}`} role="group" aria-label={title}>
            <h2>{title} <span>{cols[id].length}</span></h2>
            {cols[id].map((w) => <Row key={w.id} w={w} pulls={prs.get(w.id)} done={!isOpen(w)} onTick={() => tickRow(w)} onOpen={() => onOpen(w.id)} onBack={later.includes(w.id) ? () => laterStore.remove(w.id) : undefined} />)}
            {id === 'later' && <button type="button" className="mw-add" onClick={() => openNew('task')}>＋ Add item</button>}
          </div>
        ))}
      </section>
    </div>
  );
}

function Row({ w, pulls, done, onTick, onOpen, onBack }: { w: WorkRow; pulls?: PullChip[]; done: boolean; onTick: () => void; onOpen: () => void; onBack?: () => void }) {
  const dot = projectDot(w.projectId);
  const late = w.isOverdue && w.dueDate ? Math.abs(daysUntil(w.dueDate) ?? 0) : 0;
  const when = done ? 'just now' : late ? null : dayText(w.dueDate);
  return (
    <div className={`mw-r ${done ? 'done' : ''}`}>
      <button type="button" className={`mw-chk ${done ? 'on' : ''}`} aria-label={done ? `${w.title} is done` : `Complete ${w.title}`} aria-pressed={done} disabled={done} onClick={onTick} />
      <button type="button" className="mw-r-main" onClick={onOpen} aria-label={`${w.key} ${w.title}${w.isOverdue ? ', overdue' : ''}`}>
        <b>{w.title}</b>
        <small>{dot && !done && <i className="mw-pd" style={{ background: dot }} />}{[w.projectName, when].filter(Boolean).join(' · ')}{late > 0 && !done && <>{w.projectName ? ' · ' : ''}<span className="od">overdue {late}d</span></>}</small>
      </button>
      {!done && <PrChips pulls={pulls} compact />}
      {!done && (w.priority === 'High' || w.priority === 'Critical') && <span className="mw-flag" title={`${w.priority} priority`} aria-label={`${w.priority} priority`}>!</span>}
      {onBack && !done && <button type="button" className="mw-back" onClick={onBack} aria-label={`Bring ${w.title} back`} title="Bring it back now">↩</button>}
    </div>
  );
}
