import { useState } from 'react';
import { ApiError } from '../../api/client';
import { agentApi } from '../../api/endpoints';
import type { AgentWorkspace } from '../../api/types';
import { Icon } from '../../components/Icon';
import { ErrorState, Field, PageLoader } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import '../agent/agent.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);

/** For owners and admins: the notetaker's name in meetings and whether it may post reminders in the chat of meetings that made no choice. */
export function NotetakerWorkspaceSettings() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['agent', 'workspace'], agentApi.workspace);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const w: AgentWorkspace = q.data;
  const save = async (b: Parameters<typeof agentApi.saveWorkspace>[0], done?: string) => {
    setBusy(true);
    try { await agentApi.saveWorkspace(b); setName(null); await invalidateWorkspace(wid, 'agent'); if (done) toast(done); }
    catch (e) { toast(errText(e, 'Could not save.'), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="card ag-settings">
      <div className="card-body">
        <h3 className="ag-settings-title"><Icon name="video" size={16} /> Notetaker for this workspace</h3>
        <p className="ag-hint">Each meeting chooses its notetaker when it is scheduled (none, transcription, or transcription with voice suggestions).
          Here you name it and decide whether meetings that made no choice get reminders in their chat.</p>
        <div className={`ag-callout ${w.botAvailable ? 'ok' : ''}`}><Icon name={w.botAvailable ? 'checkCircle' : 'info'} size={15} />
          <span>{w.botAvailable ? `Ready · ${w.enabledProjects} project${w.enabledProjects === 1 ? '' : 's'} with the agent on`
            : 'The meeting bot is not running on this installation yet. Until it is, Google Meet transcripts are read after each meeting.'}</span></div>
        <ul className="ag-bot-notes">
          <li><Icon name="users" size={14} />In Google Meet and Teams it joins as a guest by name, and the host lets it in. In Project Tracker calls it is let in by itself.</li>
          <li><Icon name="mail" size={14} />Minutes go out in the organizer's name; replies go to the organizer.</li>
          <li><Icon name="shield" size={14} />Nothing it hears changes a project until someone who can edit the project approves it.</li>
        </ul>
        {w.canManage ? (
          <div className="form-grid ag-bot-form">
            <Field label="Bot name" hint="How it appears in the meeting."><input className="input" aria-label="Bot name" value={name ?? w.botName} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>
            <div className="ag-provider">
              <span><b>Chat reminders by default</b><small>For meetings that made no choice: post in the meeting chat when something is missed</small></span>
              <button type="button" className={`switch ${w.inCallReminders ? 'on' : ''}`} role="switch" aria-checked={w.inCallReminders} aria-label="Reminders during the meeting"
                disabled={busy} onClick={() => void save({ inCallReminders: !w.inCallReminders })} />
            </div>
            <div className="ag-bot-actions full">
              <button type="button" className="btn btn-primary" disabled={busy || name === null || !name.trim()} onClick={() => void save({ botName: name!.trim() }, 'Saved.')}>{busy && <span className="spinner" />}Save</button>
            </div>
          </div>
        ) : <p className="muted">Workspace owners and admins choose the bot's name and whether it reminds people.</p>}
      </div>
    </div>
  );
}
