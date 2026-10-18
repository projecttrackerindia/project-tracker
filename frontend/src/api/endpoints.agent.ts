import { get, post, put } from './client';
import type { AgentApproveEdits, AgentFinding, AgentFindingPage, AgentInboxOptIn, AgentRun, AgentWorkspace, ProjectAgent } from './types';

/** Anything left out keeps its value; an empty string clears a text setting. */
export interface AgentSettingsPatch {
  readMailbox?: boolean; readChat?: boolean; readMeetings?: boolean; liveBot?: boolean; dailyUpdates?: boolean;
  instructions?: string; speakerAliases?: string; captionLanguage?: string; autoJoinCalendar?: boolean; sendMinutes?: boolean;
  slackChannelId?: string; readWhatsApp?: boolean;
}

/** The languages Meet captions in, as the agent's settings offer them. */
export const CAPTION_LANGUAGES: [string, string][] = [
  ['en', 'English'], ['hi', 'Hindi'], ['bn', 'Bengali'], ['gu', 'Gujarati'], ['kn', 'Kannada'], ['ml', 'Malayalam'], ['mr', 'Marathi'], ['ta', 'Tamil'],
  ['te', 'Telugu'], ['ur', 'Urdu'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['it', 'Italian'], ['nl', 'Dutch'],
  ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['ar', 'Arabic'], ['ru', 'Russian'], ['id', 'Indonesian'], ['th', 'Thai'], ['vi', 'Vietnamese'],
  ['tr', 'Turkish'], ['pl', 'Polish'], ['sv', 'Swedish'],
];

/** The project agent: settings, sources, the review queue, the workspace's meeting bot and a person's own inbox opt-in. */
export const agentApi = {
  get: (projectId: string) => get<ProjectAgent>(`/projects/${projectId}/agent`),
  save: (projectId: string, b: AgentSettingsPatch & { enabled: boolean }) => put<ProjectAgent>(`/projects/${projectId}/agent`, b),
  resetMailbox: (projectId: string) => post<ProjectAgent>(`/projects/${projectId}/agent/mailbox/reset`),
  run: (projectId: string) => post<AgentRun | null>(`/projects/${projectId}/agent/run`),
  transcript: (projectId: string, b: { title?: string; text: string; meetingId?: string }) => post<{ signalId: string; run: AgentRun | null }>(`/projects/${projectId}/agent/transcript`, b),
  findings: (projectId: string, status = 'proposed') => get<AgentFindingPage>(`/projects/${projectId}/agent/findings`, { status }),
  approveAll: (projectId: string) => post<{ applied: number; failed: number; skipped: number; items: AgentFinding[] }>(`/projects/${projectId}/agent/findings/approve-all`),
  inbox: () => get<AgentFindingPage>('/agent/inbox'),
  approve: (id: string, edits?: AgentApproveEdits) => post<AgentFinding>(`/agent/findings/${id}/approve`, edits ?? {}),
  dismiss: (id: string) => post<AgentFinding>(`/agent/findings/${id}/dismiss`),
  /** Work the agent gave me, to accept or to say it is not mine. */
  assigned: () => get<AgentFindingPage>('/agent/assigned'),
  respond: (id: string, b: { response: 'accepted' | 'declined'; note?: string }) => post<AgentFinding>(`/agent/findings/${id}/respond`, b),
  workspace: () => get<AgentWorkspace>('/agent/workspace'),
  saveWorkspace: (b: { botName?: string; inCallReminders?: boolean }) => put<AgentWorkspace>('/agent/workspace', b),
  myInbox: () => get<AgentInboxOptIn>('/agent/my-inbox'),
  saveMyInbox: (b: { provider?: 'google' | 'microsoft'; enabled: boolean }) => put<AgentInboxOptIn>('/agent/my-inbox', b),
};
