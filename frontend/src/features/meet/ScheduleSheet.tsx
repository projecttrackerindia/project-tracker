import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { connectedAccountsApi, meetingApi, projectApi, teamApi, type MeetingRepeatInput, type NotetakerChoice } from '../../api/endpoints';
import type { MeetingParticipant, MeetingProvider } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Avatar, Modal } from '../../components/ui';
import { TimeZonePicker } from '../../components/TimeZonePicker';
import { invalidateWorkspace, useDebounced, useWsQuery } from '../../lib/hooks';
import { appZone, zonedParts } from '../../lib/zone';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { connectApi } from './meetApi';
import { NotetakerPicker } from './NotetakerPicker';
import { resolveOwner } from './quickLine';
import { useScheduleSheet, type ScheduleOpen } from './scheduleStore';
import { zonedTimeToUtc } from './timezone';
import './meet.css';
import './connect.css';

type Repeat = 'Once' | 'Daily' | 'Weekly' | 'Monthly' | 'Custom';
type Video = 'inapp' | 'teams' | 'meet' | 'zoho' | 'none';
const VIDEOS: { key: Video; label: string }[] = [{ key: 'inapp', label: 'In-app' }, { key: 'teams', label: 'Teams' }, { key: 'meet', label: 'Meet' }, { key: 'zoho', label: 'Zoho' }, { key: 'none', label: 'None' }];
const DURATIONS = [30, 45, 60];
const WEEK = [['MO', 'M', 'Mon'], ['TU', 'T', 'Tue'], ['WE', 'W', 'Wed'], ['TH', 'T', 'Thu'], ['FR', 'F', 'Fri'], ['SA', 'S', 'Sat'], ['SU', 'S', 'Sun']] as const;
const SCRUM_AGENDA = 'Progress since the last stand-up\nPriorities for today\nBlockers and help needed';
const REVIEW_LINE = 'Review action items since last';
const NOT_CONNECTED = ['GOOGLE_NOT_CONNECTED', 'MICROSOFT_NOT_CONNECTED', 'CALLS_UNAVAILABLE'];

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const dur = (m: number) => (m % 60 === 0 ? `${m / 60}h` : m > 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
const pad = (n: number) => String(n).padStart(2, '0');
const ordinal = (n: number) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
const dayCode = (iso: string) => WEEK[(new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7][0];
const short = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const addDaysIso = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

type Ready = { title: string; meetUri: string; provider?: MeetingProvider; providerName?: string };
type Person = { id: string; name: string };
type TeamPick = { id: string; name: string; count: number };

/**
 * The one schedule sheet (design: meet-schedule): title, project, attendees (people and whole teams), when with everyone's free/busy,
 * duration, repeats (once, daily, weekly, monthly, custom; ending on the project's due date by default), how people join, the notetaker
 * and the agenda. Opened from the Aura chip (the sentence read into the fields), a Calendar drag, a project, My Work and Messages.
 */
export function ScheduleSheet({ open, onClose }: { open: ScheduleOpen; onClose: () => void }) {
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx?.user.id);
  const workspaceName = useAuth((s) => s.ctx?.current?.name ?? 'Team');
  const isGuest = useAuth((s) => s.ctx?.current?.role === 'Guest');
  const [kind, setKind] = useState<'meeting' | 'scrum'>(open.kind ?? 'meeting');
  const [project, setProject] = useState<{ id: string; name: string } | null>(open.project ?? null);
  const [title, setTitle] = useState(open.title?.trim() || (open.kind === 'scrum' ? `${open.project?.name ?? workspaceName} stand-up` : ''));
  const [titleEdited, setTitleEdited] = useState(!!open.title?.trim());
  const [tz, setTz] = useState(appZone());
  const [showZone, setShowZone] = useState(false);
  const initial = useMemo(() => {
    const at = open.start ? new Date(open.start) : new Date(Math.ceil((Date.now() + 30 * 60_000) / (30 * 60_000)) * 30 * 60_000);
    const p = zonedParts(at, tz);
    return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [minutes, setMinutes] = useState(open.minutes ?? (open.kind === 'scrum' ? 15 : 30));
  const [repeat, setRepeat] = useState<Repeat>(open.repeat ?? (open.kind === 'scrum' ? 'Daily' : 'Once'));
  const [weekdaysOnly, setWeekdaysOnly] = useState(open.kind === 'scrum');
  const [days, setDays] = useState<string[]>([dayCode(initial.date)]);
  const [interval, setInterval] = useState(1);
  const [ends, setEnds] = useState<'until' | 'count'>('until');
  const [until, setUntil] = useState<string | null>(null);
  const [count, setCount] = useState(10);
  const [video, setVideo] = useState<Video>('inapp');
  const videoTouched = useRef(false);
  // How people join starts from the organizer's own choice of meeting service (Settings › Connected accounts): Google → Meet, Outlook → Teams.
  const accounts = useWsQuery(['account', 'connected'], connectedAccountsApi.get, { staleTime: 60_000, retry: false });
  useEffect(() => {
    const p = accounts.data?.meetings?.provider;
    if (videoTouched.current || !p) return;
    setVideo(p === 'google' ? 'meet' : p === 'microsoft' ? 'teams' : 'inapp');
  }, [accounts.data]);
  const [videoUrl, setVideoUrl] = useState('');
  const [notetaker, setNotetaker] = useState<NotetakerChoice>('off');
  const [agenda, setAgenda] = useState(open.agenda?.trim() ?? (open.kind === 'scrum' ? SCRUM_AGENDA : ''));
  const [people, setPeople] = useState<Person[]>([]);
  const [teams, setTeams] = useState<TeamPick[]>([]);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsConnect, setNeedsConnect] = useState<string | null>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const pickedFromWords = useRef(false);

  // ------------------------------------------------------------ lists
  const [projectQuery] = useState('');
  const dq = useDebounced(projectQuery, 250);
  const projects = useWsQuery(['projects', 'meeting-picker', dq], () => projectApi.list({ q: dq || undefined, pageSize: 50 }), { staleTime: 60_000 });
  const projectList = useMemo(() => {
    const items = (projects.data?.items ?? []).map((p) => ({ id: p.id, key: p.key as string, name: p.name, dueDate: p.dueDate }));
    return project && !items.some((p) => p.id === project.id) ? [{ id: project.id, key: '', name: project.name, dueDate: null as string | null }, ...items] : items;
  }, [projects.data, project]);
  const due = projectList.find((p) => p.id === project?.id)?.dueDate ?? null;
  const eligible = useWsQuery(['meetings', 'participants', project?.id ?? 'workspace'], () => (project ? meetingApi.participants(project.id) : meetingApi.workspaceParticipants()), { staleTime: 60_000, enabled: !!project || !isGuest });
  const allTeams = useWsQuery(['teams'], teamApi.list, { staleTime: 5 * 60_000, retry: false, enabled: !isGuest });
  const candidates: Person[] = useMemo(() => (eligible.data ?? []).filter((p): p is MeetingParticipant & { userId: string } => !!p.userId && p.userId !== me).map((p) => ({ id: p.userId, name: p.name })), [eligible.data, me]);

  // A project's meeting invites only people who can see the project: anyone picked who cannot is let go when the project changes. With
  // nobody picked yet (and no names said to Aura), a project's meeting starts with its people, as it always has.
  const touchedPeople = useRef(false);
  useEffect(() => {
    if (!eligible.data) return;
    const ok = new Set(candidates.map((c) => c.id));
    setPeople((list) => {
      if (project && list.length === 0 && !touchedPeople.current && !open.people?.length) return candidates;
      return list.every((p) => ok.has(p.id)) ? list : list.filter((p) => ok.has(p.id));
    });
  }, [eligible.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // The names said to Aura ("with Mira and AutoPay team"), picked once the lists are here.
  useEffect(() => {
    if (pickedFromWords.current || !open.people?.length || !eligible.data) return;
    pickedFromWords.current = true;
    const ps: Person[] = []; const ts: TeamPick[] = [];
    for (const word of open.people) {
      const teamWord = word.replace(/\s+team$/i, '').trim();
      const team = (allTeams.data ?? []).find((t) => t.name.toLowerCase() === teamWord.toLowerCase());
      if (team) { ts.push({ id: team.id, name: team.name, count: team.memberCount }); continue; }
      const hit = resolveOwner(word, candidates).person;
      if (hit && !ps.some((p) => p.id === hit.id)) ps.push(hit);
    }
    setPeople(ps); setTeams(ts);
  }, [eligible.data, allTeams.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // The series ends on the project's due date unless changed; with no project (or a date already past), after eight weeks.
  const defaultUntil = due && due > date ? due : addDaysIso(date, 56);
  const untilDate = until ?? defaultUntil;

  // ------------------------------------------------------------ the instant, and who is free then
  const start = useMemo(() => {
    const [y, mo, d] = date.split('-').map(Number); const [h, mi] = time.split(':').map(Number);
    if (!y || !mo || !d || Number.isNaN(h) || Number.isNaN(mi)) return null;
    const s = zonedTimeToUtc(y, mo - 1, d, h, mi, tz);
    return Number.isNaN(s.getTime()) ? null : s;
  }, [date, time, tz]);
  const end = start ? new Date(start.getTime() + minutes * 60_000) : null;
  const askIds = [...people.map((p) => p.id), ...(me ? [me] : [])];
  const fb = useWsQuery(['meet', 'free-busy', askIds.join(','), teams.map((t) => t.id).join(','), start?.toISOString(), minutes],
    () => connectApi.freeBusy({ userIds: askIds, teamIds: teams.map((t) => t.id), from: new Date(start!.getTime() - 12 * 3600_000).toISOString(), to: new Date(start!.getTime() + 12 * 3600_000).toISOString(),
      slotStart: start!.toISOString(), slotEnd: end!.toISOString() }), { enabled: !!start && !!end, staleTime: 30_000, retry: false });
  const busyPeople = (fb.data?.people ?? []).filter((p) => !p.freeAtSlot);

  // ------------------------------------------------------------ choices
  const chooseKind = (k: typeof kind) => {
    setKind(k);
    if (!titleEdited) setTitle(k === 'scrum' ? `${project?.name ?? workspaceName} stand-up` : '');
    if (k === 'scrum') { setAgenda((a) => a || SCRUM_AGENDA); setMinutes(15); setRepeat((r) => (r === 'Once' ? 'Daily' : r)); setWeekdaysOnly(true); }
    else { setAgenda((a) => (a === SCRUM_AGENDA ? '' : a)); setMinutes(30); setWeekdaysOnly(false); }
  };
  const chooseProject = (id: string) => {
    const p = projectList.find((x) => x.id === id);
    setProject(p ? { id: p.id, name: p.name } : null);
    setUntil(null);
    if (!p) setNotetaker('off');
    if (!titleEdited && kind === 'scrum') setTitle(`${p?.name ?? workspaceName} stand-up`);
  };
  const toggleDay = (code: string) => setDays((d) => (d.includes(code) ? (d.length > 1 ? d.filter((x) => x !== code) : d) : [...d, code]));
  const addReviewLine = () => setAgenda((a) => {
    if (a.includes(REVIEW_LINE)) return a;
    const lines = a.split('\n').filter((l) => l.trim());
    const numbered = lines.length > 0 && lines.every((l) => /^\d+\.\s/.test(l));
    return [...lines, numbered ? `${lines.length + 1}. ${REVIEW_LINE}` : REVIEW_LINE].join('\n');
  });

  const repeatLine = useMemo(() => {
    if (repeat === 'Once') return null;
    const what = repeat === 'Daily' ? (weekdaysOnly ? 'Every weekday' : 'Every day')
      : repeat === 'Weekly' ? `Every ${WEEK.find((w) => w[0] === dayCode(date))![2]}`
        : repeat === 'Monthly' ? `Every month on the ${ordinal(Number(date.slice(8)))}`
          : `Every ${interval > 1 ? `${interval} weeks on ` : ''}${WEEK.filter((w) => days.includes(w[0])).map((w) => w[2]).join(', ')}`;
    const tail = ends === 'until' ? `until ${short(untilDate)}${due && untilDate === due && !until ? ' (project due)' : ''}` : `${count} sessions`;
    return `${what} · ${tail}`;
  }, [repeat, weekdaysOnly, date, interval, days, ends, untilDate, count, due, until]);

  const where = project ? `Shows in Calendar · My Work · Today · logs time to ${project.name}` : 'Shows in Calendar · My Work · Today';

  // ------------------------------------------------------------ schedule
  const submit = async () => {
    if (!project && isGuest) { setError('Choose a project for this meeting.'); return; }
    if (!title.trim()) { setError('Give the meeting a title.'); return; }
    if (!start || !end) { setError('Choose a date and a start time.'); return; }
    if (video === 'zoho' && !videoUrl.trim()) { setError('Paste the Zoho Meeting link people join with.'); return; }
    if (repeat !== 'Once' && ends === 'count' && (!Number.isInteger(count) || count < 2 || count > 120)) { setError('Choose 2 to 120 sessions, including the first.'); return; }
    const rep: MeetingRepeatInput | undefined = repeat === 'Once' ? undefined : {
      frequency: repeat === 'Daily' ? (weekdaysOnly ? 'Weekdays' : 'Daily') : repeat,
      occurrences: ends === 'count' ? count : 0,
      until: ends === 'until' ? untilDate : undefined,
      interval: repeat === 'Custom' ? interval : undefined,
      days: repeat === 'Custom' ? (days.includes(dayCode(date)) ? days : [...days, dayCode(date)]) : undefined,
    };
    const body = {
      title: title.trim(), description: agenda.trim() || undefined, startTime: start.toISOString(), endTime: end.toISOString(), timeZone: tz,
      participantUserIds: people.map((p) => p.id), teamIds: teams.length ? teams.map((t) => t.id) : undefined, repeat: rep, scrum: kind === 'scrum' || undefined,
      video, videoUrl: videoUrl.trim() || undefined,
    };
    setBusy(true); setError(null);
    try {
      const m = project ? await meetingApi.schedule(project.id, { ...body, notetaker }) : await meetingApi.scheduleForWorkspace(body);
      invalidateWorkspace(wid, 'meet'); invalidateWorkspace(wid, 'meetings'); invalidateWorkspace(wid, 'calendar'); invalidateWorkspace(wid, 'reminders'); invalidateWorkspace(wid, 'timeline');
      toast(repeat === 'Once' ? 'Scheduled. Everyone invited is told.' : 'Series scheduled. Everyone invited is told.');
      setReady({ title: m.title, meetUri: m.meetUri, provider: m.provider, providerName: m.providerName });
    } catch (e) {
      if (e instanceof ApiError && NOT_CONNECTED.includes(e.code)) setNeedsConnect(e.message);
      else setError(errText(e, "The meeting couldn't be scheduled. Try again."));
    } finally { setBusy(false); }
  };

  const heading = kind === 'scrum' ? 'Schedule a stand-up' : 'Schedule a meeting';
  if (ready) return <Modal title={heading} onClose={onClose} className="ms-overlay"><SheetReady ready={ready} video={video} videoUrl={videoUrl} onClose={onClose} /></Modal>;
  if (needsConnect) return (
    <Modal title={heading} onClose={onClose} className="ms-overlay">
      <div className="gm-connect"><Icon name="video" size={34} /><p>{needsConnect}</p>
        <div className="mt-row"><button type="button" className="btn btn-ghost" onClick={() => setNeedsConnect(null)}>Back</button><Link className="btn btn-primary" to="/account/integrations" onClick={onClose}>Open connected accounts</Link></div>
      </div>
    </Modal>
  );

  const f = filter.trim().toLowerCase();
  const peopleLeft = candidates.filter((p) => !people.some((x) => x.id === p.id) && (!f || p.name.toLowerCase().includes(f)));
  const teamsLeft = (allTeams.data ?? []).filter((t) => !teams.some((x) => x.id === t.id) && (!f || t.name.toLowerCase().includes(f)));

  return (
    <Modal title={heading} onClose={onClose} size="lg" className="ms-overlay"
      footer={<>
        <span className="ms-where">{where}</span>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>{busy && <span className="spinner" />}Schedule</button>
      </>}>
      <div className="ms" data-testid="schedule-sheet">
        <div className="ms-top">
          {open.aura && <span className="ms-aura" data-testid="schedule-from-aura">✦ From Aura: “{open.aura}”</span>}
          <div className="ms-kind" role="group" aria-label="Kind of meeting">
            <button type="button" aria-pressed={kind === 'meeting'} onClick={() => chooseKind('meeting')}>Meeting</button>
            <button type="button" aria-pressed={kind === 'scrum'} onClick={() => chooseKind('scrum')}>Stand-up</button>
          </div>
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <input className="ms-title" aria-label="Title" placeholder="Meeting title" value={title} maxLength={200} onChange={(e) => { setTitle(e.target.value); setTitleEdited(true); }} />

        <div className="ms-row">
          <span className="ms-lab" id="ms-project">Project</span>
          <div className="ms-val">
            <label className={`ms-chip ms-select${project ? ' on' : ''}`}>
              <span>{project?.name ?? (isGuest ? 'Choose a project…' : 'No project')}</span><Icon name="chevronD" size={12} />
              <select aria-label="Project" value={project?.id ?? ''} onChange={(e) => chooseProject(e.target.value)}>
                {isGuest ? (!project && <option value="" disabled>Choose a project…</option>) : <option value="">No project (whole workspace)</option>}
                {projectList.map((p) => <option key={p.id} value={p.id}>{p.key ? `${p.key} · ` : ''}{p.name}</option>)}
              </select>
            </label>
          </div>
        </div>

        <div className="ms-row">
          <span className="ms-lab">Attendees</span>
          <div className="ms-val ms-wrap" aria-label="Attendees">
            {people.map((p) => (
              <span key={p.id} className="ms-chip ms-person"><Avatar name={p.name} userId={p.id} size="sm" />{p.name}
                <button type="button" className="ms-x" aria-label={`Remove ${p.name}`} onClick={() => { touchedPeople.current = true; setPeople((l) => l.filter((x) => x.id !== p.id)); }}>×</button></span>
            ))}
            {teams.map((t) => (
              <span key={t.id} className="ms-chip ms-person"><i className="ms-team-dot" aria-hidden="true" />Team {t.name} · {t.count}
                <button type="button" className="ms-x" aria-label={`Remove team ${t.name}`} onClick={() => setTeams((l) => l.filter((x) => x.id !== t.id))}>×</button></span>
            ))}
            <div className="ms-add-wrap">
              <button type="button" className="ms-add" aria-haspopup="listbox" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>＋ Add</button>
              {adding && (
                <div className="ms-pop" role="listbox" aria-label="Add attendees">
                  <input className="input" autoFocus type="search" aria-label="Find people or teams" placeholder="People or teams" value={filter} onChange={(e) => setFilter(e.target.value)} />
                  {peopleLeft.length > 0 && people.length + 0 < candidates.length && !f && (
                    <button type="button" role="option" aria-selected={false} className="ms-opt all" onClick={() => { setPeople(candidates); setAdding(false); }}>Everyone {project ? 'on the project' : 'in the workspace'} ({candidates.length})</button>
                  )}
                  {teamsLeft.slice(0, 6).map((t) => (
                    <button key={t.id} type="button" role="option" aria-selected={false} className="ms-opt" onClick={() => { setTeams((l) => [...l, { id: t.id, name: t.name, count: t.memberCount }]); setFilter(''); }}>
                      <i className="ms-team-dot" aria-hidden="true" />Team {t.name}<small>{t.memberCount} people</small></button>
                  ))}
                  {peopleLeft.slice(0, 12).map((p) => (
                    <button key={p.id} type="button" role="option" aria-selected={false} className="ms-opt" onClick={() => { touchedPeople.current = true; setPeople((l) => [...l, p]); setFilter(''); }}>
                      <Avatar name={p.name} userId={p.id} size="sm" />{p.name}</button>
                  ))}
                  {peopleLeft.length === 0 && teamsLeft.length === 0 && <p className="ms-none">{f ? `No one matches “${filter}”.` : 'Everyone is added.'}</p>}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="ms-row">
          <span className="ms-lab">When</span>
          <div className="ms-val ms-wrap">
            <label className="ms-chip ms-field"><span>{dayLabel(date)}</span><input type="date" aria-label="Date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></label>
            <label className="ms-chip ms-field"><span>{time}</span><input type="time" aria-label="Start" value={time} onChange={(e) => e.target.value && setTime(e.target.value)} /></label>
            <span className="ms-for">for</span>
            <div className="ms-durs" role="radiogroup" aria-label="Duration">
              {[...new Set([...(minutes < 30 || !DURATIONS.includes(minutes) ? [minutes] : []), ...DURATIONS])].sort((a, b) => a - b).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={minutes === m} className={`ms-chip${minutes === m ? ' sel' : ''}`} onClick={() => setMinutes(m)}>{dur(m)}</button>
              ))}
              <label className="ms-more" title="Another length"><span className="sr-only">Other length</span>⋯
                <select aria-label="Other length" value="" onChange={(e) => e.target.value && setMinutes(Number(e.target.value))}>
                  <option value="">Other…</option>{[15, 20, 90, 120, 180].map((m) => <option key={m} value={m}>{dur(m)}</option>)}
                </select></label>
            </div>
            <span className={`ms-free${busyPeople.length ? ' busy' : ''}`} aria-live="polite" data-testid="free-busy">
              {fb.isLoading ? '…' : fb.data ? (busyPeople.length === 0 ? 'Everyone free' : busyPeople.length === 1 ? `${busyPeople[0].userId === me ? 'You are' : `${busyPeople[0].name.split(' ')[0]} is`} busy` : `${busyPeople.length} people busy`) : ''}
            </span>
            <button type="button" className="ms-zone" onClick={() => setShowZone((v) => !v)} aria-expanded={showZone}>{tz}</button>
          </div>
        </div>
        {showZone && <div className="ms-row ms-sub"><span className="ms-lab" /><div className="ms-val"><TimeZonePicker value={tz} onChange={(z) => z && setTz(z)} label="Time zone" /></div></div>}

        <div className="ms-row">
          <span className="ms-lab">Repeats</span>
          <div className="ms-val">
            <div className="ms-seg" role="radiogroup" aria-label="Repeats">
              {(['Once', 'Daily', 'Weekly', 'Monthly', 'Custom'] as Repeat[]).map((r) => (
                <button key={r} type="button" role="radio" aria-checked={repeat === r} className={repeat === r ? 'on' : ''} onClick={() => { setRepeat(r); if (r === 'Custom' && !days.length) setDays([dayCode(date)]); }}>{r}</button>
              ))}
            </div>
            {repeat !== 'Once' && <>
              {repeat === 'Daily' && <label className="ms-check"><input type="checkbox" checked={weekdaysOnly} onChange={(e) => setWeekdaysOnly(e.target.checked)} /> Weekdays only</label>}
              {repeat === 'Custom' && (
                <div className="ms-custom">
                  <label>Every <select aria-label="Every how many weeks" value={interval} onChange={(e) => setInterval(Number(e.target.value))}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n === 1 ? 'week' : `${n} weeks`}</option>)}</select> on</label>
                  <div className="ms-days" role="group" aria-label="Days">
                    {WEEK.map(([code, letter, name]) => <button key={code} type="button" aria-pressed={days.includes(code)} aria-label={name} onClick={() => toggleDay(code)}>{letter}</button>)}
                  </div>
                </div>
              )}
              <div className="ms-ends">
                <span>Ends</span>
                <label className="ms-radio"><input type="radio" name="ms-ends" checked={ends === 'until'} onChange={() => setEnds('until')} /> on <input type="date" aria-label="Last day" value={untilDate} min={date} onChange={(e) => e.target.value && setUntil(e.target.value)} /></label>
                <label className="ms-radio"><input type="radio" name="ms-ends" checked={ends === 'count'} onChange={() => setEnds('count')} /> after <input type="number" aria-label="Total sessions" min={2} max={120} value={count} onFocus={() => setEnds('count')} onChange={(e) => { setCount(Number(e.target.value)); setEnds('count'); }} /> sessions</label>
              </div>
              <p className="ms-hint" data-testid="repeat-line">{repeatLine}</p>
            </>}
          </div>
        </div>

        <div className="ms-row">
          <span className="ms-lab">Video</span>
          <div className="ms-val">
            <div className="ms-seg" role="radiogroup" aria-label="Video">
              {VIDEOS.map((v) => <button key={v.key} type="button" role="radio" aria-checked={video === v.key} className={video === v.key ? 'on' : ''} onClick={() => { videoTouched.current = true; setVideo(v.key); }}>{v.label}</button>)}
            </div>
            {(video === 'teams' || video === 'meet' || video === 'zoho') && (
              <input className="input ms-link" type="url" aria-label="Meeting link" placeholder={video === 'zoho' ? 'Paste the Zoho Meeting link' : `Paste a ${video === 'teams' ? 'Teams' : 'Meet'} link, or leave empty to create one in your ${video === 'teams' ? 'Outlook' : 'Google'} calendar`}
                value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} />
            )}
          </div>
        </div>

        {project && (
          <div className="ms-row">
            <span className="ms-lab">Notetaker</span>
            <div className="ms-val ms-notetaker"><NotetakerPicker projectId={project.id} value={notetaker} onChange={setNotetaker} /></div>
          </div>
        )}

        <div className="ms-row ms-last">
          <span className="ms-lab">Agenda</span>
          <div className="ms-val">
            <textarea className="ms-agenda" rows={3} aria-label="Agenda" placeholder="1. What we decide today" value={agenda} maxLength={4000} onChange={(e) => setAgenda(e.target.value)} />
            {!agenda.includes(REVIEW_LINE) && <button type="button" className="ms-addline" onClick={addReviewLine}>＋ {REVIEW_LINE}</button>}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Once it is scheduled: the join link (our own call opens here; Teams, Meet and Zoho in their own tab). */
function SheetReady({ ready, video, videoUrl, onClose }: { ready: Ready; video: Video; videoUrl: string; onClose: () => void }) {
  const ours = ready.provider === 'ours' && !videoUrl.trim();
  const link = videoUrl.trim() || ready.meetUri;
  const slug = window.location.pathname.split('/').filter(Boolean)[0];
  const shareable = ours ? `${window.location.origin}${slug ? `/${slug}` : ''}${link}` : link;
  const copy = async () => { try { await navigator.clipboard.writeText(shareable); toast('Meeting link copied.'); } catch { toast('Could not copy. Select the text and copy it by hand.', 'warning'); } };
  return (
    <div className="gm-ready" data-testid="meeting-ready">
      <Icon name="checkCircle" size={34} />
      <h4>{ours ? ready.providerName ?? 'Meeting' : 'Meeting'} ready</h4>
      <p className="muted">{ready.title}</p>
      {video !== 'none' && (ours
        ? <Link className="btn btn-primary btn-lg" to={link} onClick={onClose}><Icon name="video" size={16} /> Join Meeting</Link>
        : <a className="btn btn-primary btn-lg" href={link} target="_blank" rel="noopener noreferrer"><Icon name="video" size={16} /> Join Meeting</a>)}
      {video !== 'none' && <div className="gm-link-row"><code>{shareable}</code><button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}><Icon name="copy" size={14} /> Copy link</button></div>}
      <p className="ms-hint">It shows in Calendar, My Work and Today for everyone invited{ready.providerName && !ours ? ` · ${ready.providerName}` : ''}.</p>
      <button type="button" className="btn btn-ghost" style={{ marginTop: 14 }} onClick={onClose}>Done</button>
    </div>
  );
}

/** Mounted once in the app: the sheet opened with openSchedule() from anywhere. */
export function ScheduleHost() {
  const open = useScheduleSheet((s) => s.open);
  const close = useScheduleSheet((s) => s.close);
  return open ? <ScheduleSheet open={open} onClose={close} /> : null;
}
