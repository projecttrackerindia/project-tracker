import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { integrationsApi } from '../../api/endpoints';
import { microsoftApi } from '../../api/endpoints.platform';
import { taskApi } from '../../api/endpoints.projects';
import { workspaceApi } from '../../api/endpoints';
import { matchPerson, parseDueWords } from '../../lib/quickTask';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Modal, PageLoader, ErrorState, Spinner } from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { mailboxApi } from '../mailbox/mailboxApi';
import { minutesText, notetakerApi } from './notetakerApi';
import type { Minutes, NotetakerSession, NotetakerSettings } from './notetakerApi';
import './notetaker.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const DURATIONS = [30, 45, 60, 90, 120, 180];
const PRESETS = [
  { id: 'notes', label: 'Notes only', text: 'Joins when you send it, writes the minutes and emails them to you.', values: { autoJoin: false, autoMinutes: true, autoEmail: true, autoTasks: false } },
  { id: 'tasks', label: 'Notes + tasks', text: 'Also turns the action items into tasks in the project.', values: { autoJoin: false, autoMinutes: true, autoEmail: true, autoTasks: true } },
  { id: 'auto', label: 'Fully automatic', text: 'Also joins every call on your Google Calendar by itself.', values: { autoJoin: true, autoMinutes: true, autoEmail: true, autoTasks: true } },
] as const;

function statusOf(s: NotetakerSession): { label: string; tone: 'live' | 'wait' | 'ok' | 'bad' | 'idle' } {
  if (s.status === 'failed') return { label: 'Did not record', tone: 'bad' };
  if (s.status === 'done') return { label: s.minutesStatus === 'sent' ? 'Minutes sent' : s.hasMinutes ? 'Minutes ready' : 'Recorded', tone: 'ok' };
  if (s.workerStatus === 'in_call_recording' || s.status === 'in_call') return { label: 'In the call · taking notes', tone: 'live' };
  if (s.workerStatus === 'waiting_admission') return { label: 'Waiting to be let in', tone: 'wait' };
  if (s.workerStatus === 'joining') return { label: 'Joining…', tone: 'wait' };
  if (s.workerStatus === 'fatal') return { label: 'Could not join', tone: 'bad' };
  return { label: new Date(s.start) > new Date() ? 'Scheduled' : 'Waiting for a free bot', tone: 'idle' };
}

