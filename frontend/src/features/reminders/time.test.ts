import { describe, expect, it } from 'vitest';
import { firstOccurrence, fromRRule, naive, parseReminder, ruleText, toRRule } from './time';

// Friday 23 October 2026, 10:00 (naive local time, as the app uses it).
const now = naive(2026, 9, 23, 10, 0);

describe('parseReminder', () => {
  it('reads a one-off time in plain words', () => {
    const p = parseReminder('call Priya tomorrow at 3pm', now);
    expect(p?.kind).toBe('at');
    expect(p?.title).toBe('Call Priya');   // titles start with a capital
    if (p?.kind === 'at') expect(p.local.toISOString()).toBe('2026-10-24T15:00:00.000Z');
  });

  it('reads a weekly repeat', () => {
    const p = parseReminder('every Friday 4pm submit timesheet', now);
    expect(p?.kind).toBe('repeat');
    if (p?.kind === 'repeat') {
      expect(toRRule(p.rule)).toBe('FREQ=WEEKLY;BYDAY=FR');
      expect(p.local.toISOString()).toBe('2026-10-23T16:00:00.000Z');
    }
  });

  it('reads a yearly repeat on a given date, starting this year or next', () => {
    const p = parseReminder("Ravi's birthday every year on 5 March", now);
    expect(p?.kind).toBe('repeat');
    if (p?.kind === 'repeat') {
      expect(toRRule(p.rule)).toBe('FREQ=YEARLY');
      expect(p.title).toBe("Ravi's birthday");
      expect(p.local.toISOString()).toBe('2027-03-05T09:00:00.000Z');   // March has passed this year
      expect(p.label).toMatch(/^every year at 09:00/);
    }
    const renew = parseReminder('renew the domain annually on 1 December at 11am', now);
    if (renew?.kind === 'repeat') expect(renew.local.toISOString()).toBe('2026-12-01T11:00:00.000Z');
    else throw new Error('not a repeat');
  });

  it('reads every N years', () => {
    const p = parseReminder('passport check every 5 years', now);
    expect(p?.kind === 'repeat' && p.rule).toMatchObject({ freq: 'YEARLY', interval: 5 });
  });
});

describe('rules', () => {
  it('round-trips yearly rules and describes them', () => {
    const r = fromRRule('FREQ=YEARLY;INTERVAL=2')!;
    expect(r.freq).toBe('YEARLY');
    expect(toRRule(r)).toBe('FREQ=YEARLY;INTERVAL=2');
    expect(ruleText(r)).toBe('every 2 years');
  });

  it('finds the next yearly date from today (today if still ahead)', () => {
    const r = fromRRule('FREQ=YEARLY')!;
    expect(firstOccurrence(r, now, 18, 0).toISOString()).toBe('2026-10-23T18:00:00.000Z');
    expect(firstOccurrence(r, now, 9, 0).toISOString()).toBe('2027-10-23T09:00:00.000Z');
  });
});
