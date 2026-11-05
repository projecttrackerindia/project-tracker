import { describe, expect, it } from 'vitest';
import { buildGlance } from './nativeQuick';

describe('Android Today widget glance', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  it('takes three tasks, the next meeting and the check-in ring', () => {
    const g = buildGlance([{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }], { title: 'Stand-up', start: '2026-11-05T13:00:00Z', joinUrl: 'https://meet.example/x', ref: 'w:1' },
      { checkInAt: '2026-11-05T08:00:00Z', checkOutAt: null }, now);
    expect(g.tasks.map((t) => t.title)).toEqual(['A', 'B', 'C']);
    expect(g.meeting?.link).toBe('/meetings?open=w%3A1');
    expect(g.checkInPercent).toBe(50);
    expect(g.checkInLabel).toBe('In · 4h 00m');
  });
  it('says so when not checked in, with no meeting', () => {
    const g = buildGlance([], null, null, now);
    expect(g).toEqual({ tasks: [], meeting: null, checkInPercent: 0, checkInLabel: 'Not checked in' });
  });
});
