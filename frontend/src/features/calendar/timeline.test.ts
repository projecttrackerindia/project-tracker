import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from '../../api/types';
import { setAppZones } from '../../lib/zone';
import { buildWeek, dayCounts, daySignature, focusLabel, workWeek } from './timeline';

setAppZones('UTC', null);
const ev = (p: Partial<TimelineEvent> & Pick<TimelineEvent, 'id' | 'type' | 'start' | 'date'>): TimelineEvent => ({
  title: p.id, end: null, allDay: false, sourceType: 'task', sourceId: p.id, link: null, projectId: null, projectName: null, people: [], status: null, colour: '',
  key: null, approximated: false, overdue: false, priority: null, minutes: null, note: null, joinUrl: null, notes: false, userId: null, mode: null, running: false, ...p,
});
// Wednesday 28 October 2026
const today = '2026-10-28';
const events: TimelineEvent[] = [
  ev({ id: 'm1', type: 'meeting', title: 'Cutover review', start: '2026-10-28T10:00:00Z', end: '2026-10-28T11:00:00Z', date: today, sourceType: 'projectMeeting' }),
  ev({ id: 'c1', type: 'call', title: 'Gateway war room', start: '2026-10-28T11:30:00Z', end: '2026-10-28T12:00:00Z', date: today, sourceType: 'call' }),
  ev({ id: 'd1', type: 'done', title: 'Patch the gateway', key: 'INFRA-1', start: '2026-10-28T08:20:00Z', date: today }),
  ev({ id: 't1', type: 'time', title: 'Patch the gateway', start: '2026-10-28T07:00:00Z', end: '2026-10-28T08:00:00Z', minutes: 60, date: today, sourceType: 'timeEntry' }),
  ev({ id: 'due1', type: 'due', title: 'Rotate the certificates', key: 'INFRA-4', priority: 'High', allDay: true, start: '2026-10-28T00:00:00Z', date: today, sourceType: 'task', sourceId: 'x1' }),
  ev({ id: 'due2', type: 'due', title: 'Renew the domain', key: 'INFRA-7', priority: 'Low', allDay: true, start: '2026-10-30T00:00:00Z', date: '2026-10-30', sourceType: 'task', sourceId: 'x2' }),
];

describe('the one timeline', () => {
  it('lays out a day the same whether Today (one day) or the Calendar (the week) asks', () => {
    const nowH = 9.5;
    const one = buildWeek(events, [today], today, nowH, {}).byDay.get(today)!;
    const week = buildWeek(events, workWeek(today), today, nowH, {}).byDay.get(today)!;
    expect(daySignature(one)).toBe(daySignature(week));
    expect(dayCounts(one)).toEqual(dayCounts(week));
    expect(dayCounts(one)).toMatchObject({ meetings: 1, calls: 1, logged: 60, done: 1 });
  });

  it('names focus blocks after their item, never in the past and never longer than the gap', () => {
    const nowH = 9.5;
    const d = buildWeek(events, [today], today, nowH, {}).byDay.get(today)!;
    expect(d.focus.length).toBeGreaterThan(0);
    for (const f of d.focus) {
      expect(f.start).toBeGreaterThanOrEqual(nowH);
      expect(focusLabel(f.e)).toMatch(/^INFRA-\d /);
      expect(f.end - f.start).toBeLessThanOrEqual(1.5);
      // never on top of the meeting or the call
      expect(f.end <= 10 || f.start >= 11).toBe(true);
      expect(f.end <= 11.5 || f.start >= 12).toBe(true);
    }
    // the most urgent item gets the first block
    expect(d.focus[0].e.key).toBe('INFRA-4');
  });

  it('plans nothing on a day that is over', () => {
    const d = buildWeek(events, [today], today, 18.5, {}).byDay.get(today)!;
    expect(d.focus).toHaveLength(0);
    expect(d.freeMin).toBe(0);
  });
});
