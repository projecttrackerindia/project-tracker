import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { automationApi, labelApi, workspaceAutomationApi, workspaceApi } from '../../api/endpoints';
import type { AutomationAction, AutomationInput, AutomationRule, AutomationStep, AutomationTarget, AutomationTrigger, StatusCategory, WorkflowStatus } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Badge, EmptyState, Field, Modal, SubmitButton, PriorityOptions } from '../../components/ui';
import { timeAgo as timeAgoOr } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useCan, useEntitlement, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { Select } from '../../components/Select';

const TRIGGERS: { id: AutomationTrigger; label: string; group: 'When it changes' | 'On a schedule' }[] = [
  { id: 'TaskCreated', label: 'A task is created', group: 'When it changes' },
  { id: 'StatusChanged', label: 'A task changes status', group: 'When it changes' },
  { id: 'PriorityChanged', label: 'A task’s priority changes', group: 'When it changes' },
  { id: 'DueSoon', label: 'An open task is due soon', group: 'On a schedule' },
  { id: 'Overdue', label: 'An open task is overdue', group: 'On a schedule' },
  { id: 'Stale', label: 'An open task has not changed for a while', group: 'On a schedule' },
];
const ACTIONS: { id: AutomationAction; label: string }[] = [
  { id: 'SetPriority', label: 'Set the priority' },
  { id: 'MoveToStatus', label: 'Move it to a status' },
  { id: 'SetAssignee', label: 'Assign it to someone' },
  { id: 'AddLabel', label: 'Add a label' },
  { id: 'Notify', label: 'Send a notification' },
  { id: 'AddComment', label: 'Post a comment' },
];
const CATEGORIES: { id: StatusCategory; label: string }[] = [
  { id: 'Todo', label: 'A to-do status' }, { id: 'Active', label: 'An in-progress status' }, { id: 'Done', label: 'A done status' }, { id: 'Cancelled', label: 'A cancelled status' },
];
const scheduled = (t: AutomationTrigger) => t === 'DueSoon' || t === 'Overdue' || t === 'Stale';
const MAX_STEPS = 5;

const blankStep = (): AutomationStep => ({ action: 'Notify', actionPriority: 'High', actionStatusId: null, actionStatusCategory: null, actionLabelId: null, actionTarget: 'Assignee', actionUserId: null, actionText: '' });

/** "When this happens, do that" rules for one project. Rules never trigger each other, so they cannot loop. */
export function AutomationPanel({ projectId, statuses, canEdit }: { projectId: string; statuses: WorkflowStatus[]; canEdit: boolean }) {
  return <RulesCard projectId={projectId} statuses={statuses} canEdit={canEdit} />;
}

/** Settings → Automation: workspace-wide rules, for every project. */
export function WorkspaceAutomationSettings() {
  const canEdit = useCan('workflow.manage');
  return <RulesCard projectId={null} statuses={[]} canEdit={canEdit} />;
}

