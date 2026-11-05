import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { PortfolioSkeleton, usePhone, usePortfolio, useProjectColour, useProjectFilter, useShellMenu } from './PortfolioShell';
import { AuraLine } from '../../components/calm';
import { useClassic } from '../calm/classic';
import { PortfolioPulse } from './PortfolioPulse';
import { portfolioKeys, refreshPortfolio } from './portfolioShared';
import { portfolioApi, type PortfolioFilter, type SheetRow, type TimelineProject } from './portfolioApi';
import {
  dmy, dn, fitRange, iso, mergeMilestones, placeLabel, PX_PER_DAY, slipOf, startOf, statusOf, textW, ticks, TONE, type Zoom,
} from './timelineLayout';
import './timeline.css';

type GroupBy = 'team' | 'group' | 'owner' | 'status' | 'none';
const GROUP_LABEL: Record<GroupBy, string> = { team: 'Team', group: 'Project group', owner: 'Owner', status: 'Status', none: 'None' };
const NAME_W = 242, ROW_H = 44;
const REASONS = ['Waiting on external', 'Scope changed', 'Capacity'];
const first = (s: string | null | undefined) => (s ?? '').split(' ')[0];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');


export function TimelineLegend() {
  return (
    <span className="ptl-legend" aria-label="Legend">
      <span><i className="plan" />Planned</span><span><i className="done" />Done so far</span><span><i className="risk" />At risk</span><span><i className="slip" />Slip to forecast</span>
      <span><i className="ms" />Milestone</span><span><i className="today" />Today</span>
    </span>
  );
}

interface Pending { p: TimelineProject; to: string; x: number; y: number; /** a whole-bar move also moves the start */ start?: string }

/**
 * Portfolio › Timeline (design section 8): one bar per project from its planned start to its due date, in the project's one colour (status is the bar's style and a word), filled by progress with the
 * % label, a red hatched slip out to the forecast with "+Nd", milestones as violet diamonds and a labelled today line; group rows (team, group, owner,
 * status) with a thin roll-up bar, collapsible. Week / Month / Quarter zoom, and Fit (the default: the range of the data padded to whole months).
 * Hover shows the details and how the forecast was worked out; click opens the project; drag a bar's end (or Alt + ← / →) to re-plan, which asks for
 * a reason and saves through the project's own due-date change. On a phone: a grouped list with mini bars.
 */
