import { useState } from 'react';
import { ApiError } from '../../api/client';
import { labelApi } from '../../api/endpoints';
import type { Label } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, Field, LabelChip, Modal, PageHead, PageLoader, SubmitButton } from '../../components/ui';
import { LABEL_COLORS } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useCan, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

/** Workspace settings → Labels: the tags tasks can carry, shared by every project. Add, rename, recolour and delete them. */
export function LabelSettings() {
  const wid = useWorkspaceId();
  const canManage = useCan('labels.manage');
  const q = useWsQuery(['labels'], labelApi.list);
  const [editing, setEditing] = useState<{ label?: Label } | null>(null);
  const [term, setTerm] = useState('');

  const remove = async (l: Label) => {
    if (!(await confirmDialog({ title: 'Delete label?', message: `“${l.name}” will be removed from every task that has it.`, confirmText: 'Delete' }))) return;
    try { await labelApi.remove(l.id); toast('Label deleted.', 'warning'); await invalidateWorkspace(wid); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete the label.', 'error'); }
  };

  const rows = (q.data ?? []).filter((l) => !term.trim() || l.name.toLowerCase().includes(term.trim().toLowerCase()));
  return (
    <>
      <PageHead title="Labels" sub="Tags for tasks, shared by every project in this workspace.">
        {canManage && <button type="button" className="btn btn-primary" onClick={() => setEditing({})}><Icon name="plus" /> New label</button>}
      </PageHead>
      <div className="card">
        {(q.data?.length ?? 0) > 6 && (
          <div className="toolbar"><div className="search-field"><Icon name="search" /><input className="input" placeholder="Find a label…" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Find a label" /></div></div>
        )}
        <div className="card-body">
          {q.isLoading ? <PageLoader /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : (q.data?.length ?? 0) === 0 ? (
            <EmptyState icon="tag" title="No labels yet" text={canManage ? 'Labels group tasks across projects, for example “Frontend”, “Customer request” or “Tech debt”.' : 'Nobody has added a label yet.'}
              action={canManage ? <button type="button" className="btn btn-primary" onClick={() => setEditing({})}><Icon name="plus" /> New label</button> : undefined} />
          ) : (
            <div className="label-rows">
              {rows.length === 0 && <p className="muted">No labels match.</p>}
              {rows.map((l) => (
                <div className="label-row" key={l.id}>
                  <div><LabelChip name={l.name} color={l.color} /></div>
                  {canManage && (
                    <div className="td-actions">
                      <button type="button" className="btn-icon" title="Edit" aria-label={`Edit ${l.name}`} onClick={() => setEditing({ label: l })}><Icon name="edit" /></button>
                      <button type="button" className="btn-icon danger" title="Delete" aria-label={`Delete ${l.name}`} onClick={() => void remove(l)}><Icon name="trash" /></button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {!canManage && (q.data?.length ?? 0) > 0 && <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>Only people who can manage labels can change these.</p>}
        </div>
      </div>
      {editing && <LabelModal label={editing.label} onClose={() => setEditing(null)} />}
    </>
  );
}

function LabelModal({ label, onClose }: { label?: Label; onClose: () => void }) {
  const wid = useWorkspaceId();
  const [name, setName] = useState(label?.name ?? '');
  const [color, setColor] = useState(label?.color ?? LABEL_COLORS[0]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) { setError('Give the label a name.'); return; }
    setBusy(true); setError(null);
    try {
      if (label) await labelApi.update(label.id, { name: name.trim(), color }); else await labelApi.create({ name: name.trim(), color });
      toast(label ? 'Label updated.' : 'Label added.'); await invalidateWorkspace(wid); onClose();
    } catch (e) { setError(e instanceof ApiError ? (e.fieldError('name') ?? e.message) : 'Could not save the label.'); }
    finally { setBusy(false); }
  };
  return (
    <Modal size="sm" title={label ? 'Edit label' : 'New label'} onClose={onClose} onSubmit={(e) => { e.preventDefault(); void save(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={busy}>{label ? 'Save changes' : 'Add label'}</SubmitButton></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
        <Field label="Name" required><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus placeholder="e.g. Frontend" /></Field>
        <Field label="Colour"><div className="color-swatches">{LABEL_COLORS.map((c) => <button type="button" key={c} className={`swatch ${c === color ? 'selected' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} aria-pressed={c === color} />)}</div></Field>
        <Field label="Preview"><div><LabelChip name={name.trim() || 'Label'} color={color} /></div></Field>
      </div>
    </Modal>
  );
}
