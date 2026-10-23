import { useState } from 'react';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { confirmDialog, toast } from '../../stores/ui';
import { vaultApi, type VaultCollection } from './api';
import { useStepUp } from './stepUpContext';
import { workflowSnippet } from './machineSnippet';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/**
 * Pipelines that may read a guarded collection: GitHub Actions runs of one repository, on chosen branches (and an environment, when set),
 * proving who they are with the token GitHub gives each run. Nothing to store in GitHub's secrets, nothing to rotate.
 */
export function MachinesPanel({ collection }: { collection: VaultCollection }) {
  const step = useStepUp();
  const q = useWsQuery(['vault', 'machines', collection.id], () => vaultApi.machines(collection.id), { staleTime: 30_000 });
  const [adding, setAdding] = useState(false);
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [env, setEnv] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const rows = q.data ?? [];
  return (
    <div className="vlt-machines" data-testid="machines">
      <div className="vlt-machines-head">
        <b><Icon name="git" size={14} /> Pipelines</b>
        <span className="muted vlt-small">GitHub Actions runs that may read every value here, with GitHub’s own token for the run: no secret to store in GitHub.</span>
      </div>
      {q.isLoading ? <Spinner /> : rows.length > 0 && (
        <ul className="vlt-req-list">{rows.map((m) => (
          <li key={m.id} data-machine={m.repository}>
            <span className="vlt-req-main">
              <b>{m.repository}</b>
              <span className="muted vlt-small">{m.refPattern.replace(/^refs\/heads\//, '')}{m.environment ? ` · environment ${m.environment}` : ''}{m.pinned ? ' · pinned to its repository id' : ''} · {m.lastUsedAt ? `last read ${timeAgo(m.lastUsedAt)}` : 'not used yet'}</span>
              {open === m.id && (
                <>
                  <span className="vlt-small muted">Variables: {m.variables.join(', ') || 'none yet'}</span>
                  <pre className="vlt-snippet" data-testid="workflow-snippet">{workflowSnippet(m)}</pre>
                  <span><button type="button" className="btn btn-ghost btn-xs" onClick={() => void navigator.clipboard?.writeText(workflowSnippet(m)).then(() => toast('Workflow steps copied.'))}><Icon name="copy" size={12} /> Copy the steps</button></span>
                </>
              )}
            </span>
            <div className="vlt-req-actions">
              <button type="button" className="btn btn-ghost btn-xs" aria-expanded={open === m.id} onClick={() => setOpen(open === m.id ? null : m.id)}>{open === m.id ? 'Hide' : 'How to use'}</button>
              <button type="button" className="btn btn-ghost btn-xs danger" onClick={async () => {
                if (!(await confirmDialog({ title: `Stop ${m.repository} reading this?`, message: 'Its next run gets nothing from the vault.', confirmText: 'Remove' }))) return;
                try { await vaultApi.removeMachine(m.id); void q.refetch(); } catch (e) { toast(errText(e, 'Could not remove it.'), 'error'); }
              }}>Remove</button>
            </div>
          </li>
        ))}</ul>
      )}
      {adding ? (
        <div className="vlt-machine-form">
          <input className="input" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repository" aria-label="Repository" autoFocus />
          <input className="input" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main, release/*, refs/tags/v*" aria-label="Branch or tag" />
          <input className="input" value={env} onChange={(e) => setEnv(e.target.value)} placeholder="Environment (optional), e.g. production" aria-label="Environment" />
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="vlt-unlock-ways">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setAdding(false); setError(null); }}>Cancel</button>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !repo.includes('/')} onClick={async () => {
              setBusy(true); setError(null);
              try {
                const m = await step.run((t) => vaultApi.addMachine(collection.id, { repository: repo.trim(), refPattern: branch.trim() || 'main', environment: env.trim() || null, label: null, stepUp: t }), true);
                if (m) { toast(`${m.repository} may read this collection.`); setAdding(false); setRepo(''); setEnv(''); setOpen(m.id); void q.refetch(); }
              } catch (e) { setError(errText(e, 'Could not add it.')); }
              finally { setBusy(false); }
            }}>{busy && <span className="spinner" />}Allow this pipeline</button>
          </div>
          <p className="vlt-small muted"><Icon name="shield" size={12} /> Needs a fresh two-step check. Prefer an environment with required reviewers in GitHub for production secrets.</p>
        </div>
      ) : <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Allow a GitHub Actions pipeline</button>}
    </div>
  );
}
