import { describe, expect, it, vi, afterEach } from 'vitest';
import { committedHereRecently, mutationCommitted, mutationFamilies } from './mutationEffects';
afterEach(() => vi.unstubAllGlobals());
describe('successful mutation refresh routing', () => {
  it('refreshes task lists, project details and calendars after writes', () => {
    expect(mutationFamilies('DELETE', '/tasks/id')).toEqual(expect.arrayContaining(['tasks', 'project', 'timeline', 'work']));
    expect(mutationFamilies('PATCH', '/work-tasks/id')).toContain('work-items');
    expect(mutationFamilies('POST', '/tasks/id/time')).toEqual(expect.arrayContaining(['time', 'timesheet', 'portfolio']));
    expect(mutationFamilies('POST', '/work-tasks/id/time')).toContain('time');
    expect(mutationFamilies('DELETE', '/tasks/id')).toContain('timesheet');
    expect(mutationFamilies('POST', '/tasks/id/timer/start')).toContain('timer');
  });
  it('does not refresh time views for an ordinary work edit', () => {
    for (const path of ['/tasks/id', '/work-items/id', '/projects/id/tasks'])
      for (const f of ['time', 'timesheet', 'timer']) expect(mutationFamilies('PATCH', path)).not.toContain(f);
    expect(mutationFamilies('PATCH', '/tasks/id')).toEqual(expect.arrayContaining(['my-work', 'plan-sheet', 'dashboard', 'inbox']));
    expect(mutationFamilies('POST', '/time/grid')).toContain('portfolio');
    expect(mutationFamilies('POST', '/time/grid')).toEqual(expect.arrayContaining(['time', 'timesheet', 'timeline']));
  });
  it('does not turn reads, previews or auth into refresh loops', () => {
    for (const [method, path] of [['GET', '/tasks'], ['POST', '/time/words'], ['POST', '/auth/refresh'], ['POST', '/ai/ask']])
      expect(mutationFamilies(method, path)).toEqual([]);
  });
  it('does not fail a saved request when a cache listener throws', () => {
    vi.stubGlobal('window', { dispatchEvent: () => { throw new Error('listener failure'); } });
    expect(() => mutationCommitted('DELETE', '/tasks/id', 'workspace')).not.toThrow();
  });
  it('preserves the initiating workspace and skips anonymous changes', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    mutationCommitted('DELETE', '/tasks/id', 'old-workspace');
    expect(dispatchEvent.mock.calls[0][0].detail.workspaceId).toBe('old-workspace');
    mutationCommitted('DELETE', '/tasks/id', null);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
  it('remembers a local work save so the live echo of it can be skipped', () => {
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    mutationCommitted('PATCH', '/tasks/id', 'workspace');
    expect(committedHereRecently()).toBe(true);
    expect(committedHereRecently(Date.now() + 10_000)).toBe(false);
  });
});
