import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { meApi, notificationApi, pushApi } from '../../api/endpoints';
import type { AppNotification, NotificationPreference, NotificationType, TestEmailResult } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { EmptyState, ErrorState, PageLoader, Pager, Segmented } from '../../components/ui';
import { TimeZonePicker } from '../../components/TimeZonePicker';
import { formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useDetailsDismiss, useWsQuery } from '../../lib/hooks';
import { playSound, setSoundOn, soundOn, unlockSound } from '../../lib/attention';
import { deviceZone, formatInZone, isoDateIn, useAppZone, zoneCity, zoneOffsetLabel, zoneToday, shiftIsoDate } from '../../lib/zone';
import { isDesktopApp } from '../../lib/desktop';
import { isNativeApp } from '../../lib/native';
import { queryClient, useAuth, useCan, useIsPersonal, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { reminderApi, type ReminderSettings } from '../reminders/api';
import { refreshReminders } from '../reminders/store';
import { addMinutes, iso, wall } from '../reminders/time';
import { deviceDetail, disableDeviceAlerts, enableDeviceAlerts, lastDeviceError, onDeviceAlerts, systemNotification, type DeviceAlerts, type DeviceDetail } from '../reminders/device';
import { WhatsAppContactSection } from '../settings/WhatsAppContactSection';
import { whatsAppPrefsUrl, type WhatsAppPreferences } from '../settings/WhatsAppNotificationPreferences';
import { get } from '../../api/client';
import { AlertSettings } from './centre/AlertSettings';
import { NotificationActions, snoozeChoices } from './NotificationActions';

export type NotificationSection = 'inbox' | 'preferences' | 'devices' | 'schedule';

// ------------------------------------------------------------------ categories

type Category = 'work' | 'operations' | 'reminders' | 'messages' | 'account';
const CATEGORY: Record<Category, { label: string; icon: IconName; types: NotificationType[] }> = {
  work: { label: 'Work', icon: 'kanban', types: ['TaskAssigned', 'TaskUpdated', 'Comment', 'Issue', 'Approval', 'ProjectUpdated', 'Document', 'Meeting', 'ReportReady', 'AgentAlert', 'AgentDigest', 'TimesheetReminder'] },
  operations: { label: 'Operations & support', icon: 'bolt', types: ['ServiceLevel', 'Support'] },
  reminders: { label: 'Reminders & due dates', icon: 'alarm', types: ['DueSoon', 'Overdue', 'Reminder', 'Nudge', 'Briefing', 'PortfolioDigest', 'CertificationExpiry'] },
  messages: { label: 'Messages, mentions & calls', icon: 'message', types: ['Message', 'Mention', 'Call'] },
  account: { label: 'Account & workspace', icon: 'shield', types: ['Invitation', 'Subscription', 'Security'] },
};
/** The tone of each kind's icon tile: the colour says what kind of thing it is, the words say the rest. */
const CATEGORY_TONE: Record<Category, string> = { work: '', operations: 'violet', reminders: 'warning', messages: 'neutral', account: 'success' };
const categoryOf = (t: NotificationType): Category =>
  (Object.keys(CATEGORY) as Category[]).find((c) => CATEGORY[c].types.includes(t)) ?? 'work';

const TYPE_ICON: Partial<Record<NotificationType, IconName>> = {
  TaskAssigned: 'userPlus', TaskUpdated: 'edit', Comment: 'message', Mention: 'message', Message: 'message', DueSoon: 'clock', Overdue: 'alert',
  Reminder: 'alarm', Nudge: 'alarm', Briefing: 'sun', PortfolioDigest: 'chart', Invitation: 'mail', Subscription: 'card', Security: 'lock',
  ReportReady: 'download', Issue: 'bug', Approval: 'checks', ServiceLevel: 'gauge', Document: 'note', Meeting: 'video', ProjectUpdated: 'folder',
  CertificationExpiry: 'star', Support: 'message', AgentAlert: 'radar', AgentDigest: 'sparkle', TimesheetReminder: 'timer', Call: 'video',
};

// ------------------------------------------------------------------ page

/**
 * Notifications, as Settings › Notifications shows them: what arrived (History), where each kind of event reaches you (Delivery), this
 * device's pop-ups, push and sound (This device), and when things happen: your time zone, working hours, quiet hours and the morning briefing
 * (Schedule). Settings gives the title and the tabs; this is the body of one tab.
 */
export function NotificationCenterPage({ section }: { section: NotificationSection }) {
  return (
    <div className="nc-page embedded">
      {section === 'inbox' && <Inbox />}
      {section === 'preferences' && <Delivery />}
      {section === 'devices' && <ThisDevice />}
      {section === 'schedule' && <Schedule />}
    </div>
  );
}

function Panel({ title, sub, icon, actions, children, className = '' }: { title: string; sub?: ReactNode; icon?: IconName; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`nc-panel ${className}`}>
      <header className="nc-panel-head">
        {icon && <span className="nc-panel-ico"><Icon name={icon} size={16} /></span>}
        <div className="nc-panel-titles"><h3>{title}</h3>{sub && <p>{sub}</p>}</div>
        {actions && <div className="nc-panel-actions">{actions}</div>}
      </header>
      <div className="nc-panel-body">{children}</div>
    </section>
  );
}

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />;
}

// ------------------------------------------------------------------ inbox

function dayHeading(isoDay: string) {
  const today = zoneToday();
  if (isoDay === today) return 'Today';
  if (isoDay === shiftIsoDate(today, -1)) return 'Yesterday';
  return formatInZone(new Date(`${isoDay}T12:00:00Z`), { weekday: 'long', day: 'numeric', month: 'long' }, 'UTC');
}

