import { del, get, patch, post, put, streamPost, uploadFile } from '../../api/client';

// ------------------------------------------------------------------ shapes (mirror the API)

export type AiTier = 'quick' | 'standard' | 'deep';
export type AiMode = 'auto' | AiTier;

export interface AiTierInfo { id: AiTier; label: string; model: string; credits: number; allowed: boolean; description: string }
export interface AiUsage {
  month: string; creditsUsed: number; creditsLimit: number; creditsLeft: number; unlimited: boolean; maxTier: AiTier; attachments: boolean; actions: boolean;
  tiers: AiTierInfo[]; attachmentTypes: string[]; maxFiles: number; maxImageMb: number; maxDocumentMb: number;
}
export interface AiConversation { id: string; title: string; lastMessageAt: string; isPinned: boolean }
export interface AiToolUse { name: string; label: string; count: number | null }
export interface AiAttachment { id: string; name: string; contentType: string; sizeBytes: number; isImage: boolean }
export interface AiAction { id: string; kind: string; title: string; summary: string; status: 'proposed' | 'running' | 'done' | 'failed' | 'dismissed'; link: string | null; error: string | null; preview: string | null }
export interface AiMessage {
  id: string; role: 'user' | 'assistant'; content: string; reasoning: string | null; tier: AiTier | null; model: string | null; routeReason: string | null;
  credits: number; status: 'complete' | 'stopped' | 'failed'; tools: AiToolUse[]; actions: AiAction[]; attachments: AiAttachment[]; createdAt: string;
  followUps?: string[]; unverifiedKeys?: string[]; feedback?: 'up' | 'down' | null;
}
export interface PortfolioRisk {
  projectId: string; key: string; name: string; group: string | null; health: string; progress: number; owner: string | null; startDate: string | null; dueDate: string | null; delayedDays: number;
  openTasks: number; overdueTasks: number; blockedTasks: number; openActionItems: number; overdueActionItems: number; finishedLast28Days: number; inProgressTasks: number;
  projectedFinish: string | null; projectedSlipDays: number | null; confidence: 'high' | 'medium' | 'low' | 'none'; score: number; level: 'Critical' | 'High' | 'Medium' | 'Low'; reasons: string[];
}
export interface PortfolioSlip { projectId: string; projectKey: string; project: string; previous: string | null; revised: string | null; daysShifted: number | null; reason: string | null; dependency: string | null; by: string | null; at: string }
export interface PortfolioPerson { name: string; projects: number; openTasks: number; overdueTasks: number }
export interface PortfolioBrief {
  asOf: string; projects: number; onTrack: number; atRisk: number; delayed: number; onHold: number; overdueTasks: number; blockedTasks: number; openActionItems: number; overdueActionItems: number;
  dateChangesLast30Days: number; headlines: string[]; ranked: PortfolioRisk[]; recentSlips: PortfolioSlip[]; stretched: PortfolioPerson[];
}
export interface ScenarioOutcome { finish: string | null; slipDays: number | null; confidence: string; openTasks: number }
export interface ScenarioNeed { cutTasks: number | null; addPeople: number | null; note: string }
export interface Scenario {
  projectId: string; key: string; name: string; dueDate: string | null; openTasks: number; finishedLast28Days: number; contributors: number; slipDays: number; addPeople: number; cutTasks: number;
  baseline: ScenarioOutcome; scenario: ScenarioOutcome; changeDays: number | null; toMeetDue: ScenarioNeed | null; notes: string[];
}
export interface AiInsight { id: string; severity: 'high' | 'medium' | 'low'; title: string; detail: string; prompt: string }
export interface AiStarter { label: string; prompt: string; hint: string | null }
export interface AiStarters { greeting: string; starters: AiStarter[] }
export interface AiProfile { detailLevel: number; detailLabel: string; notes: string | null; learned: string[]; learnedAt: string | null }
export type AiFeedbackReason = 'too_long' | 'too_short' | 'wrong' | 'off_topic';
export interface AiConversationDetail { conversation: AiConversation; messages: AiMessage[] }
export interface AiInstructions { text: string | null; canEdit: boolean }

