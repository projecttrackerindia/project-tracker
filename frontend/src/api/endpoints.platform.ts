import { del, download, fetchBlobUrl, get, post, put, uploadFile } from './client';
import type { ChatAttachment,BillingSettings,AuthResponse,FeatureOverride,PlatformSettings,PlatformStatus,WorkloadScope,PasswordPolicy,ProjectChatUnread,Paged,ChatFilePage,ChatMessage,ChatPerson,ChatSearchHit,ChatThread,Conversation,WorkActivity,WorkAttachment,WorkComment,WorkSummary,WorkTask,WorkTaskInput,WorkType,ConsentDocument,MyConsent,SignInDevice,DeviceLoginStart,DeviceLoginPending,Rates,Utilisation,ProjectFinancials,SlaSettings,SlaTarget,CalendarFeed,InboundMailbox,GitConnection,GitProvider,DevLink,DataPolicy,Priority,GoogleConnectionStatus,Meeting,MeetingParticipant,PlatformBilling,AdminUsage,SystemHealth,GoLive,AdminTestEmailResult } from './types';
export const platformApi = {
  billing: () => get<PlatformBilling>('/admin/billing'),
  usage: (p: { q?: string; sort?: string; warningsOnly?: boolean; page?: number }) => get<Paged<AdminUsage>>('/admin/usage', { pageSize: 25, ...p }),
  health: () => get<SystemHealth>('/admin/health'),
  goLive: () => get<GoLive>('/admin/go-live'),
  testEmail: () => post<AdminTestEmailResult>('/admin/test-email'),
  billingSettings: () => get<BillingSettings>('/admin/billing-settings'),

  setBillingSettings: (b: { currency: string }) => put<BillingSettings>('/admin/billing-settings', b),
  settings: () => get<PlatformSettings>('/admin/settings'),
  setSettings: (b: PlatformSettings) => put<PlatformSettings>('/admin/settings', b),
  passwordPolicy: () => get<PasswordPolicy>('/admin/password-policy'),
  setPasswordPolicy: (b: PasswordPolicy) => put<PasswordPolicy>('/admin/password-policy', b),
  consentDocuments: () => get<ConsentDocument[]>('/admin/consent'),
  publishConsentDocument: (b: { type: string; title: string; body: string }) => put<ConsentDocument>('/admin/consent', b),
  overrides: (tenantId: string) => get<FeatureOverride[]>(`/admin/tenants/${tenantId}/overrides`),
  setOverride: (tenantId: string, key: string, b: { value: number; reason: string; expiresInDays: number | null }) => put<FeatureOverride[]>(`/admin/tenants/${tenantId}/overrides/${key}`, b),
  removeOverride: (tenantId: string, key: string) => del<FeatureOverride[]>(`/admin/tenants/${tenantId}/overrides/${key}`),
  status: () => get<PlatformStatus>('/platform/status', undefined, { auth: false }),
};

