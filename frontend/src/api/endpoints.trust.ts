import { download, get } from './client';
import type { AuditLog, Paged } from './types';

/** The admin audit viewer's filters (all optional). `kind` is viewed · exported · changed · signin · security. */
export interface AuditFilter { kind?: string; userId?: string; entityType?: string; q?: string; from?: string; to?: string }
export interface AuditFacets { people: { id: string; name: string }[]; entityTypes: string[]; total: number; oldest: string | null }

const params = (f: AuditFilter) => Object.fromEntries(Object.entries(f).filter(([, v]) => v != null && v !== '')) as Record<string, string>;

export const trustApi = {
  audit: (f: AuditFilter, page = 1) => get<Paged<AuditLog>>('/audit', { ...params(f), page, pageSize: 50 }),
  auditFacets: () => get<AuditFacets>('/audit/facets'),
  auditCsv: (f: AuditFilter) => {
    const qs = new URLSearchParams(params(f)).toString();
    return download(`/audit/export${qs ? `?${qs}` : ''}`, `audit-log-${new Date().toISOString().slice(0, 10)}.csv`);
  },
};
