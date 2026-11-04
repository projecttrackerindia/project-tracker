/** The Notification Centre panel (see NotificationCentre.tsx): loaded on first open. */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import { chatApi, notificationApi } from '../../../api/endpoints';
import type { AppNotification, NotificationCategory, NotificationCounts, Paged } from '../../../api/types';
import { Icon } from '../../../components/Icon';
import { haptic, useIsMobile } from '../../../lib/mobile';
import { playCue } from '../../../lib/attention';
import { queryClient, useAuth } from '../../../stores/auth';
import { confirmDialog, toast } from '../../../stores/ui';
import { reminderApi } from '../../reminders/api';
import { arrange, badgeText, canJoin, CATEGORY_META, categoryOf, changeLines, conversationOf, FILTERS, iconOf, shortTime, snoozePresets, type Stack } from './model';
import { portfolioApi } from '../../projects/portfolioApi';
import { maySound } from './prefs';
import { applyTabDelta, clearTabs, destinationOf, tabKey } from './tabBadges';
import '../../../styles/notification-centre-apple.css';
import { lockScroll } from '../../../lib/scrollLock';
import { useNotificationCounts, type Filter } from './NotificationCentre';

const PAGE = 40;
const listKey = (wid: string | null, f: Filter) => [wid, 'notifications', 'centre', f];
type Pages = InfiniteData<Paged<AppNotification>, number>;

/** Changes notifications in every loaded list at once (optimistic), and the counts with them; the server's answer then refreshes both. */
function patchLists(wid: string | null, ids: Set<string>, change: (n: AppNotification) => AppNotification | null) {
  let readDelta: Partial<Record<NotificationCategory, number>> = {};
  const tabDelta: Record<string, number> = {};
  const seen = new Set<string>();
  queryClient.setQueriesData<Pages>({ queryKey: [wid, 'notifications', 'centre'] }, (data) => {
    if (!data) return data;
    return {
      ...data,
      pages: data.pages.map((p) => ({
        ...p,
        items: p.items.flatMap((n) => {
          if (!ids.has(n.id)) return [n];
          const next = change(n);
          if (!seen.has(n.id)) {
            seen.add(n.id);
            const before = n.isRead ? 0 : 1;
            const after = next && !next.isRead ? 1 : 0;
            const c = categoryOf(n);
            readDelta = { ...readDelta, [c]: (readDelta[c] ?? 0) + after - before };
            const k = tabKey(destinationOf(n.type, n.link), c);
            tabDelta[k] = (tabDelta[k] ?? 0) + after - before;
          }
          return next ? [next] : [];
        }),
      })),
    };
  });
  queryClient.setQueryData<NotificationCounts>([wid, 'notifications', 'counts'], (c) => {
    if (!c) return c;
    const next = { ...c };
    let total = 0;
    for (const [k, d] of Object.entries(readDelta) as [NotificationCategory, number][]) { next[k] = Math.max(0, (c[k] ?? 0) + d); total += d; }
    next.unread = Math.max(0, c.unread + total);
    next.tabs = applyTabDelta(c.tabs, tabDelta);
    return next;
  });
}
const settle = (wid: string | null) => { void queryClient.invalidateQueries({ queryKey: [wid, 'notifications'] }); };

