import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from '../../api/types';
import { setAppZones } from '../../lib/zone';
import { buildWeek, dayCounts, daySignature, deadlineHourOf, focusLabel, focusWord, freeMinutesOf, isDueReminder, loggedMinutesOf, shiftOf, stickFocus, timeOverlaps, workWeek } from './timeline';

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

describe('Your day stays put', () => {
  it('keeps a started focus block where it is after a refresh (12:29 then 12:35)', () => {
    const at1029 = 12 + 29 / 60, at1035 = 12 + 35 / 60;
    const first = buildWeek(events, [today], today, Math.ceil(at1029 * 4) / 4, {}).byDay.get(today)!;
    const block = first.focus.find((f) => f.start <= at1029 + 0.25)!;
    expect(block).toBeTruthy();
    const plan = stickFocus(first.focus, {}, today, at1029)!;
    expect(plan).not.toBeNull();
    const later = buildWeek(events, [today], today, Math.ceil(at1035 * 4) / 4, plan).byDay.get(today)!;
    const same = later.focus.find((f) => f.e.id === block.e.id)!;
    expect(same.start).toBe(block.start);
    expect(same.pinned).toBe(false);   // kept by the plan, not "moved by you"
    expect(stickFocus(later.focus, plan, today, at1035)).toBeNull();   // nothing more to write
    expect(focusWord(same, today, Math.max(at1035, same.start))).toBe('Focus now');
    // the kept block of an earlier day is dropped from the plan
    expect(stickFocus([], plan, '2026-10-29', 9)).toEqual({});
  });

  it('places a date-only deadline at the shift end and a timed one at its time', () => {
    expect(deadlineHourOf({ date: today }, { end: 18 })).toBe(18);
    expect(deadlineHourOf({ date: today, dueTime: '15:30' }, { end: 18 })).toBe(15.5);
  });

  it('counts logged time as the Time grid does (every finished entry in full, a running timer not yet), and free time from max(now, check-in) to the shift end', () => {
    const future = ev({ id: 't9', type: 'time', title: 'Rotate keys', start: '2026-10-28T09:31:00Z', end: '2026-10-28T11:31:00Z', minutes: 120, date: today, sourceType: 'timeEntry' });
    const running = ev({ id: 't10', type: 'time', title: 'Live', start: '2026-10-28T12:00:00Z', minutes: 0, running: true, date: today, sourceType: 'timeEntry' });
    expect(loggedMinutesOf([future])).toBe(120);
    expect(loggedMinutesOf([future, running])).toBe(120);
    const shift = shiftOf([ev({ id: 'a1', type: 'attendance', start: '2026-10-28T09:31:00Z', date: today, sourceType: 'attendance' })]);
    expect(shift).toEqual({ start: 9 + 31 / 60, end: 18, checkIn: 9 + 31 / 60 });
    // 9:00, checked in at 9:31: from 9:31 to 18:00 less the 12:00-12:30 meeting
    expect(freeMinutesOf(today, today, 9, shift, [[12, 12.5]], false)).toBe(8 * 60 + 29 - 30);
    expect(freeMinutesOf(today, today, 18 + 40 / 60, shift, [], false)).toBe(0);
    expect(freeMinutesOf('2026-10-27', today, 9, shift, [], false)).toBe(0);
  });

  // The owner's Thursday at 13:31: WT-11 2h (09:31-11:31) and WT-12 3h logged as a duration ending now (10:31-13:31) overlap.
  const thu = '2026-10-29';
  const wt11 = ev({ id: 'time:a', type: 'time', title: 'Production issue', start: '2026-10-29T09:31:00Z', end: '2026-10-29T11:31:00Z', minutes: 120, date: thu, sourceType: 'timeEntry', sourceId: 'a', itemId: 'w11', userId: 'u' });
  const wt12 = ev({ id: 'time:b', type: 'time', title: 'Juspay QR', start: '2026-10-29T10:31:00Z', end: '2026-10-29T13:31:00Z', minutes: 180, date: thu, sourceType: 'timeEntry', sourceId: 'b', itemId: 'w12', userId: 'u' });
  const due11 = ev({ id: 'due:work:w11', type: 'due', title: 'Production issue', key: 'WT-11', allDay: true, start: '2026-10-29T00:00:00Z', date: thu, sourceType: 'work', sourceId: 'w11', priority: 'High' });
  const due12 = ev({ id: 'due:work:w12', type: 'due', title: 'Juspay QR', key: 'WT-12', allDay: true, start: '2026-10-29T00:00:00Z', date: thu, sourceType: 'work', sourceId: 'w12', priority: 'Critical' });
  const autoRem = ev({ id: 'reminder:r1', type: 'reminder', title: 'WT-11 is due today', key: 'WT-11', start: '2026-10-29T10:30:00Z', date: thu, sourceType: 'reminder', sourceId: 'r1', status: 'scheduled', origin: 'dueDate', itemId: 'w11' });
  const oldAuto = ev({ id: 'reminder:r2', type: 'reminder', title: 'WT-12 is due today', key: 'WT-12', start: '2026-10-29T15:45:00Z', date: thu, sourceType: 'reminder', sourceId: 'r2', status: 'scheduled' });
  const manual = ev({ id: 'reminder:r3', type: 'reminder', title: 'Call the bank about WT-12', key: 'WT-12', start: '2026-10-29T16:00:00Z', date: thu, sourceType: 'reminder', sourceId: 'r3', status: 'scheduled', origin: 'personal' });

  it('flags overlapping entries but counts both in full, like the Time grid (5h)', () => {
    const d = buildWeek([wt11, wt12], [thu], thu, 13.5, {}).byDay.get(thu)!;
    expect(d.loggedMin).toBe(300);
    expect(d.overlaps.get('time:a')?.map((t) => t.id)).toEqual(['time:b']);
    expect(d.overlaps.get('time:b')?.map((t) => t.id)).toEqual(['time:a']);
    // a typed-in duration is placed by the server: its position is a guess, never a warning
    expect(timeOverlaps([wt11, { ...wt12, approximated: true }]).size).toBe(0);
    // entries that only touch do not overlap
    expect(timeOverlaps([wt11, { ...wt12, start: '2026-10-29T11:31:00Z' }]).size).toBe(0);
  });

  it('draws one marker per deadline: automatic due reminders are hidden beside their deadline, manual ones stay', () => {
    expect(isDueReminder(autoRem)).toBe(true);
    expect(isDueReminder(oldAuto)).toBe(true);
    expect(isDueReminder(manual)).toBe(false);
    const d = buildWeek([due11, due12, autoRem, oldAuto, manual], [thu], thu, 9, {}).byDay.get(thu)!;
    expect(d.reminders.map((t) => t.id)).toEqual(['reminder:r3']);
    expect(d.hiddenReminders.map((t) => t.id).sort()).toEqual(['reminder:r1', 'reminder:r2']);
    // without the deadline on the day, the automatic reminder is the only marker and is drawn
    expect(buildWeek([autoRem], [thu], thu, 9, {}).byDay.get(thu)!.reminders.length).toBe(1);
  });

  it('plans no focus for work already logged in full today, shortens it for partial time, and never over logged time', () => {
    // WT-12 has 3h today (more than a 90-minute block): no block. WT-11 has 2h: none either.
    const full = buildWeek([wt11, wt12, due11, due12], [thu], thu, 13.5, {}).byDay.get(thu)!;
    expect(full.focus).toEqual([]);
    // 45 minutes on WT-12: its block is at most 45 minutes, after now
    const part = buildWeek([{ ...wt12, start: '2026-10-29T12:46:00Z', minutes: 45 }, due12], [thu], thu, 13.5, {}).byDay.get(thu)!;
    expect(part.focus).toHaveLength(1);
    expect(part.focus[0].end - part.focus[0].start).toBeLessThanOrEqual(.75);
    expect(part.focus[0].start).toBeGreaterThanOrEqual(13.5);
    // a running timer on WT-12: it is being worked, no block
    const run = buildWeek([{ ...wt12, end: null, running: true, minutes: 0, start: '2026-10-29T13:00:00Z' }, due12], [thu], thu, 13.5, {}).byDay.get(thu)!;
    expect(run.focus).toEqual([]);
    // a block the plan kept (it had started) goes once the work is logged in full
    const kept = buildWeek([wt12, due12], [thu], thu, 13.5, { 'work:w12': { day: thu, start: 11.5, len: 2.75, auto: true } }).byDay.get(thu)!;
    expect(kept.focus).toEqual([]);
    // one you placed yourself stays
    const mine = buildWeek([wt12, due12], [thu], thu, 13.5, { 'work:w12': { day: thu, start: 15, len: 1 } }).byDay.get(thu)!;
    expect(mine.focus.map((f) => f.start)).toEqual([15]);
  });
});
