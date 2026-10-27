// Quality (testers): test cases, runs, the cases × runs matrix, results, readiness and filing a bug, through /api/v1/quality.
import { create, get, put } from './client';
import type { UserRef } from './types';
import type { WorkItemDetail } from './workItemsApi';

export type CasePriority = 'Low' | 'Medium' | 'High' | 'Critical';
export type ResultStatus = 'NotRun' | 'Pass' | 'Fail' | 'Blocked';
export type RunStatus = 'Open' | 'Running' | 'Done';

export interface TestCase {
  id: string; key: string; title: string; steps: string | null; expected: string | null; priority: CasePriority; tags: string | null;
  projectId: string | null; projectName: string | null; createdAt: string; updatedAt: string | null;
}
export interface TestRun {
  id: string; name: string; environment: string | null; build: string | null; status: RunStatus; projectId: string | null;
  createdAt: string; startedAt: string | null; completedAt: string | null;
}
export interface TestResult {
  id: string; runId: string; caseId: string; status: ResultStatus; actual: string | null; evidence: string | null; runBy: UserRef | null;
  at: string | null; linkedWorkItemId: string | null;
}
export interface TestMatrix { runs: TestRun[]; cases: TestCase[]; results: TestResult[] }
export interface Readiness {
  run: TestRun | null; cases: number; ran: number; passed: number; failed: number; blocked: number; notRun: number; passPercent: number;
  blockers: { caseId: string; key: string; title: string; priority: CasePriority }[]; ready: boolean;
}
export interface CaseInput { title?: string; steps?: string | null; expected?: string | null; priority?: CasePriority; tags?: string | null; projectId?: string | null }
export interface RunInput { name: string; environment?: string | null; build?: string | null; projectId?: string | null }

export const qualityApi = {
  cases: (projectId?: string) => get<TestCase[]>('/quality/cases', { projectId }),
  createCase: (b: CaseInput) => create<TestCase>('/quality/cases', b),
  updateCase: (id: string, b: CaseInput) => put<TestCase>(`/quality/cases/${id}`, b),
  runs: (projectId?: string) => get<TestRun[]>('/quality/runs', { projectId }),
  createRun: (b: RunInput) => create<TestRun>('/quality/runs', b),
  setRunStatus: (id: string, status: RunStatus) => put<TestRun>(`/quality/runs/${id}/status`, { status }),
  matrix: (projectId?: string, runs = 4) => get<TestMatrix>('/quality/matrix', { projectId, runs }),
  setResult: (runId: string, caseId: string, b: { status: ResultStatus; actual?: string | null; evidence?: string | null }) =>
    put<TestResult>(`/quality/runs/${runId}/results/${caseId}`, b),
  readiness: (q: { runId?: string; projectId?: string } = {}) => get<Readiness>('/quality/readiness', q),
  fileBug: (resultId: string, b: { title?: string; assigneeId?: string | null } = {}) =>
    create<{ result: TestResult; workItem: WorkItemDetail }>(`/quality/results/${resultId}/bug`, b),
};
