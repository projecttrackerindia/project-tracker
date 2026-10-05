import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Dashboard, WorkItem } from '../../api/types';
import { Icon } from '../../components/Icon';
import { openPalette } from '../../components/CommandPalette';
import { HealthBadge, Progress } from '../../components/ui';
import { formatDate } from '../../lib/format';
import { haptic } from '../../lib/mobile';
import { WorkItemRow, type WorkRowItem } from '../workitems/workItems';

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hello = () => { const h = new Date().getHours(); return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };

/** What to say about the day, from the figures: the single most useful sentence. */
function headline(due: number, overdue: number, done: number): string {
  if (overdue > 0) return overdue === 1 ? 'Clear the overdue one.' : `Clear the ${overdue} overdue.`;
  if (due > 0) return due === 1 ? 'One thing due today.' : `${due} things due today.`;
  if (done > 0) return 'Today is done. Nice.';
  return 'You are all caught up.';
}

/**
 * The first screen of the phone app, built around "what do I do now": a greeting that says it, a focus card with today's progress, the week as a
 * strip of days (a dot where work is due) with that day's list under it, and the projects as swipeable cards. The desktop dashboard is untouched.
 */
export function MobileHome({ name, data, showProjects, onOpen }: { name: string; data: Dashboard; showProjects: boolean; onOpen: (i: WorkRowItem) => void }) {
  const nav = useNavigate();
  const c = data.counts;
  const todayIso = iso(new Date());
  const [picked, setPicked] = useState(todayIso);

  const week = useMemo(() => {
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));   // Monday
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  }, []);
  const byDay = useMemo(() => {
    const m = new Map<string, WorkItem[]>();
    for (const w of data.myWork) if (w.dueDate) { const k = w.dueDate.slice(0, 10); m.set(k, [...(m.get(k) ?? []), w]); }
    return m;
  }, [data.myWork]);

  const dayItems = (byDay.get(picked) ?? []);
  const overdue = picked === todayIso ? data.myWork.filter((w) => w.isOverdue && (w.dueDate ?? '').slice(0, 10) < todayIso) : [];
  const shown = [...overdue, ...dayItems.filter((w) => !overdue.includes(w))];
  const pickedDate = week.find((d) => iso(d) === picked);
  const planned = c.myDueToday + c.myCompletedToday;
  const pct = planned > 0 ? Math.round((c.myCompletedToday / planned) * 100) : c.myOverdue > 0 ? 0 : 100;
  const next = data.myWork[0];

  return (
    <div className="mh">
      <header className="mh-greet">
        <small>{hello()}, {name}</small>
        <h1>{headline(c.myDueToday, c.myOverdue, c.myCompletedToday).split(' ').map((w, i, a) => (i >= a.length - 2 ? <span key={i} className="mh-grad">{w} </span> : `${w} `))}</h1>
      </header>

      <button type="button" className="mh-search" onClick={() => { haptic(); openPalette(); }}>
        <Icon name="search" size={19} /><span>Ask or search anything…</span><i><Icon name="sparkle" size={16} /></i>
      </button>

      <section className="mh-focus" aria-label="Today">
        <div className="mh-focus-top">
          <div><small>Today</small><b>{c.myCompletedToday}<span> of {planned || 0} done</span></b></div>
          <div className="mh-focus-chips">
            {c.myOverdue > 0 && <em className="late">{c.myOverdue} overdue</em>}
            {c.myOpen > 0 && <em>{c.myOpen} open</em>}
          </div>
        </div>
        <div className="mh-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
        {next && <p className="mh-next"><Icon name="arrowRight" size={14} /> Next: <b>{next.title}</b></p>}
        <Link className="mh-cta" to="/my-work" onClick={() => haptic(8)}>Open my work <Icon name="arrowRight" size={16} /></Link>
      </section>

      <section className="mh-week" aria-label="This week">
        <div className="mh-week-days" role="tablist">
          {week.map((d) => {
            const k = iso(d); const n = byDay.get(k)?.length ?? 0; const on = k === picked; const today = k === todayIso;
            return (
              <button key={k} type="button" role="tab" aria-selected={on} className={`mh-day ${on ? 'on' : ''} ${today ? 'today' : ''}`} onClick={() => { haptic(5); setPicked(k); }}>
                <small>{DAY[d.getDay()]}</small><b>{d.getDate()}</b>
                <span className="mh-dots">{Array.from({ length: Math.min(n, 3) }, (_, i) => <i key={i} />)}</span>
              </button>
            );
          })}
        </div>
        <h2 className="mh-h">{picked === todayIso ? 'Today' : pickedDate ? `${DAY[pickedDate.getDay()]}, ${pickedDate.getDate()}` : ''} <em>{shown.length}</em></h2>
        {shown.length === 0
          ? <div className="mh-none"><Icon name="checkCircle" size={22} /><span>{picked === todayIso ? 'Nothing due today.' : 'Nothing due that day.'}</span></div>
          : <div className="mh-list">{shown.slice(0, 6).map((w) => <WorkItemRow key={`${w.kind}:${w.id}`} item={w} onOpen={onOpen} />)}</div>}
      </section>

      {showProjects && data.projects.length > 0 && (
        <section className="mh-projects" aria-label="Projects">
          <div className="mh-row"><h2 className="mh-h">Projects</h2><Link to="/projects">See all</Link></div>
          <div className="mh-rail">
            {data.projects.slice(0, 8).map((p) => (
              <button key={p.id} type="button" className={`mh-card ${p.health}`} onClick={() => { haptic(6); nav(`/projects/${p.id}`); }}>
                <span className="mh-card-top"><b>{p.name}</b><HealthBadge health={p.health} /></span>
                <small>{p.owner?.name ?? 'Unassigned'} · {formatDate(p.dueDate)}</small>
                <span className="mh-card-prog"><Progress value={p.progress} /><b>{p.progress}%</b></span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
