import { get, post } from '../../api/client';

/** One action of a briefing item: approve (POST endpoint in place), review (the meeting sheet), open, reassign or join (go to href). */
export interface AuraAction { verb: 'approve' | 'review' | 'open' | 'reassign' | 'join'; label: string; href: string | null; endpoint: string | null; body: unknown; targetId: string | null }
export interface AuraEvidence { kind: 'task' | 'date' | 'dependency' | 'activity' | 'comment'; label: string; detail: string | null; href: string | null; at: string | null }
export interface AuraItem { id: string; kind: string; title: string; why: string; projectName: string | null; projectId: string | null; action: AuraAction; tone: 'neutral' | 'orange' | 'red'; evidence: AuraEvidence[] | null }
export interface AuraMeeting { id: string; title: string; start: string; end: string | null; projectName: string | null; projectId: string | null; joinUrl: string | null; link: string | null; openQuestions: string[]; action: AuraAction }
export interface AuraBriefing {
  day: string; timeZone: string; headline: string; line: string; ai: boolean; needsYou: AuraItem[]; moreNeedsYou: number; atRisk: AuraItem[]; meetings: AuraMeeting[];
  fridayReport: boolean; generatedAt: string; refreshedAt: string;
}
export interface AuraAnswer { question: string; answer: string; ai: boolean; subject: string | null; subjectHref: string | null; evidence: AuraEvidence[]; suggestions: string[] }
export interface Person { id: string; name: string }
export interface ReviewItem { id: string; kind: 'task' | 'actionItem' | 'issue'; title: string; detail: string | null; owner: Person | null; dueDate: string | null; status: string; appliedKey: string | null; evidence: string | null; approvable: boolean }
export interface MeetingReview { runId: string; projectId: string; projectName: string; title: string; held: string; summary: string | null; decisions: string[]; items: ReviewItem[]; questions: string[]; pending: number; canDecide: boolean; people: Person[] }
export interface ReviewDecision { id: string; approve: boolean; title?: string | null; assigneeId?: string | null; dueDate?: string | null }
export interface ReviewResult { approved: number; dismissed: number; failed: number; created: string[] }
export interface FridayProject { projectId: string; key: string; name: string; health: string; progress: number; text: string; done: number; slipped: number; risks: number; next: number; chat: boolean; href: string }
export interface FridayDraft { from: string; to: string; headline: string; projects: FridayProject[]; nextScheduledAt: string; timeZone: string }

export const auraBriefApi = {
  briefing: () => get<AuraBriefing>('/aura/briefing'),
  ask: (question: string, taskId?: string | null) => post<AuraAnswer>('/aura/ask', { question, taskId: taskId ?? null }),
  latestReview: () => get<MeetingReview | undefined>('/aura/meetings/review'),
  review: (runId: string) => get<MeetingReview>(`/aura/meetings/${runId}/review`),
  decide: (runId: string, items: ReviewDecision[], approveRest = true) => post<ReviewResult>(`/aura/meetings/${runId}/review`, { items, approveRest }),
  friday: () => get<FridayDraft>('/aura/friday'),
  sendFriday: (projects: { projectId: string; text: string }[]) => post<{ sent: number; failed: string[] }>('/aura/friday/send', { projects }),
  /** Runs an item's in-place action (approve) on the endpoint it names. */
  act: (a: AuraAction) => post(a.endpoint!.replace(/^\/api\/v1/, ''), a.body ?? undefined),
};
