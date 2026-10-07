import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { documentApi, orgApi, teamApi, workspaceApi } from '../../api/endpoints';
import type { ApproverKind, ApprovalRule, DocWorkflow, SaveWorkflow, WorkflowStepInput } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { EmptyState, ErrorState, Field, Modal, PageLoader, SubmitButton } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

const KINDS: { value: ApproverKind; label: string }[] = [
  { value: 'User', label: 'A person' }, { value: 'Team', label: 'A team' }, { value: 'JobRole', label: 'A job role' }, { value: 'ProjectOwner', label: 'The project’s owner' },
];
const blank = (name = ''): WorkflowStepInput => ({ name, kind: 'User', principalId: null, rule: 'Any', dueDays: null });
const PRESETS: { label: string; steps: string[] }[] = [
  { label: 'One approver', steps: ['Approval'] },
  { label: 'Business, then technical', steps: ['Business owner', 'Technical owner'] },
  { label: 'Review, architect, approval', steps: ['Peer review', 'Architect', 'Final approval'] },
];

function StepEditor({ step, index, count, onChange, onMove, onRemove, people, teams, roles, reminders }: {
  step: WorkflowStepInput; index: number; count: number; onChange: (s: WorkflowStepInput) => void; onMove: (d: -1 | 1) => void; onRemove: () => void;
  people: { id: string; name: string }[]; teams: { id: string; name: string }[]; roles: { id: string; name: string }[]; reminders: boolean;
}) {
  const options = step.kind === 'User' ? people : step.kind === 'Team' ? teams : roles;
  return (
    <li className="dwf-step">
      <span className="dwf-num">{index + 1}</span>
      <div className="dwf-fields">
        <input className="input" value={step.name} maxLength={60} placeholder="Step name, e.g. Business owner" aria-label={`Step ${index + 1} name`} onChange={(e) => onChange({ ...step, name: e.target.value })} />
        <div className="dwf-row">
          <Select className="select" value={step.kind} aria-label="Who approves" onChange={(e) => onChange({ ...step, kind: e.target.value as ApproverKind, principalId: null, rule: 'Any' })}>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select>
          {step.kind !== 'ProjectOwner' && (
            <Select className="select" value={step.principalId ?? ''} aria-label="Choose" onChange={(e) => onChange({ ...step, principalId: e.target.value || null })}><option value="">Choose…</option>{options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
          )}
          {(step.kind === 'Team' || step.kind === 'JobRole') && (
            <Select className="select" value={step.rule} aria-label="How many must approve" onChange={(e) => onChange({ ...step, rule: e.target.value as ApprovalRule })}><option value="Any">Any one of them</option><option value="All">All of them</option></Select>
          )}
          {reminders && <label className="dwf-due">Due in <input className="input" type="number" min={1} max={90} value={step.dueDays ?? ''} placeholder="–" onChange={(e) => onChange({ ...step, dueDays: e.target.value ? Number(e.target.value) : null })} /> days</label>}
        </div>
      </div>
      <div className="dwf-tools">
        <button type="button" className="btn-icon" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)}><span className="flip-v"><Icon name="chevronD" size={14} /></span></button>
        <button type="button" className="btn-icon" aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(1)}><Icon name="chevronD" size={14} /></button>
        <button type="button" className="btn-icon" aria-label="Remove step" disabled={count === 1} onClick={onRemove}><Icon name="close" size={14} /></button>
      </div>
    </li>
  );
}

function Editor({ existing, scope, onDone, onCancel, perType, reminders }: { existing: DocWorkflow | null; scope: string | null; onDone: () => void; onCancel: () => void; perType: boolean; reminders: boolean }) {
  const wid = useWorkspaceId();
  const types = useWsQuery(['document-types'], documentApi.types);
  const members = useWsQuery(['members'], workspaceApi.members);
  const teams = useWsQuery(['teams'], teamApi.list);
  const org = useWsQuery(['org'], orgApi.get);
  const [typeId, setTypeId] = useState<string | null>(existing ? existing.typeId : scope);
  const [name, setName] = useState(existing?.name ?? '');
  const [active, setActive] = useState(existing?.isActive ?? true);
  const [remind, setRemind] = useState(existing?.remind ?? false);
  const [steps, setSteps] = useState<WorkflowStepInput[]>(existing?.steps.map(({ name, kind, principalId, rule, dueDays }) => ({ name, kind, principalId, rule, dueDays })) ?? [blank('Approval')]);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => { const b: SaveWorkflow = { typeId, name: name.trim(), isActive: active, remind: remind && reminders, steps: steps.map((s) => ({ ...s, name: s.name.trim() })) }; return existing ? documentApi.updateWorkflow(existing.id, b) : documentApi.createWorkflow(b); },
    onSuccess: () => { invalidateWorkspace(wid, 'document-workflows'); invalidateWorkspace(wid, 'documents'); toast('Workflow saved.'); onDone(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  const set = (i: number, s: WorkflowStepInput) => setSteps((x) => x.map((y, j) => (j === i ? s : y)));
  const move = (i: number, d: -1 | 1) => setSteps((x) => { const y = [...x]; [y[i], y[i + d]] = [y[i + d], y[i]]; return y; });
  const typeName = types.data?.find((t) => t.id === typeId)?.name;
  return (
    <form className="dwf-edit" onSubmit={(e) => { e.preventDefault(); setError(null); if (!name.trim()) { setError('Give the workflow a name.'); return; } if (steps.some((s) => !s.name.trim() || (s.kind !== 'ProjectOwner' && !s.principalId))) { setError('Name every step and choose who approves it.'); return; } save.mutate(); }}>
      {error && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{error}</div></div>}
      <div className="dwf-top">
        <Field label="Name" required><input className="input" value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} placeholder="e.g. BRD approval" /></Field>
        <Field label="Applies to" hint={typeId ? `Only ${typeName ?? 'this kind'}. It replaces the default workflow for them.` : 'Every kind of document without a workflow of its own.'}>
          <Select className="select" value={typeId ?? ''} disabled={!!existing || !perType} aria-label="Applies to" onChange={(e) => setTypeId(e.target.value || null)}>
            <option value="">All document types</option>{perType && types.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
      </div>
      <div className="dwf-presets"><span className="muted">Start from</span>{PRESETS.map((p) => <button type="button" key={p.label} className="chip-btn" onClick={() => setSteps(p.steps.map((n) => blank(n)))}>{p.label}</button>)}</div>
      <ol className="dwf-steps">{steps.map((s, i) => <StepEditor key={i} step={s} index={i} count={steps.length} onChange={(v) => set(i, v)} onMove={(d) => move(i, d)} onRemove={() => setSteps((x) => x.filter((_, j) => j !== i))}
        people={(members.data ?? []).filter((m) => m.role !== 'Guest').map((m) => ({ id: m.userId, name: m.displayName }))} teams={(teams.data ?? []).map((t) => ({ id: t.id, name: t.name }))} roles={(org.data?.roles ?? []).filter((r) => !r.isDeleted).map((r) => ({ id: r.id, name: r.name }))} reminders={reminders} />)}</ol>
      {steps.length < 6 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSteps((x) => [...x, blank()])}><Icon name="plus" size={14} /> Add a step</button>}
      <div className="dwf-opts">
        <label className="check-row"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> <span><b>In use</b> <small>: new submissions follow this path.</small></span></label>
        {reminders ? <label className="check-row"><input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} /> <span><b>Remind approvers</b> <small>: once, when a step is later than its due time.</small></span></label> : <p className="muted"><Icon name="lock" size={13} /> Due times and reminders are on the <Link to="/settings/billing">Business plan</Link>.</p>}
      </div>
      <div className="dwf-foot"><button className="btn btn-ghost" type="button" onClick={onCancel}>Back</button><SubmitButton busy={save.isPending}>Save workflow</SubmitButton></div>
    </form>
  );
}