function useActions() {
  const wid = useAuth((s) => s.ctx?.current?.id ?? null);
  return useMemo(() => {
    const run = async (ids: string[], change: (n: AppNotification) => AppNotification | null, call: () => Promise<unknown>, fail = 'Could not do that. Try again.') => {
      patchLists(wid, new Set(ids), change);
      try { await call(); } catch { toast(fail, 'error'); }
      settle(wid);
    };
    return {
      read: (ns: AppNotification[]) => run(ns.map((n) => n.id), (n) => ({ ...n, isRead: true }), () => Promise.all(ns.filter((n) => !n.isRead).map((n) => notificationApi.read(n.id)))),
      unread: (n: AppNotification) => run([n.id], (x) => ({ ...x, isRead: false }), () => notificationApi.unreadOne(n.id)),
      remove: (n: AppNotification) => run([n.id], () => null, () => notificationApi.remove(n.id)),
      clearStack: (ns: AppNotification[]) => run(ns.map((n) => n.id), () => null, () => notificationApi.clear({ ids: ns.map((n) => n.id) })),
      snooze: (n: AppNotification, until: Date) => run([n.id], () => null, async () => {
        await notificationApi.snooze(n.id, until.toISOString());
        toast(`Snoozed until ${until.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`, 'success');
      }, 'Could not snooze it.'),
      readAll: (f: Filter) => {
        queryClient.setQueriesData<Pages>({ queryKey: [wid, 'notifications', 'centre'] }, (d) => d && ({ ...d, pages: d.pages.map((p) => ({ ...p, items: p.items.map((n) => (f === 'all' || categoryOf(n) === f ? { ...n, isRead: true } : n)) })) }));
        queryClient.setQueryData<NotificationCounts>([wid, 'notifications', 'counts'], (c) => c && (f === 'all'
          ? { ...c, unread: 0, needsYou: 0, forInfo: 0, messages: 0, reminders: 0, meetings: 0, work: 0, tabs: clearTabs(c.tabs, 'all') }
          : { ...c, unread: Math.max(0, c.unread - (c[f] ?? 0)), [f]: 0, tabs: clearTabs(c.tabs, f) }));
        void notificationApi.readAll(f === 'all' ? undefined : f).catch(() => toast('Could not mark them read.', 'error')).finally(() => settle(wid));
      },
      clearAll: async (f: Filter) => {
        const ok = await confirmDialog({ title: f === 'all' ? 'Clear all notifications?' : `Clear all ${CATEGORY_META[f].label.toLowerCase()}?`, message: 'They leave the Notification Centre. You can still find them under Settings › Notifications › History › Archived.', confirmText: 'Clear', danger: true });
        if (!ok) return;
        queryClient.setQueriesData<Pages>({ queryKey: [wid, 'notifications', 'centre'] }, (d) => d && ({ ...d, pages: d.pages.map((p) => ({ ...p, items: p.items.filter((n) => !(f === 'all' || categoryOf(n) === f)) })) }));
        try { await notificationApi.clear(f === 'all' ? {} : { category: f }); } catch { toast('Could not clear them.', 'error'); }
        settle(wid);
      },
    };
  }, [wid]);
}

// ------------------------------------------------------------------ the panel

