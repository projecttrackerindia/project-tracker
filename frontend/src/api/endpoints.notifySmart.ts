import { del, get, post, put } from './client';
import type { NotificationType } from './types';

/** Urgent rings and pops up; normal only adds to the quiet badge. */
export type NotificationPriority = 'urgent' | 'normal';
export interface SmartKind { type: NotificationType; label: string; priority: NotificationPriority; defaultPriority: NotificationPriority; locked: boolean }
export interface NotificationMute { id: string; scope: 'project' | 'thread'; targetId: string; label: string; until: string | null; createdAt: string }
export interface SmartSettings { grouping: boolean; groupWindowMinutes: number; kinds: SmartKind[]; mutes: NotificationMute[] }

export const smartNotifyApi = {
  get: () => get<SmartSettings>('/notifications/smart'),
  save: (body: { grouping?: boolean; groupWindowMinutes?: number; priorities?: { type: NotificationType; priority: NotificationPriority }[] }) => put<SmartSettings>('/notifications/smart', body),
  mute: (body: { scope: 'project' | 'thread'; targetId: string; label?: string; hours?: number | null }) => post<NotificationMute>('/notifications/mutes', body),
  muteFrom: (notificationId: string, scope: 'project' | 'thread', hours?: number | null) => post<NotificationMute>(`/notifications/${notificationId}/mute`, { scope, hours }),
  unmute: (id: string) => del(`/notifications/mutes/${id}`),
};

export interface ProblemReportInput { message: string; route: string; appVersion: string; console: string[]; network: string[]; screenshot?: string | null; userAgent?: string }
export interface ProblemReceipt { id: string; reference: string; emailed: boolean }
export interface ProblemReport { id: string; reference: string; reporter: { id: string; name: string } | null; message: string; route: string; appVersion: string; userAgent: string | null;
  console: string[]; network: string[]; hasScreenshot: boolean; status: 'open' | 'closed'; createdAt: string }

export const problemApi = {
  submit: (body: ProblemReportInput) => post<ProblemReceipt>('/problem-reports', body),
  list: () => get<ProblemReport[]>('/problem-reports'),
  setStatus: (id: string, status: 'open' | 'closed') => post(`/problem-reports/${id}/status`, { status }),
};

export type FlagScope = 'workspace' | 'team' | 'user';
export interface FeatureFlagRow { key: string; label: string; description: string; default: boolean; workspace: boolean | null; effective: boolean;
  overrides: { scope: 'team' | 'user'; targetId: string; name: string; enabled: boolean }[] }

export const flagApi = {
  mine: () => get<{ flags: Record<string, boolean> }>('/feature-flags/mine'),
  list: () => get<FeatureFlagRow[]>('/feature-flags'),
  set: (key: string, body: { scope: FlagScope; targetId?: string | null; enabled: boolean | null }) => put<FeatureFlagRow[]>(`/feature-flags/${key}`, body),
};
