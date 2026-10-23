import { describe, expect, it } from 'vitest';
import { combine, split } from './shamir';

const seed = () => crypto.getRandomValues(new Uint8Array(32));
const subsets = <T,>(xs: T[], k: number): T[][] => (k === 0 ? [[]] : xs.flatMap((x, i) => subsets(xs.slice(i + 1), k - 1).map((r) => [x, ...r])));

describe('splitting the vault seed among a recovery circle', () => {
  it('gives the secret back from any threshold-sized group, in any order', () => {
    const s = seed();
    const shares = split(s, 5, 3);
    expect(shares).toHaveLength(5);
    expect(shares.map((x) => x[0])).toEqual([1, 2, 3, 4, 5]);
    for (const group of subsets(shares, 3)) {
      expect(combine(group)).toEqual(s);
      expect(combine([...group].reverse())).toEqual(s);
    }
    for (const group of subsets(shares, 4)) expect(combine(group)).toEqual(s);
    expect(combine(shares)).toEqual(s);
  });

  it('gives something else from too few shares or a tampered one', () => {
    const s = seed();
    const shares = split(s, 4, 3);
    for (const group of subsets(shares, 2)) expect(combine(group)).not.toEqual(s);
    const bad = shares.slice(0, 3).map((x) => new Uint8Array(x));
    bad[1][5] ^= 1;
    expect(combine(bad)).not.toEqual(s);
  });

  it('keeps no byte of the secret in a share, and makes new shares every time', () => {
    const s = new Uint8Array(32).fill(0x41);
    const a = split(s, 3, 2), b = split(s, 3, 2);
    expect(a[0]).not.toEqual(b[0]);
    for (const share of a) expect(share.subarray(1).every((v) => v === 0x41)).toBe(false);
  });

  it('works for the smallest and largest circles and refuses nonsense', () => {
    const s = seed();
    expect(combine(split(s, 2, 2))).toEqual(s);
    const seven = split(s, 7, 7);
    expect(combine(seven)).toEqual(s);
    expect(() => split(s, 8, 3)).toThrow();
    expect(() => split(s, 3, 1)).toThrow();
    expect(() => split(s, 2, 3)).toThrow();
    expect(() => combine([seven[0], seven[0]])).toThrow(/different/);
    expect(() => combine([seven[0], seven[1].subarray(0, 10)])).toThrow(/belong/);
  });
});