export const chatApi = {
  people: () => get<ChatPerson[]>('/chat/people'),
  unread: () => get<{ count: number }>('/chat/unread'),
  search: (q: string) => get<ChatSearchHit[]>('/chat/search', { q }),
  conversations: () => get<Conversation[]>('/chat/conversations'),
  conversation: (id: string) => get<Conversation>(`/chat/conversations/${id}`),
  /** The team chat of a project (created on first use). Only the project's team, its owner and Owners, Admins and Managers get in. */
  openProject: (projectId: string) => post<Conversation>(`/chat/projects/${projectId}/open`),
  projectUnread: () => get<ProjectChatUnread[]>('/chat/projects/unread'),
  openDirect: (userId: string) => post<Conversation>('/chat/conversations/direct', { userId }),
  createGroup: (name: string, memberIds: string[]) => post<Conversation>('/chat/conversations/group', { name, memberIds }),
  rename: (id: string, name: string) => put<Conversation>(`/chat/conversations/${id}`, { name }),
  addMembers: (id: string, userIds: string[]) => post<Conversation>(`/chat/conversations/${id}/members`, { userIds }),
  removeMember: (id: string, userId: string) => del(`/chat/conversations/${id}/members/${userId}`),
  messages: (id: string, before?: string) => get<ChatThread>(`/chat/conversations/${id}/messages`, { before, limit: 40 }),
  /** Every file ever sent in the conversation, newest first - the Files view next to the thread. */
  files: (id: string, before?: string) => get<ChatFilePage>(`/chat/conversations/${id}/files`, { before, limit: 40 }),
  send: (id: string, body: string, replyToId?: string | null, attachmentIds?: string[]) =>
    post<ChatMessage>(`/chat/conversations/${id}/messages`, { body, replyToId: replyToId ?? null, attachmentIds: attachmentIds ?? [] }),
  /** Stores a file for a message about to be sent (the plan decides whether, how big and how much). */
  uploadFile: (id: string, file: File) => uploadFile<ChatAttachment>(`/chat/conversations/${id}/files`, file),
  removeFile: (fileId: string) => del(`/chat/files/${fileId}`),
  /** A file as an object URL, fetched with the signed-in person's access (pictures inline). */
  fileUrl: (fileId: string, inline = false) => fetchBlobUrl(`/chat/files/${fileId}${inline ? '?inline=true' : ''}`),
  react: (messageId: string, emoji: string) => put<ChatMessage>(`/chat/messages/${messageId}/reaction`, { emoji }),
  unreact: (messageId: string, emoji: string) => del<ChatMessage>(`/chat/messages/${messageId}/reaction?emoji=${encodeURIComponent(emoji)}`),
  edit: (messageId: string, body: string) => put<ChatMessage>(`/chat/messages/${messageId}`, { body }),
  deleteMessage: (messageId: string) => del(`/chat/messages/${messageId}`),
  markRead: (id: string) => post(`/chat/conversations/${id}/read`),
  mute: (id: string, muted: boolean) => put(`/chat/conversations/${id}/mute`, { muted }),
};

export const consentApi = {
  documents: () => get<ConsentDocument[]>('/consent/documents', undefined, { auth: false }),
  status: () => get<MyConsent>('/consent/status'),
  accept: (types: string[]) => post<MyConsent>('/consent/accept', { types }),
};

// ---- push notifications on this person's devices
export const pushApi = {
  status: () => get<{ publicKey: string; devices: number }>('/push'),
  subscribe: (b: { endpoint: string; keys: { p256dh: string; auth: string } }) => post<{ publicKey: string; devices: number }>('/push/subscriptions', b),
  subscribeNative: (token: string) => post<{ publicKey: string; devices: number; nativeEnabled: boolean }>('/push/native', { token }),
  unsubscribe: (endpoint: string) => post<{ publicKey: string; devices: number }>('/push/unsubscribe', { endpoint }),
  signInStatus: (endpoint?: string | null) => get<SignInDevice>('/push/sign-in', { endpoint: endpoint ?? undefined }),
  setSignIn: (endpoint: string, enabled: boolean) => put<SignInDevice>('/push/sign-in', { endpoint, enabled }),
};

// ---- signing in on a computer by approving on a phone
export const deviceLoginApi = {
  start: (email: string) => post<DeviceLoginStart>('/auth/device-login', { email }, { auth: false }),
  poll: (id: string, secret: string) => post<{ status: 'pending' | 'approved' | 'denied' | 'expired'; auth?: AuthResponse }>(`/auth/device-login/${id}/poll`, { secret }, { auth: false }),
  pending: () => get<DeviceLoginPending[]>('/me/device-login/pending'),
  get: (id: string) => get<DeviceLoginPending | null>(`/me/device-login/${id}`),
  approve: (id: string, number: number) => post<void>(`/me/device-login/${id}/approve`, { number }),
  deny: (id: string) => post<void>(`/me/device-login/${id}/deny`),
};

