import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { LiveKitRoom, PreJoin, RoomAudioRenderer, useParticipants, type LocalUserChoices } from '@livekit/components-react';
import '@livekit/components-styles';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { ErrorState, PageLoader } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { callsApi, isAgent, type Call, type CallJoin } from './callsApi';
import { CallStage } from './CallStage';
import './calls.css';

// The call covers the whole screen, drawn straight onto the page so nothing around it (a phone's tab bar, a transformed page) clips it.
const FullScreen = ({ children }: { children: ReactNode }) => createPortal(children, document.body);

/**
 * One of our own video calls. First a check of camera and microphone (nothing is sent yet), then the call: everyone's video, screen sharing,
 * the call chat and device choices. If the project agent was asked along it appears as a participant marked "Agent" - it joined by itself,
 * and everyone can see that it is listening. The host can end the call for everyone; anyone can leave.
 */
export function CallPage({ id }: { id: string }) {
  const nav = useNavigate();
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx?.user.displayName ?? '');
  const info = useWsQuery(['calls', id], () => callsApi.get(id), { refetchInterval: 15_000 });
  const [join, setJoin] = useState<CallJoin | null>(null);
  const [choices, setChoices] = useState<LocalUserChoices | null>(null);
  const [left, setLeft] = useState(false);
  const [joining, setJoining] = useState(false);

  const enter = async (values: LocalUserChoices) => {
    setJoining(true);
    try { setJoin(await callsApi.join(id)); setChoices(values); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not join the call.', 'error'); void info.refetch(); }
    finally { setJoining(false); }
  };

  const endForAll = async () => {
    if (!(await confirmDialog({ title: 'End the call for everyone?', message: 'Everyone is disconnected. The agent, if it is here, writes up its notes.', confirmText: 'End call', danger: true }))) return;
    try { await callsApi.end(id); setJoin(null); setLeft(true); void info.refetch(); void invalidateWorkspace(wid, 'calls'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not end the call.', 'error'); }
  };

  if (info.isLoading) return <FullScreen><div className="call-shell over"><PageLoader /></div></FullScreen>;
  if (info.isError || !info.data) return <FullScreen><div className="call-shell over"><ErrorState error={info.error} retry={() => info.refetch()} /></div></FullScreen>;
  const call = info.data;

  if (call.status === 'ended' || left) return <FullScreen><div className="call-shell over"><CallOver call={call} rejoin={call.status === 'live' ? () => { setLeft(false); setJoin(null); } : undefined} /></div></FullScreen>;

  if (!join || !choices) {
    return (
      <FullScreen><div className="call-shell" data-lk-theme="default">
        <CallHeader call={call} onBack={() => nav(-1)} />
        <div className="call-prejoin" data-testid="call-prejoin">
          <div className="call-prejoin-intro">
            <h2>{call.title}</h2>
            <p>{call.people.filter((p) => p.inCall).length > 0 ? `${call.people.filter((p) => p.inCall).map((p) => p.name).slice(0, 4).join(', ')} ${call.people.filter((p) => p.inCall).length === 1 ? 'is' : 'are'} in the call.` : `Started by ${call.startedByName}.`}</p>
            {call.agentEnabled && <p className="call-agent-note"><Icon name="sparkle" size={14} /><span>The project agent is in this call taking notes. It writes down who said what and sends the minutes afterwards.</span></p>}
          </div>
          <PreJoin defaults={{ username: me, videoEnabled: true, audioEnabled: true }} joinLabel={joining ? 'Joining…' : 'Join the call'} userLabel="Your name" onSubmit={(v) => void enter(v)} onError={() => toast('The camera or microphone could not be opened. You can still join and turn them on later.', 'warning')} />
        </div>
      </div></FullScreen>
    );
  }

  return (
    <FullScreen><div className="call-shell in-call" data-lk-theme="default">
      <LiveKitRoom serverUrl={join.url} token={join.token} connect video={choices.videoEnabled ? { deviceId: choices.videoDeviceId } : false}
        audio={choices.audioEnabled ? { deviceId: choices.audioDeviceId } : false} options={{ adaptiveStream: true, dynacast: true }}
        onDisconnected={() => setLeft(true)} onError={(e) => toast(e.message, 'error')} className="call-room">
        <CallHeader call={call} onBack={() => nav(-1)} live onEnd={call.canEnd ? () => void endForAll() : undefined} />
        <div className="call-stage"><CallStage title={call.title} hostIdentity={call.startedBy ? `user:${call.startedBy.replace(/-/g, '')}` : null} /></div>
        <RoomAudioRenderer />
      </LiveKitRoom>
    </div></FullScreen>
  );
}

function AgentBadge() {
  const people = useParticipants();
  const agent = people.find((p) => isAgent(p.identity));
  if (!agent) return null;
  return <span className="call-badge agent" title="The project agent joined by itself and is writing down who said what" data-testid="call-agent-badge"><Icon name="sparkle" size={12} /> {agent.name || 'Agent'} is taking notes</span>;
}

function InCallCount() {
  const people = useParticipants();
  const humans = people.filter((p) => !isAgent(p.identity)).length;
  return <span className="call-badge"><Icon name="users" size={12} /> {humans}</span>;
}

function CallHeader({ call, onBack, live = false, onEnd }: { call: Call; onBack: () => void; live?: boolean; onEnd?: () => void }) {
  const copy = async () => {
    try { await navigator.clipboard.writeText(`${window.location.origin}/calls/${call.id}`); toast('Link copied. People in this workspace who may join can open it.'); }
    catch { toast('Could not copy the link.', 'error'); }
  };
  return (
    <header className="call-head">
      <button type="button" className="call-icon-btn" onClick={onBack} aria-label="Back"><Icon name="arrowLeft" size={18} /></button>
      <div className="call-head-title">
        <b>{call.title}</b>
        <small>{call.projectKey ? <Link to={`/work/projects/${call.projectId}`}>{call.projectKey}</Link> : call.kind === 'chat' ? 'Chat call' : 'Call'} · started {formatDateTime(call.startedAt)}</small>
      </div>
      {live && <InCallCount />}
      {live && <AgentBadge />}
      <button type="button" className="call-icon-btn" onClick={() => void copy()} aria-label="Copy the link to this call" title="Copy link"><Icon name="link" size={17} /></button>
      {onEnd && <button type="button" className="call-end" onClick={onEnd} data-testid="call-end-all" aria-label="End the call for everyone" title="End the call for everyone"><Icon name="phoneOff" size={15} /><span>End for everyone</span></button>}
    </header>
  );
}

function CallOver({ call, rejoin }: { call: Call; rejoin?: () => void }) {
  const minutes = call.endedAt ? Math.max(1, Math.round((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 60_000)) : null;
  const joined = call.people.filter((p) => p.joinedAt);
  useEffect(() => { document.title = `${call.title} · Call`; }, [call.title]);
  return (
    <div className="call-over" data-testid="call-over">
      <Icon name="video" size={34} />
      <h2>{rejoin ? 'You left the call' : 'This call has ended'}</h2>
      <p>{call.title}{minutes ? ` · ${minutes} minute${minutes === 1 ? '' : 's'}` : ''}{joined.length ? ` · ${joined.map((p) => p.name).slice(0, 6).join(', ')}` : ''}</p>
      {call.agentEnabled && call.projectId && <p className="call-agent-note"><Icon name="sparkle" size={14} /><span>The agent's notes, minutes and follow-ups will be in the project's <Link to={`/projects/${call.projectId}?tab=agent`}>Agent</Link> tab shortly.</span></p>}
      <div className="call-over-actions">
        {rejoin && <button type="button" className="btn btn-primary" onClick={rejoin}><Icon name="video" size={14} /> Rejoin</button>}
        <Link className="btn" to={call.projectId ? `/work/projects/${call.projectId}` : call.conversationId ? `/messages/${call.conversationId}` : '/'}>Back to {call.projectId ? 'the project' : call.conversationId ? 'the chat' : 'Home'}</Link>
      </div>
    </div>
  );
}
