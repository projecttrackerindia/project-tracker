import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { projectApi, workspaceApi } from '../../api/endpoints';
import type { Project, Stage, StageDisplayStatus, StageStatus } from '../../api/types';
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
import { StageScheduleStudio } from './StageScheduleStudio';
import { calendarDuration, calendarEnd } from './scheduleDates';

const CLASS: Record<StageDisplayStatus, string> = { Completed: 'done', InProgress: 'active', Pending: 'pending', Delayed: 'delayed', Locked: 'locked' };

/** Locked while the stage before it is unfinished; otherwise whatever the stage itself says. */
const displayOf = (s: Stage): StageDisplayStatus => (s.locked ? 'Locked' : s.effectiveStatus);

/** The stage's numbered dot: a green tick once signed off, a lock while it waits on the stage before, "!" when late, else its number. */
function Dot({ status, n }: { status: StageDisplayStatus; n: number }) {
  if (status === 'Locked') return <Icon name="lock" size={12} />;
  if (status === 'Completed') return <Icon name="tick" size={13} />;
  if (status === 'Delayed') return <span>!</span>;
  return <span>{n}</span>;
}

/** Remembers, per browser, that the "all tasks are done" nudge was dismissed for a project - so it does not reappear every visit. */
const nudgeKey = (projectId: string) => `pm_timeline_nudge_${projectId}`;

/** Horizontal, data-driven project lifecycle (spec 13.3). This is a formal phase sign-off, kept deliberately separate from task
 *  completion: a stage only advances when someone marks it so, whatever share of its tasks (or the project's) is done. */
