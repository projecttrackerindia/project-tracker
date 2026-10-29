import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { meetingApi } from '../../api/endpoints';
import type { TimeEntry, TimelineEvent } from '../../api/types';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { instantIn } from '../../lib/zone';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { meetApi } from '../meet/meetApi';
import { undoToast } from '../talk/flyTask';
import { editError, entryLock, isoAt, moveReminder, overlapFixes, placeEntry, refreshAfterEdit, useMyEntries, warnOverlap } from './calendarEdit';
import { DOW3, addDays, clockH, dateOf, fmtMins, planKey, type Focus, type Meet, type PlanOverrides } from './plannerModel';
import { focusLabel, hoursOf } from './timeline';

const spanText = (day: string, a: number, b: number) => `${DOW3[dateOf(day).getDay()]} ${clockH(a)}–${clockH(b)}`;

/**
 * The one set of edits a day can take, shared by the Calendar (week, day, phone day) and Today's "Your day", so a drag means the same thing
 * on both: a meeting you organise is rescheduled through its PATCH endpoint (an external calendar's meeting stays read-only and says why),
 * a logged entry is moved or resized on the timesheet (a locked week and a running timer refuse; the entry's stamp makes a change made
 * elsewhere a 409, never an overwrite), a focus block is written into your plan, a reminder moves to its new time. Every change shows at
 * once (optimistic), then refreshes the one timeline and the timesheet together; each has Undo. An entry that ends up overlapping other
 * time says so ("Overlaps WT-11 09:31–11:31 · Adjust").
 */
