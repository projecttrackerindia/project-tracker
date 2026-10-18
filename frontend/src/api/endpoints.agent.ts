import { get, post, put } from './client';
import type { AgentApproveEdits, AgentFinding, AgentFindingPage, AgentInboxOptIn, AgentRun, AgentWorkspace, ProjectAgent } from './types';

/** The project agent: settings, sources, the review queue, the workspace's meeting bot and a person's own inbox opt-in. */
export const agentApi = {
  get: (projectId: string) => get<ProjectAgent>(`/projects/${projectId}/agent`),
  save: (projectId: string, b: { enabled: boolean; readMailbox?: boolean; readChat?: boolean; readMeetings?: boolean; liveBot?: boolean; dailyUpdates?: boolean }) =>
    put<ProjectAgent>(`/projects/${projectId}/agent`, b),
  resetMailbox: (projectId: string) => post<ProjectAgent>(`/projects/${projectId}/agent/mailbox/reset`),
  run: (projectId: string) => post<AgentRun | null>(`/projects/${projectId}/agent/run`),
  transcript: (projectId: string, b: { title?: string; text: string; meetingId?: string }) => post<{ signalId: string; run: AgentRun | null }>(`/projects/${projectId}/agent/transcript`, b),
  findings: (projectId: string, status = 'proposed') => get<AgentFindingPage>(`/projects/${projectId}/agent/findings`, { status }),
  approveAll: (projectId: string) => post<{ applied: number; failed: number; items: AgentFinding[] }>(`/projects/${projectId}/agent/findings/approve-all`),
  inbox: () => get<AgentFindingPage>('/agent/inbox'),
  approve: (id: string, edits?: AgentApproveEdits) => post<AgentFinding>(`/agent/findings/${id}/approve`, edits ?? {}),
  dismiss: (id: string) => post<AgentFinding>(`/agent/findings/${id}/dismiss`),
  workspace: () => get<AgentWorkspace>('/agent/workspace'),
  saveWorkspace: (b: { recallApiKey?: string; clearRecallKey?: boolean; recallRegion?: string; botName?: string; inCallReminders?: boolean }) => put<AgentWorkspace>('/agent/workspace', b),
  myInbox: () => get<AgentInboxOptIn>('/agent/my-inbox'),
  saveMyInbox: (b: { provider?: 'google' | 'microsoft'; enabled: boolean }) => put<AgentInboxOptIn>('/agent/my-inbox', b),
};
