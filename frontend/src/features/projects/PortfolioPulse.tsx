import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { TimelineProject } from './portfolioApi';
import { useProjectColour } from './PortfolioShell';
import { dmy, dn, slipOf, statusOf } from './timelineLayout';
import './portfolioPulse.css';

/**
 * The pulse under a short Portfolio tab: instead of an empty band, the next dates, what needs attention and when work lands, each in the
 * project's one colour (status is a word, never a second colour). It takes the room left on the page (flex: 1) and its charts scale with it.
 */
export type PulseKind = 'coming' | 'attention' | 'months';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SHOWN = 5;

export function PulseCard({ title, meta, children, label }: { title: string; meta?: ReactNode; children: ReactNode; label?: string }) {
  return (
    <section className="pfp-card" aria-label={label ?? title}>
      <h3 className="pfp-h"><span>{title}</span>{meta != null && <em>{meta}</em>}</h3>
      {children}
    </section>
  );
}

export function PortfolioPulse({ projects, today, kinds }: { projects: TimelineProject[]; today: string; kinds: PulseKind[] }) {
  return (
    <div className="pfp" style={{ ['--pfp-n' as string]: kinds.length }} data-pulse={kinds.join(' ')}>
      {kinds.map((k) => k === 'coming' ? <ComingUp key={k} projects={projects} today={today} />
        : k === 'attention' ? <Attention key={k} projects={projects} today={today} />
        : <ByMonth key={k} projects={projects} today={today} />)}
    </div>
  );
}

/** Due dates and milestones from today on, nearest first. */
function ComingUp({ projects, today }: { projects: TimelineProject[]; today: string }) {
  const colourOf = useProjectColour();
  const items = projects.flatMap((p) => [
    ...(p.due && p.due >= today && statusOf(p, today) !== 'Done' ? [{ p, date: p.due, what: 'Due' }] : []),
    ...p.milestones.filter((m) => m.due && m.due >= today && m.status !== 'Completed').map((m) => ({ p, date: m.due!, what: m.name })),
  ]).sort((a, b) => a.date.localeCompare(b.date));
  const shown = items.slice(0, SHOWN);
  return (
    <PulseCard title="Coming up" meta={items.length ? `${items.length} date${items.length === 1 ? '' : 's'}` : undefined}>
      {shown.length === 0 ? <p className="pfp-calm">Nothing is due from today on.</p> : (
        <ul className="pfp-list">
          {shown.map((x) => {
            const days = dn(x.date) - dn(today);
            return (
              <li key={`${x.p.id}${x.date}${x.what}`} className={`pc-${colourOf(x.p.id)}`}>
                <span className="pfp-date"><b>{+x.date.slice(8, 10)}</b><small>{MON[+x.date.slice(5, 7) - 1]}</small></span>
                <Link to={`/work/projects/${x.p.id}`} className="pfp-name"><i className="pfp-sq" aria-hidden="true" />{x.p.name}</Link>
                <span className="pfp-what">{x.what === 'Due' ? (days === 0 ? 'Due today' : `Due in ${days}d`) : `◆ ${x.what}`}</span>
              </li>
            );
          })}
        </ul>
      )}
    </PulseCard>
  );
}

/** Late and at-risk projects, the worst slip first; the status is the label. */
function Attention({ projects, today }: { projects: TimelineProject[]; today: string }) {
  const colourOf = useProjectColour();
  const list = projects.map((p) => ({ p, st: statusOf(p, today), slip: slipOf(p) })).filter((x) => x.st === 'Late' || x.st === 'At risk')
    .sort((a, b) => (a.st === b.st ? 0 : a.st === 'Late' ? -1 : 1) || b.slip - a.slip);
  return (
    <PulseCard title="Needs attention" meta={list.length || undefined}>
      {list.length === 0 ? <p className="pfp-calm">Every project is on track.</p> : (
        <ul className="pfp-list">
          {list.slice(0, SHOWN).map(({ p, st, slip }) => (
            <li key={p.id} className={`pc-${colourOf(p.id)}`}>
              <Link to={`/work/projects/${p.id}`} className="pfp-name"><i className="pfp-sq" aria-hidden="true" />{p.name}</Link>
              <span className={`pfp-st ${st === 'Late' ? 'late' : 'risk'}`}>{st}{slip > 0 ? ` · +${slip}d` : ''}</span>
              <span className="pfp-what">{p.owner ? `${p.owner.split(' ')[0]} · ` : ''}{p.due ? `due ${dmy(p.due)}` : 'no date'}</span>
            </li>
          ))}
        </ul>
      )}
    </PulseCard>
  );
}

/** When work lands: one column per month (this month and the next four), stacked in each project's colour. */
function ByMonth({ projects, today }: { projects: TimelineProject[]; today: string }) {
  const colourOf = useProjectColour();
  const y0 = +today.slice(0, 4), m0 = +today.slice(5, 7) - 1;
  const months = Array.from({ length: 5 }, (_, i) => { const m = (m0 + i) % 12, y = y0 + Math.floor((m0 + i) / 12); return { key: `${y}-${String(m + 1).padStart(2, '0')}`, label: MON[m] }; });
  const end = (p: TimelineProject) => (p.forecast && p.due && p.forecast > p.due ? p.forecast : p.due);
  const cols = months.map((m) => ({ ...m, items: projects.filter((p) => end(p)?.slice(0, 7) === m.key && statusOf(p, today) !== 'Done') }));
  const max = Math.max(1, ...cols.map((c) => c.items.length));
  const total = cols.reduce((a, c) => a + c.items.length, 0);
  return (
    <PulseCard title="Finishing by month" meta={`${total} in ${months.length} months`}>
      <div className="pfp-chart" role="img" aria-label={cols.map((c) => `${c.label}: ${c.items.length}`).join(', ')}>
        {cols.map((c) => (
          <div key={c.key} className="pfp-col">
            <span className="pfp-track">
              <span className="pfp-bar" style={{ height: `${(c.items.length / max) * 100}%` }}>
                <span className="pfp-n">{c.items.length}</span>
                {c.items.map((p) => <i key={p.id} className={`pc-${colourOf(p.id)}`} title={`${p.name} · ${dmy(end(p))}`} />)}
              </span>
            </span>
            <small>{c.label}</small>
          </div>
        ))}
      </div>
    </PulseCard>
  );
}
