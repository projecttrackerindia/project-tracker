import { del, get, post, put, uploadFile } from './client';
import type { Sprint,SprintDetail,ApiKey,Workload,WorkloadPersonDetail,WorkloadScope,WorkItem,WorkItemKind,Webhook,WebhookDelivery,Checklist,CustomField,CustomFieldValue,ImportPreview,ImportResult,PriorityInfo,ReportExport,ReportFormat,ReportKind,WebhookFormat } from './types';

export const sprintApi = {
  list: (projectId: string) => get<Sprint[]>(`/projects/${projectId}/sprints`),
  get: (projectId: string, id: string) => get<SprintDetail>(`/projects/${projectId}/sprints/${id}`),
  create: (projectId: string, b: { name: string; goal: string | null; startDate: string; endDate: string }) => post<Sprint>(`/projects/${projectId}/sprints`, b),
  update: (projectId: string, id: string, b: { name: string; goal: string | null; startDate: string; endDate: string }) => put<Sprint>(`/projects/${projectId}/sprints/${id}`, b),
  remove: (projectId: string, id: string) => del(`/projects/${projectId}/sprints/${id}`),
  start: (projectId: string, id: string) => post<Sprint>(`/projects/${projectId}/sprints/${id}/start`),
  complete: (projectId: string, id: string, moveUnfinishedTo: string | null) => post<Sprint>(`/projects/${projectId}/sprints/${id}/complete`, { moveUnfinishedTo }),
  addTasks: (projectId: string, id: string, taskIds: string[]) => post(`/projects/${projectId}/sprints/${id}/tasks`, { taskIds }),
  toBacklog: (projectId: string, taskIds: string[]) => post(`/projects/${projectId}/backlog`, { taskIds }),
  setForTask: (taskId: string, sprintId: string | null) => put(`/tasks/${taskId}/sprint`, { sprintId }),
};


export const exportApi = {
  list: () => get<ReportExport[]>('/reports/exports'),
  request: (b: { kind: ReportKind; format: ReportFormat; projectId?: string | null; targetUserId?: string | null; days?: number }) => post<ReportExport>('/reports/exports', b),
  remove: (id: string) => del(`/reports/exports/${id}`),
};

export const checklistApi = {
  get: (taskId: string) => get<Checklist>(`/tasks/${taskId}/checklist`),
  add: (taskId: string, title: string) => post<Checklist>(`/tasks/${taskId}/checklist`, { title }),
  update: (taskId: string, itemId: string, b: { title?: string; isDone?: boolean }) => put<Checklist>(`/tasks/${taskId}/checklist/${itemId}`, b),
  remove: (taskId: string, itemId: string) => del<Checklist>(`/tasks/${taskId}/checklist/${itemId}`),
  reorder: (taskId: string, itemIds: string[]) => put<Checklist>(`/tasks/${taskId}/checklist/order`, { itemIds }),
};

export const priorityApi = {
  get: () => get<PriorityInfo[]>('/priorities'),
  set: (items: { level: string; name: string; color: string }[]) => put<PriorityInfo[]>('/priorities', { items }),
  reset: () => del<PriorityInfo[]>('/priorities'),
};

export interface ImportOptions { skipInvalid: boolean; createMissingLabels: boolean; dateFormat: string }
export const importApi = {
  preview: (projectId: string, file: File, mapping: string | undefined, options: ImportOptions) =>
    uploadFile<ImportPreview>(`/projects/${projectId}/import/preview`, file, { ...(mapping ? { mapping } : {}), options: JSON.stringify(options) }),
  run: (projectId: string, file: File, mapping: string, options: ImportOptions) =>
    uploadFile<ImportResult>(`/projects/${projectId}/import`, file, { mapping, options: JSON.stringify(options) }),
};

export const customFieldApi = {
  list: () => get<CustomField[]>('/custom-fields'),
  create: (b: { name: string; type: string; options: string[] | null }) => post<CustomField>('/custom-fields', b),
  update: (id: string, b: { name: string; type: string; options: string[] | null }) => put<CustomField>(`/custom-fields/${id}`, b),
  remove: (id: string) => del(`/custom-fields/${id}`),
  reorder: (ids: string[]) => put<CustomField[]>('/custom-fields/order', { ids }),
  values: (taskId: string) => get<CustomFieldValue[]>(`/tasks/${taskId}/custom-fields`),
  setValues: (taskId: string, values: Record<string, string | null>) => put<CustomFieldValue[]>(`/tasks/${taskId}/custom-fields`, { values }),
};

export const apiKeyApi = {
  list: () => get<ApiKey[]>('/api-keys'),
  create: (b: { name: string; scope: string; expiresInDays: number | null }) => post<{ key: ApiKey; secret: string }>('/api-keys', b),
  revoke: (id: string) => del(`/api-keys/${id}`),
};

export const webhookApi = {
  list: () => get<Webhook[]>('/webhooks'),
  events: () => get<string[]>('/webhooks/events'),
  create: (b: { name: string; url: string; events: string[]; format?: WebhookFormat }) => post<{ webhook: Webhook; secret: string }>('/webhooks', b),
  update: (id: string, b: { name: string; url: string; events: string[]; isActive: boolean; format?: WebhookFormat }) => put<Webhook>(`/webhooks/${id}`, b),
  rotate: (id: string) => post<{ webhook: Webhook; secret: string }>(`/webhooks/${id}/rotate-secret`),
  remove: (id: string) => del(`/webhooks/${id}`),
  deliveries: (id: string) => get<WebhookDelivery[]>(`/webhooks/${id}/deliveries`),
  test: (id: string) => post(`/webhooks/${id}/test`),
  retry: (id: string, deliveryId: string) => post(`/webhooks/${id}/deliveries/${deliveryId}/retry`),
};

export interface WorkItemFilters { kinds?: WorkItemKind[]; open?: boolean; projectId?: string; dueFrom?: string; dueTo?: string; overdue?: boolean; q?: string; limit?: number }
/** Work of every kind in one shape: My work and the workload views. */
export const workItemApi = {
  /** Everything assigned to me: project tasks, issues, action items and operational work. */
  mine: (f: WorkItemFilters = {}) => get<WorkItem[]>('/my-work', { ...f, kinds: f.kinds?.length ? f.kinds.join(',') : undefined }),
  /** Open work per person: my reporting line, the whole workspace (with broad reports access) or just me. */
  /** Every open action item of the projects I can see (the Portfolio's view); follows the team being looked at. */
  actionItems: (open = true) => get<WorkItem[]>('/action-items', { open }),
  workload: (scope?: WorkloadScope) => get<Workload>('/workload', { scope }),
  person: (userId: string, scope?: WorkloadScope) => get<WorkloadPersonDetail>(`/workload/${userId}`, { scope }),
};
