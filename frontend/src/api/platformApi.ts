// History of fields, bulk edit, saved views, the public API status page, data location and public holidays.
import { apiUrl, create, del, get, post, put } from './client';
import type { Priority, UserRef } from './types';

/** One field change: who, when, which field, old → new (null = empty). */
export interface HistoryEntry { id: string; at: string; actor: UserRef | null; field: string; from: string | null; to: string | null }

export interface BulkWorkInput {
  ids: string[];
  /** A category, said in each kind's own words on the server. */
  status?: 'todo' | 'active' | 'done' | 'cancelled';
  assigneeId?: string;
  unassign?: boolean;
  priority?: Priority;
  dueDate?: string;
  clearDueDate?: boolean;
  /** Added to tasks (other kinds have no labels). */
  labelIds?: string[];
  /** Moves tickets to this related project. */
  projectId?: string;
  delete?: boolean;
}
export interface BulkWorkResult { changed: number; failed: { id: string; key: string | null; reason: string }[] }

export type ViewScope = 'mywork' | 'work' | 'desk' | 'portfolio';
export type ViewSharing = 'private' | 'workspace' | 'team';
export interface SavedView {
  id: string; scope: ViewScope; name: string; sharing: ViewSharing; teamId: string | null; teamName: string | null;
  ownerId: string; ownerName: string; mine: boolean; config: Record<string, unknown>; createdAt: string;
}
export interface SaveViewInput { scope?: ViewScope; name: string; sharing: ViewSharing; teamId?: string | null; config: Record<string, unknown> }

export interface StatusComponentConfig { apiId: string; name: string }
export interface StatusPageSettings {
  canManage: boolean; slug: string; title: string; published: boolean; publishedAt: string | null;
  components: StatusComponentConfig[]; available: { apiId: string; name: string; documentTitle: string }[]; url: string | null;
}
export type StatusState = 'operational' | 'degraded' | 'outage';
export interface PublicStatus {
  title: string; workspace: string; state: StatusState; updatedAt: string; source: string;
  components: { name: string; state: StatusState; uptime: number; days: { date: string; state: 'up' | 'degraded' | 'down' }[] }[];
  incidents: { title: string; severity: 'major' | 'minor'; startedAt: string; resolvedAt: string | null; components: string[] }[];
}

export interface DataLocation {
  region: string; regionName: string; backupRegionName: string; country: string; keepDataInIndia: boolean; canManage: boolean;
  providers: { key: string; name: string; location: string; inIndia: boolean; inUse: boolean }[];
}

export interface Holiday { id: string; date: string; name: string; region: string | null }

export const historyApi = {
  workItem: (id: string) => get<HistoryEntry[]>(`/work-items/${id}/history`),
  project: (id: string) => get<HistoryEntry[]>(`/projects/${id}/history`),
};

export const bulkApi = {
  run: (b: BulkWorkInput) => post<BulkWorkResult>('/work-items/bulk', b),
};

export const savedViewApi = {
  list: (scope: ViewScope) => get<SavedView[]>('/saved-views', { scope }),
  create: (b: SaveViewInput) => create<SavedView>('/saved-views', b),
  update: (id: string, b: SaveViewInput) => put<SavedView>(`/saved-views/${id}`, b),
  remove: (id: string) => del(`/saved-views/${id}`),
};

export const statusPageApi = {
  get: () => get<StatusPageSettings>('/status-page'),
  save: (b: { slug: string; title: string; published: boolean; components: StatusComponentConfig[] }) => put<StatusPageSettings>('/status-page', b),
  /** Without signing in: a plain fetch, so a 404 never looks like a signed-out session. */
  public: async (slug: string): Promise<PublicStatus | null> => {
    const res = await fetch(apiUrl(`/public/status/${encodeURIComponent(slug)}`), { headers: { Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('The status page could not be loaded.');
    const body = await res.json() as { data: PublicStatus };
    return body.data;
  },
};

export const dataLocationApi = {
  get: () => get<DataLocation>('/settings/data-location'),
  set: (keepDataInIndia: boolean) => put<DataLocation>('/settings/data-location', { keepDataInIndia }),
};

export const holidayApi = {
  list: (year: number) => get<Holiday[]>('/holidays', { year }),
  add: (b: { date: string; name: string; region?: string | null }) => create<Holiday>('/holidays', b),
  preset: (year: number) => post<{ added: number; alreadyThere: number; holidays: Holiday[] }>('/holidays/preset', { country: 'IN', year }),
  remove: (id: string) => del(`/holidays/${id}`),
};
