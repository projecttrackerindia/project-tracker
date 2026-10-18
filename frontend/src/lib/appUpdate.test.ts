import { describe, expect, it, vi } from 'vitest';
import { createUpdateChecker, isNewBuild, MIN_GAP_MS, parseVersion, runningBuild, shouldCheck, shouldShow } from './appUpdate';

// Plain Node: a "document" is only something that can answer querySelector.
const docWith = (content: string | null) => ({
  querySelector: (sel: string) => (sel === 'meta[name="app-build"]' && content !== null ? { getAttribute: (a: string) => (a === 'content' ? content : null) } : null),
}) as unknown as Document;

describe('runningBuild', () => {
  it('reads the build id from the page', () => {
    expect(runningBuild(docWith('8467c466eecaba4c'))).toBe('8467c466eecaba4c');
    expect(runningBuild(docWith('  abc-1.2_3  '))).toBe('abc-1.2_3');
  });
  it('is null without a usable id (development, or an older page)', () => {
    expect(runningBuild(docWith(null))).toBeNull();
    expect(runningBuild(docWith(''))).toBeNull();
    expect(runningBuild(docWith('<script>'))).toBeNull();
    expect(runningBuild(undefined)).toBeNull();
  });
});

describe('parseVersion', () => {
  it('takes the build from a well-formed answer', () => {
    expect(parseVersion({ build: 'b2' })).toBe('b2');
  });
  it('ignores anything else', () => {
    for (const junk of [null, undefined, 'b2', 42, {}, { build: 7 }, { build: '' }, { build: 'x'.repeat(65) }, { build: 'a b' }]) expect(parseVersion(junk)).toBeNull();
  });
});

describe('isNewBuild', () => {
  it('is true only when both are known and differ', () => {
    expect(isNewBuild('a', 'b')).toBe(true);
    expect(isNewBuild('a', 'a')).toBe(false);
    expect(isNewBuild(null, 'b')).toBe(false);
    expect(isNewBuild('a', null)).toBe(false);
  });
});

describe('shouldCheck', () => {
  const base = { hidden: false, online: true, now: 100_000, lastCheck: Number.NEGATIVE_INFINITY, inFlight: false };
  it('checks a visible, online tab', () => expect(shouldCheck(base)).toBe(true));
  it('never checks a hidden or offline tab, even when forced', () => {
    expect(shouldCheck({ ...base, hidden: true, force: true })).toBe(false);
    expect(shouldCheck({ ...base, online: false, force: true })).toBe(false);
  });
  it('never runs two checks at once', () => expect(shouldCheck({ ...base, inFlight: true, force: true })).toBe(false));
  it('waits out the minimum gap unless forced', () => {
    expect(shouldCheck({ ...base, lastCheck: base.now - MIN_GAP_MS + 1 })).toBe(false);
    expect(shouldCheck({ ...base, lastCheck: base.now - MIN_GAP_MS })).toBe(true);
    expect(shouldCheck({ ...base, lastCheck: base.now - 1, force: true })).toBe(true);
  });
});

describe('shouldShow', () => {
  it('shows a newer build until it is dismissed, and again for the next one', () => {
    expect(shouldShow(null, null)).toBe(false);
    expect(shouldShow('b', null)).toBe(true);
    expect(shouldShow('b', 'b')).toBe(false);
    expect(shouldShow('c', 'b')).toBe(true);
  });
});

describe('createUpdateChecker', () => {
  const setup = (opts: { running?: string | null; answers?: unknown[]; hidden?: boolean; online?: boolean } = {}) => {
    let t = 1_000_000;
    const env = { hidden: opts.hidden ?? false, online: opts.online ?? true };
    const answers = [...(opts.answers ?? [])];
    const fetchVersion = vi.fn(async () => { const a = answers.shift(); if (a instanceof Error) throw a; return a; });
    const onChange = vi.fn();
    const checker = createUpdateChecker({ running: opts.running === undefined ? 'a' : opts.running, fetchVersion, onChange, env: () => env, now: () => t });
    return { checker, fetchVersion, onChange, env, advance: (ms: number) => { t += ms; } };
  };

  it('stays quiet while the server has the running build (the first load)', async () => {
    const s = setup({ answers: [{ build: 'a' }] });
    expect(await s.checker.check()).toBe('a');
    expect(s.onChange).not.toHaveBeenCalled();
    expect(s.checker.newer).toBeNull();
  });

  it('reports a newer build once, however often the server repeats it', async () => {
    const s = setup({ answers: [{ build: 'b' }, { build: 'b' }] });
    await s.checker.check();
    s.advance(MIN_GAP_MS);
    await s.checker.check();
    expect(s.onChange).toHaveBeenCalledTimes(1);
    expect(s.onChange).toHaveBeenCalledWith('b');
    expect(s.checker.newer).toBe('b');
  });

  it('reports the next release, and a rollback to the running build', async () => {
    const s = setup({ answers: [{ build: 'b' }, { build: 'c' }, { build: 'a' }] });
    await s.checker.check(true);
    await s.checker.check(true);
    await s.checker.check(true);
    expect(s.onChange.mock.calls).toEqual([['b'], ['c'], [null]]);
  });

  it('throttles focus checks but not forced ones', async () => {
    const s = setup({ answers: [{ build: 'a' }, { build: 'a' }, { build: 'a' }] });
    await s.checker.check();
    expect(await s.checker.check()).toBeNull();          // focus right after visibilitychange: skipped
    expect(s.fetchVersion).toHaveBeenCalledTimes(1);
    await s.checker.check(true);                         // the regular timer
    expect(s.fetchVersion).toHaveBeenCalledTimes(2);
    s.advance(MIN_GAP_MS);
    await s.checker.check();
    expect(s.fetchVersion).toHaveBeenCalledTimes(3);
  });

  it('does not ask from a hidden or offline tab', async () => {
    const s = setup({ hidden: true, answers: [{ build: 'b' }] });
    expect(await s.checker.check(true)).toBeNull();
    s.env.hidden = false; s.env.online = false;
    expect(await s.checker.check(true)).toBeNull();
    expect(s.fetchVersion).not.toHaveBeenCalled();
    s.env.online = true;
    await s.checker.check(true);
    expect(s.onChange).toHaveBeenCalledWith('b');
  });

  it('runs one request at a time', async () => {
    const s = setup({ answers: [{ build: 'b' }] });
    const first = s.checker.check(true);
    expect(await s.checker.check(true)).toBeNull();
    await first;
    expect(s.fetchVersion).toHaveBeenCalledTimes(1);
  });

  it('treats a failed or malformed answer as no answer', async () => {
    const s = setup({ answers: [new Error('offline'), '<!doctype html>', { build: 'b' }] });
    expect(await s.checker.check(true)).toBeNull();
    expect(await s.checker.check(true)).toBeNull();
    expect(s.onChange).not.toHaveBeenCalled();
    expect(await s.checker.check(true)).toBe('b');
    expect(s.onChange).toHaveBeenCalledWith('b');
  });

  it('never checks when the page does not know its own build (development)', async () => {
    const s = setup({ running: null, answers: [{ build: 'b' }] });
    expect(await s.checker.check(true)).toBeNull();
    expect(s.fetchVersion).not.toHaveBeenCalled();
  });
});
