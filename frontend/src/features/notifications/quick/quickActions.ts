import { post } from '../../../api/client';
import type { AppNotification } from '../../../api/types';
import { quickActionsOn } from './quickPref';

/**
 * Quick actions: the buttons a notice carries in its banner, the desktop app, the phone apps and Web Push. Mirrors the server's QuickActions.For
 * (it decides the buttons on pushes); whether the action is still possible is checked by the server when it is pressed.
 */
export type QuickAction = 'approve' | 'reject' | 'reply' | 'read' | 'done' | 'snooze' | 'open' | 'join' | 'late' | 'accept' | 'decline' | 'maybe'
  | 'review' | 'discuss' | 'callback' | 'message' | 'answer';

export const QUICK_LABEL: Record<QuickAction, string> = {
  approve: 'Approve', reject: 'Reject', reply: 'Reply', read: 'Mark read', done: 'Done', snooze: 'Snooze 1h', open: 'Open', join: 'Join',
  late: 'Running late', accept: 'Accept', decline: 'Decline', maybe: 'Maybe', review: 'Review', discuss: 'Discuss', callback: 'Call back',
  message: 'Message', answer: 'Answer',
};

/** Actions that finish in the app: the notice is read and the app opens where it points. */
export const OPENS: ReadonlySet<QuickAction> = new Set(['open', 'join', 'review', 'discuss', 'callback', 'message', 'answer']);
/** Actions that need a few words first. */
export const NEEDS_TEXT: ReadonlySet<QuickAction> = new Set(['reply', 'reject']);

const TASK = /^\/projects\/[0-9a-fA-F-]{36}\?task=[0-9a-fA-F-]{36}/;
const CHAT = /^\/(chat\/[0-9a-fA-F-]{36}$|projects\/[0-9a-fA-F-]{36}\?chat=1$)/;
const outcome = (t: string) => /^(Approved|Rejected|Expired|Sent back)/.test(t);

export function quickActionsFor(n: Pick<AppNotification, 'type' | 'link' | 'title'>): QuickAction[] {
  const link = n.link ?? '', title = n.title ?? '';
  if (link.startsWith('/r/')) return [];
  if (/ extended/i.test(title) || /^Date extension/i.test(title)) return ['accept', 'discuss'];
  switch (n.type as string) {
    case 'Approval': return link.startsWith('/approvals?open=') && !outcome(title) ? ['approve', 'reject'] : [];
    case 'Document': return link.startsWith('/documents/') && !outcome(title) ? ['approve', 'reject'] : [];
    case 'TimesheetReminder': return link.startsWith('/timesheet/approvals') ? ['approve', 'reject'] : [];
    case 'Message': return CHAT.test(link) ? ['reply', 'read'] : [];
    case 'Mention': return CHAT.test(link) || TASK.test(link) ? ['reply', 'read'] : [];
    case 'Comment': return TASK.test(link) ? ['reply', 'read'] : [];
    case 'TaskAssigned': case 'DueSoon': case 'Overdue': case 'Nudge': return TASK.test(link) ? ['done', 'snooze', 'open'] : [];
    case 'Reminder': return /^Starts in \d{1,3} minutes?/.test(title) ? ['join', 'late'] : ['done', 'snooze'];
    case 'Meeting':
      if (title.includes('invited you') || title.startsWith('You were invited')) return ['accept', 'decline', 'maybe'];
      if (title.startsWith('Minutes') || /action item/i.test(title)) return ['review'];
      return [];
    case 'Call': return /^Missed call/i.test(title) ? ['callback', 'message'] : ['answer', 'decline', 'message'];
    default: return [];
  }
}

/** Only urgent notices get prominent buttons (smart priority, PR #147); older servers send no priority and keep them. */
export const showsQuickActions = (n: AppNotification & { priority?: 'urgent' | 'normal' }) => quickActionsOn() && n.priority !== 'normal' && quickActionsFor(n).length > 0;

export interface QuickResult { message: string; alreadyDone: boolean; open: string | null }
export const pressQuick = (id: string, action: QuickAction, text?: string) =>
  post<QuickResult>(`/notifications/${id}/quick`, { action, text: text || undefined, preset: action === 'snooze' ? '1h' : undefined });
