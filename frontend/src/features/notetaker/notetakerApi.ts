import { del, get, post, put } from '../../api/client';

export interface NotetakerProject { id: string; key: string; name: string; agentReady: boolean }
export interface NotetakerSettings { projectId: string | null; autoJoin: boolean; autoMinutes: boolean; autoEmail: boolean; autoTasks: boolean; deleteTranscript: boolean }
export interface NotetakerSession {
  id: string; projectId: string; projectName: string; title: string; meetUrl: string | null; start: string; end: string; status: string; workerStatus: string | null;
  error: string | null; transcriptLength: number; hasMinutes: boolean; minutesStatus: string | null; mine: boolean; automatic: boolean;
}
export interface NotetakerOverview { settings: NotetakerSettings; projects: NotetakerProject[]; sessions: NotetakerSession[]; botReady: boolean; signedInAccount: boolean; accountName: string | null; calendarConnected: boolean; aiAvailable: boolean }
export interface MinutesContent { title: string; summary: string; attendees: string[]; discussion: string[]; decisions: string[]; actionItems: { task: string; owner: string | null; due: string | null }[]; risks: string[]; nextMeeting: string | null }
export interface Minutes { sessionId: string; projectId: string; title: string; status: string; createdAt: string; sentAt: string | null; content: MinutesContent; model: string | null }
export interface BotIdentity { id: string; email: string; displayName: string; active: boolean; cookies: number; createdAt: string; lastUsedAt: string | null; lastError: string | null; lastErrorAt: string | null }

export const notetakerApi = {
  overview: () => get<NotetakerOverview>('/me/notetaker'),
  saveSettings: (b: NotetakerSettings) => put<NotetakerSettings>('/me/notetaker/settings', b),
  join: (b: { url: string; title?: string; minutes: number; projectId?: string | null; instructions?: string }) => post<NotetakerSession>('/me/notetaker/join', b),
  stop: (id: string) => post(`/me/notetaker/sessions/${id}/stop`, {}),
  minutes: (id: string) => get<Minutes | null>(`/me/notetaker/sessions/${id}/minutes`),
  writeMinutes: (id: string) => post<Minutes>(`/me/notetaker/sessions/${id}/minutes`, {}),
  sendMinutes: (id: string, b: { account: string; to: string; cc?: string; subject: string; body: string; confirmed: boolean }) => post<Minutes>(`/me/notetaker/sessions/${id}/minutes/send`, b),
  identities: () => get<BotIdentity[]>('/admin/meeting-bots/identities'),
  saveIdentity: (b: { email: string; displayName: string; cookies: string }, id?: string) => id ? put<BotIdentity>(`/admin/meeting-bots/identities/${id}`, b) : post<BotIdentity>('/admin/meeting-bots/identities', b),
  setIdentityActive: (id: string, active: boolean) => put<BotIdentity>(`/admin/meeting-bots/identities/${id}/active`, { active }),
  removeIdentity: (id: string) => del(`/admin/meeting-bots/identities/${id}`),
};

/** The minutes as plain text for an email. */
export function minutesText(c: MinutesContent, owner: string) {
  const out: string[] = [`Minutes of meeting - ${c.title}`, ''];
  if (c.attendees.length) out.push(`Attendees: ${c.attendees.join(', ')}`, '');
  out.push('Summary', c.summary, '');
  const section = (h: string, items: string[]) => { if (items.length) out.push(h, ...items.map((i) => `• ${i}`), ''); };
  section('Discussion', c.discussion);
  section('Decisions', c.decisions);
  if (c.actionItems.length) out.push('Action items', ...c.actionItems.map((a, i) => `${i + 1}. ${a.task}${a.owner ? ` — ${a.owner}` : ''}${a.due ? ` (by ${a.due})` : ''}`), '');
  section('Risks and blockers', c.risks);
  if (c.nextMeeting) out.push(`Next meeting: ${c.nextMeeting}`, '');
  out.push('Regards,', owner);
  return out.join('\n');
}
