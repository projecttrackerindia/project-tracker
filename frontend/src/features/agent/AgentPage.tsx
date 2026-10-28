import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { agentApi } from '../../api/endpoints';
import type { AgentFinding, AgentInboxOptIn } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, PageHead, PageLoader, Segmented } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { FindingCard } from './FindingCard';
import './agent.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
export type AgentSection = 'review' | 'assigned' | 'my-inbox';

/**
 * Project agent: everything waiting for my decision across projects, work given to me, and my own inbox opt-in. In v2 it sits on Home
 * (/?tab=proposals, given, mail-agent) until the Home inbox takes these rows over. The meeting bot's settings are in Talk › Meetings › Notetaker.
 */
export function AgentPage({ section, onSection }: { section: AgentSection; onSection: (s: AgentSection) => void }) {
  const inbox = useWsQuery(['agent', 'inbox'], agentApi.inbox, { enabled: section === 'review' });
  const assigned = useWsQuery(['agent', 'assigned'], agentApi.assigned);
  return (
    <>
      <PageHead eyebrow="Groot · Project agent" title="Proposals" sub="Proposals from your projects' email, chat and meetings, waiting for a decision.">
        <Segmented label="Project agent" value={section} onChange={onSection} options={[
          { id: 'review', label: 'To review', count: inbox.data?.pending || undefined },
          { id: 'assigned', label: 'Given to me', count: assigned.data?.pending || undefined },
          { id: 'my-inbox', label: 'My inbox' },
        ]} />
      </PageHead>
      <div className="ag-page">
        {section === 'review' && (inbox.isLoading ? <PageLoader /> : inbox.isError ? <ErrorState error={inbox.error} retry={() => inbox.refetch()} />
          : (inbox.data?.items.length ?? 0) === 0
            ? <EmptyState icon="checkCircle" title="Nothing waiting for you" text="Switch the agent on in a project (its Agent tab). What it finds in the project's email, chat and meetings appears here for the people who can edit that project." action={<Link className="btn btn-ghost" to="/work/projects">Open projects</Link>} />
            : <div className="ag-list">{inbox.data!.items.map((f) => <FindingCard key={f.id} f={f} canDecide showProject />)}</div>)}
        {section === 'assigned' && (assigned.isLoading ? <PageLoader /> : assigned.isError ? <ErrorState error={assigned.error} retry={() => assigned.refetch()} />
          : (assigned.data?.items.length ?? 0) === 0
            ? <EmptyState icon="user" title="Nothing given to you" text="When someone approves work the agent found for you - from a meeting, an email or the chat - it shows here so you can accept it, or say whose it is." />
            : <div className="ag-list">{assigned.data!.items.map((f) => <GivenCard key={f.id} f={f} />)}</div>)}
        {section === 'my-inbox' && <MyInbox />}
      </div>
    </>
  );
}

