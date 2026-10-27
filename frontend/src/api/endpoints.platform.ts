import { providerConnectionUrl } from './providerConnection';
import { del, download, fetchBlobUrl, fetchText, get, post, put, uploadFile, create, qs } from './client';
import type { ChatAttachment,ChatThreadView,ChatSavedItem,ChatSeenBy,ChatQuestion,ChatStatus,ChatScheduled,ChatLink,ChatUnfurl,ChatCatchUp,ChatAskAnswer,ChatExtract,BillingSettings,AuthResponse,FeatureOverride,PlatformSettings,PlatformStatus,WorkloadScope,PasswordPolicy,ProjectChatUnread,Paged,ChatFilePage,ChatMessage,ChatPerson,ChatSearchHit,ChatThread,Conversation,WorkActivity,WorkAttachment,WorkComment,WorkSummary,WorkTask,WorkTaskInput,WorkType,ConsentDocument,MyConsent,SignInDevice,DeviceLoginStart,DeviceLoginPending,Rates,Utilisation,ProjectFinancials,SlaSettings,SlaTarget,CalendarFeed,InboundMailbox,GitConnection,GitProvider,DevLink,GitHubAppStatus,GitHubStatusRules,GitHubBranch,ReviewQueue,ReleaseNotes,DeliveryMetrics,DataPolicy,Priority,MicrosoftConnectionStatus,PersonalEmailDraft,GoogleConnectionStatus,Meeting,MeetingParticipant,MeetingProvider,WorkspaceMeetingDetail,StandupCard,PlatformBilling,AdminUsage,SystemHealth,GoLive,AdminTestEmailResult,MeetingBotOverview,OpsSettings,RoutingRuleInput,Triage,OpsInsights } from './types';
export const platformApi = {
  billing: () => get<PlatformBilling>('/admin/billing'),
  usage: (p: { q?: string; sort?: string; warningsOnly?: boolean; page?: number }) => get<Paged<AdminUsage>>('/admin/usage', { pageSize: 25, ...p }),
  health: () => get<SystemHealth>('/admin/health'),
  meetingBots: () => get<MeetingBotOverview>('/admin/meeting-bots'),
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
  send: (id: string, body: string, replyToId?: string | null, attachmentIds?: string[], threadRootId?: string | null) =>
    post<ChatMessage>(`/chat/conversations/${id}/messages`, { body, replyToId: replyToId ?? null, attachmentIds: attachmentIds ?? [], threadRootId: threadRootId ?? null }),
  thread: (rootId: string) => get<ChatThreadView>(`/chat/messages/${rootId}/thread`),
  pin: (messageId: string, on: boolean) => (on ? put<ChatMessage>(`/chat/messages/${messageId}/pin`, {}) : del<ChatMessage>(`/chat/messages/${messageId}/pin`)),
  pins: (id: string) => get<ChatMessage[]>(`/chat/conversations/${id}/pins`),
  save: (messageId: string, on: boolean) => (on ? put<ChatMessage>(`/chat/messages/${messageId}/save`, {}) : del<ChatMessage>(`/chat/messages/${messageId}/save`)),
  saved: () => get<ChatSavedItem[]>('/chat/saved'),
  seenBy: (messageId: string) => get<ChatSeenBy>(`/chat/messages/${messageId}/seen`),
  questions: () => get<ChatQuestion[]>('/chat/questions'),
  status: () => get<ChatStatus>('/chat/status'),
  setStatus: (b: { emoji?: string | null; text?: string | null; clearAt?: string | null; dndUntil?: string | null }) => put<ChatStatus>('/chat/status', b),
  createPoll: (id: string, b: { question: string; options: string[]; multiple?: boolean; closesAt?: string | null }) => post<ChatMessage>(`/chat/conversations/${id}/polls`, b),
  vote: (pollId: string, options: number[]) => post<ChatMessage>(`/chat/polls/${pollId}/vote`, { options }),
  closePoll: (pollId: string, decision?: string) => post<ChatMessage>(`/chat/polls/${pollId}/close`, { decision: decision ?? null }),
  schedule: (id: string, b: { body: string; sendAt: string; replyToId?: string | null; threadRootId?: string | null }) => post<ChatScheduled>(`/chat/conversations/${id}/scheduled`, b),
  scheduled: (conversationId?: string) => get<ChatScheduled[]>('/chat/scheduled', conversationId ? { conversationId } : {}),
  updateScheduled: (scheduledId: string, b: { body: string; sendAt: string }) => put<ChatScheduled>(`/chat/scheduled/${scheduledId}`, b),
  cancelScheduled: (scheduledId: string) => del(`/chat/scheduled/${scheduledId}`),
  /** A voice note (WAV) for a message about to be sent; it is transcribed on arrival. */
  uploadVoice: (id: string, wav: Blob, seconds: number) => uploadFile<ChatAttachment>(`/chat/conversations/${id}/voice`, new File([wav], 'voice.wav', { type: 'audio/wav' }), { seconds: String(Math.round(seconds)) }),
  link: (messageId: string, b: { kind: ChatLink['kind']; id: string }) => post<ChatMessage>(`/chat/messages/${messageId}/links`, b),
  unfurl: (keys: string[]) => get<ChatUnfurl[]>('/chat/unfurl', { keys: keys.join(',') }),
  catchUp: (conversationId?: string | null) => post<ChatCatchUp>('/chat/ai/catch-up', { conversationId: conversationId ?? null }),
  ask: (question: string, conversationId?: string | null) => post<ChatAskAnswer>('/chat/ai/ask', { question, conversationId: conversationId ?? null }),
  replies: (messageId: string) => post<{ replies: string[]; model: string | null }>(`/chat/messages/${messageId}/replies`, {}),
  extract: (messageId: string, kind: ChatExtract['kind']) => post<ChatExtract>(`/chat/messages/${messageId}/extract`, { kind }),
  transform: (text: string, action: string, language?: string) => post<{ text: string; blocks: string | null; model: string; inline?: boolean }>('/chat/ai/transform', { text, action, language: language ?? null }),
  /** Stores a file for a message about to be sent (the plan decides whether, how big and how much). */
  uploadFile: (id: string, file: File) => uploadFile<ChatAttachment>(`/chat/conversations/${id}/files`, file),
  removeFile: (fileId: string) => del(`/chat/files/${fileId}`),
  /** A file as an object URL, fetched with the signed-in person's access (pictures inline). */
  fileUrl: (fileId: string, inline = false) => fetchBlobUrl(`/chat/files/${fileId}${inline ? '?inline=true' : ''}`),
  /** A text file's content (a payload sent as a file: JSON, logs, XML, CSV), read for its preview and viewer. */
  fileText: (fileId: string) => fetchText(`/chat/files/${fileId}`),
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
  /** The ProjectTracker GitHub App: install with one click, then branches, checks, reviews, risk, release notes and delivery metrics. */
  gitHubApp: () => get<GitHubAppStatus>('/integrations/github-app'),
  gitHubInstall: () => post<{ url: string }>('/integrations/github-app/install'),
  gitHubComplete: (b: { installationId: number; setupAction: string | null; code: string | null; state: string }) => post<GitHubAppStatus>('/integrations/github-app/complete', b),
  gitHubSave: (b: { rules?: GitHubStatusRules; riskyPaths?: string[]; closeOnKeyword?: boolean }) => put<GitHubAppStatus>('/integrations/github-app', b),
  gitHubDisconnect: () => del('/integrations/github-app'),
  createBranch: (taskId: string, b: { repository: string; base?: string | null }) => post<GitHubBranch>(`/tasks/${taskId}/github-branch`, b),
  reviewQueue: () => get<ReviewQueue>('/me/review-queue'),
  releaseNotes: (projectId: string, from?: string, to?: string) => get<ReleaseNotes>(`/projects/${projectId}/release-notes${qs({ from, to })}`),
  releaseNotesPage: (projectId: string, from?: string, to?: string) => post<{ documentId: string }>(`/projects/${projectId}/release-notes/page${qs({ from, to })}`),
  delivery: (projectId?: string, days = 90) => get<DeliveryMetrics>(`/integrations/github-app/delivery${qs({ projectId, days: String(days) })}`),
  dataPolicy: () => get<DataPolicy>('/workspace/data-policy'),
  saveDataPolicy: (b: { activityRetentionDays: number | null; notificationRetentionDays: number | null; chatRetentionDays: number | null; auditRetentionDays: number | null }) => put<DataPolicy>('/workspace/data-policy', b),
  /** Google Workspace: one Calendar/Meet grant per person (never a shared workspace credential - see GoogleCalendarAuthService). */
  googleStatus: () => get<GoogleConnectionStatus>('/integrations/google/status'),
  /** Returns Google's consent screen address; the caller navigates the whole page there itself (window.location.assign) - this call cannot
   * redirect there itself because only an ordinary authenticated fetch, not a bare page navigation, can carry the Authorization header. */
  googleConnectUrl: (returnUrl?: string, mail = false, inbox = false, transcripts = false, autoTranscripts = false) =>
    providerConnectionUrl('google', { returnUrl, mail: mail || undefined, inbox: inbox || undefined, transcripts: transcripts || undefined, autoTranscripts: autoTranscripts || undefined }),
  googleDisconnect: () => post('/integrations/google/disconnect'),
  /** Stops one Google feature and keeps the rest (stopping Gmail never stops Calendar and Meet). */
  googleFeatureOff: (feature: 'calendar' | 'mail' | 'inbox' | 'transcripts') => post<GoogleConnectionStatus>(`/integrations/google/features/${feature}/off`),
};

