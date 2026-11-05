import { describe, expect, it } from 'vitest';
import { shouldAutoOpen } from './open';

describe('welcome tour auto-open', () => {
  it('opens once in a brand-new workspace', () => expect(shouldAutoOpen(null, false, 0)).toBe(true));
  it('stays closed once seen', () => expect(shouldAutoOpen({ done: true }, false, 0)).toBe(false));
  it('stays closed when the workspace already has projects', () => expect(shouldAutoOpen(null, false, 3)).toBe(false));
  it('stays closed when the sample is there', () => expect(shouldAutoOpen(null, true, 1)).toBe(false));
  it('stays closed on any unclear answer', () => {
    expect(shouldAutoOpen(undefined, false, 0)).toBe(false);
    expect(shouldAutoOpen(null, undefined, 0)).toBe(false);
    expect(shouldAutoOpen(null, false, undefined)).toBe(false);
  });
});
