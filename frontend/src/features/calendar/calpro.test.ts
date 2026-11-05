import { describe, expect, it } from 'vitest';
import { breakdown, conflicts, parseQuick, toIcs } from './calpro';

// 2026-11-04 is a Wednesday.
const TODAY = '2026-11-04';

describe('quick create', () => {
  it('reads a day, a time, a length and people', () => {
    const q = parseQuick('Review with Ravi tomorrow 3pm 45m', TODAY);
    expect(q).toMatchObject({ day: '2026-11-05', start: 15, minutes: 45, people: ['Ravi'], dayGiven: true, timeGiven: true });
    expect(q.title).toBe('Review with Ravi');
  });
  it('reads weekdays, 24-hour times and hours', () => {
    expect(parseQuick('Planning fri 09:30 1.5h', TODAY)).toMatchObject({ day: '2026-11-06', start: 9.5, minutes: 90, title: 'Planning' });
    expect(parseQuick('Standup wed at 10', TODAY)).toMatchObject({ day: '2026-11-11', start: 10 });
  });
  it('reads a dated day and falls back sensibly', () => {
    expect(parseQuick('Board call 12 nov', TODAY)).toMatchObject({ day: '2026-11-12', start: 10, minutes: 30, dayGiven: true, timeGiven: false });
    expect(parseQuick('sync with Asha and Kiran', TODAY).people).toEqual(['Asha', 'Kiran']);
  });
});

describe('ics export', () => {
  it('writes a valid calendar with escaped text', () => {
    const t = toIcs([{ uid: 'a', title: 'Plan, review; ship', start: new Date('2026-11-04T09:00:00Z'), end: new Date('2026-11-04T10:00:00Z') }], new Date('2026-11-01T00:00:00Z'));
    expect(t).toContain('BEGIN:VCALENDAR');
    expect(t).toContain('DTSTART:20261104T090000Z');
    expect(t).toContain('SUMMARY:Plan\\, review\\; ship');
    expect(t.split('\r\n').at(-1)).toBe('END:VCALENDAR');
  });
});

describe('breakdown and conflicts', () => {
  it('splits reviews from meetings and scales to the longest bar', () => {
    const b = breakdown([{ title: 'Sprint review', hours: 1 }, { title: 'Sync', hours: 2 }], 240, 1);
    expect(b.map((x) => [x.key, x.hours])).toEqual([['meetings', 2], ['projects', 4], ['focus', 1], ['reviews', 1]]);
    expect(b[1].share).toBe(1);
  });
  it('flags overlapping spans only', () => {
    expect([...conflicts([{ key: 'a', start: 9, end: 10 }, { key: 'b', start: 9.5, end: 11 }, { key: 'c', start: 11, end: 12 }])].sort()).toEqual(['a', 'b']);
  });
});
