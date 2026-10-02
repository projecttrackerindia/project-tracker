import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { reminderApi, type ReminderSubject, type ReminderWhen } from './api';
import { openReminderComposer, refreshReminders } from './store';
import { addDays, addMinutes, atTime, describeInstant, describeLocal, deviceZone, fromIso, iso, parseHm, relative, wall } from './time';

/**
 * "Remind me" on a piece of work: a few one-tap choices (in an hour, this evening, tomorrow, before it is due), the reminders already set
 * on it, and the full form for anything else. Keyboard: R opens it while the item is focused.
 */
export function RemindMeButton({ subject, compact }: { subject: ReminderSubject; compact?: boolean }) {
  const wid = useWorkspaceId();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const existing = useWsQuery(['reminders', 'for', subject.type, subject.id], () => reminderApi.forTarget(subject.type, subject.id), { staleTime: 30_000 });
  const settings = useWsQuery(['reminders', 'settings'], reminderApi.settings, { staleTime: 300_000, enabled: open });
  const count = existing.data?.length ?? 0;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc, true); };
  }, [open]);

  const zone = deviceZone();
  const now = wall(new Date(), zone);
  const [dh, dm] = parseHm(settings.data?.defaultTime ?? '09:00');
  const soon = (() => { const n = addMinutes(now, 60); const r = n.getUTCMinutes() % 15; return addMinutes(n, r ? 15 - r : 0); })();
  const due = subject.due ? fromIso(subject.due) : null;
  const choices: { label: string; when: ReminderWhen; hint: string }[] = [
    { label: 'In 1 hour', when: { at: iso(soon), timeZone: zone }, hint: describeLocal(soon, now) },
    ...(now.getUTCHours() < 17 ? [{ label: 'This evening', when: { at: iso(atTime(now, 18)), timeZone: zone }, hint: 'Today 18:00' }] : []),
    { label: 'Tomorrow', when: { at: iso(atTime(addDays(now, 1), dh, dm)), timeZone: zone }, hint: describeLocal(atTime(addDays(now, 1), dh, dm), now) },
    ...(() => { const mon = atTime(addDays(now, ((8 - now.getUTCDay()) % 7) || 7), dh, dm); return [{ label: 'Next week', when: { at: iso(mon), timeZone: zone }, hint: describeLocal(mon, now) }]; })(),
    ...(due && atTime(addDays(due, -1), dh, dm) > now ? [{ label: 'A day before it’s due', when: { anchorDays: -1, anchorTime: `${String(dh).padStart(2, '0')}:${String(dm).padStart(2, '0')}`, timeZone: zone }, hint: 'Moves with the due date' }] : []),
    ...(due && atTime(due, dh, dm) > now ? [{ label: 'On the due date', when: { anchorDays: 0, anchorTime: `${String(dh).padStart(2, '0')}:${String(dm).padStart(2, '0')}`, timeZone: zone }, hint: describeLocal(atTime(due, dh, dm), now) }] : []),
  ];

  const set = async (when: ReminderWhen) => {
    setOpen(false);
    try {
      const r = await reminderApi.create({ title: null, targetType: subject.type, targetId: subject.id, when });
      await refreshReminders(wid);
      toast(`Reminder set · ${r.nextFireAt ? describeInstant(r.nextFireAt) : ''}`, 'success', { label: 'Undo', onClick: () => { void reminderApi.remove(r.id).then(() => refreshReminders(wid)); } });
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not set the reminder.', 'error'); }
  };
  const drop = async (id: string) => { await reminderApi.remove(id); await refreshReminders(wid); };

  return (
    <div className="rm-wrap" ref={box}>
      <button type="button" className={`btn btn-ghost btn-sm rm-btn ${count ? 'has' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        title={count ? `${count} reminder${count === 1 ? '' : 's'} set` : 'Remind me about this'}>
        <Icon name="alarm" size={15} />{!compact && <span>Remind me</span>}{count > 0 && <em>{count}</em>}
      </button>
      {open && (
        <div className="rm-menu" role="menu">
          <div className="rm-head">Remind me about <b>{subject.key ?? subject.title}</b></div>
          {choices.map((c) => (
            <button key={c.label} type="button" role="menuitem" className="rm-item" onClick={() => void set(c.when)}>
              <span>{c.label}</span><em>{c.hint}</em>
            </button>
          ))}
          <button type="button" role="menuitem" className="rm-item rm-custom" onClick={() => { setOpen(false); openReminderComposer({ subject }); }}>
            <span><Icon name="edit" size={13} /> Custom…</span><em>Date, repeat, someone else</em>
          </button>
          {count > 0 && (
            <>
              <div className="rm-sep">Already set</div>
              {existing.data!.map((r) => (
                <div key={r.id} className="rm-set">
                  <Icon name={r.recurrence ? 'repeat' : 'alarm'} size={13} />
                  <span>{r.state === 'Fired' ? 'Waiting for you' : r.nextFireAt ? `${describeInstant(r.nextFireAt)} · ${relative(r.nextFireAt)}` : '—'}{r.source !== 'Personal' && r.source !== 'Nudge' ? ' · automatic' : ''}</span>
                  {(r.source === 'Personal') && <button type="button" aria-label="Remove reminder" onClick={() => void drop(r.id)}><Icon name="close" size={12} /></button>}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
