import { describe, expect, it } from 'vitest';
import { placeFloating } from './popoverPlacement';

const view = { top: 0, left: 0, right: 1000, bottom: 800 };
const at = (top: number, left: number, w = 26, h = 26) => ({ top, left, right: left + w, bottom: top + h });

describe('placeFloating', () => {
  it('opens below and lines up the right edges by default', () => {
    expect(placeFloating(at(100, 500), { width: 200, height: 300 }, view)).toMatchObject({ side: 'bottom', top: 132, left: 326 });
  });
  it('flips up when there is no room below (the last message above the composer)', () => {
    const p = placeFloating(at(700, 500), { width: 200, height: 300 }, view);
    expect(p.side).toBe('top');
    expect(p.top + 300).toBeLessThanOrEqual(700);
  });
  it('flips to the other edge, then clamps, when it would leave the bounds sideways', () => {
    expect(placeFloating(at(100, 20), { width: 200, height: 100 }, view)).toMatchObject({ align: 'start', left: 20 });
    expect(placeFloating(at(100, 900), { width: 200, height: 100 }, view, { align: 'start' })).toMatchObject({ align: 'end' });
    expect(placeFloating(at(100, 400, 26), { width: 980, height: 100 }, view).left).toBe(8);
  });
  it('caps the height at the roomier side when it fits on neither', () => {
    const p = placeFloating(at(300, 500), { width: 200, height: 900 }, view);
    expect(p.side).toBe('bottom');
    expect(p.maxHeight).toBe(800 - 8 - 332);
    expect(p.top + p.maxHeight!).toBeLessThanOrEqual(792);
  });
  it('stays inside a scroll box narrower than the viewport', () => {
    const box = { top: 60, left: 280, right: 1000, bottom: 500 };
    const p = placeFloating(at(460, 900), { width: 230, height: 360 }, box);
    expect(p.side).toBe('top');
    expect(p.top).toBeGreaterThanOrEqual(68);
    expect(p.top + (p.maxHeight ?? 360)).toBeLessThanOrEqual(454);
  });
});
