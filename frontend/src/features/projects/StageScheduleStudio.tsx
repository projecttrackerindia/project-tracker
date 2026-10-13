import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { projectApi } from '../../api/endpoints';
import type { ProjectScheduleInput, ProjectSchedulePreview } from '../../api/endpoints';
import type { Project, Stage } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Field, Modal, SubmitButton } from '../../components/ui';
import { Select } from '../../components/Select';
import { ApiError } from '../../api/client';
import { formatDate } from '../../lib/format';
import { invalidateWorkspace } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { calendarDuration } from './scheduleDates';
import './stageSchedule.css';

export function StageScheduleStudio({ project, stages, onClose }: { project: Project; stages: Stage[]; onClose: () => void }) {
  const wid = useWorkspaceId();
  const [mode, setMode] = useState<ProjectScheduleInput['mode']>(project.stageScheduleMode === 'FixedDeadline' ? 'FixedDeadline' : 'FollowSchedule');
  const [start, setStart] = useState(project.startDate ?? ''); const [due, setDue] = useState(project.dueDate ?? '');
  const [durations, setDurations] = useState(stages.map(s => ({ id: s.id, durationDays: String(s.durationDays ?? calendarDuration(s.plannedStart ?? '', s.plannedEnd ?? '') ?? 0) })));
  const [reason, setReason] = useState(''); const [preview, setPreview] = useState<ProjectSchedulePreview | null>(null);
  const [error, setError] = useState(''); const [previewKey, setPreviewKey] = useState('');
  const body: ProjectScheduleInput = { version: project.version, mode, startDate: start, dueDate: due,
    durations: durations.map(d => ({ id: d.id, durationDays: d.durationDays === '' ? -1 : Number(d.durationDays) })), reason: reason.trim() || null };
  const key = JSON.stringify(body); const currentKey = useRef(key); currentKey.current = key;
  const message = (e: unknown) => e instanceof ApiError ? e.errors.map(x => x.message).join(' ') || e.message : 'Could not calculate the schedule. Try again.';
  const calculate = useMutation({ mutationFn: (input: ProjectScheduleInput) => projectApi.previewSchedule(project.id, input),
    onSuccess: (data, input) => { if (JSON.stringify(input) === currentKey.current) { setPreview(data); setPreviewKey(currentKey.current); setError(''); } },
    onError: (e, input) => { if (JSON.stringify(input) === currentKey.current) { setPreview(null); setError(message(e)); } } });
  const validPreview = previewKey === key ? preview : null;
  const extension = !!validPreview && !!project.dueDate && validPreview.dueDate > project.dueDate;
  const save = useMutation({ mutationFn: () => projectApi.saveSchedule(project.id, { ...body, expectedFingerprint: validPreview?.fingerprint }),
    onSuccess: async () => { await invalidateWorkspace(wid); toast('Automatic stage schedule saved.'); onClose(); },
    onError: e => { setError(message(e)); setPreview(null); } });
  const manual = useMutation({ mutationFn: () => projectApi.update(project.id, { name: project.name, description: project.description ?? undefined,
    priority: project.priority, status: project.status, ownerId: project.owner?.id, teamId: project.teamId, projectGroupId: project.projectGroupId,
    startDate: project.startDate, dueDate: project.dueDate, version: project.version, stageScheduleMode: 'Manual' }),
    onSuccess: async () => { await invalidateWorkspace(wid); toast('Manual stage dates enabled.'); onClose(); }, onError: e => setError(message(e)) });
  const distribute = () => {
    const completedEnd = stages.filter(s => s.status === 'Completed').map(s => s.plannedEnd ?? start).sort().at(-1) ?? start;
    const available = calendarDuration(completedEnd > start ? completedEnd : start, due);
    const active = stages.filter(s => s.status !== 'Completed');
    if (available === null || available < 0 || !active.length) { setError('Choose a project range that follows the completed stages.'); return; }
    const weights = active.map(s => Math.max(0, Number(durations.find(d => d.id === s.id)?.durationDays) || 0));
    const total = weights.reduce((a, b) => a + b, 0); let cumulative = 0; let previous = 0;
    if (!total) { setError('Allocate at least one day to a working stage before distributing. Zero-day milestones remain milestones.'); return; }
    const allocations = new Map(active.map((s, i) => { cumulative += weights[i]; const boundary = Math.round(available * cumulative / total); const days = boundary - previous; previous = boundary; return [s.id, days]; }));
    setDurations(current => current.map(d => allocations.has(d.id) ? { ...d, durationDays: String(allocations.get(d.id)) } : d)); setError('');
  };
  return <Modal size="lg" title="Schedule studio" subtitle="Allocate time once. Keep every stage connected as your plan changes." onClose={onClose}
    onSubmit={e => { e.preventDefault(); if (validPreview && (!extension || reason.trim())) save.mutate(); else calculate.mutate(body); }}
    footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <SubmitButton busy={save.isPending || calculate.isPending}>{validPreview ? 'Apply schedule' : 'Preview schedule'}</SubmitButton></>}>
    <div className="schedule-intro"><Icon name="calendar" size={23} /><div><strong>A timeline that moves with your work</strong><p>Calendar days include weekends. End = start + duration; the next stage starts at that boundary. Use 0 days for a milestone.</p></div></div>
    <div className="form-grid">
      <Field label="Project start" required><input className="input" aria-label="Project start" type="date" value={start} onChange={e => setStart(e.target.value)} /></Field>
      <Field label="Project end" required hint={mode === 'FollowSchedule' ? 'Duration edits derive the finish. Editing this date anchors the final stage and schedules backward.' : undefined}><input className="input" aria-label="Project end" type="date" value={due} onChange={e => setDue(e.target.value)} /></Field>
      <Field label="Scheduling rule" full><Select className="select" aria-label="Scheduling rule" value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
        <option value="FollowSchedule">Project end follows the final stage</option><option value="FixedDeadline">Keep project end fixed</option></Select>
        <p className="schedule-help">{mode === 'FixedDeadline' ? 'Allocated durations stay intact. Remaining days become buffer; a schedule beyond the end is rejected.' : 'The project end moves with the last stage. An extension needs a reason and enters delivery history.'}</p></Field>
    </div>
    <div className="schedule-section-head"><strong>Stage allocations</strong><button type="button" className="btn btn-ghost btn-sm" onClick={distribute}>Distribute available days</button></div>
    <div className="schedule-allocations">{stages.map((s, i) => <div className={`schedule-stage-row ${s.status === 'Completed' ? 'protected' : ''}`} key={s.id}>
      <span className="schedule-order">{i + 1}</span><div className="schedule-stage-name"><strong>{s.name}</strong><small>{s.status === 'Completed' ? 'Completed · actual history protected' : s.locked ? 'Waiting for its predecessor' : 'Ready to schedule'}</small></div>
      <label><span className="sr-only">{s.name} duration in calendar days</span><input className="input" aria-label={`${s.name} duration in calendar days`} type="number" min={0} max={36500} step={1} disabled={s.status === 'Completed'} value={durations[i].durationDays}
        onChange={e => setDurations(current => current.map(d => d.id === s.id ? { ...d, durationDays: e.target.value } : d))} /><span>days</span></label></div>)}</div>
    <Field label="Schedule change reason" full hint="Required when the project end moves later."><input className="input" aria-label="Schedule change reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={500} placeholder="Why is the schedule changing?" /></Field>
    {error && <div className="schedule-error" role="alert"><Icon name="info" /><span>{error}</span></div>}
    {validPreview && <section className="schedule-preview" aria-label="Calculated stage schedule"><div className="schedule-preview-head"><div><span>Calculated finish</span><strong>{formatDate(validPreview.finishDate)}</strong></div><div><span>Project end</span><strong>{formatDate(validPreview.dueDate)}</strong></div><div><span>Timeline buffer</span><strong>{validPreview.bufferDays} days</strong></div></div>
      <div className="schedule-preview-list">{validPreview.stages.map(s => <div key={s.id}><strong>{s.name}</strong><span>{formatDate(s.start)} <span aria-hidden="true">→</span> {formatDate(s.end)}</span><small>{s.completed ? 'Protected' : s.changed ? 'Recalculated' : 'Aligned'}</small></div>)}</div>
      {extension && !reason.trim() && <p className="schedule-help">Add a reason and preview again before applying this extension.</p>}</section>}
    {project.stageScheduleMode && project.stageScheduleMode !== 'Manual' && <button type="button" className="link schedule-manual" disabled={manual.isPending} onClick={() => manual.mutate()}>Use manual stage dates instead</button>}
  </Modal>;
}
