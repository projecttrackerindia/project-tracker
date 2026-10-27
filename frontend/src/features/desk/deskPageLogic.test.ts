import { describe, expect, it } from 'vitest';
import { clock, deskRing, firstLine, initials, leftLabel } from './deskPageLogic';

const now = Date.parse('2026-10-27T10:00:00Z');
const at = (min: number) => new Date(now + min * 60e3).toISOString();

describe('desk ring', () => {
  it('drains green, amber under an hour, red under 15 minutes and when breached', () => {
    expect(deskRing(at(-60), at(240), null, now)).toEqual({ left: 0.8, tone: 'ok' });
    expect(deskRing(at(-60), at(38), null, now).tone).toBe('warn');
    expect(deskRing(at(-60), at(9), null, now).tone).toBe('late');
    expect(deskRing(at(-60), at(-1), null, now)).toEqual({ left: 1, tone: 'late' });
    expect(deskRing(at(-60), at(120), 'Breached', now).tone).toBe('late');
    expect(deskRing(at(-60), at(120), 'Paused', now).tone).toBe('idle');
    expect(deskRing(null, null, null, now).tone).toBe('idle');
  });
  it('labels the time left', () => {
    expect(leftLabel(at(9), now)).toBe('9m');
    expect(leftLabel(at(245), now)).toBe('4h');
    expect(leftLabel(at(3000), now)).toBe('2d');
  });
  it('counts the incident clock', () => {
    expect(clock(new Date(now - (90 * 60 + 42) * 1000).toISOString(), now)).toBe('1:30:42');
    expect(clock(new Date(now - 26 * 3600e3).toISOString(), now)).toBe('1d 02:00:00');
  });
  it('trims the first line and makes initials', () => {
    expect(firstLine('\n  Payouts paused \nmore')).toBe('Payouts paused');
    expect(firstLine(null)).toBeNull();
    expect(initials('Ramesh Naidu')).toBe('RN');
  });
});
