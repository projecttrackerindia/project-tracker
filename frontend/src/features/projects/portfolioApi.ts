import { download, get, post } from '../../api/client';
import type { PortfolioBrief } from '../ai/aiApi';

/** What the board shows (projects the person may open); empty values mean no filter. */
export interface PortfolioFilter { teamId?: string | null; ownerId?: string | null; groupId?: string | null; health?: string | null; dueFrom?: string | null; dueTo?: string | null }
export interface DecisionOption { id: string; kind: 'move_person' | 'cut_scope' | 'accept_date'; title: string; effect: string; finish: string | null; slipDays: number | null; steps: string[]; why: string; personId: string | null }
export interface PortfolioDecision {
  projectId: string; key: string; name: string; headline: string; causes: string[]; slipDays: number; dueDate: string | null; finish: string | null; confidence: string;
  options: DecisionOption[]; waitingProposals: number;
}
export interface MoneyMonth { month: string; cost: number }
export interface ProjectMoney {
  projectId: string; key: string; name: string; budget: number | null; spent: number; forecast: number | null; overrun: number | null; usedShare: number | null; burn: MoneyMonth[];
  warning: string | null; budgetHours: number | null; hoursUsed: number; remainingHours: number | null; peopleWithoutRate: number; basis: string;
}
export interface PortfolioMoney { entitled: boolean; showMoney: boolean; currency: string; budget: number; spent: number; forecast: number; overrunning: number; projects: ProjectMoney[]; burn: MoneyMonth[]; notes: string[] }
export interface CapacityWeek { weekStart: string; capacityMinutes: number; demandMinutes: number; load: number | null }
export interface CapacityProject { projectId: string; key: string; name: string; minutes: number; tasks: number }
export interface CapacityPerson { userId: string; name: string; load: number | null; weeks: CapacityWeek[]; projects: CapacityProject[]; leaveDays: number; unestimatedTasks: number }
export interface PortfolioCapacity { from: string; to: string; people: number; over: CapacityPerson[]; projectsAtRisk: CapacityProject[]; notes: string[] }
export interface PortfolioChoice { id: string; name: string }
export interface PortfolioBoard {
  asOf: string; filter: PortfolioFilter; brief: PortfolioBrief; decisions: PortfolioDecision[]; money: PortfolioMoney; capacity: PortfolioCapacity;
  owners: PortfolioChoice[]; groups: PortfolioChoice[]; summary: string;
}
export interface TimelineMilestone { id: string; name: string; due: string | null; status: string }
export interface TimelineLastChange { previous: string | null; revised: string | null; reason: string | null; by: string | null; at: string }
export interface TimelineProject {
  id: string; key: string; name: string; health: string; group: string | null; start: string | null; due: string | null; originalDue: string | null; forecast: string | null;
  progress: number; milestones: TimelineMilestone[]; dependsOn: string[];
  // Additive (round 3): owner, owning team, slip and how the forecast was worked out, counts, version for a dragged re-plan, the last date change.
  ownerId?: string | null; owner?: string | null; teamId?: string | null; team?: string | null; slipDays?: number | null; confidence?: string | null; forecastBasis?: string | null;
  openTasks?: number; blockedTasks?: number; finishedLast28Days?: number; version?: number; status?: string | null; lastChange?: TimelineLastChange | null;
}
export interface PortfolioTimeline { from: string; to: string; projects: TimelineProject[] }
export type SheetKind = 'project' | 'task' | 'subtask' | 'meeting';
export interface SheetRow {
  kind: SheetKind; id: string; projectId: string; parentId: string | null; level: number; key: string; title: string; ownerId: string | null; owner: string | null;
  start: string | null; due: string | null; dueTime: string | null; durationDays: number | null; status: string; category: string; statusId: string | null; progress: number | null;
  dependsOn: string[]; cadence: string | null; nextAt: string | null; updatedAt: string | null; updatedBy: string | null; notes: string | null; late: boolean; atRisk: boolean;
  version: number; canEdit: boolean; forecast?: string | null;
  /** Additive (plan sheet v3): estimate for the workload bars, checklist counts for the smart fill, progress set by hand. */
  estimatedHours?: number | null; checklistTotal?: number | null; checklistDone?: number | null; manualProgress?: boolean;
  /** Days the due date has moved from the first one it had. */ slipDays?: number | null;
}
export interface SheetStatus { id: string; projectId: string; name: string; category: string }
export interface SheetScope { id: 'all' | 'mine' | 'managed' | 'team'; label: string; allowed: boolean; why: string | null; teamId: string | null }
export interface PlanSheet { asOf: string; timeZone: string; rows: SheetRow[]; people: PortfolioChoice[]; statuses: SheetStatus[]; scopes: SheetScope[]; truncated: boolean; canEdit: boolean; meetings: boolean }
export interface SheetChange { id: string; version?: number; assigneeId?: string; unassign?: boolean; startDate?: string; clearStart?: boolean; dueDate?: string; dueTime?: string; clearDueTime?: boolean; statusId?: string; title?: string;
  progress?: number; clearProgress?: boolean; notes?: string }
