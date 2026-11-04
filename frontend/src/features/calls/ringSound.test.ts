import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS } from '../notifications/centre/prefs';
import { ringMaySound } from './IncomingCall';

describe('incoming call ringtone', () => {
  const on = { ...DEFAULT_PREFS, cats: { ...DEFAULT_PREFS.cats, meetings: { ...DEFAULT_PREFS.cats.meetings, sound: true } } };
  it('rings when sound is on', () => expect(ringMaySound(on, true)).toBe(true));
  it('respects the device switch, Mute all, Do not disturb and the Meetings sound setting', () => {
    expect(ringMaySound(on, false)).toBe(false);
    expect(ringMaySound({ ...on, mutedUntil: -1 }, true)).toBe(false);
    expect(ringMaySound({ ...on, dnd: true }, true)).toBe(false);
    expect(ringMaySound({ ...on, cats: { ...on.cats, meetings: { ...on.cats.meetings, sound: false } } }, true)).toBe(false);
  });
});
