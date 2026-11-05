import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { opsApi, taskApi, workspaceApi } from '../../api/endpoints';
import type { TimelineEvent } from '../../api/types';
import { Face } from '../../components/Face';
import { useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { undoToast } from '../talk/flyTask';
import { editError, refreshAfterEdit } from './calendarEdit';
import { DOW3, dateOf, fmtMins, hourOf } from './plannerModel';
import { useTimeline } from './timeline';

const hm = (h: number) => { const m = Math.round(h * 60); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

/**
 * Timeline by person (the Resource view): one row per person you can see (you and your reporting line, from GET /timeline?scope=team),
 * one column per day. Each cell shows what that person has on: meetings, time logged, open work due. Drag a task or ticket chip onto
 * someone else's row to reassign it (optimistic, with Undo); the load bar on each row is the week's booked hours against 40.
 */
export function ResourceView({ week, today, q, tintOf, onOpenLink }: {
  week: string[]; today: string; q: string; tintOf: (p: string | null) => string; onOpenLink: (link: string) => void;
}) {
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx?.user);
  const tl = useTimeline({ from: week[0], to: week[week.length - 1], scope: 'team' });
  const members = useWsQuery(['members'], () => workspaceApi.members(), { staleTime: 5 * 60_000, retry: false });
  const [moved, setMoved] = useState<Record<string, string>>({});
  const [over, setOver] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const nameOf = (id: string) => (id === me?.id ? `${me.displayName} (you)` : members.data?.find((m) => m.userId === id)?.displayName ?? 'Teammate');

  const events = useMemo(() => {
    const k = q.trim().toLowerCase();
    return (tl.data?.events ?? []).filter((e) => ['due', 'meeting', 'time', 'call'].includes(e.type))
      .map((e) => (moved[e.id] ? { ...e, userId: moved[e.id] } : e))
      .filter((e) => !k || `${e.title} ${e.key ?? ''} ${e.projectName ?? ''}`.toLowerCase().includes(k));
  }, [tl.data, moved, q]);
  const rows = useMemo(() => {
    const ids = new Set<string>(me ? [me.id] : []);
    for (const e of events) if (e.userId) ids.add(e.userId);
    return [...ids].map((id) => {
      // Meetings carry no owner on the timeline: they are the caller's own (scope=team lists the caller's meetings), so they sit on your row.
      const mine = events.filter((e) => (e.userId ?? (e.type === 'meeting' || e.type === 'call' ? me?.id : null)) === id);
      const booked = mine.reduce((n, e) => n + (e.type === 'time' ? (e.minutes ?? 0) / 60 : e.end ? (Date.parse(e.end) - Date.parse(e.start)) / 3.6e6 : 0), 0);
      return { id, events: mine, booked };
    }).sort((a, b) => (a.id === me?.id ? -1 : b.id === me?.id ? 1 : nameOf(a.id).localeCompare(nameOf(b.id))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, me?.id, members.data]);

  const reassign = async (e: TimelineEvent, to: string, from: string | null, undo = false) => {
    setMoved((m) => ({ ...m, [e.id]: to }));
    try {
      if (e.sourceType === 'task') {
        const x = (await taskApi.get(e.sourceId)).task;
        await taskApi.update(e.sourceId, { title: x.title, description: x.description, priority: x.priority, assigneeId: to, startDate: x.startDate, dueDate: x.dueDate,
          estimatedHours: x.estimatedHours, labelIds: x.labels.map((l) => l.id), milestoneId: x.milestoneId, statusId: x.statusId, actualHours: x.actualHours, version: x.version,
          dueDateReason: null, dueDateDependency: null });
      } else await opsApi.bulk({ ids: [e.sourceId], assigneeId: to });
      refreshAfterEdit(wid);
      if (undo) { toast('Moved back.', 'info'); return; }
      undoToast(`${e.key ?? e.title} → ${nameOf(to).replace(' (you)', '')}`, () => { if (from) void reassign({ ...e, userId: to }, from, to, true); }, grid.current, 46);
    } catch (err) {
      setMoved((m) => { const n = { ...m }; delete n[e.id]; return n; });
      toast(editError(err, 'It could not be reassigned.'), 'error');
    }
  };
  const down = (ev: ReactPointerEvent, e: TimelineEvent) => {
    if (ev.button !== 0 || !(e.sourceType === 'task' || e.sourceType === 'work')) return;
    const x0 = ev.clientX, y0 = ev.clientY, chip = ev.currentTarget as HTMLElement;
    let target: string | null = null, dragged = false;
    const move = (m: PointerEvent) => {
      if (!dragged && Math.hypot(m.clientX - x0, m.clientY - y0) < 6) return;
      dragged = true;
      chip.style.transform = `translate(${m.clientX - x0}px, ${m.clientY - y0}px)`; chip.classList.add('lift');
      const row = (document.elementFromPoint(m.clientX, m.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-person]');
      target = row?.dataset.person ?? null; setOver(target);
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      chip.style.transform = ''; chip.classList.remove('lift'); setOver(null);
      if (dragged && target && target !== e.userId) void reassign(e, target, e.userId ?? null);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  return (
    <section className="rv" aria-label="Timeline by person" data-testid="resource-view" ref={grid} style={{ ['--cols' as string]: week.length }}>
      <div className="rv-hd"><span>Person</span>{week.map((d) => <span key={d} className={d === today ? 'tdy' : ''}>{DOW3[dateOf(d).getDay()]} <b>{dateOf(d).getDate()}</b></span>)}</div>
      {tl.isLoading && <p className="rv-none">Reading the team’s week…</p>}
      {!tl.isLoading && rows.length === 0 && <p className="rv-none">Nobody to show for this week.</p>}
      {rows.map((r) => (
        <div key={r.id} className={`rv-row${over === r.id ? ' drop' : ''}`} data-person={r.id}>
          <div className="rv-who">
            <Face userId={r.id} name={nameOf(r.id)} className="rv-face" />
            <span><b title={nameOf(r.id)}>{nameOf(r.id)}</b><small>{fmtMins(Math.round(r.booked * 60))} booked</small>
              <i className="rv-load" aria-hidden="true"><em style={{ transform: `scaleX(${Math.min(1, r.booked / 40)})` }} /></i></span>
          </div>
          {week.map((d) => {
            const cell = r.events.filter((e) => e.date === d).sort((a, b) => a.start.localeCompare(b.start));
            return (
              <div key={d} className={`rv-cell${d === today ? ' tdy' : ''}`} data-day={d}>
                {cell.slice(0, 4).map((e) => (
                  <button key={e.id} type="button" className={`rv-chip ${e.type} ${tintOf(e.projectName)}${e.overdue ? ' late' : ''}${e.sourceType === 'task' || e.sourceType === 'work' ? ' movable' : ''}`}
                    data-testid="rv-chip" title={`${e.key ? `${e.key} · ` : ''}${e.title}${e.projectName ? ` · ${e.projectName}` : ''}${e.sourceType === 'task' || e.sourceType === 'work' ? ' · drag to another person to reassign' : ''}`}
                    onPointerDown={(ev) => down(ev, e)} onClick={() => e.link && onOpenLink(e.link)}>
                    {e.type !== 'due' && <small>{hm(hourOf(new Date(e.start)))}</small>}
                    <span>{e.key && e.type === 'due' ? `${e.key} ` : ''}{e.title}</span>
                  </button>
                ))}
                {cell.length > 4 && <span className="rv-more">+{cell.length - 4}</span>}
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}
