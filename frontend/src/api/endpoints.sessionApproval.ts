import { get, post, put } from './client';
import type { AuthResponse } from './types';

/** A sign-in that must be allowed on a device already signed in ("Single active session"). The secret is in an HttpOnly cookie for browsers. */
export interface ApprovalStart {
  approvalRequired: true; approvalId: string; code: number; device: string; app: 'web' | 'desktop' | 'phone'; location: string | null;
  ipAddress: string | null; expiresAt: string; secret?: string | null;
}
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'timed_out' | 'closed';
export interface ApprovalStatus {
  status: ApprovalState; code: number; device: string; expiresAt: string; canEmail: boolean; canCode: boolean; emailSent: boolean; message?: string | null;
  auth?: AuthResponse;
}
/** What a signed-in device is asked. `token` is the signed one-time answer token. */
export interface ApprovalPrompt {
  id: string; device: string; app: 'web' | 'desktop' | 'phone'; location: string | null; ipAddress: string | null; method: string; code: number;
  createdAt: string; expiresAt: string; token: string;
}
export interface ApprovalHistoryItem {
  id: string; createdAt: string; device: string; app: string; location: string | null; ipAddress: string | null;
  outcome: 'pending' | 'allowed' | 'rejected' | 'timed_out' | 'reported'; decidedVia: string | null; decidedAt: string | null;
}
export interface SessionPolicy { singleSession: boolean; effective: boolean; requiredBy: string[] }
export interface WorkspaceSessionPolicy { singleActiveSession: boolean; canManage: boolean }
export interface ApprovalEmailPreview { device: string; app: string; location: string | null; ipAddress: string | null; createdAt: string }

export const isApprovalStart = (r: unknown): r is ApprovalStart => !!r && typeof r === 'object' && (r as { approvalRequired?: boolean }).approvalRequired === true;

const secretBody = (secret?: string | null) => (secret ? { secret } : {});

export const sessionApprovalApi = {
  status: (id: string, secret?: string | null) => post<ApprovalStatus>(`/auth/session-approval/${id}/status`, secretBody(secret), { auth: false }),
  email: (id: string, secret?: string | null) => post<ApprovalStatus>(`/auth/session-approval/${id}/email`, secretBody(secret), { auth: false }),
  code: (id: string, code: string, secret?: string | null) => post<ApprovalStatus>(`/auth/session-approval/${id}/code`, { ...secretBody(secret), code }, { auth: false }),
  emailPreview: (token: string) => post<ApprovalEmailPreview>('/auth/session-approval/email/preview', { token }, { auth: false }),
  emailConfirm: (token: string) => post<ApprovalEmailPreview>('/auth/session-approval/email/confirm', { token }, { auth: false }),
  decide: (id: string, token: string, decision: 'allow' | 'reject' | 'not-me') => post<{ outcome: string }>(`/auth/session-approval/${id}/decide`, { token, decision }),
  pending: () => get<ApprovalPrompt[]>('/me/session-approvals/pending'),
  history: () => get<ApprovalHistoryItem[]>('/me/session-approvals'),
  policy: () => get<SessionPolicy>('/me/session-policy'),
  setPolicy: (singleSession: boolean) => put<SessionPolicy>('/me/session-policy', { singleSession }),
  workspacePolicy: () => get<WorkspaceSessionPolicy>('/workspace/session-policy'),
  setWorkspacePolicy: (singleActiveSession: boolean) => put<WorkspaceSessionPolicy>('/workspace/session-policy', { singleActiveSession }),
};
