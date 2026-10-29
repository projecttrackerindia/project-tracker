import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { agentApi, CAPTION_LANGUAGES, integrationsApi, meetingApi, type AgentSettingsPatch } from '../../api/endpoints';
import type { AgentAutonomyReport, AgentFindingKind, ProjectAgent } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { EmptyState, ErrorState, Field, Modal, PageLoader } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { FindingCard } from './FindingCard';
import { aiControlApi } from '../settings/aiControlApi';
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
  { key: 'autoJoinCalendar', icon: 'calendar', title: 'Calls on my calendar', text: 'The bot also joins Meet or Teams calls on your Google or Outlook calendar that name the project', show: (a) => a.liveBot && a.liveBotAvailable },
  { key: 'readWhatsApp', icon: 'phone', title: 'WhatsApp', text: 'Messages starting with the project key, from members\' verified numbers', show: (a) => a.whatsAppAvailable },
  { key: 'sendMinutes', icon: 'note', title: 'Minutes by e-mail (MOM)', text: 'Summary, actions and the transcript, e-mailed to the people in the meeting once it is decided' },
  { key: 'dailyUpdates', icon: 'bell', title: 'Morning updates', text: 'Each person gets their own update at 9:00' },
];
const LANGUAGE = Object.fromEntries(CAPTION_LANGUAGES);

/**
 * A project's agent, in two parts since v2: what it proposed (the review queue, on the project's Activity tab beside one on/off switch) and
 * how it behaves (what it reads, the meeting bot and its four levels, minutes, morning updates, the Google account, accuracy, credits), set in
 * Settings › AI › Project agent. `ProjectAgentTab` shows both together.
 */
export function ProjectAgentTab({ projectId, archived }: { projectId: string; archived: boolean }) {
  return (
    <div className="ag-layout">
      <section className="ag-main"><ProjectAgentQueue projectId={projectId} archived={archived} /></section>
      <aside className="ag-side"><ProjectAgentSettings projectId={projectId} archived={archived} /></aside>
    </div>
  );
}

function useAgent(projectId: string) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['agent', 'project', projectId], () => agentApi.get(projectId));
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => { void invalidateWorkspace(wid, 'agent'); };
  const save = async (patch: AgentSettingsPatch & { enabled?: boolean }) => {
    if (!q.data) return;
    setBusy(Object.keys(patch)[0]);
    try {
      await agentApi.save(projectId, { enabled: q.data.enabled, ...patch });
      refresh();
      if (patch.enabled) toast('The project agent is on. It reads new mail, chat and meetings from now on.');
      else if (patch.enabled === false) toast('The project agent is off. Nothing it found is lost.');
    } catch (e) { toast(errText(e, 'Could not save.'), 'error'); }
    finally { setBusy(null); }
  };
  return { q, busy, setBusy, refresh, save, wid };
}

/** The agent's proposals for one project: to review, approved, dismissed or all, with Approve all. */
export function ProjectAgentQueue({ projectId, archived }: { projectId: string; archived: boolean }) {
  const { q, busy, setBusy, refresh, wid } = useAgent(projectId);
  const [view, setView] = useState<View>('proposed');
  const findings = useWsQuery(['agent', 'findings', projectId, view], () => agentApi.findings(projectId, view), { enabled: !!q.data?.enabled });
  if (!q.data) return q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : <PageLoader />;
  const a = q.data;
  if (!a.enabled) return null;
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
  const items = findings.data?.items ?? [];
  const last = a.runs[0];
  return (
    <div className="ag-queue" aria-label="The agent's proposals">
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
            text={view === 'proposed' ? 'New mail, chat and meetings are read as they come in.' : undefined} />
        : <div className="ag-list">{items.map((f) => <FindingCard key={f.id} f={f} canDecide={!!findings.data?.canDecide && !archived} />)}</div>}
    </div>
  );
}

