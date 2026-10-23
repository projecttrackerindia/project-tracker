import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { useWsQuery } from '../../lib/hooks';
import { queryClient, useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { reminderApi, type ReminderSuggestion } from './api';
import { refreshReminders } from './store';
import { describeInstant, deviceZone } from './time';

const FROM: Record<string, string> = { chat: 'You said in chat', email: 'You wrote in an email', meeting: 'From a meeting' };

/** A first-person promise ("I'll", "will send", "kal tak bhej dunga") that the server may have turned into a suggestion. */
const LOOKS_LIKE_PROMISE = /(?:\bi'?ll\b|\bi\s+will\b|\bi\s+shall\b|\bgoing\s+to\b|\blet\s+me\b|\bwill\s+\w+|dunga|dungi|karunga|karungi|chestanu|chesthanu|pampistanu|pamputanu|istanu)/i;
const offered = new Set<string>();

async function accept(s: ReminderSuggestion, wid: string | null) {
  try {
    await reminderApi.acceptSuggestion(s.id);
    void refreshReminders(wid);
    toast(`Reminder set for ${describeInstant(s.fireAt, deviceZone())}.`, 'success');
  } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not set it.', 'error'); void refreshReminders(wid); }
}

/**
 * After a message is sent: if it held a promise with a time, offer the reminder right there ("Remind you Fri 09:00: Send the estimate?").
 * Nothing is set until the person taps; the suggestion also waits on the Reminders page.
 */
export function offerReminderAfterSend(text: string, kind: 'chat' | 'email' = 'chat') {
  const wid = useAuth.getState().ctx?.current?.id ?? null;
  if (!wid || !LOOKS_LIKE_PROMISE.test(text)) return;
  window.setTimeout(() => {
    void reminderApi.suggestions().then((list) => {
      const fresh = list.filter((s) => s.sourceKind === kind && !offered.has(s.id) && Date.now() - new Date(s.createdAt).getTime() < 90_000)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!fresh) return;
      offered.add(fresh.id);
      queryClient.setQueryData([wid, 'reminders', 'suggestions'], list);
      toast(`Remind you ${describeInstant(fresh.fireAt, deviceZone())}: ${fresh.title}?`, 'info', { label: 'Remind me', onClick: () => void accept(fresh, wid) });
    }).catch(() => undefined);
  }, 500);
}

/**
 * "Suggested from what you said": reminders offered from promises in chat and email and from meeting action items. One tap sets one, a
 * cross lets it go. Shown on the Reminders page and (compact) in the bell's reminders pane.
 */
export function ReminderSuggestions({ compact = false }: { compact?: boolean }) {
  const wid = useWorkspaceId();
  const zone = deviceZone();
  const q = useWsQuery(['reminders', 'suggestions'], reminderApi.suggestions, { staleTime: 30_000, refetchInterval: compact ? false : 120_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const items = (q.data ?? []).slice(0, compact ? 3 : 8);
  if (items.length === 0) return null;

  const drop = (id: string) => queryClient.setQueryData<ReminderSuggestion[]>([wid, 'reminders', 'suggestions'], (old) => old?.filter((x) => x.id !== id));
  const take = async (s: ReminderSuggestion) => { setBusy(s.id); drop(s.id); await accept(s, wid); setBusy(null); };
  const dismiss = async (s: ReminderSuggestion) => {
    setBusy(s.id); drop(s.id);
    try { await reminderApi.dismissSuggestion(s.id); } catch { void q.refetch(); } finally { setBusy(null); }
  };

  return (
    <section className={`rs ${compact ? 'rs-compact' : ''}`} aria-label="Suggested from what you said">
      <h3><Icon name="sparkle" size={14} /> Suggested from what you said <em>{q.data!.length}</em></h3>
      <ul>
        {items.map((s) => (
          <li key={s.id} className="rs-item">
            <div className="rs-main">
              <b>{s.title}</b>
              <span className="rs-when"><Icon name="alarm" size={12} /> {describeInstant(s.fireAt, zone)}</span>
              {!compact && s.quote && (
                <span className="rs-quote">
                  {FROM[s.sourceKind] ?? 'You said'}: “{s.quote}”
                  {s.link && <> · <Link to={s.link}>Open</Link></>}
                </span>
              )}
            </div>
            <div className="rs-acts">
              <button type="button" className="btn btn-primary btn-sm" disabled={busy === s.id} onClick={() => void take(s)}><Icon name="plus" size={13} /> Remind me</button>
              <button type="button" className="icon-btn" aria-label={`Not needed: ${s.title}`} title="Not needed" disabled={busy === s.id} onClick={() => void dismiss(s)}><Icon name="close" size={14} /></button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
