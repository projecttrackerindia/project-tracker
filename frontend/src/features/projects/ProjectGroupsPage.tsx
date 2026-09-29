import { useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { projectGroupApi } from '../../api/endpoints';
import type { ProjectGroup } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { EmptyState, ErrorState, Field, Modal, PageHead, PageLoader, SubmitButton } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useCan, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);

/**
 * Project Group Management: the workspace's master list that every project belongs to (Salesforce Projects, Employee Portal, HRMS ...).
 * Add, rename, reorder (drag or use the arrows), activate / deactivate, and delete; each row shows how many projects the group holds.
 */
export function ProjectGroupsPage() {
  const wid = useWorkspaceId();
  const canManage = useCan('projectgroups.manage');
  const q = useWsQuery(['project-groups'], () => projectGroupApi.list());
  const [editing, setEditing] = useState<{ group?: ProjectGroup } | null>(null);
  const [removing, setRemoving] = useState<ProjectGroup | null>(null);
  const [pending, setPending] = useState<string[] | null>(null);   // the order shown while a reorder is being saved
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);

  const groups = useMemo(() => {
    const list = q.data ?? [];
    if (!pending) return list;
    const rank = new Map(pending.map((id, i) => [id, i]));
    return [...list].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  }, [q.data, pending]);

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;

  const commit = async (ids: string[]) => {
    if (ids.every((id, i) => id === groups[i].id)) return;
    setPending(ids);
    try { await projectGroupApi.reorder(ids); await invalidateWorkspace(wid, 'project-groups'); toast('Group order saved.'); }
    catch (e) { toast(errText(e, 'Could not save the new order.'), 'error'); }
    finally { setPending(null); }
  };
  const moveTo = (id: string, target: string, after: boolean) => {
    if (id === target) return;
    const ids = groups.map((g) => g.id).filter((x) => x !== id);
    ids.splice(ids.indexOf(target) + (after ? 1 : 0), 0, id);
    void commit(ids);
  };
  const nudge = (id: string, delta: -1 | 1) => {
    const ids = groups.map((g) => g.id);
    const from = ids.indexOf(id), to = from + delta;
    if (to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    void commit(ids);
  };
  const setActive = async (g: ProjectGroup, isActive: boolean) => {
    try { await projectGroupApi.update(g.id, { isActive }); await invalidateWorkspace(wid, 'project-groups'); toast(isActive ? `“${g.name}” is active.` : `“${g.name}” is inactive: no new projects can be created in it.`); }
    catch (e) { toast(errText(e, 'Could not change the group.'), 'error'); }
  };
  const remove = async (g: ProjectGroup) => {
    if (g.projectCount > 0) { setRemoving(g); return; }
    if (!(await confirmDialog({ title: 'Delete project group?', message: `Delete “${g.name}”? It has no projects.`, confirmText: 'Delete' }))) return;
    try { await projectGroupApi.remove(g.id); await invalidateWorkspace(wid, 'project-groups'); toast('Project group deleted.', 'warning'); }
    catch (e) { toast(errText(e, 'Could not delete the group.'), 'error'); }
  };

  const reorderable = canManage && groups.length > 1;
  const total = groups.reduce((n, g) => n + g.projectCount, 0);

  return (
    <>
      <PageHead title="Project groups" sub={`${groups.length} group${groups.length === 1 ? '' : 's'} · ${total} project${total === 1 ? '' : 's'}. Each project belongs to exactly one.`}>
        {canManage && <button className="btn btn-primary" onClick={() => setEditing({})}><Icon name="plus" /> New group</button>}
      </PageHead>

      <div className="card">
        <div className="card-head"><div><h3>Groups</h3><p>{canManage ? `The list projects are organized into${reorderable ? ' · drag a group, or use the arrows, to reorder' : ''}.` : 'Only people with the “manage project groups” permission can change them.'}</p></div></div>
        {groups.length === 0 ? <div className="card-body"><EmptyState icon="folder" title="No project groups yet" text="Add the first group, for example “Salesforce Projects”." /></div> : (
          <ul className="pg-list" aria-label="Project groups">
            {groups.map((g, i) => {
              const marker = over?.id === g.id && dragId !== g.id ? (over.after ? 'drop-after' : 'drop-before') : '';
              return (
                <li key={g.id} className={`pg-row ${g.isActive ? '' : 'inactive'} ${dragId === g.id ? 'dragging' : ''} ${marker}`}
                  draggable={reorderable} tabIndex={reorderable ? 0 : undefined}
                  onDragStart={(e) => { setDragId(g.id); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', g.id); } catch { /* ignore */ } }}
                  onDragEnd={() => { setDragId(null); setOver(null); }}
                  onDragOver={(e) => { if (!dragId) return; e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setOver({ id: g.id, after: e.clientY > r.top + r.height / 2 }); }}
                  onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o?.id === g.id ? null : o)); }}
                  onDrop={(e) => { e.preventDefault(); if (dragId && over) moveTo(dragId, over.id, over.after); setDragId(null); setOver(null); }}>
                  {reorderable && <span className="pg-handle" aria-hidden="true" title="Drag to reorder"><Icon name="grip" size={16} /></span>}
                  <span className="pg-order">{i + 1}</span>
                  <div className="pg-main">
                    <b>{g.name}</b>
                    {g.description && <span>{g.description}</span>}
                  </div>
                  <span className={`badge ${g.isActive ? 'badge-success' : 'badge-neutral'}`}><span className="dot" />{g.isActive ? 'Active' : 'Inactive'}</span>
                  <span className="pg-count" title={`${g.projectCount} project${g.projectCount === 1 ? '' : 's'}${g.projectCount !== g.activeProjectCount ? `, ${g.projectCount - g.activeProjectCount} archived` : ''}`}>
                    <Icon name="folder" size={14} /> <b>{g.projectCount}</b> project{g.projectCount === 1 ? '' : 's'}
                  </span>
                  {canManage && (
                    <div className="pg-actions">
                      {reorderable && (
                        <>
                          <button className="btn-icon" title="Move up" aria-label={`Move ${g.name} up`} disabled={i === 0} onClick={() => nudge(g.id, -1)}><Icon name="chevronL" size={15} style={{ transform: 'rotate(90deg)' }} /></button>
                          <button className="btn-icon" title="Move down" aria-label={`Move ${g.name} down`} disabled={i === groups.length - 1} onClick={() => nudge(g.id, 1)}><Icon name="chevronR" size={15} style={{ transform: 'rotate(90deg)' }} /></button>
                        </>
                      )}
                      <button type="button" className={`switch ${g.isActive ? 'on' : ''}`} role="switch" aria-checked={g.isActive} aria-label={`${g.name} is active`}
                        title={g.isActive ? 'Deactivate: no new projects in this group' : 'Activate'} onClick={() => void setActive(g, !g.isActive)} />
                      <button className="btn-icon" title="Edit" aria-label={`Edit ${g.name}`} onClick={() => setEditing({ group: g })}><Icon name="edit" /></button>
                      <button className="btn-icon danger" title="Delete" aria-label={`Delete ${g.name}`} onClick={() => void remove(g)}><Icon name="trash" /></button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {editing && <GroupModal group={editing.group} onClose={() => setEditing(null)} />}
      {removing && <MoveAndDeleteModal group={removing} others={groups.filter((g) => g.id !== removing.id && g.isActive)} onClose={() => setRemoving(null)} />}
    </>
  );
}

function GroupModal({ group, onClose }: { group?: ProjectGroup; onClose: () => void }) {
  const wid = useWorkspaceId();
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [isActive, setIsActive] = useState(group?.isActive ?? true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (name.trim().length < 2) { setError('A group name needs 2 to 60 characters.'); return; }
    setBusy(true);
    try {
      if (group) await projectGroupApi.update(group.id, { name: name.trim(), description: description.trim(), isActive });
      else await projectGroupApi.create({ name: name.trim(), description: description.trim() || null, isActive });
      await invalidateWorkspace(wid, 'project-groups');
      toast(group ? 'Project group updated.' : 'Project group added.');
      onClose();
    } catch (e) { setError(errText(e, 'Could not save the group.')); }
    finally { setBusy(false); }
  };

  return (
    <Modal size="sm" title={group ? 'Edit project group' : 'New project group'} subtitle="Groups organize projects on the Project Status page and in the project list." onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={busy}>{group ? 'Save' : 'Add group'}</SubmitButton></>}>
      <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
        <Field label="Name" required error={error}><input className="input" value={name} maxLength={60} placeholder="e.g. Salesforce Projects" onChange={(e) => { setName(e.target.value); setError(''); }} /></Field>
        <Field label="Description" hint="Optional."><input className="input" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Active" hint="An inactive group keeps its projects but is not offered when a project is created.">
          <label className="row" style={{ gap: 8, fontSize: 13 }}><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Available for new projects</label>
        </Field>
      </div>
    </Modal>
  );
}

/** A group that still has projects can only be deleted after they are moved: pick the group they go to. */
function MoveAndDeleteModal({ group, others, onClose }: { group: ProjectGroup; others: ProjectGroup[]; onClose: () => void }) {
  const wid = useWorkspaceId();
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!target) { setError('Choose the group the projects move to.'); return; }
    setBusy(true);
    try {
      await projectGroupApi.remove(group.id, target);
      await invalidateWorkspace(wid);
      toast(`“${group.name}” was deleted and its ${group.projectCount} project${group.projectCount === 1 ? '' : 's'} moved.`, 'warning');
      onClose();
    } catch (e) { setError(errText(e, 'Could not delete the group.')); }
    finally { setBusy(false); }
  };

  return (
    <Modal size="sm" title="Move projects, then delete" onClose={onClose}
      subtitle={`“${group.name}” has ${group.projectCount} project${group.projectCount === 1 ? '' : 's'}. A group with projects cannot be deleted until they are moved to another group.`}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-danger" type="submit" disabled={busy || others.length === 0}>Move and delete</button></>}>
      {others.length === 0
        ? <div className="form-error">There is no other active group to move the projects to. Add or activate one first.</div>
        : (
          <Field label="Move the projects to" required error={error}>
            <Select className="select" value={target} onChange={(e) => { setTarget(e.target.value); setError(''); }} aria-label="Move the projects to">
              <option value="">Select a group…</option>{others.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </Select>
          </Field>
        )}
    </Modal>
  );
}
