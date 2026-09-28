import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { projectApi, workspaceApi } from '../../api/endpoints';
import type { Stage, StageDisplayStatus, StageStatus } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, Field, Modal, StageBadge, SubmitButton } from '../../components/ui';
import { STAGE_STATUSES, formatDate, labelize } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { alertDialog, confirmDialog, toast } from '../../stores/ui';
import { REFUSALS } from '../tasks/actions';
import { isTestingStage } from '../issues/issueMeta';
import { TimelineManagerModal } from './TimelineTemplates';
import { Select } from '../../components/Select';

const CLASS: Record<StageDisplayStatus, string> = { Completed: 'done', InProgress: 'active', Pending: 'pending', Delayed: 'delayed', Locked: 'locked' };

/** Locked while the stage before it is unfinished; otherwise whatever the stage itself says. */
const displayOf = (s: Stage): StageDisplayStatus => (s.locked ? 'Locked' : s.effectiveStatus);

function Dot({ status }: { status: StageDisplayStatus }) {
  if (status === 'Locked') return <Icon name="lock" size={15} />;
  if (status === 'Completed') return <Icon name="tick" />;
  if (status === 'InProgress') return <span style={{ fontSize: 16 }}>●</span>;
  if (status === 'Pending') return <span style={{ fontSize: 16 }}>○</span>;
  return <span>!</span>;
}