export function useDayEdit({ from, to, enabled = true, today, nowH, plan, savePlan, anchor, focus, onAdjust }: {
  /** The days whose entries and meetings may be edited (a week). */
  from: string; to: string; enabled?: boolean;
  today: string; nowH: number;
  plan: PlanOverrides; savePlan: (p: PlanOverrides) => void;
  /** Where the Undo toast appears. */
  anchor: () => Element | null;
  /** The focus blocks on screen (to say "focus replanned" when a meeting lands on one). */
  focus: () => readonly Focus[];
  /** "Adjust" on an overlap warning: open that entry's card. */
  onAdjust?: (timeEventId: string) => void;
}) {
  const wid = useWorkspaceId();
  const feed = useWsQuery(['meet', 'feed', from], () => meetApi.feed({ from: `${from}T00:00:00`, to: `${addDays(to, 1)}T00:00:00` }), { staleTime: 60_000, retry: false, enabled });
  const mine = useMyEntries(from, to, enabled);
  const entries = useMemo(() => new Map((Array.isArray(mine.data?.entries) ? mine.data!.entries : []).map((e) => [e.id, e])), [mine.data]);
  /** Edits on their way to the server, shown at once (by timeline event id); dropped when the timeline comes back. */
  const [over, setOver] = useState<Record<string, Partial<TimelineEvent>>>({});
  const [moved, setMoved] = useState<Record<string, { day: string; start: number; end: number }>>({});
  const adjust = useRef(onAdjust); adjust.current = onAdjust;

  const apply = useCallback((events: readonly TimelineEvent[]) => events.map((t) => (over[t.id] ? { ...t, ...over[t.id] } : t)), [over]);
  const clearOver = useCallback(() => setOver({}), []);
  /** Show other edits at once too (a due date moved by its flag). */
  const patch = useCallback((p: Record<string, Partial<TimelineEvent>>) => setOver((o) => ({ ...o, ...p })), []);
  const unpatch = useCallback((ids: readonly string[]) => setOver((o) => { const n = { ...o }; for (const id of ids) delete n[id]; return n; }), []);
  /** Meetings with what only Meet knows (who may move it, recurring, the provider) and where you just moved them. */
  const withFeed = useCallback((ms: readonly Meet[]): Meet[] => {
    const byStart = new Map((feed.data?.items ?? []).map((f) => [`${f.id}|${Date.parse(f.start)}`, f]));
    const byId = new Map((feed.data?.items ?? []).map((f) => [f.id, f]));
    return ms.map((m) => {
      const f = byStart.get(`${m.e.id}|${Date.parse(m.e.startsAt!)}`) ?? byId.get(m.e.id) ?? null;
      const mv = moved[m.key];
      return mv ? { ...m, day: mv.day, start: mv.start, end: mv.end, feed: f } : { ...m, feed: f };
    });
  }, [feed.data, moved]);

  const canMove = useCallback((m: Meet): string | null => {
    if (!m.feed) return 'Open the meeting in Messages to move it';
    if (!m.feed.canManage) return 'Only the organiser can move this meeting';
    if (m.feed.recurring) return 'A recurring meeting moves from its series in Messages';
    if (Date.parse(m.feed.end) < Date.now()) return 'This meeting has ended';
    return null;
  }, []);
  const timeWhy = useCallback((t: TimelineEvent): string | null => (t.running ? 'The timer is running on this. Stop it to change its time.' : entryLock(entries.get(t.sourceId))), [entries]);
  const remWhy = (t: TimelineEvent) => (t.status !== 'scheduled' ? 'This reminder went off: snooze it or mark it done' : null);

  const reschedule = async (m: Meet, day: string, start: number, len: number, undo = false) => {
    const was = { day: m.day, start: m.start, end: m.end };
    setMoved((s) => ({ ...s, [m.key]: { day, start, end: start + len } }));
    try {
      const body = { startTime: instantIn(day, start).toISOString(), endTime: instantIn(day, start + len).toISOString() };
      if (m.e.projectId) await meetingApi.reschedule(m.e.id, body); else await meetingApi.workspaceReschedule(m.e.id, body);
      void invalidateWorkspace(wid, 'meet');
      void invalidateWorkspace(wid, 'timeline');
      if (undo) { toast('Moved back.', 'info'); return; }
      const hit = focus().filter((f) => f.day === day && f.end > start && f.start < start + len);
      const label = `${m.e.title} moved to ${DOW3[dateOf(day).getDay()]} ${clockH(start)}${Math.abs(len - (was.end - was.start)) > 1e-6 ? `–${clockH(start + len)}` : ''}${hit.length ? ' · focus replanned' : ''}`;
      undoToast(label, () => void reschedule({ ...m, day, start, end: start + len }, was.day, was.start, was.end - was.start, true), anchor(), 46);
    } catch (err) {
      setMoved((s) => ({ ...s, [m.key]: was }));
      toast(err instanceof ApiError ? err.message : 'Could not move the meeting.', 'error');
    }
  };

  const moveTimeEntry = async (fresh: TimeEntry, day: string, start: number, end: number) => {
    try { await placeEntry(fresh, day, start, end); toast('Moved back.', 'info'); }
    catch (err) { toast(editError(err, 'Could not move it back.'), 'error'); }
    finally { refreshAfterEdit(wid); }
  };
  const moveTime = async (t: TimelineEvent, day: string, start: number, end: number, undo = false) => {
    const e = entries.get(t.sourceId);
    const why = timeWhy(t);
    if (why || !e) { toast(why ?? 'That entry is not yours to change.', 'error'); return; }
    if (day > today || (day === today && end > nowH + 1 / 60)) { toast('Logged time is for time that has happened. Drag it earlier, or plan focus for later.', 'error'); return; }
    const was = hoursOf(t), wasDay = t.date;
    setOver((o) => ({ ...o, [t.id]: { date: day, start: isoAt(day, start), end: isoAt(day, end), approximated: false, minutes: Math.round((end - start) * 60) } }));
    try {
      const res = await placeEntry(e, day, start, end);
      refreshAfterEdit(wid);
      if (undo) { toast('Moved back.', 'info'); return; }
      if (warnOverlap(res, () => adjust.current?.(t.id))) return;
      undoToast(`${t.title} · ${spanText(day, start, end)} (${fmtMins(Math.round((end - start) * 60))})`, () => {
        // Undo works from the saved entry (its new stamp), once the timesheet has it.
        void mine.refetch().then((r) => { const fresh = r.data?.entries.find((x) => x.id === e.id); if (fresh) void moveTimeEntry(fresh, wasDay, was.start, Math.max(was.end, was.start + .25)); });
      }, anchor(), 46);
    } catch (err) {
      setOver((o) => { const n = { ...o }; delete n[t.id]; return n; });
      toast(editError(err, 'That time could not be moved.'), 'error');
      refreshAfterEdit(wid);
    }
  };
  /** One click on "Move after" / "Trim" of an overlap warning. */
  const fixOverlap = (t: TimelineEvent, other: TimelineEvent, how: 'after' | 'trim') => {
    const a = hoursOf(t), b = hoursOf(other);
    const fx = overlapFixes({ day: t.date, start: a.start, end: a.end }, { start: b.start, end: b.end }, today, nowH)[how];
    if (!fx) { toast(how === 'after' ? 'There is no room after it before now.' : 'This entry is inside the other one: move it instead.', 'error'); return; }
    void moveTime(t, t.date, fx[0], fx[1]);
  };
  const moveRem = async (t: TimelineEvent, day: string, start: number, undo = false) => {
    const why = remWhy(t);
    if (why) { toast(why, 'error'); return; }
    if (day < today || (day === today && start < nowH)) { toast('Choose a time that has not passed yet.', 'error'); return; }
    const was = hoursOf(t).start, wasDay = t.date;
    setOver((o) => ({ ...o, [t.id]: { date: day, start: isoAt(day, start) } }));
    try {
      await moveReminder(t.sourceId, day, start);
      refreshAfterEdit(wid);
      if (undo) { toast('Moved back.', 'info'); return; }
      undoToast(`Reminder moved to ${DOW3[dateOf(day).getDay()]} ${clockH(start)}`, () => void moveRem({ ...t, date: day, start: isoAt(day, start) }, wasDay, was, true), anchor(), 46);
    } catch (err) {
      setOver((o) => { const n = { ...o }; delete n[t.id]; return n; });
      toast(editError(err, 'The reminder could not be moved.'), 'error');
    }
  };
  const moveFocusTo = (f: Focus, day: string, start: number, len: number) => {
    const before = plan;
    savePlan({ ...plan, [planKey(f.e)]: { day, start, len } });
    undoToast(`Focus on ${focusLabel(f.e)} · ${spanText(day, start, start + len)}`, () => savePlan(before), anchor(), 46);
  };
  const removeFocus = (f: Focus, quiet?: boolean) => {
    const before = plan;
    savePlan({ ...plan, [planKey(f.e)]: 'removed' });
    if (!quiet) undoToast(`${focusLabel(f.e)} taken out of your plan`, () => savePlan(before), anchor(), 46);
  };
  return { wid, feed, mine, entries, over, apply, clearOver, patch, unpatch, withFeed, canMove, timeWhy, remWhy, reschedule, moveTime, fixOverlap, moveRem, moveFocusTo, removeFocus };
}

/** Drop optimistic edits once the timeline has answered again. */
export function useClearOnRefresh(stamp: number, clear: () => void) {
  useEffect(() => { clear(); }, [stamp, clear]);
}