/** How the agent behaves on one project: on or off, what it reads, the meeting bot, minutes, morning updates, autonomy, accuracy and credits. */
export function ProjectAgentSettings({ projectId, archived }: { projectId: string; archived: boolean }) {
  const { q, busy, setBusy, refresh, save } = useAgent(projectId);
  const [transcript, setTranscript] = useState(false);
  const [tuning, setTuning] = useState(false);

  // A failed background refresh keeps what is on screen (and any open dialog); only a first load that fails shows the error.
  if (!q.data) return q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : <PageLoader />;
  const a = q.data;
  const manage = a.canManage && !archived;

  const run = async () => {
    setBusy('run');
    try {
      const r = await agentApi.run(projectId);
      toast(r?.status === 'failed' ? r.error ?? 'The reading failed.' : r ? `Read ${r.signalCount} new source${r.signalCount === 1 ? '' : 's'}: ${r.findingCount} to review.` : 'Nothing new to read.', r?.status === 'failed' ? 'error' : undefined);
      refresh();
    } catch (e) { toast(errText(e, 'Could not run the agent.'), 'error'); }
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
    try { const { url } = await integrationsApi.googleConnectUrl(`/settings/ai/project-agent?project=${projectId}`, false, false, false, true); window.location.assign(url); }
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

  return (
    <div className="ag-settings">
      <div className="card ag-panel">
        <div className="ag-panel-head">
          <h3><Icon name="agent" size={16} /> Project agent</h3>
          {manage && <button type="button" className="switch on" role="switch" aria-checked aria-label="Project agent on" disabled={busy !== null} onClick={() => void save({ enabled: false })} />}
        </div>
        {a.lastError && <div className="form-error" role="alert">{a.lastError}</div>}
        <div className="ag-actions">
          {manage && <button type="button" className="btn btn-primary btn-sm" onClick={() => setTranscript(true)}><Icon name="note" size={14} />Add transcript</button>}
          {manage && <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void run()}>{busy === 'run' ? <span className="spinner" /> : <Icon name="refresh" size={14} />}Read new now</button>}
          {a.liveBotAvailable && a.readMeetings && <Link className="btn btn-ghost btn-sm" to={`/meetings?s=notetaker&project=${projectId}`}><Icon name="video" size={14} />Send to a call</Link>}
        </div>
        <p className="ag-meta">{a.lastRunAt ? `Last read ${timeAgo(a.lastRunAt)}` : 'Has not read anything yet'} · {a.runsThisMonth}/{a.monthlyRunLimit} readings this month
          {a.actingUserName && <> · acts as {a.actingUserName}</>}</p>
        <CreditMeter a={a} manage={manage} save={save} />
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
        <p className="ag-hint"><Link to="/?tab=mail-agent">Let it look in my own inbox too</Link></p>
      </div>

      <AutonomyPanel a={a} manage={manage} busy={busy !== null} save={save} />
      {manage && <TrustPanel projectId={projectId} onChanged={refresh} />}

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

      {tuning && <TuneModal a={a} onClose={() => setTuning(false)} onSave={async (patch) => { await agentApi.save(projectId, { enabled: a.enabled, ...patch }); refresh(); setTuning(false); toast('Saved. The next reading uses it.'); }} />}
      {transcript && <TranscriptModal projectId={projectId} onClose={() => setTranscript(false)} onDone={() => { setTranscript(false); refresh(); }} />}
    </div>
  );
}

/**
 * The project agent as one switch (the project's Activity tab): on or off, how many proposals wait, and where its behaviour is set.
 * Switching it on the first time keeps the settings it had (or the defaults); everything else is in Settings › AI › Project agent.
 */