/** Mounted once in the shell: the panel opens over everything when the bell is pressed. */
export function Centre({ onClose }: { onClose: () => void }) {
  const phone = useIsMobile();
  const wid = useAuth((s) => s.ctx?.current?.id ?? null);
  const nav = useNavigate();
  const [filter, setFilter] = useState<Filter>('all');
  const counts = useNotificationCounts().data;
  const acts = useActions();
  const ref = useRef<HTMLDivElement>(null);
  const list = useInfiniteQuery({
    queryKey: listKey(wid, filter),
    queryFn: ({ pageParam }) => notificationApi.centre(pageParam, filter === 'all' ? undefined : filter, PAGE),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
    enabled: !!wid, staleTime: 10_000,
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  // Unread only, by default (a snoozed one that has come back is unread again). What is read waits in a collapsed "Read" section at the end.
  const unreadItems = useMemo(() => items.filter((n) => !n.isRead), [items]);
  const readItems = useMemo(() => items.filter((n) => n.isRead), [items]);
  const sections = useMemo(() => arrange(unreadItems), [unreadItems]);
  const readStacks = useMemo(() => arrange(readItems).flatMap((s) => s.stacks), [readItems]);
  const [showRead, setShowRead] = useState(false);
  const anyUnread = filter === 'all' ? (counts?.unread ?? 0) > 0 || items.some((n) => !n.isRead) : (counts?.[filter] ?? 0) > 0 || items.some((n) => !n.isRead);

  // Escape and a click outside close it (the bell itself toggles); focus moves into the panel and back to the bell after.
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest('[data-ncx-bell]') || t.closest('.modal, .modal-overlay, .confirm-overlay, .toast-root, [role="alertdialog"]')) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    if (!phone) document.addEventListener('mousedown', onDown);
    const unlock = phone ? lockScroll('body') : () => undefined;
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); unlock(); back?.focus?.({ preventScroll: true }); };
  }, [onClose, phone]);

  // The end of the list loads the next page (long lists are paged and off-screen cards skip layout and paint).
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !list.hasNextPage) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting) && !list.isFetchingNextPage) void list.fetchNextPage(); }, { root: el.closest('.ncx-scroll'), rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [list, list.hasNextPage, list.isFetchingNextPage]);

  const go = useCallback((n: AppNotification, to?: string | null) => {
    if (!n.isRead) void acts.read([n]);
    onClose();
    const link = to ?? n.link;
    if (!link) return;
    if (/^https?:/i.test(link)) { window.open(link, '_blank', 'noopener'); return; }
    nav(link);
  }, [acts, nav, onClose]);

  const panel = (
    <div ref={ref} tabIndex={-1} className={`ncx-pop${phone ? ' phone' : ''}`} role="dialog" aria-modal={phone} aria-label="Notifications">
      {phone && <div className="ncx-grab" aria-hidden="true" />}
      <header className="ncx-head">
        <h2>Notifications</h2>
        <div className="ncx-head-acts">
          <button type="button" className="ncx-link" disabled={!anyUnread} aria-label="Mark all read" onClick={() => acts.readAll(filter)}>{phone ? 'Read all' : 'Mark all read'}</button>
          <button type="button" className="ncx-icon-btn" aria-label="Clear all" title="Clear all" disabled={items.length === 0} onClick={() => void acts.clearAll(filter)}><Icon name="trash" size={15} /></button>
          <button type="button" className="ncx-icon-btn" aria-label="Notification settings" title="Notification settings" onClick={() => { onClose(); nav('/settings/notifications/device'); }}><Icon name="settings" size={15} /></button>
          {phone && <button type="button" className="ncx-done" onClick={onClose}>Done</button>}
        </div>
      </header>
      <div className="ncx-seg" role="tablist" aria-label="Show">
        {FILTERS.map((f) => {
          const c = f.id === 'all' ? counts?.unread ?? 0 : counts?.[f.id] ?? 0;
          return (
            <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'on' : ''} onClick={() => { haptic(4); setFilter(f.id); }} title={f.label} aria-label={c > 0 ? `${f.label}, ${c} unread` : f.label}>
              <span>{f.short}</span>{c > 0 && <i>{badgeText(c)}</i>}
            </button>
          );
        })}
      </div>
      <div className="ncx-scroll">
        {list.isLoading ? <Skeleton /> : unreadItems.length === 0 ? (
          <div className="ncx-empty">
            <span className="ncx-empty-ico"><Icon name="checkCircle" size={28} /></span>
            <b>You&rsquo;re all caught up</b>
            <span>{filter === 'all' ? 'New notifications, reminders, meetings and messages appear here.' : `No ${FILTERS.find((f) => f.id === filter)?.label.toLowerCase()} right now.`}</span>
          </div>
        ) : sections.map((sec) => (
          <section key={sec.id} className="ncx-sec" aria-label={sec.label}>
            <h3>{sec.label}</h3>
            {sec.stacks.map((s) => <StackView key={s.key} stack={s} go={go} acts={acts} phone={phone} />)}
          </section>
        ))}
        {!list.isLoading && readItems.length > 0 && (
          <section className={`ncx-sec ncx-read${showRead ? ' open' : ''}`} aria-label="Read">
            <button type="button" className="ncx-read-toggle" aria-expanded={showRead} onClick={() => { haptic(4); setShowRead((v) => !v); }}>
              <span>Read</span><em>{readItems.length}{list.hasNextPage ? '+' : ''}</em><Icon name="chevronD" size={14} />
            </button>
            {showRead && readStacks.map((s) => <StackView key={`r-${s.key}`} stack={s} go={go} acts={acts} phone={phone} />)}
          </section>
        )}
        {list.hasNextPage && <div ref={sentinel} className="ncx-more">{list.isFetchingNextPage ? 'Loading…' : ''}</div>}
      </div>
    </div>
  );
  return createPortal(phone ? <div className="ncx-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>{panel}</div> : panel, document.body);
}

