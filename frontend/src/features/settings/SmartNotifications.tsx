import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { smartNotifyApi, type NotificationPriority, type SmartSettings } from '../../api/endpoints.notifySmart';
import type { NotificationType } from '../../api/types';
import { useWsQuery } from '../../lib/hooks';
import { queryClient, useAuth } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { reminderApi, type ReminderSettings } from '../reminders/api';
import { SGroup, SPaneHead, SPop, SRow, SSwitch, STile } from './Grouped';
import '../../styles/notify-smart.css';
import { openProblemReport, openWhatsNew } from '../feedback/capture';
import { useFlag } from '../../lib/flags';

const WINDOWS = [15, 30, 60, 120, 240].map((m) => ({ id: String(m), label: m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}` }));
const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
const twelve = (hm: string) => { const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const PRIORITY: { id: NotificationPriority; label: string }[] = [{ id: 'urgent', label: 'Urgent' }, { id: 'normal', label: 'Normal' }];
const SETTINGS_KEY = ['reminder-settings', 'nc'];

/** "✓ Saved" for a moment after each change. */
function useSavedTick() {
  const [saved, setSaved] = useState(false);
  const t = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(t.current), []);
  return { saved, tick: () => { setSaved(true); window.clearTimeout(t.current); t.current = window.setTimeout(() => setSaved(false), 1600); } };
}

/**
 * Settings › Notifications › Smart: urgent things ring and pop up, everything else waits as a quiet badge; bursts about one project or
 * thread are one group that pings once; one daily summary at a time of the person's choosing (in their time zone); and what they muted.
 * Every change saves at once (optimistic), with a "✓ Saved" tick.
 */
export function SmartNotificationsPane() {
  const wid = useAuth((s) => s.ctx?.current?.id ?? null);
  const zone = useAuth((s) => s.ctx?.user.timeZone);
  const key = ['notify-smart'];
  const q = useWsQuery(key, smartNotifyApi.get, { retry: false });
  const sched = useWsQuery(SETTINGS_KEY, reminderApi.settings, { retry: false });
  const { saved, tick } = useSavedTick();
  const reportOn = useFlag('report-problem');
  const data = q.data && Array.isArray(q.data.kinds) ? q.data : undefined;
  const s = sched.data && Array.isArray(sched.data.workDays) ? sched.data : undefined;

  const save = async (patch: Partial<SmartSettings>, body: Parameters<typeof smartNotifyApi.save>[0]) => {
    if (!data) return;
    const before = data;
    queryClient.setQueryData([wid, ...key], { ...data, ...patch });
    try { queryClient.setQueryData([wid, ...key], await smartNotifyApi.save(body)); tick(); }
    catch (e) { queryClient.setQueryData([wid, ...key], before); toast(e instanceof ApiError ? e.message : 'Could not save that.', 'error'); }
  };
  const setPriority = (type: NotificationType, priority: NotificationPriority) =>
    void save({ kinds: data!.kinds.map((k) => (k.type === type ? { ...k, priority } : k)) }, { priorities: [{ type, priority }] });
  const saveSchedule = async (patch: Partial<ReminderSettings>) => {
    if (!s) return;
    queryClient.setQueryData([wid, ...SETTINGS_KEY], { ...s, ...patch });
    try { queryClient.setQueryData([wid, ...SETTINGS_KEY], await reminderApi.saveSettings({ ...s, ...patch })); tick(); }
    catch (e) { queryClient.setQueryData([wid, ...SETTINGS_KEY], s); toast(e instanceof ApiError ? e.message : 'Could not save your summary time.', 'error'); }
  };
  const unmute = async (id: string) => {
    if (!data) return;
    queryClient.setQueryData([wid, ...key], { ...data, mutes: data.mutes.filter((m) => m.id !== id) });
    try { await smartNotifyApi.unmute(id); tick(); } catch { toast('Could not unmute it.', 'error'); }
    void q.refetch();
  };

  const urgent = data?.kinds.filter((k) => k.priority === 'urgent') ?? [];
  const normal = data?.kinds.filter((k) => k.priority === 'normal') ?? [];
  const digest = s?.digestTime ?? null;

  return (
    <div className="sg-pane smart-pane" data-setting="notifications.smart">
      <SPaneHead icon="✦" color="linear-gradient(180deg,#7d7aff,#5856d6)" title="Smart notifications" sub="Urgent things ring. Everything else waits quietly as a badge." />
      <p className={`smart-saved${saved ? ' on' : ''}`} role="status" aria-live="polite">{saved ? '✓ Saved' : ''}</p>

      <SGroup label="Grouping">
        <SRow icon={<STile color="#5856d6">≡</STile>} title="Group updates" sub="Bursts about one project or thread show as one group, like “6 updates on Payments”, and ping once">
          <SSwitch on={data?.grouping ?? true} label="Group updates" disabled={!data} onChange={(v) => void save({ grouping: v }, { grouping: v })} />
        </SRow>
        <SRow title="Group updates that arrive within" dim={data?.grouping === false}>
          <SPop label="Grouping window" value={String(data?.groupWindowMinutes ?? 60)} disabled={!data || data.grouping === false}
            options={WINDOWS.some((w) => w.id === String(data?.groupWindowMinutes ?? 60)) ? WINDOWS : [...WINDOWS, { id: String(data!.groupWindowMinutes), label: `${data!.groupWindowMinutes} minutes` }]}
            onChange={(v) => void save({ groupWindowMinutes: Number(v) }, { groupWindowMinutes: Number(v) })} />
        </SRow>
      </SGroup>

      <SGroup label="Daily summary">
        <SRow icon={<STile color="#30b0c7">☀</STile>} title="One daily summary" sub={`Normal updates arrive together in one e-mail${zone ? `, in your time zone (${zone})` : ''}`}>
          {digest && <SPop label="Summary time" value={digest} onChange={(v) => void saveSchedule({ digestTime: v })}
            options={(HOURS.includes(digest) ? HOURS : [...HOURS, digest].sort()).map((h) => ({ id: h, label: twelve(h) }))} />}
          <SSwitch on={!!digest} label="One daily summary" disabled={!s} onChange={(v) => void saveSchedule({ digestTime: v ? '18:00' : null })} />
        </SRow>
      </SGroup>

      <div className="smart-cols">
      <SGroup label="Urgent · rings and pops up">
        {urgent.map((k) => (
          <SRow key={k.type} title={k.label} sub={k.locked ? 'Always urgent' : k.priority !== k.defaultPriority ? 'Your choice' : undefined}>
            {!k.locked && <SPop label={`${k.label} priority`} value={k.priority} options={PRIORITY} onChange={(v) => setPriority(k.type, v)} />}
          </SRow>
        ))}
        {!data && <SRow title="Loading…" />}
      </SGroup>

      <SGroup label="Normal · a quiet badge">
        {normal.map((k) => (
          <SRow key={k.type} title={k.label} sub={k.priority !== k.defaultPriority ? 'Your choice' : undefined}>
            <SPop label={`${k.label} priority`} value={k.priority} options={PRIORITY} onChange={(v) => setPriority(k.type, v)} />
          </SRow>
        ))}
      </SGroup>
      </div>

      <SGroup label="Muted">
        {(data?.mutes ?? []).map((m) => (
          <SRow key={m.id} icon={<STile color="#8e8e93">{m.scope === 'project' ? '▦' : '☰'}</STile>} title={m.label}
            sub={`${m.scope === 'project' ? 'Project' : 'Thread'}${m.until ? ` · until ${new Date(m.until).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}`}>
            <button type="button" className="sg-btn" onClick={() => void unmute(m.id)}>Unmute</button>
          </SRow>
        ))}
        {data && data.mutes.length === 0 && <SRow title="Nothing muted" sub="Open a group in the Notification Centre and choose Mute to quiet a project or thread." />}
      </SGroup>

      <SGroup label="Help">
        <SRow icon={<STile color="#5856d6">✦</STile>} title="What’s new" sub="The latest release in a few lines" onClick={openWhatsNew} />
        {reportOn && <SRow icon={<STile color="#ff9500">!</STile>} title="Report a problem" sub="A screenshot and the recent errors come along" onClick={openProblemReport} />}
      </SGroup>
    </div>
  );
}
