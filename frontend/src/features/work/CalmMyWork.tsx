import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import type { WorkRow } from '../../api/workItemsApi';
import { AuraLine, CalmAv, CalmCard, CalmDot, CalmFoot, CalmGo, CalmInsights, CalmLink, CalmPills, CalmRailCard, CalmRailRow, CalmSplit, CalmOrb } from '../../components/calm';
import { Icon } from '../../components/Icon';
import { projectColor } from '../../lib/calm';
import { todayISO } from '../../lib/format';
import { queryClient, useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { shiftIsoDate } from '../../lib/zone';
import { useAi, useAssistant } from '../ai/Assistant';
import { useTodayFocus } from '../calendar/useToday';
import { WeekCard } from '../calm/WeekCard';
import { DotsMenu, type DotsItem } from '../talk/DotsMenu';
import { CalmCreateHost, openCalmNew } from '../calm/createSheets';
import { completedToday, myWorkBucket, weekEndOf } from './myWorkRules';
import { dayText, moveTo, smart } from './workActions';
import { refreshWork, useWorkList } from './workUi';
import '../calm/calm-pages.css';

type Tab = 'week' | 'later' | 'done' | 'waiting';
type Group = 'project' | 'due';
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const isOpen = (w: WorkRow) => w.category === 'Todo' || w.category === 'Active';
const hh = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
const mondayOf = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); return shiftIsoDate(iso, -((d.getUTCDay() + 6) % 7)); };

/**
 * My work (calm, shot 05): "N things due this week. / <first> comes first." over This week · Later · Done · Waiting on others, one
 * full-width list grouped by project (or by day), each row ticked off in place (optimistic, ✓ Saved). The right panel: This week, Waiting
 * on others, Done this week and a focus suggestion. Every row opens the Work side panel.
 */
