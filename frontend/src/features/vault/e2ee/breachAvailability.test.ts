import { describe, expect, it, vi } from 'vitest';
import { vaultApi } from '../api';
import { breachParts } from './crypto';
import { breachesFor } from './sealed';

vi.mock('../api', () => ({ vaultApi: { breachRange: vi.fn() } }));
vi.mock('../../../lib/native', () => ({ saveFile: vi.fn() }));

describe('sealed password breach availability', () => {
  it('keeps an unavailable range unknown', async () => {
    vi.mocked(vaultApi.breachRange).mockResolvedValue({ body: '' });
    expect(await breachesFor('test-only-sample')).toBeNull();
  });
  it('distinguishes a completed nonmatch from a known breach', async () => {
    const { suffix } = breachParts('test-only-sample');
    vi.mocked(vaultApi.breachRange).mockResolvedValue({ body: `${suffix}:0` });
    expect(await breachesFor('test-only-sample')).toBe(0);
    vi.mocked(vaultApi.breachRange).mockResolvedValue({ body: `${suffix}:42` });
    expect(await breachesFor('test-only-sample')).toBe(42);
  });
});
