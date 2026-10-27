import { get, post, put } from '../../api/client';

/** What an agent may do in this workspace: nothing, suggest in place, put its work in the inbox first, or act on its own. */
export type AgentLevel = 'off' | 'suggest' | 'askFirst' | 'auto';
export interface AiAgentLevel { id: string; name: string; description: string; level: AgentLevel }
/** This month's answers (failed among them; success = the share not failed, null before the first) and credits (limit -1 = unlimited). */
export interface AiControlFigures { month: string; answers: number; failed: number; successPercent: number | null; creditsUsed: number; creditsLimit: number; unlimited: boolean }
export interface AiControl { agents: AiAgentLevel[]; contextLength: number; contextLimit: number; automations: number; people: number; aiOn: boolean; canEdit: boolean; figures?: AiControlFigures | null }

/** Settings › AI (the AI control centre): /api/v1/ai/control. */
export const aiControlApi = {
  get: () => get<AiControl>('/ai/control'),
  setLevel: (agent: string, level: AgentLevel) => put<AiControl>(`/ai/control/agents/${agent}`, { level }),
  /** "Draft it from my projects": a first version of the organisation context, from the workspace's records (nothing is saved). */
  draftContext: () => post<{ text: string }>('/ai/control/context/draft'),
};
