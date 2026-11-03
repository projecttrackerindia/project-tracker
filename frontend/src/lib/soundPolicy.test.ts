import { describe, expect, it } from 'vitest';
import { COALESCE_MS, gainOf, inQuietHours, shouldPlay, type SoundContext } from './soundPolicy';

const base: SoundContext = { now: 100_000, lastPlayedAt: null, masterOn: true, categoryOn: true, dnd: false, muted: false, quiet: false };

describe('notification sound rules', () => {
  it('plays for a normal arrival', () => expect(shouldPlay(base).play).toBe(true));
  it('never for my own action or the conversation on screen', () => {
    expect(shouldPlay({ ...base, own: true })).toEqual({ play: false, reason: 'own' });
    expect(shouldPlay({ ...base, viewingSame: true })).toEqual({ play: false, reason: 'viewing' });
  });
  it('muted chats stay silent unless they @mention me', () => {
    expect(shouldPlay({ ...base, mutedChat: true }).play).toBe(false);
    expect(shouldPlay({ ...base, mutedChat: true, mention: true }).play).toBe(true);
  });
  it('nothing during Do Not Disturb, Mute all or quiet hours', () => {
    expect(shouldPlay({ ...base, dnd: true }).play).toBe(false);
    expect(shouldPlay({ ...base, muted: true }).play).toBe(false);
    expect(shouldPlay({ ...base, quiet: true })).toEqual({ play: false, reason: 'quiet' });
  });
  it('a burst is one sound', () => {
    expect(shouldPlay({ ...base, lastPlayedAt: base.now - 1000 })).toEqual({ play: false, reason: 'coalesced' });
    expect(shouldPlay({ ...base, lastPlayedAt: base.now - COALESCE_MS }).play).toBe(true);
  });
  it('respects the category switch and the master switch', () => {
    expect(shouldPlay({ ...base, categoryOn: false }).play).toBe(false);
    expect(shouldPlay({ ...base, masterOn: false }).play).toBe(false);
  });
});

describe('quiet hours and volume', () => {
  it('wraps overnight', () => {
    expect(inQuietHours('21:00', '08:00', 22 * 60)).toBe(true);
    expect(inQuietHours('21:00', '08:00', 7 * 60 + 59)).toBe(true);
    expect(inQuietHours('21:00', '08:00', 12 * 60)).toBe(false);
    expect(inQuietHours('13:00', '14:00', 13 * 60 + 30)).toBe(true);
    expect(inQuietHours(null, '08:00', 0)).toBe(false);
  });
  it('maps volume to a gentle gain', () => {
    expect(gainOf(0)).toBe(0);
    expect(gainOf(1)).toBe(1);
    expect(gainOf(0.5)).toBeLessThan(0.5);
  });
});