export function ProjectAgentSwitch({ projectId, archived }: { projectId: string; archived: boolean }) {
  const { q, busy, save } = useAgent(projectId);
  if (!q.data) return q.isError ? null : <div className="card ag-switch"><PageLoader /></div>;
  const a = q.data;
  const manage = a.canManage && !archived;
  return (
    <section className="card ag-switch" aria-label="Project agent">
      <span className="ag-switch-mark" aria-hidden="true"><Icon name="agent" size={18} /></span>
      <div className="ag-switch-text">
        <b>Project agent</b>
        <span>{!a.aiAvailable && !a.enabled ? 'Needs the AI assistant, which is off or not on this plan.'
          : a.enabled ? `Reads this project's mail, chat and meetings and proposes updates${a.pending ? ` · ${a.pending} to review` : ''}${a.lastRunAt ? ` · last read ${timeAgo(a.lastRunAt)}` : ''}.`
          : 'Off. Switch it on to have it read the project’s mail, chat and meetings and propose updates. Nothing changes until someone approves.'}</span>
        <Link className="ag-switch-link" to={`/settings/ai/project-agent?project=${projectId}`}>Set how the agent behaves ›</Link>
      </div>
      <button type="button" className={`switch ${a.enabled ? 'on' : ''}`} role="switch" aria-checked={a.enabled} aria-label="Project agent"
        disabled={!manage || busy !== null || (!a.enabled && !a.aiAvailable)} title={manage ? undefined : 'Someone who can edit this project can switch it'} onClick={() => void save({ enabled: !a.enabled })} />
    </section>
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

const LEVELS: { n: number; name: string; text: string }[] = [
  { n: 1, name: 'Observer', text: 'Takes notes, writes the minutes and proposes. Silent in meetings apart from its hello.' },
  { n: 2, name: 'Assistant', text: 'Also reminds the team in the meeting chat when something important is being missed.' },
  { n: 3, name: 'Participant', text: 'Also answers questions in the meeting chat from the tracker - status, owner, dates, what is late or blocked.' },
  { n: 4, name: 'Delegate', text: 'Also carries out safe proposals itself when it is sure enough. Changes to existing work always wait for you.' },
];
const SAFE: { kind: AgentFindingKind; label: string }[] = [
  { kind: 'CreateActionItem', label: 'Action items' }, { kind: 'CreateTask', label: 'New tasks' }, { kind: 'CreateIssue', label: 'Tickets' },
  { kind: 'Decision', label: 'Decisions' }, { kind: 'Suggestion', label: 'Suggestions' }, { kind: 'Missed', label: 'Missed points' },
];

/** How much the agent may do by itself: a level, and at level 4 which safe kinds it may carry out and how sure it must be. */
function AutonomyPanel({ a, manage, busy, save }: { a: ProjectAgent; manage: boolean; busy: boolean; save: (p: AgentSettingsPatch) => Promise<void> }) {
  const level = LEVELS.find((l) => l.n === a.autonomyLevel) ?? LEVELS[1];
  const kinds = a.autoApplyKinds ?? [];
  const toggle = (k: AgentFindingKind) => void save({ autoApplyKinds: kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k] });
  // The project's level is capped by the workspace's level for the project agent (Settings › AI): level 4 only acts by itself at "Auto".
  const control = useWsQuery(['ai', 'control'], aiControlApi.get, { staleTime: 30_000, retry: false });
  const ws = control.data?.agents?.find?.((x) => x.id === 'project')?.level;
  const WS_LABEL = { off: 'Off', suggest: 'Suggest', askFirst: 'Ask first', auto: 'Auto' } as const;
  return (
    <div className="card ag-panel">
      <h4 className="ag-panel-title"><Icon name="shield" size={14} /> Autonomy</h4>
      <div className="ag-levels" role="radiogroup" aria-label="Autonomy level">
        {LEVELS.map((l) => (
          <button key={l.n} type="button" role="radio" aria-checked={l.n === level.n} className={`ag-level ${l.n === level.n ? 'on' : ''}`} disabled={!manage || busy}
            onClick={() => l.n !== level.n && void save({ autonomyLevel: l.n })}><b>{l.n}</b><span>{l.name}</span></button>
        ))}
      </div>
      <p className="ag-level-text">{level.text}</p>
      {ws && ws !== 'auto' && (level.n === 4 || ws === 'off') && (
        <p className="ag-hint" role="note"><Icon name="info" size={12} />
          {ws === 'off' ? 'The project agent is Off for the whole workspace, so it does nothing here until an admin turns it back on.'
            : `Level 4 only acts by itself when the workspace sets the project agent to Auto. It is ${WS_LABEL[ws]} now, so ${ws === 'suggest' ? 'it only suggests' : 'its changes wait in the inbox'}.`}
          {' '}<Link to="/settings/ai">Settings › AI</Link></p>
      )}
      {level.n === 4 && (
        <>
          <div className="ag-kinds" aria-label="May carry out by itself">
            {SAFE.map((k) => <button key={k.kind} type="button" className={kinds.includes(k.kind) ? 'on' : ''} aria-pressed={kinds.includes(k.kind)} disabled={!manage || busy} onClick={() => toggle(k.kind)}>{k.label}</button>)}
          </div>
          <Field label={`Only when at least ${a.autoApplyConfidence}% sure`}>
            <input type="range" className="cmd-range" min={70} max={100} step={5} value={a.autoApplyConfidence} disabled={!manage || busy} aria-label="Confidence"
              onChange={(e) => void save({ autoApplyConfidence: Number(e.target.value) })} />
          </Field>
          <p className="ag-hint"><Icon name="info" size={12} />Only proposals whose quote was found in the source, and new work with an owner. Every one is in the audit trail.</p>
        </>
      )}
      <ul className="ag-sources">
        <li><Icon name="flag" size={15} /><span><b>Check-ins</b><small>On the due day, ask owners of agreed work how it stands</small></span>
          <button type="button" className={`switch ${a.followUps ? 'on' : ''}`} role="switch" aria-checked={a.followUps} aria-label="Check-ins" disabled={!manage || busy} onClick={() => void save({ followUps: !a.followUps })} /></li>
        <li><Icon name="note" size={15} /><span><b>Briefs before meetings</b><small>What is late, stuck and waiting - to the people invited</small></span>
          <button type="button" className={`switch ${a.meetingBriefs ? 'on' : ''}`} role="switch" aria-checked={a.meetingBriefs} aria-label="Briefs before meetings" disabled={!manage || busy} onClick={() => void save({ meetingBriefs: !a.meetingBriefs })} /></li>
      </ul>
      <p className="ag-hint"><Link to="/command-center?tab=audit">Audit trail</Link> · <Link to="/command-center?tab=decisions">Decisions</Link></p>
    </div>
  );
}

/** AI credits the agent used for this project this month, against the lead's monthly cap (0 = none). */
function CreditMeter({ a, manage, save }: { a: ProjectAgent; manage: boolean; save: (p: AgentSettingsPatch) => Promise<void> }) {
  const used = a.creditsThisMonth ?? 0;
  const cap = a.monthlyCreditCap ?? 0;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(cap || ''));
  const share = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : null;
  const tone = share == null ? '' : share >= 100 ? 'bad' : share >= 80 ? 'warn' : '';
  return (
    <div className="ag-credits">
      <div className="ag-credits-head">
        <span><Icon name="bolt" size={13} /> <b>{used.toLocaleString()}</b> AI credits this month{cap > 0 && <> of <b>{cap.toLocaleString()}</b></>}</span>
        {manage && !editing && <button type="button" className="ag-link" onClick={() => { setValue(String(cap || '')); setEditing(true); }}>{cap > 0 ? 'Change cap' : 'Set a cap'}</button>}
      </div>
      {share != null && <div className={`ag-credits-bar ${tone}`} role="meter" aria-label="Credits used of the monthly cap" aria-valuemin={0} aria-valuemax={100} aria-valuenow={share}><i style={{ width: `${share}%` }} /></div>}
      {share != null && share >= 100 && <p className="ag-hint ag-hint-bad"><Icon name="alert" size={12} />The cap is reached: the agent reads again on the 1st, or raise the cap.</p>}
      {editing && (
        <form className="ag-credits-form" onSubmit={(e) => { e.preventDefault(); void save({ monthlyCreditCap: Math.max(0, Math.round(Number(value) || 0)) }).then(() => setEditing(false)); }}>
          <input className="input" type="number" min={0} max={100000} step={10} inputMode="numeric" aria-label="Monthly credit cap" placeholder="No cap" value={value} onChange={(e) => setValue(e.target.value)} />
          <button type="submit" className="btn btn-primary btn-sm">Save</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>
          <small>0 or empty = no cap; the workspace's own credits still apply.</small>
        </form>
      )}
    </div>
  );
}