/** Work the agent gave me: accept it, or say it is not mine (and whose it is). */
function GivenCard({ f }: { f: AgentFinding }) {
  const wid = useWorkspaceId();
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const answer = async (response: 'accepted' | 'declined') => {
    setBusy(true);
    try {
      await agentApi.respond(f.id, { response, note: response === 'declined' ? note.trim() : undefined });
      toast(response === 'accepted' ? 'Thanks - it is yours.' : 'The project lead has been told.');
      await invalidateWorkspace(wid, 'agent', 'assigned');
    } catch (e) { toast(errText(e, 'Could not save.'), 'error'); }
    finally { setBusy(false); }
  };
  const link = f.kind === 'CreateTask' && f.appliedEntityId ? `/work?item=${f.appliedEntityId}` : `/projects/${f.projectId}`;
  return (
    <article className={`ag-card ${f.ownerResponse ? 'ag-closed' : ''}`} data-given={f.id}>
      <header className="ag-card-head">
        <span className="ag-kind"><Icon name="user" size={13} />{f.kind === 'CreateIssue' ? 'Ticket' : f.kind === 'CreateActionItem' ? 'Action item' : 'Task'}</span>
        <Link className="ag-project" to={link}>{f.appliedKey ?? f.projectKey} · {f.projectName}</Link>
      </header>
      <h4 className="ag-title">{f.title}</h4>
      {f.evidence && <blockquote className="ag-quote"><p>“{f.evidence}”</p><footer>{f.sourceLabel ?? 'Source'}{f.decidedBy && ` · approved by ${f.decidedBy.name}`}</footer></blockquote>}
      {f.ownerResponse ? (
        <p className="ag-meta">{f.ownerResponse === 'accepted' ? 'You accepted it.' : `You said it is not yours${f.ownerNote ? `: ${f.ownerNote}` : ''}.`}</p>
      ) : declining ? (
        <div className="ag-mine-actions">
          <input className="input" aria-label="Whose is it, or why not you" value={note} maxLength={500} placeholder="Priya owns refunds" onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !note.trim()} onClick={() => void answer('declined')}>{busy && <span className="spinner" />}Send</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDeclining(false)}>Cancel</button>
        </div>
      ) : (
        <div className="ag-mine-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void answer('accepted')}><Icon name="tick" size={14} />It's mine</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setDeclining(true)}><Icon name="close" size={14} />Not mine</button>
        </div>
      )}
    </article>
  );
}

function MyInbox() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['agent', 'my-inbox'], agentApi.myInbox);
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const o: AgentInboxOptIn = q.data;
  const set = async (provider: 'google' | 'microsoft' | undefined, enabled: boolean) => {
    setBusy(true);
    try { await agentApi.saveMyInbox({ provider, enabled }); await invalidateWorkspace(wid, 'agent', 'my-inbox'); toast(enabled ? 'The agent will look in your inbox for mail about your projects.' : 'The agent no longer looks in your inbox.'); }
    catch (e) { toast(errText(e, 'Could not save.'), 'error'); }
    finally { setBusy(false); }
  };
  const none = !o.googleAvailable && !o.microsoftAvailable;
  return (
    <div className="card ag-settings">
      <div className="card-body">
        <h3 className="ag-settings-title"><Icon name="mail" size={16} /> Let the agent read my mail about my projects</h3>
        <p className="ag-hint">Every half hour, the agent looks in your own Gmail or Outlook for mail that mentions a project you work on (its name or key) and that has the
          agent switched on. Matching mail is read like mail to the project's own address: what it finds is proposed to the project's editors, with a short quote.
          Nothing else in your mailbox is read, kept or shown. You can switch this off at any time.</p>
        {none ? (
          <div className="ag-callout"><Icon name="info" size={15} /><span>Connect Gmail or Outlook with inbox access first in <Link to="/account/integrations">Account › Connected accounts</Link>.</span></div>
        ) : (
          <div className="ag-providers">
            {(['google', 'microsoft'] as const).map((p) => {
              const available = p === 'google' ? o.googleAvailable : o.microsoftAvailable;
              const on = o.enabled && o.provider === p;
              return (
                <div key={p} className={`ag-provider ${on ? 'on' : ''}`}>
                  <span><b>{p === 'google' ? 'Gmail' : 'Outlook'}</b><small>{available ? (on ? 'The agent looks here' : 'Connected') : 'Not connected with inbox access'}</small></span>
                  <button type="button" className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={`Use ${p === 'google' ? 'Gmail' : 'Outlook'}`}
                    disabled={busy || !available} onClick={() => void set(p, !on)} />
                </div>
              );
            })}
          </div>
        )}
        {o.enabled && <p className="ag-meta">{o.scannedUntil ? `Last looked ${formatDateTime(o.scannedUntil)}` : 'Not looked yet'} · {o.found} found so far</p>}
        {o.lastError && <div className="form-error" role="alert">{o.lastError}</div>}
      </div>
    </div>
  );
}