function Skeleton() {
  return <div className="ncx-skel" aria-label="Loading">{[0, 1, 2, 3].map((i) => <div key={i} className="ncx-skel-card"><i /><span><b /><em /></span></div>)}</div>;
}

type Acts = ReturnType<typeof useActions>;

/** A stack: one card with the others tucked behind it ("3 more from #MuleSoft Support"), or all of them, with Clear. */
function StackView({ stack, go, acts, phone }: { stack: Stack; go: (n: AppNotification, to?: string | null) => void; acts: Acts; phone: boolean }) {
  const [open, setOpen] = useState(false);
  const many = stack.items.length > 1;
  if (!many) return <div className="ncx-stack single"><Card n={stack.items[0]} go={go} acts={acts} phone={phone} /></div>;
  return (
    <div className={`ncx-stack${open ? ' open' : ''}`}>
      {open && (
        <div className="ncx-stack-head">
          <b>{stack.label}</b>
          <button type="button" className="ncx-pill" onClick={() => setOpen(false)}>Show less</button>
          <button type="button" className="ncx-pill x" aria-label={`Clear ${stack.label}`} title="Clear" onClick={() => void acts.clearStack(stack.items)}><Icon name="close" size={12} /></button>
        </div>
      )}
      {(open ? stack.items : stack.items.slice(0, 1)).map((n) => <Card key={n.id} n={n} go={go} acts={acts} phone={phone} />)}
      {!open && (
        <>
          <div className="ncx-tuck" aria-hidden="true"><i /><i className={stack.items.length > 2 ? '' : 'none'} /></div>
          <button type="button" className="ncx-more-from" aria-expanded={false} onClick={() => setOpen(true)}>
            {stack.items.length - 1} more from {stack.label}{stack.unread > 1 ? ` · ${stack.unread} unread` : ''}
          </button>
        </>
      )}
    </div>
  );
}

const SWIPE_OPEN = -204;

