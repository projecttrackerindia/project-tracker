import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DndContext, DragOverlay, PointerSensor, TouchSensor, KeyboardSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { Bar, BarChart, CartesianGrid, Line, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ApiError } from '../../api/client';
import { opsApi, workApi, workspaceApi, type WorkFilters } from '../../api/endpoints';
import type { OpsSatisfaction, OpsSettings, Priority, RoutingRule, Triage, WorkTask, WorkTaskStatus } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Avatar, ErrorState, PageLoader, PriorityBadge } from '../../components/ui';
import { Select } from '../../components/Select';
import { formatDate, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useDebounced, useWsQuery } from '../../lib/hooks';
import { WORK_STATUSES } from '../../lib/workLabels';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { SlaChip, SlaSettings } from './Sla';
import './ops.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);
const hours = (v: number | null) => (v === null ? '–' : v < 24 ? `${v}h` : `${Math.round((v / 24) * 10) / 10}d`);

// ------------------------------------------------------------------ board

const COLUMNS: WorkTaskStatus[] = ['ToDo', 'InProgress', 'OnHold', 'Completed'];

/** The queue as a board: drag a card to another column to change its status. Closed work shows only what finished in the last two weeks. */
export function OpsBoard({ filters, onOpen }: { filters: WorkFilters; onOpen: (id: string) => void }) {
  const wid = useWorkspaceId();
  const since = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - 14); return d.toISOString(); }, []);
  const open = useWsQuery(['work', 'board', 'open', filters], () => workApi.list({ ...filters, open: true, status: undefined, page: 1, pageSize: 100 }));
  const done = useWsQuery(['work', 'board', 'done', filters], () => workApi.list({ ...filters, status: 'Completed', open: undefined, page: 1, pageSize: 40, sort: 'created' }));
  const [moved, setMoved] = useState<Record<string, WorkTaskStatus>>({});
  const [dragging, setDragging] = useState<WorkTask | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }), useSensor(KeyboardSensor));
  const all = useMemo(() => [...(open.data?.items ?? []), ...(done.data?.items ?? []).filter((t) => (t.completedAt ?? '') >= since)], [open.data, done.data, since]);
  if (open.isLoading) return <PageLoader />;
  if (open.isError) return <ErrorState error={open.error} retry={() => void open.refetch()} />;
  const statusOf = (t: WorkTask) => moved[t.id] ?? t.status;

  const onEnd = async (e: DragEndEvent) => {
    setDragging(null);
    const t = all.find((x) => x.id === e.active.id);
    const to = e.over?.id as WorkTaskStatus | undefined;
    if (!t || !to || statusOf(t) === to) return;
    if (!t.can.edit) { toast('You can only move work that is assigned to you or that you raised.', 'error'); return; }
    setMoved((m) => ({ ...m, [t.id]: to }));
    try { await workApi.setStatus(t.id, to); toast(`${t.key} → ${WORK_STATUSES.find((s) => s.id === to)?.label}`); void invalidateWorkspace(wid, 'work'); }
    catch (err) { setMoved((m) => { const n = { ...m }; delete n[t.id]; return n; }); toast(errText(err, 'Could not move it.'), 'error'); }
  };

  return (
    <DndContext sensors={sensors} onDragStart={(e) => setDragging(all.find((x) => x.id === e.active.id) ?? null)} onDragEnd={(e) => void onEnd(e)} onDragCancel={() => setDragging(null)}>
      <div className="ops-board">
        {COLUMNS.map((c) => {
          const cards = all.filter((t) => statusOf(t) === c);
          return <Column key={c} status={c} cards={cards} onOpen={onOpen} />;
        })}
      </div>
      <DragOverlay dropAnimation={{ duration: 180 }}>{dragging ? <Card t={dragging} overlay /> : null}</DragOverlay>
    </DndContext>
  );
}

