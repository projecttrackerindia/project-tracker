import { describe, expect, it } from 'vitest';
import { collisions, packColumns, type Span } from './pack';

const sp = (key: string, start: number, end: number): Span => ({ key, start, end });

describe('the packing engine', () => {
  it('gives a lone item the whole column', () => {
    expect(packColumns([sp('a', 9, 10)]).get('a')).toEqual({ col: 0, cols: 1, span: 1, left: 0, width: 1 });
  });

  it('puts overlapping items side by side and never lets two overlap', () => {
    // The owner's Thursday: WT-11 logged 9:31-11:31, WT-12 logged 10:31-13:31, focus 11:30-14:15, a meeting 15:00-16:00
    const items = [sp('wt11', 9.52, 11.52), sp('wt12', 10.52, 13.52), sp('focus', 11.5, 14.25), sp('meet', 15, 16)];
    const p = packColumns(items);
    expect(collisions(items, p)).toEqual([]);
    expect(p.get('wt11')!.cols).toBe(3);
    expect(new Set(['wt11', 'wt12', 'focus'].map((k) => p.get(k)!.col)).size).toBe(3);
    expect(p.get('meet')).toMatchObject({ col: 0, cols: 1, width: 1 });
  });

  it('reuses a column once it is free, and expands an item right into free columns', () => {
    // a 9-12 long block, b 9-10, c 10:30-11 (reuses b's column), d 9:30-10 forces a third column; c then expands into it
    const items = [sp('a', 9, 12), sp('b', 9, 10), sp('c', 10.5, 11), sp('d', 9.5, 10)];
    const p = packColumns(items);
    expect(collisions(items, p)).toEqual([]);
    expect(p.get('a')!.col).toBe(0);
    expect(p.get('c')!.col).toBe(1);
    expect(p.get('c')).toMatchObject({ cols: 3, span: 2 });
    expect(p.get('b')).toMatchObject({ span: 1 });
  });

  it('treats touching items as not overlapping, and point items by their drawn height', () => {
    const touching = packColumns([sp('a', 9, 10), sp('b', 10, 11)]);
    expect(touching.get('a')!.cols).toBe(1);
    expect(touching.get('b')!.cols).toBe(1);
    // a reminder at 10:05 (no length) beside a meeting at 10:00: side by side once it is given its 15-minute height
    const pts = [sp('meet', 10, 11), sp('rem', 10 + 5 / 60, 10 + 5 / 60)];
    expect(packColumns(pts, .25).get('rem')!.cols).toBe(2);
    expect(collisions(pts, packColumns(pts, .25), .25)).toEqual([]);
  });

  it('keeps the invariant on many random days', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let n = 0; n < 200; n++) {
      const items = Array.from({ length: 2 + Math.floor(rnd() * 12) }, (_, i) => { const s = 8 + Math.floor(rnd() * 40) / 4; return sp(`k${i}`, s, s + .25 + Math.floor(rnd() * 12) / 4); });
      const p = packColumns(items);
      expect(collisions(items, p)).toEqual([]);
      for (const it of items) { const x = p.get(it.key)!; expect(x.left + x.width).toBeLessThanOrEqual(1 + 1e-9); }
    }
  });
});