/** One notification. Hover (computer) or swipe left (phone) for Read / Snooze / Delete; its own quick action under the text. */
function Card({ n, go, acts, phone }: { n: AppNotification; go: (n: AppNotification, to?: string | null) => void; acts: Acts; phone: boolean }) {
  const cat = categoryOf(n);
  const meta = CATEGORY_META[cat];
  const [reply, setReply] = useState(false);
  const [snooze, setSnooze] = useState(false);
  const conv = conversationOf(n.link);
  const canReply = cat === 'messages' && (!!conv || (n.actions ?? []).includes('reply'));
  const reminder = cat === 'reminders' || (n.type === 'Reminder' && cat === 'meetings');
  const join = cat === 'meetings' && canJoin(n);
  // A Plan sheet change (design plansheet8/05): before → after, whether it was e-mailed, View and Undo.
  const diff = changeLines(n);
  const [undoing, setUndoing] = useState(false);
  const undo = async () => {
    setUndoing(true);
    try {
      const res = await portfolioApi.sheetUndo({ notificationId: n.id });
      if (res.changed) { toast(`Undone · ${res.rows[0]?.key ?? 'the task'} is back as it was.`); void acts.read([n]); settle(useAuth.getState().ctx?.current?.id ?? null); }
      else toast(res.rows[0]?.error ?? 'The change could not be undone.', 'error');
    } catch (e) { toast(e instanceof Error ? e.message : 'The change could not be undone.', 'error'); }
    finally { setUndoing(false); }
  };

  // Swipe (phone): the card slides left over Read · Snooze · Delete; a long swipe deletes.
  const body = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; base: number; locked: boolean | null } | null>(null);
  const [shift, setShift] = useState(0);
  const onDown = (e: ReactPointerEvent) => {
    if (!phone || e.pointerType === 'mouse' || (e.target as HTMLElement).closest('input, textarea, form')) return;
    drag.current = { x: e.clientX, y: e.clientY, dx: 0, base: shift, locked: null };
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (d.locked === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) { d.locked = Math.abs(dx) > Math.abs(dy); if (d.locked) try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* gone */ } }
    if (!d.locked) return;
    d.dx = dx;
    const x = Math.min(0, Math.max(-320, d.base + dx));
    if (body.current) { body.current.style.transition = 'none'; body.current.style.transform = `translate3d(${x}px,0,0)`; }
  };
  const onUp = () => {
    const d = drag.current; drag.current = null;
    if (!d || !d.locked) return;
    const x = d.base + d.dx;
    if (body.current) { body.current.style.transition = ''; body.current.style.transform = ''; }
    if (x < -280) { haptic(10); void acts.remove(n); return; }
    setShift(x < -60 ? SWIPE_OPEN : 0);
    if (x < -60) haptic(4);
  };
  const suppressClick = useRef(false);
  useEffect(() => { suppressClick.current = shift !== 0; }, [shift]);

  const open = () => { if (suppressClick.current) { setShift(0); return; } go(n); };
  const done = async () => {
    const token = n.link?.startsWith('/r/') ? n.link.slice(3) : null;
    try {
      if (token) await reminderApi.act(token, 'done');
      else if ((n.actions ?? []).includes('done')) await notificationApi.act(n.id, 'done');
    } catch { toast('Could not mark it done.', 'error'); return; }
    void acts.remove(n);
    toast('Done.', 'success');
  };

  return (
    <article className={`ncx-card${n.isRead ? '' : ' unread'}${shift ? ' swiped' : ''}`} data-id={n.id} data-cat={cat}>
      {phone && (
        <div className="ncx-swipe-acts" aria-hidden={shift === 0}>
          <button type="button" className="read" onClick={() => { setShift(0); void (n.isRead ? acts.unread(n) : acts.read([n])); }}><Icon name={n.isRead ? 'eyeOff' : 'eye'} size={17} /><span>{n.isRead ? 'Unread' : 'Read'}</span></button>
          <button type="button" className="snooze" onClick={() => { setShift(0); setSnooze(true); }}><Icon name="clock" size={17} /><span>Snooze</span></button>
          <button type="button" className="delete" onClick={() => void acts.remove(n)}><Icon name="trash" size={17} /><span>Delete</span></button>
        </div>
      )}
      <div ref={body} className="ncx-card-body" style={shift ? { transform: `translate3d(${shift}px,0,0)` } : undefined}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <span className={`ncx-ico ${meta.tint}`} aria-hidden="true"><Icon name={iconOf(n)} size={16} /></span>
        <div className="ncx-main">
          <button type="button" className="ncx-open" onClick={open} aria-label={`${n.title}${n.isRead ? '' : ', unread'}. Open`}>
            <span className="ncx-row1"><b>{n.title}</b><time dateTime={n.shownAt ?? n.createdAt} title={new Date(n.shownAt ?? n.createdAt).toLocaleString()}>{shortTime(n.shownAt ?? n.createdAt)}</time></span>
            {n.reason && <span className="ncx-why" data-testid="ncx-reason">{n.reason}</span>}
            {diff ? (
              <span className="ncx-diff" data-testid="ncx-diff">
                {diff.map((d, i) => d.after !== undefined
                  ? <span key={i} className="ncx-diff-row"><em>{d.label}</em> <s>{d.before}</s> <span aria-hidden="true">→</span><span className="sr-only"> to </span> <b>{d.after}</b>{d.delta && <b className="ncx-delta"> ({d.delta})</b>}</span>
                  : <span key={i} className="ncx-diff-note">{d.label}: {d.note}</span>)}
              </span>
            ) : n.body && <span className="ncx-text">{n.body}</span>}
            {diff && n.emailed && <span className="ncx-mailed" data-testid="ncx-emailed"><Icon name="mail" size={11} /> emailed</span>}
          </button>
          {diff && n.link && (
            <div className="ncx-quick">
              <button type="button" className="ncx-btn" onClick={() => go(n)}>View</button>
              {n.canUndo && <button type="button" className="ncx-btn ghost" disabled={undoing} onClick={() => void undo()}><Icon name="undo" size={13} /> Undo</button>}
            </div>
          )}
          {(join || reminder || canReply) && (
            <div className="ncx-quick">
              {join && <button type="button" className="ncx-btn primary" onClick={() => go(n, n.joinLink)}><Icon name="video" size={13} /> Join</button>}
              {reminder && <button type="button" className="ncx-btn" onClick={() => void done()}><Icon name="tick" size={13} /> Done</button>}
              {reminder && <button type="button" className="ncx-btn" onClick={() => setSnooze((v) => !v)}><Icon name="clock" size={13} /> Snooze</button>}
              {canReply && !reply && <button type="button" className="ncx-btn" onClick={() => setReply(true)}><Icon name="send" size={13} /> Reply</button>}
              {canReply && <button type="button" className="ncx-btn ghost" onClick={() => go(n)}>Open chat</button>}
            </div>
          )}
          {reply && <ReplyBox n={n} conv={conv} onDone={() => { setReply(false); void acts.read([n]); }} onCancel={() => setReply(false)} />}
          {snooze && <SnoozeMenu onPick={(d) => { setSnooze(false); void acts.snooze(n, d); }} onCancel={() => setSnooze(false)} />}
        </div>
        {!n.isRead && <i className="ncx-dot" aria-hidden="true" />}
        {!phone && (
          <div className="ncx-hover" role="group" aria-label="Actions">
            <button type="button" aria-label={n.isRead ? 'Mark as unread' : 'Mark as read'} title={n.isRead ? 'Mark as unread' : 'Mark as read'} onClick={() => void (n.isRead ? acts.unread(n) : acts.read([n]))}><Icon name={n.isRead ? 'eyeOff' : 'tick'} size={13} /></button>
            <button type="button" aria-label="Snooze" title="Snooze" onClick={() => setSnooze((v) => !v)}><Icon name="clock" size={13} /></button>
            <button type="button" aria-label="Delete" title="Delete" onClick={() => void acts.remove(n)}><Icon name="close" size={13} /></button>
          </div>
        )}
      </div>
    </article>
  );
}

