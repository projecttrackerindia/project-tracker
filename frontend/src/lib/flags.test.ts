import { describe, expect, it } from 'vitest';
import { FLAG_DEFAULTS } from './flags';

describe('feature flag defaults', () => {
  it('keeps unfinished things off by default', () => {
    expect(FLAG_DEFAULTS['shake-to-report']).toBe(false);
    expect(FLAG_DEFAULTS['whats-new']).toBe(true);
  });
});
