import { del, get, post, put } from '../../api/client';

export type AiProviderId = 'anthropic' | 'openai';
export interface AiProviderSettings {
  configured: boolean; provider: AiProviderId; providerName: string; keyHint: string | null; quickModel: string; standardModel: string; deepModel: string;
  enabled: boolean; fallbackToPlatform: boolean; lastCheckedAt: string | null; lastError: string | null; peopleAgreed: number; version: number;
}
export interface AiKeyCheck { ok: boolean; models: string[]; error: string | null }
export interface AiProviderStatus { active: boolean; provider: AiProviderId | null; providerName: string | null; agreed: boolean; agreedAt: string | null; fallbackToPlatform: boolean; notice: string | null }
export interface SaveAiProvider { provider: AiProviderId; apiKey?: string | null; quickModel: string; standardModel: string; deepModel: string; enabled: boolean; fallbackToPlatform: boolean }

/** The workspace's own Claude or ChatGPT key (owners and admins), and each person's one-time agreement to it. */
export const aiProviderApi = {
  get: () => get<AiProviderSettings>('/workspace/ai-provider'),
  check: (provider: AiProviderId, apiKey?: string | null) => post<AiKeyCheck>('/workspace/ai-provider/check', { provider, apiKey: apiKey || null }),
  save: (b: SaveAiProvider) => put<AiProviderSettings>('/workspace/ai-provider', b),
  remove: () => del('/workspace/ai-provider'),
  status: () => get<AiProviderStatus>('/ai/provider-status'),
  agree: () => post<AiProviderStatus>('/ai/provider-consent'),
  withdraw: () => del<AiProviderStatus>('/ai/provider-consent'),
};
