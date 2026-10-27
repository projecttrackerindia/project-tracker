import type { AutomationCondition, AutomationConditionField, AutomationDraft, AutomationInput, AutomationRule, AutomationStep, AutomationTrigger, StatusCategory } from '../../api/types';

/** What a rule acts on: Desk tickets (operational work) or project tasks. */
export type Subject = 'ticket' | 'task';

/** The builder's state: a workspace rule as When / If / Then. */
export interface Flow {
  name: string;
  isEnabled: boolean;
  isDraft: boolean;
  trigger: AutomationTrigger;
  triggerDays: number;
  whenPriority: string | null;
  whenStatusCategory: StatusCategory | null;
  conditions: AutomationCondition[];
  steps: AutomationStep[];
}

/** Only the triggers the rule engine runs. */
export const TRIGGER_LABEL: Record<AutomationTrigger, string> = {
  TicketCreated: 'A Desk ticket is created',
  TicketChanged: 'A Desk ticket is created or updated',
  TaskCreated: 'A task is created',
  StatusChanged: 'A task changes status',
  PriorityChanged: 'A task’s priority changes',
  DueSoon: 'An open task is due soon (scheduled)',
  Overdue: 'An open task is overdue (scheduled)',
  Stale: 'An open task has not changed for a while (scheduled)',
};

/** The "is …" part of the When sentence, per subject. */
export const EVENTS: Record<Subject, { id: AutomationTrigger; label: string }[]> = {
  ticket: [{ id: 'TicketCreated', label: 'created' }, { id: 'TicketChanged', label: 'created or updated' }],
  task: [
    { id: 'TaskCreated', label: 'created' }, { id: 'StatusChanged', label: 'moved to a status' }, { id: 'PriorityChanged', label: 'given a priority' },
    { id: 'DueSoon', label: 'due soon' }, { id: 'Overdue', label: 'overdue' }, { id: 'Stale', label: 'left unchanged' },
  ],
};

export const isScheduled = (t: AutomationTrigger) => t === 'DueSoon' || t === 'Overdue' || t === 'Stale';
export const subjectOf = (t: AutomationTrigger): Subject => (t === 'TicketCreated' || t === 'TicketChanged' ? 'ticket' : 'task');

/** The conditions offered, per subject (each can be used once; all must hold). */
export const CONDITIONS: { field: AutomationConditionField; label: string; ticketOnly?: boolean }[] = [
  { field: 'priority', label: 'Priority is…' },
  { field: 'status', label: 'Status is…' },
  { field: 'unassigned', label: 'Nobody is assigned' },
  { field: 'noReply', label: 'No agent has replied for…', ticketOnly: true },
  { field: 'businessHours', label: 'Within business hours' },
];

export const TICKET_STATUSES = [
  { id: 'ToDo', label: 'To Do' }, { id: 'InProgress', label: 'In Progress' }, { id: 'OnHold', label: 'On Hold' }, { id: 'Completed', label: 'Completed' }, { id: 'Cancelled', label: 'Cancelled' },
];
export const TASK_CATEGORIES: { id: StatusCategory; label: string }[] = [
  { id: 'Todo', label: 'to do' }, { id: 'Active', label: 'in progress' }, { id: 'Done', label: 'done' }, { id: 'Cancelled', label: 'cancelled' },
];

export const newCondition = (field: AutomationConditionField, subject: Subject): AutomationCondition => ({
  field,
  value: field === 'priority' ? 'Critical' : field === 'status' ? (subject === 'ticket' ? 'ToDo' : 'Todo') : null,
  minutes: field === 'noReply' ? 30 : null,
});

export const step = (p: Partial<AutomationStep>): AutomationStep => ({
  action: 'Notify', actionPriority: null, actionStatusId: null, actionStatusCategory: null, actionLabelId: null, actionTarget: 'Assignee', actionUserId: null, actionText: null,
  actionConversationId: null, ...p,
});

export const emptyFlow = (): Flow => ({
  name: '', isEnabled: true, isDraft: false, trigger: 'TicketCreated', triggerDays: 0, whenPriority: null, whenStatusCategory: null, conditions: [], steps: [step({})],
});

const stepOf = (s: AutomationStep): AutomationStep => step({
  action: s.action, actionPriority: s.actionPriority, actionStatusId: s.actionStatusId, actionStatusCategory: s.actionStatusCategory, actionLabelId: s.actionLabelId,
  actionTarget: s.actionTarget, actionUserId: s.actionUserId, actionText: s.actionText, actionConversationId: s.actionConversationId ?? null,
});

