import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_AFTER_MS, trackIdle } from './idle';

// The unit tests run in plain Node (no browser): a window and a document are just something that can send and receive events.
const fakeWindow = () => Object.assign(new EventTarget(), {
  setInterval: (fn: () => void, ms: number) => globalThis.setInterval(fn, ms),
  clearInterval: (id: number) => globalThis.clearInterval(id),
});

describe('trackIdle', () => {
  let t = 0;
  let win: ReturnType<typeof fakeWindow>;
  let doc: EventTarget;
  const now = () => t;
  beforeEach(() => {
    vi.useFakeTimers();
    t = 1_000_000;
    win = fakeWindow();
    doc = new EventTarget();
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const run = (ms: number) => { t += ms; vi.advanceTimersByTime(ms); };

  it('starts active and goes idle after five minutes without activity', () => {
    const changes: boolean[] = [];
    const tracker = trackIdle((i) => changes.push(i), { now });
    run(IDLE_AFTER_MS - 20_000);
    expect(tracker.isIdle()).toBe(false);
    run(30_000);
    expect(tracker.isIdle()).toBe(true);
    expect(changes).toEqual([true]);
    tracker.stop();
  });

  it('comes back as soon as there is keyboard, mouse or touch activity', () => {
    const changes: boolean[] = [];
    const tracker = trackIdle((i) => changes.push(i), { now });
    run(IDLE_AFTER_MS + 20_000);
    win.dispatchEvent(new Event('keydown'));
    expect(tracker.isIdle()).toBe(false);
    expect(changes).toEqual([true, false]);
    tracker.stop();
  });

  it('activity keeps the person active', () => {
    const tracker = trackIdle(() => undefined, { now });
    for (let i = 0; i < 6; i++) { run(IDLE_AFTER_MS / 2); win.dispatchEvent(new Event('mousemove')); }
    expect(tracker.isIdle()).toBe(false);
    tracker.stop();
  });

  it('notices a long sleep at the first check after waking (the timers did not run while asleep)', () => {
    const tracker = trackIdle(() => undefined, { now });
    t += 2 * 60 * 60_000;                       // the laptop was closed for two hours; no timer fired
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(tracker.isIdle()).toBe(true);
    tracker.stop();
  });

  it('reports each change once and stops listening when stopped', () => {
    const changes: boolean[] = [];
    const tracker = trackIdle((i) => changes.push(i), { now });
    run(IDLE_AFTER_MS + 60_000);
    run(60_000);
    expect(changes).toEqual([true]);
    tracker.stop();
    win.dispatchEvent(new Event('mousemove'));
    expect(changes).toEqual([true]);
  });
});
