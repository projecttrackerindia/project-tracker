// Desk omnichannel (phase 1): Integrations settings, engineers' availability, the inbound queue, each ticket's routing and voice intake.
// Keys are write-only: the server only says whether one is set.
import { fetchBlobUrl, get, post, postForm, put } from './client';
import type { Priority, UserRef } from './types';

export type EngineerStatus = 'available' | 'busy' | 'away' | 'offline';

export interface DeskSettings {
  intakeEnabled: boolean; autoAcknowledge: boolean; autoCreateTicket: boolean; ackMessage: string;
  routingEnabled: boolean; confidenceThreshold: number; acceptMinutes: number; maxReassignments: number; supervisor: UserRef | null; notifyOnWhatsApp: boolean;
  voiceEnabled: boolean; hasSarvamKey: boolean; sarvamFromServer: boolean; voiceLanguages: string[]; consentPrompt: string; recordCalls: boolean; retentionDays: number;
  telephonyProvider: string; hasTelephonyKey: boolean; telephonyReady: boolean; whatsAppNumbers: number; canManage: boolean;
}
export interface SaveDeskSettings {
  intakeEnabled: boolean; autoAcknowledge: boolean; autoCreateTicket: boolean; ackMessage: string | null; routingEnabled: boolean; confidenceThreshold: number;
  acceptMinutes: number; maxReassignments: number; supervisorId: string | null; notifyOnWhatsApp: boolean; voiceEnabled: boolean;
  /** null keeps the saved key, '' removes it. */
  sarvamApiKey: string | null; voiceLanguages: string[]; consentPrompt: string | null; recordCalls: boolean; retentionDays: number; telephonyProvider: string; telephonyKey: string | null;
}
export interface DeskEngineer {
  userId: string; name: string; status: EngineerStatus; statusChangedAt: string | null; skills: string[]; department: string; maxActive: number;
  shiftStartMinutes: number | null; shiftEndMinutes: number | null; onCall: boolean; active: number; configured: boolean;
}
export interface DeskQueueItem { id: string; provider: string; messageType: string; status: string; attempts: number; createdAt: string; nextAttemptAt: string; lastError: string | null; workTaskId: string | null }
export interface DeskQueue { pending: number; done: number; dead: number; recent: DeskQueueItem[] }

export interface DeskInsight {
  channel: string; category: string; priority: Priority; department: string; skills: string[]; confidence: number; summary: string; source: 'ai' | 'rules';
  needsReview: boolean; reviewedBy: UserRef | null; reviewedAt: string | null; contact: UserRef | null; organization: string | null;
}
export interface DeskAssignment {
  id: string; assignee: UserRef | null; method: 'auto' | 'manual' | 'override' | 'escalated' | 'review' | 'existing'; reason: string; score: number; assignedAt: string;
  acceptDueAt: string | null; acceptedAt: string | null; reassignments: number; escalatedAt: string | null; active: boolean; assignedBy: UserRef | null;
}
export interface DeskRanked { userId: string; name: string; score: number; reason: string }
export interface DeskRouting {
  workTaskId: string; key: string; routingEnabled: boolean; threshold: number; insight: DeskInsight | null; current: DeskAssignment | null; history: DeskAssignment[];
  candidates: DeskRanked[]; responseDueAt: string | null; resolutionDueAt: string | null; canOverride: boolean; canAccept: boolean;
}
export interface WhatsAppMessage { from: 'contact' | 'ai' | 'agent' | 'update' | 'system'; text: string; at: string; by: string | null; media: { kind: string; id: string; mime: string | null; fileName: string | null } | null }
export interface WhatsAppThread { chat: { id: string; contact: string; contactName: string | null; language: string; canReply: boolean; mode: string }; messages: WhatsAppMessage[] }

export interface VoiceTurn { index: number; role: 'assistant' | 'caller'; text: string; at: string; hasAudio: boolean }
export interface VoiceSession {
  id: string; workTaskId: string | null; ticketKey: string | null; channel: string; language: string; status: 'consent' | 'active' | 'completed' | 'declined' | 'failed';
  consentGiven: boolean | null; consentAt: string | null; transcript: VoiceTurn[]; summary: string | null; recorded: boolean; recordingBytes: number; retainUntil: string | null;
  startedAt: string; endedAt: string | null; provider: string;
}
export interface VoiceStep { session: VoiceSession; say: string; audio: string | null; speechReady: boolean }
export interface VoiceStatus { enabled: boolean; speechReady: boolean; telephonyReady: boolean; telephonyProvider: string; languages: string[] }

/** A real object from the server (older servers and the preview mocks answer unknown paths with an empty list). */
export const isObj = <T,>(x: unknown): x is T => !!x && typeof x === 'object' && !Array.isArray(x);

export const deskAiApi = {
  settings: () => get<DeskSettings>('/desk/settings'),
  saveSettings: (b: SaveDeskSettings) => put<DeskSettings>('/desk/settings', b),
  engineers: () => get<DeskEngineer[]>('/desk/engineers'),
  saveEngineer: (userId: string, b: { status: EngineerStatus; skills: string[]; department: string; maxActive: number; shiftStartMinutes: number | null; shiftEndMinutes: number | null }) =>
    put<DeskEngineer>(`/desk/engineers/${userId}`, b),
  myStatus: (status: EngineerStatus) => post<DeskEngineer>('/desk/engineers/me/status', { status }),
  queue: () => get<DeskQueue>('/desk/queue'),
  retry: (id: string) => post<DeskQueue>(`/desk/queue/${id}/retry`),
  routing: (id: string) => get<DeskRouting>(`/desk/tickets/${id}/routing`),
  whatsapp: (id: string) => get<WhatsAppThread | null>(`/desk/tickets/${id}/whatsapp`),
  accept: (id: string) => post<DeskRouting>(`/desk/tickets/${id}/accept`),
  reassign: (id: string, userId: string | null, reason?: string) => post<DeskRouting>(`/desk/tickets/${id}/reassign`, { userId, reason: reason ?? null }),
  override: (id: string, userId: string, reason?: string) => post<DeskRouting>(`/desk/tickets/${id}/override`, { userId, reason: reason ?? null }),
  review: (id: string, approve: boolean, priority?: Priority | null) => post<DeskRouting>(`/desk/tickets/${id}/review`, { approve, category: null, priority: priority ?? null }),
  ticketVoice: (id: string) => get<VoiceSession[]>(`/desk/tickets/${id}/voice`),
  callback: (id: string, number: string) => post<VoiceSession>(`/desk/tickets/${id}/callback`, { number }),
  voiceStatus: () => get<VoiceStatus>('/desk/voice'),
  startVoice: (workTaskId: string | null, language: string) => post<VoiceStep>('/desk/voice/sessions', { workTaskId, language }),
  consent: (id: string, agree: boolean) => post<VoiceStep>(`/desk/voice/sessions/${id}/consent`, { agree }),
  say: (id: string, text: string) => post<VoiceStep>(`/desk/voice/sessions/${id}/say`, { text }),
  listen: (id: string, audio: Blob) => { const f = new FormData(); f.append('file', audio, 'turn.webm'); return postForm<VoiceStep>(`/desk/voice/sessions/${id}/listen`, f); },
  complete: (id: string) => post<VoiceSession>(`/desk/voice/sessions/${id}/complete`),
  /** A recorded turn as an object URL (fetched with the session; revoke it when done). */
  audio: (id: string, index: number) => fetchBlobUrl(`/desk/voice/sessions/${id}/audio/${index}`),
};
