import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstTime, kindForType, resetSeen, setSoundOn, soundOn, SOUNDS } from './attention';

describe('attention', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    resetSeen();
    store.clear();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('rings once for the same alert, again after it has expired', () => {
    expect(firstTime('chat-1', 1000, 0)).toBe(true);
    expect(firstTime('chat-1', 1000, 500)).toBe(false);
    expect(firstTime('chat-2', 1000, 500)).toBe(true);
    expect(firstTime('chat-1', 1000, 2000)).toBe(true);
  });

  it('gives urgent kinds the beacon, chat the pop and the rest the chime', () => {
    expect(kindForType('Reminder')).toBe('urgent');
    expect(kindForType('Overdue')).toBe('urgent');
    expect(kindForType('ServiceLevel')).toBe('urgent');
    expect(kindForType('Security')).toBe('urgent');
    expect(kindForType('Message')).toBe('message');
    expect(kindForType('Mention')).toBe('message');
    expect(kindForType('TaskAssigned')).toBe('update');
  });

  it('has three different sounds, the urgent one the longest and loudest to notice', () => {
    expect(SOUNDS.message.length).toBe(2);
    expect(SOUNDS.update.length).toBe(3);
    expect(SOUNDS.urgent.length).toBe(12);
    const end = (k: keyof typeof SOUNDS) => Math.max(...SOUNDS[k].map((n) => n.at + n.length));
    expect(end('urgent')).toBeGreaterThan(end('update'));
    expect(end('update')).toBeGreaterThan(end('message'));
  });

  it('remembers the sound switch', () => {
    expect(soundOn()).toBe(true);
    setSoundOn(false);
    expect(soundOn()).toBe(false);
    setSoundOn(true);
    expect(soundOn()).toBe(true);
  });
});