export interface AiTierCount { tier: AiTier; answers: number; credits: number }
export interface AiPersonUsage { userId: string; name: string; answers: number; credits: number; byTier: AiTierCount[] }
export interface AiWorkspaceReport { month: string; creditsUsed: number; creditsLimit: number; unlimited: boolean; answers: number; failed: number; byTier: AiTierCount[]; people: AiPersonUsage[] }
export interface AdminAiUsageRow {
  tenantId: string; name: string; planCode: string; answers: number; failed: number; creditsUsed: number; creditsLimit: number; quick: number; standard: number; deep: number;
  tokensIn: number; tokensOut: number; cacheReadTokens: number; cacheHitPercent: number; estimatedCost: number; lastUsedAt: string | null;
}
export interface AdminAiUsage { month: string; organizations: number; answers: number; creditsUsed: number; tokensIn: number; tokensOut: number; estimatedCost: number; estimatedSavedByCache: number; cacheHitPercent: number; currency: string; rows: AdminAiUsageRow[] }

export interface AskBody { text: string; mode: AiMode; attachmentIds: string[]; timeZone: string }

export const aiAdminApi = { usage: (month: string) => get<AdminAiUsage>('/admin/ai-usage', { month }) };

/** What arrives while an answer is written. */
export type AiStreamEvent =
  | { name: 'started'; conversationId: string; questionId: string; title: string }
  | { name: 'route'; tier: AiTier; model: string; reason: string; limited: boolean; wanted: AiTier; credits: number }
  | { name: 'reasoning'; delta: string }
  | { name: 'text'; delta: string }
  | { name: 'tool'; id: string; tool: string; label: string; state: 'running' | 'done' | 'failed'; count: number | null }
  | { name: 'action'; action: AiAction }
  | { name: 'done'; message: AiMessage; creditsLeft: number; unlimited: boolean }
  | { name: 'error'; code: string; message: string };

// ------------------------------------------------------------------ calls

export const aiWorkspaceApi = {
  usage: () => get<AiUsage>('/ai/usage'),
  conversations: () => get<AiConversation[]>('/ai/conversations'),
  conversation: (id: string) => get<AiConversationDetail>(`/ai/conversations/${id}`),
  update: (id: string, body: { title?: string; pinned?: boolean }) => patch<AiConversation>(`/ai/conversations/${id}`, body),
  remove: (id: string) => del(`/ai/conversations/${id}`),
  confirm: (messageId: string, actionId: string) => post<AiAction>(`/ai/messages/${messageId}/actions/${actionId}/confirm`),
  dismiss: (messageId: string, actionId: string) => post<AiAction>(`/ai/messages/${messageId}/actions/${actionId}/dismiss`),
  upload: (file: File) => uploadFile<AiAttachment>('/ai/files', file),
  removeFile: (id: string) => del(`/ai/files/${id}`),
  report: (month: string) => get<AiWorkspaceReport>('/ai/usage/report', { month }),
  starters: () => get<AiStarters>('/ai/starters'),
  insights: () => get<AiInsight[]>('/ai/insights'),
  portfolioBrief: (teamId?: string | null) => get<PortfolioBrief>('/ai/portfolio/brief', { teamId: teamId ?? undefined }),
  sendBrief: (teamId?: string | null) => post<{ sent: boolean; reason: string | null }>(`/ai/portfolio/brief/send${teamId ? `?teamId=${teamId}` : ''}`),
  scenario: (body: { projectId: string; slipDays: number; addPeople: number; cutTasks: number; teamId?: string | null }) => post<Scenario>('/ai/portfolio/scenario', body),
  confirmAll: (messageId: string) => post<AiAction[]>(`/ai/messages/${messageId}/actions/confirm-all`),
  feedback: (messageId: string, rating: 'up' | 'down' | 'none', reason?: AiFeedbackReason) => post<void>(`/ai/messages/${messageId}/feedback`, { rating, reason }),
  profile: () => get<AiProfile>('/ai/profile'),
  setProfileNotes: (notes: string) => put<AiProfile>('/ai/profile', { notes }),
  resetProfile: () => del('/ai/profile'),
  instructions: () => get<AiInstructions>('/ai/instructions'),
  setInstructions: (text: string) => put<AiInstructions>('/ai/instructions', { text }),
};

/**
 * Asks a question and reports each event as it arrives. Resolves when the stream ends; rejects (ApiError) when the question is refused before
 * any answer starts (no plan, no credits, a bad file). Aborting the signal stops the answer; the part already written is kept by the server.
 */
export async function askAi(conversationId: string | null, body: AskBody, onEvent: (e: AiStreamEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await streamPost(conversationId ? `/ai/conversations/${conversationId}/ask` : '/ai/ask', body, signal);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const parsed = parseBlock(block);
      if (parsed) onEvent(parsed);
    }
  }
}

function parseBlock(block: string): AiStreamEvent | null {
  let name = '';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (!name || data.length === 0) return null;   // a comment or keep-alive
  try {
    return { ...JSON.parse(data.join('\n')), name };
  } catch { return null; }
}
