import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useWsQuery } from '../../lib/hooks';
import { toast } from '../../stores/ui';
import { portfolioApi, type PortfolioFilter, type TimelineProject } from './portfolioApi';
import {
  dmy, dn, fitRange, iso, mergeMilestones, placeLabel, PX_PER_DAY, slipOf, startOf, statusOf, textW, ticks, TONE, type TStatus, type Zoom,
} from './timelineLayout';
import './timeline.css';

type GroupBy = 'team' | 'group' | 'owner' | 'status' | 'none';
const GROUP_LABEL: Record<GroupBy, string> = { team: 'Team', group: 'Project group', owner: 'Owner', status: 'Status', none: 'None' };
const NAME_W = 242, ROW_H = 44;
const REASONS = ['Waiting on external', 'Scope changed', 'Capacity'];
const first = (s: string | null | undefined) => (s ?? '').split(' ')[0];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

function usePhone() {
  const q = '(max-width: 760px)';
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => { const m = window.matchMedia(q); const on = () => setPhone(m.matches); m.addEventListener('change', on); return () => m.removeEventListener('change', on); }, []);
  return phone;
}

export function TimelineLegend() {
  return (
    <span className="ptl-legend" aria-label="Legend">
      <span><i className="plan" />Planned</span><span><i className="done" />Done so far</span><span><i className="slip" />Slip to forecast</span>
      <span><i className="ms" />Milestone</span><span><i className="today" />Today</span>
    </span>
  );
}

interface Pending { p: TimelineProject; to: string; x: number; y: number }

/**
 * Portfolio › Timeline (design section 8): one bar per project from its planned start to its due date, tinted by status, filled by progress with the
 * % label, a red hatched slip out to the forecast with "+Nd", milestones as violet diamonds and a labelled today line; group rows (team, group, owner,
 * status) with a thin roll-up bar, collapsible. Week / Month / Quarter zoom, and Fit (the default: the range of the data padded to whole months).
 * Hover shows the details and how the forecast was worked out; click opens the project; drag a bar's end (or Alt + ← / →) to re-plan, which asks for
 * a reason and saves through the project's own due-date change. On a phone: a grouped list with mini bars.
 */
