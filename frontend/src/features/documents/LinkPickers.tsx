import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { documentApi, insightApi } from '../../api/endpoints';
import type { LinkRelation, LinkTarget } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { EmptyState, Field, Modal, PageLoader } from '../../components/ui';
import { invalidateWorkspace, useDebounced, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { DocStatusBadge, RELATIONS, TARGET_LABEL, TypeChip } from './docUi';

const HIT_TO_TARGET: Record<string, LinkTarget> = { project: 'Project', task: 'Task', issue: 'Issue', work: 'WorkItem' };

function RelationField({ value, onChange, document }: { value: LinkRelation; onChange: (r: LinkRelation) => void; document?: boolean }) {
  return (
    <Field label={document ? 'How does the document relate to it?' : 'What is it to the document?'} hint={RELATIONS.find((r) => r.value === value)?.hint}>
      <Select className="select" value={value} onChange={(e) => onChange(e.target.value as LinkRelation)} aria-label="Relation">
        {RELATIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
      </Select>
    </Field>
  );
}

/** From a document: find a project, task, issue or work item and link it. */
export function WorkPicker({ documentId, onClose, requirementId, fixedRelation }: { documentId: string; onClose: () => void; requirementId?: string; fixedRelation?: LinkRelation }) {
  const wid = useWorkspaceId();
  const [q, setQ] = useState('');
  const [relation, setRelation] = useState<LinkRelation>(fixedRelation ?? 'Implements');
  const dq = useDebounced(q.trim(), 250);
  const hits = useWsQuery(['search', dq], () => insightApi.search(dq), { enabled: dq.length >= 2 });
  const add = useMutation({
    mutationFn: (h: { type: LinkTarget; id: string }) => documentApi.addLink(documentId, { targetType: h.type, targetId: h.id, relation, requirementId }),
    onSuccess: () => { toast('Linked.'); invalidateWorkspace(wid, 'documents'); invalidateWorkspace(wid, 'linked-documents'); onClose(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not link it.', 'error'),
  });
  const usable = (hits.data?.hits ?? []).filter((h) => HIT_TO_TARGET[h.type]);
  return (
    <Modal title="Link work" subtitle={requirementId ? (fixedRelation === 'Verifies' ? 'Find the test (a task or a test issue) that verifies this requirement.' : 'Find the task or work item that builds this requirement.') : 'Link a project, task, issue or work item to this document.'} size="sm" onClose={onClose}>
      {!fixedRelation && <RelationField value={relation} onChange={setRelation} />}
      <Field label="Find it"><input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a title or a key such as WT-12…" /></Field>
      <div className="pick-list">
        {dq.length < 2 ? <p className="muted">Type at least two letters.</p> : hits.isLoading ? <PageLoader /> : usable.length === 0 ? <EmptyState icon="search" title="Nothing found" /> :
          usable.map((h) => (
            <button type="button" key={`${h.type}${h.id}`} className="pick-row" disabled={add.isPending} onClick={() => add.mutate({ type: HIT_TO_TARGET[h.type], id: h.id })}>
              <span className="badge badge-neutral">{TARGET_LABEL[HIT_TO_TARGET[h.type]]}</span><b>{h.title}</b>{h.subtitle && <small>{h.subtitle}</small>}
            </button>
          ))}
      </div>
    </Modal>
  );
}

/** From a task, issue, work item or project: find a document and link it. */
export function DocumentPicker({ targetType, targetId, onClose }: { targetType: LinkTarget; targetId: string; onClose: () => void }) {
  const wid = useWorkspaceId();
  const [q, setQ] = useState('');
  const [relation, setRelation] = useState<LinkRelation>('Describes');
  const dq = useDebounced(q.trim(), 250);
  const docs = useWsQuery(['documents', 'pick', dq], () => documentApi.list({ q: dq || undefined, limit: 20 }));
  const add = useMutation({
    mutationFn: (documentId: string) => documentApi.addLink(documentId, { targetType, targetId, relation }),
    onSuccess: () => { toast('Document linked.'); invalidateWorkspace(wid, 'documents'); invalidateWorkspace(wid, 'linked-documents'); onClose(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not link it.', 'error'),
  });
  return (
    <Modal title="Link a document" size="sm" onClose={onClose}>
      <RelationField value={relation} onChange={setRelation} document />
      <Field label="Find a document"><input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, DOC-12 or tag…" /></Field>
      <div className="pick-list">
        {docs.isLoading ? <PageLoader /> : (docs.data?.items.length ?? 0) === 0 ? <EmptyState icon="note" title="No documents found" /> :
          docs.data!.items.map((d) => (
            <button type="button" key={d.id} className="pick-row" disabled={add.isPending} onClick={() => add.mutate(d.id)}>
              <TypeChip doc={d} size={26} /><span className="doc-key">{d.key}</span><b>{d.title}</b><DocStatusBadge status={d.status} />
            </button>
          ))}
      </div>
      <p className="muted" style={{ fontSize: 12.5 }}><Icon name="info" size={13} /> Linking does not share the document: people still need access to it.</p>
    </Modal>
  );
}
