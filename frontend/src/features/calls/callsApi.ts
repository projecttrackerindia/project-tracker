import { get, post } from '../../api/client';

export interface CallsStatus { available: boolean; maxParticipants: number }
export interface CallPerson { userId: string; name: string; role: 'host' | 'member'; inCall: boolean; joinedAt: string | null }
export interface Call {
  id: string; title: string; kind: 'project' | 'chat' | 'adhoc'; projectId: string | null; projectKey: string | null; conversationId: string | null;
  status: 'live' | 'ended'; startedAt: string; endedAt: string | null; startedBy: string; startedByName: string;
  agentEnabled: boolean; agentStatus: string | null; canEnd: boolean; people: CallPerson[];
}
export interface CallJoin { callId: string; url: string; token: string; room: string; identity: string; title: string; agentEnabled: boolean; expiresAt: string }
export interface StartCall { title?: string; projectId?: string | null; meetingId?: string | null; conversationId?: string | null; invite?: string[]; agent?: boolean }

/** The project agent joins with an identity of its own kind, so everyone's screen can mark it. */
export const isAgent = (identity: string) => identity.startsWith('agent:');

export const callsApi = {
  status: () => get<CallsStatus>('/calls/status'),
  live: () => get<Call[]>('/calls/live'),
  start: (b: StartCall) => post<Call>('/calls', b),
  get: (id: string) => get<Call>(`/calls/${id}`),
  join: (id: string) => post<CallJoin>(`/calls/${id}/join`),
  end: (id: string) => post<Call>(`/calls/${id}/end`),
  /** Turns down a call that is ringing for you (it stops ringing on your other devices; the caller is told). */
  decline: (id: string) => post<void>(`/calls/${id}/decline`),
  /** A meeting held as a Project Tracker call: joins its live call, or starts it (inviting the meeting's people, with the agent if it is on). */
  openMeeting: (meetingId: string, workspace = false) => post<Call>(`/calls/meeting/${workspace ? 'w/' : ''}${meetingId}`),
};
