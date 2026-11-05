import { useEffect, useMemo, useState } from 'react';
import { meetingApi, workspaceApi } from '../../api/endpoints';
import { Face } from '../../components/Face';
import { Icon } from '../../components/Icon';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { appZone, instantIn } from '../../lib/zone';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { connectApi } from '../meet/meetApi';
import { openSchedule } from '../meet/scheduleStore';
import { CalPicker } from './CalPicker';
import { editError, isoAt, refreshAfterEdit } from './calendarEdit';
import { parseQuick } from './calpro';
import type { DetailActions } from './EventDetail';
import { MONTHS, SNAP, dateOf, dayLabel, fmtMins } from './plannerModel';
import { TimeEntryEditor } from './TimeEntryEditor';

const hm = (h: number) => { const m = Math.round(h * 60); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const SLOTS = Array.from({ length: 96 }, (_, i) => i * SNAP);
const longDay = (day: string) => { const d = dateOf(day); return `${d.toLocaleDateString('en-GB', { weekday: 'long' })}, ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
type Tab = 'meet' | 'focus' | 'log';

/**
 * Quick create (the floating card a click or drag on empty time opens, like the references): a title that understands a sentence
 * ("Review with Ravi tomorrow 3pm 45m"), the date and start / end, then what it becomes as chips: a Meeting (link, attendees with their
 * free/busy and "Find a time"), Focus on one of your open items (a searchable picker), or Log time (time that has happened).
 * "Add event" writes the real record; "⋯" opens the full scheduler (repeats, a project, teams).
 */
export function QuickCreate({ day: day0, start: start0, end: end0, title: title0, today, nowH, actions, onClose }: {
  day: string; start: number; end: number; title?: string; today: string; nowH: number; actions: DetailActions; onClose: () => void;
}) {
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx?.user);
  const [day, setDay] = useState(day0);
  const [start, setStart] = useState(start0);
  const [end, setEnd] = useState(Math.max(end0, start0 + SNAP));
  const past = day < today || (day === today && start < nowH);
  const future = day > today || (day === today && end > nowH);
  const [tab, setTab] = useState<Tab>(past && !future ? 'log' : 'meet');
  const [title, setTitle] = useState(title0 ?? '');
  const [link, setLink] = useState('');
  const [who, setWho] = useState<string[]>([]);
  const [proj, setProj] = useState<string | null>(null);
  const preview = actions.previewSpan;
  useEffect(() => { preview?.(day, start, end); }, [preview, day, start, end]);
  const items = actions.openItems ?? [];
  const [item, setItem] = useState(items[0] ? `${items[0].type}:${items[0].id}` : '');
  const [busy, setBusy] = useState(false);
  const members = useWsQuery(['members'], () => workspaceApi.members(), { staleTime: 5 * 60_000, retry: false, enabled: tab === 'meet' });
  const people = useMemo(() => (members.data ?? []).filter((m) => m.userId !== me?.id).map((m) => ({ id: m.userId, label: m.displayName, hint: m.email ?? null })), [members.data, me?.id]);
  const nameOf = (id: string) => people.find((p) => p.id === id)?.label ?? 'Someone';
  // Attendees' free/busy over the whole day, so the card can say who is busy at the chosen time and find the first time everyone is free.
  const fb = useWsQuery(['meet', 'free-busy', 'cal', who.join(','), day], () => connectApi.freeBusy({ userIds: who, from: instantIn(day, 0).toISOString(), to: instantIn(day, 24).toISOString() }),
    { enabled: tab === 'meet' && who.length > 0, staleTime: 30_000, retry: false });
  const busyAt = (a: number, b: number) => (fb.data?.people ?? []).filter((p) => p.busy.some((x) => Date.parse(x.start) < instantIn(day, b).getTime() && Date.parse(x.end) > instantIn(day, a).getTime()));
  const clash = who.length ? busyAt(start, end) : [];
  const findTime = () => {
    const len = end - start;
    const from = day === today ? Math.max(9, Math.ceil(nowH * 4) / 4) : 9;
    for (let a = from; a + len <= 18 + 1e-9; a += SNAP) if (busyAt(a, a + len).length === 0) { setStart(a); setEnd(a + len); toast(`Everyone is free at ${hm(a)}.`, 'success'); return; }
    toast('No time between 9:00 and 18:00 works for everyone that day.', 'info');
  };
  const read = (text: string) => {
    setTitle(text);
    const q = parseQuick(text, today, start);
    if (q.dayGiven) setDay(q.day);
    if (q.timeGiven || /\d\s*(m|h|min|hr)/i.test(text)) { setStart(q.timeGiven ? q.start : start); setEnd(Math.min(24, (q.timeGiven ? q.start : start) + q.minutes / 60)); }
    if (q.people.length && people.length) {
      const found = q.people.map((n) => people.find((p) => p.label.toLowerCase().startsWith(n.toLowerCase()))?.id).filter((x): x is string => !!x);
      if (found.length) setWho((w) => [...new Set([...w, ...found])]);
    }
  };
  const clean = () => { const q = parseQuick(title, today, start); return (q.dayGiven || q.timeGiven) && q.title ? q.title : title.trim(); };
  const schedule = async () => {
    const t = clean();
    if (!t) return;
    setBusy(true);
    try {
      const body = { title: t, startTime: isoAt(day, start), endTime: isoAt(day, end), timeZone: appZone(), service: 'ours' as const,
        participantUserIds: who.length ? who : undefined, ...(link.trim() ? { video: /meet\.google/i.test(link) ? 'meet' as const : /teams\./i.test(link) ? 'teams' as const : 'none' as const, videoUrl: /^https?:/i.test(link.trim()) ? link.trim() : undefined, description: /^https?:/i.test(link.trim()) ? undefined : `Where: ${link.trim()}` } : {}) };
      if (proj) await meetingApi.schedule(proj, body); else await meetingApi.scheduleForWorkspace(body);
      toast(`✓ ${t} added ${dayLabel(day, today).toLowerCase()} ${hm(start)}.`, 'success');
      void invalidateWorkspace(wid, 'meet'); refreshAfterEdit(wid);
      onClose();
    } catch (err) { toast(editError(err, 'The meeting could not be scheduled.'), 'error'); }
    finally { setBusy(false); }
  };
  const logEnd = day === today ? Math.min(end, Math.floor(nowH * 4) / 4) : end;
  const setS = (v: number) => { const len = end - start; setStart(v); setEnd(Math.min(24, v + len)); };

  return (
    <div className="qc" data-testid="quick-create">
      <input className="qc-title" aria-label="Meeting title" data-testid="qc-title" autoFocus maxLength={200} value={title}
        placeholder="Add title — try “Review with Ravi tomorrow 3pm 45m”"
        onChange={(e) => read(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && tab === 'meet' && title.trim()) { e.preventDefault(); void schedule(); } }} />
      <div className="qc-when">
        <label className="qc-field qc-date"><Icon name="calendar" size={14} /><span className="sr-only">Date</span>
          <input type="date" aria-label="Date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} /><em aria-hidden="true">{longDay(day)}</em></label>
        <div className="qc-times">
          <label className="qc-field"><Icon name="clock" size={14} /><span className="sr-only">Starts</span>
            <select aria-label="Starts" value={start} onChange={(e) => setS(Number(e.target.value))}>{SLOTS.map((h) => <option key={h} value={h}>{hm(h)}</option>)}</select></label>
          <label className="qc-field"><span className="sr-only">Ends</span>
            <select aria-label="Ends" value={end} onChange={(e) => setEnd(Number(e.target.value))}>{SLOTS.filter((h) => h > start).concat(24).map((h) => <option key={h} value={h}>{h === 24 ? '24:00' : hm(h)}</option>)}</select></label>
          <span className="qc-len">{fmtMins(Math.round((end - start) * 60))}</span>
        </div>
      </div>
      <div className="qc-chips" role="tablist" aria-label="Make it">
        {([['meet', 'Meeting', 'Schedule meeting'], ['focus', 'Focus', 'Plan focus'], ['log', 'Log time', 'Log time']] as const).map(([k, label, aria]) => (
          <button key={k} type="button" role="tab" className={`qc-chip ${k}`} aria-label={aria} aria-selected={tab === k}
            disabled={(k === 'log' && !past) || (k === 'meet' && day < today)} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {tab === 'meet' && (
        <form className="ed-pick qc-meet" data-testid="ed-meet-form" onSubmit={(e) => { e.preventDefault(); if (title.trim()) void schedule(); }}>
          <label className="qc-field wide"><Icon name="link" size={14} /><input aria-label="Location or meeting link" value={link} maxLength={500} placeholder="Location or meet link" onChange={(e) => setLink(e.target.value)} /></label>
          {(actions.projects?.length ?? 0) > 0 && (
            <div className="qc-proj wide" role="group" aria-label="Calendar">
              {actions.projects!.map((p) => (
                <button key={p.id} type="button" aria-pressed={proj === p.id} title={p.name} style={{ ['--ck' as string]: p.colour }} onClick={() => setProj((x) => (x === p.id ? null : p.id))}><i aria-hidden="true" /><span>{p.name}</span></button>
              ))}
            </div>
          )}
          <div className="qc-people wide">
            <div className="qc-faces" aria-label="Attendees">
              {me && <Face userId={me.id} name={me.displayName} title={`${me.displayName} (you)`} />}
              {who.map((id) => <button key={id} type="button" className="qc-face" title={`Remove ${nameOf(id)}`} aria-label={`Remove ${nameOf(id)}`} onClick={() => setWho((w) => w.filter((x) => x !== id))}><Face userId={id} name={nameOf(id)} /></button>)}
            </div>
            <CalPicker label="Add attendees" placeholder="Add people…" multiple values={who} items={people} testId="qc-people"
              onChange={(id) => setWho((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id]))} />
          </div>
          {who.length > 0 && (
            <p className={`qc-fb wide${clash.length ? ' busy' : ''}`} data-testid="qc-freebusy" aria-live="polite">
              {fb.isLoading ? 'Checking calendars…' : clash.length ? `${clash.map((p) => p.name.split(' ')[0]).join(', ')} ${clash.length === 1 ? 'is' : 'are'} busy then.` : 'Everyone is free.'}
              <button type="button" className="link" onClick={findTime} disabled={!fb.data}>Find a time</button>
            </p>
          )}
          <div className="qc-act wide">
            <button type="submit" className="qc-add" data-testid="qc-add" disabled={busy || !title.trim()}>{busy ? 'Adding…' : 'Add event'}</button>
            <button type="button" className="qc-more" data-testid="ed-meet-more" aria-label="More options: repeats, a project, teams"
              onClick={() => { onClose(); openSchedule({ title: clean() || null, start: isoAt(day, start), minutes: Math.max(15, Math.round((end - start) * 60)) }); }}>⋯</button>
          </div>
        </form>
      )}
      {tab === 'focus' && (items.length === 0 ? <p className="ed-note">No open work due this week to plan focus on.</p> : (
        <form className="ed-pick" data-testid="ed-focus-form" onSubmit={(e) => { e.preventDefault(); const it = items.find((x) => `${x.type}:${x.id}` === item); if (it && actions.planFocus) { actions.planFocus(it, day, start, end); onClose(); } }}>
          <label className="wide"><span>Focus on</span>
            <CalPicker label="Focus on" placeholder="Search your work…" value={item} onChange={setItem}
              items={items.map((x) => ({ id: `${x.type}:${x.id}`, label: `${x.key ? `${x.key} · ` : ''}${x.title}`, hint: x.projectName }))} /></label>
          <div className="qc-act wide"><button type="submit" className="qc-add">Plan focus</button><button type="button" className="ed-btn ghost" onClick={onClose}>Cancel</button></div>
        </form>
      ))}
      {tab === 'log' && past && <TimeEntryEditor key={`${day}:${start}:${end}`} entry={null} day={day} start={start} end={Math.max(logEnd, start + SNAP)} choices={actions.choices ?? []} today={today} onCancel={onClose} onDone={onClose} />}
    </div>
  );
}