export function PortfolioTimeline({ filter, onRange }: { filter: PortfolioFilter; onRange?: (label: string) => void }) {
  const q = useWsQuery(['portfolio', 'timeline', filter], () => portfolioApi.timeline(filter), { placeholderData: (p) => p });
  const phone = usePhone();
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);
  const [zoom, setZoom] = useState<Zoom>('week');
  const [fit, setFit] = useState(true);
  const [group, setGroup] = useState<GroupBy>('team');
  const [statusF, setStatusF] = useState<TStatus | null>(null);
  const [ownerF, setOwnerF] = useState<string | null>(null);
  const [menu, setMenu] = useState<null | 'group' | 'status' | 'owner'>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ id: string; to: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [focus, setFocus] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(896);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const measure = () => setAvail(Math.max(320, el.clientWidth - NAME_W - 2));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure); ro.observe(el); return () => ro.disconnect();
  }, [phone, q.data]);

  const all = useMemo(() => q.data?.projects ?? [], [q.data]);
  const projects = useMemo(() => all.filter((p) => (!statusF || statusOf(p, today) === statusF) && (!ownerF || p.owner === ownerF)), [all, statusF, ownerF, today]);
  const range = useMemo(() => fitRange(projects.length ? projects : all, today), [projects, all, today]);
  const days = range.to - range.from;
  const px = fit ? avail / days : PX_PER_DAY[zoom];
  const W = Math.round(days * px);
  const X = (s: string) => (dn(s) - range.from) * px;
  const tk = useMemo(() => ticks(range.from, range.to, zoom, px), [range, zoom, px]);
  const rangeLabel = `${dmy(iso(range.from))} – ${dmy(iso(range.to - 1))} ${new Date((range.to - 1) * 86_400_000).getUTCFullYear()}`;
  const monthsLabel = `${dmy(iso(range.from)).split(' ')[1]}–${dmy(iso(range.to - 1)).split(' ')[1]}`;
  useEffect(() => { onRange?.(rangeLabel); }, [rangeLabel, onRange]);

  const groups = useMemo(() => {
    const key = (p: TimelineProject) => group === 'team' ? p.team ?? 'No team' : group === 'group' ? p.group ?? 'No group' : group === 'owner' ? p.owner ?? 'No owner' : group === 'status' ? statusOf(p, today) : '';
    const m = new Map<string, TimelineProject[]>();
    for (const p of projects) { const k = key(p); m.set(k, [...(m.get(k) ?? []), p]); }
    return [...m.entries()].sort((a, b) => (a[0].startsWith('No ') ? 1 : 0) - (b[0].startsWith('No ') ? 1 : 0) || a[0].localeCompare(b[0]))
      .map(([name, items]) => ({ name, items: [...items].sort((a, b) => (startOf(a) ?? '9').localeCompare(startOf(b) ?? '9')) }));
  }, [projects, group, today]);
  const rows = useMemo(() => {
    const out: ({ type: 'group'; name: string; items: TimelineProject[] } | { type: 'p'; p: TimelineProject })[] = [];
    for (const g of groups) { if (group !== 'none') out.push({ type: 'group', ...g }); if (group === 'none' || !collapsed.has(g.name)) for (const p of g.items) out.push({ type: 'p', p }); }
    return out;
  }, [groups, group, collapsed]);
  const projRows = rows.flatMap((r, i) => (r.type === 'p' ? [{ p: r.p, i }] : []));
  const dependents = (id: string) => all.filter((x) => x.dependsOn.includes(id)).length;
  const late = projects.filter((p) => statusOf(p, today) === 'Late').length, risk = projects.filter((p) => statusOf(p, today) === 'At risk').length;
  const todayX = X(today);
  const owners = [...new Set(all.map((p) => p.owner).filter((x): x is string => !!x))].sort();

  const save = async (p: TimelineProject, to: string, reason: string | null) => {
    try {
      const res = await portfolioApi.sheetBulk([{ id: p.id, version: p.version, dueDate: to }], reason);
      const row = res.rows[0];
      if (!row?.ok) { toast(row?.error ?? 'The new date could not be saved.', 'error'); return false; }
      toast(`${p.key} re-planned to ${dmy(to)}.`, 'success');
      await q.refetch();
      return true;
    } catch (e) { toast(e instanceof ApiError ? e.message : 'The new date could not be saved.', 'error'); return false; }
  };

  // Drag a bar end: the live tooltip follows, the release asks for the reason.
  const startDrag = (e: ReactPointerEvent<HTMLSpanElement>, p: TimelineProject) => {
    if (!p.due) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.currentTarget; el.setPointerCapture(e.pointerId);
    const x0 = e.clientX; const due0 = dn(p.due);
    let to = p.due;
    const moveH = (ev: PointerEvent) => { to = iso(Math.max(dn(startOf(p) ?? p.due!), due0 + Math.round((ev.clientX - x0) / px))); setDrag({ id: p.id, to }); };
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', moveH); el.removeEventListener('pointerup', up);
      setDrag(null);
      if (to !== p.due) setPending({ p, to, x: X(to), y: ev.clientY });
    };
    el.addEventListener('pointermove', moveH); el.addEventListener('pointerup', up);
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const cur = projRows[Math.min(focus, projRows.length - 1)]?.p;
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocus((f) => Math.min(projRows.length - 1, f + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus((f) => Math.max(0, f - 1)); }
    else if (e.key === 'Enter' && cur) { e.preventDefault(); navigate(`/work/projects/${cur.id}`); }
    else if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && cur?.due) {
      e.preventDefault();
      const base = pending?.p.id === cur.id ? pending.to : cur.due;
      const to = iso(dn(base) + (e.key === 'ArrowRight' ? 1 : -1));
      setPending({ p: cur, to, x: X(to), y: 0 });
    }
  };
  useEffect(() => { const el = box.current?.querySelector<HTMLElement>(`[data-row="${focus}"]`); if (el && box.current?.contains(document.activeElement)) el.focus(); }, [focus]);

  if (q.isLoading) return <p className="muted" role="status">Loading the timeline…</p>;
  if (!q.data || all.length === 0) return <section className="ptl" aria-label="Timeline"><p className="ptl-empty">No projects match.</p></section>;

  const toolbar = (
    <div className="ptl-toolbar" role="toolbar" aria-label="Timeline tools">
      <span className="ptl-rel"><button type="button" className="ptl-btn" aria-expanded={menu === 'group'} onClick={() => setMenu(menu === 'group' ? null : 'group')}>Group: {GROUP_LABEL[group]} ▾</button>
        {menu === 'group' && <Menu label="Group by" onClose={() => setMenu(null)}>{(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => <button key={g} type="button" role="menuitemradio" aria-checked={g === group} className={g === group ? 'on' : ''} onClick={() => { setGroup(g); setMenu(null); }}>{GROUP_LABEL[g]}</button>)}</Menu>}</span>
      <span className="ptl-rel"><button type="button" className={`ptl-chip ${statusF ? 'on' : ''}`} aria-expanded={menu === 'status'} onClick={() => setMenu(menu === 'status' ? null : 'status')}>Status: {statusF ?? 'any'}</button>
        {menu === 'status' && <Menu label="Status" onClose={() => setMenu(null)}>{([null, 'On track', 'At risk', 'Late', 'Done', 'Not started'] as (TStatus | null)[]).map((s) => <button key={s ?? 'any'} type="button" role="menuitemradio" aria-checked={s === statusF} className={s === statusF ? 'on' : ''} onClick={() => { setStatusF(s); setMenu(null); }}>{s ?? 'Any status'}</button>)}</Menu>}</span>
      <span className="ptl-rel"><button type="button" className={`ptl-chip ${ownerF ? 'on' : ''}`} aria-expanded={menu === 'owner'} onClick={() => setMenu(menu === 'owner' ? null : 'owner')}>Owner: {ownerF ? first(ownerF) : 'any'}</button>
        {menu === 'owner' && <Menu label="Owner" onClose={() => setMenu(null)}>{[null, ...owners].map((o) => <button key={o ?? 'any'} type="button" role="menuitemradio" aria-checked={o === ownerF} className={o === ownerF ? 'on' : ''} onClick={() => { setOwnerF(o); setMenu(null); }}>{o ?? 'Anyone'}</button>)}</Menu>}</span>
      <span className="ptl-sp" />
      <TimelineLegend />
      <div className="ptl-seg" role="tablist" aria-label="Zoom">
        {(['week', 'month', 'quarter'] as Zoom[]).map((z) => <button key={z} type="button" role="tab" aria-selected={z === zoom} className={z === zoom ? 'on' : ''} onClick={() => { setZoom(z); setFit(false); }}>{z[0].toUpperCase() + z.slice(1)}</button>)}
      </div>
      <button type="button" className={`ptl-btn fit ${fit ? 'pri' : ''}`} aria-pressed={fit} onClick={() => setFit(true)}>⤢ Fit · {monthsLabel}</button>
    </div>
  );

  if (phone) return <PhoneTimeline groups={groups} today={today} range={range} monthsLabel={monthsLabel} />;

  const hp = hover ? all.find((p) => p.id === hover.id) : null;
  const height = rows.length * ROW_H;
  return (
    <section className="ptl" aria-label="Timeline">
      {toolbar}
      <div className="ptl-frame" ref={box} role="treegrid" aria-label="Projects on the timeline" aria-rowcount={rows.length} onKeyDown={onKey} onMouseLeave={() => setHover(null)}>
        <div className="ptl-head">
          <div className="ptl-name-h" style={{ width: NAME_W }}>Project</div>
          <div className="ptl-scale" style={{ width: W }}>
            {tk.top.map((t) => <div key={`t${t.x}`} className="ptl-tier1" style={{ left: t.x, width: t.w }}>{t.label} <span>{t.sub}</span></div>)}
            {tk.bottom.map((t) => <div key={`b${t.x}`} className={`ptl-tier2 ${zoom === 'quarter' ? 'm' : ''}`} style={{ left: t.x }}>{t.label}</div>)}
            {todayX >= 0 && todayX <= W && <div className="ptl-today-pill" style={{ left: todayX }}>Today {dmy(today)}</div>}
          </div>
        </div>
        <div className="ptl-body">
          <div className="ptl-names" style={{ width: NAME_W }}>
            {rows.map((r, i) => r.type === 'group' ? (
              <div key={`g${r.name}`} role="row" aria-level={1} aria-expanded={!collapsed.has(r.name)} className="ptl-grow">
                <button type="button" className="ptl-tw" aria-label={`${collapsed.has(r.name) ? 'Expand' : 'Collapse'} ${r.name}`}
                  onClick={() => setCollapsed((s) => { const n = new Set(s); if (n.has(r.name)) n.delete(r.name); else n.add(r.name); return n; })}>{collapsed.has(r.name) ? '▸' : '▾'}</button>
                <b>{r.name}</b><span className="ptl-n">{r.items.length}</span><span className="ptl-sp" />
                {r.items.some((p) => statusOf(p, today) === 'Late') && <i className="ptl-dot late" title="Something here is late" aria-label="Something here is late" />}
                {group === 'team' && <TeamFaces items={r.items} />}
              </div>
            ) : (
              <div key={r.p.id} role="row" aria-level={2} tabIndex={projRows.findIndex((x) => x.i === i) === focus ? 0 : -1} data-row={projRows.findIndex((x) => x.i === i)}
                className={`ptl-prow ${hover?.id === r.p.id || drag?.id === r.p.id || pending?.p.id === r.p.id ? 'on' : ''}`}
                onFocus={() => setFocus(projRows.findIndex((x) => x.i === i))} onClick={() => navigate(`/work/projects/${r.p.id}`)}>
                <i className={`ptl-dot ${TONE[statusOf(r.p, today)]}`} title={statusOf(r.p, today)} aria-label={statusOf(r.p, today)} />
                <span className="ptl-pname" title={r.p.name}>{r.p.name}</span>
              </div>
            ))}
          </div>
          <div className="ptl-track" style={{ width: W, height }}>
            {tk.weeks.map((w) => <i key={`w${w}`} className="ptl-wline" style={{ left: (w - range.from) * px }} />)}
            {tk.months.map((m) => <i key={`m${m}`} className="ptl-mline" style={{ left: (m - range.from) * px }} />)}
            {todayX > 0 && <i className="ptl-past" style={{ width: Math.min(W, todayX) }} />}
            {rows.map((r, i) => r.type === 'group'
              ? <GroupBar key={`gb${r.name}`} items={r.items} y={i * ROW_H} X={X} W={W} todayX={todayX} />
              : <Bar key={r.p.id} p={r.p} y={i * ROW_H} X={X} W={W} px={px} today={today} todayX={todayX} labels={zoom === 'quarter'}
                  drag={drag?.id === r.p.id ? drag.to : pending?.p.id === r.p.id ? pending.to : null} dragging={drag?.id === r.p.id}
                  onHover={(x, y) => setHover({ id: r.p.id, x, y })} onOpen={() => navigate(`/work/projects/${r.p.id}`)} onDragStart={(e) => startDrag(e, r.p)} />)}
            {todayX >= 0 && todayX <= W && <i className="ptl-todayline" style={{ left: todayX }} />}
            {hp && !drag && !pending && <HoverCard p={hp} today={today} x={hover!.x} y={hover!.y} W={W} />}
            {pending && <ReplanPop pending={pending} W={W} y={rows.findIndex((r) => r.type === 'p' && r.p.id === pending.p.id) * ROW_H} dependents={dependents(pending.p.id)}
              onCancel={() => setPending(null)} onSave={async (reason) => { const ok = await save(pending.p, pending.to, reason); if (ok) setPending(null); }} />}
          </div>
        </div>
      </div>
      <div className="ptl-foot">
        <span>{plural(projects.length, 'project')} · {late} late · {risk} at risk</span><span>Drag a bar end to re-plan</span><span>Click a bar to open the project</span>
        <span>{fit ? `Range fitted to your data: ${rangeLabel}` : `${rangeLabel} · ${zoom}`}</span>
        {days > 400 && zoom !== 'quarter' && <span className="ptl-hint">Long range: try Quarter</span>}
      </div>
    </section>
  );
}

