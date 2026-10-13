import { describe, expect, it } from 'vitest';
import { calendarDay, calendarDuration, calendarEnd } from './scheduleDates';

describe('calendar-day stage dates', () => {
  it('counts leap days and daylight-saving boundaries as calendar days', () => {
    expect(calendarEnd('2028-02-28', 2)).toBe('2028-03-01');
    expect(calendarDuration('2026-03-07', '2026-03-10')).toBe(3);
    expect(calendarDuration('2026-10-31', '2026-11-02')).toBe(2);
    expect(calendarEnd('2030-01-01', 0)).toBe('2030-01-01');
  });
  it('rejects malformed dates, fractional durations and calendar overflow', () => {
    expect(calendarDay('2026-02-30')).toBeNull();
    expect(calendarDay('0000-01-01')).toBeNull();
    expect(calendarDuration('', '2030-01-01')).toBeNull();
    expect(calendarEnd('2030-01-01', 1.5)).toBe('');
    expect(calendarEnd('9999-12-31', 1)).toBe('');
  });
});