function RulesCard({ projectId, statuses, canEdit }: { projectId: string | null; statuses: WorkflowStatus[]; canEdit: boolean }) {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const included = useEntitlement('AUTOMATION') > 0;
  const [modal, setModal] = useState<{ rule?: AutomationRule } | null>(null);
  const key = projectId ?? 'workspace';
  const q = useWsQuery(['automations', key], () => (projectId ? automationApi.list(projectId) : workspaceAutomationApi.list()));
  const rules = q.data ?? [];
  const refresh = () => void qc.invalidateQueries({ queryKey: [wid, 'automations', key] });
  const api = {
    update: (id: string, b: AutomationInput) => (projectId ? automationApi.update(projectId, id, b) : workspaceAutomationApi.update(id, b)),
    create: (b: AutomationInput) => (projectId ? automationApi.create(projectId, b) : workspaceAutomationApi.create(b)),
    remove: (id: string) => (projectId ? automationApi.remove(projectId, id) : workspaceAutomationApi.remove(id)),
  };

  const toggle = async (r: AutomationRule) => {
    try { await api.update(r.id, { ...toInput(r), isEnabled: !r.isEnabled }); refresh(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not update the rule.', 'error'); }
  };
  const remove = async (r: AutomationRule) => {
    if (!(await confirmDialog({ title: 'Delete rule?', message: `“${r.name}” will stop running. Tasks it already changed stay as they are.`, confirmText: 'Delete' }))) return;
    try { await api.remove(r.id); toast('Rule deleted.', 'warning'); refresh(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete the rule.', 'error'); }
  };

  return (
    <div className="card">
      <div className="card-head">
        <div><h3><Icon name="bolt" size={16} /> {projectId ? 'Automation' : 'Workspace automation'}</h3>
          {!projectId && <p>Rules for every project’s tasks. A project’s own rules are in its settings.</p>}</div>
        {canEdit && included && <button className="btn btn-primary btn-sm" onClick={() => setModal({})}><Icon name="plus" size={14} /> New rule</button>}
      </div>
      <div className="card-body">
        {!included && (
          <div className="notice">Automation rules are part of the Pro plan and above. <Link className="link" to="/settings/billing">See plans</Link></div>
        )}
        {q.isLoading ? null : rules.length === 0 ? (
          <EmptyState icon="bolt" title="No rules yet" text={canEdit && included
            ? (projectId ? 'For example: when a task moves to Done, notify the reporter.' : 'For example: when a task is two days overdue, notify its assignee and raise its priority.')
            : 'Rules run automatically when tasks change.'} />
        ) : (
          <div className="rule-list">
            {rules.map((r) => (
              <div className={`rule ${r.isEnabled ? '' : 'off'}`} key={r.id}>
                <div className="rule-main">
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><b>{r.name}</b>{!r.isEnabled && <Badge>Paused</Badge>}{scheduled(r.trigger) && <Badge tone="info">Scheduled</Badge>}{r.moreActions.length > 0 && <Badge tone="purple">{r.moreActions.length + 1} actions</Badge>}</div>
                  <div className="rule-sentence">{r.summary}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{r.runCount ? `Ran ${r.runCount} time${r.runCount === 1 ? '' : 's'}${r.lastRunAt ? ` · last ${timeAgoOr(r.lastRunAt)}` : ''}` : 'Has not run yet'}</div>
                </div>
                {canEdit && (
                  <div className="td-actions">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void toggle(r)}>{r.isEnabled ? 'Pause' : 'Resume'}</button>
                    <button type="button" className="btn-icon" title="Edit" aria-label={`Edit ${r.name}`} onClick={() => setModal({ rule: r })}><Icon name="edit" /></button>
                    <button type="button" className="btn-icon danger" title="Delete" aria-label={`Delete ${r.name}`} onClick={() => void remove(r)}><Icon name="trash" /></button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {modal && <RuleModal workspace={!projectId} statuses={statuses} rule={modal.rule} save={(b) => (modal.rule ? api.update(modal.rule.id, b) : api.create(b))} onClose={() => setModal(null)} onSaved={refresh} />}
    </div>
  );
}

const stepOf = (r: AutomationStep): AutomationStep => ({
  action: r.action, actionPriority: r.actionPriority, actionStatusId: r.actionStatusId, actionStatusCategory: r.actionStatusCategory, actionLabelId: r.actionLabelId,
  actionTarget: r.actionTarget, actionUserId: r.actionUserId, actionText: r.actionText,
});
const toInput = (r: AutomationRule): AutomationInput => ({
  name: r.name, isEnabled: r.isEnabled, trigger: r.trigger, whenStatusId: r.whenStatusId, whenPriority: r.whenPriority, whenStatusCategory: r.whenStatusCategory,
  triggerDays: r.triggerDays, ...stepOf(r), moreActions: r.moreActions.map(stepOf),
});

function RuleModal({ workspace, statuses, rule, save, onClose, onSaved }: {
  workspace: boolean; statuses: WorkflowStatus[]; rule?: AutomationRule; save: (b: AutomationInput) => Promise<unknown>; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(rule?.name ?? '');
  const [trigger, setTrigger] = useState<AutomationTrigger>(rule?.trigger ?? 'StatusChanged');
  const [whenStatusId, setWhenStatusId] = useState<string | null>(rule?.whenStatusId ?? null);
  const [whenStatusCategory, setWhenStatusCategory] = useState<StatusCategory | null>(rule?.whenStatusCategory ?? null);
  const [whenPriority, setWhenPriority] = useState<string | null>(rule?.whenPriority ?? null);
  const [days, setDays] = useState<string>(rule?.triggerDays?.toString() ?? '1');
  const [steps, setSteps] = useState<AutomationStep[]>(rule ? [stepOf(rule), ...rule.moreActions.map(stepOf)] : [{ ...blankStep(), actionTarget: 'Reporter' }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) return setError('Give the rule a name.');
    setBusy(true); setError(null);
    try {
      const [first, ...more] = steps.map((s) => ({ ...s, actionText: s.actionText?.trim() || null }));
      await save({
        name: name.trim(), isEnabled: rule?.isEnabled ?? true, trigger, whenStatusId: trigger === 'StatusChanged' ? whenStatusId : null,
        whenStatusCategory: trigger === 'StatusChanged' ? whenStatusCategory : null, whenPriority: trigger === 'PriorityChanged' ? whenPriority : null,
        triggerDays: scheduled(trigger) ? Number(days) : null, ...first, moreActions: more,
      });
      toast(rule ? 'Rule updated.' : 'Rule added.');
      onSaved(); onClose();
    } catch (e) { setError(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save the rule.'); }
    finally { setBusy(false); }
  };
  const sorted = [...statuses].sort((a, b) => a.order - b.order);
  const dayLabel = trigger === 'DueSoon' ? 'Days before the due date (0 = on the day)' : trigger === 'Overdue' ? 'Days after the due date (0 = as soon as it is late)' : 'Days without any change';

  return (
    <Modal title={rule ? 'Edit rule' : 'New rule'} onClose={onClose} onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={busy}>{rule ? 'Save rule' : 'Add rule'}</SubmitButton></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <Field label="Name" required><input className="input" maxLength={100} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={workspace ? 'Chase work that is late' : 'Tell the reporter when work is done'} /></Field>

      <div className="rule-step"><span>When</span></div>
      <Field label="Trigger">
        <Select className="select" value={trigger} onChange={(e) => setTrigger(e.target.value as AutomationTrigger)}>
          {(['When it changes', 'On a schedule'] as const).map((g) => (
            <optgroup key={g} label={g}>{TRIGGERS.filter((t) => t.group === g).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</optgroup>
          ))}
        </Select>
      </Field>
      {trigger === 'StatusChanged' && (workspace ? (
        <Field label="Only when it moves to">
          <Select className="select" value={whenStatusCategory ?? ''} onChange={(e) => setWhenStatusCategory((e.target.value || null) as StatusCategory | null)}>
            <option value="">Any status</option>{CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
        </Field>
      ) : (
        <Field label="Only when it moves to">
          <Select className="select" value={whenStatusId ?? ''} onChange={(e) => setWhenStatusId(e.target.value || null)}>
            <option value="">Any status</option>{sorted.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
      ))}
      {trigger === 'PriorityChanged' && (
        <Field label="Only when it becomes">
          <Select className="select" value={whenPriority ?? ''} onChange={(e) => setWhenPriority(e.target.value || null)}>
            <option value="">Any priority</option><PriorityOptions />
          </Select>
        </Field>
      )}
      {scheduled(trigger) && (
        <Field label={dayLabel} hint="Checked every few minutes. Each task is handled once per due date (or per quiet spell).">
          <input className="input" type="number" min={trigger === 'Stale' ? 1 : 0} max={365} value={days} onChange={(e) => setDays(e.target.value)} style={{ maxWidth: 120 }} />
        </Field>
      )}

      <div className="rule-step"><span>Then</span></div>
      {steps.map((s, i) => (
        <StepEditor key={i} n={i} step={s} workspace={workspace} statuses={sorted} canRemove={steps.length > 1}
          onChange={(next) => setSteps(steps.map((x, k) => (k === i ? next : x)))} onRemove={() => setSteps(steps.filter((_, k) => k !== i))} />
      ))}
      {steps.length < MAX_STEPS && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSteps([...steps, blankStep()])}><Icon name="plus" size={14} /> And also…</button>}
    </Modal>
  );
}

function StepEditor({ n, step: f, workspace, statuses, canRemove, onChange, onRemove }: {
  n: number; step: AutomationStep; workspace: boolean; statuses: WorkflowStatus[]; canRemove: boolean; onChange: (s: AutomationStep) => void; onRemove: () => void;
}) {
  const members = useWsQuery(['members'], workspaceApi.members);
  const labels = useWsQuery(['labels'], labelApi.list);
  const set = <K extends keyof AutomationStep>(k: K, v: AutomationStep[K]) => onChange({ ...f, [k]: v });
  const person = f.action === 'SetAssignee' || f.action === 'Notify';
  return (
    <div className={`rule-action ${n > 0 ? 'more' : ''}`}>
      <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
        <Field label={n === 0 ? 'Action' : `Then also`}>
          <Select className="select" value={f.action} onChange={(e) => set('action', e.target.value as AutomationAction)}>{ACTIONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</Select>
        </Field>
        {canRemove && <button type="button" className="btn-icon danger" title="Remove this action" aria-label="Remove this action" onClick={onRemove} style={{ marginBottom: 4 }}><Icon name="trash" /></button>}
      </div>
      {f.action === 'SetPriority' && (
        <Field label="Priority"><Select className="select" value={f.actionPriority ?? 'High'} onChange={(e) => set('actionPriority', e.target.value)}><PriorityOptions /></Select></Field>
      )}
      {f.action === 'MoveToStatus' && (workspace ? (
        <Field label="Status"><Select className="select" value={f.actionStatusCategory ?? ''} onChange={(e) => set('actionStatusCategory', (e.target.value || null) as StatusCategory | null)}>
          <option value="">Choose…</option>{CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label} (the project’s first)</option>)}</Select></Field>
      ) : (
        <Field label="Status"><Select className="select" value={f.actionStatusId ?? ''} onChange={(e) => set('actionStatusId', e.target.value || null)}>
          <option value="">Choose…</option>{statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
      ))}
      {f.action === 'AddLabel' && (
        <Field label="Label"><Select className="select" value={f.actionLabelId ?? ''} onChange={(e) => set('actionLabelId', e.target.value || null)}>
          <option value="">Choose…</option>{labels.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
      )}
      {person && (
        <>
          <Field label={f.action === 'Notify' ? 'Who to notify' : 'Assign to'}>
            <Select className="select" value={f.actionTarget} onChange={(e) => set('actionTarget', e.target.value as AutomationTarget)}>
              <option value="Reporter">The reporter</option>
              {f.action === 'Notify' && <option value="Assignee">The assignee</option>}
              <option value="User">A specific person…</option>
            </Select>
          </Field>
          {f.actionTarget === 'User' && (
            <Field label="Person"><Select className="select" value={f.actionUserId ?? ''} onChange={(e) => set('actionUserId', e.target.value || null)}>
              <option value="">Choose…</option>{members.data?.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}</Select></Field>
          )}
        </>
      )}
      {(f.action === 'Notify' || f.action === 'AddComment') && (
        <Field label={f.action === 'Notify' ? 'Message (optional)' : 'Comment'} required={f.action === 'AddComment'}>
          <textarea className="textarea" rows={2} maxLength={500} value={f.actionText ?? ''} onChange={(e) => set('actionText', e.target.value)} />
        </Field>
      )}
    </div>
  );
}
