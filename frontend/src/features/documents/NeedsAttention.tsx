import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { documentApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, Modal, PageLoader } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { DocumentList } from './DocumentList';

type Tab = 'missing' | 'stale' | 'unpublished';

/**
 * Documents › Needs attention: projects missing a document every project should have, documents nobody has touched for 90 days, and
 * documents that were never published. One list at a time, so each reads as a short to-do list.
 */
export function NeedsAttention({ canCreate, isAdmin, onRequired }: { canCreate: boolean; isAdmin: boolean; onRequired: () => void }) {
  const dash = useWsQuery(['documents', 'dashboard'], documentApi.dashboard);
  const [tab, setTab] = useState<Tab>('missing');
  const d = dash.data;
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'missing', label: 'Missing documents', count: d?.projectsMissingRequired },
    { id: 'stale', label: 'Not updated in 90 days', count: d?.notUpdatedIn90Days },
    { id: 'unpublished', label: 'Never published', count: d?.unpublished },
  ];
  return (
    <div className="na">
      <div className="na-tabs" role="tablist" aria-label="Needs attention">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}{t.count !== undefined && <span className="na-count">{t.count.toLocaleString()}</span>}
          </button>
        ))}
      </div>
      {tab === 'missing' ? <MissingRequired canCreate={canCreate} isAdmin={isAdmin} requiredTypes={d?.requiredTypes ?? 0} onRequired={onRequired} />
        : <DocumentList key={tab} canCreate={canCreate} attention={tab} />}
    </div>
  );
}

function MissingRequired({ canCreate, isAdmin, requiredTypes, onRequired }: { canCreate: boolean; isAdmin: boolean; requiredTypes: number; onRequired: () => void }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['documents', 'required-gaps'], documentApi.requiredGaps);
  const [busy, setBusy] = useState<string | null>(null);
  const create = async (projectId: string, names: string) => {
    setBusy(projectId);
    try {
      const made = await documentApi.createRequired(projectId);
      toast(`${made.length} draft${made.length === 1 ? '' : 's'} created: ${names}.`);
      invalidateWorkspace(wid, 'documents');
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not create the drafts.', 'error'); }
    finally { setBusy(null); }
  };
  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const gaps = q.data ?? [];
  if (requiredTypes === 0 && gaps.length === 0) {
    return (
      <EmptyState icon="checks" title="No required documents yet"
        text="Choose the kinds of documents every project should have - for example requirements, a test plan and a runbook. Projects without them will show up here."
        action={isAdmin ? <button type="button" className="btn btn-primary" onClick={onRequired}><Icon name="checks" size={15} /> Choose required documents</button> : undefined} />
    );
  }
  if (gaps.length === 0) return <EmptyState icon="checkCircle" title="Every project is complete" text="All active projects have every required document." />;
  return (
    <div className="na-table" role="table" aria-label="Projects missing required documents">
      <div className="na-row na-head" role="row"><span>Project</span><span>Missing</span><span /></div>
      {gaps.map((g) => (
        <div key={g.projectId} className="na-row" role="row">
          <span className="na-project"><Link to={`/projects/${g.projectId}?tab=documents`}>{g.projectName}</Link><small>{g.projectKey}</small></span>
          <span className="na-missing">{g.missing.map((t) => <span key={t.id} className="na-type" style={{ '--dc': t.color } as CSSProperties}><i />{t.name}</span>)}</span>
          <span className="na-actions">
            {canCreate && <button type="button" className="btn btn-ghost btn-sm" disabled={busy === g.projectId} onClick={() => void create(g.projectId, g.missing.map((t) => t.name).join(', '))}>
              {busy === g.projectId ? <span className="spinner" /> : <Icon name="plus" size={14} />}Create {g.missing.length === 1 ? 'draft' : `${g.missing.length} drafts`}
            </button>}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Owners and Admins choose which kinds of documents every active project is expected to have. */
export function RequiredDocumentsModal({ onClose }: { onClose: () => void }) {
  const wid = useWorkspaceId();
  const types = useWsQuery(['document-types'], documentApi.types);
  const [busy, setBusy] = useState<string | null>(null);
  const toggle = async (id: string, required: boolean) => {
    setBusy(id);
    try { await documentApi.setTypeRequired(id, required); invalidateWorkspace(wid, 'document-types'); invalidateWorkspace(wid, 'documents'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save.', 'error'); }
    finally { setBusy(null); }
  };
  return (
    <Modal title="Required documents" subtitle="The kinds of documents every active project should have. Projects without one show under Needs attention."
      onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
      {types.isLoading ? <PageLoader /> : types.isError ? <ErrorState error={types.error} retry={() => types.refetch()} /> : (
        <ul className="na-types">
          {(types.data ?? []).map((t) => (
            <li key={t.id}>
              <label>
                <input type="checkbox" checked={!!t.requiredForProjects} disabled={busy === t.id} onChange={(e) => void toggle(t.id, e.target.checked)} />
                <span className="na-type" style={{ '--dc': t.color } as CSSProperties}><i />{t.name}</span>
                {t.description && <small>{t.description}</small>}
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
