import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { documentApi } from '../../api/endpoints';
import type { LinkTarget } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Progress } from '../../components/ui';
import { formatDateShort } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useModule, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { DocumentPicker, WorkPicker } from './LinkPickers';
import { DocStatusBadge, TARGET_LABEL, TypeChip, relationLabel, targetLink } from './docUi';

/** On a document: the work it is linked to, with how far along that work is. */
export function LinkedWork({ documentId, canLink }: { documentId: string; canLink: boolean }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['documents', documentId, 'links'], () => documentApi.links(documentId));
  const [adding, setAdding] = useState(false);
  const remove = useMutation({
    mutationFn: (linkId: string) => documentApi.removeLink(documentId, linkId),
    onSuccess: () => { invalidateWorkspace(wid, 'documents'); invalidateWorkspace(wid, 'linked-documents'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not remove the link.', 'error'),
  });
  const w = q.data;
  const pct = w && w.total > 0 ? Math.round((w.done / w.total) * 100) : 0;
  return (
    <div className="card doc-side-card">
      <div className="card-head">
        <div><h3>Linked work</h3><p>The tasks, issues and projects this document is about.</p></div>
        {canLink && <button className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}><Icon name="plus" size={15} /> Link</button>}
      </div>
      <div className="card-body">
        {w && w.total > 0 && (
          <div className="doc-roll">
            <Progress value={pct} />
            <div className="doc-roll-text"><b>{w.done} of {w.total}</b> done{w.overdue > 0 && <span className="doc-overdue"> · {w.overdue} overdue</span>}</div>
          </div>
        )}
        {q.isLoading ? <p className="muted">Loading…</p> : !w || w.items.length === 0 ? <p className="muted">Nothing linked yet. Link the tasks that build this, and the tests that check it.</p> : (
          <ul className="doc-linked">
            {w.items.map((i) => i.restricted
              ? <li key={i.linkId} className="restricted"><Icon name="lock" size={14} /> <span>A linked item you cannot open</span>{canLink && <button className="btn-icon" aria-label="Remove link" onClick={() => remove.mutate(i.linkId)}><Icon name="close" size={14} /></button>}</li>
              : (
                <li key={i.linkId} className={i.done ? 'done' : ''}>
                  <Link to={targetLink(i.targetType, i.targetId, i.projectId)}>
                    <span className="doc-key">{i.key}</span><b>{i.title}</b>
                  </Link>
                  <div className="doc-linked-sub">
                    <span className="badge badge-neutral">{TARGET_LABEL[i.targetType]}</span>
                    <span>{relationLabel(i.relation)}</span><span>{i.status}</span>
                    {i.assignee && <span>{i.assignee}</span>}
                    {i.dueDate && <span className={i.overdue ? 'doc-overdue' : ''}>due {formatDateShort(i.dueDate)}</span>}
                  </div>
                  {canLink && <button className="btn-icon danger" aria-label={`Remove link to ${i.title}`} onClick={async () => { if (await confirmDialog({ title: 'Remove link?', message: 'The document and the work stay; only the link goes.', confirmText: 'Remove' })) remove.mutate(i.linkId); }}><Icon name="close" size={14} /></button>}
                </li>
              ))}
          </ul>
        )}
      </div>
      {adding && <WorkPicker documentId={documentId} onClose={() => setAdding(false)} />}
    </div>
  );
}

/** On a task, issue, work item or project: the documents linked to it. */
export function TargetDocuments({ targetType, targetId, title = 'Documents' }: { targetType: LinkTarget; targetId: string; title?: string }) {
  const wid = useWorkspaceId();
  const level = useModule('documents');
  const q = useWsQuery(['linked-documents', targetType, targetId], () => documentApi.linkedTo(targetType, targetId), { enabled: level > 0 });
  const [adding, setAdding] = useState(false);
  const remove = useMutation({
    mutationFn: (v: { documentId: string; linkId: string }) => documentApi.removeLink(v.documentId, v.linkId),
    onSuccess: () => { invalidateWorkspace(wid, 'documents'); invalidateWorkspace(wid, 'linked-documents'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not remove the link.', 'error'),
  });
  if (level === 0) return null;
  const items = q.data?.items ?? [];
  const hidden = q.data?.restricted ?? 0;
  return (
    <div className="doc-target">
      <div className="doc-target-head">
        <h4>{title}{items.length > 0 && <span className="muted" style={{ fontWeight: 500 }}> · {items.length}</span>}</h4>
        {level >= 2 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Link a document</button>}
      </div>
      {q.isLoading ? <p className="muted">Loading…</p> : items.length === 0 && hidden === 0 ? <p className="muted" style={{ fontSize: 13 }}>No documents linked.</p> : (
        <ul className="doc-target-list">
          {items.map((l) => (
            <li key={l.linkId}>
              <Link to={`/documents/${l.document.id}`}><TypeChip doc={l.document} size={24} /><span className="doc-key">{l.document.key}</span><b>{l.document.title}</b></Link>
              <span className="muted">{relationLabel(l.relation)}</span><DocStatusBadge status={l.document.status} />
              {level >= 2 && <button type="button" className="btn-icon danger" aria-label={`Unlink ${l.document.title}`} onClick={() => remove.mutate({ documentId: l.document.id, linkId: l.linkId })}><Icon name="close" size={14} /></button>}
            </li>
          ))}
          {hidden > 0 && <li className="restricted"><Icon name="lock" size={14} /> {hidden} restricted document{hidden === 1 ? '' : 's'} you cannot open</li>}
        </ul>
      )}
      {adding && <DocumentPicker targetType={targetType} targetId={targetId} onClose={() => setAdding(false)} />}
    </div>
  );
}
