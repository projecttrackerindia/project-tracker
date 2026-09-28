import { useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { orgApi } from '../../api/endpoints';
import type { OrgRole } from '../../api/types';
import { Field, Modal, SubmitButton } from '../../components/ui';
import { LABEL_COLORS } from '../../lib/format';
import { invalidateWorkspace } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { subtreeIds } from './orgLayout';
import { Select } from '../../components/Select';

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="color-swatches" role="radiogroup" aria-label="Colour">
      {LABEL_COLORS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} className={`swatch ${value === c ? 'selected' : ''}`} style={{ background: c }} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

/** Add a role (optionally under a parent) or edit an existing one, including who it reports to. */
export function RoleModal({ role, parentId, roles, onClose, onSaved }: {
  role?: OrgRole; parentId?: string | null; roles: OrgRole[]; onClose: () => void; onSaved?: (id: string) => void;
}) {
  const wid = useWorkspaceId();
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [color, setColor] = useState(role?.color ?? LABEL_COLORS[roles.filter((r) => !r.isDeleted).length % LABEL_COLORS.length]);
  const [parent, setParent] = useState<string>(role ? (role.parentRoleId ?? '') : (parentId ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blocked = useMemo(() => (role ? subtreeIds(role.id, roles) : new Set<string>()), [role, roles]);
  const parents = roles.filter((r) => !r.isDeleted && !blocked.has(r.id));

  const submit = async () => {
    if (name.trim().length < 2) { setError('Enter a role name (at least 2 characters).'); return; }
    setBusy(true); setError(null);
    try {
      if (role) {
        await orgApi.updateRole(role.id, { name: name.trim(), description: description.trim() || undefined, color });
        if ((role.parentRoleId ?? '') !== parent) await orgApi.moveRole(role.id, parent || null);
        toast(`Role “${name.trim()}” updated.`);
        onSaved?.(role.id);
      } else {
        const created = await orgApi.createRole({ name: name.trim(), description: description.trim() || undefined, color, parentRoleId: parent || null });
        toast(`Role “${created.name}” added.`);
        onSaved?.(created.id);
      }
      void invalidateWorkspace(wid, 'org');
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? (e.fieldError('name') ?? e.message) : 'Could not save the role.');
    } finally { setBusy(false); }
  };

  return (
    <Modal size="sm" title={role ? 'Edit role' : 'Add role'} subtitle={role ? undefined : 'A job role on the organization chart, such as CTO or Developer.'} onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={busy}>{role ? 'Save changes' : 'Add role'}</SubmitButton></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
        <Field label="Role name" required><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Delivery Manager" maxLength={60} /></Field>
        <Field label="Reports to" hint="Leave empty to make this a top-level role."><Select className="select" value={parent} onChange={(e) => setParent(e.target.value)}>
          <option value="">— Top level —</option>{parents.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </Select></Field>
        <Field label="Description"><textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this role do?" maxLength={300} rows={3} /></Field>
        <Field label="Colour"><ColorPicker value={color} onChange={setColor} /></Field>
      </div>
    </Modal>
  );
}

/** Soft delete: nobody is left without a place, so choose where people and sub-roles go. */
export function DeleteRoleModal({ role, roles, onClose, onDeleted }: { role: OrgRole; roles: OrgRole[]; onClose: () => void; onDeleted?: () => void }) {
  const wid = useWorkspaceId();
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = useMemo(() => subtreeIds(role.id, roles), [role, roles]);
  const options = roles.filter((r) => !r.isDeleted && !blocked.has(r.id));
  const parent = roles.find((r) => r.id === role.parentRoleId);
  const moving = role.peopleCount + role.childCount > 0;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const res = await orgApi.deleteRole(role.id, target || undefined);
      void invalidateWorkspace(wid, 'org');
      const moved = [res.movedPeople && `${res.movedPeople} ${res.movedPeople === 1 ? 'person' : 'people'}`, res.movedRoles && `${res.movedRoles} sub-role${res.movedRoles === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
      toast(`Role “${role.name}” deleted${moved ? ` — ${moved} moved` : ''}. You can restore it.`, 'warning', {
        label: 'Restore', onClick: () => { void orgApi.restoreRole(role.id).then(() => invalidateWorkspace(wid, 'org')).catch(() => toast('Could not restore the role.', 'error')); },
      });
      onDeleted?.();
      onClose();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not delete the role.'); }
    finally { setBusy(false); }
  };

  return (
    <Modal size="sm" title="Delete role?" subtitle="This is a soft delete — the role is kept and can be restored." onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-danger" disabled={busy}>{busy && <span className="spinner" />}Delete role</button></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <p style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: moving ? 14 : 0 }}>
        “{role.name}” will be removed from the chart.{' '}
        {moving ? `${role.peopleCount} ${role.peopleCount === 1 ? 'person' : 'people'} and ${role.childCount} sub-role${role.childCount === 1 ? '' : 's'} need a new place.` : 'Nobody is assigned to it and it has no sub-roles.'}
      </p>
      {moving && role.peopleCount > 0 && <div className="form-warn" role="note">People who move to another role get that role's access settings.</div>}
      {moving && (
        <Field label="Move them to">
          <Select className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">{parent ? `Its parent role — ${parent.name}` : 'Top level / unassigned'}</option>
            {options.filter((r) => r.id !== role.parentRoleId).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </Field>
      )}
    </Modal>
  );
}
