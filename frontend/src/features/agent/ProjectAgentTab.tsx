import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { agentApi, CAPTION_LANGUAGES, integrationsApi, meetingApi, type AgentSettingsPatch } from '../../api/endpoints';
import type { ProjectAgent } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { EmptyState, ErrorState, Field, Modal, PageLoader } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { FindingCard } from './FindingCard';
import './agent.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
type View = 'proposed' | 'applied' | 'dismissed' | 'all';
const VIEWS: { id: View; label: string }[] = [{ id: 'proposed', label: 'To review' }, { id: 'applied', label: 'Approved' }, { id: 'dismissed', label: 'Dismissed' }, { id: 'all', label: 'All' }];
const TRIGGER: Record<string, string> = { schedule: 'New chat', meeting: 'Meeting', mail: 'Email', manual: 'Run by hand' };

type Source = 'readMailbox' | 'readChat' | 'readMeetings' | 'liveBot' | 'autoJoinCalendar' | 'readWhatsApp' | 'sendMinutes' | 'dailyUpdates';
const SOURCES: { key: Source; icon: IconName; title: string; text: string; show?: (a: ProjectAgent) => boolean }[] = [
  { key: 'readMailbox', icon: 'mail', title: 'Project mailbox', text: 'Mail sent or copied to the project address' },
  { key: 'readChat', icon: 'message', title: 'Project chat', text: 'Read once a conversation goes quiet' },
  { key: 'readMeetings', icon: 'video', title: 'Meetings', text: 'Google Meet transcripts after each session' },
  { key: 'liveBot', icon: 'agent', title: 'Live meeting bot', text: 'Joins stand-ups, posts the agenda and reminds the team in the chat' },
  { key: 'autoJoinCalendar', icon: 'calendar', title: 'Calls on my calendar', text: 'The bot also joins Meet calls on your calendar that name the project', show: (a) => a.liveBot && a.liveBotAvailable },
  { key: 'readWhatsApp', icon: 'phone', title: 'WhatsApp', text: 'Messages starting with the project key, from members\' verified numbers', show: (a) => a.whatsAppAvailable },
  { key: 'sendMinutes', icon: 'note', title: 'Minutes by e-mail (MOM)', text: 'Summary, actions and the transcript, e-mailed to the people in the meeting once it is decided' },
  { key: 'dailyUpdates', icon: 'bell', title: 'Morning updates', text: 'Each person gets their own update at 9:00' },
];
const LANGUAGE = Object.fromEntries(CAPTION_LANGUAGES);

