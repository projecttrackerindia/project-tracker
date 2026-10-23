import { get, post, postForm } from '../../api/client';

export type DraftSource = 'prompt' | 'meeting' | 'tasks' | 'files' | 'voice' | 'template';
export type AiAction = 'rewrite' | 'shorten' | 'expand' | 'fix' | 'translate' | 'simpler' | 'formal' | 'friendly';
export type AiLanguage = 'en' | 'hi' | 'te';
export const LANGUAGES: { id: AiLanguage; label: string }[] = [{ id: 'en', label: 'English' }, { id: 'hi', label: 'हिन्दी Hindi' }, { id: 'te', label: 'తెలుగు Telugu' }];

export interface DocDraft { title: string; body: string; markdown: string; sources: string[]; model: string }
export interface DocTransform { text: string; blocks: string | null; model: string; inline?: boolean }
export interface AskCitation { n: number; documentId: string; key: string; title: string; icon: string | null; block: number; snippet: string }
export interface AskAnswer { answer: string; citations: AskCitation[]; pagesRead: number; model: string; found: boolean }
export interface DocSearchHit { id: string; key: string; title: string; icon: string | null; projectId: string | null; projectName: string | null; line: string; block: number; score: number; updatedAt: string; typeCode: string }
export interface FreshnessReason { kind: string; key: string; title: string; detail: string; at: string; link: string }
export interface DocFreshness { stale: boolean; since: string | null; reasons: FreshnessReason[]; lastEditedAt: string; verifiedAt: string | null; verifiedBy: string | null; canVerify: boolean; summary: string }
export interface DocProposal {
  id: string; projectId: string | null; projectKey: string | null; kind: 'decision-log' | 'release-notes' | 'api-reference'; sourceType: string; sourceId: string | null; title: string; summary: string;
  body: string; targetDocumentId: string | null; targetTitle: string | null; status: string; createdAt: string; resultDocumentId: string | null; action: 'create' | 'add' | 'replace';
}

export interface DraftInput { source: DraftSource; prompt?: string; projectId?: string | null; meetingId?: string | null; templateTypeId?: string | null; language?: AiLanguage; kind?: string; files?: File[]; voice?: Blob | null }

export const docAiApi = {
  draft: (i: DraftInput) => {
    const f = new FormData();
    f.append('source', i.source);
    for (const [k, v] of Object.entries({ prompt: i.prompt, projectId: i.projectId, meetingId: i.meetingId, templateTypeId: i.templateTypeId, language: i.language, kind: i.kind }))
      if (v) f.append(k, v);
    for (const file of i.files ?? []) f.append('files', file, file.name);
    if (i.voice) f.append('voice', i.voice, `voice.${i.voice.type.includes('wav') ? 'wav' : i.voice.type.includes('ogg') ? 'ogg' : i.voice.type.includes('mp4') ? 'm4a' : 'webm'}`);
    return postForm<DocDraft>('/documents/ai/draft', f);
  },
  transform: (text: string, action: AiAction, language?: AiLanguage, documentId?: string) => post<DocTransform>('/documents/ai/transform', { text, action, language, documentId }),
  continueWriting: (documentId: string, before: string, language?: AiLanguage) => post<DocTransform>('/documents/ai/continue', { documentId, before, language }),
  ask: (question: string, projectId?: string | null) => post<AskAnswer>('/documents/ai/ask', { question, projectId: projectId ?? null }),
  search: (q: string, projectId?: string | null, take = 20) => get<{ hits: DocSearchHit[]; total: number }>('/documents/search', { q, ...(projectId ? { projectId } : {}), take: String(take) }),
  freshness: (id: string) => get<DocFreshness>(`/documents/${id}/freshness`),
  verify: (id: string, note?: string) => post<DocFreshness>(`/documents/${id}/verify`, { note: note ?? null }),
  proposals: (projectId?: string | null, status?: string) => get<DocProposal[]>('/documents/proposals', { ...(projectId ? { projectId } : {}), ...(status ? { status } : {}) }),
  generate: (kind: DocProposal['kind'], projectId?: string | null, sourceId?: string | null) => post<DocProposal>('/documents/proposals/generate', { kind, projectId: projectId ?? null, sourceId: sourceId ?? null }),
  accept: (id: string) => post<{ documentId: string; message: string }>(`/documents/proposals/${id}/accept`),
  dismiss: (id: string) => post(`/documents/proposals/${id}/dismiss`),
};
