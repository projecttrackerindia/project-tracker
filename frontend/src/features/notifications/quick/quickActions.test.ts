import { describe, expect, it } from 'vitest';
import { quickActionsFor, showsQuickActions } from './quickActions';
import type { AppNotification } from '../../../api/types';

const id = '11111111-1111-1111-1111-111111111111';
const n = (type: string, title: string, link: string | null) => ({ id: 'n', type, title, link, body: null, isRead: false, createdAt: '', browser: true }) as unknown as AppNotification;

describe('quick actions', () => {
  it('matches the server rules for each kind of notice', () => {
    expect(quickActionsFor(n('Approval', 'Leave request', `/approvals?open=${id}`))).toEqual(['approve', 'reject']);
    expect(quickActionsFor(n('Approval', 'Approved: Leave request', `/approvals?open=${id}`))).toEqual([]);
    expect(quickActionsFor(n('Message', 'Asha', `/chat/${id}`))).toEqual(['reply', 'read']);
    expect(quickActionsFor(n('TaskAssigned', 'You were assigned', `/projects/${id}?task=${id}`))).toEqual(['done', 'snooze', 'open']);
    expect(quickActionsFor(n('Reminder', 'Starts in 5 minutes: Standup', `/calls/meeting/w/${id}`))).toEqual(['join', 'late']);
    expect(quickActionsFor(n('Meeting', 'Asha invited you to a call', `/calls/meeting/${id}`))).toEqual(['accept', 'decline', 'maybe']);
    expect(quickActionsFor(n('Call', 'Missed call from Ravi', '/calls/x'))).toEqual(['callback', 'message']);
    expect(quickActionsFor(n('Reminder', 'Renew', '/r/abc'))).toEqual([]);
  });
  it('keeps normal-priority notices quiet', () => {
    const a = n('Approval', 'Leave request', `/approvals?open=${id}`);
    expect(showsQuickActions(a)).toBe(true);
    expect(showsQuickActions({ ...a, priority: 'normal' } as never)).toBe(false);
  });
});