function Column({ status, cards, onOpen }: { status: WorkTaskStatus; cards: WorkTask[]; onOpen: (id: string) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const label = WORK_STATUSES.find((s) => s.id === status)?.label ?? status;
  const breached = cards.filter((t) => t.sla?.state === 'Breached').length;
  return (
    <section ref={setNodeRef} className={`ops-col ${status} ${isOver ? 'over' : ''}`} aria-label={label}>
      <header><span className="ops-col-dot" /><b>{label}</b><em>{cards.length}</em>{breached > 0 && <span className="ops-col-alert" title="Past their service-level target">{breached} late</span>}</header>
      <div className="ops-col-body">
        {cards.length === 0 ? <p className="ops-col-empty">{status === 'Completed' ? 'Nothing finished in the last two weeks' : 'Drop work here'}</p>
          : cards.map((t) => <Draggable key={t.id} t={t} onOpen={onOpen} />)}
      </div>
    </section>
  );
}

function Draggable({ t, onOpen }: { t: WorkTask; onOpen: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: t.id, disabled: !t.can.edit });
  return <div ref={setNodeRef} {...attributes} {...listeners} className={isDragging ? 'ops-ghost' : ''}><Card t={t} onOpen={onOpen} /></div>;
}

function Card({ t, onOpen, overlay }: { t: WorkTask; onOpen?: (id: string) => void; overlay?: boolean }) {
  return (
    <article className={`ops-card p-${t.priority} ${overlay ? 'overlay' : ''}`} onClick={() => onOpen?.(t.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen?.(t.id); }} tabIndex={-1}>
      <div className="ops-card-top"><span className="task-key">{t.key}</span><span className="ops-card-type">{t.workType}</span><PriorityBadge priority={t.priority} /></div>
      <p className="ops-card-title">{t.title}</p>
      <div className="ops-card-foot">
        {t.assignee ? <Avatar name={t.assignee.name} size="sm" userId={t.assignee.id} /> : <span className="ops-unassigned" title="Unassigned"><Icon name="user" size={12} /></span>}
        {t.dueDate && <span className={t.isOverdue ? 'work-late' : 'muted'}><Icon name="calendar" size={11} />{formatDate(t.dueDate)}</span>}
        <span className="ops-card-sla"><SlaChip sla={t.sla} /></span>
      </div>
    </article>
  );
}

// ------------------------------------------------------------------ bulk bar

