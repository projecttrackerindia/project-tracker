import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ApiError, get } from '../../api/client';
import { meApi, pushApi } from '../../api/endpoints';
import type { NotificationPreference, NotificationType } from '../../api/types';
import { useWsQuery } from '../../lib/hooks';
import { queryClient, useAuth } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { reminderApi, type ReminderSettings } from '../reminders/api';
import { liveBannersOn, setLiveBanners } from '../../components/v2/liveBannersPref';
import { whatsAppPrefsUrl, type WhatsAppPreferences } from './WhatsAppNotificationPreferences';
import { SGroup, SPaneHead, SPop, SRow, SSwitch, STile } from './Grouped';

const PREFS_KEY = ['notification-prefs'];
const SETTINGS_KEY = ['reminder-settings', 'nc'];

/** Times every half hour, as the pop-up buttons show them ("8:00 PM"). */
const twelve = (hm: string) => { const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const HALF_HOURS = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const withValue = (list: string[], v: string | null | undefined) => (v && !list.includes(v) ? [...list, v].sort() : list);

/** "What reaches you": the kinds each routing row sets, and the choices (in-app = banner + Home inbox, browser = push). */
const DIRECT: NotificationType[] = ['TaskAssigned', 'Mention', 'Approval'];
const TEAM_OVERDUE: NotificationType[] = ['Overdue', 'DueSoon', 'Nudge'];
type Route = 'push' | 'push-email' | 'inbox' | 'email' | 'off';
const ROUTES: { id: Route; label: string }[] = [
  { id: 'push', label: 'Banner + push' }, { id: 'push-email', label: 'Banner, push + email' }, { id: 'inbox', label: 'Home inbox only' }, { id: 'email', label: 'Email only' }, { id: 'off', label: 'Off' },
];
const routeOf = (p?: NotificationPreference): Route => !p ? 'push'
  : p.inApp && p.browser ? (p.email ? 'push-email' : 'push') : p.inApp ? 'inbox' : p.email ? 'email' : 'off';
const channelsOf = (r: Route) => ({ inApp: r === 'push' || r === 'push-email' || r === 'inbox', browser: r === 'push' || r === 'push-email', email: r === 'push-email' || r === 'email' });

/**
 * Settings › Notifications (the macOS pane in apple/s-settings): critical always comes through; Delivery (live banners on this device, the
 * Home inbox, push, the email digest, WhatsApp for critical); Quiet hours; and what reaches you. Every switch saves at once through the
 * existing preference APIs (/me/notification-preferences, /reminders/settings, WhatsApp consent). The per-event table, this device,
 * schedule, history and member defaults stay one row away under "More".
 */
export function NotificationsOverview({ more }: { more: { id: string; label: string }[] }) {
  const nav = useNavigate();
  const user = useAuth((s) => s.ctx?.user);
  const prefs = useQuery({ queryKey: PREFS_KEY, queryFn: meApi.notificationPrefs });
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: reminderApi.settings });
  const push = useQuery({ queryKey: ['push-status'], queryFn: pushApi.status, retry: false });
  const wa = useWsQuery(['account', 'whatsapp-contact', 'notification-preferences', user?.id], () => get<WhatsAppPreferences>(whatsAppPrefsUrl), { retry: false });
  const [banners, setBanners] = useState(liveBannersOn);

  const rows = Array.isArray(prefs.data) ? prefs.data : [];
  const editable = rows.filter((r) => !r.locked);
  const all = (ch: 'inApp' | 'browser') => editable.length > 0 && editable.every((r) => r[ch]);
  const savePrefs = async (next: NotificationPreference[]) => {
    const before = prefs.data;
    queryClient.setQueryData(PREFS_KEY, next);
    try { queryClient.setQueryData(PREFS_KEY, await meApi.setNotificationPrefs(next.filter((r) => !r.locked).map(({ type, inApp, email, browser }) => ({ type, inApp, email, browser })))); }
    catch (e) { queryClient.setQueryData(PREFS_KEY, before); toast(e instanceof ApiError ? e.message : 'Could not save your notification settings.', 'error'); }
  };
  const setChannel = (ch: 'inApp' | 'browser', v: boolean) => void savePrefs(rows.map((r) => {
    if (r.locked) return r;
    const n = { ...r, [ch]: v };
    if (ch === 'inApp' && !v) n.browser = false;   // push is the in-app notice delivered outside the app
    if (ch === 'browser' && v) n.inApp = true;
    return n;
  }));
  const setRoute = (types: NotificationType[], r: Route) => void savePrefs(rows.map((p) => (types.includes(p.type) && !p.locked ? { ...p, ...channelsOf(r) } : p)));

  // Only a real settings object (the reminder settings) drives the schedule rows.
  const s = settings.data && Array.isArray(settings.data.workDays) ? settings.data : undefined;
  const saveSettings = async (patch: Partial<ReminderSettings>) => {
    if (!s) return;
    const next = { ...s, ...patch };
    queryClient.setQueryData(SETTINGS_KEY, next);
    try { queryClient.setQueryData(SETTINGS_KEY, await reminderApi.saveSettings(next)); }
    catch (e) { queryClient.setQueryData(SETTINGS_KEY, s); toast(e instanceof ApiError ? e.message : 'Could not save your schedule.', 'error'); }
  };
  const quiet = !!s?.quietStart;
  const weekends = !!s && !s.workDays.includes(0) && !s.workDays.includes(6);
  const showWa = !!wa.data && (wa.data.canEnable === true || wa.data.optedIn === true);
  const devices = typeof push.data?.devices === 'number' ? push.data.devices : 0;
  const toWhatsApp = () => nav('/settings/notifications/delivery#whatsapp-settings');

  return (
    <div className="sg-pane" data-setting="notifications.overview">
      <SPaneHead icon="◉" color="linear-gradient(180deg,#ff6961,#ff3b30)" title="Notifications" sub="Choose where things reach you. Project Tracker only interrupts for what matters." />

      <SGroup tone="critical">
        <SRow icon={<STile color="#ff3b30">!</STile>} title="Critical always comes through" sub="Sev‑1 tickets and outages break through quiet hours and Focus">
          <SSwitch on locked label="Critical always comes through" />
        </SRow>
      </SGroup>

      <SGroup label="Delivery">
        <SRow icon={<STile color="#0071e3">▭</STile>} title="Live banners" sub="Top‑right, while the app is open">
          <SSwitch on={banners} label="Live banners" onChange={(v) => { setLiveBanners(v); setBanners(v); }} />
        </SRow>
        <SRow icon={<STile color="#ff9500">⌂</STile>} title="Home inbox" sub="Collect everything in Today › Needs you">
          <SSwitch on={all('inApp')} label="Home inbox" disabled={!rows.length} onChange={(v) => setChannel('inApp', v)} />
        </SRow>
        <SRow icon={<STile color="#28cd41">▯</STile>} title="Push to phone"
          sub={devices ? `${devices} device${devices === 1 ? '' : 's'} · ${user?.displayName ?? ''}` : 'Set up push on your phone in This device'}>
          <SSwitch on={all('browser')} label="Push to phone" disabled={!rows.length} onChange={(v) => setChannel('browser', v)} />
        </SRow>
        <SRow icon={<STile color="#30b0c7">✉</STile>} title="Email digest" sub={user?.email}>
          {s?.digestTime && (
            <SPop label="Email digest time" value={s.digestTime} onChange={(v) => void saveSettings({ digestTime: v })}
              options={withValue(HALF_HOURS.filter((t) => t.endsWith(':00')), s.digestTime).map((t) => ({ id: t, label: `Daily at ${t.replace(/^0/, '')}` }))} />
          )}
          <SSwitch on={!!s?.digestTime} label="Email digest" disabled={!s} onChange={(v) => void saveSettings({ digestTime: v ? s?.digestTime ?? '09:00' : null })} />
        </SRow>
        {showWa && (
          <SRow icon={<STile color="#25d366">✆</STile>} title="WhatsApp for critical"
            sub={wa.data!.optedIn ? 'Only Sev‑1, approvals and what you chose in WhatsApp' : 'Agree to WhatsApp messages to turn it on'}>
            <SSwitch on={wa.data!.optedIn} label="WhatsApp for critical" onChange={toWhatsApp} />
          </SRow>
        )}
      </SGroup>

      <SGroup label="Quiet hours">
        <SRow icon={<STile color="#5856d6">☾</STile>} title="Quiet hours" sub="Hold everything except critical">
          <SSwitch on={quiet} label="Quiet hours" disabled={!s} onChange={(v) => void saveSettings({ quietStart: v ? s?.quietStart ?? '20:00' : null, quietEnd: v ? s?.quietEnd ?? '08:00' : null })} />
        </SRow>
        <SRow title="From" dim={!quiet}>
          <SPop label="Quiet from" value={s?.quietStart ?? '20:00'} disabled={!quiet} onChange={(v) => void saveSettings({ quietStart: v })}
            options={withValue(HALF_HOURS, s?.quietStart).map((t) => ({ id: t, label: twelve(t) }))} />
          <span>to</span>
          <SPop label="Quiet until" value={s?.quietEnd ?? '08:00'} disabled={!quiet} onChange={(v) => void saveSettings({ quietEnd: v })}
            options={withValue(HALF_HOURS, s?.quietEnd).map((t) => ({ id: t, label: twelve(t) }))} />
        </SRow>
        <SRow title="Also on weekends" sub="Sat and Sun, all day" dim={!quiet}>
          <SSwitch on={weekends} label="Also on weekends" disabled={!s || !quiet}
            onChange={(v) => s && void saveSettings({ workDays: v ? s.workDays.filter((d) => d !== 0 && d !== 6) : [...new Set([...s.workDays, 6, 0])].sort((a, b) => a - b) })} />
        </SRow>
      </SGroup>

      <SGroup label="What reaches you">
        <SRow title="Assigned to me, mentions, approvals">
          <SPop label="Assigned to me, mentions, approvals" value={routeOf(rows.find((r) => r.type === 'TaskAssigned'))} options={ROUTES} disabled={!rows.length} onChange={(r) => setRoute(DIRECT, r)} />
        </SRow>
        <SRow title="My team's overdue work">
          <SPop label="My team's overdue work" value={routeOf(rows.find((r) => r.type === 'Overdue'))} options={ROUTES} disabled={!rows.length} onChange={(r) => setRoute(TEAM_OVERDUE, r)} />
        </SRow>
      </SGroup>

      {more.length > 0 && (
        <SGroup label="More">
          {more.map((m) => <SRow key={m.id} title={m.label} onClick={() => nav(`/settings/notifications/${m.id}`)} />)}
        </SGroup>
      )}
    </div>
  );
}
