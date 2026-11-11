import { useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalmPicker, type PickItem } from '../../components/calm';
import { useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { ApiError } from '../../api/client';
import { loadApi, loadKeys, SIZES, STATE_LABEL, undoMoves, type LoadFitQuery, type TaskSize } from './loadApi';

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
const first = (name: string) => name.split(/\s+/)[0] ?? name;
const TONE: Record<string, string> = { free: 'free', balanced: 'balanced', stretched: 'stretched', overloaded: 'overloaded', leave: 'leave', off: 'leave' };

/**
 * The owner / assignee picker, load-aware (approved designs assign / reassign-phone): each person with their load state and a short reason
 * for this item's dates and size ("Free Thu · best fit", "Overloaded Wed–Thu"), the best fit highlighted first; teams with "N people · M
 * free" (picking a team gives it to its best free person). Optional: S/M/L/XL chips, and "Also move <name>'s N open tasks" when an owner
 * changes (moved through the bulk reassign, with Undo). Falls back to the plain list when Load cannot be read.
 */
export function LoadPicker({ value, onChange, people, label, placeholder, className, allowClear, disabled, selected, fit, title, subtitle, size, moveOpen, testId }: {
  value: string | null | undefined; onChange: (id: string | null) => void; people: PickItem[]; label: string; placeholder?: string; className?: string;
  allowClear?: boolean; disabled?: boolean; selected?: PickItem | null; fit: LoadFitQuery; title?: ReactNode; subtitle?: ReactNode; testId?: string;
  size?: { value: TaskSize | null; onChange: (s: TaskSize) => void };
  /** "Also move <name>'s open tasks in this stage" (a stage or owner change). */ moveOpen?: { fromUserId: string; fromName: string; stageId: string } | null;
}) {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [alsoMove, setAlsoMove] = useState(true);
  const q = useWsQuery(loadKeys.fit(fit), () => loadApi.fit(fit), { enabled: open, staleTime: 30_000, retry: false });
  const openTasks = useWsQuery(['capacity', 'load-open', moveOpen?.stageId ?? '', moveOpen?.fromUserId ?? ''],
    () => loadApi.reassign({ toUserId: moveOpen!.fromUserId, fromUserId: moveOpen!.fromUserId, stageId: moveOpen!.stageId, dryRun: true }),
    { enabled: open && !!moveOpen, staleTime: 30_000, retry: false });
  // A reply without people (an old server, a stub) reads as "no load": the plain list.
  const fitData = Array.isArray(q.data?.people) && Array.isArray(q.data?.teams) ? q.data : undefined;
  const best = fitData?.people.find((p) => p.bestFit)?.userId ?? null;
  const items = useMemo<PickItem[]>(() => {
    if (!fitData) return people;
    const known = new Map(people.map((p) => [p.id, p]));
    const ranked: PickItem[] = fitData.people.filter((p) => known.has(p.userId)).map((p) => ({
      id: p.userId, label: p.isCurrent ? `${p.name} · now` : p.name, keywords: known.get(p.userId)?.sub ?? undefined, sub: p.reason, tone: TONE[p.state],
      avatar: { text: initials(p.name), tone: TONE[p.state] },
      badge: p.state === 'balanced' ? null : { text: p.state === 'overloaded' ? 'Over' : STATE_LABEL[p.state], tone: TONE[p.state] },
    }));
    const rest = people.filter((p) => !fitData!.people.some((x) => x.userId === p.id));
    const teams: PickItem[] = fitData.teams.filter((t) => t.bestUserId).map((t) => ({
      id: `team:${t.teamId}`, label: t.name, sub: `${t.people} ${t.people === 1 ? 'person' : 'people'} · ${t.free} free`, group: 'Teams', avatar: { text: initials(t.name), tone: 'team' },
    }));
    return [...ranked, ...rest, ...teams];
  }, [fitData, people]);
  const n = openTasks.data?.items.length ?? 0;

  const pick = async (id: string | null) => {
    const team = id?.startsWith('team:') ? fitData?.teams.find((t) => `team:${t.teamId}` === id) : null;
    const to = team ? team.bestUserId : id;
    if (team && to) toast(`Given to ${first(fitData?.people.find((p) => p.userId === to)?.name ?? team.name)} (${team.name}).`);
    onChange(to ?? null);
    if (to && moveOpen && alsoMove && n > 0 && to !== moveOpen.fromUserId) {
      try {
        const res = await loadApi.reassign({ toUserId: to, fromUserId: moveOpen.fromUserId, stageId: moveOpen.stageId });
        toast(`Moved ${first(moveOpen.fromName)}’s ${res.items.length} open task${res.items.length === 1 ? '' : 's'}.`, 'success', {
          label: 'Undo', ms: 8000, onClick: () => { void undoMoves(res.items).then(() => qc.invalidateQueries({ queryKey: [wid, 'capacity'] })).catch(() => toast('Could not undo the move.', 'error')); } });
      } catch (e) { toast(e instanceof ApiError ? e.message : 'The open tasks could not be moved.', 'error'); }
      void Promise.all(['capacity', 'portfolio', 'tasks', 'task'].map((k) => qc.invalidateQueries({ queryKey: [wid, k] })));
    }
  };

  const footer = (size || (moveOpen && n > 0)) ? <>
    {moveOpen && n > 0 && <>
      <h4>Open tasks in this stage</h4>
      <label className="cpk-check"><input type="checkbox" checked={alsoMove} onChange={(e) => setAlsoMove(e.target.checked)} />Also move {first(moveOpen.fromName)}’s {n} open task{n === 1 ? '' : 's'}</label>
    </>}
    {size && <>
      <h4>Size</h4>
      <div className="cpk-chips" role="group" aria-label="Size">
        {SIZES.map((s) => <button key={s.id} type="button" aria-pressed={size.value === s.id} onClick={() => size.onChange(s.id)}>{s.label}</button>)}
      </div>
    </>}
  </> : undefined;

  return (
    <CalmPicker label={label} placeholder={placeholder} className={className} allowClear={allowClear} disabled={disabled} selected={selected} testId={testId}
      items={items} value={value} onChange={(id) => void pick(id)} recentKey={fitData ? undefined : 'people'} ranked={!!fitData} limit={fitData ? 50 : undefined}
      suggestedId={best} title={title} subtitle={subtitle ?? (q.isLoading ? 'Checking load…' : undefined)} footer={footer} onOpenChange={setOpen} />
  );
}
