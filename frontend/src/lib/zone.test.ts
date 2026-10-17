import { afterEach, describe, expect, it, vi } from 'vitest';
import { appZone, canonicalZone, daysFromToday, isKnownZone, isoDateIn, setAppZones, shiftIsoDate, zoneOffsetLabel, zoneToday } from './zone';
import { daysUntil, dueLabel, todayISO } from './format';

afterEach(() => { vi.useRealTimers(); setAppZones(null, null); });

describe('app time zone', () => {
  it('prefers the person, then the workspace, then the device', () => {
    setAppZones('America/New_York', 'Europe/London');
    expect(appZone()).toBe('America/New_York');
    setAppZones(null, 'Europe/London');
    expect(appZone()).toBe('Europe/London');
    setAppZones('Not/AZone', null);
    expect(isKnownZone('Not/AZone')).toBe(false);
    expect(appZone()).toBe(canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone));
  });

  it('maps old zone names to current ones', () => {
    expect(canonicalZone('Asia/Calcutta')).toBe('Asia/Kolkata');
  });

  it('works out "today" in the person\'s zone, not the device\'s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T20:00:00Z'));   // 01:30 on the 18th in India, 16:00 on the 17th in New York
    setAppZones('Asia/Kolkata', null);
    expect(zoneToday()).toBe('2026-10-18');
    expect(todayISO()).toBe('2026-10-18');
    expect(daysUntil('2026-10-17')).toBe(-1);
    expect(dueLabel('2026-10-17')).toBe('Yesterday');
    setAppZones('America/New_York', null);
    expect(zoneToday()).toBe('2026-10-17');
    expect(daysUntil('2026-10-17')).toBe(0);
    expect(dueLabel('2026-10-17')).toBe('Today');
  });

  it('puts an instant on the right calendar day of a zone', () => {
    const instant = new Date('2026-03-08T07:30:00Z');
    expect(isoDateIn(instant, 'America/Los_Angeles')).toBe('2026-03-07');
    expect(isoDateIn(instant, 'Asia/Tokyo')).toBe('2026-03-08');
  });

  it('does calendar arithmetic without daylight-saving drift', () => {
    expect(shiftIsoDate('2026-03-07', 2)).toBe('2026-03-09');
    expect(shiftIsoDate('2026-01-01', -1)).toBe('2025-12-31');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T12:00:00Z'));
    expect(daysFromToday('2026-03-10', 'America/New_York')).toBe(2);
  });

  it('labels offsets', () => {
    expect(zoneOffsetLabel('Asia/Kolkata', new Date('2026-01-01T00:00:00Z'))).toBe('GMT+5:30');
    expect(zoneOffsetLabel('UTC', new Date('2026-01-01T00:00:00Z'))).toBe('GMT+0');
  });
});
