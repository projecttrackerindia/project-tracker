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
export interface TimelineProject {
  id: string; key: string; name: string; health: string; group: string | null; start: string | null; due: string | null; originalDue: string | null; forecast: string | null;
  progress: number; milestones: TimelineMilestone[]; dependsOn: string[];
}
export interface PortfolioTimeline { from: string; to: string; projects: TimelineProject[] }
export interface PortfolioAiSummary { text: string; model: string; at: string; cached: boolean }

const q = (f: PortfolioFilter) => Object.fromEntries(Object.entries(f).filter(([, v]) => v != null && v !== '')) as Record<string, string>;

export const portfolioApi = {
  board: (f: PortfolioFilter) => get<PortfolioBoard>('/portfolio/board', q(f)),
  timeline: (f: PortfolioFilter) => get<PortfolioTimeline>('/portfolio/timeline', q(f)),
  apply: (projectId: string, option: string, filter: PortfolioFilter) => post<{ proposals: number; message: string }>(`/portfolio/decisions/${projectId}/apply`, { option, filter: { teamId: filter.teamId ?? null } }),
  summary: (f: PortfolioFilter, fresh = false) => post<PortfolioAiSummary>(`/portfolio/summary?${new URLSearchParams({ ...q(f), ...(fresh ? { fresh: 'true' } : {}) })}`),
  export: (f: PortfolioFilter, format: 'xlsx' | 'pdf') =>
    download(`/portfolio/export?${new URLSearchParams({ ...q(f), format })}`, `portfolio-${new Date().toISOString().slice(0, 10)}.${format}`),
};
