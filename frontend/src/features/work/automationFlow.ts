import type { AutomationDraft, AutomationInput, AutomationRule, AutomationStep, AutomationTrigger, StatusCategory } from '../../api/types';

/** The builder's state: a workspace rule as When / If / Then. */
export interface Flow {
  name: string;
  isEnabled: boolean;
  trigger: AutomationTrigger;
  triggerDays: number;
  whenPriority: string | null;
  whenStatusCategory: StatusCategory | null;
  steps: AutomationStep[];
}

/** Only the triggers the rule engine runs. */
export const TRIGGER_LABEL: Record<AutomationTrigger, string> = {
  TaskCreated: 'A task is created',
  StatusChanged: 'A task changes status',
  PriorityChanged: 'A task’s priority changes',
  DueSoon: 'An open task is due soon (scheduled)',
  Overdue: 'An open task is overdue (scheduled)',
  Stale: 'An open task has not changed for a while (scheduled)',
};

export const isScheduled = (t: AutomationTrigger) => t === 'DueSoon' || t === 'Overdue' || t === 'Stale';

export const step = (p: Partial<AutomationStep>): AutomationStep => ({
  action: 'Notify', actionPriority: null, actionStatusId: null, actionStatusCategory: null, actionLabelId: null, actionTarget: 'Assignee', actionUserId: null, actionText: null, ...p,
});

export const emptyFlow = (): Flow => ({ name: '', isEnabled: true, trigger: 'Overdue', triggerDays: 0, whenPriority: null, whenStatusCategory: null, steps: [step({})] });

const stepOf = (s: AutomationStep): AutomationStep => step({
  action: s.action, actionPriority: s.actionPriority, actionStatusId: s.actionStatusId, actionStatusCategory: s.actionStatusCategory, actionLabelId: s.actionLabelId,
  actionTarget: s.actionTarget, actionUserId: s.actionUserId, actionText: s.actionText,
});

export const ruleToFlow = (r: AutomationRule): Flow => ({
  name: r.name, isEnabled: r.isEnabled, trigger: r.trigger, triggerDays: r.triggerDays ?? (r.trigger === 'Stale' ? 1 : 0), whenPriority: r.whenPriority,
  whenStatusCategory: r.whenStatusCategory, steps: [stepOf(r), ...r.moreActions.map(stepOf)],
});

/** The flow as the rules API takes it: conditions only where the trigger has them, the first step in the rule's own fields. */
export function flowToInput(f: Flow): AutomationInput {
  const [first, ...more] = f.steps.map((s) => ({ ...s, actionText: s.actionText?.trim() || null }));
  return {
    name: f.name.trim(), isEnabled: f.isEnabled, trigger: f.trigger, whenStatusId: null,
    whenStatusCategory: f.trigger === 'StatusChanged' ? f.whenStatusCategory : null,
    whenPriority: f.trigger === 'PriorityChanged' ? f.whenPriority : null,
    triggerDays: isScheduled(f.trigger) ? f.triggerDays : null,
    ...(first ?? step({})), moreActions: more,
  };
}

export function draftToFlow(d: AutomationDraft): Flow {
  return {
    name: d.name, isEnabled: true, trigger: d.trigger, triggerDays: d.triggerDays ?? (d.trigger === 'Stale' ? 1 : 0), whenPriority: d.whenPriority, whenStatusCategory: d.whenStatusCategory,
    steps: d.steps.map((s) => step({
      action: s.action, actionPriority: s.action === 'SetPriority' ? s.priority ?? 'High' : null, actionStatusCategory: s.action === 'MoveToStatus' ? s.statusCategory : null,
      actionTarget: s.target ?? (s.action === 'SetAssignee' ? 'Reporter' : 'Assignee'), actionUserId: s.userId, actionText: s.text,
    })),
  };
}

/** Templates: the ones the engine can run start a flow; the others say where the built-in feature lives. */
export const TEMPLATES: { id: string; name: string; text: string; flow?: () => Flow }[] = [
  {
    id: 'sla', name: 'SLA escalation', text: 'A day past due: raise to High and tell the owner to escalate.',
    flow: () => ({ ...emptyFlow(), name: 'SLA escalation', trigger: 'Overdue', triggerDays: 1,
      steps: [step({ action: 'SetPriority', actionPriority: 'High' }), step({ action: 'Notify', actionTarget: 'Assignee', actionText: 'A day past its target. Escalate it or agree a new date.' })] }),
  },
  {
    id: 'overdue', name: 'Overdue nudge', text: 'Nudge the owner the day a task becomes overdue.',
    flow: () => ({ ...emptyFlow(), name: 'Overdue nudge', trigger: 'Overdue', triggerDays: 0,
      steps: [step({ action: 'Notify', actionTarget: 'Assignee', actionText: 'This is overdue. Update it, or move the date if it still matters.' })] }),
  },
  {
    id: 'timesheet', name: 'Timesheet missing reminder',
    text: 'Runs for everyone already: a workday with nothing logged, and last week not submitted on Monday. People switch it under Notifications.',
  },
  {
    id: 'signoff', name: 'Sign-off complete → notify', text: 'When a task moves to Done, tell the person who asked for it.',
    flow: () => ({ ...emptyFlow(), name: 'Sign-off complete', trigger: 'StatusChanged', whenStatusCategory: 'Done',
      steps: [step({ action: 'Notify', actionTarget: 'Reporter', actionText: 'Signed off and done.' })] }),
  },
];
