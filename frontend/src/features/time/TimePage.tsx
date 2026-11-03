import { useMemo, useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { insightApi, timeApi } from '../../api/endpoints';
import type { ParsedTime } from '../../api/types';
import { AuraLine, CalmAvatar, CalmCard, CalmDot, CalmFoot, CalmGo, CalmInsights, CalmLink, CalmPills, CalmRailCard, CalmRailRow, CalmSplit } from '../../components/calm';
import { Icon } from '../../components/Icon';
import { ErrorState, PageLoader } from '../../components/ui';
import { projectColor, ribbonColors } from '../../lib/calm';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { todayISO } from '../../lib/format';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { approvalsApi } from '../approvals/api';
import { ApprovalRequestHost, openApprovalRequest } from '../approvals/host';
import { reminderApi } from '../reminders/api';
import { deviceZone } from '../reminders/time';
import { mondayOf } from './Approvals';
import { ReviewDrawer } from './ReviewDrawer';
import { TimeWordsReview } from './TimeWords';
import { formatMinutes } from './time';
import './time-calm.css';

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dow = (iso: string) => new Date(`${iso}T00:00:00`).getDay();
/** ISO week number (week 45). */
function isoWeek(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d.getTime() - firstThu.getTime()) / 86_400_000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
}
const ago = (iso: string) => { const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000); return m < 60 ? `${Math.max(1, m)}m` : m < 1440 ? `${Math.round(m / 60)}h` : new Date(iso).toLocaleDateString('en-GB', { weekday: 'short' }); };

/**
 * Time: the week in one sentence ("31h 20m logged this week. Fill Monday and you can submit."), the one thing missing as the hero with its
 * fix (the drafted entry from your calendar, or log it in words), requests for an attendance correction or leave (both go to Approvals),
 * the week as a ribbon of days, where the time went by project, and the rail: the week against its target, the timer, the days, and the
 * workspace's activity. The full grid, entries, insights and reviews stay one tap away (Timesheet ›).
 */
