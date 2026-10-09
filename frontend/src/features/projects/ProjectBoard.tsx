import { useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { projectApi } from '../../api/endpoints';
import type { Paged, Project, ProjectStatus } from '../../api/types';
import { Icon } from '../../components/Icon';
import { activeShare, Avatar, HealthBadge, PriorityBadge, Progress } from '../../components/ui';
import { dueLabel } from '../../lib/format';
import { invalidateWorkspace } from '../../lib/hooks';
import { queryClient, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { ProjectChatButton } from '../chat/ProjectChat';

const COLUMNS: { status: ProjectStatus; label: string; color: string }[] = [
  { status: 'Planning', label: 'Planning', color: '#38bdf8' },
  { status: 'Active', label: 'Active', color: '#8b5cf6' },
  { status: 'OnHold', label: 'On Hold', color: '#fbbf24' },
  { status: 'Completed', label: 'Completed', color: '#34d399' },
  { status: 'Cancelled', label: 'Cancelled', color: '#9aa0b5' },
];
const ARCHIVED = { status: 'Archived' as ProjectStatus, label: 'Archived', color: '#94a3b8' };

/**
 * Projects board. Columns are project statuses.
 *  - Dropping a card in a different column changes the project's status.
 *  - Dropping it inside its own column only re-orders it (status is untouched).
 * Order is persisted (Project.Position), so it survives a reload.
 */
export function ProjectBoard({ projects, cacheKey, includeArchived, canEditAll, meId, onOpen }: {
  projects: Project[]; cacheKey: unknown[]; includeArchived: boolean; canEditAll: boolean; meId: string; onOpen: (id: string) => void;
}) {
  const wid = useWorkspaceId();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<ProjectStatus | null>(null);
  const [overCard, setOverCard] = useState<string | null>(null);

  const columns = useMemo(() => {
    const cols = includeArchived ? [...COLUMNS, ARCHIVED] : COLUMNS;
    return cols.map((c) => ({ ...c, items: projects.filter((p) => p.status === c.status).sort((a, b) => a.position - b.position) }));
  }, [projects, includeArchived]);

  const canMove = (p: Project) => canEditAll || p.owner?.id === meId;

  const reset = () => { setDragId(null); setOverCol(null); setOverCard(null); };

  const drop = async (status: ProjectStatus, beforeId?: string) => {
    const project = projects.find((p) => p.id === dragId);
    reset();
    if (!project || !canMove(project)) return;

    const column = projects.filter((p) => p.status === status && p.id !== project.id).sort((a, b) => a.position - b.position);
    let position: number;
    if (beforeId) {
      const idx = column.findIndex((p) => p.id === beforeId);
      const next = column[idx]; const prev = column[idx - 1];
      position = !next ? (column.at(-1)?.position ?? 0) + 1024 : prev ? (prev.position + next.position) / 2 : next.position - 512;
    } else position = (column.at(-1)?.position ?? 0) + 1024;
    if (project.status === status && project.position === position) return;

    // Optimistic update; rolled back if the server refuses (permission, plan limit...).
    const previous = queryClient.getQueryData<Paged<Project>>(cacheKey);
    queryClient.setQueryData<Paged<Project>>(cacheKey, (old) => old && ({
      ...old, items: old.items.map((p) => (p.id === project.id ? { ...p, status, position } : p)),
    }));
    try {
      await projectApi.move(project.id, { status, position });
      if (project.status !== status) toast(`“${project.name}” moved to ${[...COLUMNS, ARCHIVED].find((c) => c.status === status)?.label}.`);
      void invalidateWorkspace(wid, 'projects');
    } catch (e) {
      queryClient.setQueryData(cacheKey, previous);
      toast(e instanceof ApiError ? e.message : 'Could not move the project.', 'error');
    }
  };

  return (
    <div className="kanban" role="list" aria-label="Projects by status">
      {columns.map((col) => (
        <div key={col.status} role="listitem" className={`kb-col ${overCol === col.status ? 'drag-over' : ''}`}>
          <div className="kb-head">
            <div className="kb-head-left"><span className="kb-dot" style={{ background: col.color, color: col.color }} /><span className="kb-title">{col.label}</span></div>
            <span className="kb-count">{col.items.length}</span>
          </div>
          <div className="kb-body"
            onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverCol(col.status); } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverCol(null); }}
            onDrop={(e) => { e.preventDefault(); void drop(col.status, overCard ?? undefined); }}>
            {col.items.length === 0 && <div className="kb-empty">Drop projects here</div>}
            {col.items.map((p) => (
              <div key={p.id} role="button" tabIndex={0} draggable={canMove(p)}
                className={`kb-card ${dragId === p.id ? 'dragging' : ''} ${overCard === p.id && dragId !== p.id ? 'drop-before' : ''}`}
                onDragStart={(e) => { setDragId(p.id); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', p.id); } catch { /* ignore */ } }}
                onDragEnd={reset}
                onDragOver={(e) => { if (dragId && dragId !== p.id) { e.preventDefault(); e.stopPropagation(); setOverCol(col.status); setOverCard(p.id); } }}
                onClick={() => onOpen(p.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(p.id); }}>
                <div className="task-key">{p.key}{p.teamName ? ` · ${p.teamName}` : ''}</div>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
                  <div className="kb-card-title">{p.name}</div><ProjectChatButton projectId={p.id} name={p.name} />
                </div>
                <div className="row" style={{ marginBottom: 9 }}>
                  <div style={{ flex: 1 }}><Progress value={p.progress} active={activeShare(p.stats)} /></div><b style={{ fontSize: 11.5 }}>{p.progress}%</b>
                </div>
                <div className="kb-card-meta"><PriorityBadge priority={p.priority} /><HealthBadge health={p.health} /></div>
                <div className="kb-card-meta" style={{ marginTop: 9 }}>
                  <span className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--text-3)' }}><Avatar name={p.owner?.name} size="sm" userId={p.owner?.id} />{p.owner?.name ?? 'Unassigned'}</span>
                  <span className="meta-line"><Icon name="clock" /> {dueLabel(p.dueDate)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
