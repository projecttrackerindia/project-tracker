import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { automationApi, labelApi, workspaceApi } from '../../api/endpoints';
import type { AutomationAction, AutomationInput, AutomationRule, AutomationTarget, AutomationTrigger, WorkflowStatus } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Badge, EmptyState, Field, Modal, SubmitButton, PriorityOptions } from '../../components/ui';
import { timeAgo as timeAgoOr } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useEntitlement, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { Select } from '../../components/Select';

const TRIGGERS: { id: AutomationTrigger; label: string }[] = [
  { id: 'TaskCreated', label: 'A task is created' },
  { id: 'StatusChanged', label: 'A task changes status' },
  { id: 'PriorityChanged', label: 'A task’s priority changes' },
];
const ACTIONS: { id: AutomationAction; label: string }[] = [
  { id: 'SetPriority', label: 'Set the priority' },
  { id: 'MoveToStatus', label: 'Move it to a status' },
  { id: 'SetAssignee', label: 'Assign it to someone' },
  { id: 'AddLabel', label: 'Add a label' },
  { id: 'Notify', label: 'Send a notification' },
  { id: 'AddComment', label: 'Post a comment' },
];

/** "When this happens, do that" rules for one project. Rules never trigger each other, so they cannot loop. */
export function AutomationPanel({ projectId, statuses, canEdit }: { projectId: string; statuses: WorkflowStatus[]; canEdit: boolean }) {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const included = useEntitlement('AUTOMATION') > 0;
  const [modal, setModal] = useState<{ rule?: AutomationRule } | null>(null);
  const q = useWsQuery(['automations', projectId], () => automationApi.list(projectId));
  const rules = q.data ?? [];
  const refresh = () => void qc.invalidateQueries({ queryKey: [wid, 'automations', projectId] });

  const toggle = async (r: AutomationRule) => {
    try { await automationApi.update(projectId, r.id, { ...toInput(r), isEnabled: !r.isEnabled }); refresh(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not update the rule.', 'error'); }
  };
  const remove = async (r: AutomationRule) => {
    if (!(await confirmDialog({ title: 'Delete rule?', message: `“${r.name}” will stop running. Tasks it already changed stay as they are.`, confirmText: 'Delete' }))) return;
    try { await automationApi.remove(projectId, r.id); toast('Rule deleted.', 'warning'); refresh(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete the rule.', 'error'); }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3><Icon name="bolt" size={16} /> Automation</h3>
        {canEdit && included && <button className="btn btn-primary btn-sm" onClick={() => setModal({})}><Icon name="plus" size={14} /> New rule</button>}
      </div>
      <div className="card-body">
        {!included && (
          <div className="notice">Automation rules are part of the Pro plan and above. <Link className="link" to="/settings/billing">See plans</Link></div>
        )}
        {q.isLoading ? null : rules.length === 0 ? (
          <EmptyState icon="bolt" title="No rules yet" text={canEdit && included ? 'For example: when a task moves to Done, notify the reporter.' : 'Rules run automatically when tasks change.'} />
        ) : (
          <div className="rule-list">
            {rules.map((r) => (
              <div className={`rule ${r.isEnabled ? '' : 'off'}`} key={r.id}>
                <div className="rule-main">
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><b>{r.name}</b>{!r.isEnabled && <Badge>Paused</Badge>}</div>
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
      {modal && <RuleModal projectId={projectId} statuses={statuses} rule={modal.rule} onClose={() => setModal(null)} onSaved={refresh} />}
    </div>
  );
}

const toInput = (r: AutomationRule): AutomationInput => ({
  name: r.name, isEnabled: r.isEnabled, trigger: r.trigger, whenStatusId: r.whenStatusId, whenPriority: r.whenPriority, action: r.action, actionPriority: r.actionPriority,
  actionStatusId: r.actionStatusId, actionLabelId: r.actionLabelId, actionTarget: r.actionTarget, actionUserId: r.actionUserId, actionText: r.actionText,
});

function RuleModal({ projectId, statuses, rule, onClose, onSaved }: { projectId: string; statuses: WorkflowStatus[]; rule?: AutomationRule; onClose: () => void; onSaved: () => void }) {
  const members = useWsQuery(['members'], workspaceApi.members);
  const labels = useWsQuery(['labels'], labelApi.list);
  const [f, setF] = useState<AutomationInput>(rule ? toInput(rule) : {
    name: '', isEnabled: true, trigger: 'StatusChanged', whenStatusId: null, whenPriority: null, action: 'Notify', actionPriority: 'High',
    actionStatusId: null, actionLabelId: null, actionTarget: 'Reporter', actionUserId: null, actionText: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof AutomationInput>(k: K, v: AutomationInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const sorted = [...statuses].sort((a, b) => a.order - b.order);
  const person = f.action === 'SetAssignee' || f.action === 'Notify';

  const submit = async () => {
    if (!f.name.trim()) return setError('Give the rule a name.');
    setBusy(true); setError(null);
    try {
      const body: AutomationInput = { ...f, name: f.name.trim(), actionText: f.actionText?.trim() || null };
      if (rule) await automationApi.update(projectId, rule.id, body); else await automationApi.create(projectId, body);
      toast(rule ? 'Rule updated.' : 'Rule added.');
      onSaved(); onClose();
    } catch (e) { setError(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save the rule.'); }
    finally { setBusy(false); }
  };

  return (
    <Modal size="sm" title={rule ? 'Edit rule' : 'New rule'} onClose={onClose} onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={busy}>{rule ? 'Save rule' : 'Add rule'}</SubmitButton></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <Field label="Name" required><input className="input" maxLength={100} autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Tell the reporter when work is done" /></Field>

      <div className="rule-step"><span>When</span></div>
      <Field label="Trigger">
        <Select className="select" value={f.trigger} onChange={(e) => set('trigger', e.target.value as AutomationTrigger)}>{TRIGGERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</Select>
      </Field>
      {f.trigger === 'StatusChanged' && (
        <Field label="Only when it moves to">
          <Select className="select" value={f.whenStatusId ?? ''} onChange={(e) => set('whenStatusId', e.target.value || null)}>
            <option value="">Any status</option>{sorted.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
      )}
      {f.trigger === 'PriorityChanged' && (
        <Field label="Only when it becomes">
          <Select className="select" value={f.whenPriority ?? ''} onChange={(e) => set('whenPriority', e.target.value || null)}>
            <option value="">Any priority</option><PriorityOptions />
          </Select>
        </Field>
      )}

      <div className="rule-step"><span>Then</span></div>
      <Field label="Action">
        <Select className="select" value={f.action} onChange={(e) => set('action', e.target.value as AutomationAction)}>{ACTIONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</Select>
      </Field>
      {f.action === 'SetPriority' && (
        <Field label="Priority"><Select className="select" value={f.actionPriority ?? 'High'} onChange={(e) => set('actionPriority', e.target.value)}><PriorityOptions /></Select></Field>
      )}
      {f.action === 'MoveToStatus' && (
        <Field label="Status"><Select className="select" value={f.actionStatusId ?? ''} onChange={(e) => set('actionStatusId', e.target.value || null)}>
          <option value="">Choose…</option>{sorted.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
      )}
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
          <textarea className="textarea" rows={3} maxLength={500} value={f.actionText ?? ''} onChange={(e) => set('actionText', e.target.value)} />
        </Field>
      )}
    </Modal>
  );
}
