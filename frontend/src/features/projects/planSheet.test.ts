import { describe, expect, it } from 'vitest';
import { buildDisplay, DEFAULT_CONFIG, mapColumns, parseDue, parseTsv, parseTypedDate, pasteRows, totals } from './planSheet';
import { fitRange, placeLabel, ticks } from './timelineLayout';
import type { SheetRow, TimelineProject } from './portfolioApi';

const r = (o: Partial<SheetRow>): SheetRow => ({ kind: 'task', id: 'x', projectId: 'p', parentId: null, level: 1, key: 'K', title: 'T', ownerId: null, owner: null, start: null, due: null, dueTime: null,
  durationDays: null, status: 'To do', category: 'Todo', statusId: null, progress: 0, dependsOn: [], cadence: null, nextAt: null, updatedAt: null, updatedBy: null, notes: null, late: false, atRisk: false,
  version: 1, canEdit: true, ...o });

describe('plan sheet', () => {
  const rows = [r({ kind: 'project', id: 'p', level: 0, start: '2026-09-01', due: '2026-11-14' }), r({ id: 'a', due: '2026-10-20', late: true }), r({ id: 'b', parentId: 'a', kind: 'subtask', category: 'Done', progress: 100 }),
    r({ kind: 'meeting', id: 'm', cadence: 'Daily', category: 'Meeting' })];
  it('groups project › task › sub-item with meetings last', () => {
    expect(buildDisplay(rows, DEFAULT_CONFIG, new Set(), null, '2026-10-29').map((d) => (d.type === 'row' ? d.row.id : d.label))).toEqual(['p', 'a', 'b', 'm']);
    expect(buildDisplay(rows, DEFAULT_CONFIG, new Set(['p']), null, '2026-10-29')).toHaveLength(1);
  });
  it('filters keep parents of passing items, and totals count', () => {
    const d = buildDisplay(rows, { ...DEFAULT_CONFIG, filters: { ...DEFAULT_CONFIG.filters, notDone: true } }, new Set(), null, '2026-10-29');
    expect(d.map((x) => (x.type === 'row' ? x.row.id : ''))).toEqual(['p', 'a', 'm']);
    const t = totals(d);
    expect([t.rows, t.late, t.meetings, t.spanDays]).toEqual([3, 1, 1, 75]);
  });
  it('reads typed dates day first and due times', () => {
    expect(parseTypedDate('7/11', null, '2026-10-29')).toBe('2026-11-07');
    expect(parseTypedDate('+3', '2026-10-01', '2026-10-29')).toBe('2026-10-04');
    expect(parseTypedDate('31/11', null, '2026-10-29')).toBeNull();
    expect(parseDue('28 Nov · 18:00', null, '2026-10-29')).toEqual({ date: '2026-11-28', time: '18:00' });
  });
  it('parses pasted TSV and maps headers', () => {
    const g = parseTsv('Task\tAssigned to\tEnd\nA\tRavi\t7 Nov\n"B\nline"\t\t\n');
    const m = mapColumns(g);
    expect(m).toEqual({ header: true, map: ['title', 'owner', 'due'] });
    expect(pasteRows(g, m.header, m.map)).toEqual([{ title: 'A', owner: 'Ravi', start: undefined, due: '7 Nov', status: undefined }, { title: 'B\nline', owner: undefined, start: undefined, due: undefined, status: undefined }]);
  });
});

describe('timeline layout', () => {
  it('fits the range to whole months', () => {
    const p = { start: '2026-09-02', due: '2026-11-14', forecast: '2026-12-02', milestones: [] } as unknown as TimelineProject;
    const { from, to } = fitRange([p], '2026-10-29');
    expect([new Date(from * 864e5).toISOString().slice(0, 10), new Date(to * 864e5).toISOString().slice(0, 10)]).toEqual(['2026-09-01', '2027-01-01']);
    expect(ticks(from, to, 'quarter', 2).top.map((t) => t.label)).toEqual(['Q3', 'Q4']);
  });
  it('labels flip at the edge and never cover the today line', () => {
    expect(placeLabel(100, 200, 1000, 80, 600)).toBe(208);
    expect(placeLabel(800, 960, 1000, 80, 100)).toBe(712);
    const x = placeLabel(100, 200, 1000, 80, 240);
    expect(240 > x - 3 && 240 < x + 83).toBe(false);
  });
});
