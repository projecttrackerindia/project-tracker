import { Fragment, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { projectApi, workspaceApi } from '../../api/endpoints';
import type { ProjectDetail, WorkflowStatus } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Avatar, EmptyState, Field, Modal, PageLoader, Pager, RoleBadge, SubmitButton } from '../../components/ui';
import { LABEL_COLORS, STATUS_CATEGORIES, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useCan, useEntitlement, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { activityIcon } from '../dashboard/DashboardPage';
import { Select } from '../../components/Select';

// ------------------------------------------------------------------ team
export function TeamTab({ detail, canEdit }: { detail: ProjectDetail; canEdit: boolean }) {
  const wid = useWorkspaceId();
  const all = useWsQuery(['members'], workspaceApi.members, { enabled: canEdit });
  const [pick, setPick] = useState('');
  const ownerId = detail.project.owner?.id;
  const available = all.data?.filter((m) => !detail.members.some((x) => x.userId === m.userId)) ?? [];

  const add = useMutation({
    mutationFn: () => projectApi.addMember(detail.project.id, pick),
    onSuccess: () => { setPick(''); toast('Member added.'); invalidateWorkspace(wid); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not add the member.', 'error'),
  });
  const remove = async (userId: string, name: string) => {
    if (!(await confirmDialog({ title: 'Remove member?', message: `Remove ${name} from this project? They keep their workspace role.`, confirmText: 'Remove' }))) return;
    try { await projectApi.removeMember(detail.project.id, userId); toast('Member removed.', 'warning'); invalidateWorkspace(wid); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not remove the member.', 'error'); }
  };

  return (
    <div className="card">
      <div className="card-head">
        <div><h3>Project members</h3><p>People who can see and work on this project. Guests only see projects they belong to.</p></div>
        {canEdit && available.length > 0 && (
          <div className="row">
            <Select className="select" style={{ width: 200 }} value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Add a member">
              <option value="">Add a member…</option>{available.map((m) => <option key={m.userId} value={m.userId}>{m.displayName} ({m.role})</option>)}
            </Select>
            <button className="btn btn-primary btn-sm" disabled={!pick || add.isPending} onClick={() => add.mutate()}><Icon name="plus" /> Add</button>
          </div>
        )}
      </div>
      <div className="card-body">
        <div className="member-list">
          {detail.members.map((m) => (
            <div className="member-item" key={m.userId}>
              <Avatar name={m.name} size="lg" userId={m.userId} />
              <div className="member-main"><div className="member-name">{m.name}</div><div className="member-role">{m.userId === ownerId ? 'Project owner' : 'Member'}{m.email ? ` · ${m.email}` : ''}</div></div>
              {m.role && <RoleBadge role={m.role} />}
              {canEdit && m.userId !== ownerId && <button className="btn-icon danger" title="Remove" aria-label={`Remove ${m.name}`} onClick={() => remove(m.userId, m.name)}><Icon name="close" /></button>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ workflow statuses
export function WorkflowTab({ projectId, statuses }: { projectId: string; statuses: WorkflowStatus[] }) {
  const wid = useWorkspaceId();
  const canManage = useCan('workflow.manage');
  const entitled = useEntitlement('CUSTOM_WORKFLOWS') !== 0;
  const canReorder = canManage && entitled;
  const [modal, setModal] = useState<{ status?: WorkflowStatus } | null>(null);
  // The order shown while a change is being saved, so a dropped status does not jump back before the server has answered.
  const [pending, setPending] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const flowRef = useRef<HTMLDivElement>(null);

  const ordered = useMemo(() => {
    const byOrder = [...statuses].sort((a, b) => a.order - b.order);
    if (!pending) return byOrder;
    const rank = new Map(pending.map((id, i) => [id, i]));
    return byOrder.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  }, [statuses, pending]);

  const remove = async (s: WorkflowStatus) => {
    if (!(await confirmDialog({ title: 'Delete status?', message: `Delete “${s.name}”? Move its tasks to another status first.` }))) return;
    try { await projectApi.deleteStatus(projectId, s.id); toast('Status deleted.', 'warning'); invalidateWorkspace(wid); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete the status.', 'error'); }
  };

  const commit = async (ids: string[]) => {
    if (ids.every((id, i) => id === ordered[i].id)) return;
    setPending(ids);
    try {
      await projectApi.reorderStatuses(projectId, ids);
      await invalidateWorkspace(wid);
      toast('Workflow order saved.');
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save the new order.', 'error'); }
    finally { setPending(null); }
  };
  const moveTo = (id: string, target: string, after: boolean) => {
    if (id === target) return;
    const ids = ordered.map((s) => s.id).filter((x) => x !== id);
    ids.splice(ids.indexOf(target) + (after ? 1 : 0), 0, id);
    void commit(ids);
  };
  const nudge = (id: string, delta: -1 | 1) => {
    const ids = ordered.map((s) => s.id);
    const from = ids.indexOf(id); const to = from + delta;
    if (to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    void commit(ids);
  };
  const endDrag = () => { setDragId(null); setOver(null); };

  return (
    <div className="card">
      <div className="card-head">
        <div><h3>Task workflow</h3><p>Statuses are configured per project. Each belongs to a category that drives progress and reports.</p></div>
        {canManage && entitled && <button className="btn btn-primary btn-sm" onClick={() => setModal({})}><Icon name="plus" /> Add status</button>}
      </div>
      <div className="card-body">
        {!entitled && <div className="form-warn">Custom workflows are available on the Pro plan and above. <Link className="link" to="/settings/billing">View plans</Link></div>}
        {canReorder && <p className="wf-hint">Drag a status onto another to reorder the workflow (or focus one and press Alt + ← / →). The arrows show the order tasks normally flow in, and the board columns follow it.</p>}
        <div className="wf-flow" role="list" ref={flowRef}>
          {ordered.map((s, i) => {
            const marker = over?.id === s.id && dragId !== s.id ? (over.after ? 'drop-after' : 'drop-before') : '';
            return (
              <Fragment key={s.id}>
                {i > 0 && <span className="wf-link" aria-hidden="true" />}
                <div role="listitem" className={`wf-node ${canReorder ? 'draggable' : ''} ${dragId === s.id ? 'dragging' : ''} ${marker}`}
                  draggable={canReorder} title={canReorder ? 'Drag to reorder' : undefined} tabIndex={canReorder ? 0 : undefined}
                  onKeyDown={(e) => {
                    if (!canReorder || !e.altKey || e.target !== e.currentTarget) return;
                    const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp'; const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
                    if (back || fwd) { e.preventDefault(); nudge(s.id, back ? -1 : 1); }
                  }}
                  onDragStart={(e) => { setDragId(s.id); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', s.id); } catch { /* ignore */ } }}
                  onDragEnd={endDrag}
                  onDragOver={(e) => {
                    if (!dragId) return;
                    e.preventDefault();
                    const r = e.currentTarget.getBoundingClientRect();
                    const vertical = flowRef.current ? getComputedStyle(flowRef.current).flexDirection === 'column' : false;
                    setOver({ id: s.id, after: vertical ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2 });
                  }}
                  onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o?.id === s.id ? null : o)); }}
                  onDrop={(e) => { e.preventDefault(); if (dragId && over) moveTo(dragId, over.id, over.after); endDrag(); }}>
                  {canReorder && <span className="wf-grip" aria-hidden="true"><Icon name="grip" size={16} /></span>}
                  <span className="wf-step" style={{ background: s.color }}>{i + 1}</span>
                  <div className="wf-main"><div className="wf-name">{s.name}</div><div className="wf-cat">{s.category}</div></div>
                  {canReorder && (
                    <div className="wf-actions">
                      <button className="btn-icon wf-move" title="Move earlier" aria-label={`Move ${s.name} earlier`} disabled={i === 0} onClick={() => nudge(s.id, -1)}><Icon name="chevronL" size={15} /></button>
                      <button className="btn-icon wf-move" title="Move later" aria-label={`Move ${s.name} later`} disabled={i === ordered.length - 1} onClick={() => nudge(s.id, 1)}><Icon name="chevronR" size={15} /></button>
                      <button className="btn-icon" title="Edit" aria-label={`Edit ${s.name}`} onClick={() => setModal({ status: s })}><Icon name="edit" size={15} /></button>
                      <button className="btn-icon danger" title="Delete" aria-label={`Delete ${s.name}`} onClick={() => remove(s)}><Icon name="trash" size={15} /></button>
                    </div>
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>
      {modal && <StatusModal projectId={projectId} status={modal.status} count={statuses.length} onClose={() => setModal(null)} />}
    </div>
  );
}

function StatusModal({ projectId, status, count, onClose }: { projectId: string; status?: WorkflowStatus; count: number; onClose: () => void }) {
  const wid = useWorkspaceId();
  const [name, setName] = useState(status?.name ?? '');
  const [category, setCategory] = useState(status?.category ?? 'Active');
  const [color, setColor] = useState(status?.color ?? LABEL_COLORS[0]);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => status
      ? projectApi.updateStatus(projectId, status.id, { name: name.trim(), category, color, order: status.order })
      : projectApi.createStatus(projectId, { name: name.trim(), category, color }),
    onSuccess: () => { toast(status ? 'Status updated.' : 'Status added.'); invalidateWorkspace(wid); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save the status.'),
  });
  void count;
  return (
    <Modal size="sm" title={status ? 'Edit status' : 'Add status'} onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); if (!name.trim()) { setError('Enter a status name.'); return; } setError(null); save.mutate(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={save.isPending}>Save</SubmitButton></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
        <Field label="Name" required><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} /></Field>
        <Field label="Category" hint="Done tasks count toward progress."><Select className="select" value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>{STATUS_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
        <Field label="Colour"><div className="color-swatches">{LABEL_COLORS.map((c) => <button type="button" key={c} className={`swatch ${c === color ? 'selected' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />)}</div></Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ activity
export function ActivityTab({ projectId }: { projectId: string }) {
  const [page, setPage] = useState(1);
  const q = useWsQuery(['project', projectId, 'activity', page], () => projectApi.activity(projectId, page), { placeholderData: (p) => p });
  if (q.isLoading) return <PageLoader />;
  const data = q.data;
  return (
    <div className="card">
      <div className="card-head"><div><h3>Project activity</h3><p>Everything that changed in this project.</p></div></div>
      <div className="card-body">
        {!data?.items.length ? <EmptyState icon="activity" title="No activity yet" text="Changes to tasks and the project will appear here." /> : (
          <div className="activity-list">
            {data.items.map((a) => (
              <div className="act-item" key={a.id}>
                <div className={`act-ico ${activityIcon(a.action).tone}`}><Icon name={activityIcon(a.action).icon} /></div>
                <div className="act-body"><div className="act-text">{a.actor && <b>{a.actor.name} </b>}{a.summary}</div><div className="act-time">{timeAgo(a.createdAt)}</div></div>
              </div>
            ))}
          </div>
        )}
      </div>
      {data && <Pager page={data.page} totalPages={data.totalPages} totalItems={data.totalItems} onPage={setPage} />}
    </div>
  );
}
