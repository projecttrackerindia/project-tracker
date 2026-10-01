import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { planningApi, workspaceApi } from '../../api/endpoints';
import type { Milestone, Stage, StageStatus } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, Field, Modal, Progress, StageBadge, SubmitButton } from '../../components/ui';
import { STAGE_STATUSES, formatDate, labelize } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { Select } from '../../components/Select';

/** Dated checkpoints of a project, each optionally marking one of its timeline stages, with progress from the tasks that count towards it. */
export function MilestonesPanel({ projectId, canEdit, stages = [] }: { projectId: string; canEdit: boolean; stages?: Stage[] }) {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const [modal, setModal] = useState<{ milestone?: Milestone } | null>(null);
  const key = ['milestones', projectId];
  const q = useWsQuery(key, () => planningApi.milestones(projectId));
  const items = q.data ?? [];
  const refresh = () => { void qc.invalidateQueries({ queryKey: [wid, 'milestones', projectId] }); void qc.invalidateQueries({ queryKey: [wid, 'project', projectId] }); };

  const remove = async (m: Milestone) => {
    if (!(await confirmDialog({ title: 'Remove milestone?', message: `“${m.name}” will be removed. Its ${m.taskTotal} task${m.taskTotal === 1 ? '' : 's'} stay in the project.` }))) return;
    try { await planningApi.deleteMilestone(projectId, m.id); toast('Milestone removed.', 'warning'); refresh(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not remove the milestone.', 'error'); }
  };

  return (
    <div className="card">
      <div className="card-head">
        <div><h3>Milestones</h3><p>{items.length ? `${items.filter((m) => m.status === 'Completed').length} of ${items.length} reached` : 'Key dates and deliverables for this project'}</p></div>
        {canEdit && <button type="button" className="btn btn-primary btn-sm" onClick={() => setModal({})}><Icon name="plus" /> Add milestone</button>}
      </div>
      <div className="card-body">
        {q.isLoading ? null : items.length === 0 ? (
          <EmptyState icon="flag" title="No milestones yet" text={canEdit ? 'Add checkpoints such as “Beta release”, then tick tasks off towards them.' : 'Nobody has planned a milestone for this project yet.'}
            action={canEdit ? <button type="button" className="btn btn-primary" onClick={() => setModal({})}><Icon name="plus" /> Add milestone</button> : undefined} />
        ) : (
          <div className="milestone-list">
            {items.map((m) => (
              <div className={`milestone ${m.status === 'Completed' ? 'done' : ''} ${m.isOverdue ? 'late' : ''}`} key={m.id}>
                <div className="milestone-flag"><Icon name="flag" /></div>
                <div className="milestone-main">
                  <div className="row" style={{ justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div className="milestone-name">{m.name}</div>
                    <div className="row" style={{ gap: 8 }}>
                      {m.isOverdue && <span className="badge badge-danger">Overdue</span>}
                      <StageBadge status={m.isOverdue && m.status === 'Pending' ? 'Delayed' : m.status} />
                    </div>
                  </div>
                  {m.description && <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>{m.description}</div>}
                  <div className="milestone-meta">
                    <span><Icon name="calendar" size={13} /> {m.dueDate ? formatDate(m.dueDate) : 'No date'}</span>
                    {m.stageName && <span title="The timeline stage this milestone marks"><Icon name="layers" size={13} /> {m.stageName}</span>}
                    {m.owner && <span><Icon name="user" size={13} /> {m.owner.name}</span>}
                    <span><Icon name="check" size={13} /> {m.taskDone}/{m.taskTotal} tasks</span>
                  </div>
                  <div className="row" style={{ marginTop: 8 }}><div style={{ flex: 1 }}><Progress value={m.progress} tone={m.isOverdue ? 'red' : 'auto'} /></div><b style={{ fontSize: 12 }}>{m.progress}%</b></div>
                </div>
                {canEdit && (
                  <div className="td-actions">
                    <button type="button" className="btn-icon" title="Edit" aria-label={`Edit ${m.name}`} onClick={() => setModal({ milestone: m })}><Icon name="edit" /></button>
                    <button type="button" className="btn-icon danger" title="Remove" aria-label={`Remove ${m.name}`} onClick={() => void remove(m)}><Icon name="trash" /></button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {modal && <MilestoneModal projectId={projectId} milestone={modal.milestone} stages={stages} onClose={() => setModal(null)} onSaved={refresh} />}
    </div>
  );
}

function MilestoneModal({ projectId, milestone, stages, onClose, onSaved }: { projectId: string; milestone?: Milestone; stages: Stage[]; onClose: () => void; onSaved: () => void }) {
  const members = useWsQuery(['members'], workspaceApi.members);
  const [name, setName] = useState(milestone?.name ?? '');
  const [description, setDescription] = useState(milestone?.description ?? '');
  const [startDate, setStartDate] = useState(milestone?.startDate ?? '');
  const [dueDate, setDueDate] = useState(milestone?.dueDate ?? '');
  const [status, setStatus] = useState<StageStatus>(milestone?.status ?? 'Pending');
  const [ownerId, setOwnerId] = useState(milestone?.owner?.id ?? '');
  const [stageId, setStageId] = useState(milestone?.stageId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (name.trim().length < 1) { setError('Give the milestone a name.'); return; }
    if (startDate && dueDate && dueDate < startDate) { setError('The due date must not be before the start date.'); return; }
    setBusy(true); setError(null);
    const body = { name: name.trim(), description: description.trim() || null, startDate: startDate || null, dueDate: dueDate || null, status, ownerId: ownerId || null, stageId: stageId || null };
    try {
      if (milestone) await planningApi.updateMilestone(projectId, milestone.id, body); else await planningApi.createMilestone(projectId, body);
      toast(milestone ? 'Milestone updated.' : 'Milestone added.');
      onSaved(); onClose();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not save the milestone.'); }
    finally { setBusy(false); }
  };

  return (
    <Modal size="sm" title={milestone ? 'Edit milestone' : 'Add milestone'} subtitle="A dated checkpoint, optionally on one of the project’s stages. Tasks are linked to it from the task screen." onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={busy}>{milestone ? 'Save changes' : 'Add milestone'}</SubmitButton></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="form-grid">
        <Field label="Name" required full><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Beta release" maxLength={120} /></Field>
        <Field label="Start date"><input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
        <Field label="Due date"><input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
        <Field label="Status"><Select className="select" value={status} onChange={(e) => setStatus(e.target.value as StageStatus)}>{STAGE_STATUSES.map((s) => <option key={s} value={s}>{labelize(s)}</option>)}</Select></Field>
        <Field label="Owner"><Select className="select" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}><option value="">— Nobody —</option>{members.data?.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}</Select></Field>
        {stages.length > 0 && (
          <Field label="Marks the stage" full hint="Optional: the timeline stage this milestone is a checkpoint of, such as “Design approved” at the end of Design.">
            <Select className="select" value={stageId} onChange={(e) => setStageId(e.target.value)} aria-label="Stage">
              <option value="">— No particular stage —</option>{[...stages].sort((a, b) => a.order - b.order).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Description" full><textarea className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></Field>
      </div>
    </Modal>
  );
}