export function PortfolioTimeline({ filter, onRange }: { filter: PortfolioFilter; onRange?: (label: string) => void }) {
  // The Board's key too: one cached copy, refreshed by an edit on any tab.
  const q = useWsQuery(portfolioKeys.timeline(filter), () => portfolioApi.timeline(filter), { placeholderData: (p) => p });
  const wid = useWorkspaceId();
  const passes = useProjectFilter();
  const colourOf = useProjectColour();
  const phone = usePhone();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // The calm lanes (demo shot 14) are the Timeline; ?classic=1 keeps the full Gantt with grouping, zoom tiers and hover cards.
  const classic = useClassic();
  void params;
  const { work } = usePortfolio();
  const [calmWeeks, setCalmWeeks] = useState<6 | 14>(6);
  const lanesRef = useRef<HTMLDivElement>(null);
  const today = new Date().toISOString().slice(0, 10);
  const [zoom, setZoom] = useState<Zoom>('week');
  const [fit, setFit] = useState(true);
  const [group, setGroup] = useState<GroupBy>('none');
  const [menu, setMenu] = useState<null | 'group'>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ id: string; to: string; start?: string } | null>(null);
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
  // Owner, status, dates, project, colour and text: the shell's one field (in the address), the same on every tab.
  const projects = useMemo(() => all.filter((p) => passes({ id: p.id, name: p.name, key: p.key, ownerId: p.ownerId, owner: p.owner, health: p.health, due: p.due })), [all, passes]);
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

  const save = async (p: TimelineProject, to: string, reason: string | null, start?: string) => {
    try {
      const res = await portfolioApi.sheetBulk([{ id: p.id, version: p.version, dueDate: to, ...(start ? { startDate: start } : {}) }], reason);
      const row = res.rows[0];
      if (!row?.ok) { toast(row?.error ?? 'The new date could not be saved.', 'error'); return false; }
      toast(`${p.key} re-planned to ${dmy(to)}.`, 'success');
      // Every tab: the Board's cards and the Plan sheet's project row show the new date without a reload.
      await refreshPortfolio(wid);
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
  // Drag the whole bar (design: "Drag a bar to move it; dependents ripple"): start and due move together; past 4px it is a drag, not a click.
  const moved = useRef(false);
  const startMove = (e: ReactPointerEvent<HTMLDivElement>, p: TimelineProject) => {
    const s0 = startOf(p);
    if (!p.due || !s0 || e.button !== 0) return;
    const el = e.currentTarget; const x0 = e.clientX; const due0 = dn(p.due), st0 = dn(s0);
    let d = 0; moved.current = false;
    const moveH = (ev: PointerEvent) => {
      if (!moved.current && Math.abs(ev.clientX - x0) < 4) return;
      if (!moved.current) { moved.current = true; try { el.setPointerCapture(ev.pointerId); } catch { /* the pointer already left */ } }
      d = Math.round((ev.clientX - x0) / px); setDrag({ id: p.id, to: iso(due0 + d), start: iso(st0 + d) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', moveH); window.removeEventListener('pointerup', up);
      if (!moved.current) return;
      setDrag(null);
      if (d !== 0) setPending({ p, to: iso(due0 + d), start: iso(st0 + d), x: X(iso(due0 + d)), y: ev.clientY });
    };
    window.addEventListener('pointermove', moveH); window.addEventListener('pointerup', up);
  };
  // Ripple: while a bar moves later, every project that depends on it (and on those, in turn) slides by the same days.
  const live = drag ?? (pending ? { id: pending.p.id, to: pending.to } : null);
  const ripple = useMemo(() => {
    const m = new Map<string, number>();
    const src = live ? all.find((x) => x.id === live.id) : null;
    const d = src?.due && live ? dn(live.to) - dn(src.due) : 0;
    if (!src || d <= 0) return m;
    const q = [src.id];
    while (q.length) { const id = q.shift()!; for (const x of all) if ((x.dependsOn ?? []).includes(id) && !m.has(x.id) && x.id !== src.id) { m.set(x.id, d); q.push(x.id); } }
    return m;
  }, [live, all]);

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

  // The calm Timeline (demo shot 14): no tool bar; grouping and Fit live in ⋯, the zoom is the Aura line's links.
  useShellMenu([
    ...(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => ({ label: `Group by ${GROUP_LABEL[g].toLowerCase()}`, icon: 'list' as const, hint: g === group ? 'Shown now' : undefined, onSelect: () => setGroup(g) })),
    { label: `Fit to the data · ${monthsLabel}`, icon: 'search' as const, onSelect: () => setFit(true) },
  ]);
  const toolbar = null;
  void menu; void setMenu;
  if (q.isLoading) return <PortfolioSkeleton label="Loading the timeline" />;
  if (!q.data || projects.length === 0) return <section className="ptl" aria-label="Timeline"><p className="ptl-empty">No projects match.</p></section>;


  if (phone) return <div className="ptl ptl-phonewrap"><PhoneTimeline groups={groups} today={today} range={range} monthsLabel={monthsLabel} colourOf={colourOf} /><PortfolioPulse projects={projects} today={today} kinds={['coming', 'attention']} /></div>;

  if (!classic) return (
    <CalmLanes projects={projects} work={work} today={today} weeks={calmWeeks} setWeeks={setCalmWeeks} colourOf={colourOf} lanesRef={lanesRef}
      drag={drag} setDrag={setDrag} pending={pending} setPending={setPending} ripple={ripple} dependents={dependents} save={save} navigate={navigate} />
  );

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
                {(() => { const n = r.items.filter((p) => statusOf(p, today) === 'Late').length; return n > 0 && <span className="ptl-gflag">{n} late</span>; })()}
                {group === 'team' && <TeamFaces items={r.items} />}
              </div>
            ) : (
              <div key={r.p.id} role="row" aria-level={2} tabIndex={projRows.findIndex((x) => x.i === i) === focus ? 0 : -1} data-row={projRows.findIndex((x) => x.i === i)}
                className={`ptl-prow ${hover?.id === r.p.id || drag?.id === r.p.id || pending?.p.id === r.p.id ? 'on' : ''}`}
                onFocus={() => setFocus(projRows.findIndex((x) => x.i === i))} onClick={() => navigate(`/work/projects/${r.p.id}`)}>
                <i className={`ps4-sq pc-${colourOf(r.p.id)}`} aria-hidden="true" />
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
              : <Bar key={r.p.id} p={r.p} colour={colourOf(r.p.id)} y={i * ROW_H} X={X} W={W} px={px} today={today} todayX={todayX} labels={zoom === 'quarter'}
                  drag={drag?.id === r.p.id ? drag.to : pending?.p.id === r.p.id ? pending.to : null} dragging={drag?.id === r.p.id}
                  dragStart={drag?.id === r.p.id ? drag.start ?? null : pending?.p.id === r.p.id ? pending.start ?? null : null} shift={(ripple.get(r.p.id) ?? 0) * px}
                  onHover={(x, y) => setHover({ id: r.p.id, x, y })} onOpen={() => { if (!moved.current) navigate(`/work/projects/${r.p.id}`); moved.current = false; }}
                  onDragStart={(e) => startDrag(e, r.p)} onMoveStart={(e) => startMove(e, r.p)} />)}
            {todayX >= 0 && todayX <= W && <i className="ptl-todayline" style={{ left: todayX }} />}
            {hp && !drag && !pending && <HoverCard p={hp} today={today} x={hover!.x} y={hover!.y} W={W} />}
            {pending && <ReplanPop pending={pending} W={W} y={rows.findIndex((r) => r.type === 'p' && r.p.id === pending.p.id) * ROW_H} dependents={dependents(pending.p.id)}
              onCancel={() => setPending(null)} onSave={async (reason) => { const ok = await save(pending.p, pending.to, reason, pending.start); if (ok) setPending(null); }} />}
            {ripple.size > 0 && <span className="ptl-ripnote" role="status">{ripple.size} dependent{ripple.size === 1 ? '' : 's'} ripple +{[...ripple.values()][0]}d</span>}
          </div>
        </div>
      </div>
      <div className="ptl-aura">
        <AuraLine text={<>Drag a bar to move it; dependents ripple. {plural(projects.length, 'project')} · {late} late · {risk} at risk.</>} />
        <span className="ptl-zoom" role="group" aria-label="Zoom">{(['week', 'month', 'quarter'] as Zoom[]).map((z) => <button key={z} type="button" aria-pressed={!fit && z === zoom} onClick={() => { setZoom(z); setFit(false); }}>{z === 'week' ? '6 weeks' : z === 'month' ? '14 weeks' : 'Quarters'}</button>)}
          <button type="button" aria-pressed={fit} onClick={() => setFit(true)}>Fit</button></span>
      </div>
      {/* What is coming and what needs attention, under the frame, so the page has no empty band. */}
      <PortfolioPulse projects={projects} today={today} kinds={['coming', 'attention', 'months']} />
    </section>
  );
}