// ---- integrations and compliance
export const integrationsApi = {
  calendarFeed: () => get<CalendarFeed>('/calendar/feed'),
  resetCalendarFeed: () => post<CalendarFeed>('/calendar/feed'),
  removeCalendarFeed: () => del('/calendar/feed'),
  mailbox: () => get<InboundMailbox>('/integrations/inbound-email'),
  saveMailbox: (b: { enabled: boolean; workTypeId: string | null; priority: Priority }) => put<InboundMailbox>('/integrations/inbound-email', b),
  resetMailbox: () => post<InboundMailbox>('/integrations/inbound-email/reset'),
  git: () => get<GitConnection[]>('/integrations/git'),
  createGit: (b: { provider: GitProvider; name: string; closeOnKeyword: boolean }) => post<{ connection: GitConnection; secret: string }>('/integrations/git', b),
  updateGit: (id: string, b: { provider: GitProvider; name: string; closeOnKeyword: boolean }) => put<GitConnection>(`/integrations/git/${id}`, b),
  removeGit: (id: string) => del(`/integrations/git/${id}`),
  taskLinks: (taskId: string) => get<DevLink[]>(`/tasks/${taskId}/dev-links`),
  workTaskLinks: (workTaskId: string) => get<DevLink[]>(`/work-tasks/${workTaskId}/dev-links`),
  dataPolicy: () => get<DataPolicy>('/workspace/data-policy'),
  saveDataPolicy: (b: { activityRetentionDays: number | null; notificationRetentionDays: number | null; chatRetentionDays: number | null; auditRetentionDays: number | null }) => put<DataPolicy>('/workspace/data-policy', b),
  /** Google Workspace: one Calendar/Meet grant per person (never a shared workspace credential - see GoogleCalendarAuthService). */
  googleStatus: () => get<GoogleConnectionStatus>('/integrations/google/status'),
  /** Returns Google's consent screen address; the caller navigates the whole page there itself (window.location.assign) - this call cannot
   * redirect there itself because only an ordinary authenticated fetch, not a bare page navigation, can carry the Authorization header. */
  googleConnectUrl: (returnUrl?: string) => get<{ url: string }>('/integrations/google/connect', returnUrl ? { returnUrl } : undefined),
  googleDisconnect: () => del('/integrations/google/disconnect'),
};

export const meetingApi = {
  list: (projectId: string) => get<Meeting[]>(`/projects/${projectId}/meetings`),
  participants: (projectId: string) => get<MeetingParticipant[]>(`/projects/${projectId}/meetings/participants`),
  start: (projectId: string, b: { title?: string; participantUserIds?: string[] }) => post<Meeting>(`/projects/${projectId}/meetings/start`, b),
  schedule: (projectId: string, b: { title: string; description?: string; startTime: string; endTime: string; timeZone: string; participantUserIds?: string[] }) =>
    post<Meeting>(`/projects/${projectId}/meetings/schedule`, b),
  get: (id: string) => get<Meeting>(`/meetings/${id}`),
  cancel: (id: string) => post(`/meetings/${id}/cancel`, {}),
  reschedule: (id: string, b: { startTime: string; endTime: string }) => post<Meeting>(`/meetings/${id}/reschedule`, b),
  addParticipant: (id: string, userId: string) => post<Meeting>(`/meetings/${id}/participants`, { userId }),
  removeParticipant: (id: string, userId: string) => del<Meeting>(`/meetings/${id}/participants/${userId}`),
};

