import { useRef, useState, type MouseEvent } from 'react';
import { ApiError } from '../../api/client';
import { notificationApi } from '../../api/endpoints';
import type { AppNotification, NotificationAction } from '../../api/types';
import { Icon } from '../../components/Icon';
import { invalidateWorkspace, useDetailsDismiss } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { addDays, addMinutes, atTime, deviceZone, wall } from '../reminders/time';

/** A moment in the app's time zone ("tomorrow at 9:00") as a real instant. */
function inZone(build: (wallNow: Date) => Date): Date {
  const now = new Date();
  const w = wall(now, deviceZone());
  // Zone offsets are whole quarter hours; the wall clock drops seconds, so round to the nearest 15 minutes.
  const offset = Math.round((w.getTime() - now.getTime()) / 900_000) * 900_000;
  return new Date(build(w).getTime() - offset);
}

/** When a snoozed notification can come back: soon, later today, tomorrow morning, next Monday morning. */
export function snoozeChoices(): { label: string; until: Date }[] {
  const tomorrow9 = inZone((w) => atTime(addDays(w, 1), 9));
  const monday9 = inZone((w) => { const dow = w.getUTCDay(); const ahead = ((8 - dow) % 7) || 7; return atTime(addDays(w, ahead), 9); });
  return [
    { label: 'In 1 hour', until: inZone((w) => addMinutes(w, 60)) },
    { label: 'In 3 hours', until: inZone((w) => addMinutes(w, 180)) },
    { label: 'Tomorrow 9:00', until: tomorrow9 },
    { label: 'Monday 9:00', until: monday9 },
  ];
}

const LABEL: Record<Exclude<NotificationAction, 'snooze'>, { text: string; icon: Parameters<typeof Icon>[0]['name'] }> = {
  done: { text: 'Mark done', icon: 'tick' },
  take: { text: 'Take it', icon: 'userPlus' },
  reply: { text: 'Reply', icon: 'message' },
  approve: { text: 'Approve', icon: 'checks' },
  reject: { text: 'Send back', icon: 'undo' },
};

/**
 * The things a notification lets you do on the spot: mark the task done, take it, reply, approve or send back, snooze. Replying and sending
 * back open a small box right there; everything else is one tap, then the notification is read (and put away once the work is done).
 */
export function NotificationActions({ n, withSnooze = true, onActed }: { n: AppNotification; withSnooze?: boolean; onActed?: () => void }) {
  const wid = useWorkspaceId();
  const [writing, setWriting] = useState<'reply' | 'reject' | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  useDetailsDismiss(menu);
  const actions = (n.actions ?? []).filter((a) => a !== 'snooze') as Exclude<NotificationAction, 'snooze'>[];
  const canSnooze = withSnooze && (n.actions ?? []).includes('snooze');
  if (actions.length === 0 && !canSnooze) return null;

  const stop = (e: MouseEvent) => e.stopPropagation();
  const act = async (action: string, extra: { text?: string; until?: string } = {}) => {
    setBusy(true);
    try {
      const r = await notificationApi.act(n.id, action, extra);
      toast(r.message, 'success');
      setWriting(null); setText('');
      invalidateWorkspace(wid, 'notifications');
      invalidateWorkspace(wid, 'tasks'); invalidateWorkspace(wid, 'work-tasks'); invalidateWorkspace(wid, 'documents'); invalidateWorkspace(wid, 'timesheet');
      onActed?.();
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'That did not work. Open it instead.', 'error'); }
    finally { setBusy(false); }
  };
  const tap = (a: Exclude<NotificationAction, 'snooze'>) => {
    if (a === 'reply' || a === 'reject') { setWriting(writing === a ? null : a); return; }
    void act(a);
  };
  const isDoc = n.link?.startsWith('/documents/');

  return (
    <div className="na" onClick={stop} onKeyDown={(e) => e.stopPropagation()}>
      <div className="na-row">
        {actions.map((a) => (
          <button key={a} type="button" className={`na-btn ${a === 'approve' || a === 'done' ? 'primary' : ''}`} disabled={busy} aria-pressed={writing === a}
            onClick={() => tap(a)}>
            <Icon name={LABEL[a].icon} size={13} /> {a === 'reject' && isDoc ? 'Request changes' : LABEL[a].text}
          </button>
        ))}
        {canSnooze && (
          <details className="na-snooze" ref={menu}>
            <summary className="na-btn" aria-label="Snooze"><Icon name="clock" size={13} /> Snooze</summary>
            <div className="na-pop" role="menu">
              {snoozeChoices().map((c) => (
                <button key={c.label} type="button" role="menuitem" disabled={busy}
                  onClick={() => { if (menu.current) menu.current.open = false; void act('snooze', { until: c.until.toISOString() }); }}>{c.label}</button>
              ))}
            </div>
          </details>
        )}
      </div>
      {writing && (
        <form className="na-write" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void act(writing, { text: text.trim() }); }}>
          <textarea autoFocus rows={2} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} aria-label={writing === 'reply' ? 'Your reply' : 'What should change'}
            placeholder={writing === 'reply' ? 'Write a reply…' : isDoc ? 'What should change?' : 'Why is it going back?'}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (text.trim()) void act(writing, { text: text.trim() }); } if (e.key === 'Escape') setWriting(null); }} />
          <div className="na-write-bar">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setWriting(null)}>Cancel</button>
            <button className="btn btn-primary btn-sm" disabled={busy || !text.trim()}>{busy && <span className="spinner" />}{writing === 'reply' ? 'Send' : 'Send back'}</button>
          </div>
        </form>
      )}
    </div>
  );
}
