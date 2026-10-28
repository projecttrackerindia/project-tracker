/**
 * Settings › Notifications › This device: "Sounds & alerts". Mute all (an hour, until tomorrow, until switched back on), Do Not Disturb,
 * and per category whether it plays a sound, shows a banner, counts on the badge (this device) and is pushed to devices (the account).
 * Each sound can be previewed. Muting a single conversation stays in Messages; quiet hours stay under Schedule.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { meApi } from '../../../api/endpoints';
import type { NotificationCategory, NotificationPreference } from '../../../api/types';
import { Icon } from '../../../components/Icon';
import { playCue, unlockSound, type Cue } from '../../../lib/attention';
import { queryClient } from '../../../stores/auth';
import { toast } from '../../../stores/ui';
import { CATEGORY_META, categoryOf } from './model';
import '../../../styles/notification-centre-apple.css';
import { CATEGORIES, isMuted, muteUntil, setAlertPrefs, setCategoryPref, useAlertPrefs, type CategoryPrefs, type MuteFor } from './prefs';

const PREFS_KEY = ['notification-prefs'];
const CUE_OF: Record<NotificationCategory, Cue> = { messages: 'message', reminders: 'reminder', meetings: 'meeting', work: 'message' };
const SOUNDS: { cue: Cue; label: string; hint: string }[] = [
  { cue: 'message', label: 'Message', hint: 'Soft pop' },
  { cue: 'mention', label: 'Mention', hint: 'Brighter, two notes' },
  { cue: 'meeting', label: 'Meeting starting', hint: 'Gentle chime' },
  { cue: 'reminder', label: 'Reminder', hint: 'Two falling notes' },
  { cue: 'critical', label: 'Critical ticket / incident', hint: 'Short alert' },
  { cue: 'sent', label: 'Reply sent', hint: 'Whoosh' },
];

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />;
}

function mutedText(until: number | null) {
  if (until === -1) return 'Muted until you turn it back on';
  if (until === null || until <= Date.now()) return 'Sounds and banners are on';
  return `Muted until ${new Date(until).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

export function AlertSettings() {
  const prefs = useAlertPrefs();
  const muted = isMuted(prefs);
  const server = useQuery({ queryKey: PREFS_KEY, queryFn: meApi.notificationPrefs });
  const pushOf = (cat: NotificationCategory) => {
    const rows = (server.data ?? []).filter((p) => categoryOf({ type: p.type, link: null }) === cat && !p.locked);
    return rows.length > 0 && rows.every((p) => p.browser);
  };
  const setPush = useMutation({
    mutationFn: ({ cat, on }: { cat: NotificationCategory; on: boolean }) => meApi.setNotificationPrefs((server.data ?? []).map((p: NotificationPreference) => ({
      type: p.type, inApp: p.inApp, email: p.email, browser: !p.locked && categoryOf({ type: p.type, link: null }) === cat ? on : p.browser,
    }))),
    onSuccess: (data) => { queryClient.setQueryData(PREFS_KEY, data); toast('Push settings saved.', 'success'); },
    onError: () => toast('Could not save push settings.', 'error'),
  });
  const mute = (choice: MuteFor | 'off') => setAlertPrefs({ mutedUntil: choice === 'off' ? null : muteUntil(choice) });
  const current: MuteFor | 'off' = prefs.mutedUntil === null || (!muted) ? 'off' : prefs.mutedUntil === -1 ? 'forever' : prefs.mutedUntil - Date.now() <= 3_600_000 ? '1h' : 'tomorrow';

  return (
    <section className="nc-panel ncx-settings" aria-labelledby="ncx-alerts-title">
      <header className="nc-panel-head">
        <span className="nc-panel-ico"><Icon name="bell" size={16} /></span>
        <div className="nc-panel-titles"><h3 id="ncx-alerts-title">Sounds &amp; alerts</h3><p>How new notifications get your attention on this device. Push reaches all your devices, even with the app closed.</p></div>
      </header>
      <div className="nc-panel-body">
      <div className="ncx-set-row">
        <span><b>Mute all</b><small>{mutedText(prefs.mutedUntil)}</small></span>
        <div className="ncx-set-seg" role="radiogroup" aria-label="Mute all">
          {([['off', 'Off'], ['1h', '1 hour'], ['tomorrow', 'Until tomorrow'], ['forever', 'Until I turn off']] as [MuteFor | 'off', string][]).map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={current === k} className={current === k ? 'on' : ''} onClick={() => mute(k)}>{l}</button>
          ))}
        </div>
      </div>
      <div className="ncx-set-row">
        <span><b>Do Not Disturb</b><small>No sounds or banners; the badge and the Notification Centre still fill up. Quiet hours also hold back push.</small></span>
        <Toggle on={prefs.dnd} label="Do Not Disturb" onChange={(v) => setAlertPrefs({ dnd: v })} />
      </div>
      <div className="ncx-set-table" role="table" aria-label="Per category">
        <div className="ncx-set-tr head" role="row">
          <span role="columnheader">Category</span><span role="columnheader">Sound</span><span role="columnheader">Banner</span><span role="columnheader">Badge</span><span role="columnheader">Push</span>
        </div>
        {CATEGORIES.map((cat) => {
          const meta = CATEGORY_META[cat];
          const c = prefs.cats[cat];
          const cell = (k: keyof CategoryPrefs, label: string) => (
            <span role="cell"><Toggle on={c[k]} disabled={muted && k !== 'badge'} label={`${label} for ${meta.label}`} onChange={(v) => { setCategoryPref(cat, k, v); if (k === 'sound' && v) { unlockSound(); playCue(CUE_OF[cat]); } }} /></span>
          );
          return (
            <div key={cat} className="ncx-set-tr" role="row" data-cat={cat}>
              <span role="cell" className="ncx-set-cat"><i className={`ncx-ico ${meta.tint}`}><Icon name={meta.icon} size={13} /></i>{meta.label}</span>
              {cell('sound', 'Sound')}{cell('banner', 'Banner')}{cell('badge', 'Badge')}
              <span role="cell"><Toggle on={pushOf(cat)} disabled={!server.data || setPush.isPending} label={`Push for ${meta.label}`} onChange={(v) => setPush.mutate({ cat, on: v })} /></span>
            </div>
          );
        })}
      </div>
      <div className="ncx-set-sounds">
        {SOUNDS.map((s) => (
          <button key={s.cue} type="button" className="nc-sound" onClick={() => { unlockSound(); playCue(s.cue); }} aria-label={`Play the ${s.label} sound`}>
            <Icon name="play" size={13} /><span><b>{s.label}</b><small>{s.hint}</small></span>
          </button>
        ))}
      </div>
      <p className="ncx-set-foot">Sounds play only while Project Tracker is open and in front; when it is closed your device&rsquo;s own notification sound is used. A muted conversation never sounds (mute it from its menu in Messages).</p>
      </div>
    </section>
  );
}
