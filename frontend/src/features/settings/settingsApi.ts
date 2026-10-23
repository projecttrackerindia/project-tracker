import { del, get, post, put } from '../../api/client';

export interface SetupFix { label: string; to: string }
export interface SetupCheck {
  id: string; title: string; detail: string; severity: 'high' | 'medium' | 'low'; ok: boolean; dismissed: boolean; dismissReason: string | null;
  fix: SetupFix | null; action: string | null; actionLabel: string | null; canDismiss: boolean;
}
export interface SetupHealth { score: number; done: number; total: number; open: number; checks: SetupCheck[] }

export interface SettingChange {
  key: string; section: string; setting: string; summary: string; action: string; at: string; byId: string | null; byName: string | null; auditId: string;
  canUndo: boolean; undoTo: string | null; undoBlocked: string | null; wasUndo: boolean;
}
export interface SettingChanges { items: SettingChange[]; canUndo: boolean }
export interface UndoResult { key: string; message: string; latest: SettingChange | null }

export interface ImpactRequest {
  kind: 'security' | 'retention';
  requireMfa?: boolean; ipAllowlistEnabled?: boolean; ipRanges?: string[]; minPasswordLength?: number; sessionHours?: number; allowedSignIn?: string[];
  activityRetentionDays?: number | null; notificationRetentionDays?: number | null; chatRetentionDays?: number | null; auditRetentionDays?: number | null;
}
export interface ImpactPerson { userId: string; name: string; email: string; role: string; reasons: string[] }
export interface ImpactRecords { label: string; count: number; before: string }
export interface SettingImpact {
  kind: string; headline: string; people: number; affected: ImpactPerson[]; records: ImpactRecords[]; includesYou: boolean; warning: string | null; enforced: boolean; changes: string[];
}

export interface ChannelSet { inApp: boolean; email: boolean; browser: boolean }
export interface NotificationDefaultKind {
  type: string; label: string; description: string; locked: boolean; needsYou: boolean; platform: ChannelSet; workspace: ChannelSet; changed: boolean; following: number; choseOwn: number;
}
export interface NotificationDefaults {
  kinds: NotificationDefaultKind[]; quietCustom: boolean; quietStart: string | null; quietEnd: string | null; digestCustom: boolean; digestTime: string | null;
  members: number; membersWithOwnSchedule: number; platformQuiet: string; canEdit: boolean; updatedAt: string | null;
}
export interface SaveNotificationDefaults {
  kinds: { type: string; inApp: boolean; email: boolean; browser: boolean }[]; quietCustom: boolean; quietStart: string | null; quietEnd: string | null;
  digestCustom: boolean; digestTime: string | null;
}

export const settingsApi = {
  health: () => get<SetupHealth>('/settings/health'),
  dismiss: (id: string, reason?: string) => post<SetupHealth>(`/settings/health/${id}/dismiss`, { reason: reason ?? null }),
  restore: (id: string) => del<SetupHealth>(`/settings/health/${id}/dismiss`),
  remindTwoStep: () => post<{ sent: number }>('/settings/health/two-step/remind'),
  changes: (section?: string) => get<SettingChanges>('/settings/changes', section ? { section } : undefined),
  recent: (take = 12) => get<SettingChanges>('/settings/changes/recent', { take: String(take) }),
  undo: (auditId: string, key: string) => post<UndoResult>(`/settings/changes/${auditId}/undo`, { key }),
  impact: (req: ImpactRequest) => post<SettingImpact>('/settings/impact', req),
  notificationDefaults: () => get<NotificationDefaults>('/settings/notification-defaults'),
  saveNotificationDefaults: (b: SaveNotificationDefaults) => put<NotificationDefaults>('/settings/notification-defaults', b),
};
