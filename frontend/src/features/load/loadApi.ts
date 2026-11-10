import { get, post, put } from '../../api/client';

/** Load (GET /load): Free under 50% of capacity, Balanced to 85, Stretched to 110, Overloaded above; leave and days off. */
export type LoadState = 'free' | 'balanced' | 'stretched' | 'overloaded' | 'leave' | 'off';
export type LoadScope = 'people' | 'teams' | 'projects';
export interface LoadDay { date: string; workingMinutes: number; meetingMinutes: number; capacityMinutes: number; committedMinutes: number; percent: number | null; state: LoadState }
export interface LoadRow {
  kind: 'person' | 'team' | 'project'; id: string; name: string; state: LoadState; percent: number | null; reason: string; days: LoadDay[];
  freeMinutes: number; wip: number; signal: 'swamped' | 'room' | null; people: number; freePeople: number; isMe: boolean;
}
export interface Load { from: string; days: number; scope: LoadScope; rows: LoadRow[]; seesOthers: boolean; mySignal: 'swamped' | 'room' | null }
export interface LoadItem { kind: 'task' | 'action' | 'work' | 'stage'; id: string; title: string; projectId: string | null; projectName: string | null; due: string | null; minutes: number; dayMinutes: number; basis: string; overdue: boolean }
export interface LoadDayDetail {
  userId: string; name: string; date: string; workingMinutes: number; usedMinutes: number; committedMinutes: number; meetingMinutes: number; percent: number | null; state: LoadState;
  items: LoadItem[]; meetings: { title: string; start: string; minutes: number }[];
}
export interface LoadSuggestion {
  kind: 'task' | 'action'; itemId: string; title: string; minutes: number; due: string | null; fromUserId: string; fromName: string; fromWhen: string;
  toUserId: string; toName: string; toWhen: string; toPercentAfter: number;
}
export interface LoadFitPerson { userId: string; name: string; state: LoadState; reason: string; bestFit: boolean; fits: boolean; freeMinutes: number; isCurrent: boolean }
export interface LoadFitTeam { teamId: string; name: string; people: number; free: number; bestUserId: string | null }
export interface LoadFit { minutes: number; people: LoadFitPerson[]; teams: LoadFitTeam[] }
export interface LoadMoved { kind: 'task' | 'action'; id: string; title: string; fromUserId: string | null }
export interface LoadFitQuery { start?: string | null; due?: string | null; minutes?: number | null; size?: string | null; current?: string | null }
export type TaskSize = 'S' | 'M' | 'L' | 'XL';
export const SIZES: { id: TaskSize; label: string; hours: number }[] = [
  { id: 'S', label: 'S · 1h', hours: 1 }, { id: 'M', label: 'M · 4h', hours: 4 }, { id: 'L', label: 'L · 1 day', hours: 8 }, { id: 'XL', label: 'XL · 3 days', hours: 24 }];

const q = (o: Record<string, string | number | null | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== '') s.set(k, String(v));
  const t = s.toString();
  return t ? `?${t}` : '';
};

export const loadApi = {
  get: (scope: LoadScope, from?: string, days = 14) => get<Load>(`/load${q({ scope, from, days })}`),
  day: (userId: string, date: string) => get<LoadDayDetail>(`/load/${userId}/day/${date}`),
  suggestions: () => get<LoadSuggestion[]>('/load/suggestions'),
  fit: (f: LoadFitQuery) => get<LoadFit>(`/load/fit${q({ start: f.start, due: f.due, minutes: f.minutes, size: f.size, current: f.current })}`),
  reassign: (b: { toUserId: string; items?: { kind: string; id: string }[]; fromUserId?: string | null; stageId?: string | null; dryRun?: boolean }) =>
    post<{ toUserId: string; items: LoadMoved[]; dryRun: boolean }>('/load/reassign', b),
  signal: (signal: 'swamped' | 'room' | null) => put<{ signal: string | null }>('/load/signal', { signal }),
  size: (taskId: string, size: TaskSize | null) => put<{ id: string; size: TaskSize | null }>(`/tasks/${taskId}/size`, { size }),
};

/** Undo a move: each item goes back to whoever had it (grouped, one call per person). */
export async function undoMoves(moved: LoadMoved[]) {
  const by = new Map<string, LoadMoved[]>();
  for (const m of moved) if (m.fromUserId) by.set(m.fromUserId, [...(by.get(m.fromUserId) ?? []), m]);
  for (const [to, items] of by) await loadApi.reassign({ toUserId: to, items: items.map((i) => ({ kind: i.kind, id: i.id })) });
}

export const STATE_LABEL: Record<LoadState, string> = { free: 'Free', balanced: 'Balanced', stretched: 'Stretched', overloaded: 'Overloaded', leave: 'On leave', off: 'Off' };
export const loadKeys = { load: (scope: string) => ['capacity', 'load', scope] as unknown[], sugg: ['capacity', 'load-suggestions'] as unknown[], day: (u: string, d: string) => ['capacity', 'load-day', u, d] as unknown[], fit: (f: LoadFitQuery) => ['capacity', 'load-fit', f.start ?? '', f.due ?? '', f.minutes ?? '', f.size ?? '', f.current ?? ''] as unknown[] };
