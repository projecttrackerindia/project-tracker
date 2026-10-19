import { get, post, put } from './client';
import type {
  AgentApproveEdits, AgentAuditEntry, AgentCommitment, AgentDecision, AgentDelegation, AgentFinding, AgentFindingKind, AgentFindingPage, AgentImpact, AgentInboxOptIn,
  AgentPersonalSettings, AgentRun, AgentWorkspace, CheckInAnswer, CommandCenter, MeetingBrief, MyMeeting, ProjectAgent, WhatIfTask,
} from './types';

/** Anything left out keeps its value; an empty string clears a text setting. */
export interface AgentSettingsPatch {
  readMailbox?: boolean; readChat?: boolean; readMeetings?: boolean; liveBot?: boolean; dailyUpdates?: boolean;
  instructions?: string; speakerAliases?: string; captionLanguage?: string; autoJoinCalendar?: boolean; sendMinutes?: boolean;
  slackChannelId?: string; readWhatsApp?: boolean;
  autonomyLevel?: number; autoApplyConfidence?: number; autoApplyKinds?: AgentFindingKind[]; followUps?: boolean; meetingBriefs?: boolean;
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
  /** E-mails the minutes (MOM) of a meeting the agent read, with the transcript, to the people in it - in the caller's name. */
  sendMinutes: (projectId: string, runId: string) => post<{ sent: number }>(`/projects/${projectId}/agent/runs/${runId}/minutes`),
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

/** The agent as a delegate: the Command Center, commitments and check-ins, sending it to a meeting, briefs, impact, decisions and the audit trail. */
export const delegateApi = {
  commandCenter: () => get<CommandCenter>('/agent/command-center'),
  settings: () => get<AgentPersonalSettings>('/agent/me/settings'),
  saveSettings: (b: Partial<Omit<AgentPersonalSettings, 'googleConnected'>>) => put<AgentPersonalSettings>('/agent/me/settings', b),
  myCommitments: () => get<AgentCommitment[]>('/agent/commitments/mine'),
  commitment: (id: string) => get<AgentCommitment>(`/agent/commitments/${id}`),
  checkIn: (id: string, b: { answer: CheckInAnswer; note?: string; newDate?: string }) => post<AgentCommitment>(`/agent/commitments/${id}/check-in`, b),
  meetings: (hours = 24 * 7) => get<MyMeeting[]>('/agent/meetings', { hours }),
  delegations: () => get<AgentDelegation[]>('/agent/delegations'),
  delegation: (id: string) => get<AgentDelegation>(`/agent/delegations/${id}`),
  delegate: (b: { meetingId: string; sessionStartUtc: string; instructions?: string }) => post<AgentDelegation>('/agent/delegations', b),
  cancelDelegation: (id: string) => post<AgentDelegation>(`/agent/delegations/${id}/cancel`),
  brief: (meetingId: string, at?: string | null) => get<MeetingBrief>(`/agent/meetings/${meetingId}/brief`, at ? { at } : undefined),
  findingImpact: (id: string) => get<AgentImpact | null>(`/agent/findings/${id}/impact`),
  whatIf: (b: { taskId: string; newDue?: string; slipDays?: number }) => post<AgentImpact>('/agent/what-if', b),
  whatIfTasks: (projectId: string) => get<WhatIfTask[]>(`/agent/what-if/projects/${projectId}/tasks`),
  decisions: (q?: { projectId?: string; q?: string }) => get<AgentDecision[]>('/agent/decisions', q),
  audit: (projectId?: string) => get<AgentAuditEntry[]>('/agent/audit', projectId ? { projectId } : undefined),
};