export const ruleToFlow = (r: AutomationRule): Flow => ({
  name: r.name, isEnabled: r.isEnabled, isDraft: !!r.isDraft, trigger: r.trigger, triggerDays: r.triggerDays ?? (r.trigger === 'Stale' ? 1 : 0), whenPriority: r.whenPriority,
  whenStatusCategory: r.whenStatusCategory, conditions: (r.conditions ?? []).map((c) => ({ ...c })), steps: [stepOf(r), ...r.moreActions.map(stepOf)],
});

/** The flow as the rules API takes it: conditions only where the trigger has them, the first step in the rule's own fields. */
export function flowToInput(f: Flow): AutomationInput {
  const [first, ...more] = f.steps.map((s) => ({ ...s, actionText: s.actionText?.trim() || null }));
  const ticket = subjectOf(f.trigger) === 'ticket';
  return {
    name: f.name.trim(), isEnabled: f.isEnabled && !f.isDraft, isDraft: f.isDraft, trigger: f.trigger, whenStatusId: null,
    whenStatusCategory: f.trigger === 'StatusChanged' ? f.whenStatusCategory : null,
    whenPriority: f.trigger === 'PriorityChanged' ? f.whenPriority : null,
    triggerDays: isScheduled(f.trigger) ? f.triggerDays : null,
    conditions: f.conditions.filter((c) => ticket || c.field !== 'noReply'),
    ...(first ?? step({})), moreActions: more,
  };
}

export function draftToFlow(d: AutomationDraft): Flow {
  return {
    name: d.name, isEnabled: true, isDraft: true, trigger: d.trigger, triggerDays: d.triggerDays ?? (d.trigger === 'Stale' ? 1 : 0), whenPriority: d.whenPriority,
    whenStatusCategory: d.whenStatusCategory, conditions: [],
    steps: d.steps.map((s) => step({
      action: s.action, actionPriority: s.action === 'SetPriority' ? s.priority ?? 'High' : null, actionStatusCategory: s.action === 'MoveToStatus' ? s.statusCategory : null,
      actionTarget: s.target ?? (s.action === 'SetAssignee' ? 'Reporter' : 'Assignee'), actionUserId: s.userId, actionText: s.text,
    })),
  };
}

/**
 * Recipes: the ones the engine can run start a flow (saved as a draft until turned on); the built-in ones say where that feature lives.
 * Icons and colours follow the design: red page, blue mail, purple flag, green loop, indigo clock.
 */
export const RECIPES: { id: string; name: string; text: string; icon: string; color: string; flow?: () => Flow; builtIn?: { text: string; to: string } }[] = [
  {
    id: 'oncall', name: 'Page on-call for outages', text: 'When a critical ticket comes in, page the on-call lead and tell the incidents channel', icon: '!', color: '#ff3b30',
    flow: () => ({ ...emptyFlow(), isDraft: true, name: 'Page on-call for outages', trigger: 'TicketCreated',
      conditions: [{ field: 'priority', value: 'Critical', minutes: null }],
      steps: [step({ action: 'SetAssignee', actionTarget: 'User' }), step({ action: 'PostToChannel', actionText: 'Critical ticket — on-call is paged.' })] }),
  },
  {
    id: 'mail', name: 'Mail becomes a ticket', text: 'Built in: the Mail agent turns customer mail into tickets', icon: '✉︎', color: '#0a84ff',
    builtIn: { text: 'Set it in Settings › AI', to: '/settings/ai' },
  },
  {
    id: 'bug', name: 'Failed test files a bug', text: 'Built in: “File bug” on a failed test case raises a ticket', icon: '⚑', color: '#af52de',
    builtIn: { text: 'Open Quality', to: '/quality' },
  },
  {
    id: 'close', name: 'Close resolved after 3 days', text: 'When an open task has had no change for 3 days, close it with a note', icon: '↻', color: '#28cd41',
    flow: () => ({ ...emptyFlow(), isDraft: true, name: 'Close resolved after 3 days', trigger: 'Stale', triggerDays: 3,
      steps: [step({ action: 'MoveToStatus', actionStatusCategory: 'Done' }), step({ action: 'AddComment', actionText: 'Closed after 3 days without a reply. Reopen it if it still needs work.' })] }),
  },
  {
    id: 'report', name: 'Friday status report', text: 'Built in: each project drafts its weekly report for the manager to approve and send', icon: '◷', color: '#5856d6',
    builtIn: { text: 'Open Projects', to: '/projects' },
  },
];
