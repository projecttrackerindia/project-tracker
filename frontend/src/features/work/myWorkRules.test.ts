import { describe, expect, it } from 'vitest';
import { completedToday, myWorkBucket, weekEndOf } from './myWorkRules';
import { focusBlocks, focusForItems } from '../calendar/plannerModel';
import { instantIn, hourIn, isoDateIn } from '../../lib/zone';

describe('My Work rules (shared by both My Work screens)', () => {
  const today = '2026-11-02';
  it('keeps overdue work out of Today', () => {
    expect(myWorkBucket({ dueDate: '2026-10-30', isOverdue: true }, today)).toBe('overdue');
    expect(myWorkBucket({ dueDate: '2026-10-30', isOverdue: false }, today)).toBe('overdue');
    expect(myWorkBucket({ dueDate: today, isOverdue: false }, today)).toBe('today');
    expect(myWorkBucket({ dueDate: '2026-11-05', isOverdue: false }, today)).toBe('week');
    expect(myWorkBucket({ dueDate: '2026-11-20', isOverdue: false }, today)).toBe('later');
    expect(myWorkBucket({ dueDate: null, isOverdue: false }, today)).toBe('none');
    expect(weekEndOf(today)).toBe('2026-11-09');
  });
  it('counts done today from completedAt in the app zone, not updatedAt', () => {
    // 2026-11-01 20:00 UTC is 2 Nov 01:30 in Kolkata.
    expect(completedToday({ completedAt: '2026-11-01T20:00:00Z' }, today, 'Asia/Kolkata')).toBe(true);
    expect(completedToday({ completedAt: '2026-11-01T17:00:00Z' }, today, 'Asia/Kolkata')).toBe(false);
    expect(completedToday({ completedAt: null }, today, 'Asia/Kolkata')).toBe(false);
  });
});

describe('zone helpers build instants in the app zone, not the device zone', () => {
  it('turns a wall-clock time into the right instant across DST', () => {
    expect(instantIn('2026-11-02', 9.5, 'Asia/Kolkata').toISOString()).toBe('2026-11-02T04:00:00.000Z');
    expect(instantIn('2026-03-09', 9, 'America/New_York').toISOString()).toBe('2026-03-09T13:00:00.000Z');   // after the change: EDT
    expect(instantIn('2026-03-06', 9, 'America/New_York').toISOString()).toBe('2026-03-06T14:00:00.000Z');   // before: EST
    expect(hourIn(new Date('2026-11-02T04:00:00Z'), 'Asia/Kolkata')).toBe(9.5);
    expect(isoDateIn(new Date('2026-11-01T20:00:00Z'), 'Asia/Kolkata')).toBe('2026-11-02');
  });
});

describe('one focus-block rule', () => {
  it('fills free gaps of an hour or more between meetings', () => {
    const r = focusBlocks([[10, 11], [13, 13.5]], 9, 19, { max: 2, maxLen: 1.5 });
    expect(r.blocks).toEqual([{ start: 9, end: 10 }, { start: 11, end: 12.5 }]);
  });
  it('never places a block outside the item’s own window (the 11–15 maintenance window case)', () => {
    const r = focusForItems([{ item: 'INFRA-4', window: [11, 15] as const }], [[12, 13.75]], 13.75, 19, { max: 2, maxLen: 1.5 });
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].start).toBeGreaterThanOrEqual(11);
    expect(r.blocks[0].end).toBeLessThanOrEqual(15);
    const none = focusForItems([{ item: 'late', window: [11, 12] as const }], [], 13, 19);
    expect(none.blocks).toHaveLength(0);
  });
});
