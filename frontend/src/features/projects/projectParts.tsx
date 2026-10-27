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

// ------------------------------------------------------------------------------------------------------------------ Passes (Apple design)

/** The one status a pass, the list and the project page show: At risk · Late · On track · Done. 100% work with stages unsigned reads At risk. */
export type PassTone = 'ok' | 'risk' | 'late' | 'done';
export function passStatus(p: Pick<Project, 'health' | 'pendingSignOffs' | 'progress' | 'status'>): { label: string; tone: PassTone } {
  const pending = p.pendingSignOffs ?? 0;
  if ((p.health === 'Completed' || p.progress >= 100) && pending > 0 && p.health !== 'Delayed') return { label: 'At risk', tone: 'risk' };
  switch (p.health) {
    case 'OnTrack': return { label: 'On track', tone: 'ok' };
    case 'AtRisk': return { label: 'At risk', tone: 'risk' };
    case 'Delayed': return { label: 'Late', tone: 'late' };
    case 'Completed': return { label: 'Done', tone: 'done' };
    case 'Cancelled': return { label: 'Cancelled', tone: 'done' };
    default: return { label: 'Archived', tone: 'done' };
  }
}

/** Twelve Wallet-style gradients; a project keeps its own (picked from its key, so it never changes between visits). */
const GRADIENTS: [string, string][] = [
  ['#7a78ff', '#3634a3'], ['#ffb340', '#e0640a'], ['#5fd4e4', '#1a8aa3'], ['#4a8cff', '#1d4fc4'], ['#3fd38a', '#14905a'], ['#9ad35a', '#4c9a20'],
  ['#ff6b7f', '#c41e3a'], ['#c38bff', '#7b3fd1'], ['#ff8a5c', '#d1452b'], ['#4fc3c8', '#167a86'], ['#f27ab8', '#b52c78'], ['#6f9bd8', '#33508f'],
];
const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };
export function passGradient(p: Pick<Project, 'key' | 'id' | 'status'>): [string, string] {
  if (p.status === 'Completed' || p.status === 'Cancelled' || p.status === 'Archived') return ['#8e8e9a', '#4a4a55'];
  return GRADIENTS[hash(p.key || p.id) % GRADIENTS.length];
}
export const initials = (name: string | null | undefined) => {
  const w = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (w.length === 0) return '?';
  return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[w.length - 1][0]).toUpperCase();
};
const AVATAR = ['#5856d6', '#0a84ff', '#ff9500', '#af52de', '#34c759', '#ff2d55', '#30b0c7', '#a2845e'];
export const avatarColor = (seed: string | null | undefined) => AVATAR[hash(seed ?? '') % AVATAR.length];
/** A round initials avatar (the projects pages draw people this way). */
export function Initials({ name, seed, className = '' }: { name: string | null | undefined; seed?: string | null; className?: string }) {
  return <span className={`pa-av ${className}`} style={{ background: avatarColor(seed ?? name) }} aria-hidden="true">{initials(name)}</span>;
}