/** Horizontal, data-driven project lifecycle (spec 13.3). */
export function Timeline({ projectId, projectName, stages, canEdit, canReportIssue, onShowIssues, onReportIssue }: {
  projectId: string; projectName: string; stages: Stage[]; canEdit: boolean;
  /** Test issues: whether the person may report one, and the ways into them from a stage. */
  canReportIssue: boolean; onShowIssues: (stageId: string) => void; onReportIssue: (stageId: string) => void;
}) {
  const wid = useWorkspaceId();
  const [modal, setModal] = useState<{ stage?: Stage } | null>(null);
  const [manager, setManager] = useState(false);
  // The order shown while a change is being saved, so a dropped stage does not jump back before the server has answered.
  const [pending, setPending] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const ordered = useMemo(() => {
    if (!pending) return stages;
    const rank = new Map(pending.map((id, i) => [id, i]));
    return [...stages].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  }, [stages, pending]);
  const done = stages.filter((s) => s.effectiveStatus === 'Completed').length;

  const commit = async (ids: string[]) => {
    if (ids.every((id, i) => id === ordered[i].id)) return;
    setPending(ids);
    try {
      await projectApi.reorderStages(projectId, ids);
      await invalidateWorkspace(wid);
      toast('Timeline order saved.');
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
  const canReorder = canEdit && stages.length > 1;

  return (
    <div className="card">
      <div className="card-head">
        <div><h3>Project timeline</h3><p>{stages.length ? `${done} of ${stages.length} stages completed${canReorder ? ' · drag a stage to reorder' : ''}` : 'No stages defined yet'}</p></div>
        <div className="row">
          <div className="legend"><span>✓ Completed</span><span>● In progress</span><span>○ Pending</span><span><Icon name="lock" size={11} /> Locked</span><span>! Delayed</span></div>
          {canEdit && <button className="btn-icon" title="Timeline templates" aria-label="Timeline templates" onClick={() => setManager(true)}><Icon name="layers" /></button>}
          {canEdit && <button className="btn btn-primary btn-sm" onClick={() => setModal({})}><Icon name="plus" /> Add stage</button>}
        </div>
      </div>
      <div className="card-body">
        {stages.length === 0 ? <EmptyState icon="flag" title="No stages yet" text="Add lifecycle stages such as Planning, Development and UAT." /> : (
          <div className="htl">
            {ordered.map((s) => {
              const effective = displayOf(s);
              const marker = over?.id === s.id && dragId !== s.id ? (over.after ? 'drop-after' : 'drop-before') : '';
              return (
                <div className={`htl-item ${CLASS[effective]} ${dragId === s.id ? 'dragging' : ''} ${marker}`} key={s.id}
                  draggable={canReorder} tabIndex={canReorder ? 0 : undefined} title={canReorder ? 'Drag to reorder' : undefined}
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
                    setOver({ id: s.id, after: e.clientX > r.left + r.width / 2 });
                  }}
                  onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o?.id === s.id ? null : o)); }}
                  onDrop={(e) => { e.preventDefault(); if (dragId && over) moveTo(dragId, over.id, over.after); endDrag(); }}>
                  <div className="htl-dot"><Dot status={effective} /></div>
                  <div className="htl-body">
                    <div className="htl-top">
                      <span className="htl-title">{s.name}</span>
                      <div className="row" style={{ gap: 6 }}>
                        <StageBadge status={effective} />
                        {canEdit && <button className="btn-icon" title="Edit stage" aria-label={`Edit ${s.name}`} onClick={() => setModal({ stage: s })}><Icon name="edit" /></button>}
                      </div>
                      {canReorder && (
                        <div className="htl-move">
                          <button type="button" className="btn-icon" title="Move earlier" aria-label={`Move ${s.name} earlier`} disabled={ordered[0].id === s.id} onClick={() => nudge(s.id, -1)}><Icon name="chevronL" size={15} /></button>
                          <button type="button" className="btn-icon" title="Move later" aria-label={`Move ${s.name} later`} disabled={ordered[ordered.length - 1].id === s.id} onClick={() => nudge(s.id, 1)}><Icon name="chevronR" size={15} /></button>
                        </div>
                      )}
                    </div>
                    <div className="htl-dates">
                      <span>Planned: {formatDate(s.plannedStart)}{s.plannedEnd && s.plannedEnd !== s.plannedStart ? ` → ${formatDate(s.plannedEnd)}` : ''}</span>
                      {(s.actualStart || s.actualEnd) && <span>Actual: {formatDate(s.actualStart)}{s.actualEnd ? ` → ${formatDate(s.actualEnd)}` : ' → …'}</span>}
                      {s.owner && <span>Owner: {s.owner.name}</span>}
                      {s.assignee && <span>Assignee: {s.assignee.name}</span>}
                    </div>
                    {s.taskTotal > 0 && (
                      <div className="htl-tasks" title="A stage completes automatically once all of its tasks are completed">
                        <div className="htl-tasks-top"><span>{s.taskDone} of {s.taskTotal} task{s.taskTotal === 1 ? '' : 's'} done</span><b>{Math.round((s.taskDone / s.taskTotal) * 100)}%</b></div>
                        <div className="progress"><div className={`progress-bar${s.taskDone === s.taskTotal ? ' green' : ''}`} style={{ width: `${(s.taskDone / s.taskTotal) * 100}%` }} /></div>
                      </div>
                    )}
                    {(s.totalIssues > 0 || (isTestingStage(s.name) && !s.locked)) && (
                      <div className="htl-issues">
                        <button type="button" className={`issue-chip ${s.openIssues > 0 ? 'open' : s.totalIssues > 0 ? 'clear' : ''}`} onClick={() => onShowIssues(s.id)}
                          title="Show this stage's issues"><Icon name="bug" size={13} />
                          {s.openIssues > 0 ? `${s.openIssues} open issue${s.openIssues === 1 ? '' : 's'}` : s.totalIssues > 0 ? `All ${s.totalIssues} resolved` : 'No issues'}
                        </button>
                        {canReportIssue && !s.locked && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onReportIssue(s.id)}><Icon name="plus" size={13} /> Report issue</button>}
                      </div>
                    )}
                    {s.description && <div className="htl-note">{s.description}</div>}
                    {effective === 'Locked' && <div className="htl-note">Complete “{s.lockedBy}” first.</div>}
                    {s.openIssues > 0 && effective !== 'Locked' && <div className="htl-note warn">Resolve {s.openIssues === 1 ? 'the open issue' : `the ${s.openIssues} open issues`} before this stage can be completed.</div>}
                    {effective === 'Delayed' && s.status !== 'Delayed' && <div className="htl-note warn">Planned end {formatDate(s.plannedEnd)} has passed.</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {modal && <StageModal projectId={projectId} stage={modal.stage} stages={ordered} onClose={() => setModal(null)} />}
      {manager && <TimelineManagerModal project={{ id: projectId, name: projectName }} onClose={() => setManager(false)} />}
    </div>
  );
}

function StageModal({ projectId, stage, stages, onClose }: { projectId: string; stage?: Stage; stages: Stage[]; onClose: () => void }) {
  const wid = useWorkspaceId();
  const [after, setAfter] = useState('end'); // where a new stage goes: at the end, or right after another stage
  const members = useWsQuery(['members'], workspaceApi.members);
  const [f, setF] = useState({
    name: stage?.name ?? '', status: (stage?.status ?? 'Pending') as StageStatus, plannedStart: stage?.plannedStart ?? '', plannedEnd: stage?.plannedEnd ?? '',
    actualStart: stage?.actualStart ?? '', actualEnd: stage?.actualEnd ?? '', ownerId: stage?.owner?.id ?? '', assigneeId: stage?.assignee?.id ?? '',
    description: stage?.description ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof f, v: string) => { setF((p) => ({ ...p, [k]: v })); setErrors((e) => ({ ...e, [k]: '' })); };

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name.trim(), status: f.status, plannedStart: f.plannedStart || null, plannedEnd: f.plannedEnd || null, actualStart: f.actualStart || null,
        actualEnd: f.actualEnd || null, ownerId: f.ownerId || null, assigneeId: f.assigneeId || null, description: f.description.trim() || null,
        order: stage ? undefined : after === 'end' ? stages.length : stages.findIndex((x) => x.id === after) + 1,
      };
      return stage ? projectApi.updateStage(projectId, stage.id, body) : projectApi.createStage(projectId, body);
    },
    onSuccess: async () => { toast(stage ? 'Stage updated.' : 'Stage added.'); await invalidateWorkspace(wid); onClose(); },
    onError: (e) => {
      if (e instanceof ApiError && REFUSALS[e.code]) {
        void alertDialog({ title: REFUSALS[e.code], message: e.errors[0]?.message ?? e.message });
        return;
      }
      const fe: Record<string, string> = {};
      if (e instanceof ApiError) e.errors.forEach((x) => { fe[x.field ?? 'name'] = x.message; });
      setErrors(Object.keys(fe).length ? fe : { name: 'Could not save the stage.' });
    },
  });

  const remove = async () => {
    if (!stage || !(await confirmDialog({ title: 'Delete stage?', message: stage.taskTotal > 0 ? `Remove “${stage.name}” from the timeline? Its ${stage.taskTotal} task${stage.taskTotal === 1 ? '' : 's'} stay in the project but no longer belong to a phase.` : `Remove “${stage.name}” from the timeline?` }))) return;
    try { await projectApi.deleteStage(projectId, stage.id); toast('Stage deleted.', 'warning'); await invalidateWorkspace(wid); onClose(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete the stage.', 'error'); }
  };

  return (
    <Modal size="lg" title={stage ? 'Edit stage' : 'Add stage'} subtitle="Stages describe the project lifecycle and appear on the timeline." onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); if (!f.name.trim()) { setErrors({ name: 'Stage name is required.' }); return; } save.mutate(); }}
      footer={<>
        {stage && <button type="button" className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={remove}><Icon name="trash" /> Delete</button>}
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={save.isPending}>Save stage</SubmitButton>
      </>}>
      <div className="form-grid">
        <Field label="Stage name" required error={errors.name}><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={80} /></Field>
        <Field label="Status" hint={stage?.locked ? `Locked until “${stage.lockedBy}” is completed, so it can only stay pending for now.` : undefined}>
          <Select className="select" value={f.status} onChange={(e) => set('status', e.target.value)}>
            {STAGE_STATUSES.map((s) => <option key={s} value={s} disabled={!!stage?.locked && s !== 'Pending' && s !== stage.status}>{labelize(s)}</option>)}
          </Select>
        </Field>
        {!stage && (
          <Field label="Position" hint="Stages are worked through in order. You can also drag stages on the timeline afterwards.">
            <Select className="select" value={after} onChange={(e) => setAfter(e.target.value)}>
              <option value="end">At the end</option>
              {stages.map((s) => <option key={s.id} value={s.id}>After “{s.name}”</option>)}
            </Select>
          </Field>
        )}
        <Field label="Planned start"><input className="input" type="date" value={f.plannedStart} onChange={(e) => set('plannedStart', e.target.value)} /></Field>
        <Field label="Planned end" error={errors.plannedEnd}><input className="input" type="date" value={f.plannedEnd} onChange={(e) => set('plannedEnd', e.target.value)} /></Field>
        <Field label="Actual start"><input className="input" type="date" value={f.actualStart} onChange={(e) => set('actualStart', e.target.value)} /></Field>
        <Field label="Actual completion"><input className="input" type="date" value={f.actualEnd} onChange={(e) => set('actualEnd', e.target.value)} /></Field>
        <Field label="Owner"><Select className="select" value={f.ownerId} onChange={(e) => set('ownerId', e.target.value)}><option value="">—</option>{members.data?.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}</Select></Field>
        <Field label="Assignee"><Select className="select" value={f.assigneeId} onChange={(e) => set('assigneeId', e.target.value)}><option value="">—</option>{members.data?.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}</Select></Field>
        <Field label="Description / comments" full><textarea className="textarea" value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} /></Field>
      </div>
    </Modal>
  );
}
