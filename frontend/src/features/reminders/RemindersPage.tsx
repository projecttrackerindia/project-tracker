import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { CalmGo, CalmRailCard, CalmRailRow, CalmSheet } from '../../components/calm';
import { Icon, type IconName } from '../../components/Icon';
import { ErrorState, PageLoader } from '../../components/ui';
import { projectColor } from '../../lib/calm';
import { useIsMobile } from '../../lib/mobile';
import { useWsQuery } from '../../lib/hooks';
import { queryClient, useIsPersonal, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { reminderApi, watchApi, type Reminder, type ReminderList, type SnoozePreset, type Watch } from './api';
import { openReminderComposer, refreshReminders } from './store';
import { addDays, dayFirst, describeInstant, deviceZone, hhmm, iso, parseReminder, sameDay, toRRule, wall } from './time';
import './reminders-calm.css';

type Smart = 'today' | 'scheduled' | 'flagged' | 'all' | 'done';
type View = Smart | `list:${string}` | 'others' | 'sent' | 'auto' | 'watching';
const AUTO = new Set(['DueDate', 'Overdue', 'Escalation']);
const EXAMPLES = ['send Tom the plan in 2 hours', 'call the bank tomorrow 10am', 'every Friday 5:30pm submit timesheet', 'water the plants every 3 days 7pm'];
const TILES: { id: Smart; label: string; icon: IconName; color: string }[] = [
  { id: 'today', label: 'Today', icon: 'sun', color: '#0a84ff' }, { id: 'scheduled', label: 'Scheduled', icon: 'calendar', color: '#ff3b30' },
  { id: 'flagged', label: 'Flagged', icon: 'flag', color: '#ff9500' }, { id: 'all', label: 'All', icon: 'list', color: 'var(--calm-ink)' },
  { id: 'done', label: 'Done', icon: 'checkCircle', color: '#8e8e93' },
];
const SNOOZE: { id: SnoozePreset | 'free' | 'pick'; label: string }[] = [
  { id: '10m', label: '10 minutes' }, { id: '1h', label: '1 hour' }, { id: '3h', label: '3 hours' }, { id: 'evening', label: 'This evening · 18:00' },
  { id: 'tomorrow', label: 'Tomorrow morning' }, { id: 'nextweek', label: 'Next week' }, { id: 'free', label: 'When I’m free' }, { id: 'pick', label: 'Pick a date…' },
];

/** When a reminder is on the person's clock: its next time, or (gone off) when it went off. */
const at = (r: Reminder, zone: string) => (r.nextFireAt ? wall(new Date(r.nextFireAt), zone) : r.lastFiredAt ? wall(new Date(r.lastFiredAt), zone) : null);
/** "Done", the source of a reminder in a few words ("From Lena", "Meeting", "Due soon · auto"). */
function sourceText(r: Reminder) {
  if (r.from) return `From ${r.from.name.split(' ')[0]}`;
  if (r.source === 'Meeting') return 'Meeting';
  if (r.source === 'DueDate') return 'Due soon · auto';
  if (r.source === 'Overdue') return 'Overdue · auto';
  if (r.source === 'Escalation') return 'Escalation';
  return '';
}

/** Everything a reminder already has, as the update call takes it (to change one switch without touching the rest). */
const asSave = (r: Reminder) => ({
  title: r.title, note: r.note, targetType: r.targetType, targetId: r.targetId, onlyIfOpen: r.onlyIfOpen, exact: r.exact,
  when: { at: r.localAt, timeZone: r.timeZone, anchorDays: r.anchorDays, anchorTime: r.anchorTime, recurrence: r.recurrence },
});

/** "#Work" files it in a list, a lone "!" flags it; the rest is read as plain words ("call Sofia tomorrow 10am every week"). */
function readQuick(text: string, now: Date, defaultTime: string) {
  const list = /(?:^|\s)#([\p{L}\d][\p{L}\d._-]{0,38})/u.exec(text)?.[1] ?? null;
  const flagged = /(?:^|\s)!(?=\s|$)/.test(text);
  const words = text.replace(/(?:^|\s)#[\p{L}\d][\p{L}\d._-]{0,38}/gu, ' ').replace(/(?:^|\s)!(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  const parsed = words.length > 2 ? parseReminder(words, now, { defaultTime, dayFirst: dayFirst() }) : null;
  return { list, flagged, words, parsed };
}

/**
 * Reminders: the smart lists as tiles (Today, Scheduled, Flagged, All, Done), the person's own lists, people (from others, sent by me,
 * automatic) and "Tell me when" watches; the day's reminders by morning, afternoon and evening; adding in plain words with live chips;
 * a detail popover for every switch (exact time or working hours, only while the work is open, list, flag) and a snooze menu. The rail:
 * reminders suggested from what you said, your watches, this week's numbers and the automatic rules. All times are this device's.
 */
export function RemindersPage() {
  const wid = useWorkspaceId();
  const zone = deviceZone();
  const personal = useIsPersonal();
  const phone = useIsMobile();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const list = useWsQuery(['reminders', 'list'], reminderApi.list, { refetchInterval: 60_000 });
  const insights = useWsQuery(['reminders', 'insights'], reminderApi.insights, { staleTime: 120_000 });
  const settings = useWsQuery(['reminders', 'settings'], reminderApi.settings, { staleTime: 300_000 });
  const suggestions = useWsQuery(['reminders', 'suggestions'], reminderApi.suggestions, { staleTime: 30_000, refetchInterval: 120_000 });
  const watches = useWsQuery(['reminders', 'watches'], watchApi.list, { staleTime: 60_000, retry: false });
  const [view, setView] = useState<View>(() => (params.get('tab') === 'watching' ? 'watching' : 'today'));
  const [showDone, setShowDone] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<Set<string>>(() => new Set());
  const busy = useRef(new Set<string>());
  const key = [wid, 'reminders', 'list'];
  const now = wall(new Date(), zone);

  const data = list.data;
  const open = useMemo(() => data?.open ?? [], [data]);
  const isToday = (r: Reminder) => r.state === 'Fired' || (!!r.nextFireAt && sameDay(wall(new Date(r.nextFireAt), zone), now));
  const lists = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of open) if (r.list) m.set(r.list, (m.get(r.list) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [open]);
  const counts: Record<Smart, number> = {
    today: open.filter(isToday).length, scheduled: open.filter((r) => r.state === 'Scheduled' && r.nextFireAt).length,
    flagged: open.filter((r) => r.flagged).length, all: open.length, done: data?.completed.length ?? 0,
  };
  const activeWatches = (watches.data ?? []).filter((w) => w.state === 'active');

  const items: Reminder[] = useMemo(() => {
    if (!data) return [];
    const byTime = (a: Reminder, b: Reminder) => ((a.nextFireAt ?? a.lastFiredAt ?? '') < (b.nextFireAt ?? b.lastFiredAt ?? '') ? -1 : 1);
    if (view === 'done') return data.completed;
    if (view === 'sent') return data.sent;
    const base = view === 'today' ? open.filter(isToday) : view === 'scheduled' ? open.filter((r) => r.nextFireAt) : view === 'flagged' ? open.filter((r) => r.flagged)
      : view === 'others' ? open.filter((r) => r.source === 'Nudge') : view === 'auto' ? open.filter((r) => AUTO.has(r.source))
      : view.startsWith('list:') ? open.filter((r) => r.list === view.slice(5)) : open;
    const done = view === 'today' && showDone ? data.completed.filter((r) => r.completedAt && sameDay(wall(new Date(r.completedAt), zone), now)) : [];
    return [...base, ...done].sort(byTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, view, showDone, zone, now.getUTCDate()]);

  const groups = useMemo(() => {
    const out: { title: string; items: Reminder[] }[] = [];
    const add = (title: string, r: Reminder) => { const g = out.find((x) => x.title === title); if (g) g.items.push(r); else out.push({ title, items: [r] }); };
    for (const r of items) {
      const w = r.state === 'Done' && r.completedAt ? wall(new Date(r.completedAt), zone) : at(r, zone);
      if (view === 'today') { const h = w?.getUTCHours() ?? 9; add(h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening', r); continue; }
      if (view === 'done') { add(!w ? 'Earlier' : sameDay(w, now) ? 'Today' : sameDay(w, addDays(now, -1)) ? 'Yesterday' : w.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }), r); continue; }
      if (r.state === 'Fired') { add('Needs attention', r); continue; }
      add(!w ? 'Someday' : sameDay(w, now) ? 'Today' : sameDay(w, addDays(now, 1)) ? 'Tomorrow' : w < addDays(now, 7) ? w.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }) : 'Later', r);
    }
    const order = view === 'today' ? ['Morning', 'Afternoon', 'Evening'] : null;
    return order ? order.map((t) => out.find((g) => g.title === t)).filter((g): g is { title: string; items: Reminder[] } => !!g) : out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, view, zone, now.getUTCDate()]);

  const begin = (id: string) => { if (busy.current.has(id)) return false; busy.current.add(id); return true; };
  const end = (id: string) => busy.current.delete(id);

  const complete = async (r: Reminder) => {
    if (r.state === 'Done') { void restore(r); return; }
    if (!begin(r.id)) return;
    setLeaving((s) => new Set(s).add(r.id));
    const before = queryClient.getQueryData<ReminderList>(key);
    await new Promise((res) => setTimeout(res, 520));   // the tick draws, then the row folds away
    if (before && !r.recurrence) queryClient.setQueryData<ReminderList>(key, { ...before, open: before.open.filter((x) => x.id !== r.id), completed: [{ ...r, state: 'Done', completedAt: new Date().toISOString() }, ...before.completed] });
    try {
      const done = await reminderApi.done(r.id, { nextFireAt: r.nextFireAt, lastFiredAt: r.lastFiredAt });
      toast(r.recurrence ? '✓ Done for this time — it repeats' : '✓ Done', 'success', { label: 'Undo', onClick: () => { void reminderApi.reopen(done.id).then(() => refreshReminders(wid)); } });
    } catch (e) {
      if (before) queryClient.setQueryData(key, before);
      toast(e instanceof ApiError ? e.message : 'Could not finish the reminder.', 'error');
    } finally { end(r.id); setLeaving((s) => { const n = new Set(s); n.delete(r.id); return n; }); void refreshReminders(wid); }
  };
  const restore = async (r: Reminder) => {
    try { await reminderApi.reopen(r.id); await refreshReminders(wid); toast('✓ Back in your reminders', 'success'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not restore it.', 'error'); }
  };
  const snooze = async (r: Reminder, choice: SnoozePreset | 'free', until?: string) => {
    setSnoozeFor(null);
    if (!begin(r.id)) return;
    try {
      const s = choice === 'free'
        ? await reminderApi.update(r.id, { ...asSave(r), when: { free: true, timeZone: zone, recurrence: r.recurrence } })
        : await reminderApi.snooze(r.id, until ? undefined : choice, until, { nextFireAt: r.nextFireAt, lastFiredAt: r.lastFiredAt });
      await refreshReminders(wid);
      toast(`✓ Snoozed until ${s.nextFireAt ? describeInstant(s.nextFireAt, zone) : 'later'}`, 'success');
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not snooze it.', 'error'); void refreshReminders(wid); }
    finally { end(r.id); }
  };
  const patchOne = (r: Reminder) => queryClient.setQueryData<ReminderList>(key, (old) => old && { ...old, open: old.open.map((x) => (x.id === r.id ? r : x)) });
  const meta = async (r: Reminder, b: { flagged?: boolean; list?: string }) => {
    patchOne({ ...r, flagged: b.flagged ?? r.flagged, list: b.list === undefined ? r.list : b.list || null });
    try { patchOne(await reminderApi.meta(r.id, b)); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save that.', 'error'); void refreshReminders(wid); }
  };
  const change = async (r: Reminder, patch: { exact?: boolean; onlyIfOpen?: boolean }) => {
    patchOne({ ...r, ...patch });
    try { patchOne(await reminderApi.update(r.id, { ...asSave(r), ...patch })); }
    catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save that.', 'error'); void refreshReminders(wid); }
  };
  const remove = async (r: Reminder) => {
    setOpenId(null);
    try { await reminderApi.remove(r.id); await refreshReminders(wid); toast(r.source === 'Personal' ? 'Reminder deleted.' : 'Dismissed.', 'success'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not remove it.', 'error'); }
  };

  if (list.isLoading) return <PageLoader />;
  if (list.error) return <ErrorState error={list.error} retry={() => list.refetch()} />;
  const selected = openId ? [...open, ...data!.completed, ...data!.sent].find((r) => r.id === openId) ?? null : null;
  const title = view.startsWith('list:') ? view.slice(5) : { today: 'Today', scheduled: 'Scheduled', flagged: 'Flagged', all: 'All', done: 'Done', others: 'From others', sent: 'Sent by me', auto: 'Automatic', watching: 'Tell me when' }[view as string] ?? 'Reminders';
  const shown = view === 'watching' ? activeWatches.length : items.filter((r) => r.state !== 'Done').length || (view === 'done' ? items.length : 0);
  const pick = (v: View) => { setView(v); setOpenId(null); setSnoozeFor(null); if (params.get('tab') === 'watching') setParams((p) => { const n = new URLSearchParams(p); n.delete('tab'); return n; }, { replace: true }); };
  const ins = insights.data;
  const s = settings.data;
  const leads = s?.dueLeads?.length ? s.dueLeads.map((d) => (d === 0 ? 'on the day' : `${d} day${d === 1 ? '' : 's'} before`)) : ['1 day before', 'on the day'];

  const side = (
    <div className="rm-side">
      <div className="rm-tiles-wrap">
      <div className="rm-tiles" role="group" aria-label="Smart lists">
        {TILES.map((t) => (
          <button key={t.id} type="button" className={`rm-tile${view === t.id ? ' on' : ''}${t.id === 'done' ? ' w' : ''}`} aria-pressed={view === t.id} onClick={() => pick(t.id)}>
            <span className="rm-ic" style={{ background: t.color } as CSSProperties}><Icon name={t.icon} size={15} /></span><b>{counts[t.id]}</b><span className="rm-n">{t.label}</span>
          </button>
        ))}
      </div>
      </div>
      <div className="rm-lists">
      {lists.length > 0 && <div className="rm-ps">My lists</div>}
      {lists.map(([name, n]) => <SideRow key={name} on={view === `list:${name}`} onClick={() => pick(`list:${name}`)} lead={<i style={{ background: projectColor(name) }} />} label={name} n={n} />)}
      <div className="rm-ps">People</div>
      {!personal && <SideRow on={view === 'others'} onClick={() => pick('others')} lead={<Icon name="user" size={14} />} label="From others" n={open.filter((r) => r.source === 'Nudge').length} />}
      <SideRow on={view === 'sent'} onClick={() => pick('sent')} lead={<Icon name="send" size={14} />} label="Sent by me" n={data!.sent.length} />
      {watches.isSuccess && <><div className="rm-ps">Watching</div><SideRow on={view === 'watching'} onClick={() => pick('watching')} lead={<Icon name="eye" size={14} />} label="Tell me when" n={activeWatches.length} /></>}
      </div>
    </div>
  );

  const rail = (
    <aside className="rm-rail" aria-label="Suggestions and insights">
      {(suggestions.data?.length ?? 0) > 0 && (
        <CalmRailCard title="Suggested from your words">
          {suggestions.data!.slice(0, 4).map((x) => (
            <div key={x.id} className="rm-sug">
              <b>{x.quote ? `“${x.quote}”` : x.title}</b>
              <small>{x.title !== x.quote ? `${x.title} · ` : ''}{describeInstant(x.fireAt, zone)}</small>
              <div>
                <CalmGo onClick={() => { queryClient.setQueryData([wid, 'reminders', 'suggestions'], suggestions.data!.filter((y) => y.id !== x.id)); void reminderApi.acceptSuggestion(x.id).then(() => { void refreshReminders(wid); toast(`✓ Reminder set for ${describeInstant(x.fireAt, zone)}`, 'success'); }).catch(() => void suggestions.refetch()); }}>Remind me</CalmGo>
                <button type="button" className="rm-lk" onClick={() => { queryClient.setQueryData([wid, 'reminders', 'suggestions'], suggestions.data!.filter((y) => y.id !== x.id)); void reminderApi.dismissSuggestion(x.id).catch(() => void suggestions.refetch()); }}>Dismiss</button>
              </div>
            </div>
          ))}
        </CalmRailCard>
      )}
      {watches.isSuccess && (
        <CalmRailCard title="Tell me when" aside={activeWatches.length > 2 ? <button type="button" className="rm-lk" onClick={() => pick('watching')}>All ›</button> : undefined}>
          {activeWatches.length === 0 && <p className="rm-note">Ask Aura “tell me when ATL-12 is done”. You get one notification, then it stops.</p>}
          {activeWatches.slice(0, 3).map((w) => <CalmRailRow key={w.id} lead={<span className="rm-eye"><Icon name="eye" size={14} /></span>} title={`${w.targetKey} ${w.label}`} sub={`Until ${new Date(w.expiresAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}`} onClick={() => pick('watching')} />)}
        </CalmRailCard>
      )}
      <CalmRailCard title="This week">
        <div className="rm-stats">
          <div><small>Done</small><b>{ins?.doneThisWeek ?? 0}</b></div>
          <div><small>On time</small><b>{ins ? `${ins.onTimePercent}%` : '—'}</b></div>
          <div><small>Usual</small><b>{ins?.usualTime ?? '—'}</b></div>
        </div>
        {(ins?.snoozedOften.length ?? 0) > 0 && (
          <p className="rm-note">Snoozed again and again: {ins!.snoozedOften.slice(0, 2).map((r) => `“${r.title}” (${r.snoozeCount}×)`).join(', ')}.{' '}
            <button type="button" className="rm-lk bl" onClick={() => setOpenId(ins!.snoozedOften[0].id)}>Do it now?</button></p>
        )}
      </CalmRailCard>
      <CalmRailCard>
        <p className="rm-note">
          {s?.autoEnabled === false ? 'Due dates do not remind you automatically.' : `Due dates remind you automatically (${leads.join(', then ')}).`}
          {s?.quietStart && s.quietEnd ? ` Quiet hours ${s.quietStart}–${s.quietEnd}.` : ''}{' '}
          <Link className="rm-lk bl" to="/settings/notifications/schedule">Settings</Link>{' '}
          <button type="button" className="rm-lk" onClick={() => pick('auto')}>See them ›</button>
        </p>
      </CalmRailCard>
    </aside>
  );

  return (
    <div className="rm-page" aria-label="Reminders">
      <div className="rm-top"><span className="rm-crumb">Reminders</span><CalmGo onClick={() => openReminderComposer()}>+ Reminder</CalmGo></div>
      <div className="rm-3">
        {side}
        <div className="rm-main">
          <div className="rm-h">
            <h1>{title}</h1><span className="rm-hn">{shown}</span>
            {view === 'today' && <button type="button" className="rm-lk" aria-pressed={showDone} onClick={() => setShowDone((v) => !v)}>{showDone ? 'Hide done' : 'Show done'}</button>}
          </div>
          {view !== 'watching' && view !== 'done' && view !== 'sent' && <QuickAdd defaultTime={s?.defaultTime ?? '09:00'} listHint={view.startsWith('list:') ? view.slice(5) : null} onAdded={() => refreshReminders(wid)} />}
          {view === 'watching' ? <WatchList items={watches.data ?? []} onStopped={() => void watches.refetch()} /> : (
            <div className="rm-card">
              {groups.length === 0 && <div className="rm-empty"><b>{view === 'today' ? 'Nothing left today.' : 'Nothing here.'}</b>{view === 'done' ? 'Tick a reminder off and it lands here for 30 days.' : 'Type one above in your own words, or use “Remind me” on any task.'}</div>}
              {groups.map((g) => (
                <section key={g.title} className="rm-grp" aria-label={g.title}>
                  <h3>{g.title}</h3>
                  {g.items.map((r) => (
                    <Row key={r.id} r={r} zone={zone} now={now} leaving={leaving.has(r.id)} sent={view === 'sent'} onDone={() => void complete(r)} onOpen={() => setOpenId(r.id)}
                      snoozing={snoozeFor === r.id} onSnooze={() => setSnoozeFor(snoozeFor === r.id ? null : r.id)} onPick={(c, u) => void snooze(r, c, u)} onCloseSnooze={() => setSnoozeFor(null)} />
                  ))}
                </section>
              ))}
            </div>
          )}
          {selected && (
            <Detail r={selected} zone={zone} phone={phone} onClose={() => setOpenId(null)} onDone={() => { setOpenId(null); void complete(selected); }}
              onSnooze={(c, u) => { setOpenId(null); void snooze(selected, c, u); }} onDelete={() => void remove(selected)} onMeta={(b) => void meta(selected, b)} onChange={(p) => void change(selected, p)}
              lists={lists.map(([n]) => n)} onNav={nav} />
          )}
        </div>
        {rail}
      </div>
    </div>
  );
}

function SideRow({ on, onClick, lead, label, n }: { on: boolean; onClick: () => void; lead: ReactNode; label: string; n: number }) {
  return <button type="button" className={`rm-srow${on ? ' on' : ''}`} aria-pressed={on} onClick={onClick}>{lead}<span>{label}</span><em>{n}</em></button>;
}

function Row({ r, zone, now, leaving, sent, onDone, onOpen, snoozing, onSnooze, onPick, onCloseSnooze }: {
  r: Reminder; zone: string; now: Date; leaving: boolean; sent: boolean; onDone: () => void; onOpen: () => void; snoozing: boolean; onSnooze: () => void;
  onPick: (c: SnoozePreset | 'free', until?: string) => void; onCloseSnooze: () => void;
}) {
  const done = r.state === 'Done';
  const w = at(r, zone);
  const late = !done && r.state === 'Fired';
  const time = done ? `${r.completedAt ? hhmm(wall(new Date(r.completedAt), zone)) : ''} · Done ✓` : w ? (sameDay(w, now) ? hhmm(w) : describeInstant(r.nextFireAt ?? r.lastFiredAt!, zone)) : '';
  const src = sent && r.for ? `To ${r.for.name.split(' ')[0]} · ${r.state === 'Fired' ? 'delivered' : 'waiting'}` : sourceText(r);
  return (
    <div className={`rm-row${done ? ' dn' : ''}${leaving ? ' gone' : ''}`}>
      <button type="button" className={`rm-ck${done || leaving ? ' ok' : ''}`} aria-label={done ? `Not done: ${r.title}` : `Done: ${r.title}`} disabled={sent} onClick={onDone}>
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M6 12.5l4 4 8-9" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <button type="button" className="rm-t" onClick={onOpen}>
        <b>{r.title}</b>
        <small><span className={late ? 'late' : ''}>{time}</span>{r.recurrenceText && <> · <Icon name="repeat" size={12} /> {r.recurrenceText}</>}{src && ` · ${src}`}{r.isSnoozed && !done ? ` · snoozed${r.snoozeCount > 1 ? ` ×${r.snoozeCount}` : ''}` : ''}</small>
      </button>
      {r.targetKey && <span className="rm-lch"><i style={{ background: projectColor(r.targetKey.split('-')[0]) }} />{r.targetKey}{r.source === 'Meeting' && r.targetTitle ? ` · ${r.targetTitle}` : ''}</span>}
      {r.flagged && <span className="rm-fl" aria-label="Flagged"><Icon name="flag" size={14} /></span>}
      {!done && !sent && <button type="button" className="rm-sz" aria-label={`Snooze ${r.title}`} aria-haspopup="menu" aria-expanded={snoozing} onClick={onSnooze}><Icon name="clock" size={15} /></button>}
      {snoozing && <SnoozeMenu zone={zone} onPick={onPick} onClose={onCloseSnooze} />}
    </div>
  );
}

function SnoozeMenu({ zone, onPick, onClose }: { zone: string; onPick: (c: SnoozePreset | 'free', until?: string) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [picking, setPicking] = useState(false);
  const [when, setWhen] = useState('');
  useEffect(() => {
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    requestAnimationFrame(() => box.current?.querySelector<HTMLButtonElement>('button')?.focus());
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [onClose]);
  return (
    <div ref={box} className="rm-snz" role="menu" aria-label="Snooze">
      {SNOOZE.map((c) => (
        <button key={c.id} type="button" role="menuitem" onClick={() => (c.id === 'pick' ? setPicking(true) : onPick(c.id))}>{c.label}</button>
      ))}
      {picking && (
        <div className="rm-pick">
          <input type="datetime-local" value={when} min={iso(wall(new Date(), zone))} onChange={(e) => setWhen(e.target.value)} aria-label="Snooze until" />
          <CalmGo disabled={!when} onClick={() => onPick('10m', when)}>Snooze</CalmGo>
        </div>
      )}
    </div>
  );
}

function Detail({ r, zone, phone, lists, onClose, onDone, onSnooze, onDelete, onMeta, onChange, onNav }: {
  r: Reminder; zone: string; phone: boolean; lists: string[]; onClose: () => void; onDone: () => void; onSnooze: (c: SnoozePreset | 'free', until?: string) => void;
  onDelete: () => void; onMeta: (b: { flagged?: boolean; list?: string }) => void; onChange: (p: { exact?: boolean; onlyIfOpen?: boolean }) => void; onNav: (to: string) => void;
}) {
  const [snz, setSnz] = useState(false);
  const [listText, setListText] = useState(r.list ?? '');
  useEffect(() => setListText(r.list ?? ''), [r.list]);
  const done = r.state === 'Done';
  const auto = AUTO.has(r.source);
  const when = r.nextFireAt ? describeInstant(r.nextFireAt, zone) : r.lastFiredAt ? `Went off ${describeInstant(r.lastFiredAt, zone)}` : r.anchorDays != null ? (r.anchorDays === 0 ? 'On the due date' : `${-r.anchorDays} days before due`) : '—';
  const body = (
    <>
      {(r.from || r.note) && <p className="rm-pop-from">{r.from ? `From ${r.from.name}` : ''}{r.from && r.note ? ' · ' : ''}{r.note ? `“${r.note}”` : ''}</p>}
      <div className="rm-prs">
        <Prop icon="alarm" k="When" v={when} act={!auto && r.canEdit ? <button type="button" className="rm-lk bl" onClick={() => onChange({ exact: !r.exact })}>{r.exact ? 'Exact time' : 'Working hours'}</button> : undefined} />
        <Prop icon="repeat" k="Repeat" v={r.recurrenceText ?? 'Never'} act={r.canEdit && !done ? <button type="button" className="rm-lk bl" onClick={() => { onClose(); openReminderComposer({ editing: r }); }}>Change</button> : undefined} />
        {r.targetKey && <Prop icon="link" k="Linked" v={<>{r.link ? <button type="button" className="rm-lk" onClick={() => onNav(r.link!)}>{r.targetKey}</button> : r.targetKey}{r.targetTitle ? ` · ${r.targetTitle}` : ''}</>}
          act={r.canEdit ? <button type="button" className="rm-lk bl" onClick={() => onChange({ onlyIfOpen: !r.onlyIfOpen })}>{r.onlyIfOpen ? 'Only while it’s open' : 'Even when it’s done'}</button> : undefined} />}
        <Prop icon="user" k="For" v={r.for ? r.for.name : 'Me'} act={<button type="button" className="rm-lk bl" onClick={() => { onClose(); openReminderComposer({ text: r.title, subject: r.targetId ? { type: r.targetType, id: r.targetId, title: r.targetTitle ?? r.title, key: r.targetKey } : undefined }); }}>Remind someone else</button>} />
        <Prop icon="list" k="List" v={
          <input className="rm-list-in" list="rm-lists" value={listText} placeholder="None" maxLength={40} aria-label="List" onChange={(e) => setListText(e.target.value)}
            onBlur={() => { if (listText.trim() !== (r.list ?? '')) onMeta({ list: listText.trim() }); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />} />
        <datalist id="rm-lists">{['Work', 'Home', ...lists].filter((v, i, a) => a.indexOf(v) === i).map((l) => <option key={l} value={l} />)}</datalist>
        <Prop icon="flag" k="Flag" v={r.flagged ? 'On' : 'Off'} act={<button type="button" className="rm-lk bl" role="switch" aria-checked={!!r.flagged} onClick={() => onMeta({ flagged: !r.flagged })}>{r.flagged ? 'Unflag' : 'Flag it'}</button>} />
        {r.snoozeCount > 0 && <Prop icon="clock" k="Snoozed" v={`${r.snoozeCount === 1 ? 'Once' : `${r.snoozeCount} times`}`} />}
      </div>
      <div className="rm-pop-acts">
        {done ? <CalmGo onClick={onDone}>Not done</CalmGo> : <CalmGo onClick={onDone}>Done</CalmGo>}
        {!done && <button type="button" className="rm-pill" aria-expanded={snz} onClick={() => setSnz((v) => !v)}><Icon name="clock" size={14} /> Snooze</button>}
        <span className="rm-sp" />
        <button type="button" className="rm-lk red" onClick={onDelete}>{r.source === 'Personal' ? 'Delete' : 'Dismiss'}</button>
        {snz && <SnoozeMenu zone={zone} onPick={(c, u) => onSnooze(c, u)} onClose={() => setSnz(false)} />}
      </div>
    </>
  );
  if (phone) return <CalmSheet open onClose={onClose} title={r.title} kind="bottom">{body}</CalmSheet>;
  return (
    <div className="rm-pop" role="dialog" aria-label={r.title}>
      <div className="rm-pop-h"><span className={`rm-ck${done ? ' ok' : ''}`} aria-hidden="true" /><b>{r.title}</b><button type="button" className="rm-x" onClick={onClose} aria-label="Close"><Icon name="close" size={13} /></button></div>
      {body}
    </div>
  );
}

function Prop({ icon, k, v, act }: { icon: IconName; k: string; v: ReactNode; act?: ReactNode }) {
  return <div className="rm-pr"><Icon name={icon} size={15} /><span className="rm-k">{k}</span><b>{v}</b>{act && <small>{act}</small>}</div>;
}

/** One line, plain words, with chips that say how it was read; Enter adds it. Without a time it opens the full form. */
function QuickAdd({ defaultTime, listHint, onAdded }: { defaultTime: string; listHint: string | null; onAdded: () => void }) {
  const zone = deviceZone();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [example, setExample] = useState(0);
  useEffect(() => { const t = setInterval(() => setExample((i) => (i + 1) % EXAMPLES.length), 4000); return () => clearInterval(t); }, []);
  const q = readQuick(text, wall(new Date(), zone), defaultTime);
  const ready = q.parsed && q.parsed.kind !== 'anchor' && q.parsed.title;
  const list = q.list ?? listHint;
  // The words that were read as time, a list or a flag are highlighted in the field itself.
  const marked = useMemo(() => {
    if (!text) return null;
    const titleWords = new Set((q.parsed?.title ?? q.words).toLowerCase().split(/\s+/));
    return text.split(/(\s+)/).map((w, i) => (/^\s+$/.test(w) || !w ? w : titleWords.has(w.toLowerCase()) && !w.startsWith('#') && w !== '!' ? w : <em key={i}>{w}</em>));
  }, [text, q.parsed, q.words]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) { openReminderComposer(text.trim() ? { text: q.words || text } : undefined); setText(''); return; }
    setBusy(true);
    try {
      const p = q.parsed!;
      const made = await reminderApi.create({ title: p.title, when: p.kind === 'free' ? { free: true, timeZone: zone } : p.kind === 'anchor' ? {} : { at: iso(p.local), timeZone: zone, recurrence: p.kind === 'repeat' ? toRRule(p.rule) : null } });
      if (list || q.flagged) await reminderApi.meta(made.id, { list: list ?? undefined, flagged: q.flagged || undefined });
      setText('');
      onAdded();
      toast(`✓ Reminder set · ${p.label}`, 'success');
    } catch (err) { toast(err instanceof ApiError ? err.errors[0]?.message ?? err.message : 'Could not add the reminder.', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <form className={`rm-qa-wrap${text ? ' live' : ''}`} onSubmit={submit}>
      <div className={`rm-qa${text ? '' : ' idle'}`}>
        <Icon name="plus" size={18} />
        <div className="rm-qa-f">
          <div className="rm-qa-mirror" aria-hidden="true">{marked}</div>
          <input id="rp-quick-input" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Remind me… “${EXAMPLES[example]}”`} aria-label="Add a reminder in plain words" maxLength={240} />
        </div>
        <button type="submit" className="rm-qa-go" disabled={busy} aria-label={ready ? 'Add this reminder' : 'More options'}>↵</button>
      </div>
      {text.trim().length > 2 && (
        <div className="rm-chips" aria-live="polite">
          {ready ? (
            <>
              <span className="rm-pc"><Icon name="alarm" size={13} /><b>{q.parsed!.kind === 'repeat' ? describeLocalShort(q.parsed!.local) : q.parsed!.label}</b></span>
              {q.parsed!.kind === 'repeat' && <span className="rm-pc"><Icon name="repeat" size={13} /><b>{q.parsed!.label.replace(/^./, (c) => c.toUpperCase())}</b></span>}
              {list && <span className="rm-pc"><i style={{ background: projectColor(list) }} /><b>{list}</b></span>}
              {q.flagged && <span className="rm-pc"><Icon name="flag" size={13} /><b>Flagged</b></span>}
              <button type="button" className="rm-pc quiet" onClick={() => { openReminderComposer({ text: q.words }); setText(''); }}>+ Link task</button>
              <span className="rm-hint">Or “when I’m free”, “2 days before due”</span>
            </>
          ) : <span className="rm-hint">Add when — “tomorrow 9am”, “in 2 hours”, “every Friday” — or press Enter for more options</span>}
        </div>
      )}
    </form>
  );
}

const describeLocalShort = (n: Date) => {
  const now = wall(new Date(), deviceZone());
  return `${sameDay(n, now) ? 'Today' : sameDay(n, addDays(now, 1)) ? 'Tomorrow' : n.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })} · ${hhmm(n)}`;
};

/** What the person asked to be told about, and what was found. Watches are made from the assistant ("tell me when ATL-12 is done"). */
function WatchList({ items, onStopped }: { items: Watch[]; onStopped: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const stop = async (w: Watch) => {
    setBusy(w.id);
    try { await watchApi.stop(w.id); toast(`Stopped watching ${w.targetKey}.`); onStopped(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not stop watching.', 'error'); }
    finally { setBusy(null); }
  };
  const active = items.filter((w) => w.state === 'active');
  const past = items.filter((w) => w.state !== 'active');
  return (
    <div className="rm-card" data-testid="watch-list">
      {items.length === 0 && <div className="rm-empty"><b>Not watching anything.</b>Ask Aura “tell me when ATL-12 is done” or “warn me if Atlas slips past Friday”. You get one notification, then it stops.</div>}
      {active.length > 0 && (
        <section className="rm-grp" aria-label="Watching"><h3>Watching</h3>
          {active.map((w) => (
            <div key={w.id} className="rm-row">
              <span className="rm-eye"><Icon name="eye" size={14} /></span>
              <span className="rm-t static"><b>Tell me {w.label}</b><small>{w.link ? <Link to={w.link}>{w.targetTitle}</Link> : w.targetTitle}{w.note ? ` · “${w.note}”` : ''} · until {new Date(w.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</small></span>
              <button type="button" className="rm-pill" disabled={busy === w.id} onClick={() => void stop(w)}>Stop</button>
            </div>
          ))}
        </section>
      )}
      {past.length > 0 && (
        <section className="rm-grp" aria-label="Recently"><h3>Recently</h3>
          {past.map((w) => (
            <div key={w.id} className="rm-row">
              <span className="rm-eye"><Icon name={w.state === 'fired' ? 'bell' : 'eyeOff'} size={14} /></span>
              <span className="rm-t static"><b>{w.outcome ?? `Stopped: ${w.label}`}</b><small>{w.link ? <Link to={w.link}>{w.targetKey} {w.targetTitle}</Link> : `${w.targetKey} ${w.targetTitle}`}</small></span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
