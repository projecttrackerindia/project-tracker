import { get, post } from '../../api/client';

/** What a row asks for. With an endpoint it is done in place (POST); otherwise the row's href is opened. */
export interface InboxAction { label: string; verb: string; endpoint: string | null }
export type InboxKind = 'ticket' | 'task' | 'decision' | 'approval' | 'access' | 'review' | 'mention' | 'reminder';
export type InboxGroup = 'assigned' | 'decisions' | 'mentions';
export type InboxFilter = 'all' | InboxGroup;
export interface InboxRow { id: string; kind: InboxKind; group: InboxGroup; title: string; sub: string; action: InboxAction; href: string | null; at: string; urgent: boolean }
export interface Inbox { rows: InboxRow[]; counts: { all: number; assigned: number; decisions: number; mentions: number }; later: number }
export interface InboxBriefing {
  count: number; headline: string; reasons: string[]; sources: string;
  stats: { overdue: number; dueToday: number; decisions: number; approvals: number; mentions: number; reminders: number };
}

export const inboxApi = {
  list: (filter: InboxFilter = 'all') => get<Inbox>('/inbox', { filter }),
  briefing: () => get<InboxBriefing>('/inbox/briefing'),
  later: (id: string) => post(`/inbox/${encodeURIComponent(id)}/later`),
  /** Runs a row's own action on the endpoint that already does it (approve a timesheet, accept a proposal, finish a reminder). */
  act: (row: InboxRow) => post(row.action.endpoint!.replace(/^\/api\/v1/, ''), row.kind === 'approval' || row.kind === 'access' ? { note: null } : undefined),
};

/** The label shown in each row's coloured tag. */
export const KIND_LABEL: Record<InboxKind, string> = {
  ticket: 'Ticket', task: 'Task', decision: 'Decision', approval: 'Approval', access: 'Access', review: 'Review', mention: 'Mention', reminder: 'Reminder',
};
