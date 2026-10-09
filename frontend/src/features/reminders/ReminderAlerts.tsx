import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { onReminders, type ReminderEvent } from '../live/bus';
import { reminderApi, type SnoozePreset } from './api';
import { refreshReminders, useReminderCounts } from './store';
import { syncNativePush } from '../../lib/native';
import { pushApi } from '../../api/endpoints';
import { deviceAlerts, playChime, primeSound, pushCoversThisDevice, soundOn, systemNotification } from './device';
import { deviceZone } from './time';

const SOURCE_LABEL: Record<string, string> = { Personal: 'Reminder', Nudge: 'Reminder', DueDate: 'Due soon', Overdue: 'Overdue', Escalation: 'Overdue work' };

/**
 * When a reminder goes off while the app is open, it appears in the corner with Done, Snooze and Open - straight away over the live
 * connection, or within half a minute from the badge's own refresh where there is none (personal workspaces, guests). The tab title
 * shows a ⏰ until it is dealt with. Also keeps the profile's time zone in step with the device, for automatic reminders.
 */
export function ReminderAlerts() {
  const wid = useWorkspaceId();
  const user = useAuth((s) => s.ctx?.user);
  const nav = useNavigate();
  const enabled = !!wid && !!user && !user.isPlatformAdmin;
  const counts = useReminderCounts(enabled);
  const [alerts, setAlerts] = useState<ReminderEvent[]>([]);
  const shown = useRef(new Map<string, number>());
  const lastNow = useRef<number | null>(null);

  const fresh = (id: string) => {
    const at = shown.current.get(id);
    if (at && Date.now() - at < 180_000) return false;
    shown.current.set(id, Date.now());
    return true;
  };
  const push = (items: ReminderEvent[]) => {
    if (!items.length) return;
    setAlerts((a) => [...items.filter((i) => !a.some((x) => x.id === i.id)), ...a].slice(0, 4));
    if (soundOn()) playChime();
    // Someone in another app: the operating system shows it now (unless a push is already bringing it to this device).
    if ((document.hidden || !document.hasFocus()) && !pushCoversThisDevice())
      for (const i of items) void systemNotification(i.from ? `${i.from}: ${i.title}` : `⏰ ${i.title}`, i.note ?? i.targetKey, `reminder-${i.id}`);
  };

  useEffect(() => { primeSound(); void deviceAlerts(); void syncNativePush((token) => pushApi.subscribeNative(token)); }, []);

  useEffect(() => onReminders((items) => { push(items.filter((i) => fresh(i.id))); void refreshReminders(wid); }), [wid]);

  // Without a live connection: notice the badge going up and show what just went off.
  useEffect(() => {
    const n = counts.data?.now;
    if (n == null) return;
    if (lastNow.current != null && n > lastNow.current) {
      void reminderApi.list().then((list) => push(list.open
        .filter((r) => r.state === 'Fired' && !r.quiet && r.lastFiredAt && Date.now() - Date.parse(r.lastFiredAt) < 180_000 && fresh(r.id))
        .map((r) => ({ id: r.id, title: r.title, note: r.note, targetKey: r.targetKey, link: r.link, source: r.source, from: r.from?.name ?? null })))).catch(() => undefined);
    }
    lastNow.current = n;
  }, [counts.data?.now]);

  // The device's zone, once a session, so "09:00" automatic reminders follow someone who travels (if they keep that setting).
  useEffect(() => {
    if (!enabled || !user || user.timeZone === deviceZone()) return;
    const key = `pm_tz_synced_${deviceZone()}`;
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch { /* storage unavailable */ }
    void reminderApi.followDevice().catch(() => undefined);
  }, [enabled, user]);

  // ⏰ in the tab title while something waits.
  useEffect(() => {
    const base = document.title.replace(/^⏰ /, '');
    document.title = alerts.length ? `⏰ ${base}` : base;
  }, [alerts.length]);

  const dismiss = (id: string) => setAlerts((a) => a.filter((x) => x.id !== id));
  const act = async (id: string, run: () => Promise<unknown>, message: string) => {
    dismiss(id);
    try { await run(); await refreshReminders(wid); toast(message, 'success'); }
    catch { toast('That did not work. Open Reminders to try again.', 'error'); }
  };

  if (!alerts.length) return null;
  return (
    <div className="ra-stack" aria-live="assertive">
      {alerts.map((a) => (
        <div key={a.id} className={`ra-card ra-${a.source.toLowerCase()}`} role="alertdialog" aria-label={`Reminder: ${a.title}`}>
          <div className="ra-ico"><Icon name="alarm" size={18} /></div>
          <div className="ra-main">
            <span className="ra-kicker">{a.from ? `From ${a.from}` : SOURCE_LABEL[a.source] ?? 'Reminder'}</span>
            <b>{a.title}</b>
            {(a.note || a.targetKey) && <span className="ra-sub">{a.note ?? a.targetKey}</span>}
            <div className="ra-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void act(a.id, () => reminderApi.done(a.id), 'Done.')}><Icon name="tick" size={14} /> Done</button>
              {(['1h', 'tomorrow'] as SnoozePreset[]).map((p) => (
                <button key={p} type="button" className="btn btn-ghost btn-sm" onClick={() => void act(a.id, () => reminderApi.snooze(a.id, p), p === '1h' ? 'Snoozed for an hour.' : 'Snoozed until tomorrow.')}>
                  {p === '1h' ? '1 hour' : 'Tomorrow'}
                </button>
              ))}
              {a.link && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { dismiss(a.id); nav(a.link!); }}>Open</button>}
            </div>
          </div>
          <button type="button" className="btn-icon ra-close" aria-label="Close" onClick={() => dismiss(a.id)}><Icon name="close" size={14} /></button>
        </div>
      ))}
    </div>
  );
}
