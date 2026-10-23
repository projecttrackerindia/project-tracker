import { describe, expect, it } from 'vitest';
import { dropZone, planDrop, planStep } from './treeDrag';

const docs = [
  { id: 'a', title: 'A', parentId: null, pageOrder: 0 },
  { id: 'b', title: 'B', parentId: null, pageOrder: 1 },
  { id: 'c', title: 'C', parentId: null, pageOrder: 2 },
  { id: 'a1', title: 'A1', parentId: 'a', pageOrder: 0 },
  { id: 'a2', title: 'A2', parentId: 'a', pageOrder: 1 },
];

describe('page tree drag and drop', () => {
  it('reads the zone of a row', () => {
    expect(dropZone(2, 30)).toBe('before');
    expect(dropZone(15, 30)).toBe('inside');
    expect(dropZone(28, 30)).toBe('after');
  });
  it('moves a page before, after and inside others', () => {
    expect(planDrop(docs, 'c', 'a', 'before')).toEqual({ parentId: null, pageOrder: 0 });
    expect(planDrop(docs, 'a', 'c', 'after')).toEqual({ parentId: null, pageOrder: 2 });
    expect(planDrop(docs, 'c', 'a', 'inside')).toEqual({ parentId: 'a', pageOrder: 2 });
    expect(planDrop(docs, 'a2', 'b', 'after')).toEqual({ parentId: null, pageOrder: 2 });
    expect(planDrop(docs, 'b', 'a1', 'before')).toEqual({ parentId: 'a', pageOrder: 0 });
  });
  it('refuses a drop into its own branch and one that changes nothing', () => {
    expect(planDrop(docs, 'a', 'a1', 'inside')).toBeNull();
    expect(planDrop(docs, 'a', 'a', 'after')).toBeNull();
    expect(planDrop(docs, 'b', 'a', 'after')).toBeNull();
    expect(planDrop(docs, 'b', 'c', 'before')).toBeNull();
    expect(planDrop(docs, 'a1', 'a', 'inside')).toBeNull();
  });
  it('steps a page up or down from the keyboard', () => {
    expect(planStep(docs, 'b', -1)).toEqual({ parentId: null, pageOrder: 0 });
    expect(planStep(docs, 'a2', -1)).toEqual({ parentId: 'a', pageOrder: 0 });
    expect(planStep(docs, 'c', 1)).toBeNull();
  });
});