const KIND_NAME: Record<AgentFindingKind, string> = {
  CreateTask: 'New tasks', UpdateTask: 'Task updates', CreateActionItem: 'Action items', CreateIssue: 'Tickets', UpdateIssue: 'Ticket updates',
  Delay: 'Delays', Missed: 'Missed points', Suggestion: 'Suggestions', Decision: 'Decisions',
};

/**
 * Earned trust: for each kind of proposal, how often the team approved it unchanged (last 90 days) and why it dismissed the rest - and, once a
 * safe kind is approved unchanged 95% of at least 30 times, the offer to let the agent do it alone.
 */
function TrustPanel({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['agent', 'autonomy', projectId], () => agentApi.autonomy(projectId), { staleTime: 60_000 });
  const [busy, setBusy] = useState<string | null>(null);
  if (!q.data?.kinds) return null;
  const r: AgentAutonomyReport = q.data;
  const act = async (kind: AgentFindingKind, accept: boolean) => {
    setBusy(kind);
    try {
      if (accept) await agentApi.acceptAutonomy(projectId, kind); else await agentApi.dismissAutonomy(projectId, kind);
      toast(accept ? `The agent now creates ${KIND_NAME[kind].toLowerCase()} by itself (level 4 for this kind only).` : 'Not now - it will not ask again for this kind.');
      void invalidateWorkspace(wid, 'agent'); onChanged();
    } catch (e) { toast(errText(e, 'Could not save that.'), 'error'); }
    finally { setBusy(null); }
  };
  const shown = r.kinds.filter((k) => k.decided > 0).slice(0, 7);
  return (
    <div className="card ag-panel ag-trust">
      <h4 className="ag-panel-title"><Icon name="target" size={14} /> How the team decides</h4>
      {r.hints.map((h) => (
        <div key={h.kind} className="ag-earned" role="status">
          <span className="ag-earned-mark"><Icon name="sparkle" size={14} /></span>
          <p>{h.message}</p>
          <div>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void act(h.kind, true)}>{busy === h.kind ? <span className="spinner" /> : <Icon name="tick" size={13} />}Yes, let it</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void act(h.kind, false)}>Not now</button>
          </div>
        </div>
      ))}
      {shown.length === 0 ? <p className="ag-hint">Once the team has decided on some proposals, you see here how often each kind is approved as proposed.</p> : (
        <ul className="ag-trust-list">
          {shown.map((k) => (
            <li key={k.kind} title={`${k.approvedAsIs} approved as proposed, ${k.edited} changed first, ${k.dismissed} dismissed`}>
              <div><span>{KIND_NAME[k.kind]}</span>{k.automatic && <em className="ag-auto"><Icon name="sparkle" size={10} />Auto</em>}<b>{k.rate ?? 0}%</b></div>
              <div className="ag-trust-bar" aria-hidden>
                <i className="ok" style={{ flexGrow: k.approvedAsIs }} /><i className="edit" style={{ flexGrow: k.edited }} /><i className="no" style={{ flexGrow: k.dismissed }} />
              </div>
              <small>{k.decided} decided{k.reasons.length > 0 && <> · dismissed: {k.reasons.slice(0, 2).map((x) => `${x.label} ${x.count}`).join(', ')}</>}</small>
            </li>
          ))}
        </ul>
      )}
      <p className="ag-hint"><i className="ag-dot ok" />as proposed <i className="ag-dot edit" />changed <i className="ag-dot no" />dismissed · last 90 days. Suggested after {r.minRate}% of {r.minDecisions}+.</p>
    </div>
  );
}

