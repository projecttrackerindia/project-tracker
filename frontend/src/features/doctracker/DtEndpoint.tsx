import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { apiDocApi } from '../../api/endpoints';
import { API_STAGES, type DtCatalog, type DtEndpoint, type DtProject, type EndpointDetail } from '../../api/types';
import { Icon } from '../../components/Icon';
import { ErrorState, Field, Kpi, Modal, PageLoader } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { EndpointEditor } from '../documents/ApiEndpointEditor';
import { EndpointArticle } from '../documents/ApiView';
import { pid, useDtNav } from './DocTrackerPage';
import { ScoreRing } from './DtHome';

/** A documentation score as a letter: A from 90, B from 75, C from 60, D below. */
const grade = (score: number) => (score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D');

/** Ask why, then show the masked values for a few seconds (audited). */
export function RevealModal({ onClose, onReveal }: { onClose: () => void; onReveal: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setError(null);
    try { await onReveal(reason.trim()); } catch (e) { setError(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not reveal.'); } finally { setBusy(false); }
  };
  return (
    <Modal title="Reveal masked values" subtitle="They show for a few seconds, then are masked again." onClose={onClose} onSubmit={(e) => { e.preventDefault(); void go(); }} className="doc-scope"
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy || reason.trim().length < 4}>{busy && <span className="spinner" />}Reveal</button></>}>
      {error && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{error}</div></div>}
      <Field label="Why do you need to see them?" hint="Recorded in the audit trail with your name and the time.">
        <input className="input" autoFocus value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Partner integration call" />
      </Field>
    </Modal>
  );
}

/** One endpoint in DocTracker: the reference (or its raw JSON), its documentation score and gaps, masked values with an audited reveal, and editing. */
export function DtEndpointView({ project, endpoint: e }: { project: DtProject; endpoint: DtEndpoint; catalog: DtCatalog }) {
  const nav = useDtNav();
  const wid = useWorkspaceId();
  const doc = e.documentId;
  const q = useWsQuery(['documents', doc, 'api-endpoint', e.id, ''], () => apiDocApi.endpoint(doc, e.id));
  const overview = useWsQuery(['documents', doc, 'api', ''], () => apiDocApi.overview(doc));
  const [shown, setShown] = useState<EndpointDetail | null>(null);
  const [left, setLeft] = useState(0);
  const [asking, setAsking] = useState(false);
  const [editing, setEditing] = useState<EndpointDetail | null>(null);
  const [view, setView] = useState<'docs' | 'json'>('docs');
  useEffect(() => { setShown(null); setLeft(0); setEditing(null); }, [e.id]);
  useEffect(() => {
    if (!shown || left <= 0) return;
    const t = setTimeout(() => { if (left <= 1) { setShown(null); toast('Masked again.'); } setLeft((s) => s - 1); }, 1000);
    return () => clearTimeout(t);
  }, [shown, left]);
  const remove = useMutation({
    mutationFn: () => apiDocApi.removeEndpoint(doc, e.id),
    onSuccess: () => { invalidateWorkspace(wid, 'documents'); toast('Endpoint removed.', 'warning'); nav.go({ p: pid(project), t: 'apis' }); },
    onError: (err) => toast(err instanceof ApiError ? err.message : 'Could not remove it.', 'error'),
  });
  const startEdit = async () => {
    try { setEditing(await apiDocApi.revealEndpoint(doc, e.id, { purpose: 'edit' })); }
    catch (err) { toast(err instanceof ApiError ? err.message : 'Could not open it for editing.', 'error'); }
  };

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const data = shown ?? q.data;
  const defs = overview.data?.definitions ?? [];
  const canEdit = !!overview.data?.canEdit && overview.data.live;
  const masked = q.data.maskedCount ?? 0;
  return (
    <div className="dt-ep">
      <nav className="dt-crumbs" aria-label="Breadcrumb">
        <button className="link-btn" onClick={() => nav.go({ p: pid(project) })}>{project.name}</button><Icon name="chevronR" size={11} />
        <button className="link-btn" onClick={() => nav.go({ p: pid(project), t: 'apis' })}>{e.definition}</button><Icon name="chevronR" size={11} />
        <span>{e.tag ?? 'Ungrouped'}</span>
      </nav>
      <h2 className="dt-ep-title">{q.data.item.summary || `${e.method} ${e.path}`}</h2>
      {q.data.details.description && <p className="dt-ep-desc">{q.data.details.description}</p>}
      <div className="dt-ep-kpis" data-testid="endpoint-kpis">
        <Kpi tile label="Documentation grade" value={`${grade(e.score)} · ${e.score}`} tone={e.score >= 75 ? 'success' : e.score >= 60 ? 'warning' : 'danger'} />
        <Kpi tile label="Things to add" value={e.gaps.length} tone={e.gaps.length ? 'warning' : undefined} />
        <Kpi tile label="Stage" value={API_STAGES.find((s) => s.id === e.stage)?.label ?? e.stage} small />
        <Kpi tile label="Masked values" value={masked} />
      </div>
      {masked > 0 && (
        <div className={`dt-mask${shown ? ' open' : ''}`} role="status">
          <Icon name={shown ? 'eye' : 'lock'} size={15} />
          {shown ? <span><b>Showing real values</b> · masked again in {left}s</span> : <span><b>{masked} value{masked === 1 ? '' : 's'} masked</b> · mobile numbers, IDs, account numbers and credentials are hidden</span>}
          {shown ? <button className="btn btn-ghost btn-sm" onClick={() => { setShown(null); setLeft(0); }}><Icon name="eyeOff" size={13} /> Hide now</button>
            : q.data.canReveal && <button className="btn btn-ghost btn-sm" onClick={() => setAsking(true)}><Icon name="eye" size={13} /> Reveal</button>}
        </div>
      )}
      <div className="dt-ep-body">
        <div className="dt-ep-main">
          <div className="dt-viewbar">
            <div className="seg" role="radiogroup" aria-label="View">
              <button role="radio" aria-checked={view === 'docs'} className={view === 'docs' ? 'on' : ''} onClick={() => setView('docs')}>Reference</button>
              <button role="radio" aria-checked={view === 'json'} className={view === 'json' ? 'on' : ''} onClick={() => setView('json')}>JSON</button>
            </div>
            <Link className="link-btn" to={`/documents/${doc}`}>Open the API document</Link>
          </div>
          {view === 'docs' ? (
            <EndpointArticle ep={data} definition={defs.find((d) => d.id === data.item.definitionId)} canEdit={canEdit} onEdit={() => void startEdit()}
              onDelete={async () => { if (await confirmDialog({ title: 'Remove this endpoint?', message: `${e.method} ${e.path} is removed from the working copy. Published versions keep it.`, confirmText: 'Remove' })) remove.mutate(); }} />
          ) : (
            <div className="apv-panel dt-json"><div className="apv-panel-bar"><b>{data.item.method} {data.item.path}</b><span>{shown ? 'real values' : 'masked'}</span>
              <button className="link-btn" onClick={() => { void navigator.clipboard?.writeText(JSON.stringify(data.details, null, 2)); toast('Copied.'); }}><Icon name="copy" size={13} /> Copy</button></div>
              <pre>{JSON.stringify({ method: data.item.method, path: data.item.path, summary: data.item.summary, tag: data.item.tag, deprecated: data.item.deprecated, ...data.details }, null, 2)}</pre></div>
          )}
        </div>
        <aside className="dt-ep-side">
          <section className="dt-card dt-score">
            <ScoreRing score={e.score} size={64} label="Documentation score" />
            <div><b>Documentation score</b><small className="muted">{e.gaps.length ? `${e.gaps.length} thing${e.gaps.length === 1 ? '' : 's'} to add` : 'Complete'}</small></div>
            {e.gaps.length > 0 && <ul className="dt-score-gaps">{e.gaps.map((g) => <li key={g}><Icon name="alert" size={12} /> {g}</li>)}</ul>}
            {canEdit && e.gaps.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => void startEdit()}><Icon name="edit" size={13} /> Fill the gaps</button>}
          </section>
          <section className="dt-card dt-facts">
            <dl>
              <div><dt>API</dt><dd>{e.definition}</dd></div>
              <div><dt>Stage</dt><dd>{API_STAGES.find((s) => s.id === e.stage)?.label ?? e.stage}</dd></div>
              {q.data.item.owner && <div><dt>Owner</dt><dd>{q.data.item.owner.name}</dd></div>}
              <div><dt>Project</dt><dd>{project.name}</dd></div>
            </dl>
          </section>
        </aside>
      </div>
      {asking && <RevealModal onClose={() => setAsking(false)} onReveal={async (reason) => {
        const r = await apiDocApi.revealEndpoint(doc, e.id, { purpose: 'read', reason });
        setShown(r); setLeft(r.revealSeconds || 15); setAsking(false);
      }} />}
      {editing && defs.length > 0 && <EndpointEditor documentId={doc} definitions={defs} existing={editing} startDefinition={editing.item.definitionId} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setShown(null); invalidateWorkspace(wid, 'documents'); }} />}
    </div>
  );
}
