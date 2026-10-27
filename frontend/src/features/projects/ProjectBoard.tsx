import { useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { projectApi } from '../../api/endpoints';
import type { Project, ProjectStatus } from '../../api/types';
import { Face } from '../../components/Face';
import { invalidateWorkspace } from '../../lib/hooks';
import { queryClient, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { dayMonth, isFinished, passGradient, passStatus } from './projectParts';

export type BoardColumnId = 'notStarted' | 'inProgress' | 'atRisk' | 'late' | 'done';

/**
 * The five board columns. Status comes from the one source the passes and the list use (passStatus); "Not started" is an on-track project
 * still in Planning. `moveTo` is the project status a drop sets; At risk and Late are worked out by the server from dates and work, so
 * nothing can be dropped there (the same moves the old status board allowed: Planning, Active, Completed).
 */
export const BOARD_COLUMNS: { id: BoardColumnId; label: string; tone: string; moveTo?: ProjectStatus }[] = [
  { id: 'notStarted', label: 'Not started', tone: 'idle', moveTo: 'Planning' },
  { id: 'inProgress', label: 'In progress', tone: 'ok', moveTo: 'Active' },
  { id: 'atRisk', label: 'At risk', tone: 'risk' },
  { id: 'late', label: 'Late', tone: 'late' },
  { id: 'done', label: 'Done', tone: 'done', moveTo: 'Completed' },
];

export function boardColumn(p: Project): BoardColumnId {
  const tone = passStatus(p).tone;
  if (tone === 'done' || isFinished(p)) return 'done';
  if (tone === 'late') return 'late';
  if (tone === 'risk') return 'atRisk';
  return p.status === 'Planning' ? 'notStarted' : 'inProgress';
}

/**
 * Projects board (Apple design): status columns with compact cards — key chip, name, owner photo, progress bar, due.
 * Dragging a card to Not started / In progress / Done changes the project's status through the same move API and permission as the old
 * board (whole-org editors, or the project's owner), with the same sign-off warning when a project is marked Completed too early.
 */
export function ProjectBoard({ projects, cacheKey, canEditAll, meId, onOpen }: {
  projects: Project[]; cacheKey: unknown[]; canEditAll: boolean; meId: string; onOpen: (id: string) => void;
}) {
  const wid = useWorkspaceId();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<BoardColumnId | null>(null);

  const columns = useMemo(() => BOARD_COLUMNS.map((c) => ({ ...c, items: projects.filter((p) => boardColumn(p) === c.id) })), [projects]);
  const canMove = (p: Project) => canEditAll || p.owner?.id === meId;
  const dragged = projects.find((p) => p.id === dragId);
  const accepts = (c: typeof BOARD_COLUMNS[number]) => !!dragged && !!c.moveTo && c.moveTo !== dragged.status;
  const reset = () => { setDragId(null); setOverCol(null); };

  const drop = async (col: typeof BOARD_COLUMNS[number]) => {
    const project = dragged;
    reset();
    if (!project || !col.moveTo || !canMove(project) || project.status === col.moveTo) return;
    const status = col.moveTo;
    const previous = queryClient.getQueryData(cacheKey);
    queryClient.setQueryData<{ items: Project[]; total: number }>(cacheKey, (old) => old && ({
      ...old, items: old.items.map((p) => (p.id === project.id ? { ...p, status, health: status === 'Completed' ? 'Completed' : p.health === 'Completed' ? 'OnTrack' : p.health } : p)),
    }));
    try {
      const res = await projectApi.move(project.id, { status });
      const pending = res?.pendingSignOffs ?? 0;
      if (status === 'Completed' && pending > 0)
        toast(`“${project.name}” marked Completed, but ${pending} stage sign-off${pending === 1 ? ' is' : 's are'} still pending.`, 'warning');
      else toast(`“${project.name}” moved to ${col.label}.`);
      void invalidateWorkspace(wid, 'projects');
    } catch (e) {
      queryClient.setQueryData(cacheKey, previous);
      toast(e instanceof ApiError ? e.message : 'Could not move the project.', 'error');
    }
  };

  return (
    <div className="pb-board" role="list" aria-label="Projects by status" data-testid="projects-board">
      {columns.map((col) => {
        const ok = accepts(col);
        return (
          <section key={col.id} role="listitem" aria-label={col.label} data-column={col.id}
            className={`pb-col ${dragId ? (ok ? 'can-drop' : 'no-drop') : ''} ${overCol === col.id && ok ? 'over' : ''}`}
            onDragOver={(e) => { if (ok) { e.preventDefault(); setOverCol(col.id); } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverCol(null); }}
            onDrop={(e) => { e.preventDefault(); void drop(col); }}>
            <header className="pb-head">
              <span className={`pb-dot ${col.tone}`} aria-hidden="true" />
              <b>{col.label}</b>
              <span className="pb-count">{col.items.length}</span>
            </header>
            <div className="pb-body">
              {col.items.length === 0 && <div className="pb-empty">{col.moveTo ? 'Drop projects here' : 'None'}</div>}
              {col.items.map((p) => {
                const [from, to] = passGradient(p);
                const pct = Math.max(0, Math.min(100, p.progress));
                const movable = canMove(p);
                return (
                  <div key={p.id} role="button" tabIndex={0} draggable={movable} data-testid="board-card" data-project={p.name}
                    className={`pb-card ${dragId === p.id ? 'dragging' : ''}`}
                    aria-label={`${p.name}, ${pct}% done${p.dueDate ? `, due ${dayMonth(p.dueDate)}` : ''}`}
                    onDragStart={(e) => { setDragId(p.id); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', p.id); } catch { /* ignore */ } }}
                    onDragEnd={reset}
                    onClick={() => onOpen(p.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(p.id); }}>
                    <span className="pb-top">
                      <span className="pb-key" style={{ background: `linear-gradient(150deg, ${from}, ${to})` }}>{p.key}</span>
                      {p.owner ? <Face className="pb-av" userId={p.owner.id} name={p.owner.name} title={p.owner.name} /> : <span className="pb-av" title="No owner">–</span>}
                    </span>
                    <b className="pb-name" title={p.name}>{p.name}</b>
                    <span className="pb-bar" aria-hidden="true"><i className={col.tone} style={{ width: `${pct}%` }} /></span>
                    <span className="pb-meta"><span>{pct}%</span><span>{p.dueDate ? `Due ${dayMonth(p.dueDate)}` : 'No due date'}</span></span>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
