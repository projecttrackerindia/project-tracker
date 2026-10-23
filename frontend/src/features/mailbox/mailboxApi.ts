import { del, get, post, put } from '../../api/client';

export type MailFolder = 'inbox' | 'sent';
export interface MailPreset { id: string; name: string; imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; domain: string }
export interface MailImapAccount { id: string; provider: string; name: string; email: string; connectedAt: string; lastSyncedAt: string | null; lastError: string | null }
export interface CompanyMail { provider: string; name: string; domains: string[]; incoming: 'imap' | 'pop'; incomingHost: string; incomingPort: number; smtpHost: string; smtpPort: number; custom: boolean }
export interface CompanyMailInput { provider: string; domains: string; incoming?: 'imap' | 'pop'; incomingHost?: string; incomingPort?: number; smtpHost?: string; smtpPort?: number }
export interface MailServerCheck { server: string; ok: boolean; detail: string }
export interface MailAccounts { imap: MailImapAccount[]; presets: MailPreset[]; company: CompanyMail | null; canManageCompany: boolean; myEmail: string | null }
export interface MailMessage { id: string; threadId: string; subject: string; from: string; to: string; cc: string; date: string | null; unread: boolean; hasAttachments: boolean; body?: string | null; bodyTruncated?: boolean }
export interface MailList { account: string; email: string; folder: MailFolder; messages: MailMessage[]; cursor: string | null }
export interface MailThread { account: string; email: string; folder: MailFolder; threadId: string; messages: MailMessage[]; truncated: boolean }
export interface MailSendInput { account: string; replyToId?: string | null; folder?: MailFolder; replyAll?: boolean; to?: string; cc?: string; subject?: string; body: string; confirmed: boolean }
export interface MailSendResult { accepted: boolean; to: string; cc: string; subject: string }
export interface MailForwardInput { account: string; folder?: MailFolder; messageId: string; to: string; cc?: string; note?: string; confirmed: boolean }
export interface MailReplySuggestion { label: string; body: string }
export interface MailTaskSuggestion { kind: 'create' | 'update'; taskId: string | null; taskKind: 'task' | 'work' | null; taskRef: string | null; projectId: string | null; title: string; detail: string | null; priority: string | null; status: string | null; reason: string; due: string | null }
export interface MailAssist { summary: string; intent: string; urgency: 'low' | 'medium' | 'high'; actionItems: string[]; replies: MailReplySuggestion[]; tasks: MailTaskSuggestion[]; keyFacts: string[]; model: string | null }
export type ComposeMode = 'reply' | 'improve' | 'shorter' | 'formal' | 'friendly' | 'complete';

export const mailboxApi = {
  accounts: () => get<MailAccounts>('/me/mailbox/accounts'),
  saveCompany: (b: CompanyMailInput) => put<CompanyMail | null>('/me/mailbox/company', b),
  testCompany: (b: { settings: CompanyMailInput; email: string; password: string }) => post<{ ok: boolean; checks: MailServerCheck[] }>('/me/mailbox/company/test', b),
  connectImap: (b: { provider: string; email: string; password: string }) => post<MailImapAccount>('/me/mailbox/accounts/imap', b),
  disconnectImap: (id: string) => del(`/me/mailbox/accounts/imap/${id}`),
  messages: (account: string, folder: MailFolder, cursor?: string | null, q?: string, signal?: AbortSignal) =>
    get<MailList>('/me/mailbox/messages', { account, folder, cursor: cursor || undefined, q: q || undefined }, { signal }),
  thread: (account: string, folder: MailFolder, messageId: string, signal?: AbortSignal) => get<MailThread>('/me/mailbox/thread', { account, folder, messageId }, { signal }),
  send: (b: MailSendInput) => post<MailSendResult>('/me/mailbox/send', b),
  forward: (b: MailForwardInput) => post<MailSendResult>('/me/mailbox/forward', b),
  agentOptions: () => get<{ available: boolean; credits: number }>('/me/mailbox/agent/options'),
  assist: (b: { account: string; folder: MailFolder; messageId: string }) => post<MailAssist>('/me/mailbox/agent/assist', b),
  compose: (b: { account?: string; folder?: MailFolder; messageId?: string; draft: string; mode: ComposeMode }) => post<{ body: string; model: string | null }>('/me/mailbox/agent/compose', b),
};

/** "Asha Rao <asha@x.com>" -> "Asha Rao"; a bare address stays as it is. */
export function displayName(from: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(from);
  if (m) return m[1].trim() || m[2];
  return from.trim();
}
export function addressOf(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1] : from).trim();
}
