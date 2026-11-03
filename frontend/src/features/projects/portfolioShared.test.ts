import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { decodeToks, encodeToks, normFilter, patchPortfolio, portfolioKeys, projectPasses, refreshPortfolio } from './portfolioShared';
import type { PlanSheet, PortfolioTimeline, SheetRow } from './portfolioApi';

const row = (o: Partial<SheetRow>) => ({ kind: 'task', id: 't', projectId: 'p1', parentId: null, level: 1, key: 'K-1', title: 'Task', ownerId: null, owner: null, start: null, due: null, dueTime: null,
  durationDays: null, status: 'To do', category: 'Todo', statusId: null, progress: 0, dependsOn: [], cadence: null, nextAt: null, updatedAt: null, updatedBy: null, notes: null, late: false, atRisk: false,
  version: 1, canEdit: true, ...o }) as SheetRow;
const ctx = { today: '2026-10-29', me: 'me-id' };

describe('portfolio shared state', () => {
  it('keeps tokens in the address and reads them back, with separators inside values', () => {
    const toks = [{ kind: 'owner' as const, value: 'u-1', label: 'Ravi | Menon~' }, { kind: 'text' as const, value: '50% done', label: '“50% done”' }];
    expect(decodeToks(encodeToks(toks))).toEqual(toks);
    expect(decodeToks('nonsense~x|status~late~Late')).toEqual([{ kind: 'status', value: 'late', label: 'Late' }]);
    expect(decodeToks(null)).toEqual([]);
  });

  it('makes one key for one filter, whatever the empty values', () => {
    expect(portfolioKeys.board({ ownerId: null, teamId: 't', health: '' })).toEqual(['portfolio', 'board', { teamId: 't' }]);
    expect(normFilter({ dueTo: 'b', teamId: 't', dueFrom: 'a' })).toEqual({ teamId: 't', dueFrom: 'a', dueTo: 'b' });
    expect(portfolioKeys.timeline({}).slice(0, 1)).toEqual(['portfolio']);
  });

  it('filters projects by health, lead, project and by the work in them', () => {
    const p = { id: 'p1', name: 'UPI AutoPay', key: 'UP', ownerId: 'lead', health: 'Delayed', due: '2026-10-18' };
    expect(projectPasses(p, [{ kind: 'status', value: 'late', label: 'Late' }], ctx, [])).toBe(true);
    expect(projectPasses(p, [{ kind: 'status', value: 'risk', label: 'At risk' }], ctx, [])).toBe(false);
    expect(projectPasses(p, [{ kind: 'status', value: 'lateorrisk', label: '' }], ctx, [])).toBe(true);
    expect(projectPasses(p, [{ kind: 'project', value: 'p2', label: '' }], ctx, [])).toBe(false);
    // Not the lead, but owns work in it.
    expect(projectPasses(p, [{ kind: 'owner', value: 'u-9', label: '' }], ctx, [row({ ownerId: 'u-9' })])).toBe(true);
    expect(projectPasses(p, [{ kind: 'owner', value: 'u-8', label: '' }], ctx, [row({ ownerId: 'u-9' })])).toBe(false);
    expect(projectPasses(p, [{ kind: 'text', value: 'autopay', label: '' }], ctx, [])).toBe(true);
  });

  it('patches every cached copy at once and refreshes the whole family', async () => {
    const qc = new QueryClient();
    const wid = 'w1';
    qc.setQueryData([wid, ...portfolioKeys.sheet({})], { rows: [row({ id: 'p1', kind: 'project', due: '2026-11-01' })] } as unknown as PlanSheet);
    qc.setQueryData([wid, ...portfolioKeys.sheet({ ownerId: 'x' })], { rows: [row({ id: 'p1', kind: 'project', due: '2026-11-01' })] } as unknown as PlanSheet);
    qc.setQueryData([wid, ...portfolioKeys.timeline({})], { from: '', to: '', projects: [{ id: 'p1', due: '2026-11-01', name: 'A' }] } as unknown as PortfolioTimeline);
    patchPortfolio(wid, [{ id: 'p1', dueDate: '2026-11-09' }], () => ({ due: '2026-11-09' }), qc);
    for (const [, d] of qc.getQueriesData<PlanSheet>({ queryKey: [wid, 'portfolio', 'sheet'] })) expect(d?.rows[0].due).toBe('2026-11-09');
    expect(qc.getQueryData<PortfolioTimeline>([wid, ...portfolioKeys.timeline({})])?.projects[0].due).toBe('2026-11-09');
    await refreshPortfolio(wid, qc);
    expect(qc.getQueryState([wid, ...portfolioKeys.timeline({})])?.isInvalidated).toBe(true);
    expect(qc.getQueryState([wid, ...portfolioKeys.sheet({ ownerId: 'x' })])?.isInvalidated).toBe(true);
  });
});
