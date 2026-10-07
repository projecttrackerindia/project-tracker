import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { documentApi } from '../../api/endpoints';
import type { Coverage, CoverageItem, CoverageRow, LinkRelation } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, Field, Modal, PageLoader, SubmitButton } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { TARGET_LABEL } from './docUi';
import { WorkPicker } from './LinkPickers';

const STATE: Record<CoverageRow['state'], { label: string; tone: string }> = {
  Covered: { label: 'Covered', tone: 'badge-success' }, NoTask: { label: 'No work yet', tone: 'badge-neutral' },
  NoTest: { label: 'Not tested', tone: 'badge-warning' }, Failing: { label: 'Test failing', tone: 'badge-danger' },
};

function Chip({ item, onRemove }: { item: CoverageItem; onRemove?: () => void }) {
  if (item.restricted) return <span className="cov-chip restricted" title="You cannot open this item"><Icon name="lock" size={11} /> Restricted</span>;
  const tone = item.failing ? 'fail' : item.done ? 'done' : '';
  return (
    <span className={`cov-chip ${tone}`} title={`${TARGET_LABEL[item.targetType]} · ${item.title} · ${item.status}${item.assignee ? ` · ${item.assignee}` : ''}`}>
      <b>{item.key}</b><span>{item.title}</span>
      {onRemove && <button type="button" aria-label={`Unlink ${item.key}`} onClick={onRemove}><Icon name="close" size={11} /></button>}
    </span>
  );
}

/** The requirements of a document and what covers them: work that builds each one and the tests that verify it. */
export function CoverageModal({ documentId, canEdit, onClose }: { documentId: string; canEdit: boolean; onClose: () => void }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['documents', documentId, 'coverage'], () => documentApi.coverage(documentId));
  const [text, setText] = useState('');
  const [picker, setPicker] = useState<{ requirementId: string; relation: LinkRelation } | null>(null);
  const [filter, setFilter] = useState<'all' | CoverageRow['state']>('all');
  const refresh = () => invalidateWorkspace(wid, 'documents');
  const add = useMutation({
    mutationFn: () => documentApi.addRequirements(documentId, text.split('\n').map((l) => l.trim()).filter(Boolean)),
    onSuccess: () => { setText(''); refresh(); toast('Requirements added.'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not add them.', 'error'),
  });
  const unlink = useMutation({
    mutationFn: (linkId: string) => documentApi.removeLink(documentId, linkId),
    onSuccess: refresh, onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not unlink.', 'error'),
  });
  const removeReq = useMutation({
    mutationFn: (rid: string) => documentApi.removeRequirement(documentId, rid),
    onSuccess: refresh, onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not remove it.', 'error'),
  });
  const data: Coverage | undefined = q.data;
  const rows = (data?.rows ?? []).filter((r) => filter === 'all' || r.state === filter);
  return (
    <Modal title="Requirements and coverage" subtitle="What the document asks for, the work that builds it and the tests that prove it." size="xl" onClose={onClose} footer={<button className="btn btn-ghost" onClick={onClose}>Close</button>}>
      {q.isLoading ? <PageLoader /> : q.isError || !data ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
        <div className="cov">
          <div className="cov-stats" role="group" aria-label="Filter by coverage">
            {[
              { key: 'all' as const, n: data.requirements, label: 'Requirements' },
              { key: 'Covered' as const, n: data.covered, label: 'Covered' },
              { key: 'NoTask' as const, n: data.withoutTask, label: 'No work yet' },
              { key: 'NoTest' as const, n: data.withoutTest, label: 'Not tested' },
              { key: 'Failing' as const, n: data.rows.filter((r) => r.state === 'Failing').length, label: 'Failing' },
            ].map((s) => <button key={s.key} className={`cov-stat${filter === s.key ? ' on' : ''}`} onClick={() => setFilter(s.key)}><b>{s.n}</b><span>{s.label}</span></button>)}
            <div className="cov-extra muted">{data.workWithoutTest} {data.workWithoutTest === 1 ? 'item' : 'items'} of work without a test · {data.failingTests} failing {data.failingTests === 1 ? 'test' : 'tests'}{data.restricted > 0 ? ` · ${data.restricted} restricted` : ''}</div>
          </div>

          {canEdit && (
            <form className="cov-add" onSubmit={(e) => { e.preventDefault(); if (text.trim()) add.mutate(); }}>
              <Field label="Add requirements" hint="One per line. They are numbered REQ-1, REQ-2 … and keep their number.">
                <textarea className="textarea" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Employees can download their payslip as a PDF" />
              </Field>
              <SubmitButton busy={add.isPending}>Add</SubmitButton>
            </form>
          )}

          {data.rows.length === 0 ? <EmptyState icon="list" title="No requirements yet" text={canEdit ? 'Add the first ones above, then link the tasks that build them.' : 'The owner has not listed any yet.'} /> : (
            <ul className="cov-rows">
              {rows.map((r) => (
                <li key={r.requirement.id} className="cov-row">
                  <div className="cov-head"><span className="doc-key">{r.requirement.key}</span><b>{r.requirement.title}</b><span className={`badge ${STATE[r.state].tone}`}>{STATE[r.state].label}</span>
                    {canEdit && <button className="btn-icon" aria-label={`Remove ${r.requirement.key}`} onClick={async () => { if (await confirmDialog({ title: `Remove ${r.requirement.key}?`, message: 'The work linked to it stays linked to the document as a whole.', confirmText: 'Remove' })) removeReq.mutate(r.requirement.id); }}><Icon name="trash" size={14} /></button>}
                  </div>
                  <div className="cov-cols">
                    <div><span className="cov-lab">Built by</span><div className="cov-chips">{r.implementing.length === 0 ? <span className="muted">Nothing yet</span> : r.implementing.map((i) => <Chip key={i.linkId} item={i} onRemove={canEdit ? () => unlink.mutate(i.linkId) : undefined} />)}
                      {canEdit && <button className="cov-add-btn" onClick={() => setPicker({ requirementId: r.requirement.id, relation: 'Implements' })}><Icon name="plus" size={12} /> Work</button>}</div></div>
                    <div><span className="cov-lab">Verified by</span><div className="cov-chips">{r.verifying.length === 0 ? <span className="muted">No test</span> : r.verifying.map((i) => <Chip key={i.linkId} item={i} onRemove={canEdit ? () => unlink.mutate(i.linkId) : undefined} />)}
                      {canEdit && <button className="cov-add-btn" onClick={() => setPicker({ requirementId: r.requirement.id, relation: 'Verifies' })}><Icon name="plus" size={12} /> Test</button>}</div></div>
                  </div>
                </li>
              ))}
              {rows.length === 0 && <li className="muted">Nothing in this view.</li>}
            </ul>
          )}
        </div>
      )}
      {picker && <WorkPicker documentId={documentId} requirementId={picker.requirementId} fixedRelation={picker.relation} onClose={() => setPicker(null)} />}
    </Modal>
  );
}

