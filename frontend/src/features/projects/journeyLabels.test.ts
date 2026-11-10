import { describe, expect, it } from 'vitest';
import { labelWidth, layoutLabels } from './journeyLabels';

const box = (center: number, text: string) => ({ center, width: labelWidth(text) });

describe('layoutLabels', () => {
  it('keeps names that fit on one row', () => {
    const spots = layoutLabels([box(100, 'Design'), box(400, 'Build'), box(700, 'Launch')], 900);
    expect(spots.map((s) => s.row)).toEqual([0, 0, 0]);
  });

  it('puts crowded names on separate rows so none overlap', () => {
    const names = ['Project Kickoff', 'Requirements', 'Development', 'Code Review', 'Testing / QA', 'UAT', 'Production Deployment'];
    const boxes = names.map((n, i) => box(40 + i * 45, n));          // seven stages squeezed into 360px
    const spots = layoutLabels(boxes, 400);
    const placed = boxes.map((b, i) => ({ row: spots[i].row, l: b.center + spots[i].shift - b.width / 2, r: b.center + spots[i].shift + b.width / 2 }));
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
      if (placed[i].row !== placed[j].row) continue;
      expect(placed[i].r <= placed[j].l || placed[j].r <= placed[i].l).toBe(true);
    }
    expect(Math.max(...spots.map((s) => s.row))).toBeGreaterThan(0);
  });

  it('keeps the first and last names inside the line', () => {
    const [first, last] = layoutLabels([box(2, 'Kickoff'), box(398, 'Go-live')], 400);
    expect(first.shift).toBeGreaterThan(0);
    expect(last.shift).toBeLessThan(0);
  });

  it('never needs more rows than allowed', () => {
    const boxes = Array.from({ length: 20 }, (_, i) => box(10 + i * 5, 'Stage name'));
    expect(Math.max(...layoutLabels(boxes, 300, 3).map((s) => s.row))).toBeLessThanOrEqual(2);
  });
});