/** Meet › Notetaker: send it to any Google Meet or Teams link, how much it does on its own, and every call it attended with its minutes. */
export function NotetakerPanel() {
  const wid = useWorkspaceId();
  const [params, setParams] = useSearchParams();
  const q = useWsQuery(['notetaker'], notetakerApi.overview, { refetchInterval: 10_000 });
  // "Send notetaker" from a call on your calendar arrives with its link and name filled in.
  const [url, setUrl] = useState(params.get('url') ?? '');
  const [title, setTitle] = useState(params.get('title') ?? '');
  const [minutes, setMinutes] = useState(60);
  const [project, setProject] = useState('');
  const [raise, setRaise] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(params.get('session'));
  const [pending, setPending] = useState<NotetakerSettings | null>(null);
  const data = q.data;
  const asked = params.get('project');
  useEffect(() => { if (data?.settings && !project) setProject((asked && data.projects.some((p) => p.id === asked) ? asked : null) ?? data.settings.projectId ?? data.projects.find((p) => p.agentReady)?.id ?? data.projects[0]?.id ?? ''); }, [data, project, asked]);

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !data?.settings) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const chosen = data.projects.find((p) => p.id === project);
  const settings = pending ?? data.settings;

  const join = async () => {
    setBusy(true);
    try {
      await notetakerApi.join({ url: url.trim(), title: title.trim() || undefined, minutes, projectId: project || null, instructions: raise.trim() || undefined });
      toast('Your notetaker is on its way. It joins within a minute.');
      setUrl(''); setTitle(''); setRaise('');
      void invalidateWorkspace(wid, 'notetaker');
    } catch (e) { toast(errText(e, 'The notetaker could not be sent.'), 'error'); }
    finally { setBusy(false); }
  };
  const save = async (patch: Partial<NotetakerSettings>) => {
    const next = { ...settings, ...patch };
    setPending(next);   // the switch moves at once; the server's answer replaces it
    try { await notetakerApi.saveSettings(next); toast('Saved.'); await q.refetch(); }
    catch (e) { toast(errText(e, 'Could not save.'), 'error'); }
    finally { setPending(null); }
  };
  const stop = async (s: NotetakerSession) => {
    if (!(await confirmDialog({ title: 'Call the notetaker back?', message: 'It leaves the call. What it heard so far is kept and written up.', confirmText: 'Leave the call' }))) return;
    try { await notetakerApi.stop(s.id); void invalidateWorkspace(wid, 'notetaker'); } catch (e) { toast(errText(e, 'Could not stop it.'), 'error'); }
  };
  const live = data.sessions.filter((s) => ['scheduled', 'in_call'].includes(s.status));
  const past = data.sessions.filter((s) => !['scheduled', 'in_call'].includes(s.status));

  return (
    <div className="nt">
      <header className="nt-hero">
        <div>
          <h2>Your notetaker</h2>
          <p>Choose it when you schedule a meeting, or send it to any Google Meet or Teams link here. It joins in your name, takes notes, writes the minutes and proposes task updates.</p>
        </div>
        <ul className="nt-checks" aria-label="Readiness">
          <li className={data.botReady ? 'ok' : 'bad'}><Icon name={data.botReady ? 'checkCircle' : 'alert'} size={15} />{data.botReady ? 'Meeting bot online' : 'Meeting bot not set up'}</li>
          <li className={data.signedInAccount ? 'ok' : 'warn'}><Icon name={data.signedInAccount ? 'checkCircle' : 'info'} size={15} />
            <span>{data.signedInAccount ? <>Joins as <b>{data.accountName}</b>, let in automatically in your company's calls</> : <>Joins as a guest. Google Meet often refuses guest bots: ask your administrator to add a notetaker Google account</>}</span></li>
          <li className={data.calendarConnected ? 'ok' : 'warn'}><Icon name={data.calendarConnected ? 'checkCircle' : 'info'} size={15} />
            <span>{data.calendarConnected ? 'Google Calendar connected' : <>Connect Google in <Link to="/account/integrations">Connected accounts</Link> to join calendar calls</>}</span></li>
          <li className={data.aiAvailable ? 'ok' : 'warn'}><Icon name={data.aiAvailable ? 'checkCircle' : 'info'} size={15} />{data.aiAvailable ? 'Minutes written by AI' : 'AI is off: transcripts only'}</li>
        </ul>
      </header>

      <div className="nt-grid">
        <section className="nt-card nt-send" aria-labelledby="nt-send-title">
          <h2 id="nt-send-title"><Icon name="video" size={17} /> Join a call for me</h2>
          <label className="nt-field"><span>Meeting link</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://meet.google.com/abc-defg-hij" inputMode="url" /></label>
          <div className="nt-row">
            <label className="nt-field"><span>Name (optional)</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Client sync" /></label>
            <label className="nt-field nt-short"><span>Stay up to</span>
              <Select className="select" aria-label="Stay up to" value={String(minutes)} onChange={(e) => setMinutes(Number(e.target.value))}>{DURATIONS.map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h${m % 60 ? ' 30' : ''}`}</option>)}</Select></label>
          </div>
          <label className="nt-field"><span>File notes under</span>
            <Select className="select" aria-label="Project" value={project} onChange={(e) => setProject(e.target.value)}>{data.projects.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}{p.agentReady ? '' : ' (agent off)'}</option>)}</Select></label>
          {chosen && !chosen.agentReady && <p className="nt-warn"><Icon name="alert" size={13} /> Switch on this project's agent with “read meetings” first (<Link to={`/projects/${chosen.id}?tab=agent`}>Project › Agent</Link>).</p>}
          <label className="nt-field"><span>Anything to raise for you? (optional)</span>
            <textarea rows={3} value={raise} onChange={(e) => setRaise(e.target.value)} placeholder="Ask when the UAT sign-off will happen. Tell them I'll send the estimate by Friday." /></label>
          <button className="btn btn-primary" disabled={busy || !url.trim() || !project || !data.botReady} onClick={() => void join()}>{busy ? <Spinner /> : <Icon name="play" size={14} />} Join now</button>
        </section>

        <section className="nt-card" aria-labelledby="nt-auto-title">
          <h2 id="nt-auto-title"><Icon name="settings" size={17} /> How much it does for you</h2>
          <label className="nt-field"><span>File my notes under</span>
            <Select className="select" aria-label="Default project" value={settings.projectId ?? ''} onChange={(e) => void save({ projectId: e.target.value || null })}>
              <option value="">Choose a project</option>{data.projects.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}</Select></label>
          <div className="nt-presets" role="radiogroup" aria-label="How much it does for you">
            {PRESETS.map((p) => {
              const on = (Object.keys(p.values) as (keyof typeof p.values)[]).every((k) => settings[k] === p.values[k]);
              return (
                <button key={p.id} type="button" role="radio" aria-checked={on} className={on ? 'on' : ''} disabled={p.values.autoJoin && !settings.projectId}
                  onClick={() => void save(p.values)}>
                  <b>{p.label}</b><small>{p.text}</small>
                </button>
              );
            })}
          </div>
          <details className="nt-advanced">
            <summary>Advanced</summary>
          <label className="nt-toggle"><input type="checkbox" checked={settings.autoJoin} disabled={!settings.projectId} onChange={(e) => void save({ autoJoin: e.target.checked })} />
            <span><b>Join every call on my Google Calendar</b><small>It joins each Meet call a minute before it starts, in your name, even when you are there too.</small></span></label>
          <label className="nt-toggle"><input type="checkbox" checked={settings.autoMinutes} onChange={(e) => void save({ autoMinutes: e.target.checked })} />
            <span><b>Write the minutes when a call ends</b><small>You get a notification to review and email them. One AI request per call.</small></span></label>
          <div className={`nt-after ${settings.autoMinutes ? '' : 'off'}`} aria-label="After the minutes are written">
            <label className="nt-toggle"><input type="checkbox" checked={settings.autoEmail} disabled={!settings.autoMinutes} onChange={(e) => void save({ autoEmail: e.target.checked })} />
              <span><b>Email me the minutes</b><small>Sent to your ProjectTracker address as soon as they are written.</small></span></label>
            <label className="nt-toggle"><input type="checkbox" checked={settings.autoTasks} disabled={!settings.autoMinutes} onChange={(e) => void save({ autoTasks: e.target.checked })} />
              <span><b>Create tasks from the action items</b><small>Added to the project, assigned when the person named in the call is a member, with the date said.</small></span></label>
            <label className="nt-toggle"><input type="checkbox" checked={settings.deleteTranscript} onChange={(e) => void save({ deleteTranscript: e.target.checked })} />
              <span><b>Delete the transcript afterwards</b><small>Once the minutes are written and the agent has read the call, only the minutes are kept. Audio is never stored.</small></span></label>
          </div>
          </details>
        </section>
      </div>

      <section className="nt-card" aria-labelledby="nt-sessions-title">
        <h2 id="nt-sessions-title"><Icon name="list" size={17} /> Calls</h2>
        {data.sessions.length === 0 ? <p className="muted">No calls yet. Send the notetaker to one above.</p> : (
          <ul className="nt-sessions">
            {[...live, ...past].map((s) => {
              const st = statusOf(s);
              return (
                <li key={s.id} className={`nt-session ${st.tone}`}>
                  <span className={`nt-dot ${st.tone}`} aria-hidden />
                  <div className="nt-session-main">
                    <b>{s.title}</b>
                    <small>{formatDateTime(s.start)} · {s.projectName}{s.automatic ? ' · from your calendar' : ''}{s.transcriptLength > 0 ? ` · ${Math.round(s.transcriptLength / 6)} words heard` : ''}</small>
                    <span className={`nt-status ${st.tone}`}>{st.label}</span>
                    {s.error && st.tone === 'bad' && <small className="nt-error">{s.error.replace(/^NOTETAKER_SIGNED_OUT:\s*/, '')}</small>}
                  </div>
                  <div className="nt-session-actions">
                    {['scheduled', 'in_call'].includes(s.status) && s.mine && <button className="btn btn-sm btn-ghost" onClick={() => void stop(s)}>Leave call</button>}
                    {(s.status === 'done' || s.hasMinutes) && <button className="btn btn-sm" onClick={() => { setOpen(s.id); setParams((p) => { const n = new URLSearchParams(p); n.set('session', s.id); return n; }, { replace: true }); }}><Icon name="note" size={14} /> {s.hasMinutes ? 'Minutes' : 'Write minutes'}</button>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {open && <MinutesModal sessionId={open} session={data.sessions.find((s) => s.id === open)} ai={data.aiAvailable}
        onClose={() => { setOpen(null); setParams((p) => { const n = new URLSearchParams(p); n.delete('session'); return n; }, { replace: true }); void invalidateWorkspace(wid, 'notetaker'); }} />}
    </div>
  );
}

/**
 * The call's action items as tasks to approve: the person named in the call is matched to a member and the date said ("Friday",
 * "25 Oct") is read, both editable before anything is created. One click per item or all at once; items that already have a task with
 * the same title in the project show it instead, so opening the minutes again never makes duplicates.
 */
function ActionItemsToTasks({ minutes }: { minutes: Minutes }) {
  const wid = useWorkspaceId();
  const meUser = useAuth((s) => s.ctx?.user);
  const members = useWsQuery(['members'], workspaceApi.members, { staleTime: 300_000 });
  const existing = useWsQuery(['tasks', 'project', minutes.projectId, 'for-minutes'], () => taskApi.listForProject(minutes.projectId, {}), { staleTime: 15_000 });
  const people = useMemo(() => (members.data ?? []).filter((m) => m.role !== 'Guest').map((m) => ({ id: m.userId, name: m.displayName })), [members.data]);
  const me = meUser ? { id: meUser.id, name: meUser.displayName } : undefined;
  const base = useMemo(() => minutes.content.actionItems.map((a) => {
    const owner = a.owner ? matchPerson(a.owner.replace(/\(.*?\)/g, '').split(/\s+/).slice(0, 2).join(' '), people, me) ?? matchPerson(a.owner.split(/\s+/)[0], people) : undefined;
    return { title: a.task.trim().slice(0, 200), owner: a.owner, assigneeId: owner?.id ?? '', due: a.due ? parseDueWords(a.due) ?? '' : '', dueSaid: a.due };
  }), [minutes.content.actionItems, people, me?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [edits, setEdits] = useState<Record<number, { assigneeId?: string; due?: string }>>({});
  const [made, setMade] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | 'all' | null>(null);
  const rows = base.map((r, i) => ({ ...r, ...edits[i] }));
  const already = (title: string) => existing.data?.items.find((t) => t.title.trim().toLowerCase() === title.toLowerCase());
  const open = rows.map((_, i) => i).filter((i) => !made[i] && !already(rows[i].title));

  const create = async (i: number) => {
    const r = rows[i];
    const t = await taskApi.create(minutes.projectId, {
      title: r.title, priority: 'Medium', assigneeId: r.assigneeId || null, dueDate: r.due || null,
      description: `From the minutes of ${minutes.title}${r.owner ? `\nNamed in the call: ${r.owner}` : ''}${r.dueSaid && !r.due ? `\nDue as said: ${r.dueSaid}` : ''}`,
    });
    setMade((m) => ({ ...m, [i]: t.key }));
  };
  const one = async (i: number) => {
    setBusy(i);
    try { await create(i); toast('Task created.'); void invalidateWorkspace(wid, 'tasks'); }
    catch (e) { toast(errText(e, 'Could not create the task.'), 'error'); } finally { setBusy(null); }
  };
  const all = async () => {
    setBusy('all');
    let done = 0;
    try { for (const i of open) { await create(i); done++; } toast(`${done} task${done === 1 ? '' : 's'} created.`, 'success'); }
    catch (e) { toast(`${done} created; then: ${errText(e, 'one could not be created.')}`, 'error'); }
    finally { setBusy(null); void invalidateWorkspace(wid, 'tasks'); }
  };

  return (
    <div className="nt-items">
      <ul className="nt-actions">
        {rows.map((r, i) => {
          const have = made[i] ?? already(r.title)?.key;
          return (
            <li key={i} className={have ? 'done' : ''}>
              <span className="nt-item-main"><b>{r.title}</b>
                <small>{r.owner ? `Named: ${r.owner}` : 'No owner named'}{r.dueSaid && !/^\d{4}-\d{2}-\d{2}$/.test(r.dueSaid) ? ` · said “${r.dueSaid}”` : ''}</small></span>
              {have ? <span className="nt-done"><Icon name="check" size={13} /> {have}</span> : <>
                <Select className="select nt-item-who" aria-label={`Assign “${r.title}” to`} value={r.assigneeId} onChange={(e) => setEdits((x) => ({ ...x, [i]: { ...x[i], assigneeId: e.target.value } }))}>
                  <option value="">Unassigned</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
                <input type="date" className="input nt-item-due" aria-label={`Due date for “${r.title}”`} value={r.due} onChange={(e) => setEdits((x) => ({ ...x, [i]: { ...x[i], due: e.target.value } }))} />
                <button className="btn btn-sm" disabled={busy !== null} onClick={() => void one(i)}>{busy === i ? <Spinner /> : <Icon name="plus" size={13} />} Create</button>
              </>}
            </li>
          );
        })}
      </ul>
      {open.length > 1 && <button className="btn btn-primary btn-sm nt-all" disabled={busy !== null} onClick={() => void all()}>{busy === 'all' ? <Spinner /> : <Icon name="checks" size={14} />} Create all {open.length} tasks</button>}
    </div>
  );
}

function MinutesModal({ sessionId, session, ai, onClose }: { sessionId: string; session?: NotetakerSession; ai: boolean; onClose: () => void }) {
  const me = useAuth((s) => s.ctx?.user.displayName ?? '');
  const m = useWsQuery(['notetaker', 'minutes', sessionId], () => notetakerApi.minutes(sessionId));
  const [writing, setWriting] = useState(false);
  const [mail, setMail] = useState(false);
  const write = async () => {
    setWriting(true);
    try { await notetakerApi.writeMinutes(sessionId); await m.refetch(); }
    catch (e) { toast(errText(e, 'The minutes could not be written.'), 'error'); }
    finally { setWriting(false); }
  };
  const minutes = m.data;
  return (
    <Modal title={minutes?.title ?? session?.title ?? 'Minutes'} subtitle={session ? `${formatDateTime(session.start)} · ${session.projectName}` : undefined} onClose={onClose} size="lg"
      footer={minutes ? <>
        <button className="btn btn-ghost" disabled={writing || !ai} onClick={() => void write()}>{writing ? <Spinner /> : <Icon name="refresh" size={14} />} Rewrite</button>
        <button className="btn btn-primary" onClick={() => setMail(true)}><Icon name="mail" size={14} /> Email minutes</button>
      </> : undefined}>
      {m.isLoading ? <PageLoader /> : !minutes ? (
        <div className="nt-empty">
          <Icon name="note" size={28} />
          <p>{ai ? 'The notetaker can write the minutes from what it heard: summary, decisions, action items with owners, risks.' : 'AI is off for this workspace, so minutes cannot be written.'}</p>
          <button className="btn btn-primary" disabled={writing || !ai} onClick={() => void write()}>{writing ? <Spinner /> : <Icon name="sparkle" size={14} />} Write the minutes</button>
        </div>
      ) : (
        <div className="nt-minutes">
          {minutes.sentAt && <p className="nt-sent"><Icon name="checkCircle" size={14} /> Emailed {timeAgo(minutes.sentAt)}</p>}
          {minutes.content.attendees.length > 0 && <p className="nt-attendees"><b>Attendees:</b> {minutes.content.attendees.join(', ')}</p>}
          <h3>Summary</h3><p>{minutes.content.summary}</p>
          {minutes.content.decisions.length > 0 && <><h3>Decisions</h3><ul>{minutes.content.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul></>}
          {minutes.content.actionItems.length > 0 && <><h3>Action items</h3><ActionItemsToTasks minutes={minutes} /></>}
          {minutes.content.discussion.length > 0 && <><h3>Discussion</h3><ul>{minutes.content.discussion.map((d, i) => <li key={i}>{d}</li>)}</ul></>}
          {minutes.content.risks.length > 0 && <><h3>Risks and blockers</h3><ul>{minutes.content.risks.map((d, i) => <li key={i}>{d}</li>)}</ul></>}
          {minutes.content.nextMeeting && <p><b>Next meeting:</b> {minutes.content.nextMeeting}</p>}
          <p className="nt-foot">The project agent also reads this call and proposes task updates in <Link to={`/projects/${minutes.projectId}?tab=agent`}>the project's agent</Link> for you to approve.</p>
        </div>
      )}
      {mail && minutes && <SendMinutes sessionId={sessionId} minutes={minutes} owner={me} onClose={() => setMail(false)} onSent={() => { setMail(false); void m.refetch(); }} />}
    </Modal>
  );
}

function SendMinutes({ sessionId, minutes, owner, onClose, onSent }: { sessionId: string; minutes: Minutes; owner: string; onClose: () => void; onSent: () => void }) {
  const google = useWsQuery(['account', 'google-status'], integrationsApi.googleStatus);
  const ms = useWsQuery(['account', 'microsoft-status'], microsoftApi.status);
  const imap = useWsQuery(['mailbox', 'accounts'], mailboxApi.accounts);
  const accounts = useMemo(() => [
    ...(google.data?.connected && google.data.mailSendAccess ? [{ key: 'google', label: `Gmail · ${google.data.googleEmail ?? ''}` }] : []),
    ...(ms.data?.connected && ms.data.mailSendAccess ? [{ key: 'microsoft', label: `Outlook · ${ms.data.email ?? ''}` }] : []),
    ...(imap.data?.imap ?? []).map((a) => ({ key: `imap:${a.id}`, label: `${a.name} · ${a.email}` })),
  ], [google.data, ms.data, imap.data]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState(`Minutes of meeting: ${minutes.title}`);
  const [body, setBody] = useState(() => minutesText(minutes.content, owner));
  const [busy, setBusy] = useState(false);
  const account = from || accounts[0]?.key || '';
  const send = async () => {
    if (!(await confirmDialog({ title: 'Email the minutes?', message: `To ${to}${cc ? `, cc ${cc}` : ''}.`, confirmText: 'Send' }))) return;
    setBusy(true);
    try { await notetakerApi.sendMinutes(sessionId, { account, to, cc, subject, body, confirmed: true }); toast('Minutes sent.'); onSent(); }
    catch (e) { toast(errText(e, 'The minutes could not be sent.'), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Email the minutes" onClose={onClose} size="lg" footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !account || !to.trim()} onClick={() => void send()}>{busy ? <Spinner /> : <Icon name="send" size={14} />} Send</button></>}>
      {accounts.length === 0 ? <p className="muted">Connect a mail account in <Link to="/mailbox">Mailbox</Link> first.</p> : (
        <div className="nt-mail">
          <label className="nt-field"><span>From</span><Select className="select" aria-label="From" value={account} onChange={(e) => setFrom(e.target.value)}>{accounts.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}</Select></label>
          <label className="nt-field"><span>To</span><input value={to} onChange={(e) => setTo(e.target.value)} placeholder="attendees@company.com, …" autoFocus /></label>
          <label className="nt-field"><span>Cc</span><input value={cc} onChange={(e) => setCc(e.target.value)} /></label>
          <label className="nt-field"><span>Subject</span><input value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
          <label className="nt-field"><span>Message</span><textarea rows={14} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        </div>
      )}
    </Modal>
  );
}
