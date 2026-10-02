import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { insightApi, workspaceApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Modal, SubmitButton } from '../../components/ui';
import { useWsQuery, useDebounced } from '../../lib/hooks';
import { useAuth, useIsPersonal, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { reminderApi, type ReminderSubject, type ReminderTarget, type SaveReminder } from './api';
import { refreshReminders, useReminderComposer, type ComposerDraft } from './store';
import {
  addDays, addMinutes, atTime, dayFirst, describeLocal, deviceZone, firstOccurrence, fromIso, fromRRule, hhmm, isoDate, iso, parseHm,
  parseReminder, relative, ruleText, toRRule, wall, type Parsed, type Rule,
} from './time';

type Mode = 'at' | 'repeat' | 'anchor';
const DAYS = [{ d: 1, l: 'Mon' }, { d: 2, l: 'Tue' }, { d: 3, l: 'Wed' }, { d: 4, l: 'Thu' }, { d: 5, l: 'Fri' }, { d: 6, l: 'Sat' }, { d: 0, l: 'Sun' }];
type RepeatKind = 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly' | 'lastworking';
const HIT_TYPES: Record<string, ReminderTarget> = { task: 'Task', issue: 'Issue', action: 'ActionItem', work: 'Operational' };

function kindOf(r: Rule): RepeatKind {
  if (r.freq === 'DAILY') return 'daily';
  if (r.freq === 'MONTHLY') return r.lastWorkingDay ? 'lastworking' : 'monthly';
  if (r.interval === 2) return 'biweekly';
  return r.byDay.length === 5 && [1, 2, 3, 4, 5].every((d) => r.byDay.includes(d)) ? 'weekdays' : 'weekly';
}

function ruleOf(kind: RepeatKind, days: number[], monthDay: number): Rule {
  switch (kind) {
    case 'daily': return { freq: 'DAILY', interval: 1, byDay: [], byMonthDay: null, lastWorkingDay: false };
    case 'weekdays': return { freq: 'WEEKLY', interval: 1, byDay: [1, 2, 3, 4, 5], byMonthDay: null, lastWorkingDay: false };
    case 'weekly': return { freq: 'WEEKLY', interval: 1, byDay: days.length ? days : [1], byMonthDay: null, lastWorkingDay: false };
    case 'biweekly': return { freq: 'WEEKLY', interval: 2, byDay: days.length ? days : [1], byMonthDay: null, lastWorkingDay: false };
    case 'monthly': return { freq: 'MONTHLY', interval: 1, byDay: [], byMonthDay: monthDay, lastWorkingDay: false };
    default: return { freq: 'MONTHLY', interval: 1, byDay: [], byMonthDay: null, lastWorkingDay: true };
  }
}

/** Renders the reminder form while one is open (mounted once, in the app shell). */
export function ReminderComposerHost() {
  const draft = useReminderComposer((s) => s.draft);
  const close = useReminderComposer((s) => s.close);
  return draft ? <Composer draft={draft} onClose={close} /> : null;
}

function Composer({ draft, onClose }: { draft: ComposerDraft; onClose: () => void }) {
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx?.user.id);
  const personal = useIsPersonal();
  const zone = deviceZone();
  const now = useMemo(() => wall(new Date(), zone), [zone]);
  const editing = draft.editing;
  const settings = useWsQuery(['reminders', 'settings'], reminderApi.settings, { staleTime: 300_000 });
  const insights = useWsQuery(['reminders', 'insights'], reminderApi.insights, { staleTime: 300_000 });
  const defaultTime = settings.data?.defaultTime ?? '09:00';
  const members = useWsQuery(['members'], () => workspaceApi.members(), { enabled: !personal, retry: false, staleTime: 300_000 });

  // ---- what
  const [title, setTitle] = useState(editing?.title ?? '');
  const [note, setNote] = useState(editing?.note ?? '');
  const [showNote, setShowNote] = useState(!!editing?.note);
  const [subject, setSubject] = useState<ReminderSubject | null>(draft.subject
    ?? (editing && editing.targetType !== 'None' && editing.targetId ? { type: editing.targetType, id: editing.targetId, title: editing.targetTitle ?? '', key: editing.targetKey } : null));

  // ---- when
  const soon = (() => { const n = addMinutes(now, 60); const r = n.getUTCMinutes() % 15; return addMinutes(n, r ? 15 - r : 0); })();
  const [mode, setMode] = useState<Mode>('at');
  const [date, setDate] = useState(isoDate(soon));
  const [time, setTime] = useState(hhmm(soon));
  const [repeat, setRepeat] = useState<RepeatKind>('weekly');
  const [days, setDays] = useState<number[]>([now.getUTCDay()]);
  const [monthDay, setMonthDay] = useState(now.getUTCDate());
  const [anchorDays, setAnchorDays] = useState(-1);
  const [touched, setTouched] = useState(!!editing);

  // ---- who and how
  const [forUser, setForUser] = useState(draft.forUserId ?? (editing?.for?.id ?? ''));
  const [onlyIfOpen, setOnlyIfOpen] = useState(editing?.onlyIfOpen ?? true);
  const [exact, setExact] = useState<boolean | null>(editing ? editing.exact : null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // Start from what the person typed elsewhere, or from the reminder being changed.
  useEffect(() => {
    if (editing) {
      const rule = fromRRule(editing.recurrence);
      const first = editing.localAt ? fromIso(editing.localAt) : null;
      if (rule && first) { setMode('repeat'); setRepeat(kindOf(rule)); setDays(rule.byDay.length ? rule.byDay : [first.getUTCDay()]); setMonthDay(rule.byMonthDay && rule.byMonthDay > 0 ? rule.byMonthDay : first.getUTCDate()); setTime(hhmm(first)); }
      else if (editing.anchorDays != null) { setMode('anchor'); setAnchorDays(editing.anchorDays); setTime(editing.anchorTime ?? defaultTime); }
      else if (editing.nextFireAt) { const n = wall(new Date(editing.nextFireAt), zone); setDate(isoDate(n)); setTime(hhmm(n)); }
      return;
    }
    if (draft.text) {
      const p = parseReminder(draft.text, now, { defaultTime, dayFirst: dayFirst() });
      if (p) apply(p); else setTitle(draft.text);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const typed = !editing && !touched && title.trim().length > 2 ? parseReminder(title, now, { defaultTime, dayFirst: dayFirst() }) : null;

  function apply(p: Parsed) {
    setTitle(p.title);
    setTouched(true);
    if (p.kind === 'at') { setMode('at'); setDate(isoDate(p.local)); setTime(hhmm(p.local)); }
    else if (p.kind === 'repeat') {
      setMode('repeat'); setRepeat(kindOf(p.rule)); setTime(hhmm(p.local));
      setDays(p.rule.byDay.length ? p.rule.byDay : [p.local.getUTCDay()]);
      if (p.rule.byMonthDay && p.rule.byMonthDay > 0) setMonthDay(p.rule.byMonthDay);
    }
    else { setMode('anchor'); setAnchorDays(p.days); setTime(p.time ?? defaultTime); }
    titleRef.current?.focus();
  }

  const [h, m] = parseHm(time);
  const rule = ruleOf(repeat, days, monthDay);
  const preview = (() => {
    if (mode === 'at') { const at = fromIso(`${date}T${time}`); return at ? { at, text: `${describeLocal(at, now)} · ${relative(new Date(Date.now() + (at.getTime() - now.getTime())))}` } : null; }
    if (mode === 'repeat') { const at = firstOccurrence(rule, now, h, m); return { at, text: `${ruleText(rule)} at ${time} · first ${describeLocal(at, now)}` }; }
    if (!subject?.due) return null;
    const due = fromIso(subject.due)!;
    const at = atTime(addDays(due, anchorDays), h, m);
    return { at, text: `${describeLocal(at, now)} · ${anchorDays === 0 ? 'on the due date' : `${-anchorDays} day${anchorDays === -1 ? '' : 's'} before it's due`}` };
  })();

  const quick = [
    { label: 'In 1 hour', at: soon },
    ...(now.getUTCHours() < 17 ? [{ label: 'This evening', at: atTime(now, 18) }] : []),
    { label: 'Tomorrow morning', at: atTime(addDays(now, 1), ...parseHm(defaultTime)) },
    { label: 'Next Monday', at: atTime(addDays(now, ((8 - now.getUTCDay()) % 7) || 7), ...parseHm(defaultTime)) },
    ...(insights.data?.usualTime && insights.data.usualTime !== defaultTime ? [{ label: `Tomorrow at your usual ${insights.data.usualTime}`, at: atTime(addDays(now, 1), ...parseHm(insights.data.usualTime)) }] : []),
  ];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    let t = title, md = mode;
    let when: SaveReminder['when'];
    if (typed && !touched) {   // the words carry the time: use them
      t = typed.title;
      if (typed.kind === 'at') when = { at: iso(typed.local), timeZone: zone };
      else if (typed.kind === 'repeat') when = { at: iso(typed.local), timeZone: zone, recurrence: toRRule(typed.rule) };
      else when = { anchorDays: typed.days, anchorTime: typed.time ?? defaultTime, timeZone: zone };
      md = typed.kind;
    }
    else if (mode === 'at') when = { at: `${date}T${time}`, timeZone: zone };
    else if (mode === 'repeat') when = { at: iso(firstOccurrence(rule, now, h, m)), timeZone: zone, recurrence: toRRule(rule) };
    else when = { anchorDays, anchorTime: time, timeZone: zone };
    if (!t.trim() && !subject) { setError('Say what to remind you about.'); return; }
    if (md === 'at' && when.at && fromIso(when.at)! <= now) { setError('Pick a time in the future.'); return; }
    if (md === 'anchor' && !subject?.due) { setError('Choose work with a due date to count from.'); return; }
    const body: SaveReminder = {
      title: t.trim() || null, note: note.trim() || null, targetType: subject?.type ?? 'None', targetId: subject?.id ?? null,
      forUserId: forUser || null, when, onlyIfOpen: subject ? onlyIfOpen : false, ...(exact === null ? {} : { exact }),
    };
    setBusy(true);
    try {
      const saved = editing ? await reminderApi.update(editing.id, body) : await reminderApi.create(body);
      await refreshReminders(wid);
      const whenText = saved.nextFireAt ? describeLocal(wall(new Date(saved.nextFireAt), zone), now) : '';
      toast(editing ? 'Reminder updated.' : `${saved.for ? `${saved.for.name} will be reminded` : 'Reminder set'}${whenText ? ` · ${whenText}` : ''}`, 'success');
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.errors[0]?.message ?? err.message : 'Could not save the reminder.');
    } finally { setBusy(false); }
  };

  const someoneElse = forUser && forUser !== me;
  const assignee = subject?.assigneeId && subject.assigneeId !== me ? { id: subject.assigneeId, name: subject.assigneeName ?? 'the assignee' } : null;

  return (
    <Modal title={editing ? 'Change reminder' : 'New reminder'} subtitle={`Times are in ${zone} (this device)`} onClose={onClose} onSubmit={submit}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={busy}><Icon name="alarm" size={15} /> {editing ? 'Save' : someoneElse ? 'Send reminder' : 'Remind me'}</SubmitButton></>}>
      <div className="rc-form">
        <div className="rc-what">
          <input ref={titleRef} className="input rc-title" value={title} maxLength={200} autoFocus
            placeholder={subject ? subject.title : 'What should we remind you about? e.g. “call Priya tomorrow at 3pm”'}
            onChange={(e) => setTitle(e.target.value)} aria-label="What to remember" />
          {typed && (
            <button type="button" className="rc-understood" onClick={() => apply(typed)} title="Use this time">
              <Icon name="bolt" size={13} /> <b>{typed.label}</b>{typed.title && <span> · “{typed.title}”</span>}<em>Use</em>
            </button>
          )}
          {showNote
            ? <textarea className="input rc-note" rows={2} value={note} maxLength={1000} placeholder="Add a note (optional)" onChange={(e) => setNote(e.target.value)} />
            : <button type="button" className="link rc-add-note" onClick={() => setShowNote(true)}>+ Add a note</button>}
        </div>

        <SubjectPicker subject={subject} onChange={setSubject} locked={!!editing} />

        <div className="rc-when">
          <div className="seg" role="tablist" aria-label="When">
            <button type="button" role="tab" aria-selected={mode === 'at'} className={mode === 'at' ? 'on' : ''} onClick={() => { setMode('at'); setTouched(true); }}><Icon name="calendar" size={14} /> On a date</button>
            <button type="button" role="tab" aria-selected={mode === 'repeat'} className={mode === 'repeat' ? 'on' : ''} onClick={() => { setMode('repeat'); setTouched(true); }}><Icon name="repeat" size={14} /> Repeats</button>
            {subject?.due && <button type="button" role="tab" aria-selected={mode === 'anchor'} className={mode === 'anchor' ? 'on' : ''} onClick={() => { setMode('anchor'); setTouched(true); }}><Icon name="flag" size={14} /> Before it's due</button>}
          </div>

          {mode === 'at' && (
            <>
              <div className="rc-row">
                <label className="rc-field"><span>Date</span><input className="input" type="date" value={date} min={isoDate(now)} onChange={(e) => { setDate(e.target.value); setTouched(true); }} /></label>
                <label className="rc-field"><span>Time</span><input className="input" type="time" value={time} onChange={(e) => { setTime(e.target.value); setTouched(true); }} /></label>
              </div>
              <div className="rc-chips">
                {quick.map((q) => (
                  <button key={q.label} type="button" className={`rc-chip ${iso(q.at) === `${date}T${time}` ? 'on' : ''}`} onClick={() => { setDate(isoDate(q.at)); setTime(hhmm(q.at)); setTouched(true); }}>{q.label}</button>
                ))}
              </div>
            </>
          )}

          {mode === 'repeat' && (
            <>
              <div className="rc-row">
                <label className="rc-field"><span>Repeats</span>
                  <Select className="input" value={repeat} onChange={(e) => { setRepeat(e.target.value as RepeatKind); setTouched(true); }} aria-label="Repeats">
                    <option value="daily">Every day</option>
                    <option value="weekdays">Every weekday (Mon–Fri)</option>
                    <option value="weekly">Every week</option>
                    <option value="biweekly">Every 2 weeks</option>
                    <option value="monthly">Every month on a date</option>
                    <option value="lastworking">Last working day of the month</option>
                  </Select>
                </label>
                <label className="rc-field"><span>Time</span><input className="input" type="time" value={time} onChange={(e) => { setTime(e.target.value); setTouched(true); }} /></label>
              </div>
              {(repeat === 'weekly' || repeat === 'biweekly') && (
                <div className="rc-days" role="group" aria-label="On">
                  {DAYS.map((d) => (
                    <button key={d.d} type="button" aria-pressed={days.includes(d.d)} className={`rc-day ${days.includes(d.d) ? 'on' : ''}`}
                      onClick={() => setDays((xs) => xs.includes(d.d) ? (xs.length > 1 ? xs.filter((x) => x !== d.d) : xs) : [...xs, d.d])}>{d.l}</button>
                  ))}
                </div>
              )}
              {repeat === 'monthly' && (
                <label className="rc-field rc-narrow"><span>Day of the month</span>
                  <Select className="input" value={String(monthDay)} onChange={(e) => setMonthDay(Number(e.target.value))} aria-label="Day of the month">
                    {Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}{i + 1 >= 29 ? ' (or the last day)' : ''}</option>)}
                    <option value={-1}>Last day</option>
                  </Select>
                </label>
              )}
            </>
          )}

          {mode === 'anchor' && subject?.due && (
            <div className="rc-row">
              <label className="rc-field"><span>When</span>
                <Select className="input" value={String(anchorDays)} onChange={(e) => setAnchorDays(Number(e.target.value))} aria-label="Days before due">
                  <option value={0}>On the due date</option>
                  {[1, 2, 3, 5, 7, 14].map((n) => <option key={n} value={-n}>{n} day{n === 1 ? '' : 's'} before</option>)}
                </Select>
              </label>
              <label className="rc-field"><span>Time</span><input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
            </div>
          )}
          {preview && <div className="rc-preview"><Icon name="alarm" size={14} /> {preview.text}{mode === 'anchor' && <em>Moves with the due date</em>}</div>}
        </div>

        {!personal && (
          <div className="rc-for">
            <label className="rc-field"><span>Remind</span>
              <Select className="input" value={forUser} onChange={(e) => setForUser(e.target.value)} aria-label="Remind who" disabled={!!editing}>
                <option value="">Me</option>
                {assignee && !members.data?.some((x) => x.userId === assignee.id) && <option value={assignee.id}>{assignee.name}</option>}
                {(members.data ?? []).filter((x) => x.userId !== me).map((x) => <option key={x.userId} value={x.userId}>{x.displayName}</option>)}
              </Select>
            </label>
            {assignee && !forUser && !editing && <button type="button" className="rc-chip" onClick={() => setForUser(assignee.id)}><Icon name="user" size={13} /> Remind {assignee.name}</button>}
            {someoneElse && <p className="rc-hint">They get it in their working hours, and can see it came from you. You can remind people about their own work, or anyone who reports to you.</p>}
          </div>
        )}

        <button type="button" className="link rc-more" onClick={() => setMore((v) => !v)} aria-expanded={more}>{more ? 'Fewer options' : 'More options'}</button>
        {more && (
          <div className="rc-options">
            {subject && <label className="rc-check"><input type="checkbox" checked={onlyIfOpen} onChange={(e) => setOnlyIfOpen(e.target.checked)} /> Only while the work is still open <span>— finishing it finishes the reminder</span></label>}
            <label className="rc-check"><input type="checkbox" checked={exact ?? !someoneElse} onChange={(e) => setExact(e.target.checked)} /> Exact time, even in quiet hours <span>— otherwise it waits for working hours</span></label>
          </div>
        )}
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
    </Modal>
  );
}

/** The work a reminder is about: shown as a chip, or found by searching. */
function SubjectPicker({ subject, onChange, locked }: { subject: ReminderSubject | null; onChange: (s: ReminderSubject | null) => void; locked: boolean }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const term = useDebounced(q.trim(), 250);
  const hits = useWsQuery(['reminders', 'subject-search', term], () => insightApi.search(term), { enabled: term.length >= 2 });
  if (subject) return (
    <div className="rc-subject">
      <span className="rc-subject-chip"><Icon name="paperclip" size={13} />{subject.key && <b>{subject.key}</b>}<span>{subject.title}</span>
        {!locked && <button type="button" aria-label="Remove link" onClick={() => onChange(null)}><Icon name="close" size={12} /></button>}</span>
      {subject.due && <span className="rc-hint">Due {describeLocal(fromIso(subject.due)!, wall(new Date())).replace(/, \d\d:\d\d$/, '').replace(/ \d\d:\d\d$/, '')}</span>}
    </div>
  );
  if (locked) return null;
  const list = (hits.data?.hits ?? []).filter((h) => HIT_TYPES[h.type]).slice(0, 6);
  return (
    <div className="rc-subject">
      {!open
        ? <button type="button" className="link rc-add-note" onClick={() => setOpen(true)}><Icon name="paperclip" size={13} /> Link to a task or other work</button>
        : (
          <div className="rc-search">
            <input className="input" autoFocus value={q} placeholder="Search tasks, issues, action items, operational work…" onChange={(e) => setQ(e.target.value)} aria-label="Find work" />
            {list.length > 0 && (
              <div className="rc-hits">
                {list.map((h) => (
                  <button key={`${h.type}:${h.id}`} type="button" onClick={() => { onChange({ type: HIT_TYPES[h.type], id: h.type === 'task' ? h.taskId ?? h.id : h.id, title: h.title, key: h.subtitle ?? null }); setOpen(false); }}>
                    <b>{h.title}</b>{h.subtitle && <span>{h.subtitle}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
    </div>
  );
}
