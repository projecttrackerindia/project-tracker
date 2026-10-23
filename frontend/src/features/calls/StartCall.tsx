import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { Modal, Spinner } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { callsApi } from './callsApi';

interface Person { userId: string; name: string }

/**
 * Starts one of our own video calls - in a project (with its people, and optionally the project agent taking notes) or in a chat - and opens it.
 * Shown only where calls are set up.
 */
export function StartCallButton({ projectId, conversationId, people = [], label = 'Start a call', compact = false, agentAvailable = false, className }: {
  projectId?: string; conversationId?: string; people?: Person[]; label?: string; compact?: boolean; agentAvailable?: boolean; className?: string;
}) {
  const status = useWsQuery(['calls', 'status'], callsApi.status, { staleTime: 600_000, retry: false });
  const [open, setOpen] = useState(false);
  if (!status.data?.available) return null;
  return (
    <>
      <button type="button" className={className ?? (compact ? 'btn btn-ghost btn-icon' : 'btn btn-sm')} onClick={() => setOpen(true)} aria-label={label} title={label} data-testid="start-call">
        <Icon name="video" size={compact ? 17 : 14} />{!compact && <span>{label}</span>}
      </button>
      {open && <StartCallModal projectId={projectId} conversationId={conversationId} people={people} agentAvailable={agentAvailable} onClose={() => setOpen(false)} />}
    </>
  );
}

function StartCallModal({ projectId, conversationId, people, agentAvailable, onClose }: { projectId?: string; conversationId?: string; people: Person[]; agentAvailable: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const me = useAuth((s) => s.ctx?.user.id);
  const others = useMemo(() => people.filter((p) => p.userId !== me), [people, me]);
  const [title, setTitle] = useState('');
  const [invite, setInvite] = useState<Set<string>>(() => new Set(others.length <= 12 ? others.map((p) => p.userId) : []));
  const [agent, setAgent] = useState(agentAvailable);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const call = await callsApi.start({ title: title.trim() || undefined, projectId: projectId ?? null, conversationId: conversationId ?? null, invite: [...invite], agent: !!projectId && agent });
      if (agent && projectId && !call.agentEnabled && call.agentStatus) toast(call.agentStatus, 'info');
      nav(`/calls/${call.id}`);
    } catch (e) { toast(e instanceof ApiError ? e.message : 'The call could not be started.', 'error'); setBusy(false); }
  };
  const toggle = (id: string) => setInvite((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Modal title="Start a call" onClose={onClose} footer={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void start()} data-testid="start-call-go">{busy ? <Spinner /> : <Icon name="video" size={14} />} Start</button>
    </>}>
      <div className="call-start">
        <div className="field">
          <label htmlFor="call-title">Title (optional)</label>
          <input id="call-title" className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder={conversationId ? 'Chat call' : 'Stand-up, review, quick sync…'} />
        </div>
        {conversationId && <p className="muted call-start-note"><Icon name="users" size={14} /><span>Everyone in this chat gets a notification to join.</span></p>}
        {others.length > 0 && (
          <fieldset className="call-invite">
            <legend>Notify {invite.size > 0 ? `${invite.size} ${invite.size === 1 ? 'person' : 'people'}` : 'nobody yet'}</legend>
            <div className="call-invite-list">
              {others.map((p) => (
                <label key={p.userId} className="call-invite-item"><input type="checkbox" checked={invite.has(p.userId)} onChange={() => toggle(p.userId)} /> {p.name}</label>
              ))}
            </div>
            <small className="muted">Anyone in the project can join from the link too.</small>
          </fieldset>
        )}
        {projectId && (
          <label className="call-agent">
            <input type="checkbox" checked={agent} onChange={(e) => setAgent(e.target.checked)} />
            <span><b>Bring the project agent</b><small>It joins by itself (no one has to let it in), writes down who said what, and sends the minutes and follow-ups after the call. Everyone sees it in the call.</small></span>
          </label>
        )}
      </div>
    </Modal>
  );
}
