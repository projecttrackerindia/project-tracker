import { useEffect, useState } from 'react';
import { get, put } from '../../api/client';
import { Modal } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { reminderApi } from '../reminders/api';

export interface NotifyPrefs { owner: boolean; watchers: boolean; lead: boolean; team: boolean; inApp: boolean; email: 'instant' | 'digest' }
const DEFAULTS: NotifyPrefs = { owner: true, watchers: true, lead: true, team: false, inApp: true, email: 'instant' };
const QUIET = { start: '20:00', end: '08:00' };

function Toggle({ on, set, label, disabled }: { on: boolean; set: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`ps4-tg ${on ? 'on' : ''}`} onClick={() => set(!on)} />;
}

/**
 * Notify (design plansheet8/07): who your changes on the sheet tell when a date, assignee, status or project changes (the task owner, its watchers,
 * the project lead, the whole team), in the app; and how you get these yourself — e-mail at once or in one daily digest at 9:00, and quiet hours
 * (your own notification settings, the same ones Notification Center uses).
 */
export function NotifySheet({ project, lead, onClose }: { project: { title: string; colour: string } | null; lead: string | null; onClose: () => void }) {
  const wid = useWorkspaceId();
  const prefs = useWsQuery(['ui', 'plansheetnotify'], async () => { try { return { ...DEFAULTS, ...((await get<{ value: Partial<NotifyPrefs> | null }>('/me/ui/plansheetnotify'))?.value ?? {}) }; } catch { return DEFAULTS; } }, { staleTime: 60_000 });
  const mine = useWsQuery(['reminders', 'settings'], reminderApi.settings, { staleTime: 60_000, retry: false });
  const [v, setV] = useState<NotifyPrefs>(DEFAULTS);
  const [quiet, setQuiet] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (prefs.data) setV(prefs.data); }, [prefs.data]);
  useEffect(() => { if (mine.data) { setQuiet(!!mine.data.quietStart); setV((x) => ({ ...x, email: mine.data!.digestTime ? 'digest' : x.email })); } }, [mine.data]);
  const set = (p: Partial<NotifyPrefs>) => setV((x) => ({ ...x, ...p }));
  const save = async () => {
    setSaving(true);
    try {
      await put('/me/ui/plansheetnotify', { value: v });
      if (mine.data) {
        const digestTime = v.email === 'digest' ? mine.data.digestTime ?? '09:00' : null;
        const quietStart = quiet ? mine.data.quietStart ?? QUIET.start : null, quietEnd = quiet ? mine.data.quietEnd ?? QUIET.end : null;
        if (digestTime !== (mine.data.digestTime ?? null) || quietStart !== mine.data.quietStart || quietEnd !== mine.data.quietEnd)
          await reminderApi.saveSettings({ ...mine.data, digestTime, quietStart, quietEnd });
      }
      void invalidateWorkspace(wid, 'ui'); void invalidateWorkspace(wid, 'reminders');
      toast('Notify settings saved.'); onClose();
    } catch { toast('The settings could not be saved.', 'error'); }
    finally { setSaving(false); }
  };
  const rows: [keyof NotifyPrefs, string, string, boolean?][] = [
    ['owner', 'Task owner', 'Always'], ['watchers', 'Watchers', 'Who raised it and who watches it'], ['lead', 'Project lead', lead ?? 'The project’s owner'], ['team', 'Whole team', 'Everyone on the project'],
  ];
  return (
    <Modal title="Notify" subtitle="When a date, assignee, task or project changes" onClose={onClose} size="sm">
      <div className="ps4-notify">
        {project && <span className={`pchip pc-${project.colour}`}><b />{project.title}</span>}
        <div className="hk">WHO GETS TOLD</div>
        {rows.map(([k, label, hint]) => <div key={k} className="srow"><span style={{ flex: 1 }}>{label}</span><span className="ps3-dim">{hint}</span><Toggle on={!!v[k]} label={label} set={(x) => set({ [k]: x } as Partial<NotifyPrefs>)} /></div>)}
        <div className="hk">CHANNELS</div>
        <div className="srow"><span style={{ flex: 1 }}>In-app</span><Toggle on={v.inApp} label="In-app" set={(x) => set({ inApp: x })} /></div>
        <div className="srow"><span style={{ flex: 1 }}>Email</span>
          <div className="ps3-vsw" role="tablist" aria-label="Email">{(['instant', 'digest'] as const).map((e) => <button key={e} type="button" role="tab" aria-selected={v.email === e} onClick={() => set({ email: e })}>{e === 'instant' ? 'Instant' : `Daily digest ${mine.data?.digestTime ?? '9:00'}`}</button>)}</div></div>
        <div className="hk">QUIET HOURS</div>
        <div className="srow"><span style={{ flex: 1 }}>{mine.data?.quietStart ?? QUIET.start} – {mine.data?.quietEnd ?? QUIET.end}</span><span className="ps3-dim" style={{ fontSize: 12 }}>held for digest</span>
          <Toggle on={quiet} label="Quiet hours" disabled={!mine.data} set={setQuiet} /></div>
        <div className="ps4-notify-f"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>Save</button></div>
      </div>
    </Modal>
  );
}
