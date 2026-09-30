import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react';
import { Icon, type IconName } from './Icon';

/*
 * The left-hand panel on auth pages (hidden below the breakpoint in auth.css, where the card alone fills the screen).
 * Purely decorative: a live, self-running preview of what the product does rather than a static screenshot. A sprint
 * board moves its own cards: the top "In progress" card's bar fills, it flies to Done, the next To-do card is pulled
 * in, and the sprint ring, the activity feed and the running timer all react to that same move. When the sprint is
 * finished it says so, then a new one starts. Everything is fictional sample data; nothing here reads the API.
 */

type Tag = 'Design' | 'Backend' | 'Frontend' | 'QA' | 'Content';
interface Person { initials: string; name: string; color: string }
interface Task { id: number; title: string; tag: Tag; who: Person; pct: number }
interface ActivityEvent { id: number; kind: 'done' | 'sprint'; who?: Person; title: string; fresh: boolean }
interface Sim { sprint: number; todo: Task[]; doing: Task[]; done: Task[]; flying: number[]; landed: number | null; complete: boolean; event: ActivityEvent }

const PEOPLE: Person[] = [
  { initials: 'AS', name: 'Asha', color: '#8b5cf6' },
  { initials: 'RV', name: 'Ravi', color: '#0ea5e9' },
  { initials: 'MK', name: 'Meera', color: '#ec4899' },
  { initials: 'JD', name: 'Jordan', color: '#f59e0b' },
  { initials: 'NK', name: 'Nikhil', color: '#10b981' },
];
const POOL: [string, Tag][] = [
  ['Checkout flow QA', 'QA'], ['Pricing page copy', 'Content'], ['API rate limits', 'Backend'], ['Onboarding emails', 'Content'],
  ['Mobile nav polish', 'Frontend'], ['Invoice export', 'Backend'], ['Dark mode audit', 'Design'], ['Release notes', 'Content'],
  ['SSO integration', 'Backend'], ['Dashboard charts', 'Frontend'], ['Empty states', 'Design'], ['Load testing', 'QA'],
  ['Search filters', 'Frontend'], ['Brand refresh', 'Design'], ['Webhook retries', 'Backend'], ['Help center', 'Content'],
];
const SPRINT_SIZE = 12;
const FIRST_SPRINT = 14;
/** How long each card spends finishing before it moves, and how long the sprint-complete moment holds. */
const STEP_MS = 3000;
const COMPLETE_HOLD_MS = 4200;
const FLY_MS = 950;
const VISIBLE_SLOTS = 3;

function makeSprint(n: number): Sim {
  const tasks: Task[] = Array.from({ length: SPRINT_SIZE }, (_, i) => {
    const [title, tag] = POOL[(n * 5 + i) % POOL.length];
    return { id: n * 100 + i, title, tag, who: PEOPLE[(n + i) % PEOPLE.length], pct: 28 + ((i * 37) % 50) };
  });
  const lastDone = tasks[7];
  return {
    sprint: n, todo: tasks.slice(0, 4), doing: tasks.slice(4, 7), done: tasks.slice(7), flying: [], landed: null, complete: false,
    event: { id: lastDone.id, kind: 'done', who: lastDone.who, title: lastDone.title, fresh: false },
  };
}

function reducer(s: Sim, action: 'advance' | 'reset' | 'settle'): Sim {
  if (action === 'reset') return makeSprint(s.sprint + 1);
  if (action === 'settle') return { ...s, flying: [] };
  const [moved, ...rest] = s.doing;
  if (!moved) return { ...s, complete: true, flying: [], event: { id: -s.sprint, kind: 'sprint', title: `Sprint ${s.sprint}`, fresh: true } };
  const [pulled, ...todo] = s.todo;
  return {
    ...s, todo, doing: pulled ? [...rest, pulled] : rest, done: [moved, ...s.done],
    flying: pulled ? [moved.id, pulled.id] : [moved.id], landed: moved.id,
    event: { id: moved.id, kind: 'done', who: moved.who, title: moved.title, fresh: true },
  };
}