/** The side card: how well the requirements are covered, at a glance. */
export function RequirementsCard({ documentId, canEdit }: { documentId: string; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const q = useWsQuery(['documents', documentId, 'coverage'], () => documentApi.coverage(documentId));
  const c = q.data;
  const pct = c && c.requirements > 0 ? Math.round((c.covered / c.requirements) * 100) : 0;
  return (
    <div className="card doc-side-card">
      <div className="card-head"><div><h3>Requirements</h3></div><button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>{c && c.requirements > 0 ? 'Open' : canEdit ? 'Add' : 'View'}</button></div>
      <div className="card-body">
        {!c || c.requirements === 0 ? <p className="muted">{canEdit ? 'List what this document asks for, then link the work and tests that cover each requirement.' : 'No requirements listed.'}</p> : (
          <>
            <div className="cov-meter" role="img" aria-label={`${pct}% of requirements covered`}><i style={{ width: `${pct}%` }} /></div>
            <p className="cov-sum"><b>{c.covered}</b> of {c.requirements} covered</p>
            <ul className="cov-mini">
              {c.withoutTask > 0 && <li><span className="dot warn" /> {c.withoutTask} without work</li>}
              {c.withoutTest > 0 && <li><span className="dot warn" /> {c.withoutTest} not tested</li>}
              {c.failingTests > 0 && <li><span className="dot bad" /> {c.failingTests} failing {c.failingTests === 1 ? 'test' : 'tests'}</li>}
              {c.withoutTask + c.withoutTest + c.failingTests === 0 && <li><span className="dot ok" /> Everything is covered</li>}
            </ul>
          </>
        )}
      </div>
      {open && <CoverageModal documentId={documentId} canEdit={canEdit} onClose={() => setOpen(false)} />}
    </div>
  );
}

