import { useQueries } from '@tanstack/react-query';
import { useCallback, useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import { planningApi } from '../../api/endpoints';
import type { Task } from '../../api/types';
import { useWorkspaceId } from '../../stores/auth';

/** One link: `from` has to be dealt with before `to`. `open` is true while it still holds `to` back. */
export type TaskEdge = { id: string; from: string; to: string; open: boolean };

/** The links among the tasks on screen. Only tasks that say they have links are asked, so a list without any costs nothing. */
export function useTaskEdges(rows: Task[]): TaskEdge[] {
  const wid = useWorkspaceId();
  const linked = useMemo(() => rows.filter((t) => t.dependsOnCount + t.blocksCount > 0), [rows]);
  const results = useQueries({ queries: linked.map((t) => ({ queryKey: [wid, 'task', t.id, 'dependencies'], queryFn: () => planningApi.dependencies(t.id), staleTime: 30_000, retry: false })) });
  return useMemo(() => {
    const shown = new Set(rows.map((t) => t.id));
    const out = new Map<string, TaskEdge>();
    linked.forEach((t, i) => {
      const d = results[i]?.data;
      if (!d) return;
      for (const l of d.blockedBy) if (shown.has(l.task.id)) out.set(l.id, { id: l.id, from: l.task.id, to: t.id, open: !l.satisfied });
      for (const l of d.blocks) if (shown.has(l.task.id)) out.set(l.id, { id: l.id, from: t.id, to: l.task.id, open: !l.satisfied });
    });
    return [...out.values()];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked, rows, ...results.map((r) => r.data)]);
}

type Seg = TaskEdge & { y1: number; y2: number };

/**
 * Curved arrows in the gutter beside a list: from the task that comes first, round to the task that waits for it (arrowhead on the waiting task).
 * Amber while the first task is still open, green once it is done. Hover or focus a task and only its arrows stay bold.
 */
export function TaskLinkArrows({ list, edges, active }: { list: RefObject<HTMLElement | null>; edges: TaskEdge[]; active: string | null }) {
  const [segs, setSegs] = useState<Seg[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const measure = useCallback(() => {
    const ul = list.current;
    if (!ul) return;
    const top = ul.getBoundingClientRect().top;
    const mid = (id: string) => { const el = ul.querySelector<HTMLElement>(`[data-task="${id}"]`); if (!el) return null; const r = el.getBoundingClientRect(); return r.top - top + r.height / 2; };
    setSegs(edges.flatMap((e) => { const y1 = mid(e.from), y2 = mid(e.to); return y1 == null || y2 == null ? [] : [{ ...e, y1, y2 }]; }));
    setSize({ w: ul.clientWidth, h: ul.clientHeight });
  }, [list, edges]);
  useLayoutEffect(() => {
    measure();
    const ul = list.current;
    if (!ul || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(ul);
    return () => ro.disconnect();
  }, [measure, list]);
  if (!segs.length) return null;
  const G = 50;   // the gutter
  // Each arrow gets its own lane so arrows that cover the same rows never sit on top of each other.
  const lanes: { lo: number; hi: number }[][] = [];
  const laneOf = new Map<string, number>();
  [...segs].sort((x, y) => Math.abs(x.y2 - x.y1) - Math.abs(y.y2 - y.y1)).forEach((s) => {
    const lo = Math.min(s.y1, s.y2) - 8, hi = Math.max(s.y1, s.y2) + 8;
    let n = lanes.findIndex((l) => l.every((r) => hi < r.lo || lo > r.hi));
    if (n < 0) { lanes.push([]); n = lanes.length - 1; }
    lanes[n].push({ lo, hi });
    laneOf.set(s.id, n);
  });
  const X0 = 6;
  return (
    <svg className="tl-arrows" width={G} height={size.h} viewBox={`0 0 ${G} ${size.h}`} aria-hidden="true" data-testid="task-links">
      <defs>
        {(['open', 'done'] as const).map((k) => (
          <marker key={k} id={`tl-head-${k}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M1 1.5 8.5 5 1 8.5" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: k === 'open' ? 'var(--calm-orange, #ff9500)' : 'var(--calm-green, #28cd41)' }} />
          </marker>
        ))}
      </defs>
      {segs.map((s) => {
        const bulge = 10 + Math.min(laneOf.get(s.id) ?? 0, 3) * 10 + Math.min(10, Math.abs(s.y2 - s.y1) / 40);
        const on = active == null || active === s.from || active === s.to;
        const k = s.open ? 'open' : 'done';
        return (
          <g key={s.id} className={`tl-arrow ${k}${on ? '' : ' dim'}`}>
            <path markerEnd={`url(#tl-head-${k})`} d={`M${X0} ${s.y1} C ${X0 + bulge} ${s.y1}, ${X0 + bulge} ${s.y2}, ${X0 + 3} ${s.y2}`} />
            <circle cx={X0} cy={s.y1} r="2.6" />
          </g>
        );
      })}
    </svg>
  );
}