export interface SheetMove { id: string; projectId?: string; afterId?: string | null; beforeId?: string | null; version?: number }
export interface SheetMoveResult { id: string; key: string; projectId: string; version: number; position: number; movedProject: boolean }
export interface SheetRowResult { id: string; key: string | null; ok: boolean; error: string | null; field: string | null; code: string | null; version: number | null }
export interface SheetBulkResult { changed: number; failed: number; rows: SheetRowResult[] }
export interface PasteRowIn { title: string; owner?: string; start?: string; due?: string; status?: string }
export interface PasteRowOut {
  index: number; action: 'create' | 'update' | 'error'; title: string; ownerId: string | null; owner: string | null; ownerMatch: 'exact' | 'fuzzy' | 'none' | 'empty';
  start: string | null; due: string | null; statusId: string | null; status: string | null; matchedId: string | null; matchedKey: string | null; change: string | null;
  problems: string[]; ready: boolean; needsReason: boolean; saved: boolean; savedId: string | null; error: string | null;
}
export interface PasteResult { projectId: string; projectKey: string; projectName: string; committed: boolean; ready: number; problems: number; saved: number; rows: PasteRowOut[] }
export interface SheetExportOptions { format: 'xlsx' | 'csv'; columns?: string[]; mine?: boolean; meetings?: boolean; ids?: string[] }

export interface PortfolioAiSummary { text: string; model: string; at: string; cached: boolean }

const q = (f: PortfolioFilter) => Object.fromEntries(Object.entries(f).filter(([, v]) => v != null && v !== '')) as Record<string, string>;

export const portfolioApi = {
  board: (f: PortfolioFilter) => get<PortfolioBoard>('/portfolio/board', q(f)),
  timeline: (f: PortfolioFilter) => get<PortfolioTimeline>('/portfolio/timeline', q(f)),
  apply: (projectId: string, option: string, filter: PortfolioFilter) => post<{ proposals: number; message: string; findingIds?: string[] | null }>(`/portfolio/decisions/${projectId}/apply`, { option, filter: { teamId: filter.teamId ?? null } }),
  summary: (f: PortfolioFilter, fresh = false) => post<PortfolioAiSummary>(`/portfolio/summary?${new URLSearchParams({ ...q(f), ...(fresh ? { fresh: 'true' } : {}) })}`),
  sheet: (f: PortfolioFilter, mine = false) => get<PlanSheet>('/portfolio/sheet', { ...q(f), ...(mine ? { mine: 'true' } : {}) }),
  sheetBulk: (changes: SheetChange[], dueDateReason?: string | null, dueDateDependency?: string | null) =>
    post<SheetBulkResult>('/portfolio/sheet/bulk', { changes, dueDateReason: dueDateReason || null, dueDateDependency: dueDateDependency || null }),
  sheetMove: (m: SheetMove) => post<SheetMoveResult>('/portfolio/sheet/move', m),
  sheetPaste: (projectId: string, rows: PasteRowIn[], commit = false, include?: number[], dueDateReason?: string | null) =>
    post<PasteResult>('/portfolio/sheet/paste', { projectId, rows, commit, include: include ?? null, dueDateReason: dueDateReason || null }),
  sheetExport: (f: PortfolioFilter, o: SheetExportOptions) => {
    const p: Record<string, string> = { ...q(f), format: o.format };
    if (o.columns?.length) p.columns = o.columns.join(',');
    if (o.mine) p.mine = 'true';
    if (o.meetings === false) p.meetings = 'false';
    if (o.ids?.length) p.ids = o.ids.join(',');
    return download(`/portfolio/sheet/export?${new URLSearchParams(p)}`, `plan-sheet-${new Date().toISOString().slice(0, 10)}.${o.format}`);
  },
  export: (f: PortfolioFilter, format: 'xlsx' | 'pdf') =>
    download(`/portfolio/export?${new URLSearchParams({ ...q(f), format })}`, `portfolio-${new Date().toISOString().slice(0, 10)}.${format}`),
};