export const microsoftApi = {
  status: () => get<MicrosoftConnectionStatus>('/integrations/microsoft/status'),
  connect: (inbox = false, calendars = false, meetings = false, returnUrl?: string) => providerConnectionUrl('microsoft', { inbox: inbox || undefined, calendars: calendars || undefined, meetings: meetings || undefined, returnUrl }),
  disconnect: () => post('/integrations/microsoft/disconnect'),
  /** Stops one Microsoft feature and keeps the rest. */
  featureOff: (feature: 'mail' | 'inbox' | 'calendar' | 'meetings') => post<MicrosoftConnectionStatus>(`/integrations/microsoft/features/${feature}/off`),
};

export const personalInboxApi = {
  list: (provider: 'google' | 'microsoft', cursor?: string, signal?: AbortSignal) => get<import('./types').InboxPage>('/me/inbox', { provider, cursor }, { signal }),
  thread: (provider: 'google' | 'microsoft', messageId: string, signal?: AbortSignal) => get<import('./types').InboxThread>('/me/inbox/thread', { provider, messageId }, { signal }),
  attachments: (provider: 'google' | 'microsoft', messageId: string, signal?: AbortSignal) => get<import('./types').InboxAttachments>('/me/inbox/attachments', { provider, messageId }, { signal }),
};
export const inboxSummaryApi = {
  options: (signal?: AbortSignal) => get<import('./types').InboxSummaryOptions>('/me/inbox/summaries/options', undefined, { signal }),
  list: (signal?: AbortSignal) => get<import('./types').InboxSummaryReceipt[]>('/me/inbox/summaries', undefined, { signal }),
  get: (operation: string, signal?: AbortSignal) => get<import('./types').InboxSummary>('/me/inbox/summaries/' + operation, undefined, { signal }),
  create: (body: import('./types').InboxSummaryRequest, signal?: AbortSignal) => post<import('./types').InboxSummary>('/me/inbox/summaries', body, { signal }),
  remove: (operation: string) => del('/me/inbox/summaries/' + operation),
};