function SnoozeMenu({ onPick, onCancel }: { onPick: (d: Date) => void; onCancel: () => void }) {
  const [custom, setCustom] = useState(false);
  const [value, setValue] = useState(() => { const d = new Date(Date.now() + 2 * 3_600_000); d.setMinutes(0, 0, 0); const p = (x: number) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; });
  return (
    <div className="ncx-snooze" role="menu" aria-label="Snooze until">
      {snoozePresets().map((p) => <button key={p.label} type="button" role="menuitem" className="ncx-btn" onClick={() => onPick(p.until)}>{p.label}</button>)}
      {!custom ? <button type="button" role="menuitem" className="ncx-btn" onClick={() => setCustom(true)}>Pick a time…</button> : (
        <form className="ncx-snooze-pick" onSubmit={(e) => { e.preventDefault(); const d = new Date(value); if (Number.isNaN(d.getTime()) || d.getTime() < Date.now() + 5 * 60_000) { toast('Pick a time at least 5 minutes from now.', 'error'); return; } onPick(d); }}>
          <input type="datetime-local" aria-label="Snooze until" value={value} onChange={(e) => setValue(e.target.value)} />
          <button type="submit" className="ncx-btn primary">Snooze</button>
        </form>
      )}
      <button type="button" className="ncx-btn ghost" onClick={onCancel}>Cancel</button>
    </div>
  );
}

/** Answer a message from the card: sent to the conversation (or through the notification's own reply), then it is marked read. */
function ReplyBox({ n, conv, onDone, onCancel }: { n: AppNotification; conv: string | null; onDone: () => void; onCancel: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      if (conv) await chatApi.send(conv, t);
      else await notificationApi.act(n.id, 'reply', { text: t });
      if (maySound('messages')) playCue('sent');
      toast('Reply sent.', 'success');
      onDone();
    } catch { toast('Could not send your reply.', 'error'); setBusy(false); }
  };
  return (
    <form className="ncx-reply" onSubmit={(e) => void send(e)}>
      <input ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply…" aria-label="Reply" maxLength={4000}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }} />
      <button type="submit" className="ncx-send" aria-label="Send reply" disabled={!text.trim() || busy}><Icon name="arrowUp" size={14} /></button>
    </form>
  );
}
