import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, PageHead, PageLoader } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { queryClient, useIsPersonal, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { reminderApi, SNOOZE_CHOICES, type Reminder, type ReminderList, type SnoozePreset } from './api';
import { openReminderComposer, refreshReminders } from './store';
import { ReminderSuggestions } from './Suggestions';
import { addDays, atTime, dayFirst, describeInstant, deviceZone, iso, parseReminder, relative, sameDay, toRRule, wall } from './time';

type Filter = 'all' | 'mine' | 'others' | 'auto' | 'sent';
const AUTO = new Set(['DueDate', 'Overdue', 'Escalation']);
const EXAMPLES = ['Call Priya tomorrow at 3pm', 'Every Friday 4pm submit my timesheet', 'In 2 hours check the deployment', 'Last working day of the month: send invoices', 'Next Monday 10am plan the sprint'];
const reduced = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

/** A copy of the card flies into the Completed tab, shrinking as it goes. */
function flyTo(card: HTMLElement, target: HTMLElement | null) {
  if (!target || reduced() || typeof card.animate !== 'function') return;
  const from = card.getBoundingClientRect(), to = target.getBoundingClientRect();
  const ghost = card.cloneNode(true) as HTMLElement;
  ghost.classList.add('rp-ghost');
  Object.assign(ghost.style, { position: 'fixed', left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, margin: '0', zIndex: '1000', pointerEvents: 'none' });
  document.body.appendChild(ghost);
  const dx = to.left + to.width / 2 - (from.left + from.width / 2), dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const anim = ghost.animate([
    { transform: 'translate(0, 0) scale(1)', opacity: 1 },
    { transform: `translate(${dx * 0.3}px, ${dy * 0.3 - 40}px) scale(.7)`, opacity: 0.95, offset: 0.4 },
    { transform: `translate(${dx}px, ${dy}px) scale(.06)`, opacity: 0.15 },
  ], { duration: 720, delay: 180, easing: 'cubic-bezier(.55, 0, .25, 1)', fill: 'both' });
  anim.onfinish = () => ghost.remove();
  anim.oncancel = () => ghost.remove();
}

/** The card folds away once its tick has been drawn. */
function collapse(el: HTMLElement): Promise<unknown> {
  if (reduced() || typeof el.animate !== 'function') return Promise.resolve();
  const h = el.getBoundingClientRect().height;
  return el.animate([
    { height: `${h}px`, opacity: 1, transform: 'translateX(0)' },
    { height: '0px', opacity: 0, transform: 'translateX(24px)', marginTop: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px' },
  ], { duration: 360, delay: 380, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' }).finished.catch(() => undefined);
}

/**
 * Reminders: what needs attention now, what is coming (later today, tomorrow, this week, later) and what is done. Add one in plain words,
 * finish it with a tick - it flies into Completed - or snooze it. All times are this device's.
 */
export function RemindersPage() {
  const wid = useWorkspaceId();
  const zone = deviceZone();
  const personal = useIsPersonal();
  const list = useWsQuery(['reminders', 'list'], reminderApi.list, { refetchInterval: 60_000 });
  const insights = useWsQuery(['reminders', 'insights'], reminderApi.insights, { staleTime: 120_000 });
  const nav = useNavigate();
  const settings = useWsQuery(['reminders', 'settings'], reminderApi.settings, { staleTime: 300_000 });
  const [tab, setTab] = useState<'upcoming' | 'completed'>('upcoming');
  const [filter, setFilter] = useState<Filter>('all');
  const [bump, setBump] = useState(0);
  const completedTab = useRef<HTMLButtonElement>(null);
  const key = [wid, 'reminders', 'list'];

  const data = list.data;
  const now = wall(new Date(), zone);
  const groups = useMemo(() => {
    if (!data) return [];
    const pick = (r: Reminder) => filter === 'all' || (filter === 'mine' && r.source === 'Personal') || (filter === 'others' && r.source === 'Nudge') || (filter === 'auto' && AUTO.has(r.source));
    if (filter === 'sent') return [{ id: 'sent', title: 'Sent to others', items: data.sent }];
    const open = data.open.filter(pick);
    const attention = open.filter((r) => r.state === 'Fired').sort((a, b) => (b.lastFiredAt ?? '').localeCompare(a.lastFiredAt ?? ''));
    const waiting = open.filter((r) => r.state === 'Scheduled' && r.nextFireAt).sort((a, b) => a.nextFireAt!.localeCompare(b.nextFireAt!));
    const local = (r: Reminder) => wall(new Date(r.nextFireAt!), zone);
    const week = atTime(addDays(now, 7), 0);
    return [
      { id: 'now', title: 'Needs attention', items: attention },
      { id: 'today', title: 'Later today', items: waiting.filter((r) => sameDay(local(r), now)) },
      { id: 'tomorrow', title: 'Tomorrow', items: waiting.filter((r) => sameDay(local(r), addDays(now, 1))) },
      { id: 'week', title: 'Next 7 days', items: waiting.filter((r) => { const l = local(r); return l > atTime(addDays(now, 2), 0) && l < week; }) },
      { id: 'later', title: 'Later', items: waiting.filter((r) => local(r) >= week) },
    ].filter((g) => g.items.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, filter, zone, now.getUTCDate()]);

  const completedGroups = useMemo(() => {
    const out: { title: string; items: Reminder[] }[] = [];
    for (const r of data?.completed ?? []) {
      const d = wall(new Date(r.completedAt ?? r.createdAt), zone);
      const title = sameDay(d, now) ? 'Today' : sameDay(d, addDays(now, -1)) ? 'Yesterday' : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
      const g = out.find((x) => x.title === title);
      if (g) g.items.push(r); else out.push({ title, items: [r] });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.completed, zone]);

  const complete = async (r: Reminder, card: HTMLElement) => {
    card.classList.add('is-completing');
    flyTo(card, completedTab.current);
    const series = !!r.recurrence;
    if (!series) await collapse(card);
    const before = queryClient.getQueryData<ReminderList>(key);
    if (before && !series) {
      queryClient.setQueryData<ReminderList>(key, {
        ...before, open: before.open.filter((x) => x.id !== r.id),
        completed: [{ ...r, state: 'Done', completedAt: new Date().toISOString() }, ...before.completed],
        counts: { ...before.counts, now: before.counts.now - (r.state === 'Fired' ? 1 : 0), completed: before.counts.completed + 1 },
      });
    }
    setBump((b) => b + 1);
    try {
      const done = await reminderApi.done(r.id);
      void refreshReminders(wid);
      toast(series ? 'Done for this time — it repeats.' : 'Done.', 'success', { label: 'Undo', onClick: () => { void reminderApi.reopen(done.id).then(() => refreshReminders(wid)); } });
    } catch (e) {
      if (before) queryClient.setQueryData(key, before);
      card.classList.remove('is-completing');
      toast(e instanceof ApiError ? e.message : 'Could not finish the reminder.', 'error');
    }
  };

  const restore = async (r: Reminder, card: HTMLElement) => {
    card.classList.add('is-restoring');
    await collapse(card);
    try { await reminderApi.reopen(r.id); await refreshReminders(wid); toast('Back in your reminders.', 'success'); }
    catch (e) { card.classList.remove('is-restoring'); toast(e instanceof ApiError ? e.message : 'Could not restore it.', 'error'); }
  };

  const snooze = async (r: Reminder, preset?: SnoozePreset, until?: string) => {
    try { const s = await reminderApi.snooze(r.id, preset, until); await refreshReminders(wid); toast(`Snoozed until ${s.nextFireAt ? describeInstant(s.nextFireAt, zone) : 'later'}.`, 'success'); }
    catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not snooze it.', 'error'); }
  };

  const remove = async (r: Reminder) => {
    try { await reminderApi.remove(r.id); await refreshReminders(wid); toast(r.source === 'Personal' ? 'Reminder deleted.' : 'Dismissed.', 'success'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not remove it.', 'error'); }
  };

  if (list.isLoading) return <PageLoader />;
  if (list.error) return <ErrorState error={list.error} retry={() => list.refetch()} />;
  const counts = data!.counts;
  const filters: { id: Filter; label: string; n: number }[] = [
    { id: 'all', label: 'All', n: data!.open.length },
    { id: 'mine', label: 'Mine', n: data!.open.filter((r) => r.source === 'Personal').length },
    ...(!personal ? [{ id: 'others' as Filter, label: 'From others', n: data!.open.filter((r) => r.source === 'Nudge').length }] : []),
    { id: 'auto', label: 'Automatic', n: data!.open.filter((r) => AUTO.has(r.source)).length },
    ...(data!.sent.length ? [{ id: 'sent' as Filter, label: 'Sent', n: data!.sent.length }] : []),
  ];

  return (
    <div className="rp">
      <PageHead title="Reminders" sub={<>Everything you asked to be reminded about — times in <b>{zone}</b>.</>}>
        <button type="button" className="btn btn-ghost" onClick={() => nav('/notifications/schedule')}><Icon name="settings" size={15} /> Settings</button>
        <button type="button" className="btn btn-primary" onClick={() => openReminderComposer()}><Icon name="plus" size={15} /> New reminder</button>
      </PageHead>

      <QuickAdd defaultTime={settings.data?.defaultTime ?? '09:00'} onAdded={() => refreshReminders(wid)} />

      <ReminderSuggestions />

      <div className="rp-stats">
        <Stat icon="alarm" tone="primary" value={counts.now} label="Need attention" />
        <Stat icon="clock" tone="info" value={counts.today} label="Still today" />
        <Stat icon="checkCircle" tone="success" value={insights.data?.doneThisWeek ?? 0} label="Done this week" foot={insights.data && insights.data.doneThisWeek > 0 ? `${insights.data.onTimePercent}% on time` : undefined} />
        <Stat icon="timer" tone="purple" value={insights.data?.usualTime ?? '—'} label="Your usual time" foot="when you usually get things done" />
      </div>

      {(insights.data?.snoozedOften.length ?? 0) > 0 && (
        <div className="rp-advice" role="note">
          <Icon name="info" size={15} />
          <span><b>Snoozed again and again:</b> {insights.data!.snoozedOften.map((r) => `“${r.title}” (${r.snoozeCount}×)`).join(', ')}. Maybe move the date, hand it over, or drop it?</span>
        </div>
      )}

      <div className="rp-bar">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'upcoming'} className={`tab ${tab === 'upcoming' ? 'active' : ''}`} onClick={() => setTab('upcoming')}>
            <Icon name="alarm" size={15} /> Upcoming {data!.open.length > 0 && <span className="tab-badge">{data!.open.length}</span>}
          </button>
          <button type="button" role="tab" ref={completedTab} key={bump} aria-selected={tab === 'completed'} className={`tab ${tab === 'completed' ? 'active' : ''} ${bump ? 'rp-bump' : ''}`} onClick={() => setTab('completed')}>
            <Icon name="checkCircle" size={15} /> Completed {data!.completed.length > 0 && <span className="tab-badge">{data!.completed.length}</span>}
          </button>
        </div>
        {tab === 'upcoming' && (
          <div className="rp-filters" role="group" aria-label="Show">
            {filters.map((f) => <button key={f.id} type="button" aria-pressed={filter === f.id} className={`rp-filter ${filter === f.id ? 'on' : ''}`} onClick={() => setFilter(f.id)}>{f.label}{f.n > 0 && <em>{f.n}</em>}</button>)}
          </div>
        )}
      </div>

      {tab === 'upcoming' && (groups.length === 0
        ? <EmptyReminders filter={filter} />
        : groups.map((g) => (
          <section key={g.id} className={`rp-group rp-group-${g.id}`} aria-label={g.title}>
            <h3>{g.id === 'now' && <span className="rp-pulse" aria-hidden />}{g.title}<em>{g.items.length}</em></h3>
            <ul className="rp-list">
              {g.items.map((r) => <ReminderCard key={r.id} r={r} zone={zone} sent={filter === 'sent'} onDone={complete} onSnooze={snooze} onRemove={remove} />)}
            </ul>
          </section>
        )))}

      {tab === 'completed' && (completedGroups.length === 0
        ? <EmptyState icon="checkCircle" title="Nothing finished yet" text="Tick a reminder off and it lands here. The last 30 days are kept." />
        : completedGroups.map((g) => (
          <section key={g.title} className="rp-group" aria-label={g.title}>
            <h3>{g.title}<em>{g.items.length}</em></h3>
            <ul className="rp-list">{g.items.map((r) => <ReminderCard key={r.id} r={r} zone={zone} done onRestore={restore} onRemove={remove} />)}</ul>
          </section>
        )))}

    </div>
  );
}

function Stat({ icon, tone, value, label, foot }: { icon: 'alarm' | 'clock' | 'checkCircle' | 'timer'; tone: string; value: number | string; label: string; foot?: string }) {
  return (
    <div className={`rp-stat tone-${tone}`}>
      <span className="rp-stat-ico"><Icon name={icon} size={17} /></span>
      <div><b>{value}</b><span>{label}</span>{foot && <em>{foot}</em>}</div>
    </div>
  );
}

function EmptyReminders({ filter }: { filter: Filter }) {
  if (filter !== 'all') return <EmptyState icon="alarm" title="Nothing here" text="Nothing matches this view right now." />;
  return (
    <div className="rp-empty">
      <div className="rp-empty-art"><Icon name="alarm" size={34} /></div>
      <h3>No reminders yet</h3>
      <p>Type one above in your own words, use “Remind me” on any task, or try one of these:</p>
      <div className="rp-chips">{EXAMPLES.slice(0, 3).map((x) => <button key={x} type="button" className="rc-chip" onClick={() => openReminderComposer({ text: x })}>{x}</button>)}</div>
    </div>
  );
}

/** One line, plain words: "call Priya tomorrow 3pm". Enter adds it; without a time it opens the full form. */
function QuickAdd({ defaultTime, onAdded }: { defaultTime: string; onAdded: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [example, setExample] = useState(0);
  useEffect(() => { const t = setInterval(() => setExample((i) => (i + 1) % EXAMPLES.length), 4000); return () => clearInterval(t); }, []);
  const zone = deviceZone();
  const parsed = text.trim().length > 2 ? parseReminder(text, wall(new Date(), zone), { defaultTime, dayFirst: dayFirst() }) : null;
  const ready = parsed && parsed.kind !== 'anchor' && parsed.title;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    if (!ready) { openReminderComposer({ text }); setText(''); return; }
    setBusy(true);
    try {
      await reminderApi.create({ title: parsed.title, when: parsed.kind === 'free' ? { free: true, timeZone: zone }
        : { at: iso(parsed.local), timeZone: zone, recurrence: parsed.kind === 'repeat' ? toRRule(parsed.rule) : null } });
      setText('');
      onAdded();
      toast(`Reminder set · ${parsed.label}`, 'success');
    } catch (err) { toast(err instanceof ApiError ? err.errors[0]?.message ?? err.message : 'Could not add the reminder.', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <form className={`rp-quick ${ready ? 'ready' : ''}`} onSubmit={submit}>
      <Icon name="plus" size={18} />
      <div className="rp-quick-main">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Remind me… e.g. “${EXAMPLES[example]}”`} aria-label="Add a reminder in plain words" maxLength={240} />
        <div className="rp-quick-parse" aria-live="polite">
          {ready ? <><Icon name={parsed.kind === 'repeat' ? 'repeat' : 'alarm'} size={13} /> <b>{parsed.title}</b> · {parsed.label}</>
            : text.trim().length > 2 ? <span className="muted">Add when — “tomorrow 9am”, “in 2 hours”, “every Friday” — or press Enter for more options</span> : null}
        </div>
      </div>
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !text.trim()}>{busy && <span className="spinner" />}{ready ? 'Add' : 'More…'}</button>
    </form>
  );
}

function ReminderCard({ r, zone, done, sent, onDone, onSnooze, onRemove, onRestore }: {
  r: Reminder; zone: string; done?: boolean; sent?: boolean;
  onDone?: (r: Reminder, el: HTMLElement) => void; onSnooze?: (r: Reminder, p?: SnoozePreset, until?: string) => void;
  onRemove: (r: Reminder) => void; onRestore?: (r: Reminder, el: HTMLElement) => void;
}) {
  const nav = useNavigate();
  const el = useRef<HTMLLIElement>(null);
  const [menu, setMenu] = useState<'snooze' | 'more' | null>(null);
  const [pick, setPick] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setMenu(null); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [menu]);

  const fired = r.state === 'Fired';
  const auto = AUTO.has(r.source);
  const when = done ? (r.completedAt ? `Done ${describeInstant(r.completedAt, zone)}` : 'Done')
    : fired ? `Went off ${r.lastFiredAt ? relative(r.lastFiredAt) : ''}${r.quiet ? ' · held for your briefing' : ''}`
    : r.nextFireAt ? `${describeInstant(r.nextFireAt, zone)} · ${relative(r.nextFireAt)}` : '';
  // Set on a device in another zone: show its own clock too - unless it reads the same as this one (same offset, or an old zone name).
  const there = !done && !auto && r.nextFireAt ? describeInstant(r.nextFireAt, r.timeZone) : null;
  const otherZone = there && there !== describeInstant(r.nextFireAt!, zone) ? `${there.replace(/^(Today|Tomorrow) /, '')} in ${r.timeZone}` : null;

  return (
    <li ref={el} className={`rp-card ${fired ? 'is-fired' : ''} ${done ? 'is-done' : ''} ${menu ? 'menu-open' : ''} src-${r.source.toLowerCase()}`}>
      {done
        ? <span className="rp-check checked" aria-hidden><Icon name="tick" size={14} /></span>
        : <button type="button" className="rp-check" aria-label={`Done: ${r.title}`} title="Done" disabled={sent} onClick={() => el.current && onDone?.(r, el.current)}><Icon name="tick" size={14} /></button>}
      <div className="rp-body">
        <div className="rp-title">{r.title}</div>
        {r.note && <div className="rp-note">{r.note}</div>}
        <div className="rp-meta">
          <span className={`rp-when ${fired ? 'now' : ''}`}><Icon name={fired ? 'bell' : 'clock'} size={12} /> {when}</span>
          {r.recurrenceText && <span className="rp-tag"><Icon name="repeat" size={11} /> {r.recurrenceText}</span>}
          {r.anchorDays != null && <span className="rp-tag"><Icon name="flag" size={11} /> {r.anchorDays === 0 ? 'on the due date' : `${-r.anchorDays}d before due`}</span>}
          {r.targetKey && r.link && <button type="button" className="rp-target" onClick={() => nav(r.link!)} title={r.targetTitle ?? ''}><Icon name="paperclip" size={11} /> {r.targetKey}{r.targetTitle && r.targetTitle !== r.title ? ` · ${r.targetTitle}` : ''}</button>}
          {auto && <span className="rp-tag auto"><Icon name="bolt" size={11} /> {r.source === 'Escalation' ? 'Escalation' : 'Automatic'}</span>}
          {r.from && <span className="rp-tag from"><Icon name="user" size={11} /> From {r.from.name}</span>}
          {sent && r.for && <span className="rp-tag from"><Icon name="send" size={11} /> To {r.for.name} · {r.state === 'Done' ? 'done' : r.state === 'Fired' ? 'delivered' : 'waiting'}</span>}
          {r.isSnoozed && !done && <span className="rp-tag snz">Snoozed{r.snoozeCount > 1 ? ` ×${r.snoozeCount}` : ''}</span>}
          {otherZone && <span className="rp-tag" title="Set in another time zone">{otherZone}</span>}
        </div>
      </div>
      <div className="rp-actions" ref={box}>
        {done
          ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => el.current && onRestore?.(r, el.current)}><Icon name="undo" size={13} /> Restore</button>
          : !sent && (
            <button type="button" className="btn btn-ghost btn-sm" aria-haspopup="menu" aria-expanded={menu === 'snooze'} onClick={() => setMenu(menu === 'snooze' ? null : 'snooze')}>
              <Icon name="clock" size={13} /> Snooze
            </button>
          )}
        <button type="button" className="btn-icon" aria-label="More" aria-haspopup="menu" aria-expanded={menu === 'more'} onClick={() => setMenu(menu === 'more' ? null : 'more')}><Icon name="more" /></button>
        {menu === 'snooze' && (
          <div className="rp-menu" role="menu">
            {SNOOZE_CHOICES.map((c) => <button key={c.id} type="button" role="menuitem" onClick={() => { setMenu(null); onSnooze?.(r, c.id); }}>{c.label}</button>)}
            <div className="rp-menu-pick">
              <input type="datetime-local" className="input" value={pick} min={iso(wall(new Date(), zone))} onChange={(e) => setPick(e.target.value)} aria-label="Snooze until" />
              <button type="button" className="btn btn-primary btn-sm" disabled={!pick} onClick={() => { setMenu(null); onSnooze?.(r, undefined, pick); }}>Snooze</button>
            </div>
          </div>
        )}
        {menu === 'more' && (
          <div className="rp-menu" role="menu">
            {r.link && <button type="button" role="menuitem" onClick={() => { setMenu(null); nav(r.link!); }}><Icon name="arrowRight" size={13} /> Open {r.targetKey ?? 'the work'}</button>}
            {r.canEdit && !done && <button type="button" role="menuitem" onClick={() => { setMenu(null); openReminderComposer({ editing: r }); }}><Icon name="edit" size={13} /> Change</button>}
            <button type="button" role="menuitem" className="danger" onClick={() => { setMenu(null); onRemove(r); }}>
              <Icon name="trash" size={13} /> {r.source === 'Personal' || sent ? 'Delete' : 'Dismiss'}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
