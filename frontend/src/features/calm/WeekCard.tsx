import { useNavigate } from 'react-router-dom';
import { CalmRailCard, CalmWeek, type CalmWeekDay } from '../../components/calm';
import { projectColor, ribbonColors } from '../../lib/calm';
import { DOW, todayISO } from '../../lib/format';
import { useTimeline, weekRange, workWeek } from '../calendar/timeline';

const hm = (min: number) => { const h = Math.floor(min / 60), m = Math.round(min % 60); return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`; };

/** This week: five day tiles with a dot per meeting and thing due, and one line under them. */
export function WeekCard({ title = 'This week', link }: { title?: string; link?: boolean }) {
  const nav = useNavigate();
  const today = todayISO();
  const tl = useTimeline({ ...weekRange(today), scope: 'me' });
  const days = workWeek(today);
  const ev = tl.data?.events ?? [];
  const tiles: CalmWeekDay[] = days.map((d) => {
    const on = ev.filter((e) => e.date === d && (e.type === 'due' || e.type === 'meeting'));
    return { day: d, label: DOW[new Date(`${d}T00:00:00`).getDay()], num: new Date(`${d}T00:00:00`).getDate(), today: d === today,
      dots: on.map((e) => (e.type === 'meeting' ? ribbonColors.meet : projectColor(e.projectId ?? e.id))), onClick: () => nav(`/?tab=calendar&date=${d}`) };
  });
  const dueN = ev.filter((e) => e.type === 'due' && days.includes(e.date)).length;
  const meetMin = ev.filter((e) => e.type === 'meeting' && days.includes(e.date)).reduce((s, e) => s + (e.end ? (Date.parse(e.end) - Date.parse(e.start)) / 60000 : 30), 0);
  const heavy = tiles.reduce((b, t) => (t.dots.length > b.dots.length ? t : b), tiles[0]);
  const note = link ? (heavy && heavy.dots.length ? `${heavy.today ? 'Today' : heavy.label} is the heaviest day: ${heavy.dots.length} thing${heavy.dots.length === 1 ? '' : 's'}.` : 'A light week so far.')
    : `${dueN} due · ${hm(meetMin)} in meetings`;
  return (
    <CalmRailCard title={title} link={link ? 'Calendar ›' : undefined} to="/?tab=calendar">
      <CalmWeek days={tiles} note={note} />
    </CalmRailCard>
  );
}