export const personalEmailApi = {
  rewrite: (id: string, b: { operationId: string; version: number; style: string; confirmed: boolean; credits: number }) => post<import('./types').EmailRewriteReceipt>('/me/email-drafts/' + id + '/rewrites', b),
  rewrites: (id: string) => get<import('./types').EmailRewriteReceipt[]>('/me/email-drafts/' + id + '/rewrites'),
  rewriteReceipt: (id: string, operation: string, signal?: AbortSignal) => get<import('./types').EmailRewriteReceipt>('/me/email-drafts/' + id + '/rewrites/' + operation, undefined, { signal }),
  reconcile: (id: string) => post<PersonalEmailDraft>('/me/email-drafts/' + id + '/reconcile', {}),
  options: () => get<{ available: boolean; credits: number; maxBodyCharacters: number }>('/me/email-drafts/options'),
  improve: (id: string, b: { operationId: string; version: number; style: string; confirmed: boolean; credits: number }) => post<PersonalEmailDraft>('/me/email-drafts/' + id + '/improve', b),
  list: () => get<PersonalEmailDraft[]>('/me/email-drafts'),
  get: (id: string, signal?: AbortSignal) => get<PersonalEmailDraft>('/me/email-drafts/' + id, undefined, { signal }),
  create: (b: { recipient: string; subject: string; body: string; provider?: 'google' | 'microsoft' }) => post<PersonalEmailDraft>('/me/email-drafts', b),
  save: (id: string, b: { recipient: string; subject: string; body: string; version: number; provider?: 'google' | 'microsoft' }) => put<PersonalEmailDraft>('/me/email-drafts/' + id, b),
  remove: (id: string) => del('/me/email-drafts/' + id),
  send: (id: string, b: { version: number; confirmed: boolean; senderEmail: string }) => post<PersonalEmailDraft>('/me/email-drafts/' + id + '/send', b),
};
/** Whether the notetaker comes to a meeting: no, to listen and write (transcript), or also to speak up when something is missed (voice). */
export type NotetakerChoice = 'off' | 'transcript' | 'voice';
export const meetingApi = {
  list: (projectId: string) => get<Meeting[]>(`/projects/${projectId}/meetings`),
  participants: (projectId: string) => get<MeetingParticipant[]>(`/projects/${projectId}/meetings/participants`),
  start: (projectId: string, b: { title?: string; participantUserIds?: string[]; service?: MeetingServiceKey; notetaker?: NotetakerChoice }) => post<Meeting>(`/projects/${projectId}/meetings/start`, b),
  schedule: (projectId: string, b: { title: string; description?: string; startTime: string; endTime: string; timeZone: string; participantUserIds?: string[]; repeat?: { frequency: 'Daily' | 'Weekdays' | 'Weekly'; occurrences: number }; scrum?: boolean; service?: MeetingServiceKey; notetaker?: NotetakerChoice }) =>
    post<Meeting>(`/projects/${projectId}/meetings/schedule`, b),
  get: (id: string) => get<Meeting>(`/meetings/${id}`),
  cancel: (id: string) => post(`/meetings/${id}/cancel`, {}),
  reschedule: (id: string, b: { startTime: string; endTime: string }) => post<Meeting>(`/meetings/${id}/reschedule`, b),
  addParticipant: (id: string, userId: string) => post<Meeting>(`/meetings/${id}/participants`, { userId }),
  removeParticipant: (id: string, userId: string) => del<Meeting>(`/meetings/${id}/participants/${userId}`),
  /** A meeting for the workspace as a whole (no project): its own invitee list and endpoint; Google, Outlook or our own calls hold it. */
  workspaceParticipants: () => get<MeetingParticipant[]>('/meetings/participants'),
  scheduleForWorkspace: (b: { title: string; description?: string; startTime: string; endTime: string; timeZone: string; participantUserIds?: string[]; repeat?: { frequency: 'Daily' | 'Weekdays' | 'Weekly'; occurrences: number }; scrum?: boolean; service?: MeetingServiceKey }) =>
    post<{ id: string; title: string; meetUri: string; calendarUrl: string | null; participantCount: number; provider?: MeetingProvider; providerName?: string }>('/meetings/schedule', b),
  workspaceGet: (id: string) => get<WorkspaceMeetingDetail>(`/meetings/workspace/${id}`),
  workspaceCancel: (id: string) => post(`/meetings/workspace/${id}/cancel`, {}),
  workspaceReschedule: (id: string, b: { startTime: string; endTime: string }) => post<WorkspaceMeetingDetail>(`/meetings/workspace/${id}/reschedule`, b),
  /** Posts the stand-up summary for a project meeting to the project chat now. */
  standupSummary: (id: string) => post<StandupCard>(`/meetings/${id}/standup-summary`, {}),
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
  unassigned?: boolean;
}
export const opsApi = {
  settings: () => get<OpsSettings>('/operations/settings'),
  saveSettings: (b: { businessHoursOnly: boolean; dayStartMinutes: number; dayEndMinutes: number; workDays: number[]; timeZone: string; escalateOnBreach: boolean; escalateToUserId: string | null }) => put<OpsSettings>('/operations/settings', b),
  addRule: (b: RoutingRuleInput) => post<OpsSettings>('/operations/routing', b),
  saveRule: (id: string, b: RoutingRuleInput) => put<OpsSettings>(`/operations/routing/${id}`, b),
  removeRule: (id: string) => del<OpsSettings>(`/operations/routing/${id}`),
  triage: (b: { title: string; description?: string | null; workTypeId?: string | null }) => post<Triage>('/operations/triage', b),
  bulk: (b: { ids: string[]; status?: string; assigneeId?: string; unassign?: boolean; priority?: string; dueDate?: string; clearDueDate?: boolean }) => post<{ updated: number; failed: { id: string; message: string }[] }>('/operations/bulk', b),
  insights: (days = 90) => get<OpsInsights>('/operations/insights', { days }),
};
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
  create: (b: WorkTaskInput) => create<WorkTask>('/work-tasks', b),
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