function TeamFaces({ items }: { items: TimelineProject[] }) {
  // The owners who carry the team's projects (the org tree's team lead arrives with the team-scoped step).
  const names = [...new Set(items.map((p) => p.owner).filter((x): x is string => !!x))].slice(0, 2);
  return <span className="ptl-faces">{names.map((n) => <i key={n} title={n}>{initials(n)}</i>)}</span>;
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

function Bar({ p, colour, y, X, W, px, today, todayX, labels, drag, dragging, dragStart, shift, onHover, onOpen, onDragStart, onMoveStart }: {
  p: TimelineProject; colour: string; y: number; X: (s: string) => number; W: number; px: number; today: string; todayX: number; labels: boolean; drag: string | null; dragging: boolean;
  dragStart: string | null; shift: number;
  onHover: (x: number, y: number) => void; onOpen: () => void; onDragStart: (e: ReactPointerEvent<HTMLSpanElement>) => void; onMoveStart: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const st = statusOf(p, today);
  const tone = TONE[st];
  const s = dragStart ?? startOf(p);
  if (!s || !p.due) return null;
  const due = drag ?? p.due;
  const x0 = X(s), x1 = Math.max(x0 + 8, X(due) + px);   // the due day is included
  const bw = x1 - x0;
  const slip = drag ? 0 : slipOf(p);
  const fx = slip > 0 && p.forecast ? X(p.forecast) + px : x1;
  const fill = (bw * Math.min(100, p.progress)) / 100;
  const by = y + 11;
  const owner = first(p.owner);
  // The bar is the project's colour; the status is its style (dashed when at risk, the slip hatched when late) and a word in the label.
  const word = st === 'Late' ? 'Late · ' : st === 'At risk' ? 'At risk · ' : '';
  const after = word + (st === 'Done' ? `Done ${dmy(p.due)}${owner ? ` · ${owner}` : ''}` : slip > 0 ? `forecast ${dmy(p.forecast)}${owner ? ` · ${owner}` : ''}` : `due ${dmy(due)}${owner ? ` · ${owner}` : ''}`);
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
    <div className={`ptl-rip ${shift ? 'on' : ''}`} style={shift ? { transform: `translateX(${shift}px)` } : undefined}>
      <div className={`ptl-bar pc-${colour} ${tone} ${dragging || drag ? 'drag' : ''}`} onPointerDown={onMoveStart} role="button" tabIndex={-1} aria-label={sentence} style={{ top: by, left: Math.max(0, x0), width: Math.min(W, x1) - Math.max(0, x0) }}
        onMouseMove={(e) => { const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect(); onHover(e.clientX - r.left, y); }} onClick={onOpen}>
        <i className="ptl-fill" style={{ width: Math.max(0, fill - Math.max(0, -x0)) }} />
        <span className={`ptl-pc ${fill > 40 ? 'in' : ''}`} style={fill > 40 ? undefined : { left: fill + 6 }}>{p.progress}%</span>
        {clipL && <span className="ptl-clip l" aria-hidden="true">‹</span>}
        <span className="ptl-handle" role="slider" aria-label={`Due date of ${p.name}`} aria-valuetext={dmy(due)} aria-valuenow={dn(due)} onPointerDown={onDragStart} onClick={(e) => e.stopPropagation()} />
      </div>
      {/* The original plan as a ghost bar under the current one, when the due date was extended. */}
      {p.originalDue && p.due && p.originalDue < p.due && <i className="ptl-orig" data-testid="timeline-ghost" title={`Original plan: due ${dmy(p.originalDue)}`} style={{ top: by + 24, left: Math.max(0, x0), width: Math.max(4, Math.min(W, X(p.originalDue) + px) - Math.max(0, x0)) }} aria-hidden="true" />}
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
          {slip > 0 && <em className="ptl-slipchip">+{slip}d</em>}{word && <b className={`ptl-st ${tone}`}>{word.slice(0, -3)}</b>}{word ? after.slice(word.length - 3) : after}
        </span>
      )}
    </div>
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

function PhoneTimeline({ groups, today, range, monthsLabel, colourOf }: { groups: { name: string; items: TimelineProject[] }[]; today: string; range: { from: number; to: number }; monthsLabel: string; colourOf: (id: string) => string }) {
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
                    <span className="ptl-row"><b><i className={`ps4-sq pc-${colourOf(p.id)}`} aria-hidden="true" /> {p.name}</b>{slip > 0 ? <em className="ptl-slipchip big">+{slip}d</em> : <span className="ptl-pcs">{p.progress}%</span>}</span>
                    <span className="ptl-row">
                      <span className={`ptl-dates ${slip > 0 ? 'late' : ''}`}>{dmy(s)} → {dmy(slip > 0 ? p.forecast : p.due)}{(st === 'Late' || st === 'At risk') && <> · <b className={`ptl-st ${TONE[st]}`}>{st}</b></>}</span>
                      <span className="ptl-mini" aria-hidden="true">
                        {s && p.due && <i className={`ptl-mbar pc-${colourOf(p.id)} ${TONE[st]}`} style={{ left: X(s), width: Math.max(4, X(p.due) - X(s)) }}><b style={{ width: `${p.progress}%` }} /></i>}
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

interface Seg { name: string; start: string; due: string }
/** A project's phases for its lane: the stages its tasks sit in, else its top-level tasks that have sub-tasks, else the project itself. */
function phasesOf(p: TimelineProject, work: SheetRow[]): Seg[] {
  const rows = work.filter((r) => r.projectId === p.id && r.kind !== 'project' && r.kind !== 'meeting');
  const span = (xs: SheetRow[]) => {
    const s = xs.map((r) => r.start ?? r.due).filter((x): x is string => !!x).sort()[0];
    const e = xs.map((r) => r.due ?? r.start).filter((x): x is string => !!x).sort().pop();
    return s && e ? { start: s.slice(0, 10), due: e.slice(0, 10) } : null;
  };
  const out: Seg[] = [];
  const byStage = new Map<string, SheetRow[]>();
  for (const r of rows) if (r.stage) byStage.set(r.stage, [...(byStage.get(r.stage) ?? []), r]);
  if (byStage.size > 0) for (const [name, xs] of byStage) { const sp = span(xs); if (sp) out.push({ name, ...sp }); }
  else {
    const parents = rows.filter((r) => !r.parentId && rows.some((c) => c.parentId === r.id));
    for (const ph of parents) { const sp = span([ph, ...rows.filter((c) => c.parentId === ph.id)]); if (sp) out.push({ name: ph.title, ...sp }); }
  }
  const s0 = startOf(p);
  if (out.length === 0 && s0 && p.due) out.push({ name: p.name, start: s0, due: p.due });
  return out.sort((a, b) => a.start.localeCompare(b.start)).slice(0, 6);
}

/**
 * Portfolio › Timeline, calm (demo shot 14): one lane per project with its phases as soft tinted blocks, a Milestones lane, the red now line, and
 * the Aura line with the 6 / 14 week links. Drag a lane's blocks to move the project; its dependents ripple, then the reason pop asks and saves.
 */
function CalmLanes({ projects, work, today, weeks, setWeeks, colourOf, lanesRef, drag, setDrag, pending, setPending, ripple, dependents, save, navigate }: {
  projects: TimelineProject[]; work: SheetRow[]; today: string; weeks: 6 | 14; setWeeks: (w: 6 | 14) => void; colourOf: (id: string) => string;
  lanesRef: React.RefObject<HTMLDivElement | null>; drag: { id: string; to: string; start?: string } | null; setDrag: (d: { id: string; to: string; start?: string } | null) => void;
  pending: Pending | null; setPending: (p: Pending | null) => void; ripple: Map<string, number>; dependents: (id: string) => number;
  save: (p: TimelineProject, to: string, reason: string | null, start?: string) => Promise<boolean>; navigate: (to: string) => void;
}) {
  const t = dn(today);
  const from = t - ((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7) - 7;   // the Monday of last week
  const days = weeks * 7, to = from + days;
  const pct = (d: number) => `${((d - from) / days) * 100}%`;
  const ticksAt = Array.from({ length: weeks === 6 ? 6 : 7 }, (_, i) => from + i * (weeks === 6 ? 7 : 14));
  const [laneW, setLaneW] = useState(800);
  useEffect(() => {
    const el = lanesRef.current; if (!el) return;
    const m = () => setLaneW(Math.max(200, el.clientWidth)); m();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(m); ro.observe(el); return () => ro.disconnect();
  }, [lanesRef]);
  const pxDay = laneW / days;
  const moved = useRef(false);
  const startMove = (e: ReactPointerEvent<HTMLDivElement>, p: TimelineProject) => {
    const s0 = startOf(p);
    if (!p.due || !s0 || e.button !== 0) return;
    const el = e.currentTarget; const x0 = e.clientX; const due0 = dn(p.due), st0 = dn(s0);
    let d = 0; moved.current = false;
    const moveH = (ev: PointerEvent) => {
      if (!moved.current && Math.abs(ev.clientX - x0) < 4) return;
      if (!moved.current) { moved.current = true; try { el.setPointerCapture(ev.pointerId); } catch { /* the pointer already left */ } }
      d = Math.round((ev.clientX - x0) / pxDay); setDrag({ id: p.id, to: iso(due0 + d), start: iso(st0 + d) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', moveH); window.removeEventListener('pointerup', up);
      if (!moved.current) return;
      setDrag(null);
      if (d !== 0) setPending({ p, to: iso(due0 + d), start: iso(st0 + d), x: ((due0 + d - from) / days) * laneW, y: ev.clientY });
    };
    window.addEventListener('pointermove', moveH); window.addEventListener('pointerup', up);
  };
  const ms = projects.flatMap((p) => mergeMilestones(p.milestones).map((m) => ({ ...m, pid: p.id }))).filter((m) => dn(m.due) >= from && dn(m.due) < to);
  const pendIdx = pending ? projects.findIndex((p) => p.id === pending.p.id) : -1;
  return (
    <section className="ptl ctl" aria-label="Timeline">
      <div className="ctl-pane">
        <div className="ctl-scale" aria-hidden="true">{ticksAt.map((d) => <span key={d} style={{ left: pct(d) }}>{dmy(iso(d)).split(' ').reverse().join(' ')}</span>)}</div>
        <div className="ctl-body">
          {projects.map((p) => {
            const live = drag?.id === p.id ? drag : pending?.p.id === p.id ? { to: pending.to, start: pending.start } : null;
            const shiftD = live && p.due ? dn(live.to) - dn(p.due) : (ripple.get(p.id) ?? 0);
            const segs = phasesOf(p, work);
            const st = statusOf(p, today);
            return (
              <div key={p.id} className="ctl-lane">
                <button type="button" className={`ctl-name pc-${colourOf(p.id)}`} onClick={() => navigate(`/work/projects/${p.id}`)} title={p.name}><i aria-hidden="true" />{p.name}</button>
                <div className={`ctl-track ptl-rip ${ripple.has(p.id) ? 'on' : ''}`} ref={p === projects[0] ? lanesRef : undefined}
                  style={shiftD ? { transform: `translateX(${shiftD * pxDay}px)` } : undefined}>
                  <div className={`ptl-bar ctl-hit pc-${colourOf(p.id)} ${live ? 'drag' : ''}`} role="button" tabIndex={0}
                    aria-label={`${p.name}, ${st.toLowerCase()}, ${dmy(startOf(p))} to ${dmy(p.due)}, ${p.progress}% done`}
                    onPointerDown={(e) => startMove(e, p)} onClick={() => { if (!moved.current) navigate(`/work/projects/${p.id}`); moved.current = false; }}
                    onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/work/projects/${p.id}`); }}
                    style={(() => { const s = segs[0]?.start, e = segs.at(-1)?.due; if (!s || !e) return { display: 'none' };
                      const a = Math.max(from, dn(s)), b = Math.min(to, dn(e) + 1); return b <= a ? { display: 'none' } : { left: pct(a), width: `${((b - a) / days) * 100}%` }; })()} />
                  {segs.map((g) => {
                    const a = Math.max(from, dn(g.start)), b = Math.min(to, dn(g.due) + 1);
                    if (b <= a) return null;
                    return <span key={g.name + g.start} className={`ctl-seg pc-${colourOf(p.id)} ${st === 'Late' ? 'late' : st === 'At risk' ? 'risk' : ''}`} style={{ left: pct(a), width: `calc(${((b - a) / days) * 100}% - 4px)` }}>{g.name}</span>;
                  })}
                </div>
              </div>
            );
          })}
          <div className="ctl-lane ctl-ms">
            <span className="ctl-name muted">Milestones</span>
            <div className="ctl-track">{ms.map((m, i) => <span key={`${m.pid}${m.due}`} className={`ctl-msi pc-${colourOf(m.pid)}`} style={{ left: pct(dn(m.due)), top: 8 + (i % 2) * 26 }} title={`${m.names.join(', ')} · ${dmy(m.due)}`}><i aria-hidden="true" />{m.names.join(', ')}</span>)}</div>
          </div>
          <i className="ctl-now" style={{ left: `calc(var(--ctl-name) + (100% - var(--ctl-name)) * ${(t - from) / days})` }} aria-hidden="true" />
          {pending && <div className="ctl-popwrap" style={{ top: Math.max(0, pendIdx) * 0 }}>
            <ReplanPop pending={pending} W={laneW} y={0} dependents={dependents(pending.p.id)} onCancel={() => setPending(null)}
              onSave={async (reason) => { const ok = await save(pending.p, pending.to, reason, pending.start); if (ok) setPending(null); }} />
          </div>}
          {ripple.size > 0 && <span className="ptl-ripnote" role="status">{ripple.size} dependent{ripple.size === 1 ? '' : 's'} ripple +{[...ripple.values()][0]}d</span>}
        </div>
        <div className="ctl-aura">
          <AuraLine text={<>Drag a bar to move it; dependents ripple.</>} />
          <span className="ptl-zoom" role="group" aria-label="Zoom">
            <button type="button" aria-pressed={weeks === 6} onClick={() => setWeeks(6)}>6 weeks</button>
            <button type="button" aria-pressed={weeks === 14} onClick={() => setWeeks(14)}>14 weeks</button>
          </span>
        </div>
      </div>
    </section>
  );
}