export function Timeline({ projectId, projectName, project, stages, canEdit, canReportIssue, taskProgress, finished, onShowIssues, onReportIssue }: {
  project?: Project;
  projectId: string; projectName: string; stages: Stage[]; canEdit: boolean;
  /** Issues: whether the person may report one, and the ways into them from a stage. */
  canReportIssue: boolean;
  /** The project's own task-completion percentage (0-100) and whether it is itself Completed/Cancelled/Archived - to offer, not force, closing out any stage left open once the work is done. */
  taskProgress: number; finished: boolean;
  onShowIssues: (stageId: string) => void; onReportIssue: (stageId: string) => void;
}) {
  const wid = useWorkspaceId();
  const [modal, setModal] = useState<{ stage?: Stage } | null>(null);
  const [manager, setManager] = useState(false);
  const [scheduling, setScheduling] = useState(false);
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
      await projectApi.reorderStages(projectId, ids, project?.version);
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

  const [nudgeDismissed, setNudgeDismissed] = useState(() => { try { return sessionStorage.getItem(nudgeKey(projectId)) === '1'; } catch { return false; } });
  const dismissNudge = () => { setNudgeDismissed(true); try { sessionStorage.setItem(nudgeKey(projectId), '1'); } catch { /* storage unavailable */ } };
  // All the work is done, the project itself is still open, and at least one stage was never walked through to Completed.
  const showNudge = canEdit && !finished && !nudgeDismissed && taskProgress >= 100 && done < stages.length;
  const open = stages.length - done;
  const nextUp = ordered.find((s) => displayOf(s) !== 'Completed');

  return (
    <div className="card tl-card">
      <div className="card-head tl-head">
        <div className="tl-head-main">
          <h3>Project timeline</h3>
          <p>{stages.length ? <>{done} of {stages.length} stages signed off{nextUp ? <> · next up: <b className="tl-next">{nextUp.name}</b></> : ''}</> : 'Phase sign-off, tracked separately from task completion'}{canReorder ? ' · drag a stage to reorder' : ''}</p>
        </div>
        {canEdit && (
          <div className="tl-actions">
            {project && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setScheduling(true)}><Icon name="calendar" size={14} /> Schedule studio</button>}
            <button type="button" className="btn btn-soft btn-sm" title="Timeline templates" onClick={() => setManager(true)}><Icon name="layers" size={14} /><span className="tl-hide-sm">Templates</span></button>
            <button type="button" className="btn btn-soft btn-sm" onClick={() => setModal({})}><Icon name="plus" size={14} /> Add stage</button>
          </div>
        )}
      </div>
      <div className="card-body">
        {stages.length > 0 && (
          <div className="tl-summary">
            <div className="tl-progress">
              <div className="tl-progress-top"><b>{done} of {stages.length}</b><span>stages completed</span>
                {project && <em className="tl-mode" title={project.stageScheduleMode === 'Manual' || !project.stageScheduleMode ? 'Open Schedule studio to calculate a connected timeline' : undefined}>
                  <Icon name={project.stageScheduleMode && project.stageScheduleMode !== 'Manual' ? 'repeat' : 'edit'} size={11} />
                  {project.stageScheduleMode === 'FixedDeadline' ? 'Automatic · fixed end' : project.stageScheduleMode === 'FollowSchedule' ? 'Automatic · end follows stages' : 'Manual dates'}</em>}
              </div>
              <div className="tl-segments" role="img" aria-label={`${done} of ${stages.length} stages completed`}>
                {ordered.map((s) => <i key={s.id} className={`seg-${CLASS[displayOf(s)]}`} title={`${s.name}: ${labelize(displayOf(s))}`} />)}
              </div>
            </div>
            <ul className="tl-legend" aria-label="Legend">
              <li><i className="seg-done" />Completed</li><li><i className="seg-active" />In progress</li><li><i className="seg-pending" />Pending</li>
              <li><i className="seg-locked" />Locked</li><li><i className="seg-delayed" />Delayed</li>
            </ul>
          </div>
        )}
        {showNudge && (
          <div className="tl-nudge" role="status">
            <span className="tl-nudge-icon"><Icon name="info" size={15} /></span>
            <p>All tasks are done, but {open} {open === 1 ? 'stage is' : 'stages are'} still open. Walk {open === 1 ? 'it' : 'them'} through to Completed to close out the timeline - it does not do that on its own.</p>
            <div className="tl-nudge-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setModal({ stage: ordered.find((s) => displayOf(s) !== 'Completed' && displayOf(s) !== 'Locked') ?? ordered.find((s) => displayOf(s) !== 'Completed') })}>Review stages</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={dismissNudge}>Not now</button>
            </div>
          </div>
        )}
        {stages.length === 0 ? <EmptyState icon="flag" title="No stages yet" text="Add lifecycle stages such as Planning, Development and UAT." /> : (
          <div className="htl">
            {ordered.map((s, index) => {
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
                  <div className="htl-dot"><Dot status={effective} n={index + 1} /></div>
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
                      {s.durationDays != null && <span>{s.durationDays === 0 ? 'Milestone' : `${s.durationDays} calendar days allocated`}</span>}
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
      {modal && <StageModal projectId={projectId} project={project} stage={modal.stage} stages={ordered} onClose={() => setModal(null)} />}
      {scheduling && project && <StageScheduleStudio project={project} stages={ordered} onClose={() => setScheduling(false)} />}
      {manager && <TimelineManagerModal project={{ id: projectId, name: projectName }} onClose={() => setManager(false)} />}
    </div>
  );
}

function StageModal({ projectId, project, stage, stages, onClose }: { projectId: string; project?: Project; stage?: Stage; stages: Stage[]; onClose: () => void }) {
  const wid = useWorkspaceId();
  const [after, setAfter] = useState('end'); // where a new stage goes: at the end, or right after another stage
  const members = useWsQuery(['members'], workspaceApi.members);
  const [f, setF] = useState({
    name: stage?.name ?? '', status: (stage?.status ?? 'Pending') as StageStatus, plannedStart: stage?.plannedStart ?? '', plannedEnd: stage?.plannedEnd ?? '',
    actualStart: stage?.actualStart ?? '', actualEnd: stage?.actualEnd ?? '', ownerId: stage?.owner?.id ?? '', assigneeId: stage?.assignee?.id ?? '',
    description: stage?.description ?? '',
    durationDays: String(stage?.durationDays ?? calendarDuration(stage?.plannedStart ?? '', stage?.plannedEnd ?? '') ?? 1), scheduleReason: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof f, v: string) => { setF((p) => ({ ...p, [k]: v })); setErrors((e) => ({ ...e, [k]: '' })); };
  const automatic = !!project?.stageScheduleMode && project.stageScheduleMode !== 'Manual';
  const changeStart = (value: string) => { set('plannedStart', value); if (automatic) set('plannedEnd', calendarEnd(value, Number(f.durationDays))); };
  const changeDuration = (value: string) => { set('durationDays', value); set('plannedEnd', value === '' ? '' : calendarEnd(f.plannedStart, Number(value))); };
  const changeEnd = (value: string) => { set('plannedEnd', value); const days = calendarDuration(f.plannedStart, value); if (days !== null && days >= 0) set('durationDays', String(days)); };

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name.trim(), status: f.status, plannedStart: f.plannedStart || null, plannedEnd: f.plannedEnd || null, actualStart: f.actualStart || null,
        actualEnd: f.actualEnd || null, ownerId: f.ownerId || null, assigneeId: f.assigneeId || null, description: f.description.trim() || null,
        order: stage ? undefined : after === 'end' ? stages.length : stages.findIndex((x) => x.id === after) + 1,
        durationDays: f.durationDays === '' ? null : Number(f.durationDays), scheduleReason: f.scheduleReason.trim() || null, projectVersion: automatic ? project?.version : undefined,
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
    try { await projectApi.deleteStage(projectId, stage.id, project?.version); toast('Stage deleted.', 'warning'); await invalidateWorkspace(wid); onClose(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete the stage.', 'error'); }
  };

  return (
    <Modal size="lg" title={stage ? 'Edit stage' : 'Add stage'} subtitle="Stages describe the project lifecycle and appear on the timeline." onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); if (!f.name.trim()) { setErrors({ name: 'Stage name is required.' }); return; }
        if (f.durationDays === '' || !Number.isInteger(Number(f.durationDays)) || Number(f.durationDays) < 0 || Number(f.durationDays) > 36500) { setErrors({ durationDays: 'Use a whole number from 0 to 36500.' }); return; } save.mutate(); }}
      footer={<>
        {stage && <button type="button" className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={remove}><Icon name="trash" /> Delete</button>}
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={save.isPending}>Save stage</SubmitButton>
      </>}>
      {automatic && <div className="schedule-intro"><Icon name="calendar" /><div><strong>Connected stage dates</strong><p>Moving this stage or changing its duration recalculates subsequent stages. Completed history, actual dates and task deadlines are protected. {project?.stageScheduleMode === 'FixedDeadline' ? 'The schedule must fit inside the project end date.' : 'The project end follows the final stage.'}</p></div></div>}
      {(errors.schedule || errors.plannedStart || errors.reason) && <div className="schedule-error" role="alert">{errors.schedule || errors.plannedStart || errors.reason}</div>}
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
        <Field label="Allocated duration" error={errors.durationDays} hint="Calendar days; 0 is a milestone."><input className="input" aria-label="Allocated duration" type="number" min={0} max={36500} step={1} value={f.durationDays} disabled={automatic && stage?.status === 'Completed'} onChange={e => changeDuration(e.target.value)} /></Field>
        <Field label="Planned start" error={errors.plannedStart}><input className="input" aria-label="Planned start" type="date" value={f.plannedStart} disabled={automatic && stage?.status === 'Completed'} onChange={(e) => changeStart(e.target.value)} /></Field>
        <Field label="Planned end" error={errors.plannedEnd}><input className="input" aria-label="Planned end" type="date" value={f.plannedEnd} disabled={automatic && stage?.status === 'Completed'} onChange={(e) => changeEnd(e.target.value)} /></Field>
        {automatic && <Field label="Schedule change reason" error={errors.dueDateReason || errors.scheduleReason} hint="Required if this extends the project end date."><input className="input" aria-label="Schedule change reason" value={f.scheduleReason} onChange={e => set('scheduleReason', e.target.value)} maxLength={500} /></Field>}
        <Field label="Actual start"><input className="input" type="date" value={f.actualStart} onChange={(e) => set('actualStart', e.target.value)} /></Field>
        <Field label="Actual completion"><input className="input" type="date" value={f.actualEnd} onChange={(e) => set('actualEnd', e.target.value)} /></Field>
        <Field label="Owner"><Select className="select" value={f.ownerId} onChange={(e) => set('ownerId', e.target.value)}><option value="">—</option>{members.data?.filter((m) => m.isActive !== false || m.userId === f.ownerId || m.userId === f.assigneeId).map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}</Select></Field>
        <Field label="Assignee"><Select className="select" value={f.assigneeId} onChange={(e) => set('assigneeId', e.target.value)}><option value="">—</option>{members.data?.filter((m) => m.isActive !== false || m.userId === f.ownerId || m.userId === f.assigneeId).map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}</Select></Field>
        <Field label="Description / comments" full><textarea className="textarea" value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} /></Field>
      </div>
    </Modal>
  );
}
