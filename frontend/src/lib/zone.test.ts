import { afterEach, describe, expect, it, vi } from 'vitest';
import { appZone, canonicalZone, daysFromToday, hourIn, isKnownZone, isPlaceholderZone, isoDateIn, resolveZone, setAppZones, shiftIsoDate, zoneAbbrev, zoneBadge, zoneOffsetLabel, zoneToday } from './zone';
import { daysUntil, dueLabel, todayISO } from './format';

afterEach(() => { vi.useRealTimers(); setAppZones(null, null, null, false); });

describe('app time zone', () => {
  it('prefers the person, then the workspace, then the device', () => {
    setAppZones('America/New_York', 'Europe/London');
    expect(appZone()).toBe('America/New_York');
    setAppZones(null, 'Europe/London');
    expect(appZone()).toBe('Europe/London');
    setAppZones('Not/AZone', null);
    expect(isKnownZone('Not/AZone')).toBe(false);
    const device = canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(appZone()).toBe(isPlaceholderZone(device) ? 'Asia/Kolkata' : device);
  });

  it('uses the zone the server worked out for the person before anything else', () => {
    setAppZones('UTC', null, 'Asia/Kolkata', false);
    expect(appZone()).toBe('Asia/Kolkata');
    setAppZones('UTC', null, 'UTC', true);
    expect(appZone()).toBe('UTC');
  });

  it('treats a reported or default UTC as "not set": the organization, then a real device zone, then India', () => {
    for (const z of ['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT', '', null, 'Not/AZone']) expect(isPlaceholderZone(z)).toBe(true);
    for (const z of ['Asia/Kolkata', 'Europe/London', 'Africa/Abidjan']) expect(isPlaceholderZone(z)).toBe(false);
    expect(resolveZone('UTC', false, 'Asia/Dubai', 'Etc/UTC')).toBe('Asia/Dubai');
    expect(resolveZone('Etc/UTC', false, null, 'Europe/Berlin')).toBe('Europe/Berlin');
    expect(resolveZone('UTC', false, null, 'Etc/UTC')).toBe('Asia/Kolkata');
    expect(resolveZone('UTC', true, 'Asia/Dubai', 'Etc/UTC')).toBe('UTC');
    expect(resolveZone('America/New_York', false, 'Asia/Dubai', 'Etc/UTC')).toBe('America/New_York');
    expect(resolveZone('Asia/Calcutta', false, null)).toBe('Asia/Kolkata');
  });

  it('puts hours and days in the app zone even when the device runs on UTC', () => {
    setAppZones('Etc/UTC', null, null, false);   // what an Electron shell reports, no zone from the server yet
    const instant = new Date('2026-10-28T19:00:00Z');
    const zone = resolveZone('Etc/UTC', false, null, 'Etc/UTC');
    expect(zone).toBe('Asia/Kolkata');
    expect(isoDateIn(instant, zone)).toBe('2026-10-29');
    expect(hourIn(instant, zone)).toBe(0.5);
    setAppZones('UTC', null, 'Asia/Kolkata', false);
    expect(isoDateIn(instant)).toBe('2026-10-29');
    expect(hourIn(new Date('2026-10-29T04:00:00Z'))).toBe(9.5);
  });

  it('names the zone with a short badge only when it differs from the device', () => {
    expect(zoneAbbrev('Asia/Kolkata', new Date('2026-01-01T00:00:00Z'))).toBe('IST');
    expect(zoneBadge('Asia/Kolkata', 'Etc/UTC')).toBe('IST');
    expect(zoneBadge('Asia/Kolkata', 'Asia/Calcutta')).toBeNull();
    expect(zoneBadge('Europe/London', 'Europe/London')).toBeNull();
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