/** The Agent tab of a project: switch the agent on, choose what it reads, give it a transcript, and review what it found. */
export function ProjectAgentTab({ projectId, archived }: { projectId: string; archived: boolean }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['agent', 'project', projectId], () => agentApi.get(projectId));
  const [view, setView] = useState<View>('proposed');
  const findings = useWsQuery(['agent', 'findings', projectId, view], () => agentApi.findings(projectId, view), { enabled: !!q.data });
  const [busy, setBusy] = useState<string | null>(null);
  const [transcript, setTranscript] = useState(false);
  const [tuning, setTuning] = useState(false);
  const refresh = () => { void invalidateWorkspace(wid, 'agent'); };

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const a = q.data;
  const manage = a.canManage && !archived;

  const save = async (patch: AgentSettingsPatch & { enabled?: boolean }) => {
    setBusy(Object.keys(patch)[0]);
    try {
      await agentApi.save(projectId, { enabled: a.enabled, ...patch });
      refresh();
      if (patch.enabled) toast('The project agent is on. It reads new mail, chat and meetings from now on.');
    } catch (e) { toast(errText(e, 'Could not save.'), 'error'); }
    finally { setBusy(null); }
  };
  const run = async () => {
    setBusy('run');
    try {
      const r = await agentApi.run(projectId);
      toast(r?.status === 'failed' ? r.error ?? 'The reading failed.' : r ? `Read ${r.signalCount} new source${r.signalCount === 1 ? '' : 's'}: ${r.findingCount} to review.` : 'Nothing new to read.', r?.status === 'failed' ? 'error' : undefined);
      refresh();
    } catch (e) { toast(errText(e, 'Could not run the agent.'), 'error'); }
    finally { setBusy(null); }
  };
  const approveAll = async () => {
    if (!(await confirmDialog({ title: 'Approve the new items and notes?', message: 'New tasks, tickets and action items are created as you, and notes are recorded. Changes to existing work (status, owner, dates) stay here to approve one by one. Anything that cannot be done stays with the reason.', confirmText: 'Approve all' }))) return;
    setBusy('all');
    try {
      const r = await agentApi.approveAll(projectId);
      const rest = r.skipped ? ` ${r.skipped} change${r.skipped === 1 ? '' : 's'} to existing work left to approve one by one.` : '';
      toast((r.failed ? `${r.applied} done, ${r.failed} could not be done - see the reasons.` : `${r.applied} done.`) + rest, r.failed ? 'error' : undefined);
      refresh(); void invalidateWorkspace(wid, 'project', projectId);
    } catch (e) { toast(errText(e, 'Could not approve them.'), 'error'); }
    finally { setBusy(null); }
  };
  const copy = async () => {
    if (!a.mailboxAddress) return;
    try { await navigator.clipboard.writeText(a.mailboxAddress); toast('Address copied.'); } catch { toast(a.mailboxAddress); }
  };
  const resetMailbox = async () => {
    if (!(await confirmDialog({ title: 'Give the project a new address?', message: 'Mail to the current address will be refused from now on.', confirmText: 'New address' }))) return;
    try { await agentApi.resetMailbox(projectId); refresh(); } catch (e) { toast(errText(e, 'Could not change the address.'), 'error'); }
  };
  const allowTranscripts = async () => {
    try { const { url } = await integrationsApi.googleConnectUrl(`/projects/${projectId}?tab=agent`, false, false, false, true); window.location.assign(url); }
    catch (e) { toast(errText(e, 'Could not open Google.'), 'error'); }
  };
  const sendMinutes = async (runId: string, again: boolean) => {
    if (!(await confirmDialog({ title: again ? 'Send the minutes again?' : 'E-mail the minutes?', message: 'The summary, action items and the full transcript go to the people in the meeting, in your name. Replies come to your own e-mail address.', confirmText: 'Send' }))) return;
    setBusy(`mom-${runId}`);
    try { const r = await agentApi.sendMinutes(projectId, runId); toast(`Minutes e-mailed to ${r.sent} ${r.sent === 1 ? 'person' : 'people'}.`); refresh(); }
    catch (e) { toast(errText(e, 'Could not send the minutes.'), 'error'); }
    finally { setBusy(null); }
  };

  if (!a.enabled) {
    return (
      <div className="ag-intro card">
        <div className="ag-intro-mark"><Icon name="agent" size={26} /></div>
        <div className="ag-intro-text">
          <h3>Let an agent keep this project up to date</h3>
          <p>It reads the project's email, chat and scrum calls, then proposes new tasks, updates to tasks and tickets, delays, missed points and
            suggestions - each with the words it came from. Nothing changes until someone who can edit the project approves it.</p>
          <ul className="ag-intro-list">
            <li><Icon name="mail" size={14} />Its own email address - copy it on client threads</li>
            <li><Icon name="video" size={14} />Reads Google Meet transcripts, or joins stand-ups live</li>
            <li><Icon name="bell" size={14} />Sends everyone a morning update of their own work</li>
          </ul>
          {!a.aiAvailable && <p className="ag-warn"><Icon name="info" size={14} />The agent needs the AI assistant, which is not available on this workspace's plan or is switched off.</p>}
          {manage ? <button type="button" className="btn btn-primary" disabled={!a.aiAvailable || busy !== null} onClick={() => void save({ enabled: true })}>{busy === 'enabled' && <span className="spinner" />}<Icon name="bolt" size={15} /> Switch on the agent</button>
            : <p className="muted">Someone who can edit this project can switch it on.</p>}
        </div>
      </div>
    );
  }

  const items = findings.data?.items ?? [];
  const last = a.runs[0];
  return (
    <div className="ag-layout">
      <section className="ag-main">
        <div className="ag-queue-head">
          <div className="seg" role="tablist" aria-label="Proposals">
            {VIEWS.map((v) => <button key={v.id} type="button" role="tab" aria-selected={view === v.id} className={view === v.id ? 'on' : ''} onClick={() => setView(v.id)}>
              {v.label}{v.id === 'proposed' && a.pending > 0 && <em className="ag-count">{a.pending}</em>}</button>)}
          </div>
          {view === 'proposed' && a.pending > 1 && findings.data?.canDecide && !archived &&
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void approveAll()}>{busy === 'all' ? <span className="spinner" /> : <Icon name="checks" size={14} />}Approve all</button>}
        </div>
        {last?.summary && view === 'proposed' && <p className="ag-summary"><Icon name="sparkle" size={14} />{last.summary}</p>}
        {findings.isLoading ? <PageLoader /> : findings.isError ? <ErrorState error={findings.error} retry={() => findings.refetch()} />
          : items.length === 0 ? <EmptyState icon="checkCircle" title={view === 'proposed' ? 'Nothing to review' : 'Nothing here yet'}
              text={view === 'proposed' ? 'New mail, chat and meetings are read as they come in. Add a transcript or run the agent to read what is new now.' : undefined} />
          : <div className="ag-list">{items.map((f) => <FindingCard key={f.id} f={f} canDecide={!!findings.data?.canDecide && !archived} />)}</div>}
      </section>

      <aside className="ag-side">
        <div className="card ag-panel">
          <div className="ag-panel-head">
            <h3><Icon name="agent" size={16} /> Project agent</h3>
            {manage && <button type="button" className="switch on" role="switch" aria-checked aria-label="Project agent on" disabled={busy !== null} onClick={() => void save({ enabled: false })} />}
          </div>
          {a.lastError && <div className="form-error" role="alert">{a.lastError}</div>}
          <div className="ag-actions">
            {manage && <button type="button" className="btn btn-primary btn-sm" onClick={() => setTranscript(true)}><Icon name="note" size={14} />Add transcript</button>}
            {manage && <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void run()}>{busy === 'run' ? <span className="spinner" /> : <Icon name="refresh" size={14} />}Read new now</button>}
          </div>
          <p className="ag-meta">{a.lastRunAt ? `Last read ${timeAgo(a.lastRunAt)}` : 'Has not read anything yet'} · {a.runsThisMonth}/{a.monthlyRunLimit} readings this month
            {a.actingUserName && <> · acts as {a.actingUserName}</>}</p>
        </div>

        {a.mailboxAddress && (
          <div className="card ag-panel">
            <h4 className="ag-panel-title"><Icon name="mail" size={14} /> Project email address</h4>
            <div className="ag-address"><code>{a.mailboxAddress}</code><button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()} aria-label="Copy the address"><Icon name="copy" size={14} /></button></div>
            <p className="ag-hint">Copy it on client and team emails, or forward mail to it. Anyone can write to it, so the agent treats what it says as information only.
              {manage && <> <button type="button" className="ag-link" onClick={() => void resetMailbox()}>New address</button></>}</p>
          </div>
        )}

        <div className="card ag-panel">
          <h4 className="ag-panel-title"><Icon name="layers" size={14} /> What it reads</h4>
          <ul className="ag-sources">
            {SOURCES.filter((s) => !s.show || s.show(a)).map((s) => {
              const on = a[s.key];
              const blocked = s.key === 'liveBot' && !a.liveBotAvailable;
              return (
                <li key={s.key}>
                  <Icon name={s.icon} size={15} />
                  <span><b>{s.title}</b><small>{blocked ? 'The meeting bot is not running on this installation yet' : s.text}</small></span>
                  <button type="button" className={`switch ${on && !blocked ? 'on' : ''}`} role="switch" aria-checked={on && !blocked} aria-label={s.title}
                    disabled={!manage || busy !== null || blocked} onClick={() => void save({ [s.key]: !on })} />
                </li>
              );
            })}
          </ul>
          {a.readMeetings && (a.autoTranscriptAccess
            ? <p className="ag-hint"><Icon name="checkCircle" size={13} /> Google Meet transcribes your meetings automatically, with your own Google account - no bot or mailbox needed.</p>
            : <p className="ag-hint"><Icon name="info" size={13} /> Let Google Meet transcribe your meetings itself, with your own Google account - no bot to let in, no mailbox for it.
              <button type="button" className="ag-link" onClick={() => void allowTranscripts()}>Use my Google account</button></p>)}
          <p className="ag-hint"><Link to="/project-agent/my-inbox">Let it look in my own inbox too</Link></p>
        </div>

        <div className="card ag-panel ag-tune">
          <h4 className="ag-panel-title"><Icon name="target" size={14} /> Accuracy</h4>
          <dl>
            <dt>Notes</dt><dd>{a.instructions ? a.instructions.split('\n')[0] : manage ? 'None yet' : 'Set by the lead'}</dd>
            <dt>Names</dt><dd>{a.speakerAliases ? `${a.speakerAliases.split('\n').length} matched to people` : 'None yet'}</dd>
            <dt>Language</dt><dd>{a.captionLanguage ? LANGUAGE[a.captionLanguage] ?? a.captionLanguage : 'Meeting default'}</dd>
            {a.slackAvailable && <><dt>Slack</dt><dd>{a.slackChannelId ?? 'No channel'}</dd></>}
          </dl>
          <p className="ag-hint">Tell it your project's words and who is who in calls; it also learns from what you approve, change and dismiss.</p>
          {manage && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTuning(true)}><Icon name="edit" size={14} />Notes and names</button>}
        </div>

        {a.runs.length > 0 && (
          <div className="card ag-panel">
            <h4 className="ag-panel-title"><Icon name="clock" size={14} /> Recent readings</h4>
            <ul className="ag-runs">
              {a.runs.map((r) => (
                <li key={r.id} className={r.status === 'failed' ? 'bad' : ''}>
                  <span>{TRIGGER[r.trigger] ?? r.trigger}</span>
                  <small>{r.status === 'failed' ? r.error ?? 'Failed' : `${r.signalCount} source${r.signalCount === 1 ? '' : 's'} · ${r.findingCount} found`}
                    {r.meeting && r.minutesSentAt && <> · MOM sent</>}</small>
                  <time>{timeAgo(r.startedAt)}</time>
                  {r.meeting && r.status === 'done' && manage && (
                    <button type="button" className="ag-link ag-mom" disabled={busy !== null} onClick={() => void sendMinutes(r.id, !!r.minutesSentAt)}>
                      {busy === `mom-${r.id}` ? <span className="spinner" /> : <Icon name="mail" size={12} />}{r.minutesSentAt ? 'Resend MOM' : 'E-mail MOM'}</button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>

      {tuning && <TuneModal a={a} onClose={() => setTuning(false)} onSave={async (patch) => { await agentApi.save(projectId, { enabled: a.enabled, ...patch }); refresh(); setTuning(false); toast('Saved. The next reading uses it.'); }} />}
      {transcript && <TranscriptModal projectId={projectId} onClose={() => setTranscript(false)} onDone={() => { setTranscript(false); setView('proposed'); refresh(); }} />}
    </div>
  );
}

/** The lead's notes for the agent, who is who in calls, the meetings' language and the Slack channel. */
function TuneModal({ a, onClose, onSave }: { a: ProjectAgent; onClose: () => void; onSave: (patch: AgentSettingsPatch) => Promise<void> }) {
  const [instructions, setInstructions] = useState(a.instructions ?? '');
  const [aliases, setAliases] = useState(a.speakerAliases ?? '');
  const [language, setLanguage] = useState(a.captionLanguage ?? '');
  const [slack, setSlack] = useState(a.slackChannelId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try { await onSave({ instructions, speakerAliases: aliases, captionLanguage: language, ...(a.slackAvailable ? { slackChannelId: slack.trim() } : {}) }); }
    catch (e) { setError(errText(e, 'Could not save.')); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Notes and names" subtitle="What the agent should know about this project. Only people who can edit the project see this." size="lg" onClose={onClose}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>{busy && <span className="spinner" />}Save</button></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="form-grid">
        <Field label="Notes for the agent" full hint="Abbreviations and terms, who usually owns what, what to ignore. Up to 4,000 characters.">
          <textarea className="input" aria-label="Notes for the agent" rows={5} maxLength={4000} value={instructions} onChange={(e) => setInstructions(e.target.value)}
            placeholder={'UAT = the bank\'s test environment.\nRefunds belong to Priya unless someone says otherwise.\nIgnore talk about the office move.'} />
        </Field>
        <Field label="Names in calls and chat" full hint="One per line: the name as captions or chat show it = the person's email. Helps when people use nicknames or captions misspell a name.">
          <textarea className="input ag-textarea" aria-label="Names in calls and chat" rows={4} maxLength={4000} value={aliases} onChange={(e) => setAliases(e.target.value)}
            placeholder={'RK = ravi.kumar@company.com\nPriya S = priya@company.com'} />
        </Field>
        <Field label="Meeting language" hint="The bot switches Meet's captions to it; captions in the wrong language are gibberish.">
          <select className="input" aria-label="Meeting language" value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="">Meeting default</option>
            {CAPTION_LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </Field>
        {a.slackAvailable && (
          <Field label="Slack channel ID" hint="In Slack: the channel's name › About (at the bottom, starts with C). Invite the app to the channel.">
            <input className="input" aria-label="Slack channel ID" value={slack} maxLength={24} placeholder="C0123ABCD" onChange={(e) => setSlack(e.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

/** Paste a transcript or notes (or open a .txt / .vtt file); the agent reads it at once. */
function TranscriptModal({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  const meetings = useWsQuery(['meetings', projectId], () => meetingApi.list(projectId));
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [meetingId, setMeetingId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async (file?: File) => {
    if (!file) return;
    if (file.size > 2_000_000) { setError('That file is too large (2 MB at most).'); return; }
    setText(await file.text());
    if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''));
  };
  const submit = async () => {
    if (text.trim().length < 40) { setError('Paste the transcript or notes first.'); return; }
    setBusy(true); setError(null);
    try {
      const r = await agentApi.transcript(projectId, { title: title.trim() || undefined, text, meetingId: meetingId || undefined });
      toast(r.run ? (r.run.status === 'failed' ? r.run.error ?? 'Saved; the reading failed and will be tried again.' : `Read: ${r.run.findingCount} to review.`) : 'Saved - it will be read shortly.', r.run?.status === 'failed' ? 'error' : undefined);
      onDone();
    } catch (e) { setError(errText(e, 'Could not add the transcript.')); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Add a transcript" subtitle="A meeting transcript or notes. The agent reads it straight away." size="lg" onClose={onClose}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>{busy && <span className="spinner" />}Read it</button></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="form-grid">
        <Field label="Title"><input className="input" aria-label="Title" value={title} maxLength={200} placeholder="Stand-up 18 Oct" onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Meeting (optional)">
          <select className="input" aria-label="Meeting" value={meetingId} onChange={(e) => setMeetingId(e.target.value)}>
            <option value="">Not one of the project's meetings</option>
            {(meetings.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select>
        </Field>
        <Field label="Transcript or notes" full hint="Paste it, or open a .txt or .vtt file. Speaker names help the agent assign work.">
          <textarea className="input ag-textarea" aria-label="Transcript or notes" rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Ravi: I finished the gateway sandbox yesterday.\nClient: Can you send the go-live checklist by Friday?'} />
        </Field>
        <label className="btn btn-ghost btn-sm ag-file"><Icon name="upload" size={14} />Open a file<input type="file" accept=".txt,.vtt,.srt,text/plain,text/vtt" hidden onChange={(e) => void open(e.target.files?.[0])} /></label>
      </div>
    </Modal>
  );
}
