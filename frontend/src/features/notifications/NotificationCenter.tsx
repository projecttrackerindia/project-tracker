import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { meApi, notificationApi, pushApi, workspaceApi } from '../../api/endpoints';
import type { AppNotification, NotificationPreference, NotificationType, TestEmailResult } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { EmptyState, ErrorState, PageLoader, Pager, SectionLayout, type SectionLink } from '../../components/ui';
import { TimeZonePicker } from '../../components/TimeZonePicker';
import { formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { playSound, setSoundOn, soundOn, unlockSound, type AttentionKind } from '../../lib/attention';
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

export type NotificationSection = 'inbox' | 'preferences' | 'devices' | 'schedule';

// ------------------------------------------------------------------ categories

type Category = 'work' | 'reminders' | 'messages' | 'account';
const CATEGORY: Record<Category, { label: string; icon: IconName; types: NotificationType[] }> = {
  work: { label: 'Work', icon: 'kanban', types: ['TaskAssigned', 'TaskUpdated', 'Comment', 'Issue', 'Approval', 'ServiceLevel', 'ProjectUpdated', 'Document', 'Meeting', 'ReportReady'] },
  reminders: { label: 'Reminders & due dates', icon: 'alarm', types: ['DueSoon', 'Overdue', 'Reminder', 'Nudge', 'Briefing', 'PortfolioDigest', 'CertificationExpiry'] },
  messages: { label: 'Messages & mentions', icon: 'message', types: ['Message', 'Mention'] },
  account: { label: 'Account & workspace', icon: 'shield', types: ['Invitation', 'Subscription', 'Security'] },
};
const categoryOf = (t: NotificationType): Category =>
  (Object.keys(CATEGORY) as Category[]).find((c) => CATEGORY[c].types.includes(t)) ?? 'work';

const TYPE_ICON: Partial<Record<NotificationType, IconName>> = {
  TaskAssigned: 'userPlus', TaskUpdated: 'edit', Comment: 'message', Mention: 'message', Message: 'message', DueSoon: 'clock', Overdue: 'alert',
  Reminder: 'alarm', Nudge: 'alarm', Briefing: 'sun', PortfolioDigest: 'chart', Invitation: 'mail', Subscription: 'card', Security: 'lock',
  ReportReady: 'download', Issue: 'bug', Approval: 'checks', ServiceLevel: 'gauge', Document: 'note', Meeting: 'video', ProjectUpdated: 'folder',
  CertificationExpiry: 'star',
};

// ------------------------------------------------------------------ page

/**
 * The Notification Center: the one place for everything about notifications and time - what arrived (Inbox), where each kind of event
 * reaches you (Delivery), this device's pop-ups, push and sound (This device), and when things happen: your time zone, working hours,
 * quiet hours and the morning briefing (Schedule). Replaces the separate settings that used to live on Reminders and My account.
 */
export function NotificationCenterPage({ section }: { section: NotificationSection }) {
  const unread = useWsQuery(['notifications', 'unread-count'], notificationApi.unread, { refetchInterval: 60_000 });
  const zone = useAppZone();
  const groups: { title?: string; items: SectionLink[] }[] = [
    { items: [{ to: '/notifications', label: 'Inbox', icon: 'inbox', end: true, badge: unread.data?.count || undefined }] },
    { title: 'Settings', items: [
      { to: '/notifications/preferences', label: 'Delivery', icon: 'send' },
      { to: '/notifications/devices', label: 'This device', icon: 'monitor' },
      { to: '/notifications/schedule', label: 'Schedule & time zone', icon: 'clock' },
    ] },
  ];
  return (
    <SectionLayout wide title="Notification Center" sub={`Everything that reaches you, and when - all times in ${zoneCity(zone)} (${zoneOffsetLabel(zone)}).`} groups={groups}>
      {section === 'inbox' && <Inbox />}
      {section === 'preferences' && <Delivery />}
      {section === 'devices' && <ThisDevice />}
      {section === 'schedule' && <Schedule />}
    </SectionLayout>
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

function Inbox() {
  const wid = useWorkspaceId();
  const nav = useNavigate();
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [cat, setCat] = useState<Category | 'all'>('all');
  useAppZone();   // re-group when the zone changes
  const q = useWsQuery(['notifications', 'page', page, unreadOnly], () => notificationApi.list(page, unreadOnly), { placeholderData: (p) => p });
  const refresh = () => invalidateWorkspace(wid, 'notifications');
  const readAll = useMutation({ mutationFn: notificationApi.readAll, onSuccess: () => { refresh(); toast('All caught up.', 'success'); } });

  const open = async (n: AppNotification) => {
    if (!n.isRead) { await notificationApi.read(n.id).catch(() => undefined); refresh(); }
    if (n.link) nav(n.link);
  };

  const items = useMemo(() => (q.data?.items ?? []).filter((n) => cat === 'all' || categoryOf(n.type) === cat), [q.data, cat]);
  const days = useMemo(() => {
    const out: { day: string; items: AppNotification[] }[] = [];
    for (const n of items) {
      const day = isoDateIn(new Date(n.createdAt));
      const last = out[out.length - 1];
      if (last?.day === day) last.items.push(n); else out.push({ day, items: [n] });
    }
    return out;
  }, [items]);

  return (
    <>
      <div className="nc-toolbar">
        <div className="nc-seg" role="tablist" aria-label="Show">
          <button role="tab" aria-selected={unreadOnly} className={unreadOnly ? 'on' : ''} onClick={() => { setUnreadOnly(true); setPage(1); }}>Unread</button>
          <button role="tab" aria-selected={!unreadOnly} className={!unreadOnly ? 'on' : ''} onClick={() => { setUnreadOnly(false); setPage(1); }}>All</button>
        </div>
        <div className="nc-chips" role="group" aria-label="Filter by kind">
          <button className={`nc-chip ${cat === 'all' ? 'on' : ''}`} onClick={() => setCat('all')}>Everything</button>
          {(Object.keys(CATEGORY) as Category[]).map((c) => (
            <button key={c} className={`nc-chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}><Icon name={CATEGORY[c].icon} size={13} /> {CATEGORY[c].label}</button>
          ))}
        </div>
        <button className="btn btn-ghost btn-sm nc-readall" disabled={readAll.isPending} onClick={() => readAll.mutate()}><Icon name="checks" size={14} /> Mark all read</button>
      </div>

      {q.isLoading ? <PageLoader /> : q.isError || !q.data ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
        <div className="nc-inbox">
          {days.length === 0 ? (
            <EmptyState icon="bell" title={unreadOnly ? "You're all caught up" : 'Nothing here yet'}
              text={unreadOnly ? 'New assignments, mentions, messages and reminders appear here.' : 'Notifications you received show up here.'} />
          ) : days.map((d) => (
            <div key={d.day} className="nc-day">
              <div className="nc-day-head">{dayHeading(d.day)}</div>
              <ul className="nc-list">
                {d.items.map((n) => {
                  const c = categoryOf(n.type);
                  return (
                    <li key={n.id} className={`nc-item cat-${c} ${n.isRead ? '' : 'unread'}`}>
                      <button className="nc-item-main" onClick={() => void open(n)}>
                        <span className="nc-item-ico"><Icon name={TYPE_ICON[n.type] ?? 'bell'} size={16} /></span>
                        <span className="nc-item-text">
                          <b>{n.title}</b>
                          {n.body && <span className="nc-item-body">{n.body}</span>}
                          <span className="nc-item-meta"><span>{CATEGORY[c].label}</span> · <time title={formatDateTime(n.createdAt)} dateTime={n.createdAt}>{timeAgo(n.createdAt)}</time></span>
                        </span>
                      </button>
                      {!n.isRead && (
                        <button className="btn-icon nc-item-read" aria-label="Mark as read" title="Mark as read"
                          onClick={async () => { await notificationApi.read(n.id).catch(() => undefined); refresh(); }}><Icon name="tick" size={14} /></button>
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

// ------------------------------------------------------------------ delivery

const PREFS_KEY = ['notification-prefs'];
type Channel = 'inApp' | 'email' | 'browser';
const CHANNELS: { id: Channel; label: string; icon: IconName; hint: string }[] = [
  { id: 'inApp', label: 'In the app', icon: 'bell', hint: 'The bell and this Inbox' },
  { id: 'email', label: 'Email', icon: 'mail', hint: 'To your sign-in address' },
  { id: 'browser', label: 'Push', icon: 'monitor', hint: 'Pop-ups on your devices' },
];

function Delivery() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: PREFS_KEY, queryFn: meApi.notificationPrefs });
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
          <button className="btn btn-primary btn-sm" onClick={() => nav('/notifications/devices')}>Set up this device</button>
        </div>
      )}

      <Panel title="Where each event reaches you" icon="send" sub="Events you switch off everywhere are not sent at all. Security notices always reach you."
        actions={<button className="btn btn-primary btn-sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending && <span className="spinner" />}Save changes</button>}>
        <div className="nc-matrix" role="table" aria-label="Notification delivery">
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

      <WhatsAppContactSection />
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
        const shown = await systemNotification('Notifications are on', 'This is how reminders and messages will reach you.', 'pt-test', '/notifications/devices', { sticky: false });
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
    const ok = await systemNotification('Test notification', 'If you can see this, pop-ups work on this device.', 'pt-test-now', '/notifications/devices', { sticky: false });
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

      <Panel title="Sound" icon="play" sub="Alerts get a sound on this device so they stand out from other apps."
        actions={<Switch on={sound} label="Play alert sounds" onChange={(v) => { setSound(v); setSoundOn(v); if (v) { unlockSound(); playSound('message'); } }} />}>
        <div className="nc-sounds">
          {([['message', 'Message', 'A quick pop for chat'], ['update', 'Update', 'A rising chime for updates'], ['urgent', 'Urgent', 'The beacon for reminders and overdue work']] as [AttentionKind, string, string][]).map(([k, l, d]) => (
            <button key={k} className="nc-sound" disabled={!sound} onClick={() => { unlockSound(); playSound(k); }}>
              <Icon name="play" size={13} /><span><b>{l}</b><small>{d}</small></span>
            </button>
          ))}
        </div>
      </Panel>

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
        <button className="btn btn-ghost btn-sm" onClick={() => nav('/account/mobile')}><Icon name="phone" size={13} /> Get the mobile app</button>
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
  const [zone, setZone] = useState<string>(ctx.user.timeZone);
  const [wsZone, setWsZone] = useState<string | null>(ctx.current?.timeZone ?? null);
  const [busy, setBusy] = useState(false);
  const device = deviceZone();
  useEffect(() => { if (settings.data && !s) setS(settings.data); }, [settings.data, s]);
  useEffect(() => { setZone(ctx.user.timeZone); }, [ctx.user.timeZone]);

  if (settings.isLoading || !s) return settings.isError ? <ErrorState error={settings.error} retry={() => settings.refetch()} /> : <PageLoader />;
  const set = <K extends keyof ReminderSettings>(k: K, v: ReminderSettings[K]) => setS((x) => x && ({ ...x, [k]: v }));
  const toggle = (k: 'workDays' | 'dueLeads' | 'overdueSteps', v: number) => setS((x) => x && ({ ...x, [k]: x[k].includes(v) ? x[k].filter((y) => y !== v) : [...x[k], v].sort((a, b) => a - b) }));
  const quiet = !!s.quietStart;

  const zoneDirty = zone !== ctx.user.timeZone;
  const settingsDirty = JSON.stringify(s) !== JSON.stringify(settings.data);
  const wsDirty = (wsZone ?? null) !== (ctx.current?.timeZone ?? null);

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
      if (wsDirty && canWorkspace) await workspaceApi.setTimeZone(wsZone);
      await reload();
      await refreshReminders(wid);
      invalidateWorkspace(wid);
      toast('Schedule saved. Dates and reminders now follow it everywhere.', 'success');
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save your schedule.', 'error'); }
    finally { setBusy(false); }
  };

  const dirty = zoneDirty || settingsDirty || wsDirty;
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
        <Panel title="Workspace default time zone" icon="building" sub={`For ${ctx.current?.name}: used for people who have not set their own, and for workspace-wide schedules such as digests and service-level clocks.`}>
          <div className="nc-narrow"><TimeZonePicker value={wsZone} onChange={setWsZone} label="Workspace default time zone" allowEmpty emptyLabel="Platform default (Asia/Kolkata)" /></div>
        </Panel>
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
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setS(settings.data!); setZone(ctx.user.timeZone); setWsZone(ctx.current?.timeZone ?? null); }}>Discard</button>
        <button className="btn btn-primary btn-sm" disabled={busy || !dirty} onClick={() => void save()}>{busy && <span className="spinner" />}Save</button>
      </div>
    </>
  );
}
