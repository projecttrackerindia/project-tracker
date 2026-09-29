import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { customFieldApi } from '../../api/endpoints';
import type { CustomField, CustomFieldType } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Badge, EmptyState, Field, Modal, SubmitButton } from '../../components/ui';
import { useCustomFields } from '../customfields/CustomFieldsSection';
import { useCan, useEntitlement, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { Select } from '../../components/Select';

const TYPES: { id: CustomFieldType; label: string }[] = [
  { id: 'Text', label: 'Text' }, { id: 'Number', label: 'Number' }, { id: 'Date', label: 'Date' }, { id: 'Dropdown', label: 'Dropdown' }, { id: 'Checkbox', label: 'Checkbox (yes / no)' },
];

/** Settings → Custom fields: extra fields every task of the workspace can carry. */
export function CustomFieldSettings() {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const canManage = useCan('workflow.manage');
  const included = useEntitlement('CUSTOM_FIELDS') > 0;
  const q = useCustomFields();
  const fields = q.data ?? [];
  const [modal, setModal] = useState<{ field?: CustomField } | null>(null);
  const editable = canManage && included;
  const refresh = () => void qc.invalidateQueries({ queryKey: [wid, 'custom-fields'] });

  const move = async (i: number, to: number) => {
    if (to < 0 || to >= fields.length) return;
    const ids = fields.map((f) => f.id);
    [ids[i], ids[to]] = [ids[to], ids[i]];
    try { await customFieldApi.reorder(ids); refresh(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not reorder.', 'error'); }
  };
  const remove = async (f: CustomField) => {
    const msg = f.inUse > 0 ? `“${f.name}” and the value it holds on ${f.inUse} task${f.inUse === 1 ? '' : 's'} will be deleted. This cannot be undone.` : `“${f.name}” will be deleted.`;
    if (!(await confirmDialog({ title: 'Delete field?', message: msg, confirmText: 'Delete' }))) return;
    try { await customFieldApi.remove(f.id); toast('Field deleted.', 'warning'); refresh(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete the field.', 'error'); }
  };

  return (
    <div className="card mb-22">
      <div className="card-head">
        <div><h3>Custom fields</h3><p>Extra information on every task, such as a customer, a size or a release date.</p></div>
        {editable && <button className="btn btn-primary btn-sm" onClick={() => setModal({})}><Icon name="plus" size={14} /> New field</button>}
      </div>
      <div className="card-body">
        {!included && <div className="notice">Custom fields are part of the Pro plan and above. <Link className="link" to="/billing">See plans</Link></div>}
        {fields.length === 0 ? (
          <EmptyState icon="list" title="No custom fields" text={editable ? 'Add a field and it appears in every task.' : 'Nobody has defined custom fields yet.'} />
        ) : (
          <div className="cf-list">
            {fields.map((f, i) => (
              <div className="cf-row" key={f.id}>
                <div className="cf-main">
                  <b>{f.name}</b> <Badge tone="purple">{f.type === 'Checkbox' ? 'Checkbox' : f.type}</Badge>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {f.type === 'Dropdown' ? f.options.join(' · ') + ' — ' : ''}{f.inUse > 0 ? `used on ${f.inUse} task${f.inUse === 1 ? '' : 's'}` : 'not used yet'}
                  </div>
                </div>
                {canManage && (
                  <div className="td-actions">
                    {editable && <>
                      <button type="button" className="btn-icon" aria-label="Move up" disabled={i === 0} onClick={() => void move(i, i - 1)}><Icon name="chevronD" size={13} style={{ transform: 'rotate(180deg)' }} /></button>
                      <button type="button" className="btn-icon" aria-label="Move down" disabled={i === fields.length - 1} onClick={() => void move(i, i + 1)}><Icon name="chevronD" size={13} /></button>
                      <button type="button" className="btn-icon" title="Edit" aria-label={`Edit ${f.name}`} onClick={() => setModal({ field: f })}><Icon name="edit" /></button>
                    </>}
                    <button type="button" className="btn-icon danger" title="Delete" aria-label={`Delete ${f.name}`} onClick={() => void remove(f)}><Icon name="trash" /></button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {modal && <FieldModal field={modal.field} onClose={() => setModal(null)} onSaved={refresh} />}
    </div>
  );
}

function FieldModal({ field, onClose, onSaved }: { field?: CustomField; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(field?.name ?? '');
  const [type, setType] = useState<CustomFieldType>(field?.type ?? 'Text');
  const [options, setOptions] = useState((field?.options ?? []).join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) return setError('Give the field a name.');
    setBusy(true); setError(null);
    try {
      const body = { name: name.trim(), type, options: type === 'Dropdown' ? options.split('\n').map((o) => o.trim()).filter(Boolean) : null };
      if (field) await customFieldApi.update(field.id, body); else await customFieldApi.create(body);
      toast(field ? 'Field updated.' : 'Field added.'); onSaved(); onClose();
    } catch (e) { setError(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save the field.'); }
    finally { setBusy(false); }
  };

  return (
    <Modal size="sm" title={field ? 'Edit field' : 'New field'} onClose={onClose} onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={busy}>{field ? 'Save field' : 'Add field'}</SubmitButton></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <Field label="Name" required><input className="input" maxLength={40} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer" /></Field>
      <Field label="Type" hint={field ? 'The type cannot be changed once the field exists.' : undefined}>
        <Select className="select" value={type} disabled={!!field} onChange={(e) => setType(e.target.value as CustomFieldType)}>{TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</Select>
      </Field>
      {type === 'Dropdown' && (
        <Field label="Choices" hint="One per line. Renaming or removing a choice does not change tasks that already use it.">
          <textarea className="textarea" rows={5} value={options} onChange={(e) => setOptions(e.target.value)} placeholder={'Small\nMedium\nLarge'} />
        </Field>
      )}
    </Modal>
  );
}