/** One line per kind: why this reached the person, so a notice never feels random. */
const WHY: Record<NotificationType, string> = {
  TaskAssigned: 'You are the assignee of this task.',
  Mention: 'Someone mentioned you with @.',
  Comment: 'Someone commented on work you are assigned to or follow.',
  DueSoon: 'Work assigned to you is due soon (your automatic reminders).',
  Overdue: 'Work assigned to you is past its due date.',
  Invitation: 'Someone invited you to a workspace or project.',
  Subscription: 'You look after this workspace\'s plan and billing.',
  Security: 'Something happened on your account. Security notices always reach you.',
  ReportReady: 'A report or export you asked for is ready.',
  Issue: 'An issue you raised, own or follow changed.',
  Approval: 'Your approval is asked for, or one you asked for was decided.',
  ServiceLevel: 'A ticket you are responsible for is close to, or past, its response time.',
  Reminder: 'A reminder you or a teammate set.',
  Nudge: 'A teammate reminded you about your work.',
  Briefing: 'Your morning briefing, at the time set in Schedule.',
  Message: 'A chat message for you that you had not seen.',
  PortfolioDigest: 'The digest for projects you lead or follow.',
  Document: 'A document you own, review or follow changed.',
  Meeting: 'A meeting you are invited to, or its notes.',
  Call: 'Someone called you in Project Tracker, or you missed their call.',
  TaskUpdated: 'A task assigned to you changed (priority, due date or status).',
  ProjectUpdated: 'A project you are a member of changed.',
  CertificationExpiry: 'A certification you hold or manage is about to expire.',
  AgentAlert: 'An AI agent you set up found something.',
  AgentDigest: 'A summary from an AI agent you set up.',
  TimesheetReminder: 'Your timesheet for the week is not submitted yet.',
  Support: 'A support conversation you are part of has a reply.',
};

type Lane = 'needs' | 'info' | 'snoozed' | 'archived';

/** Notices about the same thing on the same day are one row: the newest on top, the rest behind "+n". */
interface Bundle { key: string; head: AppNotification; rest: AppNotification[] }
function bundle(items: AppNotification[]): Bundle[] {
  const out: Bundle[] = [];
  const byLink = new Map<string, Bundle>();
  for (const n of items) {
    const b = n.link ? byLink.get(n.link) : undefined;
    if (b) { b.rest.push(n); continue; }
    const nb: Bundle = { key: n.id, head: n, rest: [] };
    out.push(nb);
    if (n.link) byLink.set(n.link, nb);
  }
  return out;
}