export const personalCalendarApi = {
  options: () => get<{enabled:boolean; account:string|null; calendarAccess:boolean}>('/me/calendar-proposals/options'),
  list: () => get<import('./types').PersonalCalendarProposal[]>('/me/calendar-proposals'),
  get: (id:string) => get<import('./types').PersonalCalendarProposal>('/me/calendar-proposals/'+id),
  save: (body:{title:string;description:string;start:string;end:string;timeZone:string}) => post<import('./types').PersonalCalendarProposal>('/me/calendar-proposals',body),
  availability: (id:string,version:number) => get<{version:number;blockingEvents:number;scope:string}>('/me/calendar-proposals/'+id+'/availability',{version}),
  confirm: (id:string,body:{version:number;confirmed:boolean;account:string}) => post<import('./types').PersonalCalendarProposal>('/me/calendar-proposals/'+id+'/confirm',body),
  reconcile: (id:string) => post<import('./types').PersonalCalendarProposal>('/me/calendar-proposals/'+id+'/reconcile'),
  remove: (id:string) => del('/me/calendar-proposals/'+id),
};

export const microsoftCalendarApi = {
  list: (signal?: AbortSignal) => get<import('./types').MicrosoftCalendarInventory>('/me/microsoft-calendars', undefined, { signal }),
  availability: (body: {calendarIds: string[]; accessContext: string; start: string; end: string}, signal?: AbortSignal) => post<import('./types').MicrosoftCalendarAvailability>('/me/microsoft-calendars/availability', body, { signal }),
};