/** What to do with the work ticked in the queue. */
export function BulkBar({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const wid = useWorkspaceId();
  const members = useWsQuery(['members'], () => workspaceApi.members());
  const [busy, setBusy] = useState(false);
  if (!ids.length) return null;
  const run = async (change: Parameters<typeof opsApi.bulk>[0], label: string) => {
    setBusy(true);
    try {
      const r = await opsApi.bulk({ ...change, ids });
      toast(r.failed.length ? `${label}: ${r.updated} changed, ${r.failed.length} not yours to change.` : `${label}: ${r.updated} changed.`, r.failed.length ? 'error' : undefined);
      void invalidateWorkspace(wid, 'work'); onDone();
    } catch (e) { toast(errText(e, 'Could not change them.'), 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="ops-bulk" role="toolbar" aria-label="Change the selected work">
      <b>{ids.length} selected</b>
      <Select className="select" value="" disabled={busy} aria-label="Set status" onChange={(e) => e.target.value && void run({ ids, status: e.target.value }, 'Status')}>
        <option value="">Status…</option>{WORK_STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </Select>
      <Select className="select" value="" disabled={busy} aria-label="Assign to" onChange={(e) => e.target.value && void run(e.target.value === '-' ? { ids, unassign: true } : { ids, assigneeId: e.target.value }, 'Assignee')}>
        <option value="">Assign…</option><option value="-">Nobody</option>
        {members.data?.filter((m) => m.role !== 'Guest' && m.isActive !== false).map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
      </Select>
      <Select className="select" value="" disabled={busy} aria-label="Set priority" onChange={(e) => e.target.value && void run({ ids, priority: e.target.value }, 'Priority')}>
        <option value="">Priority…</option>{(['Critical', 'High', 'Medium', 'Low'] as Priority[]).map((p) => <option key={p} value={p}>{p}</option>)}
      </Select>
      <label className="ops-bulk-date">Due <input className="input" type="date" disabled={busy} onChange={(e) => e.target.value && void run({ ids, dueDate: e.target.value }, 'Due date')} aria-label="Set due date" /></label>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>Clear</button>
    </div>
  );
}

// ------------------------------------------------------------------ smart triage (in the new work form)

/** As the title is typed: likely type, priority and person (from the workspace's own history) and open work that looks the same. */
export function SmartTriage({ title, description, workTypeId, onApply, onOpen }: {
  title: string; description: string; workTypeId: string; onApply: (t: Partial<{ workTypeId: string; priority: Priority; assigneeId: string }>) => void; onOpen?: (id: string) => void;
}) {
  const t = useDebounced(title.trim(), 500), d = useDebounced(description.trim(), 700);
  const q = useWsQuery(['ops', 'triage', t, d, workTypeId], () => opsApi.triage({ title: t, description: d || null, workTypeId: workTypeId || null }), { enabled: t.length >= 5, staleTime: 60_000 });
  const r: Triage | undefined = q.data;
  if (!r || (!r.workType && !r.priority && !r.assignee && !r.duplicates.length && !r.routed)) return null;
  return (
    <div className="ops-triage" aria-live="polite">
      {r.duplicates.length > 0 && (
        <div className="ops-dupes">
          <Icon name="copy" size={13} /><b>Looks like open work:</b>
          {r.duplicates.map((x) => (
            <button key={x.id} type="button" className="ops-dupe" onClick={() => onOpen?.(x.id)} title={`${x.score}% similar`}>
              <span className="task-key">{x.key}</span>{x.title}{x.assignee && <em> · {x.assignee.name}</em>}
            </button>
          ))}
        </div>
      )}
      <div className="ops-sugs">
        <Icon name="bolt" size={13} />
        {r.workType && r.workTypeId !== workTypeId && <button type="button" className="ops-sug" title={r.typeReason ?? ''} onClick={() => onApply({ workTypeId: r.workTypeId! })}>{r.workType}<Icon name="plus" size={11} /></button>}
        {r.priority && <button type="button" className="ops-sug" title={r.priorityReason ?? ''} onClick={() => onApply({ priority: r.priority! })}>{r.priority} priority<Icon name="plus" size={11} /></button>}
        {r.assignee && <button type="button" className="ops-sug" title={r.assigneeReason ?? ''} onClick={() => onApply({ assigneeId: r.assignee!.id })}>{r.assignee.name}<em>{r.assigneeReason}</em><Icon name="plus" size={11} /></button>}
        {r.routed && <span className="ops-routed">Left unassigned, it goes {r.routed}.</span>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ insights

/** Operations → Insights: service levels and flow, kept with the tool rather than in Reports. */
export function OpsInsights() {
  const [days, setDays] = useState(90);
  const q = useWsQuery(['ops', 'insights', days], () => opsApi.insights(days));
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const d = q.data;
  const weeks = d.weeks.map((w) => ({ label: new Date(`${w.weekStart}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), Created: w.created, Completed: w.completed, Late: w.breached, Compliance: w.compliance === null ? null : Math.round(w.compliance * 100) }));
  const maxAge = Math.max(1, ...d.aging.map((a) => a.count));
  return (
    <div className="ops-ins">
      <div className="ops-ins-head">
        <span className="muted">{d.businessHours ? 'Service levels count business hours only.' : 'Service levels count calendar hours.'}</span>
        <div className="seg" role="group" aria-label="Period">{[30, 90, 180].map((n) => <button key={n} type="button" className={days === n ? 'active' : ''} aria-pressed={days === n} onClick={() => setDays(n)}>{n} days</button>)}</div>
      </div>
      <div className="ops-kpis">
        <Kpi tone="green" label="SLA met" value={pct(d.compliance)} foot="of work finished with a target" />
        <Kpi tone="blue" label="Resolution" value={hours(d.medianResolutionHours)} foot="median, raised to done" />
        <Kpi tone="purple" label="First response" value={d.medianResponseMinutes === null ? '–' : d.medianResponseMinutes < 120 ? `${Math.round(d.medianResponseMinutes)}m` : hours(Math.round(d.medianResponseMinutes / 6) / 10)} foot="median" />
        <Kpi tone="amber" label="Open" value={String(d.open)} foot={`${d.unassigned} unassigned`} />
        <Kpi tone="red" label="Late now" value={String(d.breached)} foot={`${d.atRisk} at risk`} />
        <Kpi tone="teal" label="Throughput" value={`${d.completedInPeriod}`} foot={`done · ${d.createdInPeriod} raised`} />
      </div>
      <div className="ops-ins-grid">
        <div className="card ops-wide">
          <div className="card-head"><div><h3>Week by week</h3><p>Raised against finished, late work, and the share that met its target</p></div></div>
          <div className="card-body" style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={weeks} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-3)' }} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
                <YAxis yAxisId="n" allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--text-3)' }} axisLine={false} tickLine={false} width={30} />
                <YAxis yAxisId="p" orientation="right" domain={[0, 100]} tick={{ fontSize: 11, fill: 'var(--text-3)' }} axisLine={false} tickLine={false} width={34} tickFormatter={(v: number) => `${v}%`} />
                <Tooltip contentStyle={{ background: 'var(--modal-bg)', border: '1px solid var(--modal-border)', borderRadius: 10, fontSize: 12 }} />
                <Bar yAxisId="n" dataKey="Created" fill="#38bdf8" radius={[5, 5, 0, 0]} maxBarSize={18} />
                <Bar yAxisId="n" dataKey="Completed" fill="#34d399" radius={[5, 5, 0, 0]} maxBarSize={18} />
                <Bar yAxisId="n" dataKey="Late" fill="#fb7185" radius={[5, 5, 0, 0]} maxBarSize={18} />
                <Line yAxisId="p" dataKey="Compliance" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><div><h3>Age of open work</h3><p>How long it has been waiting</p></div></div>
          <div className="card-body ops-aging">
            {d.aging.map((a, i) => <div key={a.label}><span>{a.label}</span><i><b style={{ width: `${(a.count / maxAge) * 100}%`, background: ['#34d399', '#38bdf8', '#f59e0b', '#fb7185'][i] }} /></i><em>{a.count}</em></div>)}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><div><h3>By priority</h3><p>Open, late and target met</p></div></div>
          <div className="card-body" style={{ height: 200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={d.byPriority} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
                <XAxis type="number" allowDecimals={false} hide />
                <YAxis type="category" dataKey="name" width={64} tick={{ fontSize: 12, fill: 'var(--text-2)' }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ background: 'var(--modal-bg)', border: '1px solid var(--modal-border)', borderRadius: 10, fontSize: 12 }} />
                <Bar dataKey="open" name="Open" stackId="a" fill="#8b5cf6" maxBarSize={16} />
                <Bar dataKey="breached" name="Late" stackId="a" fill="#fb7185" radius={[0, 5, 5, 0]} maxBarSize={16} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <Breakdown title="By work type" rows={d.byType} />
        <Breakdown title="By person" rows={d.byPerson} />
      </div>
      {d.satisfaction && d.satisfaction.chats > 0 && <Satisfaction s={d.satisfaction} />}
    </div>
  );
}

const STARS = ['#fb7185', '#f97316', '#f59e0b', '#84cc16', '#22c55e'];

/** WhatsApp customers' ratings (1-5 after a chat or its ticket closes), the AI employee's share, and the low ratings worth a call back. */
function Satisfaction({ s }: { s: OpsSatisfaction }) {
  const max = Math.max(1, ...s.distribution);
  const weeks = s.weeks.map((w) => ({ label: new Date(`${w.weekStart}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), Average: w.average, Ratings: w.rated }));
  return (
    <section className="ops-csat" aria-label="Customer satisfaction">
      <h3 className="ops-csat-title"><Icon name="message" size={15} /> WhatsApp customers</h3>
      <div className="ops-csat-kpis">
        <Kpi tone="green" label="Rating" value={s.average === null ? '–' : `${s.average.toFixed(1)} / 5`} foot={`${s.rated} rated of ${s.asked} asked`} />
        <Kpi tone="teal" label="Happy" value={pct(s.satisfied)} foot="rated 4 or 5" />
        <Kpi tone="purple" label="AI answered alone" value={s.chats === 0 ? '–' : `${Math.round((s.aiOnly / s.chats) * 100)}%`} foot={`${s.aiOnly} of ${s.chats} chats`} />
        <Kpi tone="amber" label="Handed to a person" value={String(s.handedOver)} foot={s.handoverReasons.length ? s.handoverReasons.map((r) => `${r.count} ${r.label.toLowerCase()}`).join(' · ') : 'none in this period'} />
      </div>
      <div className="ops-ins-grid">
        <div className="card">
          <div className="card-head"><div><h3>Ratings</h3><p>How many gave each score</p></div></div>
          <div className="card-body ops-stars" role="list" aria-label="Ratings by score">
            {[5, 4, 3, 2, 1].map((n) => (
              <div key={n} role="listitem"><span>{'★'.repeat(n)}</span><i><b style={{ width: `${(s.distribution[n - 1] / max) * 100}%`, background: STARS[n - 1] }} /></i><em>{s.distribution[n - 1]}</em></div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><div><h3>Week by week</h3><p>Average rating</p></div></div>
          <div className="card-body" style={{ height: 200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={weeks} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-3)' }} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
                <YAxis domain={[1, 5]} ticks={[1, 2, 3, 4, 5]} tick={{ fontSize: 11, fill: 'var(--text-3)' }} axisLine={false} tickLine={false} width={24} />
                <Tooltip contentStyle={{ background: 'var(--modal-bg)', border: '1px solid var(--modal-border)', borderRadius: 10, fontSize: 12 }} />
                <Line dataKey="Average" stroke="#22c55e" strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><div><h3>By person</h3><p>Who had the chat when it closed</p></div></div>
          <div className="table-wrap">
            <table className="ops-table ops-table-narrow">
              <thead><tr><th>Name</th><th className="num">Rated</th><th className="num">Average</th></tr></thead>
              <tbody>{s.byPerson.length === 0 ? <tr><td colSpan={3} className="muted">No ratings yet.</td></tr> : s.byPerson.map((p) => (
                <tr key={`${p.name}:${p.id}`}><td>{p.name}</td><td className="num">{p.rated}</td>
                  <td className="num"><span className={`ops-pct ${p.average === null ? '' : p.average >= 4 ? 'good' : p.average >= 3 ? 'ok' : 'bad'}`}>{p.average === null ? '–' : p.average.toFixed(1)}</span></td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><div><h3>Low ratings</h3><p>1 or 2: worth a call back</p></div></div>
          <ul className="ops-low">
            {s.low.length === 0 ? <li className="muted">None in this period.</li> : s.low.map((l) => (
              <li key={l.chatId}>
                <span className="ops-low-score" style={{ background: STARS[l.rating - 1] }}>{l.rating}</span>
                <span className="ops-low-main"><b>{l.contact}</b><small>{timeAgo(l.at)}{l.ticketKey ? ` · ${l.ticketKey}` : ''}{l.with ? ` · with ${l.with}` : ''}</small></span>
                <Link to={`/operations?view=whatsapp&chat=${l.chatId}`} className="btn btn-ghost btn-sm">Open chat</Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Kpi({ tone, label, value, foot }: { tone: string; label: string; value: string; foot: string }) {
  return <div className={`ops-kpi ${tone}`}><span>{label}</span><b>{value}</b><small>{foot}</small></div>;
}

function Breakdown({ title, rows }: { title: string; rows: OpsInsightsRow[] }) {
  return (
    <div className="card">
      <div className="card-head"><div><h3>{title}</h3></div></div>
      <div className="table-wrap">
        <table className="ops-table">
          <thead><tr><th>Name</th><th className="num">Open</th><th className="num">Done</th><th className="num">Late</th><th className="num">SLA met</th><th className="num">Resolution</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={`${r.name}:${r.id}`}><td>{r.name}</td><td className="num">{r.open}</td><td className="num">{r.completed}</td><td className={`num ${r.breached ? 'work-late' : ''}`}>{r.breached}</td>
              <td className="num"><span className={`ops-pct ${r.compliance === null ? '' : r.compliance >= 0.9 ? 'good' : r.compliance >= 0.7 ? 'ok' : 'bad'}`}>{pct(r.compliance)}</span></td><td className="num">{hours(r.medianResolutionHours)}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
type OpsInsightsRow = { name: string; id: string | null; open: number; completed: number; breached: number; compliance: number | null; medianResolutionHours: number | null };

// ------------------------------------------------------------------ settings

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fromTime = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };

/** Operations → Settings: business hours and escalation, who new work goes to, and the service-level targets. */
export function OpsSettingsPanel() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['ops', 'settings'], opsApi.settings);
  const types = useWsQuery(['work', 'types', 'all'], () => workApi.types(true));
  const members = useWsQuery(['members'], () => workspaceApi.members());
  const [form, setForm] = useState<OpsSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) setForm(q.data); }, [q.data]);
  if (q.isLoading || !form) return <PageLoader />;
  const can = form.canManage;
  const people = (members.data ?? []).filter((m) => m.role !== 'Guest' && m.isActive !== false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await opsApi.saveSettings({ businessHoursOnly: form.businessHoursOnly, dayStartMinutes: form.dayStartMinutes, dayEndMinutes: form.dayEndMinutes, workDays: form.workDays, timeZone: form.timeZone, escalateOnBreach: form.escalateOnBreach, escalateToUserId: form.escalateTo?.id ?? null });
      setForm(r); toast('Saved. New and changed work uses these hours.'); void invalidateWorkspace(wid, 'ops');
    } catch (e) { toast(errText(e, 'Could not save.'), 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="ops-settings">
      <div className="card">
        <div className="card-head"><div><h3>Business hours</h3><p>Count service-level targets in working time only, so a ticket raised on Friday evening is not late on Saturday.</p></div></div>
        <div className="card-body ops-form">
          <label className="ops-switch"><input type="checkbox" disabled={!can} checked={form.businessHoursOnly} onChange={(e) => setForm({ ...form, businessHoursOnly: e.target.checked })} /><span>Count business hours only</span></label>
          <div className="ops-row">
            <label>From <input className="input" type="time" disabled={!can || !form.businessHoursOnly} value={toTime(form.dayStartMinutes)} onChange={(e) => setForm({ ...form, dayStartMinutes: fromTime(e.target.value) })} /></label>
            <label>to <input className="input" type="time" disabled={!can || !form.businessHoursOnly} value={toTime(form.dayEndMinutes)} onChange={(e) => setForm({ ...form, dayEndMinutes: fromTime(e.target.value) })} /></label>
            <label>Time zone <input className="input" disabled={!can || !form.businessHoursOnly} value={form.timeZone} onChange={(e) => setForm({ ...form, timeZone: e.target.value })} /></label>
          </div>
          <div className="ops-days" role="group" aria-label="Working days">
            {DAYS.map((d, i) => { const on = form.workDays.includes(i + 1); return (
              <button key={d} type="button" disabled={!can || !form.businessHoursOnly} aria-pressed={on} className={on ? 'on' : ''}
                onClick={() => setForm({ ...form, workDays: on ? form.workDays.filter((x) => x !== i + 1) : [...form.workDays, i + 1].sort() })}>{d}</button>); })}
          </div>
          <h4>Escalation</h4>
          <label className="ops-switch"><input type="checkbox" disabled={!can} checked={form.escalateOnBreach} onChange={(e) => setForm({ ...form, escalateOnBreach: e.target.checked })} /><span>Tell a lead when work misses its resolution target</span></label>
          <Select className="select" disabled={!can || !form.escalateOnBreach} value={form.escalateTo?.id ?? ''} aria-label="Who hears about it"
            onChange={(e) => { const p = people.find((m) => m.userId === e.target.value); setForm({ ...form, escalateTo: p ? { id: p.userId, name: p.displayName } : null }); }}>
            <option value="">Choose a person…</option>{people.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
          </Select>
          {can && <div><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>Save</button></div>}
        </div>
      </div>
      <RoutingRules settings={form} onChange={setForm} types={types.data ?? []} people={people.map((m) => ({ id: m.userId, name: m.displayName }))} />
      <SlaSettings />
    </div>
  );
}

function RoutingRules({ settings, onChange, types, people }: { settings: OpsSettings; onChange: (s: OpsSettings) => void; types: { id: string; name: string }[]; people: { id: string; name: string }[] }) {
  const [editing, setEditing] = useState<{ id: string | null; workTypeId: string; mode: string; members: string[]; escalate: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const can = settings.canManage;
  const edit = (r?: RoutingRule) => setEditing(r ? { id: r.id, workTypeId: r.workTypeId ?? '', mode: r.mode, members: r.members.map((m) => m.id), escalate: r.escalateTo?.id ?? '' } : { id: null, workTypeId: '', mode: 'round_robin', members: [], escalate: '' });
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    const b = { workTypeId: editing.workTypeId || null, mode: editing.mode, memberIds: editing.members, escalateToUserId: editing.escalate || null, enabled: true };
    try { onChange(editing.id ? await opsApi.saveRule(editing.id, b) : await opsApi.addRule(b)); setEditing(null); toast('Routing saved.'); }
    catch (e) { toast(errText(e, 'Could not save the rule.'), 'error'); } finally { setBusy(false); }
  };
  const remove = async (id: string) => { try { onChange(await opsApi.removeRule(id)); } catch (e) { toast(errText(e, 'Could not remove it.'), 'error'); } };
  return (
    <div className="card">
      <div className="card-head">
        <div><h3>Routing</h3><p>Who new work goes to when it is raised without an assignee.</p></div>
        {can && !editing && <button type="button" className="btn btn-ghost btn-sm" onClick={() => edit()}><Icon name="plus" size={14} />Add rule</button>}
      </div>
      <div className="card-body ops-rules">
        {settings.rules.length === 0 && !editing && <p className="muted">No rules yet: new work waits unassigned until someone picks it up.</p>}
        {settings.rules.map((r) => (
          <div key={r.id} className="ops-rule">
            <div><b>{r.workType ?? 'Any other work type'}</b><span>{r.mode === 'least_loaded' ? 'Least open work' : 'Taking turns'} · {r.members.map((m) => m.name).join(', ')}{r.escalateTo ? ` · escalates to ${r.escalateTo.name}` : ''}</span>
              {r.lastAssigned && <small>Last went to {r.lastAssigned.name}</small>}</div>
            {can && <><button type="button" className="btn btn-ghost btn-sm" onClick={() => edit(r)}>Edit</button><button type="button" className="btn-icon" aria-label="Remove rule" onClick={() => void remove(r.id)}><Icon name="trash" size={14} /></button></>}
          </div>
        ))}
        {editing && (
          <div className="ops-rule-form">
            <Select className="select" value={editing.workTypeId} onChange={(e) => setEditing({ ...editing, workTypeId: e.target.value })} aria-label="Work type">
              <option value="">Any other work type</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
            <div className="seg" role="group" aria-label="How">
              {[['round_robin', 'Take turns'], ['least_loaded', 'Least open work']].map(([id, l]) => <button key={id} type="button" className={editing.mode === id ? 'active' : ''} onClick={() => setEditing({ ...editing, mode: id })}>{l}</button>)}
            </div>
            <div className="ops-people">
              {people.map((p) => { const on = editing.members.includes(p.id); return (
                <button key={p.id} type="button" className={on ? 'on' : ''} aria-pressed={on} onClick={() => setEditing({ ...editing, members: on ? editing.members.filter((x) => x !== p.id) : [...editing.members, p.id] })}>
                  <Avatar name={p.name} size="sm" userId={p.id} />{p.name}</button>); })}
            </div>
            <Select className="select" value={editing.escalate} onChange={(e) => setEditing({ ...editing, escalate: e.target.value })} aria-label="Escalate to">
              <option value="">Escalate to the workspace lead</option>{people.map((p) => <option key={p.id} value={p.id}>Escalate to {p.name}</option>)}
            </Select>
            <div className="row" style={{ gap: 8 }}><button type="button" className="btn btn-primary btn-sm" disabled={busy || !editing.members.length} onClick={() => void save()}>Save rule</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button></div>
          </div>
        )}
      </div>
    </div>
  );
}
