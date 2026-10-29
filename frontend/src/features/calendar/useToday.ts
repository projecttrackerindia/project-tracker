import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TimelineEvent } from '../../api/types';
import { todayISO } from '../../lib/format';
import { useWorkspaceId } from '../../stores/auth';
import { hourOf, type PlanOverrides } from './plannerModel';
import { buildWeek, focusLabel, readPlan, stickFocus, useTimeline, weekRange, writePlan, type DayView } from './timeline';

/** The clock, refreshed every minute (shared by Today's pieces so they agree with the Calendar's now line). */
export function useNow(ms = 60_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), ms); return () => window.clearInterval(t); }, [ms]);
  return now;
}

/**
 * Today from the one timeline: the same request as the Calendar's current week (Monday to Sunday) and the same layout (buildWeek), so Today and
 * the Calendar show the same meetings, calls, logged time, finished work, reminders and focus blocks. `team` reads the team's day (no focus plan).
 */
export function useToday(team = false) {
  const wid = useWorkspaceId();
  const today = todayISO();
  const now = useNow();
  const nowQ = Math.ceil(hourOf(now) * 4) / 4;
  /** To the minute: today's logged time counts only up to now. */
  const nowM = Math.floor(hourOf(now) * 60) / 60;
  const [plan, setPlan] = useState<PlanOverrides>(() => readPlan(wid));
  useEffect(() => { setPlan(readPlan(wid)); }, [wid]);
  // the Calendar may change the plan in another tab or a moment ago: read it again when the window comes back
  useEffect(() => { const f = () => setPlan(readPlan(wid)); window.addEventListener('focus', f); window.addEventListener('storage', f); return () => { window.removeEventListener('focus', f); window.removeEventListener('storage', f); }; }, [wid]);
  const q = useTimeline({ ...weekRange(today), scope: team ? 'team' : 'me' });
  /** Today laid out from a list of events (the timeline, or the timeline with edits on their way shown at once). */
  const build = useCallback((events: readonly TimelineEvent[]): DayView => {
    const d = buildWeek(events, [today], today, nowQ, team ? {} : plan, nowM).byDay.get(today)!;
    return team ? { ...d, focus: [] } : d;
  }, [today, nowQ, nowM, plan, team]);
  const day: DayView | null = useMemo(() => (q.data ? build(q.data.events) : null), [q.data, build]);
  const savePlan = useCallback((p: PlanOverrides) => { setPlan(p); writePlan(wid, p); }, [wid]);
  // A suggested block that has started (or starts within 15 minutes) stays where it is: kept in the plan, so a refresh never slides it later.
  const nowH = hourOf(now);
  useEffect(() => {
    if (team || !day) return;
    const next = stickFocus(day.focus, plan, today, nowH);
    if (next) savePlan(next);
  }, [team, day, plan, today, nowH, savePlan]);
  return { q, day, today, now, plan, savePlan, build };
}

/** My Work's focus card: today's focus blocks from the same plan Today and the Calendar draw. */
export function useTodayFocus() {
  const { day } = useToday(false);
  return useMemo(() => {
    const blocks = (day?.focus ?? []).map((f) => ({ start: f.start, end: f.end, label: focusLabel(f.e), id: f.e.id }));
    return { blocks, minutes: blocks.reduce((s, b) => s + (b.end - b.start) * 60, 0) };
  }, [day]);
}
