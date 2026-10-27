import { describe, expect, it } from 'vitest';
import { freshLabel, freshOf, freshOfMany } from './Fresh';
import { withLevels } from './arch/ArchStudio';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe('freshness', () => {
  it('says verified N days ago, from the verify or else the last edit', () => {
    expect(freshLabel(freshOf({ verifiedAt: ago(3), updatedAt: ago(1) }, NOW)!)).toBe('Verified 3 days ago');
    expect(freshLabel(freshOf({ updatedAt: ago(1) }, NOW)!)).toBe('Verified 1 day ago');
    expect(freshLabel(freshOf({ verifiedAt: ago(0) }, NOW)!)).toBe('Verified today');
  });
  it('says may be stale when linked work changed, or nothing confirmed it in 90 days', () => {
    expect(freshLabel(freshOf({ verifiedAt: ago(2), staleSince: ago(1) }, NOW)!)).toBe('May be stale');
    expect(freshLabel(freshOf({ updatedAt: ago(120) }, NOW)!)).toBe('May be stale');
    expect(freshOf({}, NOW)).toBeNull();
  });
  it('treats several pages as one: stale if any is, else the oldest', () => {
    expect(freshLabel(freshOfMany([{ verifiedAt: ago(2) }, { verifiedAt: ago(9) }], NOW)!)).toBe('Verified 9 days ago');
    expect(freshOfMany([{ verifiedAt: ago(2) }, { staleSince: ago(1) }], NOW)?.stale).toBe(true);
    expect(freshOfMany([], NOW)).toBeNull();
  });
});

describe('AI-drawn levels', () => {
  it('puts boxes without a level on the current tab and picks the level most new boxes are on', () => {
    const r = withLevels({ nodes: [
      { id: 'a', kind: 'icon', label: 'Borrower', x: 0, y: 0, w: 1, h: 1, level: 'context', ctype: 'person' },
      { id: 'b', kind: 'icon', label: 'API', x: 0, y: 0, w: 1, h: 1 },
      { id: 'c', kind: 'icon', label: 'DB', x: 0, y: 0, w: 1, h: 1, level: 'context' },
      { id: 'd', kind: 'icon', label: 'Old', x: 0, y: 0, w: 1, h: 1, level: 'deployment' },
      { id: 'e', kind: 'icon', label: 'Everywhere', x: 0, y: 0, w: 1, h: 1 },
    ], edges: [] }, 'components', new Set(['d', 'e']));
    expect(r.data.nodes.find((n) => n.id === 'e')?.level).toBeUndefined();
    expect(r.data.nodes.find((n) => n.id === 'b')?.level).toBe('components');
    expect(r.level).toBe('context');
  });
});
