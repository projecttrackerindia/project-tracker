import { describe, expect, it, vi, afterEach } from 'vitest';
import { mutationCommitted, mutationFamilies } from './mutationEffects';
afterEach(() => vi.unstubAllGlobals());
describe('successful mutation refresh routing', () => {
  it('refreshes task lists, project details and calendars after writes', () => {
    expect(mutationFamilies('DELETE', '/tasks/id')).toEqual(expect.arrayContaining(['tasks', 'project', 'timeline', 'work']));
    expect(mutationFamilies('PATCH', '/work-tasks/id')).toContain('work-items');
    expect(mutationFamilies('POST', '/time/grid')).toEqual(expect.arrayContaining(['time', 'timesheet', 'timeline']));
  });
  it('does not turn reads, previews or auth into refresh loops', () => {
    for (const [method, path] of [['GET', '/tasks'], ['POST', '/time/words'], ['POST', '/auth/refresh'], ['POST', '/ai/ask']])
      expect(mutationFamilies(method, path)).toEqual([]);
  });
  it('preserves the initiating workspace and skips anonymous changes', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    mutationCommitted('DELETE', '/tasks/id', 'old-workspace');
    expect(dispatchEvent.mock.calls[0][0].detail.workspaceId).toBe('old-workspace');
    mutationCommitted('DELETE', '/tasks/id', null);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
});
