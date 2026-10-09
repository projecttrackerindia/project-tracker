import { useMemo, useState, type CSSProperties } from 'react';
import type { OrgPerson, OrgRole, OrgStructure } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Avatar, RoleBadge } from '../../components/ui';
import { formatDate } from '../../lib/format';
import { PERSON_MIME, subtreeIds, wouldLoopPeople } from './orgLayout';
import type { OrgActions } from './orgState';
import { Select } from '../../components/Select';

// ------------------------------------------------------------------ people who are not on the chart yet
export function UnassignedTray({ people, canManage, actions, onSelect }: {
  people: OrgPerson[]; canManage: boolean; actions: OrgActions; onSelect: (id: string) => void;
}) {
  const [over, setOver] = useState(false);
  const free = people.filter((p) => !p.roleId);
  return (
    <aside className={`org-tray ${over ? 'drop-over' : ''}`} aria-label="People without a role"
      onDragOver={(e) => { if (canManage && Array.from(e.dataTransfer.types).includes(PERSON_MIME)) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { setOver(false); const id = e.dataTransfer.getData(PERSON_MIME); if (id && canManage) { e.preventDefault(); void actions.assign(id, null); } }}>
      <div className="org-side-head"><strong>No role yet</strong><span className="kb-count">{free.length}</span></div>
      <p className="org-side-hint">{canManage ? 'Drag a person onto a role in the chart to place them. Drop someone here to take them off the chart.' : 'These people have not been placed on the chart yet.'}</p>
      <div className="org-tray-list">
        {free.length === 0 && <div className="kb-empty">Everyone is on the chart.</div>}
        {free.map((p) => (
          <div key={p.userId} className="org-person-chip" role="button" tabIndex={0} draggable={canManage} onClick={() => onSelect(p.userId)} onKeyDown={(e) => { if (e.key === 'Enter') onSelect(p.userId); }}
            onDragStart={(e) => { e.dataTransfer.setData(PERSON_MIME, p.userId); e.dataTransfer.effectAllowed = 'move'; }} title={canManage ? 'Drag onto a role' : p.displayName}>
            <Avatar name={p.displayName} userId={p.userId} />
            <div className="org-chip-text"><div className="org-chip-name">{p.displayName}</div><div className="org-chip-sub">{p.accessRole}{p.email ? ` · ${p.email}` : ''}</div></div>
          </div>
        ))}
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ inspector
interface InspectorProps {
  data: OrgStructure; selectedId: string | null; actions: OrgActions; onSelect: (id: string | null) => void;
  onEdit: (role: OrgRole) => void; onAddChild: (parentId: string) => void; onDelete: (role: OrgRole) => void; onRestore: (id: string) => void;
}

export function Inspector(p: InspectorProps) {
  const role = p.data.roles.find((r) => r.id === p.selectedId);
  const person = p.data.people.find((x) => x.userId === p.selectedId);
  if (!role && !person) return null; // the panel only exists while something is selected
  return (
    <aside className="org-inspector" aria-label="Details">
      {role ? <RoleDetails {...p} role={role} /> : <PersonDetails {...p} person={person!} />}
    </aside>
  );
}

function RoleDetails({ role, data, actions, onSelect, onEdit, onAddChild, onDelete, onRestore }: InspectorProps & { role: OrgRole }) {
  const canManage = data.canManage;
  const editable = canManage && !role.isDeleted;
  const members = data.people.filter((x) => x.roleId === role.id);
  const kids = data.roles.filter((r) => !r.isDeleted && r.parentRoleId === role.id);
  const parent = data.roles.find((r) => r.id === role.parentRoleId);
  const blocked = useMemo(() => subtreeIds(role.id, data.roles), [role.id, data.roles]);
  const candidates = data.roles.filter((r) => !r.isDeleted && !blocked.has(r.id));
  const others = data.people.filter((x) => x.roleId !== role.id);

  return (
    <div className="org-details" style={{ '--node': role.color } as CSSProperties}>
      <div className="org-side-head">
        <div className="row" style={{ minWidth: 0 }}><span className="org-dot big" /><strong className="org-details-title">{role.name}</strong></div>
        <button className="btn-icon" onClick={() => onSelect(null)} aria-label="Close details" title="Close"><Icon name="close" /></button>
      </div>
      {role.isDeleted && <div className="form-warn" style={{ margin: '0 0 12px' }}>This role was deleted{role.deletedAt ? ` on ${formatDate(role.deletedAt)}` : ''}. It is kept so it can be restored.</div>}
      <p className="org-details-desc">{role.description || 'No description.'}</p>

      <div className="org-section">
        <label className="org-label" htmlFor="org-parent">Reports to</label>
        {editable
          ? <Select id="org-parent" className="select" value={role.parentRoleId ?? ''} onChange={(e) => { void actions.moveRole(role.id, e.target.value || null); }}>
              <option value="">— Top level —</option>{candidates.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
          : <div className="org-value">{parent ? parent.name : 'Top level'}</div>}
      </div>

      <div className="org-section">
        <div className="org-label">People in this role ({members.length})</div>
        {members.length === 0 && <div className="org-value muted">Nobody yet.</div>}
        {members.map((m) => (
          <div key={m.userId} className="org-row">
            <button className="org-row-main" onClick={() => onSelect(m.userId)} title="View person"><Avatar name={m.displayName} userId={m.userId} /><span>{m.displayName}</span></button>
            {editable && <button className="btn-icon" title="Take off this role" aria-label={`Remove ${m.displayName} from ${role.name}`} draggable
              onDragStart={(e) => { e.dataTransfer.setData(PERSON_MIME, m.userId); e.dataTransfer.effectAllowed = 'move'; }}
              onClick={() => { void actions.assign(m.userId, null); }}><Icon name="close" size={14} /></button>}
          </div>
        ))}
        {editable && others.length > 0 && (
          <Select className="select" value="" aria-label="Add a person to this role" onChange={(e) => { if (e.target.value) void actions.assign(e.target.value, role.id); }}>
            <option value="">+ Add a person…</option>
            {others.map((x) => <option key={x.userId} value={x.userId}>{x.displayName}{x.roleId ? ` (${data.roles.find((r) => r.id === x.roleId)?.name ?? ''})` : ''}</option>)}
          </Select>
        )}
      </div>

      {kids.length > 0 && (
        <div className="org-section">
          <div className="org-label">Sub-roles ({kids.length})</div>
          <div className="org-tags">{kids.map((k) => <button key={k.id} className="org-tag" style={{ '--node': k.color } as CSSProperties} onClick={() => onSelect(k.id)}><span className="org-dot" />{k.name}</button>)}</div>
        </div>
      )}

      {canManage && (
        <div className="org-actions">
          {role.isDeleted
            ? <button className="btn btn-primary" onClick={() => onRestore(role.id)}><Icon name="undo" /> Restore role</button>
            : <>
                <button className="btn btn-primary" onClick={() => onEdit(role)}><Icon name="edit" /> Edit</button>
                <button className="btn btn-ghost" onClick={() => onAddChild(role.id)}><Icon name="plus" /> Sub-role</button>
                <button className="btn btn-ghost danger" onClick={() => onDelete(role)}><Icon name="trash" /> Delete</button>
              </>}
        </div>
      )}
    </div>
  );
}

function PersonDetails({ person, data, actions, onSelect }: InspectorProps & { person: OrgPerson }) {
  const canManage = data.canManage;
  const role = data.roles.find((r) => r.id === person.roleId);
  const boss = data.people.find((x) => x.userId === person.reportsToUserId);
  const reports = data.people.filter((x) => x.reportsToUserId === person.userId);
  const bosses = data.people.filter((x) => x.userId !== person.userId && !wouldLoopPeople(person.userId, x.userId, data));
  const roles = data.roles.filter((r) => !r.isDeleted);

  return (
    <div className="org-details" style={{ '--node': role?.color ?? '#94a3b8' } as CSSProperties}>
      <div className="org-side-head">
        <div className="row" style={{ minWidth: 0 }}><Avatar name={person.displayName} size="lg" userId={person.userId} /><div style={{ minWidth: 0 }}><strong className="org-details-title">{person.displayName}</strong><div className="muted" style={{ fontSize: 12 }}>{person.email}</div></div></div>
        <button className="btn-icon" onClick={() => onSelect(null)} aria-label="Close details" title="Close"><Icon name="close" /></button>
      </div>
      <div className="org-section"><div className="org-label">Access level</div><div><RoleBadge role={person.accessRole} /></div></div>

      <div className="org-section">
        <label className="org-label" htmlFor="org-role">Job role</label>
        {canManage
          ? <Select id="org-role" className="select" value={person.roleId ?? ''} onChange={(e) => { void actions.assign(person.userId, e.target.value || null); }}>
              <option value="">— No role yet —</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
          : <div className="org-value">{role?.name ?? 'No role yet'}</div>}
      </div>

      <div className="org-section">
        <label className="org-label" htmlFor="org-boss">Reports to</label>
        {canManage
          ? <Select id="org-boss" className="select" value={person.reportsToUserId ?? ''} onChange={(e) => { void actions.reportsTo(person.userId, e.target.value || null); }}>
              <option value="">— Nobody —</option>{bosses.map((x) => <option key={x.userId} value={x.userId}>{x.displayName}</option>)}
            </Select>
          : <div className="org-value">{boss?.displayName ?? 'Nobody'}</div>}
      </div>

      <div className="org-section">
        <div className="org-label">Direct reports ({reports.length})</div>
        {reports.length === 0 && <div className="org-value muted">None.</div>}
        {reports.map((r) => <div key={r.userId} className="org-row"><button className="org-row-main" onClick={() => onSelect(r.userId)}><Avatar name={r.displayName} userId={r.userId} /><span>{r.displayName}</span></button></div>)}
      </div>
    </div>
  );
}
