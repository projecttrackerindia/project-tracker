// Quality (testers): test cases, runs, the cases × runs matrix, results, readiness and filing a bug, through /api/v1/quality.
import { create, del, get, post, put } from './client';
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

// ---- releases: the work going out together, the runs that check it, the go/no-go (/api/v1/releases)
export interface Release {
  id: string; name: string; projectId: string | null; projectName: string | null; targetDate: string | null; status: 'Planned' | 'Approved' | 'Shipped'; notes: string | null;
  items: number; runs: number; approvedBy: UserRef | null; approvedAt: string | null; shippedAt: string | null; createdAt: string;
}
export interface ReleaseItem { id: string; kind: string; key: string; title: string; status: string; category: 'Todo' | 'Active' | 'Done' | 'Cancelled'; assignee: UserRef | null; dueDate: string | null; bug: boolean }
export interface ReleaseCheck { key: 'work' | 'bugs' | 'tests'; label: string; ok: boolean; detail: string }
export interface ReleaseState {
  release: Release; items: ReleaseItem[]; runs: TestRun[]; tests: Readiness | null; done: number; open: number; openBugs: number; checks: ReleaseCheck[]; go: boolean; canApprove: boolean;
}
export const releaseApi = {
  list: (projectId?: string) => get<Release[]>('/releases', { projectId }),
  create: (b: { name: string; projectId?: string | null; targetDate?: string | null; notes?: string | null }) => create<Release>('/releases', b),
  update: (id: string, b: { name: string; targetDate?: string | null; notes?: string | null }) => put<Release>(`/releases/${id}`, b),
  get: (id: string) => get<ReleaseState>(`/releases/${id}`),
  items: (id: string, b: { add?: string[]; remove?: string[] }) => put<ReleaseState>(`/releases/${id}/items`, b),
  attachRun: (id: string, runId: string) => put<ReleaseState>(`/releases/${id}/runs/${runId}`, {}),
  detachRun: (id: string, runId: string) => del<ReleaseState>(`/releases/${id}/runs/${runId}`),
  approve: (id: string, reason?: string) => post<ReleaseState>(`/releases/${id}/approve`, { reason: reason ?? null }),
  ship: (id: string) => post<ReleaseState>(`/releases/${id}/ship`, {}),
};