export function CalmMyWork({ onOpen, more }: { onOpen: (id: string) => void; more: DotsItem[] }) {
  const wid = useWorkspaceId();
  const nav = useNavigate();
  const me = useAuth((s) => s.ctx!.user.id);
  const today = todayISO();
  const weekEnd = weekEndOf(today);
  const open = useWorkList({ mine: true });
  const closed = useWorkList({ mine: true, status: 'closed' });
  const raised = useWorkList({ raisedByMe: true });
  const [tab, setTab] = useState<Tab>('week');
  const [group, setGroup] = useState<Group>('project');
  const [done, setDone] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState(false);

  const live = useMemo(() => open.items.filter(isOpen).sort(smart), [open.items]);
  const week = live.filter((w) => { const b = myWorkBucket(w, today, weekEnd); return b === 'overdue' || b === 'today' || b === 'week'; });
  const later = live.filter((w) => !week.includes(w));
  const monday = mondayOf(today);
  const doneWeek = closed.items.filter((w) => w.category === 'Done' && (w.completedAt ?? '').slice(0, 10) >= monday).sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  const waiting = raised.items.filter((w) => isOpen(w) && w.assignee && w.assignee.id !== me).sort(smart);
  const rows = tab === 'week' ? week : tab === 'later' ? later : tab === 'done' ? doneWeek : waiting;
  const overdue = live.filter((w) => w.isOverdue).length;

  const tick = async (w: WorkRow) => {
    setDone((s) => new Set(s).add(w.id));
    try {
      await moveTo(w, 'Done');
      setSaved(true); window.setTimeout(() => setSaved(false), 1400);
      window.setTimeout(() => refreshWork(wid), 700);
    } catch (e) {
      setDone((s) => { const x = new Set(s); x.delete(w.id); return x; });
      toast(errText(e, 'Could not mark it done.'), 'error');
      if (e instanceof ApiError && e.status === 409) void queryClient.invalidateQueries({ queryKey: [wid, 'work-items'] });
    }
  };

  const groups = useMemo(() => {
    const m = new Map<string, { key: string; name: string; color: string | null; items: WorkRow[] }>();
    for (const w of rows) {
      const k = group === 'project' ? (w.projectId ?? 'none') : (w.isOverdue ? '0' : w.dueDate ?? '9');
      const name = group === 'project' ? (w.projectName ?? 'No project') : w.isOverdue ? 'Overdue' : w.dueDate ? dayText(w.dueDate) : 'No date';
      if (!m.has(k)) m.set(k, { key: k, name, color: group === 'project' ? projectColor(w.projectId) : null, items: [] });
      m.get(k)!.items.push(w);
    }
    return [...m.values()];
  }, [rows, group]);

  const first = week[0] ?? live[0];
  const title = week.length ? `${week.length} thing${week.length === 1 ? '' : 's'} due this week.` : live.length ? 'Nothing due this week.' : 'Your list is clear.';
  const second = first ? `${shortTitle(first.title)} comes first.` : 'New work lands here.';
  const lateOne = live.find((w) => w.isOverdue);

  const dots = <DotsMenu label="More in My work" items={[{ label: 'Focus stack', hint: 'The earlier My work, with Do this now', icon: 'target', onSelect: () => nav('/work?classic=1') }, ...more]} />;
  return (
    <CalmSplit crumb={<><span>My work</span><span style={{ flex: 1 }} />{dots}</>} label="My work" rail={<MyWorkRail waiting={waiting} doneWeek={doneWeek} first={first ?? null} onOpen={onOpen} />}>
      <header className="cp-hero"><h1>{title}<em>{second}</em></h1></header>
      <div className="cp-tools">
        <CalmPills label="Show" value={tab} onChange={setTab} options={[{ value: 'week', label: 'This week' }, { value: 'later', label: 'Later' }, { value: 'done', label: 'Done' }, { value: 'waiting', label: 'Waiting on others' }]} />
        <span className="cp-sp" />
        <span className={`cp-saved${saved ? ' on' : ''}`} aria-live="polite">{saved ? '✓ Saved' : ''}</span>
        <button type="button" className="cp-lk" onClick={() => setGroup(group === 'project' ? 'due' : 'project')}>Group: {group === 'project' ? 'Project' : 'Day'} ›</button>
        <button type="button" className="cp-go-sm" onClick={() => openCalmNew({ type: 'task' })}><Icon name="plus" size={13} /> New task</button>
      </div>
      <CalmCard variant="flush" className="mw2-list" aria-label="Work">
        {open.isLoading && !rows.length ? <p className="mw2-empty">Loading your work…</p>
          : rows.length === 0 ? <p className="mw2-empty">{tab === 'week' ? 'Nothing due this week.' : tab === 'later' ? 'Nothing later.' : tab === 'done' ? 'Nothing finished this week yet.' : 'Nobody owes you anything.'}</p>
          : groups.map((g) => (
            <div key={g.key} role="group" aria-label={g.name}>
              <div className="mw2-grp">{g.color && <CalmDot color={g.color} />}{g.name}<small>{g.items.length}</small></div>
              {g.items.map((w) => {
                const off = done.has(w.id) || tab === 'done';
                const right = tab === 'done' ? dayText((w.completedAt ?? '').slice(0, 10) || null) : tab === 'waiting' ? (w.assignee?.name.split(' ')[0] ?? '') : w.isOverdue ? 'Overdue' : w.dueTime && w.dueDate === today ? w.dueTime.slice(0, 5) : dayText(w.dueDate);
                const hot = tab !== 'done' && (w.isOverdue || w.dueDate === today);
                return (
                  <div key={w.id} className={`mw2-row${off ? ' done' : ''}`}>
                    {group === 'project' && <CalmDot color={projectColor(w.projectId)} />}
                    {tab === 'waiting' ? <CalmAv name={w.assignee?.name ?? '?'} size={20} />
                      : <button type="button" className={`cp-ring${off ? ' done' : ''}`} aria-label={`Done: ${w.title}`} aria-pressed={off} disabled={off} onClick={() => void tick(w)} />}
                    <button type="button" className="mw2-open" onClick={() => onOpen(w.id)}>
                      <span className="mw2-t"><b>{w.title}</b><small>{[w.key, w.source?.title ? `from ${w.source.title}` : null, w.assignee && w.assignee.id !== me && tab !== 'waiting' ? `with ${w.assignee.name.split(' ')[0]}` : null].filter(Boolean).join(' · ')}</small></span>
                      <span className={`mw2-r${hot ? ' hot' : ''}`}>{right}</span>
                      <span className="mw2-chev" aria-hidden="true"><Icon name="chevronR" size={14} /></span>
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
      </CalmCard>
      <div className="td-gap" />
      <CalmFoot>
        <CalmInsights items={[
          { key: 'open', label: `${live.length} open`, onClick: () => setTab('week') },
          { key: 'overdue', label: `${overdue} overdue`, onClick: () => nav('/work?classic=1&overdue=1') },
          { key: 'done', label: `${doneWeek.length} done this week`, onClick: () => setTab('done') },
        ]} />
        <AuraLine text={lateOne ? `${shortTitle(lateOne.title)} is overdue. Moving it to a free afternoon keeps the week honest.` : completedToday(doneWeek[0] ?? {}, today) ? 'You finished something today. Nice.' : undefined}
          action={lateOne ? 'Open it' : undefined} onAction={() => lateOne && onOpen(lateOne.id)} />
      </CalmFoot>
      <CalmCreateHost />
    </CalmSplit>
  );
}

const shortTitle = (t: string) => (t.length > 34 ? `${t.slice(0, 32).trimEnd()}…` : t);

function MyWorkRail({ waiting, doneWeek, first, onOpen }: { waiting: WorkRow[]; doneWeek: WorkRow[]; first: WorkRow | null; onOpen: (id: string) => void }) {
  const nav = useNavigate();
  const ai = useAi();
  const ask = useAssistant((s) => s.ask);
  const { blocks } = useTodayFocus();
  const [dismissed, setDismissed] = useState(false);
  const block = blocks[0];
  return (
    <>
      <WeekCard link />
      <CalmRailCard title="Waiting on others" link={waiting.length ? 'All ›' : undefined} onLink={() => nav('/work?classic=1&filter=raised')}>
        {waiting.length === 0 ? <p className="calm-week-note">Nobody owes you anything.</p> : waiting.slice(0, 4).map((w) => (
          <CalmRailRow key={w.id} lead={<CalmAv name={w.assignee?.name ?? '?'} />} title={w.assignee?.name ?? 'Unassigned'} sub={w.title} hot={w.isOverdue}
            right={w.isOverdue ? 'Late' : dayText(w.dueDate)} onClick={() => onOpen(w.id)} />
        ))}
      </CalmRailCard>
      <CalmRailCard title={`Done this week · ${doneWeek.length}`}>
        {doneWeek.length === 0 ? <p className="calm-week-note">Nothing finished yet this week.</p> : doneWeek.slice(0, 3).map((w) => (
          <CalmRailRow key={w.id} lead={<span className="cp-ring done" aria-hidden="true" />} title={w.title} sub={w.key} right={dayText((w.completedAt ?? '').slice(0, 10) || null)} onClick={() => onOpen(w.id)} />
        ))}
      </CalmRailCard>
      {first && !dismissed && (
        <CalmRailCard title="Focus suggestion" className="mw2-focus">
          <p><CalmOrb /><span>{block ? <>Block <b>{hh(block.start)} – {hh(block.end)}</b> for {first.key}. Your calendar is free then.</> : <>Give {first.key} an hour before anything else today.</>}</span></p>
          <div className="acts">
            <CalmGo onClick={() => (ai ? ask(`Hold focus time for ${first.key} ${first.title}${block ? ` from ${hh(block.start)} to ${hh(block.end)}` : ''} today.`) : nav('/?tab=calendar'))}>Hold focus time</CalmGo>
            <CalmLink onClick={() => setDismissed(true)}>Not now</CalmLink>
          </div>
        </CalmRailCard>
      )}
    </>
  );
}
