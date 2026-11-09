import { useMemo, useState, type ReactNode } from 'react';
import { ApiError } from '../../api/client';
import { projectApi, teamApi, workspaceApi } from '../../api/endpoints';
import type { Project, Stage, Task } from '../../api/types';
import { CalmAv, CalmSheet, type CalmStep } from '../../components/calm';
import { Icon } from '../../components/Icon';
import { daysUntil } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { askExtensionReason, isExtension } from '../dates/ExtensionReason';
import { loadApi, loadKeys, type LoadFit } from '../load/loadApi';

/*
 * Stages = the project's journey (Requirements → Development → Code review → Testing → Go-live), each with an owner (a person or a team) and
 * a date. Statuses (To do · In progress · In review · Done) are how a single task moves; they are kept separate and edited under Statuses.
 */

export const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "22 Aug" */
export const dm = (iso: string | null | undefined) => { if (!iso) return ''; const d = new Date(`${iso.slice(0, 10)}T00:00:00`); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
export const ordered = (stages: Stage[]) => [...stages].sort((a, b) => a.order - b.order);
export const isClosed = (s: Stage) => s.effectiveStatus === 'Completed';
/** The stage the project is in: the first one not completed (-1 when every stage is). */
export const currentIndex = (stages: Stage[]) => stages.findIndex((s) => !isClosed(s));
/** Days a stage is past its date (open stages only). */
export const lateDays = (s: Stage) => (!isClosed(s) && s.plannedEnd ? Math.max(0, -(daysUntil(s.plannedEnd) ?? 0)) : 0);
const first = (name: string) => name.split(' ')[0];
/** Who owns a stage, short: the team, else the owner's first name, else its assignee's. */
export const ownerLabel = (s: Stage) => s.ownerTeamName ?? (s.owner ? first(s.owner.name) : s.assignee ? first(s.assignee.name) : null);

/** The journey bar's steps: label, then "owner · date" (✓ date when done, "+Nd" in amber when late). */
export function journeySteps(stages: Stage[]): CalmStep[] {
  const list = ordered(stages);
  const cur = currentIndex(list);
  return list.map((s, i) => {
    const state: CalmStep['state'] = isClosed(s) ? 'done' : i === cur ? 'current' : 'next';
    const late = lateDays(s);
    const date = state === 'done' ? (s.actualEnd ?? s.plannedEnd) : s.plannedEnd;
    const who = state === 'done' ? null : ownerLabel(s);
    const text = [who, date ? dm(date) : null].filter(Boolean).join(' · ');
    const sub: ReactNode = state === 'done' ? (date ? `✓ ${dm(date)}` : '✓ Done')
      : late > 0 ? <><span>{who ? `${who} · ` : ''}</span><span className="late">{dm(date)} · +{late}d</span></> : text || undefined;
    const step: CalmStep = { key: s.id, label: s.name, state, sub, ariaLabel: `${s.name}${text ? `, ${text}` : ''}${late ? `, ${late} days late` : ''}`, data: { 'data-stage': s.id } };
    return step;
  });
}

/** The body a stage update needs, from the stage as it is, with changes on top. */
export const stageBody = (s: Stage, patch: Partial<Parameters<typeof projectApi.updateStage>[2]> = {}) => ({
  name: s.name, status: s.status, plannedStart: s.plannedStart, plannedEnd: s.plannedEnd, actualStart: s.actualStart, actualEnd: s.actualEnd,
  ownerId: s.owner?.id ?? null, assigneeId: s.assignee?.id ?? null, description: s.description, durationDays: s.durationDays ?? null, ...patch,
});

/** Moves a stage's date, asking why when it moves later (the server's 422 rule), then saves. Resolves false when cancelled or refused. */
export async function moveStageDate(projectId: string, s: Stage, to: string | null): Promise<Stage[] | null> {
  let extensionReason: string | null = null;
  if (isExtension(s.plannedEnd, to)) {
    extensionReason = await askExtensionReason({ what: `${s.name} date`, from: s.plannedEnd, to });
    if (!extensionReason) return null;
  }
  const start = s.plannedStart && to && s.plannedStart > to ? to : s.plannedStart;
  try { return await projectApi.updateStage(projectId, s.id, stageBody(s, { plannedStart: start, plannedEnd: to, durationDays: null, extensionReason })); }
  catch (e) { toast(errText(e, 'Could not move the date.'), 'error'); return null; }
}

/** Size from the estimate: S ≤ 2h, M ≤ 4h, L ≤ 8h, XL above. */
export const sizeOf = (h: number | null | undefined) => (h == null || h <= 0 ? null : h <= 2 ? 'S' : h <= 4 ? 'M' : h <= 8 ? 'L' : 'XL');
export const SIZES: { id: string; hours: number }[] = [{ id: 'S', hours: 2 }, { id: 'M', hours: 4 }, { id: 'L', hours: 8 }, { id: 'XL', hours: 16 }];

/**
 * How busy a person is, from their open tasks in this project: the fallback when the load engine (useStageLoad) cannot be read.
 */
export function loadHint(userId: string, tasks: Task[] | undefined): { label: string; tone: 'free' | 'ok' | 'busy' | 'over' } | null {
  if (!tasks) return null;
  const open = tasks.filter((t) => t.assignee?.id === userId && t.statusCategory !== 'Done' && t.statusCategory !== 'Cancelled');
  const late = open.filter((t) => t.isOverdue).length;
  if (open.length === 0) return { label: 'free', tone: 'free' };
  if (late >= 2 || open.length >= 8) return { label: `${open.length} open · ${late} late`, tone: 'over' };
  if (open.length >= 5) return { label: `${open.length} open`, tone: 'busy' };
  return { label: `${open.length} open`, tone: 'ok' };
}
const TONE_WORD = { free: 'Free', ok: 'Balanced', busy: 'Stretched', over: 'Over' } as const;
type Hint = { label: string; tone: 'free' | 'ok' | 'busy' | 'over'; best?: boolean };
const LOAD_TONE: Record<string, Hint['tone']> = { free: 'free', balanced: 'ok', stretched: 'busy', overloaded: 'over', leave: 'over', off: 'over' };

/**
 * The load engine's signal for a stage's owner choice (GET /load/fit over the stage's dates): Free / Balanced / Stretched / Over with its
 * reason ("Free Thu · best fit"). Falls back to loadHint() from the project's open tasks when Load cannot be read.
 */
export function useStageLoad(stage: Pick<Stage, 'plannedStart' | 'plannedEnd'> | null, current: string | null | undefined, tasks: Task[] | undefined, enabled = true) {
  const fit = { start: stage?.plannedStart ?? null, due: stage?.plannedEnd ?? null, current: current ?? null };
  const q = useWsQuery(loadKeys.fit(fit), () => loadApi.fit(fit), { enabled: enabled && !!stage, staleTime: 30_000, retry: false });
  const data: LoadFit | undefined = q.data;
  return useMemo(() => (userId: string): Hint | null => {
    const p = Array.isArray(data?.people) ? data.people.find((x) => x.userId === userId) : undefined;
    if (p) return { label: p.reason || TONE_WORD[LOAD_TONE[p.state] ?? 'ok'], tone: LOAD_TONE[p.state] ?? 'ok', best: p.bestFit };
    return loadHint(userId, tasks);
  }, [data, tasks]);
}

/**
 * "Who owns <stage>?": people (with how busy they are) and teams; "Also move <previous>'s N open tasks" hands their unfinished work in the
 * stage to the new person. Saves on tap, notifies the new owner (or every team member) and the previous one.
 */
export function StageOwnerSheet({ projectId, stage, tasks, onClose, onSaved }: {
  projectId: string; stage: Stage | null; tasks: Task[] | undefined; onClose: () => void; onSaved?: (stages: Stage[]) => void;
}) {
  const wid = useWorkspaceId();
  const people = useWsQuery(['members', 'assignable'], workspaceApi.assignableMembers, { enabled: !!stage, staleTime: 60_000 });
  const teams = useWsQuery(['teams'], teamApi.list, { enabled: !!stage, staleTime: 60_000, retry: false });
  const prev = stage?.owner ?? null;
  const prevOpen = useMemo(() => (prev && stage ? (tasks ?? []).filter((t) => t.stageId === stage.id && t.assignee?.id === prev.id && t.statusCategory !== 'Done' && t.statusCategory !== 'Cancelled').length : 0), [tasks, prev, stage]);
  const [move, setMove] = useState(true);
  const [busy, setBusy] = useState(false);
  const hintOf = useStageLoad(stage, prev?.id, tasks, !!stage);
  const hint = prev ? hintOf(prev.id) : null;
  const pick = async (b: { ownerId?: string | null; teamId?: string | null }) => {
    if (!stage || busy) return;
    setBusy(true);
    try {
      const r = await projectApi.reassignStage(projectId, stage.id, { ...b, moveOpenTasks: move && prevOpen > 0 && !!b.ownerId });
      toast(r.movedTasks ? `${stage.name} handed over · ${r.movedTasks} task${r.movedTasks === 1 ? '' : 's'} moved.` : `${stage.name} handed over.`);
      onSaved?.(r.stages);
      void invalidateWorkspace(wid, 'project', projectId);
      onClose();
    } catch (e) { toast(errText(e, 'Could not change the owner.'), 'error'); }
    finally { setBusy(false); }
  };
  const list = (people.data ?? []).filter((m) => m.isActive !== false);
  const rank = { free: 0, ok: 1, busy: 2, over: 3 } as const;
  const sorted = [...list].sort((a, b) => ((hintOf(a.userId)?.best ? -1 : 0) - (hintOf(b.userId)?.best ? -1 : 0) || rank[hintOf(a.userId)?.tone ?? 'ok'] - rank[hintOf(b.userId)?.tone ?? 'ok']) || a.displayName.localeCompare(b.displayName));
  return (
    <CalmSheet open={!!stage} onClose={onClose} kind="bottom" width={520} title={stage ? `Who owns ${stage.name}?` : 'Owner'}
      sub={prev ? `${prev.name}${hint && hint.tone !== 'free' ? ` · ${TONE_WORD[hint.tone].toLowerCase()} (${hint.label})` : ' owns it now'}` : 'Nobody owns it yet'}>
      <div className="stg-owner" data-testid="stage-owner-sheet">
        {sorted.map((m, i) => {
          const h = hintOf(m.userId);
          const now = m.userId === prev?.id;
          return (
            <button key={m.userId} type="button" className={`stg-owner-row${!now && (h?.best || (i === 0 && h?.tone === 'free')) ? ' best' : ''}`} disabled={busy || now} onClick={() => void pick({ ownerId: m.userId })}>
              <CalmAv name={m.displayName} size={40} />
              <span className="stg-owner-t"><b>{m.displayName}{now ? ' · now' : ''}</b><small>{h ? (h.best && !/best fit/.test(h.label) ? `${h.label} · best fit` : h.tone === 'free' && h.label === 'free' ? `No open work here${i === 0 ? ' · best fit' : ''}` : h.label) : m.jobRole ?? m.role}</small></span>
              {h && <span className={`stg-load ${h.tone}`}>{TONE_WORD[h.tone]}</span>}
            </button>
          );
        })}
        {(teams.data?.length ?? 0) > 0 && <h5 className="stg-cap">Teams</h5>}
        {(teams.data ?? []).map((t) => (
          <button key={t.id} type="button" className="stg-owner-row" disabled={busy || stage?.ownerTeamId === t.id} onClick={() => void pick({ teamId: t.id, ownerId: null })}>
            <CalmAv name={t.name} size={40} />
            <span className="stg-owner-t"><b>{t.name}{stage?.ownerTeamId === t.id ? ' · now' : ''}</b><small>{t.memberCount} {t.memberCount === 1 ? 'person' : 'people'} · everyone is told</small></span>
          </button>
        ))}
        {prev && prevOpen > 0 && (
          <>
            <h5 className="stg-cap">Open tasks in this stage</h5>
            <label className="stg-check"><input type="checkbox" checked={move} onChange={(e) => setMove(e.target.checked)} /><span>Also move {first(prev.name)}’s {prevOpen} open task{prevOpen === 1 ? '' : 's'}</span></label>
          </>
        )}
      </div>
    </CalmSheet>
  );
}

/** A tiny "✓ Saved" that flashes after each autosave. */
export function useSaved(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  return [on, () => { setOn(true); window.setTimeout(() => setOn(false), 1600); }];
}
export function SavedTick({ on }: { on: boolean }) {
  return <span className={`cp-saved${on ? ' on' : ''}`} aria-live="polite" data-testid="saved"><Icon name="tick" size={13} /> Saved</span>;
}

/** Everything a project update needs, from the project as it is, with changes on top. */
export const projectBody = (p: Project, patch: Record<string, unknown> = {}) => ({
  name: p.name, description: p.description ?? undefined, priority: p.priority, status: p.status, ownerId: p.owner?.id ?? null, teamId: p.teamId,
  startDate: p.startDate, dueDate: p.dueDate, version: p.version, projectGroupId: p.projectGroupId, projectType: p.projectType, deliveryMethod: p.deliveryMethod,
  enforceDependencies: p.enforceDependencies, ...patch,
});