export function TimePage() {
  const wid = useWorkspaceId();
  const nav = useNavigate();
  const today = todayISO();
  const [mode, setMode] = useState<'week' | 'month'>('week');
  const week = mondayOf(today);
  const grid = useWsQuery(['time', 'grid', week], () => timeApi.grid(week), { placeholderData: (p) => p });
  const status = useWsQuery(['time', 'week', week], () => timeApi.week(week));
  const insights = useWsQuery(['time', 'insights', 'me', 8], () => timeApi.insights(undefined, 8), { staleTime: 120_000, retry: false });
  const draft = useWsQuery(['time', 'draft', week], () => timeApi.draft(week), { enabled: !!grid.data?.editable && !grid.data.locked, staleTime: 60_000, retry: false });
  const activity = useWsQuery(['activity', 1], () => insightApi.activity(1), { staleTime: 60_000, retry: false });
  const leaveChain = useWsQuery(['approvals', 'chain', 'Leave'], () => approvalsApi.chain('Leave'), { staleTime: 300_000, retry: false });
  const [words, setWords] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedTime | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = () => void invalidateWorkspace(wid, 'time');

  const g = grid.data;
  const weekdays = useMemo(() => (g?.days ?? []).filter((d) => !d.weekend || d.minutes > 0), [g]);
  // The first working day so far that is short of its target (and not on leave): the one thing between you and submitting.
  const short = weekdays.find((d) => d.date <= today && !d.leave && d.targetMinutes > 0 && d.minutes < d.targetMinutes && d.date !== today) ?? null;
  const missing = short ? short.targetMinutes - short.minutes : 0;
  const draftCells = (draft.data?.cells ?? []).filter((c) => short && c.date === short.date);
  const draftMinutes = draftCells.reduce((a, c) => a + c.minutes, 0);
  const projects = useMemo(() => {
    const m = new Map<string, { id: string | null; name: string; minutes: number; what: string[] }>();
    for (const r of g?.rows ?? []) {
      const k = r.projectId ?? `ops:${r.projectName ?? 'Operational work'}`;
      const cur = m.get(k) ?? { id: r.projectId, name: r.projectName ?? 'Operational work', minutes: 0, what: [] };
      cur.minutes += r.totalMinutes; if (cur.what.length < 2) cur.what.push(cur.what.length ? r.title : `${r.key}, ${r.title}`);
      m.set(k, cur);
    }
    return [...m.values()].filter((p) => p.minutes > 0).sort((a, b) => b.minutes - a.minutes);
  }, [g]);

  if (grid.isLoading && !g) return <PageLoader />;
  if (grid.isError && !g) return <ErrorState error={grid.error} retry={() => void grid.refetch()} />;
  const total = g!.totalMinutes, target = g!.targetMinutes || 1;
  const pct = Math.min(100, Math.round((total / target) * 100));
  const billable = total ? Math.min(100, Math.round((g!.billableMinutes / total) * 100)) : 0;
  const streak = insights.data?.streak ?? 0;
  const st = status.data;
  const running = g!.running;
  const last = g!.rows.slice().sort((a, b) => b.totalMinutes - a.totalMinutes)[0];
  const weekNo = isoWeek(week);
  const second = st?.status === 'Submitted' ? 'Submitted. Waiting for approval.' : st?.status === 'Approved' ? 'Approved. Nothing to do.' : st?.status === 'Rejected' ? 'Returned. Fix it and submit again.'
    : short ? `Fill ${DAY_LONG[dow(short.date)]} and you can submit.` : total >= target ? 'Ready to submit.' : 'Keep logging as you go.';
  const chainNames = leaveChain.data?.steps.map((s) => s.approver.name.split(' ')[0]).join(' → ');

  const logDraft = async () => {
    if (!draftCells.length) { setWords(''); return; }
    setBusy(true);
    try {
      const res = await timeApi.saveGrid(week, draftCells.map((c) => ({ kind: c.kind, targetId: c.targetId, date: c.date, minutes: c.minutes, note: null })));
      toast(res.errors.length ? res.errors[0].message : `✓ Logged ${formatMinutes(draftMinutes)}`, res.errors.length ? 'error' : 'success');
      refresh();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not log it.', 'error'); }
    finally { setBusy(false); }
  };
  const readWords = async () => {
    if (!words?.trim()) return;
    setBusy(true);
    try { setParsed(await timeApi.parseWords(words.trim())); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not read that. Try "2h on PAY-12 today".', 'error'); }
    finally { setBusy(false); }
  };
  const timer = async () => {
    try {
      if (running) { await timeApi.stop(); toast('✓ Timer stopped', 'success'); }
      else if (last) { await (last.kind === 'work' ? timeApi.startOnWorkTask(last.targetId) : timeApi.start(last.targetId)); toast(`✓ Timer on ${last.key}`, 'success'); }
      else { nav('/insights?tab=time&s=week'); return; }
      refresh();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not change the timer.', 'error'); }
  };
  const timesheetLink = { kind: 'timesheet', label: `Timesheet week ${weekNo}`, href: `/insights?tab=time&s=week&week=${week}` };
  const lowDay = insights.data?.byWeekday.filter((d) => d.day >= 1 && d.day <= 5).sort((a, b) => a.averageMinutes - b.averageMinutes)[0];
  const remindLow = async () => {
    if (!lowDay) return;
    const code = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][lowDay.day];
    const next = (() => { const d = new Date(); for (let i = 0; i < 8; i++) { const x = new Date(d.getTime() + i * 86_400_000); if (x.getDay() === lowDay.day) return x; } return d; })();
    const p = (n: number) => String(n).padStart(2, '0');
    try {
      await reminderApi.create({ title: 'Log my time', when: { at: `${next.getFullYear()}-${p(next.getMonth() + 1)}-${p(next.getDate())}T17:30`, timeZone: deviceZone(), recurrence: `FREQ=WEEKLY;BYDAY=${code}` } });
      toast(`✓ Reminder set · every ${DAY_LONG[lowDay.day]} 17:30`, 'success');
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not set it.', 'error'); }
  };

  const ribbonDays = weekdays.slice(0, 7);
  const monthWeeks = (insights.data?.weeks ?? []).slice(-5);
  const rail = (
    <>
      <CalmRailCard title={`Week ${weekNo}`}>
        <div className="tm-ring-row">
          <span className="tm-ring" style={{ '--p': pct } as CSSProperties} role="img" aria-label={`${pct}% of the week's target`}><b>{pct}%</b></span>
          <div><div className="tm-ring-big">{formatMinutes(total)} <small>of {formatMinutes(target)}</small></div><small>{billable}% billable{streak ? ` · ${streak}-day streak` : ''}</small></div>
        </div>
      </CalmRailCard>
      <CalmRailCard title="Timer">
        <div className="tm-timer">
          <i className={running ? 'on' : ''} aria-hidden="true" />
          <div><b>{running ? `On ${running.taskKey}` : 'Off'}</b><small>{running ? running.taskTitle : last ? `Last: ${last.key} · ${formatMinutes(last.totalMinutes)}` : 'Start it from any task'}</small></div>
          <CalmGo onClick={() => void timer()}>{running ? 'Stop' : 'Start'}</CalmGo>
        </div>
      </CalmRailCard>
      <CalmRailCard title="By day">
        {weekdays.map((d) => {
          const w = Math.min(100, d.targetMinutes ? (d.minutes / d.targetMinutes) * 100 : d.minutes ? 100 : 0);
          const col = d.date >= today ? 'var(--calm-p1)' : d.minutes < d.targetMinutes && !d.leave ? ribbonColors.admin : 'var(--calm-p2)';
          return <div key={d.date} className="tm-mb"><span>{DAY[dow(d.date)]}</span><div className="calm-bar thin"><i style={{ width: `${w}%`, background: col }} /></div><b>{d.leave ? 'Leave' : formatMinutes(d.minutes)}</b></div>;
        })}
      </CalmRailCard>
      <CalmRailCard title="Workspace activity" aside={<Link className="tm-lk" to="/activity">All ›</Link>} className="tm-feed">
        {(activity.data?.items ?? []).slice(0, 6).map((a) => (
          <CalmRailRow key={a.id} lead={<CalmAvatar userId={a.actor?.id} name={a.actor?.name ?? 'System'} size="m" />} title={a.summary} sub={a.entityType} right={ago(a.createdAt)} />
        ))}
        {activity.isSuccess && !activity.data?.items.length && <p className="tm-note">Nothing yet this week.</p>}
      </CalmRailCard>
    </>
  );

  return (
    <div className="tm-page" aria-label="Time">
      <ApprovalRequestHost />
      <div className="tm-top"><span className="tm-crumb">Time</span>
        <CalmPills label="Range" value={mode} onChange={setMode} options={[{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} />
      </div>
      <CalmSplit rail={rail}>
        <h1 className="tm-title">{formatMinutes(total)} logged this week.<em>{second}</em></h1>
        <CalmCard variant="hero" className="tm-hero">
          <div className="tm-tag"><CalmDot color="var(--calm-p1)" />Timesheet · week {weekNo} · {st?.status === 'Submitted' ? 'submitted' : st?.status === 'Approved' ? 'approved' : 'due Friday'}</div>
          {short ? (
            <>
              <h2>{formatMinutes(missing)} missing on {DAY_LONG[dow(short.date)]}</h2>
              <p className="tm-why">{draftCells.length ? `${draftCells[0].why}. Log it and the week is complete.` : `You logged ${formatMinutes(short.minutes)} of ${formatMinutes(short.targetMinutes)}. Add what you worked on.`}</p>
            </>
          ) : (
            <>
              <h2>{st?.canSubmit && total > 0 ? 'Your week is ready to submit' : total ? 'Nothing missing so far' : 'Nothing logged yet this week'}</h2>
              <p className="tm-why">{total ? `${formatMinutes(total)} of ${formatMinutes(target)}, ${billable}% billable.` : 'Say what you did, like “3h on ATL-482 today, 1h call”.'}</p>
            </>
          )}
          {words !== null ? (
            <form className="tm-words" onSubmit={(e) => { e.preventDefault(); void readWords(); }}>
              <input autoFocus value={words} onChange={(e) => setWords(e.target.value)} placeholder="“35m on Orbit review prep Monday”" aria-label="Log time in words" />
              <CalmGo type="submit" disabled={busy || !words.trim()}>Log</CalmGo>
              <CalmLink onClick={() => setWords(null)}>Cancel</CalmLink>
            </form>
          ) : (
            <div className="tm-acts">
              {short && draftCells.length > 0 ? <CalmGo onClick={() => void logDraft()} disabled={busy}>Log {formatMinutes(draftMinutes)}</CalmGo> : <CalmGo onClick={() => setWords('')}>Log time</CalmGo>}
              {short && draftCells.length > 0 && <CalmLink onClick={() => setWords('')}>Something else</CalmLink>}
              {st?.canSubmit && <CalmLink onClick={() => setReviewing(true)}>Submit week ›</CalmLink>}
            </div>
          )}
        </CalmCard>
        <div className="tm-req">
          <button type="button" className="tm-pill" onClick={() => openApprovalRequest({ type: 'AttendanceCorrection', payload: short ? { day: short.date } : {}, links: [timesheetLink] })}><Icon name="clock" size={14} />Request attendance correction</button>
          <button type="button" className="tm-pill" onClick={() => openApprovalRequest({ type: 'Leave', links: [timesheetLink] })}><Icon name="sun" size={14} />Request leave</button>
          <span className="tm-req-note">Both go to Approvals{chainNames ? ` · ${chainNames}` : ''}</span>
        </div>
        <div className="tm-sec"><span>{mode === 'week' ? `This week · target ${formatMinutes(Math.round(target / Math.max(1, weekdays.filter((d) => !d.weekend).length)))} a day` : 'The last weeks'}</span><Link className="tm-lk" to={`/insights?tab=time&s=${mode === 'week' ? 'week' : 'insights'}`}>Timesheet ›</Link></div>
        {mode === 'week' ? (
          <>
            <div className="tm-rib" role="img" aria-label={ribbonDays.map((d) => `${DAY[dow(d.date)]} ${formatMinutes(d.minutes)}`).join(', ')}>
              {ribbonDays.map((d) => {
                const col = d.leave ? 'var(--calm-fill-2)' : d.date > today ? 'transparent' : d.date === today ? '#bcd6ff' : d.minutes < d.targetMinutes ? ribbonColors.admin : ribbonColors.light;
                return <span key={d.date} style={{ flex: Math.max(d.minutes, 60), background: col }} className={d.date > today ? 'future' : ''}><b>{DAY[dow(d.date)]} {d.leave ? 'leave' : d.minutes ? formatMinutes(d.minutes) : ''}</b></span>;
              })}
            </div>
            <div className="tm-rib-axis" aria-hidden="true">{ribbonDays.map((d) => <span key={d.date} style={{ flex: Math.max(d.minutes, 60) }}>{DAY[dow(d.date)]}</span>)}</div>
          </>
        ) : (
          <div className="tm-rib" role="img" aria-label="Weeks">
            {monthWeeks.map((w) => <span key={w.weekStart} style={{ flex: Math.max(w.loggedMinutes, 60), background: w.loggedMinutes >= w.targetMinutes ? ribbonColors.light : ribbonColors.admin }}><b>{new Date(`${w.weekStart}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} {formatMinutes(w.loggedMinutes)}</b></span>)}
          </div>
        )}
        <CalmCard variant="list" className="tm-projects">
          {projects.length === 0 && <div className="tm-note pad">No time on projects yet this week.</div>}
          {projects.map((p) => (
            <Link key={p.id ?? p.name} to={p.id ? `/work/projects/${p.id}` : '/insights?tab=time&s=week'} className="tm-prow">
              <CalmDot color={projectColor(p.id ?? p.name)} />
              <span className="tm-pt"><b>{p.name}</b><small>{p.what.join(', ')}</small></span>
              <span className="tm-pv">{formatMinutes(p.minutes)}</span>
              <Icon name="chevronR" size={14} />
            </Link>
          ))}
        </CalmCard>
        <CalmFoot>
          <CalmInsights items={[
            { key: 'billable', label: `${billable}% billable`, href: '/insights?tab=time&s=insights' },
            { key: 'timer', label: running ? `Timer on ${running.taskKey}` : 'Timer off', onClick: () => void timer() },
            ...(streak ? [{ key: 'streak', label: `${streak}-day streak`, href: '/insights?tab=time&s=insights' }] : []),
          ]} />
          {lowDay && <AuraLine text={`You usually log least on ${DAY_LONG[lowDay.day]}s.`} action={`Remind me at 17:30?`} onAction={() => void remindLow()} />}
        </CalmFoot>
      </CalmSplit>
      {reviewing && <ReviewDrawer week={week} onClose={() => setReviewing(false)} onLog={() => { setReviewing(false); setWords(''); }} onSubmitted={() => { setReviewing(false); refresh(); }} />}
      {parsed && <TimeWordsReview parsed={parsed} onClose={() => setParsed(null)} onLogged={() => { setParsed(null); setWords(null); refresh(); }} />}
    </div>
  );
}

export default TimePage;
