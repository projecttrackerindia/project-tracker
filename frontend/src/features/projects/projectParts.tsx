import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { projectApi } from '../../api/endpoints';
import type { Project, ProjectHealth } from '../../api/types';
import { AiCard } from '../../components/v2/AiCard';
import { MONTHS } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useCan, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { duplicateGroups, groupKey, readDismissed, writeDismissed } from './duplicates';
import './projectsHome.css';

/** The pieces Projects, Portfolio and the project page share. */

type Tone = 'ok' | 'risk' | 'late' | 'done' | 'muted';
export const HEALTH: Record<ProjectHealth, { label: string; tone: Tone }> = {
  OnTrack: { label: 'On track', tone: 'ok' }, AtRisk: { label: 'At risk', tone: 'risk' }, Delayed: { label: 'Delayed', tone: 'late' },
  Completed: { label: 'Completed', tone: 'done' }, Cancelled: { label: 'Cancelled', tone: 'muted' }, Archived: { label: 'Archived', tone: 'muted' },
};
/** "2 Nov" (a date-only value, read as the calendar day it names) */
export const dayMonth = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return y && m && d ? `${d} ${MONTHS[m - 1]}` : '—';
};
export const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
export const isFinished = (p: Pick<Project, 'status'>) => p.status === 'Completed' || p.status === 'Cancelled' || p.status === 'Archived';

/** A project's status as a small coloured pill (colour means status). */
export function HealthPill({ health, pendingSignOffs = 0 }: { health: ProjectHealth; pendingSignOffs?: number }) {
  // Completed (or 100% of the work done) but stages still unsigned: not really finished yet, so amber.
  if (health === 'Completed' && pendingSignOffs > 0)
    return <span className="pj2-pill risk" title="Every task is done; the remaining stages still need sign-off">100% work · {pendingSignOffs} sign-off{pendingSignOffs === 1 ? '' : 's'} pending</span>;
  const h = HEALTH[health];
  return <span className={`pj2-pill ${h.tone}`}>{h.label}</span>;
}

/** "‹ Work" (or another place): where this page belongs, as the blue line above its title. */
export function BackLink({ to, label }: { to: string; label: string }) {
  return <Link className="pj2-back" to={to}><span aria-hidden="true">‹</span> {label}</Link>;
}

const PAGE = 100, MAX_PAGES = 5;
/** Every project the person may open (up to 500), for the counts, the cards and the duplicate check; health is worked out per project by the server. */
export function useAllProjects(f: { mineOnly: boolean; includeArchived: boolean }) {
  return useWsQuery(['projects', 'list', 'all', f], async () => {
    const first = await projectApi.list({ ...f, sort: 'due', page: 1, pageSize: PAGE });
    let items = first.items;
    for (let page = 2; page <= Math.min(first.totalPages, MAX_PAGES); page++) items = items.concat((await projectApi.list({ ...f, sort: 'due', page, pageSize: PAGE })).items);
    return { items, total: first.totalItems };
  }, { placeholderData: (p) => p, staleTime: 30_000 });
}

/**
 * ✦ "Likely duplicate": two projects whose names match once case, spaces and punctuation are ignored. There is no merge yet, so the card
 * offers to close one (it is archived: its work stays, and it can be restored) or to say it is not a duplicate (remembered for the workspace).
 */
export function DuplicateFlags({ projects }: { projects: Project[] }) {
  const wid = useWorkspaceId();
  const canEdit = useCan('projects.edit');
  const meId = useAuth((s) => s.ctx?.user.id);
  const [dismissed, setDismissed] = useState<string[]>(() => readDismissed(wid));
  const [choosing, setChoosing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const groups = useMemo(() => duplicateGroups(projects.filter((p) => p.status !== 'Archived')).filter((g) => !dismissed.includes(groupKey(g))), [projects, dismissed]);
  if (groups.length === 0) return null;
  const notDuplicate = (key: string) => { const next = [...dismissed, key]; setDismissed(next); writeDismissed(wid, next); toast('Got it. They will not be flagged again.', 'info'); };
  const close = async (p: Project) => {
    if (!(await confirmDialog({ title: `Close “${p.name}”?`, message: 'It is archived: its work and history stay, and it can be restored from Edit details. The other project carries on.', confirmText: 'Close it' }))) return;
    setBusy(p.id);
    try { await projectApi.move(p.id, { status: 'Archived' }); toast(`“${p.name}” closed.`); setChoosing(null); void invalidateWorkspace(wid, 'projects'); void invalidateWorkspace(wid, 'portfolio'); }
    catch (e) { toast(errText(e, 'Could not close the project.'), 'error'); }
    finally { setBusy(null); }
  };
  return (
    <div className="pj2-dupes">
      {groups.map((g) => {
        const key = groupKey(g);
        const names = g.map((p) => `“${p.name}”`);
        const closable = g.filter((p) => canEdit || p.owner?.id === meId);
        return (
          <AiCard key={key} className="pj2-dupe" title={<>Likely duplicate: {names.slice(0, -1).join(', ')} and {names.at(-1)}</>}>
            <span className="pj2-dupe-text">Same name apart from case and spacing. Merge or close: there is no merge yet, so keep one and close the other.</span>
            <span className="pj2-dupe-acts" data-testid="duplicate-actions">
              {choosing === key
                ? closable.map((p) => (
                  <button key={p.id} type="button" className="btn btn-sm btn-ghost" disabled={busy !== null} onClick={() => void close(p)}>
                    Close “{p.name}” <small>{p.progress}% · {p.stats.total - p.stats.cancelled} task{p.stats.total - p.stats.cancelled === 1 ? '' : 's'}</small>
                  </button>
                ))
                : closable.length > 0 && <button type="button" className="btn btn-sm btn-ai" onClick={() => setChoosing(key)}>Close one</button>}
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => notDuplicate(key)}>Not a duplicate</button>
            </span>
          </AiCard>
        );
      })}
    </div>
  );
}
