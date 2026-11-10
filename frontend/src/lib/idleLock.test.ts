import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PING_EVERY_MS, WARN_BEFORE_MS, countdown, createIdleLock, type IdlePhase } from './idleLock';

// Plain Node: a window and a document that can send and receive events, an in-memory localStorage, and a BroadcastChannel shared by "tabs".
const fakeWindow = () => Object.assign(new EventTarget(), {
  setInterval: (fn: () => void, ms: number) => globalThis.setInterval(fn, ms),
  clearInterval: (id: number) => globalThis.clearInterval(id),
});
class FakeChannel extends EventTarget {
  static all: FakeChannel[] = [];
  constructor(public name: string) { super(); FakeChannel.all.push(this); }
  postMessage(data: unknown) { for (const c of FakeChannel.all) if (c !== this && c.name === this.name) c.dispatchEvent(Object.assign(new Event('message'), { data })); }
  close() { FakeChannel.all = FakeChannel.all.filter((c) => c !== this); }
}

describe('createIdleLock', () => {
  let t = 0;
  const now = () => t;
  const store = new Map<string, string>();
  beforeEach(() => {
    vi.useFakeTimers(); t = 1_000_000; store.clear(); FakeChannel.all = [];
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    vi.stubGlobal('BroadcastChannel', FakeChannel);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const run = (ms: number) => { for (let i = 0; i < ms; i += 1000) { t += 1000; vi.advanceTimersByTime(1000); } };
  const make = (timeoutMs = 30 * 60_000) => {
    const phases: IdlePhase[] = []; const pings: number[] = []; const due: number[] = []; const remote: string[] = [];
    const lock = createIdleLock({ timeoutMs, now, onPhase: (p) => { if (phases.at(-1) !== p) phases.push(p); }, onPing: () => pings.push(t), onLockDue: () => due.push(t), onRemote: (w) => remote.push(w) });
    return { lock, phases, pings, due, remote };
  };

  it('warns two minutes before the time and locks at the time', () => {
    const a = make();
    run(30 * 60_000 - WARN_BEFORE_MS - 2000);
    expect(a.lock.phase()).toBe('active');
    run(3000);
    expect(a.lock.phase()).toBe('warning');
    run(WARN_BEFORE_MS);
    expect(a.lock.phase()).toBe('locked');
    expect(a.due).toHaveLength(1);
    a.lock.stop();
  });

  it('keyboard or pointer use resets the timer and pings the server at most once a minute', () => {
    const a = make();
    for (let i = 0; i < 10; i++) { run(10_000); window.dispatchEvent(new Event('keydown')); }
    expect(a.pings.length).toBeLessThanOrEqual(Math.ceil(100_000 / PING_EVERY_MS) + 1);
    run(29 * 60_000);
    expect(a.lock.phase()).not.toBe('locked');
    a.lock.stop();
  });

  it('use in one tab keeps the other open, and they lock and unlock together', () => {
    const a = make(); const b = make();
    run(20 * 60_000);
    window.dispatchEvent(new Event('pointerdown'));   // both fake tabs share the window here; the channel carries it either way
    run(20 * 60_000);
    expect(b.lock.phase()).not.toBe('locked');
    a.lock.lockNow();
    expect(b.lock.phase()).toBe('locked');
    a.lock.unlocked();
    expect(b.remote).toContain('unlock');
    expect(b.lock.phase()).toBe('active');
    a.lock.stop(); b.lock.stop();
  });

  it('coming back after the time (timers asleep) locks rather than counting as use; never means never', () => {
    const a = make();
    t += 31 * 60_000;   // the laptop slept: no timer ran
    window.dispatchEvent(new Event('mousedown'));
    expect(a.lock.phase()).toBe('locked');
    a.lock.stop();
    const never = make(0);
    run(10 * 60_000); t += 24 * 60 * 60_000; run(1000);
    expect(never.lock.phase()).toBe('active');
    never.lock.stop();
  });

  it('formats the countdown', () => {
    expect(countdown(120_000)).toBe('2:00');
    expect(countdown(61_500)).toBe('1:02');
    expect(countdown(0)).toBe('0:00');
  });
});
