import { create, del, get, patch, post, put } from '../../api/client';
import type { Priority } from '../../api/types';

/** A repeat rule (backend: RecurrenceRuleDto). Weekdays are ISO: 1 = Monday … 7 = Sunday. monthWeek 5 = the last. */
export type RepeatRule = {
  frequency: 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';
  interval?: number; unit?: 'day' | 'week' | 'month' | null; daysOfWeek?: number[] | null;
  monthDay?: number | null; monthWeek?: number | null; monthWeekday?: number | null; endAfter?: number | null; endBy?: string | null;
};
export type Recurrence = {
  repeats: boolean; seriesId: string | null; rule: RepeatRule | null; summary: string | null; index: number | null; date: string | null; next: string[]; occurrences: number;
};
export type OccurrenceEdit = { scope: 'this' | 'following'; title?: string; description?: string; priority?: Priority; assigneeId?: string; clearAssignee?: boolean; rule?: RepeatRule };

export type TemplateKind = 'project' | 'task';
export type WorkTemplate = { id: string; kind: TemplateKind; name: string; description: string | null; taskCount: number; sectionCount: number; durationDays: number | null; createdAt: string };
export type CreatedFromTemplate = { projectId: string | null; taskIds: string[] };

export const recurrenceApi = {
  get: (taskId: string) => get<Recurrence>(`/tasks/${taskId}/recurrence`),
  set: (taskId: string, rule: RepeatRule) => put<Recurrence>(`/tasks/${taskId}/recurrence`, { rule }),
  edit: (taskId: string, body: OccurrenceEdit) => patch<Recurrence>(`/tasks/${taskId}/recurrence`, body),
  skip: (taskId: string) => post<Recurrence>(`/tasks/${taskId}/recurrence/skip`),
  stop: (taskId: string) => del<Recurrence>(`/tasks/${taskId}/recurrence`),
};

export const templateApi = {
  list: (kind?: TemplateKind, q?: string) => get<WorkTemplate[]>('/templates', { kind, q }),
  saveProject: (projectId: string, name?: string) => post<WorkTemplate>(`/templates/from-project/${projectId}`, { name }),
  saveTask: (taskId: string, name?: string) => post<WorkTemplate>(`/templates/from-task/${taskId}`, { name }),
  createProject: (id: string, body: { name: string; startDate: string; projectGroupId?: string }) => create<CreatedFromTemplate>(`/templates/${id}/create-project`, body),
  createTask: (id: string, body: { projectId: string; startDate: string }) => create<CreatedFromTemplate>(`/templates/${id}/create-task`, body),
  remove: (id: string) => del(`/templates/${id}`),
};