export type MeetingServiceKey = 'auto' | 'google' | 'microsoft' | 'ours';
export type SlackMessagesChoice = 'off' | 'needs' | 'all';
export interface MeetingServiceChoice { preference: MeetingServiceKey; provider: Exclude<MeetingServiceKey, 'auto'>; name: string; reason: string; googleReady: boolean; microsoftReady: boolean; ownCallsReady: boolean }
export interface ConnectedAccounts {
  google: GoogleConnectionStatus;
  microsoft: MicrosoftConnectionStatus;
  slack: { available: boolean; workspaceConnected: boolean; teamName: string | null; linked: boolean; name: string | null; messages: SlackMessagesChoice; problem: string | null };
  gitHub: { available: boolean; linked: boolean; email: string | null; appInstalled: boolean };
  meetingService: MeetingServiceKey;
  meetings: MeetingServiceChoice | null;
  meetingProblem: string | null;
}

/** My account > Connected accounts: every connected account in one answer, the meeting service and Slack choices, and the person's Slack link. */
export const connectedAccountsApi = {
  get: () => get<ConnectedAccounts>('/me/connected-accounts'),
  save: (b: { meetingService?: MeetingServiceKey; slackMessages?: SlackMessagesChoice }) => put<ConnectedAccounts>('/me/connected-accounts', b),
  slackConnect: async () => {
    const r = await get<{ url: string }>('/integrations/slack/me/connect');
    await get('/integrations/slack/me/callback/browser-check');
    return r;
  },
  slackUnlink: () => del('/integrations/slack/me'),
};