function Inbox() {
  const wid = useWorkspaceId();
  const nav = useNavigate();
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [picked, setPicked] = useState<Lane | null>(null);
  const [cat, setCat] = useState<Category | 'all'>('all');
  const [why, setWhy] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useAppZone();   // re-group when the zone changes
  const counts = useWsQuery(['notifications', 'counts'], notificationApi.counts, { refetchInterval: 60_000 });
  // Until the person picks, open the lane that has something in it: what needs them first.
  const lane: Lane = picked ?? (counts.data && counts.data.needsYou === 0 && counts.data.forInfo > 0 ? 'info' : 'needs');
  const q = useWsQuery(['notifications', 'page', lane, page, unreadOnly], () =>
    notificationApi.list(page, unreadOnly && lane !== 'archived' && lane !== 'snoozed', lane === 'archived' ? undefined : lane, lane === 'archived'), { placeholderData: (p) => p });
  const refresh = () => invalidateWorkspace(wid, 'notifications');
  const readAll = useMutation({ mutationFn: notificationApi.readAll, onSuccess: () => { refresh(); toast('All caught up.', 'success'); } });
  const clearRead = useMutation({
    mutationFn: notificationApi.archiveRead,
    onSuccess: (r) => { refresh(); toast(r.archived ? `Archived ${r.archived} read notification${r.archived === 1 ? '' : 's'}.` : 'Nothing read to clear.', 'success'); },
  });

  const read = async (ns: AppNotification[]) => {
    const unread = ns.filter((n) => !n.isRead);
    if (!unread.length) return;
    await Promise.all(unread.map((n) => notificationApi.read(n.id).catch(() => undefined)));
    refresh();
  };
  const go = async (n: AppNotification, all: AppNotification[]) => { await read(all); if (n.link) nav(n.link); };
  const archive = async (ns: AppNotification[]) => {
    await Promise.all(ns.map((n) => notificationApi.archive(n.id).catch(() => undefined)));
    refresh();
    toast(ns.length === 1 ? 'Archived.' : `Archived ${ns.length}.`, 'success', {
      label: 'Undo', onClick: () => void Promise.all(ns.map((n) => notificationApi.unarchive(n.id).catch(() => undefined))).then(refresh),
    });
  };
  const unarchive = async (ns: AppNotification[]) => {
    await Promise.all(ns.map((n) => notificationApi.unarchive(n.id).catch(() => undefined)));
    refresh();
    toast('Back in your inbox.', 'success');
  };
  const snooze = async (ns: AppNotification[], until: Date) => {
    try {
      await Promise.all(ns.map((n) => notificationApi.act(n.id, 'snooze', { until: until.toISOString() })));
      refresh();
      toast(`Snoozed until ${formatDateTime(until.toISOString())}.`, 'success', {
        label: 'Undo', onClick: () => void Promise.all(ns.map((n) => notificationApi.act(n.id, 'wake').catch(() => undefined))).then(refresh),
      });
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not snooze it.', 'error'); }
  };
  const wake = async (n: AppNotification) => { await notificationApi.act(n.id, 'wake').catch(() => undefined); refresh(); toast('Back in your inbox.', 'success'); };
  const mute = async (type: NotificationType) => {
    try {
      const prefs = await queryClient.fetchQuery({ queryKey: PREFS_KEY, queryFn: meApi.notificationPrefs });
      const p = prefs.find((x) => x.type === type);
      if (!p) return;
      if (p.locked) { toast(`${p.label} can't be muted: it keeps your account safe.`, 'info'); return; }
      const before = { type, inApp: p.inApp, email: p.email, browser: p.browser };
      const saved = await meApi.setNotificationPrefs([{ ...before, inApp: false, browser: false }]);
      queryClient.setQueryData(PREFS_KEY, saved);
      toast(`Muted “${p.label}” in the app and on your devices.${p.email ? ' Email still comes.' : ''}`, 'success', {
        label: 'Undo', onClick: () => void meApi.setNotificationPrefs([before]).then((d) => { queryClient.setQueryData(PREFS_KEY, d); toast('Unmuted.', 'success'); }),
      });
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not mute this kind of notification.', 'error'); }
  };

  const items = useMemo(() => (q.data?.items ?? []).filter((n) => cat === 'all' || categoryOf(n.type) === cat), [q.data, cat]);
  const days = useMemo(() => {
    const out: { day: string; items: AppNotification[] }[] = [];
    for (const n of items) {
      const day = isoDateIn(new Date(n.shownAt ?? n.createdAt));
      const last = out[out.length - 1];
      if (last?.day === day) last.items.push(n); else out.push({ day, items: [n] });
    }
    return out.map((d) => ({ day: d.day, bundles: bundle(d.items) }));
  }, [items]);

  const pick = (l: Lane) => { setPicked(l); setPage(1); setWhy(null); };
  const c = counts.data;
  const LANES: { id: Lane; label: string; count?: number }[] = [
    { id: 'needs', label: 'Needs you', count: c?.needsYou },
    { id: 'info', label: 'Updates', count: c?.forInfo },
    ...(c?.snoozed || lane === 'snoozed' ? [{ id: 'snoozed' as Lane, label: 'Snoozed', count: c?.snoozed }] : []),
    { id: 'archived', label: 'Archived' },
  ];
  const empty = lane === 'needs'
    ? { title: 'Nothing needs you right now', text: 'Assignments, mentions, approvals, reminders and messages for you land here first.' }
    : lane === 'info' ? { title: 'No updates', text: 'Changes, comments, digests and reports you follow show up here.' }
      : lane === 'snoozed' ? { title: 'Nothing snoozed', text: 'Snoozed notifications wait here and come back on top when their time comes.' }
      : { title: 'Nothing archived', text: 'Archive a notification to put it away. It stays findable here.' };

  return (
    <>
      <div className="nc-toolbar">
        <Segmented label="Inbox" value={lane} onChange={pick} className="nc-lanes"
          options={LANES.map((l) => ({ id: l.id, label: l.label, count: l.count || undefined }))} />
        {lane !== 'archived' && lane !== 'snoozed' && (
          <div className="nc-readall">
            <button className="btn btn-ghost btn-sm" disabled={readAll.isPending} onClick={() => readAll.mutate()}><Icon name="checks" size={14} /> Mark all read</button>
            <button className="btn btn-ghost btn-sm" disabled={clearRead.isPending} onClick={() => clearRead.mutate()} title="Archive everything already read"><Icon name="inbox" size={14} /> Clear read</button>
          </div>
        )}
      </div>
      <div className="nc-filters ds-chips" role="group" aria-label="Kind">
        <button type="button" className={`ds-chip ${cat === 'all' ? 'on' : ''}`} aria-pressed={cat === 'all'} onClick={() => setCat('all')}>All kinds</button>
        {(Object.keys(CATEGORY) as Category[]).map((k) => (
          <button key={k} type="button" className={`ds-chip ${cat === k ? 'on' : ''}`} aria-pressed={cat === k} onClick={() => setCat(k)}>{CATEGORY[k].label}</button>
        ))}
        {lane !== 'archived' && lane !== 'snoozed' && (
          <button type="button" className={`ds-chip nc-unread ${unreadOnly ? 'on' : ''}`} aria-pressed={unreadOnly} onClick={() => { setUnreadOnly(!unreadOnly); setPage(1); }}>
            <span className="nc-unread-dot" aria-hidden="true" />Unread only
          </button>
        )}
      </div>

      {q.isLoading ? <PageLoader /> : q.isError || !q.data ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
        <div className="nc-inbox">
          {days.length === 0 ? (
            <EmptyState icon={lane === 'archived' ? 'inbox' : 'bell'} title={unreadOnly && lane !== 'archived' ? "You're all caught up" : empty.title} text={empty.text} />
          ) : days.map((d) => (
            <div key={d.day} className="nc-day">
              <div className="nc-day-head">{dayHeading(d.day)}</div>
              <ul className="nc-list">
                {d.bundles.map((b) => {
                  const n = b.head;
                  const all = [n, ...b.rest];
                  const k = categoryOf(n.type);
                  const unread = all.some((x) => !x.isRead);
                  const expanded = open.has(b.key);
                  return (
                    <li key={b.key} className={`nc-item cat-${k} ${unread ? 'unread' : ''} ${n.needsYou ? 'needs' : ''}`}>
                      <div className="nc-item-row">
                        <button className="nc-item-main" onClick={() => void go(n, all)}>
                          <span className={`nc-item-ico ds-tile-ico ${CATEGORY_TONE[k]}`}>{unread && <i className="nc-dot" aria-label="Unread" />}<Icon name={TYPE_ICON[n.type] ?? 'bell'} size={16} /></span>
                          <span className="nc-item-text">
                            <b>{n.title}</b>
                            {n.reason && <span className="nc-item-reason" data-testid="nc-reason">{n.reason}</span>}
                            {n.body && <span className="nc-item-body">{n.body}</span>}
                            <span className="nc-item-meta"><span>{CATEGORY[k].label}</span>
                              {n.snoozedUntil && <> · <span className="nc-back">back {formatDateTime(n.snoozedUntil)}</span></>}</span>
                          </span>
                        </button>
                        {b.rest.length > 0 && (
                          <button className="nc-more" aria-expanded={expanded} onClick={() => setOpen((s) => { const x = new Set(s); if (x.has(b.key)) x.delete(b.key); else x.add(b.key); return x; })}>
                            +{b.rest.length}
                          </button>
                        )}
                        {/* The end of the row: the time, and in its place (on hover or focus) the row's own actions. */}
                        <span className="nc-item-end">
                        <time className="nc-item-time" title={formatDateTime(n.createdAt)} dateTime={n.createdAt}>{timeAgo(n.createdAt)}</time>
                        <span className="nc-item-acts">
                          {lane === 'snoozed' && <button className="btn-icon" aria-label="Bring back now" title="Bring back now" onClick={() => void wake(n)}><Icon name="bell" size={14} /></button>}
                          {unread && lane !== 'archived' && lane !== 'snoozed' && (
                            <button className="btn-icon" aria-label="Mark as read" title="Mark as read" onClick={() => void read(all)}><Icon name="tick" size={14} /></button>
                          )}
                          {lane === 'archived'
                            ? <button className="btn-icon" aria-label="Move to inbox" title="Move to inbox" onClick={() => void unarchive(all)}><Icon name="undo" size={14} /></button>
                            : <button className="btn-icon" aria-label="Archive" title="Archive" onClick={() => void archive(all)}><Icon name="inbox" size={14} /></button>}
                          <ItemMenu label={n.title} onWhy={() => setWhy(why === b.key ? null : b.key)} onMute={() => void mute(n.type)}
                            onSnooze={lane !== 'archived' && lane !== 'snoozed' ? (until) => void snooze(all, until) : undefined}
                            onRead={unread && lane !== 'archived' ? () => void read(all) : undefined}
                            onArchive={lane === 'archived' ? undefined : () => void archive(all)} onRestore={lane === 'archived' ? () => void unarchive(all) : undefined} />
                        </span>
                        </span>
                      </div>
                      {lane !== 'archived' && lane !== 'snoozed' && <NotificationActions n={n} withSnooze={false} />}
                      {why === b.key && (
                        <p className="nc-why" role="note"><Icon name="info" size={13} /> {WHY[n.type] ?? 'This reached you because of your delivery settings.'}{' '}
                          <button className="link-btn" onClick={() => nav('/settings/notifications/delivery')}>Change where this reaches you</button></p>
                      )}
                      {expanded && (
                        <ul className="nc-sub">
                          {b.rest.map((r) => (
                            <li key={r.id} className={r.isRead ? '' : 'unread'}>
                              <button onClick={() => void go(r, [r])}><b>{r.title}</b>{r.body && <span> · {r.body}</span>}
                                <time dateTime={r.createdAt}>{timeAgo(r.createdAt)}</time></button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          <Pager page={q.data.page} totalPages={q.data.totalPages} totalItems={q.data.totalItems} onPage={setPage} />
        </div>
      )}
    </>
  );
}

/** The quieter actions of a notification: why it came, and muting its kind. */
function ItemMenu({ label, onWhy, onMute, onRead, onArchive, onRestore, onSnooze }: {
  label: string; onWhy: () => void; onMute: () => void; onRead?: () => void; onArchive?: () => void; onRestore?: () => void; onSnooze?: (until: Date) => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useDetailsDismiss(ref);
  const close = () => { if (ref.current) ref.current.open = false; };
  return (
    <details className="nc-menu" ref={ref}>
      <summary className="btn-icon" aria-label={`More for ${label}`} title="More"><Icon name="more" size={14} /></summary>
      <div className="nc-menu-pop" role="menu">
        {/* On a phone the row has no room for separate buttons: reading and archiving live here too. */}
        {onRead && <button role="menuitem" className="nc-phone-only" onClick={() => { close(); onRead(); }}><Icon name="tick" size={13} /> Mark as read</button>}
        {onArchive && <button role="menuitem" className="nc-phone-only" onClick={() => { close(); onArchive(); }}><Icon name="inbox" size={13} /> Archive</button>}
        {onRestore && <button role="menuitem" className="nc-phone-only" onClick={() => { close(); onRestore(); }}><Icon name="undo" size={13} /> Move to inbox</button>}
        {onSnooze && <div className="nc-menu-group" role="group" aria-label="Snooze">
          <span className="nc-menu-label"><Icon name="clock" size={12} /> Snooze</span>
          {snoozeChoices().map((c) => <button key={c.label} role="menuitem" onClick={() => { close(); onSnooze(c.until); }}>{c.label}</button>)}
        </div>}
        <button role="menuitem" onClick={() => { close(); onWhy(); }}><Icon name="info" size={13} /> Why am I getting this?</button>
        <button role="menuitem" onClick={() => { close(); onMute(); }}><Icon name="eyeOff" size={13} /> Mute this kind</button>
      </div>
    </details>
  );
}

// ------------------------------------------------------------------ delivery

const PREFS_KEY = ['notification-prefs'];
type Channel = 'inApp' | 'email' | 'browser';
const CHANNELS: { id: Channel; label: string; icon: IconName; hint: string }[] = [
  { id: 'inApp', label: 'In the app', icon: 'bell', hint: 'The bell and this Inbox' },
  { id: 'email', label: 'Email', icon: 'mail', hint: 'To your sign-in address' },
  { id: 'browser', label: 'Push', icon: 'monitor', hint: 'Pop-ups on your devices' },
];

/** Which notification kinds WhatsApp can carry, and the WhatsApp preference that switches each on. */
const WHATSAPP_OF: Partial<Record<NotificationType, keyof WhatsAppPreferences>> = {
  TaskAssigned: 'taskAssignments', Overdue: 'overdue', TaskUpdated: 'supportUpdates', Reminder: 'reminders', Approval: 'approvals',
};

function Delivery() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: PREFS_KEY, queryFn: meApi.notificationPrefs });
  const userId = useAuth((st) => st.ctx?.user.id);
  // The WhatsApp column appears where WhatsApp can be used: an organization with WhatsApp connected and the person's number linked (or already opted in).
  const wa = useWsQuery(['account', 'whatsapp-contact', 'notification-preferences', userId], () => get<WhatsAppPreferences>(whatsAppPrefsUrl), { retry: false });
  const showWa = !!wa.data && (wa.data.canEnable || wa.data.optedIn);
  const toWhatsApp = () => document.getElementById('whatsapp-notifications-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    ?? document.getElementById('whatsapp-contact-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const [draft, setDraft] = useState<NotificationPreference[] | null>(null);
  const [test, setTest] = useState<TestEmailResult | null>(null);
  const device = useDevice();
  useEffect(() => { if (q.data && !draft) setDraft(q.data); }, [q.data, draft]);
  const dirty = useMemo(() => !!draft && !!q.data && JSON.stringify(draft) !== JSON.stringify(q.data), [draft, q.data]);

  const save = useMutation({
    mutationFn: () => meApi.setNotificationPrefs(draft!.map(({ type, inApp, email, browser }) => ({ type, inApp, email, browser }))),
    onSuccess: (data) => { queryClient.setQueryData(PREFS_KEY, data); setDraft(data); toast('Delivery settings saved.', 'success'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not save your delivery settings.', 'error'),
  });
  const sendTest = useMutation({
    mutationFn: meApi.testEmail,
    onSuccess: (r) => setTest(r),
    onError: (e) => setTest({ provider: '', delivered: false, message: e instanceof ApiError ? e.message : 'Could not send the test email.' }),
  });

  if (q.isLoading || !draft) return q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : <PageLoader />;

  const set = (type: string, ch: Channel, v: boolean) => setDraft((rows) => rows && rows.map((r) => {
    if (r.type !== type || r.locked) return r;
    const next = { ...r, [ch]: v };
    if (ch === 'inApp' && !v) next.browser = false;   // push is the in-app notice delivered outside the app
    if (ch === 'browser' && v) next.inApp = true;
    return next;
  }));
  const setColumn = (ch: Channel, v: boolean, types?: NotificationType[]) =>
    draft.filter((r) => !r.locked && (!types || types.includes(r.type))).forEach((r) => set(r.type, ch, v));

  const grouped = (Object.keys(CATEGORY) as Category[]).map((c) => ({ c, rows: draft.filter((r) => categoryOf(r.type) === c) })).filter((g) => g.rows.length);
  const pushReady = device?.state === 'on' || device?.state === 'tab-only';

  return (
    <>
      {!pushReady && device && (
        <div className={`nc-callout is-${device.state}`} role="note">
          <Icon name="monitor" size={16} />
          <span><b>Push is off on this device.</b> Ticked Push events still reach your other devices; turn it on here to get pop-ups on this one too.</span>
          <button className="btn btn-primary btn-sm" onClick={() => nav('/settings/notifications/device')}>Set up this device</button>
        </div>
      )}

      <Panel title="Where each event reaches you" icon="send" sub="Events you switch off everywhere are not sent at all. Security notices always reach you."
        actions={<button className="btn btn-primary btn-sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending && <span className="spinner" />}Save changes</button>}>
        <div className={`nc-matrix${showWa ? ' with-wa' : ''}`} role="table" aria-label="Notification delivery">
          <div className="nc-matrix-row nc-matrix-head" role="row">
            <span role="columnheader">Event</span>
            {CHANNELS.map((ch) => {
              const editable = draft.filter((r) => !r.locked);
              const all = editable.length > 0 && editable.every((r) => r[ch.id]);
              return (
                <span role="columnheader" key={ch.id} className="nc-matrix-col">
                  <Icon name={ch.icon} size={14} /><span>{ch.label}</span>
                  <button className="nc-col-toggle" onClick={() => setColumn(ch.id, !all)} title={all ? `Turn ${ch.label} off for everything` : `Turn ${ch.label} on for everything`}>{all ? 'None' : 'All'}</button>
                </span>
              );
            })}
            {showWa && (
              <span role="columnheader" className="nc-matrix-col">
                <Icon name="message" size={14} /><span>WhatsApp</span>
                <button className="nc-col-toggle" onClick={toWhatsApp} title="WhatsApp has its own consent and quiet hours: change it below">Change</button>
              </span>
            )}
          </div>
          {grouped.map(({ c, rows }) => (
            <div key={c} className="nc-matrix-group" role="rowgroup">
              <div className="nc-matrix-groupname"><Icon name={CATEGORY[c].icon} size={14} /> {CATEGORY[c].label}</div>
              {rows.map((r) => (
                <div key={r.type} className={`nc-matrix-row ${r.locked ? 'locked' : ''}`} role="row">
                  <span role="cell" className="nc-matrix-event"><b>{r.label}</b><small>{r.description}</small></span>
                  {CHANNELS.map((ch) => (
                    <span role="cell" key={ch.id} className="nc-matrix-cell">
                      <Switch on={!!r[ch.id]} label={`${r.label}: ${ch.label}`} disabled={r.locked} onChange={(v) => set(r.type, ch.id, v)} />
                    </span>
                  ))}
                  {showWa && (() => {
                    const key = WHATSAPP_OF[r.type];
                    const on = !!key && !!wa.data?.optedIn && !!wa.data[key];
                    return (
                      <span role="cell" className="nc-matrix-cell">
                        {key ? <button type="button" className={`nc-wa ${on ? 'on' : ''}`} onClick={toWhatsApp} aria-label={`${r.label}: WhatsApp ${on ? 'on' : 'off'}. Change below.`}
                          title={r.type === 'TaskUpdated' ? 'Support tickets only' : undefined}>{on ? 'On' : 'Off'}</button>
                          : <span className="nc-wa-na" title="WhatsApp only carries a few kinds of notification, with fixed approved messages">—</span>}
                      </span>
                    );
                  })()}
                </div>
              ))}
            </div>
          ))}
        </div>
        {dirty && <div className="nc-savebar"><span>You have unsaved changes.</span><button className="btn btn-ghost btn-sm" onClick={() => setDraft(q.data!)}>Discard</button><button className="btn btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate()}>Save changes</button></div>}
      </Panel>

      <Panel title="Email" icon="mail" sub="Check that messages from Project Tracker reach your inbox (and not spam)."
        actions={<button className="btn btn-ghost btn-sm" disabled={sendTest.isPending} onClick={() => { setTest(null); sendTest.mutate(); }}>{sendTest.isPending && <span className="spinner" />}<Icon name="send" size={13} /> Send test email</button>}>
        {test ? <div className={test.delivered ? 'nc-result ok' : 'nc-result bad'} role="status"><Icon name={test.delivered ? 'checkCircle' : 'alert'} size={15} /> {test.message}</div>
          : <p className="nc-muted">Emails are sent from the address your administrator configured. Unread chat messages and mentions are emailed only if you have not seen them in the app.</p>}
      </Panel>

      <div id="whatsapp-settings"><WhatsAppContactSection /></div>
    </>
  );
}

// ------------------------------------------------------------------ this device

function useDevice() {
  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => void deviceDetail().then((d) => { if (live) setDetail(d); });
    load();
    const off = onDeviceAlerts(load);
    // The person may change the permission in the browser's own settings: check again when they come back to the tab.
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { live = false; off(); window.removeEventListener('focus', onFocus); };
  }, []);
  return detail;
}

const STATE_COPY: Record<DeviceAlerts, { title: string; text: string; tone: string }> = {
  on: { title: 'Notifications are on', text: 'Pop-ups and push reach this device, also when Project Tracker is closed.', tone: 'ok' },
  'tab-only': { title: 'Only while Project Tracker is open', text: 'Pop-ups show while a Project Tracker tab is open. Push is what brings them when it is closed.', tone: 'warn' },
  off: { title: 'Notifications are off', text: 'Reminders, mentions and messages only show inside the app on this device.', tone: 'off' },
  blocked: { title: 'Blocked for this site', text: 'The browser is refusing notifications from Project Tracker.', tone: 'bad' },
  unsupported: { title: 'Not supported here', text: 'This browser cannot show notifications.', tone: 'bad' },
};

function browserName() {
  const ua = navigator.userAgent;
  return /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'your browser';
}

function ThisDevice() {
  const wid = useWorkspaceId();
  const nav = useNavigate();
  const detail = useDevice();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sound, setSound] = useState(soundOn());
  const devices = useQuery({ queryKey: ['push-status'], queryFn: pushApi.status, retry: false });

  const turnOn = async () => {
    setBusy(true); setError(null); unlockSound();
    try {
      const s = await enableDeviceAlerts();
      const why = lastDeviceError();
      if (s === 'on' || s === 'tab-only') {
        if (soundOn()) playSound('urgent');
        const shown = await systemNotification('Notifications are on', 'This is how reminders and messages will reach you.', 'pt-test', '/settings/notifications/device', { sticky: false });
        toast(s === 'on' ? 'Done. Notifications reach this device even when Project Tracker is closed.' : 'Done. Notifications show while Project Tracker is open.', 'success');
        if (!shown) setError('Permission is granted, but the system did not show the test pop-up. Check your operating system\'s notification settings (below).');
        else if (why) setError(why);
      } else setError(why ?? STATE_COPY[s].text);
      void devices.refetch();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not turn notifications on.'); }
    finally { setBusy(false); }
  };
  const turnOff = async () => { setBusy(true); try { await disableDeviceAlerts(); toast('Push is off for this device.'); void devices.refetch(); } finally { setBusy(false); } };
  const testNow = async () => {
    unlockSound(); if (soundOn()) playSound('update');
    const ok = await systemNotification('Test notification', 'If you can see this, pop-ups work on this device.', 'pt-test-now', '/settings/notifications/device', { sticky: false });
    if (!ok) setError('The browser did not show the pop-up. Turn notifications on above, or check the system settings below.');
  };
  const testReminder = useMutation({
    mutationFn: async () => {
      const zone = useAuth.getState().ctx?.user.timeZone || deviceZone();
      await reminderApi.create({ title: 'Test reminder', note: 'Switch to another app - it will find you there.', when: { at: iso(addMinutes(wall(new Date(), zone), 2)), timeZone: zone } });
      await refreshReminders(wid);
    },
    onSuccess: () => toast('A test reminder will go off in about 2 minutes. Switch to another app or close this tab to see push arrive.', 'success'),
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not set the test reminder.', 'error'),
  });

  if (!detail) return <PageLoader />;
  const copy = STATE_COPY[detail.state];
  const canTurnOn = detail.canFixHere && (detail.state === 'off' || detail.state === 'tab-only');
  const where = isNativeApp() ? 'the Android app' : isDesktopApp() ? 'the desktop app' : browserName();

  return (
    <>
      <section className={`nc-device tone-${copy.tone}`}>
        <div className="nc-device-visual" aria-hidden><Icon name={detail.state === 'on' ? 'bell' : detail.state === 'blocked' ? 'lock' : 'monitor'} size={28} /></div>
        <div className="nc-device-main">
          <span className="nc-kicker">This device · {where}</span>
          <h3>{copy.title}</h3>
          <p>{detail.reason ?? copy.text}</p>
          <div className="nc-device-actions">
            {canTurnOn && <button className="btn btn-primary" disabled={busy} onClick={() => void turnOn()}>{busy && <span className="spinner" />}<Icon name="bell" size={15} /> {detail.state === 'tab-only' ? 'Turn on push' : 'Turn on notifications'}</button>}
            {detail.state === 'on' && !isDesktopApp() && <button className="btn btn-ghost" disabled={busy} onClick={() => void turnOff()}>Turn off push here</button>}
            {(detail.state === 'on' || detail.state === 'tab-only') && <button className="btn btn-ghost" onClick={() => void testNow()}><Icon name="play" size={13} /> Show a test pop-up</button>}
          </div>
          {error && <div className="nc-result bad" role="alert"><Icon name="alert" size={15} /> {error}</div>}
        </div>
      </section>

      {detail.state === 'blocked' && !isNativeApp() && (
        <Panel title={`Allow notifications in ${browserName()}`} icon="lock">
          <ol className="nc-steps">
            <li>Click the <b>lock</b> (or tune) icon at the left of the address bar.</li>
            <li>Find <b>Notifications</b> and choose <b>Allow</b>.</li>
            <li>Reload this page, then come back here and press <b>Turn on notifications</b>.</li>
          </ol>
        </Panel>
      )}

      <Panel title="Sound" icon="play" sub="Alerts get a sound on this device so they stand out from other apps. Choose which ones below."
        actions={<Switch on={sound} label="Play alert sounds" onChange={(v) => { setSound(v); setSoundOn(v); if (v) { unlockSound(); playSound('message'); } }} />}>
        <p className="ncx-set-foot">{sound ? 'Sounds are on for this device.' : 'All sounds are off on this device.'}</p>
      </Panel>
      <AlertSettings />

      <Panel title="Check end to end" icon="alarm" sub="Sends a real reminder through the server in 2 minutes - the best way to confirm push works when the app is closed.">
        <div className="nc-row-actions">
          <button className="btn btn-ghost btn-sm" disabled={testReminder.isPending} onClick={() => testReminder.mutate()}>{testReminder.isPending && <span className="spinner" />}<Icon name="alarm" size={13} /> Send a test reminder (2 min)</button>
          <span className="nc-muted">{devices.data ? `${devices.data.devices} device${devices.data.devices === 1 ? '' : 's'} signed up for push on your account.` : ''}</span>
        </div>
      </Panel>

      <Panel title="Still nothing?" icon="info">
        <ul className="nc-checklist">
          <li><b>Windows:</b> Settings → System → Notifications - your browser must be allowed, and Do not disturb / Focus off.</li>
          <li><b>macOS:</b> System Settings → Notifications → {browserName()} - Allow notifications, and Focus off.</li>
          <li><b>Android:</b> install the Project Tracker app for reliable push, or allow notifications for {browserName()}.</li>
          <li><b>iPhone / iPad:</b> add Project Tracker to the Home Screen from Safari's Share menu, then open it from there and turn notifications on.</li>
        </ul>
        <button className="btn btn-ghost btn-sm" onClick={() => nav('/settings/profile/mobile')}><Icon name="phone" size={13} /> Get the mobile app</button>
      </Panel>
    </>
  );
}

// ------------------------------------------------------------------ schedule & time zone

const WEEK = [{ d: 1, l: 'Mon' }, { d: 2, l: 'Tue' }, { d: 3, l: 'Wed' }, { d: 4, l: 'Thu' }, { d: 5, l: 'Fri' }, { d: 6, l: 'Sat' }, { d: 7, l: 'Sun' }];

function LiveClock({ zone }: { zone: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 15_000); return () => clearInterval(t); }, []);
  return (
    <div className="nc-clock">
      <span className="nc-clock-time">{formatInZone(now, { hour: '2-digit', minute: '2-digit' }, zone)}</span>
      <span className="nc-clock-date">{formatInZone(now, { weekday: 'long', day: 'numeric', month: 'long' }, zone)}</span>
      <span className="nc-clock-zone">{zoneCity(zone)} · {zoneOffsetLabel(zone)}</span>
    </div>
  );
}

function Schedule() {
  const ctx = useAuth((s) => s.ctx)!;
  const reload = useAuth((s) => s.reloadContext);
  const wid = useWorkspaceId();
  const canManageOrg = useCan('org.manage');
  const personal = useIsPersonal();
  const canWorkspace = canManageOrg && !personal;
  const settings = useQuery({ queryKey: ['reminder-settings', 'nc'], queryFn: reminderApi.settings });
  const [s, setS] = useState<ReminderSettings | null>(null);
  // The zone the day really runs in (a reported UTC on the profile shows as the organization's zone it falls back to).
  const shownZone = ctx.timeZone ?? ctx.user.timeZone;
  const [zone, setZone] = useState<string>(shownZone);
  const [busy, setBusy] = useState(false);
  const device = deviceZone();
  useEffect(() => { if (settings.data && !s) setS(settings.data); }, [settings.data, s]);
  useEffect(() => { setZone(ctx.user.timeZone); }, [ctx.user.timeZone]);

  if (settings.isLoading || !s) return settings.isError ? <ErrorState error={settings.error} retry={() => settings.refetch()} /> : <PageLoader />;
  const set = <K extends keyof ReminderSettings>(k: K, v: ReminderSettings[K]) => setS((x) => x && ({ ...x, [k]: v }));
  const toggle = (k: 'workDays' | 'dueLeads' | 'overdueSteps', v: number) => setS((x) => x && ({ ...x, [k]: x[k].includes(v) ? x[k].filter((y) => y !== v) : [...x[k], v].sort((a, b) => a - b) }));
  const quiet = !!s.quietStart;

  const zoneDirty = zone !== shownZone;
  const settingsDirty = JSON.stringify(s) !== JSON.stringify(settings.data);

  const pickZone = (z: string | null) => {
    if (!z) return;
    setZone(z);
    // Choosing a zone by hand that differs from this device means "keep this one": stop following the device, or it would move back.
    if (z !== device && s.followDeviceTimeZone) { set('followDeviceTimeZone', false); toast('Following this device is now off, so your chosen zone stays.', 'info'); }
  };

  const save = async () => {
    setBusy(true);
    try {
      if (settingsDirty) {
        const saved = await reminderApi.saveSettings(s);
        queryClient.setQueryData(['reminder-settings', 'nc'], saved);
        setS(saved);
      }
      if (zoneDirty) await meApi.updateProfile({ displayName: ctx.user.displayName, timeZone: zone });
      else if (s.followDeviceTimeZone && ctx.user.timeZone !== device) await reminderApi.followDevice();
      await reload();
      await refreshReminders(wid);
      invalidateWorkspace(wid);
      toast('Schedule saved. Dates and reminders now follow it everywhere.', 'success');
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save your schedule.', 'error'); }
    finally { setBusy(false); }
  };

  const dirty = zoneDirty || settingsDirty;
  return (
    <>
      <Panel title="Your time zone" icon="clock" className="nc-tz"
        sub="Everything you see and get follows it: today and overdue, due dates, timesheet days, chat times, reminders, briefings and charts.">
        <div className="nc-tz-grid">
          <div className="nc-tz-pick">
            <TimeZonePicker value={zone} onChange={pickZone} label="Your time zone" />
            <label className="nc-check">
              <Switch on={s.followDeviceTimeZone} label="Follow this device's time zone" onChange={(v) => { set('followDeviceTimeZone', v); if (v) setZone(device); }} />
              <span><b>Follow this device automatically</b><small>When you travel, your zone moves with the device you use. This device is in {zoneCity(device)} ({zoneOffsetLabel(device)}).</small></span>
            </label>
            {zone !== device && !s.followDeviceTimeZone && <p className="nc-note"><Icon name="info" size={13} /> This device is in {zoneCity(device)}; the app will keep showing {zoneCity(zone)} time.</p>}
          </div>
          <LiveClock zone={zone} />
        </div>
      </Panel>

      {canWorkspace && (
        <p className="nc-note"><Icon name="building" size={13} /> The workspace's default time zone, for people who have not set their own, is set in <Link className="link" to="/settings/general#s-workspace.timeZone">Workspace settings › General</Link>.</p>
      )}

      <Panel title="Working hours" icon="calendar" sub="Automatic reminders and nudges from others only arrive on working days, inside these hours.">
        <div className="nc-days" role="group" aria-label="Working days">{WEEK.map((d) => (
          <button key={d.d} type="button" aria-pressed={s.workDays.includes(d.d)} className={`nc-day-btn ${s.workDays.includes(d.d) ? 'on' : ''}`} onClick={() => toggle('workDays', d.d)}>{d.l}</button>))}</div>
        <div className="nc-fields">
          <label><span>Start</span><input className="input" type="time" value={s.workStart} onChange={(e) => set('workStart', e.target.value)} /></label>
          <label><span>End</span><input className="input" type="time" value={s.workEnd} onChange={(e) => set('workEnd', e.target.value)} /></label>
          <label><span>“Tomorrow” means</span><input className="input" type="time" value={s.defaultTime} onChange={(e) => set('defaultTime', e.target.value)} /></label>
        </div>
      </Panel>

      <Panel title="Quiet hours" icon="moon" sub="Automatic reminders, nudges and WhatsApp messages wait until quiet hours end. Your own reminders still ring."
        actions={<Switch on={quiet} label="Quiet hours" onChange={(v) => setS((x) => x && ({ ...x, quietStart: v ? x.quietStart ?? '21:00' : null, quietEnd: v ? x.quietEnd ?? '08:00' : null }))} />}>
        {quiet ? (
          <div className="nc-fields">
            <label><span>From</span><input className="input" type="time" value={s.quietStart ?? '21:00'} onChange={(e) => set('quietStart', e.target.value)} /></label>
            <label><span>Until</span><input className="input" type="time" value={s.quietEnd ?? '08:00'} onChange={(e) => set('quietEnd', e.target.value)} /></label>
          </div>
        ) : <p className="nc-muted">Off - automatic reminders can arrive any time inside your working hours.</p>}
      </Panel>

      <Panel title="Morning briefing" icon="sun" sub="A summary of what is due, overdue and coming up, on working days."
        actions={<Switch on={s.briefingEnabled} label="Morning briefing" onChange={(v) => set('briefingEnabled', v)} />}>
        {s.briefingEnabled ? <div className="nc-fields"><label><span>At</span><input className="input" type="time" value={s.briefingTime} onChange={(e) => set('briefingTime', e.target.value)} /></label></div>
          : <p className="nc-muted">Off.</p>}
      </Panel>

      <Panel title="Daily digest of updates" icon="inbox" sub="Updates (comments, changes, reports you follow) skip push and arrive as one email at a time you choose. Anything that needs you still comes at once."
        actions={<Switch on={!!s.digestTime} label="Daily digest of updates" onChange={(v) => set('digestTime', v ? s.digestTime ?? '18:00' : null)} />}>
        {s.digestTime ? <div className="nc-fields"><label><span>Send at</span><input className="input" type="time" value={s.digestTime} onChange={(e) => set('digestTime', e.target.value || '18:00')} /></label></div>
          : <p className="nc-muted">Off - updates are emailed and pushed as they happen (following your choices in Delivery).</p>}
      </Panel>

      <Panel title="Automatic reminders for your work" icon="bolt" sub="Reminders about tasks and work assigned to you, before and after they are due."
        actions={<Switch on={s.autoEnabled} label="Automatic reminders" onChange={(v) => set('autoEnabled', v)} />}>
        {s.autoEnabled ? (
          <>
            <div className="nc-label">Before it is due</div>
            <div className="nc-chips">{[{ v: 3, l: '3 working days before' }, { v: 2, l: '2 days before' }, { v: 1, l: 'The day before' }, { v: 0, l: 'On the day' }].map((o) => (
              <button key={o.v} type="button" aria-pressed={s.dueLeads.includes(o.v)} className={`nc-chip ${s.dueLeads.includes(o.v) ? 'on' : ''}`} onClick={() => toggle('dueLeads', o.v)}>{o.l}</button>))}</div>
            <div className="nc-label">If it becomes overdue</div>
            <div className="nc-chips">{[1, 3, 7, 14].map((v) => (
              <button key={v} type="button" aria-pressed={s.overdueSteps.includes(v)} className={`nc-chip ${s.overdueSteps.includes(v) ? 'on' : ''}`} onClick={() => toggle('overdueSteps', v)}>after {v} day{v === 1 ? '' : 's'}</button>))}</div>
            <div className="nc-fields"><label><span>At most a day</span>
              <select className="input" value={String(s.dailyAutoLimit)} onChange={(e) => set('dailyAutoLimit', Number(e.target.value))}>
                {[5, 8, 12, 20, 50].map((n) => <option key={n} value={n}>{n} (the rest go in the briefing)</option>)}
              </select></label></div>
          </>
        ) : <p className="nc-muted">Off - you only get reminders you set yourself or that others send.</p>}
        <label className="nc-check nc-check-top">
          <Switch on={!s.muteNudges} label="Let people remind me about my work" onChange={(v) => set('muteNudges', !v)} />
          <span><b>Let people remind me about my work</b><small>Teammates can send you a reminder about work assigned to you.</small></span>
        </label>
      </Panel>

      <div className={`nc-savebar nc-savebar-sticky ${dirty ? 'show' : ''}`} aria-hidden={!dirty}>
        <span>Unsaved schedule changes</span>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setS(settings.data!); setZone(ctx.user.timeZone); }}>Discard</button>
        <button className="btn btn-primary btn-sm" disabled={busy || !dirty} onClick={() => void save()}>{busy && <span className="spinner" />}Save</button>
      </div>
    </>
  );
}
