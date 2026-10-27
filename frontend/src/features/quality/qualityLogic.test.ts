import { describe, expect, it } from 'vitest';
import type { TestRun } from '../../api/qualityApi';
import { commonCause, evidenceLines, releaseOf, runHeading, stepsOf } from './qualityLogic';

const run = (o: Partial<TestRun>): TestRun => ({ id: '1', name: 'UAT 1.4', environment: 'UAT', build: null, status: 'Done', projectId: null, createdAt: '2026-10-20T10:00:00Z', startedAt: null, completedAt: null, ...o });

describe('quality page helpers', () => {
  it('heads the matrix columns', () => {
    expect(runHeading(run({ name: 'DEV #212', environment: 'DEV', build: '212' }))).toEqual({ top: 'DEV', sub: '#212' });
    expect(runHeading(run({ name: 'PROD-like', environment: 'PROD-like', status: 'Open' }))).toEqual({ top: 'PROD-like', sub: 'queued' });
    expect(runHeading(run({ status: 'Running' })).top).toBe('UAT 1.4');
    expect(runHeading(run({ status: 'Running', startedAt: '2026-10-20T10:41:00Z' })).sub).toMatch(/^running · \d\d:\d\d$/);
  });
  it('names the release and splits steps', () => {
    expect(releaseOf('UAT 1.4')).toBe('Release 1.4');
    expect(releaseOf('Smoke')).toBe('Smoke');
    expect(stepsOf('1. POST /x\n2) Bureau check\n\n- Assert')).toEqual(['POST /x', 'Bureau check', 'Assert']);
  });
  it('highlights evidence', () => {
    const l = evidenceLines('$ curl -X POST $UAT/x\nHTTP/1.1 502 Bad Gateway\n{ "error": "BUREAU" }');
    expect(l[0]).toEqual([{ t: '$ curl -X POST $UAT/x', k: 'g' }]);
    expect(l[1]).toEqual([{ t: 'HTTP/1.1 ' }, { t: '502 Bad Gateway', k: 'r' }]);
    expect(l[2]).toEqual([{ t: '{ ' }, { t: '"error"', k: 'k' }, { t: ':' }, { t: ' "BUREAU" }' }]);
  });
  it('finds what the failures share', () => {
    expect(commonCause(['502 · CRIF token expired', 'Timeout: CRIF token expired', '401 CRIF token expired'])).toBe('the CRIF token');
    expect(commonCause(['500 Internal', 'Wrong total'])).toBeNull();
    expect(commonCause(['only one'])).toBeNull();
  });
});