// ---- capacity and cost
export const resourcesApi = {
  rates: () => get<Rates>('/resources/rates'),
  setRates: (userId: string, b: { weeklyCapacityHours: number | null; costRate: number | null; billRate: number | null }) => put<Rates>(`/resources/rates/${userId}`, b),
  setCurrency: (currency: string) => put<Rates>('/resources/currency', { currency }),
  utilisation: (p: { from?: string; to?: string; scope?: WorkloadScope }) => get<Utilisation>('/resources/utilisation', p),
  project: (projectId: string) => get<ProjectFinancials>(`/resources/projects/${projectId}`),
  setBudget: (projectId: string, b: { isBillable: boolean; budgetHours: number | null; budgetAmount: number | null; billRate: number | null }) => put<ProjectFinancials>(`/resources/projects/${projectId}/budget`, b),
};

// ---- Work management
export interface WorkFilters {
  q?: string; workTypeId?: string; relatedProjectId?: string; noProject?: boolean; assigneeId?: string; mine?: boolean; priority?: string; status?: string; open?: boolean;
  dueFrom?: string; dueTo?: string; overdue?: boolean; sort?: string; page?: number; pageSize?: number;
  /** Service levels: 'breached' (a target already missed), 'atRisk' or 'tracked'. */
  sla?: string;
}
export const workApi = {
  types: (includeInactive = false) => get<WorkType[]>('/work-types', includeInactive ? { includeInactive: true } : undefined),
  createType: (b: { name: string; description?: string | null }) => post<WorkType>('/work-types', b),
  updateType: (id: string, b: { name: string; description?: string | null; isActive?: boolean }) => put<WorkType>(`/work-types/${id}`, b),
  reorderTypes: (ids: string[]) => put<void>('/work-types/order', { ids }),
  removeType: (id: string) => del<void>(`/work-types/${id}`),
  sla: () => get<SlaSettings>('/work/sla'),
  saveSla: (workTypeId: string | null, targets: SlaTarget[]) => put<SlaSettings>('/work/sla', { workTypeId, targets }),
  clearSla: (workTypeId: string) => del<SlaSettings>(`/work/sla/${workTypeId}`),

  list: (f: WorkFilters = {}) => get<Paged<WorkTask>>('/work-tasks', { pageSize: 25, ...f }),
  get: (id: string) => get<WorkTask>(`/work-tasks/${id}`),
  create: (b: WorkTaskInput) => post<WorkTask>('/work-tasks', b),
  update: (id: string, b: WorkTaskInput & { status: string; priority: string; version: number }) => put<WorkTask>(`/work-tasks/${id}`, b),
  setStatus: (id: string, status: string) => put<WorkTask>(`/work-tasks/${id}/status`, { status }),
  remove: (id: string) => del<void>(`/work-tasks/${id}`),
  summary: (from?: string, to?: string) => get<WorkSummary>('/work-tasks/summary', { from, to }),
  /** The filtered list as a CSV file (every filter but the page). */
  exportCsv: (f: WorkFilters) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...f, page: undefined, pageSize: undefined })) if (v !== undefined && v !== '' && v !== false) q.set(k, String(v));
    return download(`/work-tasks/export?${q}`, 'work-tasks.csv');
  },

  comments: (id: string) => get<WorkComment[]>(`/work-tasks/${id}/comments`),
  addComment: (id: string, body: string, mentionUserIds?: string[]) => post<WorkComment>(`/work-tasks/${id}/comments`, { body, mentionUserIds: mentionUserIds ?? null }),
  updateComment: (id: string, commentId: string, body: string) => put<WorkComment>(`/work-tasks/${id}/comments/${commentId}`, { body }),
  deleteComment: (id: string, commentId: string) => del<void>(`/work-tasks/${id}/comments/${commentId}`),
  history: (id: string) => get<WorkActivity[]>(`/work-tasks/${id}/history`),
  files: (id: string) => get<WorkAttachment[]>(`/work-tasks/${id}/attachments`),
  upload: (id: string, file: File) => uploadFile<WorkAttachment>(`/work-tasks/${id}/attachments`, file),
  download: (fileId: string, fileName: string) => download(`/work-attachments/${fileId}/download`, fileName),
  removeFile: (fileId: string) => del<void>(`/work-attachments/${fileId}`),
};