function useReducedMotion() {
  return useMemo(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
}

/** Eases a displayed number toward `value` so the percentage counts up instead of jumping. */
function useCountUp(value: number, ms = 700) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const v = a + (value - a) * (1 - Math.pow(1 - t, 3));
      from.current = v;
      setShown(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return Math.round(shown);
}

/** A running time-tracking timer for the task currently being finished; restarts when that task changes. */
function LiveTimer({ task }: { task: string }) {
  const base = useMemo(() => 600 + ([...task].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 3000, 7)), [task]);
  const [secs, setSecs] = useState(base);
  useEffect(() => {
    const t = window.setInterval(() => setSecs((v) => v + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  const hh = String(Math.floor(secs / 3600)).padStart(2, '0');
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  return (
    <div className="av-timer-in">
      <span className="av-rec" />
      <div>
        <strong className="av-time">{hh}:{mm}<span>:{ss}</span></strong>
        <small>Tracking · {task}</small>
      </div>
    </div>
  );
}

const TAG_CLASS: Record<Tag, string> = { Design: 't-design', Backend: 't-backend', Frontend: 't-frontend', QA: 't-qa', Content: 't-content' };
const LANES: { key: 'todo' | 'doing' | 'done'; label: string }[] = [
  { key: 'todo', label: 'To do' }, { key: 'doing', label: 'In progress' }, { key: 'done', label: 'Done' },
];

function Board({ s }: { s: Sim }) {
  // One layer holds every card, positioned by (lane, slot). A card that changes lane keeps its DOM node, so the CSS
  // transition on its position carries it across the board; nothing has to be measured.
  const placed = useMemo(() => {
    // Sorted by id so DOM order never changes (re-ordering nodes would cancel their in-flight transitions).
    const out: { t: Task; lane: number; slot: number; laneKey: 'todo' | 'doing' | 'done' }[] = [];
    LANES.forEach((l, lane) => s[l.key].forEach((t, i) => out.push({ t, lane, slot: Math.min(i, VISIBLE_SLOTS), laneKey: l.key })));
    return out.sort((a, b) => a.t.id - b.t.id);
  }, [s]);
  const finishing = s.doing[0]?.id;

  return (
    <div className="kb">
      <div className="kb-lanes">
        {LANES.map((l) => (
          <div key={l.key} className={`kb-lane kb-lane-${l.key}`}>
            <div className="kb-lane-head"><i />{l.label}<b key={s[l.key].length}>{s[l.key].length}</b></div>
            <div className="kb-lane-body" />
          </div>
        ))}
      </div>
      <div className="kb-layer">
        {placed.map(({ t, lane, slot, laneKey }) => {
          const cls = ['kb-slot', `is-${laneKey}`];
          if (t.id === finishing) cls.push('finishing');
          if (s.flying.includes(t.id)) cls.push('flying');
          if (t.id === s.landed && laneKey === 'done') cls.push('landed');
          return (
            <div key={t.id} className={cls.join(' ')} style={{ '--lane': lane, '--slot': slot } as CSSProperties}>
              <div className="kb-card">
                <div className="kb-card-top">
                  <strong>{t.title}</strong>
                  <span className="kb-done-tick"><Icon name="tick" size={10} /></span>
                </div>
                <div className="kb-card-foot">
                  <span className={`kb-tag ${TAG_CLASS[t.tag]}`}>{t.tag}</span>
                  <span className="kb-prog"><i style={{ width: `${t.pct}%` }} /></span>
                  <span className="kb-av" style={{ background: t.who.color }}>{t.who.initials}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SprintRing({ s }: { s: Sim }) {
  const pct = Math.round((s.done.length / SPRINT_SIZE) * 100);
  const shown = useCountUp(pct);
  return (
    <div className={`av-ring-in ${s.complete ? 'complete' : ''}`}>
      <svg viewBox="0 0 44 44" className="av-ring">
        <defs>
          <linearGradient id="av-ring-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#c084fc" /><stop offset="1" stopColor="#7c3aed" />
          </linearGradient>
        </defs>
        <circle cx="22" cy="22" r="18" className="av-ring-track" />
        <circle cx="22" cy="22" r="18" className="av-ring-fill" pathLength={100} style={{ strokeDashoffset: 100 - pct }} />
      </svg>
      <div>
        <small>{s.complete ? `Sprint ${s.sprint}` : `Sprint ${s.sprint} progress`}</small>
        <strong>{s.complete ? 'Complete' : `${shown}%`}</strong>
        <span>{s.done.length} of {SPRINT_SIZE} tasks done</span>
      </div>
      {s.complete && <span className="av-ring-spark" />}
    </div>
  );
}

function Activity({ e }: { e: ActivityEvent }) {
  return (
    <div className="av-activity-in" key={`${e.kind}-${e.id}`}>
      {e.kind === 'sprint'
        ? <span className="av-av av-av-team"><Icon name="flag" size={14} /></span>
        : <span className="av-av" style={{ background: e.who!.color }}>{e.who!.initials}</span>}
      <div>
        <strong>{e.kind === 'sprint' ? `${e.title} shipped` : `${e.who!.name} completed a task`}</strong>
        <small>{e.kind === 'sprint' ? 'All 12 tasks done · just now' : <>“{e.title}” · {e.fresh ? 'just now' : '2m ago'}</>}</small>
      </div>
      <span className="av-activity-check"><Icon name="tick" size={11} /></span>
    </div>
  );
}

const FEATURES: { icon: IconName; label: string }[] = [
  { icon: 'kanban', label: 'Boards & sprints' }, { icon: 'clock', label: 'Time tracking' },
  { icon: 'chart', label: 'Reports' }, { icon: 'message', label: 'Team chat' },
];

export function AuthVisual() {
  const reduced = useReducedMotion();
  const [s, dispatch] = useReducer(reducer, FIRST_SPRINT, makeSprint);
  const sceneRef = useRef<HTMLDivElement>(null);

  // The board's own clock: finish the top card, move it, repeat; hold on "sprint complete", then start the next sprint.
  useEffect(() => {
    if (reduced) return;
    const ms = s.complete ? COMPLETE_HOLD_MS : s.doing.length ? STEP_MS : 900;
    const t = window.setTimeout(() => dispatch(s.complete ? 'reset' : 'advance'), ms);
    return () => window.clearTimeout(t);
  }, [s, reduced]);
  useEffect(() => {
    if (!s.flying.length) return;
    const t = window.setTimeout(() => dispatch('settle'), FLY_MS);
    return () => window.clearTimeout(t);
  }, [s.flying]);

  // Pointer parallax: the board tilts and the floating widgets drift at different depths.
  useEffect(() => {
    const el = sceneRef.current;
    if (reduced || !el) return;
    let raf = 0, mx = 0, my = 0;
    const onMove = (e: PointerEvent) => {
      mx = (e.clientX / window.innerWidth) * 2 - 1;
      my = (e.clientY / window.innerHeight) * 2 - 1;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; el.style.setProperty('--mx', mx.toFixed(3)); el.style.setProperty('--my', my.toFixed(3)); });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => { window.removeEventListener('pointermove', onMove); cancelAnimationFrame(raf); };
  }, [reduced]);

  const tracking = s.doing[0]?.title ?? 'Sprint review';

  return (
    <div className="auth-visual" aria-hidden="true">
      <div className="av-copy">
        <span className="av-eyebrow"><span className="av-eyebrow-dot" />Project Tracker</span>
        <h2>
          Plan the work.<br />
          Track it <span className="av-rotator">
            <span style={{ '--d': '0s' } as CSSProperties}>in real time.</span>
            <span style={{ '--d': '3s' } as CSSProperties}>sprint by sprint.</span>
            <span style={{ '--d': '6s' } as CSSProperties}>across every team.</span>
          </span>
        </h2>
        <p>Projects, tasks, timesheets and reporting in one workspace your whole team actually uses.</p>
        <ul className="av-features">
          {FEATURES.map((f) => <li key={f.label}><Icon name={f.icon} size={14} />{f.label}</li>)}
        </ul>
      </div>

      <div className="av-scene" ref={sceneRef}>
        <span className="av-halo" />
        <div className="av-window">
          <div className="av-win-bar">
            <span className="av-lights"><i /><i /><i /></span>
            <span className="av-win-title"><Icon name="kanban" size={13} />Sprint {s.sprint} · Website relaunch</span>
            <span className="av-live-pill"><span className="av-live" />Live</span>
          </div>
          <Board s={s} />
          <span className="av-cursor av-cursor-1"><svg viewBox="0 0 16 16"><path d="M1 1l5.5 13.5 2-5.6L14 7z" /></svg><em>Meera</em></span>
          <span className="av-cursor av-cursor-2"><svg viewBox="0 0 16 16"><path d="M1 1l5.5 13.5 2-5.6L14 7z" /></svg><em>Ravi</em></span>
        </div>

        <div className="av-sat av-sat-ring"><div className="av-float av-float-a"><SprintRing s={s} /></div></div>
        <div className="av-sat av-sat-activity"><div className="av-float av-float-b"><Activity e={s.event} /></div></div>
        <div className="av-sat av-sat-timer"><div className="av-float av-float-c"><LiveTimer key={tracking} task={tracking} /></div></div>
      </div>
    </div>
  );
}