/** The approval paths: who approves which kind of document. People without the permission can read them. */
export function WorkflowsModal({ onClose }: { onClose: () => void }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['document-workflows'], documentApi.workflows);
  const [editing, setEditing] = useState<DocWorkflow | 'new' | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => documentApi.removeWorkflow(id),
    onSuccess: () => { invalidateWorkspace(wid, 'document-workflows'); invalidateWorkspace(wid, 'documents'); toast('Workflow removed.', 'warning'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not remove it.', 'error'),
  });
  const d = q.data;
  return (
    <Modal title="Approval workflows" subtitle="Who must approve a document before it is published." size="lg" onClose={onClose} footer={editing ? undefined : <button className="btn btn-ghost" onClick={onClose}>Close</button>}>
      {q.isLoading ? <PageLoader /> : q.isError || !d ? <ErrorState error={q.error} retry={() => q.refetch()} /> : editing ? (
        <Editor existing={editing === 'new' ? null : editing} scope={null} perType={d.perType} reminders={d.reminders} onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />
      ) : !d.allowed ? (
        <EmptyState icon="lock" title="Approval workflows are on Pro and above" text="On the Free plan the owner of a document publishes it. Pro adds multi-step approval; Business adds a path per kind of document, due times and reminders." action={<Link className="btn btn-primary" to="/settings/billing" onClick={onClose}>See plans</Link>} />
      ) : (
        <div className="dwf">
          {d.items.length === 0 ? <EmptyState icon="checkCircle" title="No workflow yet" text="Without one, whoever may edit a document publishes it directly." action={d.canManage ? <button className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" /> New workflow</button> : undefined} /> : (
            <>
              <ul className="dwf-list">
                {d.items.map((w) => (
                  <li key={w.id} className={w.isActive ? '' : 'off'}>
                    <div className="dwf-list-main">
                      <div className="dwf-list-head"><b>{w.name}</b><span className="badge badge-neutral">{w.typeName ?? 'All document types'}</span>{!w.isActive && <span className="badge badge-warning">Not in use</span>}{w.remind && <span className="badge badge-info">Reminders</span>}</div>
                      <ol className="dwf-flow">{w.steps.map((s, i) => <li key={i}><b>{s.name}</b><span>{s.who}{s.rule === 'All' ? ' (all)' : ''}{s.dueDays ? ` · ${s.dueDays} d` : ''}</span></li>)}</ol>
                    </div>
                    {d.canManage && <div className="dwf-list-actions"><button className="btn btn-ghost btn-sm" onClick={() => setEditing(w)}>Edit</button>
                      <button className="btn-icon" aria-label="Remove workflow" onClick={async () => { if (await confirmDialog({ title: `Remove “${w.name}”?`, message: 'Reviews already running keep their steps. New documents of this kind are published directly again, unless another workflow applies.', confirmText: 'Remove' })) remove.mutate(w.id); }}><Icon name="trash" size={14} /></button></div>}
                  </li>
                ))}
              </ul>
              {d.canManage && <button className="btn btn-ghost" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> New workflow</button>}
            </>
          )}
          {!d.canManage && <p className="muted">Only people who manage document workflows can change these.</p>}
          {d.canManage && !d.perType && <p className="muted dwf-hint"><Icon name="lock" size={13} /> A separate path for each kind of document is on the <Link to="/settings/billing" onClick={onClose}>Business plan</Link>.</p>}
        </div>
      )}
    </Modal>
  );
}
