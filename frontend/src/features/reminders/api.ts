import { del, get, post, put } from '../../api/client';
import { deviceZone } from './time';

export type ReminderSource = 'Personal' | 'Nudge' | 'DueDate' | 'Overdue' | 'Escalation';
export type ReminderState = 'Scheduled' | 'Fired' | 'Done' | 'Cancelled';
export type ReminderTarget = 'None' | 'Task' | 'Issue' | 'ActionItem' | 'Operational' | 'Milestone' | 'ChatMessage';
interface UserRef { id: string; name: string }

export interface Reminder {
  id: string; source: ReminderSource; state: ReminderState; title: string; note: string | null;
  targetType: ReminderTarget; targetId: string | null; targetKey: string | null; targetTitle: string | null; link: string | null;
  timeZone: string; localAt: string | null; anchorDays: number | null; anchorTime: string | null; recurrence: string | null; recurrenceText: string | null;
  onlyIfOpen: boolean; exact: boolean; nextFireAt: string | null; isSnoozed: boolean; snoozeCount: number; fireCount: number; lastFiredAt: string | null; quiet: boolean;
  completedAt: string | null; seriesId: string | null; from: UserRef | null; for: UserRef | null; canEdit: boolean; createdAt: string;
}
export interface ReminderCounts { now: number; today: number; upcoming: number; completed: number }
export interface ReminderList {
  open: Reminder[]; completed: Reminder[]; sent: Reminder[]; counts: ReminderCounts;
  limits: { open: number; recurring: number; openUsed: number; recurringUsed: number };
}
export interface ReminderWhen { at?: string | null; timeZone?: string | null; anchorDays?: number | null; anchorTime?: string | null; recurrence?: string | null }
export interface SaveReminder {
  title?: string | null; note?: string | null; targetType?: ReminderTarget; targetId?: string | null; forUserId?: string | null;
  when: ReminderWhen; onlyIfOpen?: boolean; exact?: boolean;
}
export interface ReminderSettings {
  workDays: number[]; workStart: string; workEnd: string; quietStart: string | null; quietEnd: string | null; defaultTime: string;
  autoEnabled: boolean; dueLeads: number[]; overdueSteps: number[]; dailyAutoLimit: number; briefingEnabled: boolean; briefingTime: string;
  followDeviceTimeZone: boolean; muteNudges: boolean; timeZone: string;
}
export interface ReminderInsights { doneThisWeek: number; firedThisWeek: number; onTimePercent: number; usualTime: string | null; snoozedOften: Reminder[] }
export interface ReminderPolicy { available: boolean; canManage: boolean; escalationEnabled: boolean; steps: string; sentLast30Days: number; doneLast30Days: number; escalatedLast30Days: number }
export interface ReminderActionInfo {
  valid: boolean; title: string | null; note: string | null; targetKey: string | null; link: string | null; state: ReminderState | null;
  nextFireAt: string | null; isSnoozed: boolean; timeZone: string | null; workspace: string | null;
}
/** What a reminder can be about, as the screens that offer "Remind me" know it. */
export interface ReminderSubject { type: ReminderTarget; id: string; title: string; key?: string | null; due?: string | null; assigneeId?: string | null; assigneeName?: string | null }

export type SnoozePreset = '10m' | '30m' | '1h' | '3h' | 'evening' | 'tomorrow' | 'nextweek' | 'workday';

export const reminderApi = {
  list: () => get<ReminderList>('/reminders'),
  counts: () => get<ReminderCounts>('/reminders/counts'),
  forTarget: (type: ReminderTarget, id: string) => get<Reminder[]>(`/reminders/for/${type}/${id}`),
  create: (body: SaveReminder) => post<Reminder>('/reminders', body),
  update: (id: string, body: SaveReminder) => put<Reminder>(`/reminders/${id}`, body),
  snooze: (id: string, preset?: SnoozePreset, until?: string) => post<Reminder>(`/reminders/${id}/snooze`, { preset, until, timeZone: deviceZone() }),
  done: (id: string) => post<Reminder>(`/reminders/${id}/done`),
  reopen: (id: string) => post<Reminder>(`/reminders/${id}/reopen`),
  remove: (id: string) => del(`/reminders/${id}`),
  settings: () => get<ReminderSettings>('/reminders/settings'),
  saveSettings: (s: ReminderSettings) => put<ReminderSettings>('/reminders/settings', s),
  followDevice: () => put<ReminderSettings>('/reminders/time-zone', { timeZone: deviceZone() }),
  insights: () => get<ReminderInsights>('/reminders/insights'),
  policy: () => get<ReminderPolicy>('/reminders/policy'),
  savePolicy: (body: { escalationEnabled: boolean; steps: string }) => put<ReminderPolicy>('/reminders/policy', body),
  actionInfo: (token: string) => get<ReminderActionInfo>(`/reminder-actions/${encodeURIComponent(token)}`),
  act: (token: string, action: 'done' | 'snooze', preset?: SnoozePreset) => post<ReminderActionInfo>(`/reminder-actions/${encodeURIComponent(token)}`, { action, preset }),
};

export const SNOOZE_CHOICES: { id: SnoozePreset; label: string }[] = [
  { id: '10m', label: '10 minutes' }, { id: '1h', label: '1 hour' }, { id: '3h', label: '3 hours' },
  { id: 'evening', label: 'This evening (18:00)' }, { id: 'tomorrow', label: 'Tomorrow morning' }, { id: 'nextweek', label: 'Next week' },
];