function TeamFaces({ items }: { items: TimelineProject[] }) {
  // The owners who carry the team's projects (the org tree's team lead arrives with the team-scoped step).
  const names = [...new Set(items.map((p) => p.owner).filter((x): x is string => !!x))].slice(0, 2);
  return <span className="ptl-faces">{names.map((n) => <i key={n} title={n}>{initials(n)}</i>)}</span>;
}

function Menu({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[aria-expanded="true"]')) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [onClose]);
  return <div ref={ref} role="menu" aria-label={label} className="ptl-menu">{children}</div>;
}

function GroupBar({ items, y, X, W, todayX }: { items: TimelineProject[]; y: number; X: (s: string) => number; W: number; todayX: number }) {
  const s = items.map(startOf).filter((x): x is string => !!x).sort()[0];
  const e = items.map((p) => (p.forecast && p.due && p.forecast > p.due ? p.forecast : p.due)).filter((x): x is string => !!x).sort().pop();
  if (!s || !e) return null;
  const pc = Math.round(items.reduce((a, p) => a + p.progress, 0) / Math.max(1, items.length));
  const x0 = X(s), x1 = Math.max(x0 + 6, X(e));
  const label = `${pc}% · ${dmy(s)} – ${dmy(e)}`;
  const lx = placeLabel(x0, x1, W, textW(label), todayX);
  return (
    <>
      <i className="ptl-gbar" style={{ top: y + ROW_H / 2 - 3, left: x0, width: x1 - x0 }} aria-hidden="true"><b style={{ width: `${pc}%` }} /></i>
      <span className="ptl-glabel" style={{ top: y + ROW_H / 2 - 8, left: lx }}>{label}</span>
    </>
  );
}

function Bar({ p, y, X, W, px, today, todayX, labels, drag, dragging, onHover, onOpen, onDragStart }: {
  p: TimelineProject; y: number; X: (s: string) => number; W: number; px: number; today: string; todayX: number; labels: boolean; drag: string | null; dragging: boolean;
  onHover: (x: number, y: number) => void; onOpen: () => void; onDragStart: (e: ReactPointerEvent<HTMLSpanElement>) => void;
}) {
  const st = statusOf(p, today);
  const tone = TONE[st];
  const s = startOf(p);
  if (!s || !p.due) return null;
  const due = drag ?? p.due;
  const x0 = X(s), x1 = Math.max(x0 + 8, X(due) + px);   // the due day is included
  const bw = x1 - x0;
  const slip = drag ? 0 : slipOf(p);
  const fx = slip > 0 && p.forecast ? X(p.forecast) + px : x1;
  const fill = (bw * Math.min(100, p.progress)) / 100;
  const by = y + 11;
  const owner = first(p.owner);
  const after = st === 'Done' ? `Done ${dmy(p.due)}${owner ? ` · ${owner}` : ''}` : slip > 0 ? `forecast ${dmy(p.forecast)}${owner ? ` · ${owner}` : ''}` : `due ${dmy(due)}${owner ? ` · ${owner}` : ''}`;
  const chipW = slip > 0 ? textW(`+${slip}d`) + 10 : 0;
  const end = slip > 0 ? fx : x1;
  const lw = textW(after) + chipW;
  const lx = placeLabel(x0, end, W, lw, todayX);
  const flipped = lx < x0;
  const clipL = x0 < 0, clipR = end > W;
  const ms = mergeMilestones(p.milestones);
  const sentence = `${p.name}, ${p.owner ?? 'no owner'}, ${st.toLowerCase()}, planned ${dmy(s)} to ${dmy(p.due)}${p.forecast ? `, forecast ${dmy(p.forecast)}` : ''}, ${p.progress}% done`;
  const delta = drag && drag !== p.due ? dn(drag) - dn(p.due) : 0;
  return (
    <>
      <div className={`ptl-bar ${tone} ${dragging || drag ? 'drag' : ''}`} role="button" tabIndex={-1} aria-label={sentence} style={{ top: by, left: Math.max(0, x0), width: Math.min(W, x1) - Math.max(0, x0) }}
        onMouseMove={(e) => { const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect(); onHover(e.clientX - r.left, y); }} onClick={onOpen}>
        <i className="ptl-fill" style={{ width: Math.max(0, fill - Math.max(0, -x0)) }} />
        <span className={`ptl-pc ${fill > 40 ? 'in' : ''}`} style={fill > 40 ? undefined : { left: fill + 6 }}>{p.progress}%</span>
        {clipL && <span className="ptl-clip l" aria-hidden="true">‹</span>}
        <span className="ptl-handle" role="slider" aria-label={`Due date of ${p.name}`} aria-valuetext={dmy(due)} aria-valuenow={dn(due)} onPointerDown={onDragStart} onClick={(e) => e.stopPropagation()} />
      </div>
      {slip > 0 && <i className="ptl-slip" style={{ top: by, left: x1, width: Math.max(4, Math.min(W, fx) - x1) }} aria-hidden="true" />}
      {clipR && <span className="ptl-clip r" style={{ top: by }} aria-hidden="true">›</span>}
      {drag && <i className="ptl-ghost" style={{ top: by - 1, left: X(p.due) + px, width: Math.max(0, x1 - X(p.due) - px) }} aria-hidden="true" />}
      {dragging && <span className="ptl-dragtip" style={{ top: by - 32, left: Math.max(0, x1 - 70) }}>Due {dmy(p.due)} → {dmy(due)} · {delta >= 0 ? '+' : ''}{delta}d</span>}
      {ms.map((m, i) => (
        <span key={m.due} className="ptl-ms" style={{ top: by + 5, left: X(m.due) + px / 2 - 6 }} title={`${m.names.join(', ')} · ${dmy(m.due)}`} aria-label={`Milestone ${m.names.join(', ')} ${dmy(m.due)}`}>
          {m.names.length > 1 && <em>{m.names.length}</em>}
          {labels && <span className={`ptl-mslabel ${i % 2 ? 'below' : 'above'}`}>{m.names.join(', ')}</span>}
        </span>
      ))}
      {!dragging && (
        <span className={`ptl-label ${flipped ? 'flip' : ''}`} style={{ top: by + 1, left: lx, width: lw }} data-label={p.id}>
          {slip > 0 && <em className="ptl-slipchip">+{slip}d</em>}{after}
        </span>
      )}
    </>
  );
}

function HoverCard({ p, today, x, y, W }: { p: TimelineProject; today: string; x: number; y: number; W: number }) {
  const st = statusOf(p, today);
  const slip = slipOf(p);
  const s = startOf(p);
  const next = p.milestones.filter((m) => m.due && m.due >= today && m.status !== 'Completed').sort((a, b) => a.due!.localeCompare(b.due!))[0];
  const dur = s && p.due ? dn(p.due) - dn(s) + 1 : null;
  const style: CSSProperties = { top: y + ROW_H - 2, ...(x > W - 330 ? { left: Math.max(0, x - 316) } : { left: x + 16 }) };
  return (
    <div className="ptl-hover" role="tooltip" style={style}>
      <div className="ptl-hover-h"><b>{p.name}</b><span className={`ptl-chipst ${TONE[st]}`}>{st}{slip > 0 ? ` · +${slip}d` : ''}</span></div>
      <dl>
        <dt>Owner</dt><dd>{p.owner ?? '—'}</dd>
        <dt>Planned</dt><dd>{dmy(s)} → {dmy(p.due)}{dur ? ` · ${dur}d` : ''}</dd>
        <dt>Forecast</dt><dd className={slip > 0 ? 'late' : ''}>{p.forecast ? dmy(p.forecast) : 'No forecast'}{p.forecastBasis ? <small>{p.forecastBasis}</small> : null}</dd>
        <dt>Progress</dt><dd>{p.progress}%{p.openTasks != null ? ` · ${p.openTasks} open` : ''}{p.blockedTasks ? ` · ${p.blockedTasks} blocked` : ''}</dd>
        {next && <><dt>Next ◆</dt><dd>{next.name} · {dmy(next.due)}</dd></>}
      </dl>
      {p.lastChange && <div className="ptl-hover-ch">Last change: due {dmy(p.lastChange.previous)} → {dmy(p.lastChange.revised)}{p.lastChange.reason ? ` · “${p.lastChange.reason}”` : ''}{p.lastChange.by ? ` — ${first(p.lastChange.by)}` : ''}, {dmy(p.lastChange.at.slice(0, 10))}</div>}
      <div className="ptl-hover-f">Click to open · drag end to re-plan</div>
    </div>
  );
}

function ReplanPop({ pending, W, y, dependents, onCancel, onSave }: { pending: Pending; W: number; y: number; dependents: number; onCancel: () => void; onSave: (reason: string | null) => Promise<void> }) {
  const { p, to } = pending;
  const days = p.due ? dn(to) - dn(p.due) : 0;
  const later = days > 0;
  const [chip, setChip] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const reason = [chip, text.trim()].filter(Boolean).join(': ');
  const stays = p.milestones.filter((m) => m.due && p.due && m.due <= p.due).slice(-1)[0];
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const style: CSSProperties = { top: y + ROW_H + 4, left: Math.max(0, Math.min(W - 350, pending.x - 150)) };
  return (
    <form className="ptl-pop" role="dialog" aria-label={`Move ${p.name}?`} style={style} onSubmit={async (e) => { e.preventDefault(); if (later && !reason) return; setBusy(true); await onSave(reason || null); setBusy(false); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }}>
      <b className="ptl-pop-t">Move {p.name}?</b>
      <div className="ptl-pop-sub">Due {dmy(p.due)} → <b>{dmy(to)}</b> · {days > 0 ? '+' : ''}{days} day{Math.abs(days) === 1 ? '' : 's'}{stays ? ` · ${stays.name} ◆ stays ${dmy(stays.due)}` : ''}</div>
      <div className="ptl-pop-chips" role="group" aria-label="Common reasons">{REASONS.map((r) => <button key={r} type="button" aria-pressed={chip === r} className={`ptl-chip ${chip === r ? 'on' : ''}`} onClick={() => setChip(chip === r ? null : r)}>{r}</button>)}</div>
      <textarea ref={ref} aria-label="Reason for the new date" rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={480} placeholder={later ? 'Why is it moving? (needed)' : 'Why? (optional)'} />
      <div className="ptl-pop-f"><span>{dependents ? `${plural(dependents, 'dependent project')} shift too` : 'Nothing depends on it'}</span><span className="ptl-sp" />
        <button type="button" className="ptl-btn" onClick={onCancel}>Esc</button><button type="submit" className="ptl-btn pri" disabled={busy || (later && !reason)}>Re-plan</button></div>
    </form>
  );
}

function PhoneTimeline({ groups, today, range, monthsLabel }: { groups: { name: string; items: TimelineProject[] }[]; today: string; range: { from: number; to: number }; monthsLabel: string }) {
  const [lateFirst, setLateFirst] = useState(false);
  const navigate = useNavigate();
  const w = 150, px = w / (range.to - range.from);
  const X = (s: string) => (dn(s) - range.from) * px;
  const n = groups.reduce((a, g) => a + g.items.length, 0);
  return (
    <section className="ptl ptl-phone" aria-label="Timeline">
      <div className="ptl-phone-sub">{plural(n, 'project')} · {monthsLabel}</div>
      <div className="ptl-phone-chips"><span className="ptl-chip on">Team ▾</span><button type="button" className={`ptl-chip ${lateFirst ? 'on' : ''}`} aria-pressed={lateFirst} onClick={() => setLateFirst(!lateFirst)}>Late first</button>
        <span className="ptl-sp" /><span className="ptl-chip red">Today {dmy(today)}</span></div>
      {groups.map((g) => {
        const items = lateFirst ? [...g.items].sort((a, b) => slipOf(b) - slipOf(a)) : g.items;
        return (
          <div key={g.name}>
            <h3 className="ptl-phone-h">{g.name.toUpperCase()}</h3>
            <div className="ptl-card">
              {items.map((p) => {
                const st = statusOf(p, today); const slip = slipOf(p); const s = startOf(p);
                return (
                  <button key={p.id} type="button" className="ptl-prow-ph" onClick={() => navigate(`/work/projects/${p.id}`)}>
                    <span className="ptl-row"><b>{p.name}</b>{slip > 0 ? <em className="ptl-slipchip big">+{slip}d</em> : <span className="ptl-pcs">{p.progress}%</span>}</span>
                    <span className="ptl-row">
                      <span className={`ptl-dates ${slip > 0 ? 'late' : ''}`}>{dmy(s)} → {dmy(slip > 0 ? p.forecast : p.due)}</span>
                      <span className="ptl-mini" aria-hidden="true">
                        {s && p.due && <i className={`ptl-mbar ${TONE[st]}`} style={{ left: X(s), width: Math.max(4, X(p.due) - X(s)) }}><b style={{ width: `${p.progress}%` }} /></i>}
                        {slip > 0 && p.due && p.forecast && <i className="ptl-mslip" style={{ left: X(p.due), width: Math.max(3, X(p.forecast) - X(p.due)) }} />}
                        <i className="ptl-mtoday" style={{ left: X(today) }} />
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}
