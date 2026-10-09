import { del, download, get, post, put, uploadFile } from './client';
import type { ReportExport,InvoiceSeller,EmailOverview,EmailBlocked,EmailDomainCheck,UnsubscribeInfo,Priority,DocumentType,DocumentPage,DocumentDetail,DocumentFilters,DocumentVisibility,LinkedWork,LinkedDocuments,LinkTarget,LinkRelation,DocVersions,DocVersionContent,VersionDiff,DocAccess,DocAccessLevel,GrantPrincipal,DocFile,DocWorkflows,DocWorkflow,ApiOverview,EndpointPage,EndpointDetail,SaveEndpoint,SaveDefinition,ApiImportResult,ApiChanges,EndpointHit,SaveWorkflow,DocumentReview,DocumentInbox,DocumentGate,AccessRequest,Requirement,Coverage,DocActivity,DocAuditPage,SecretClass,DocumentDashboard,SecretList,SecretReveal,StepUpToken,ChainStatus,DocSecurity,Passkey,PasskeyChallenge,AuthResponse } from './types';

// ---- passkeys: sign in with the device's own fingerprint, face or screen lock
export const passkeyApi = {
  list: () => get<Passkey[]>('/me/passkeys'),
  registerOptions: () => post<PasskeyChallenge>('/me/passkeys/options', {}),
  add: (challengeId: string, response: Record<string, unknown>, name: string) => post<Passkey>('/me/passkeys', { challengeId, response, name }),
  rename: (id: string, name: string) => put<void>(`/me/passkeys/${id}`, { name }),
  remove: (id: string) => del(`/me/passkeys/${id}`),
  signInOptions: (email: string) => post<PasskeyChallenge>('/auth/passkey/options', { email }, { auth: false }),
  signIn: (challengeId: string, response: Record<string, unknown>) => post<AuthResponse>('/auth/passkey/verify', { challengeId, response }, { auth: false }),
};

export const invoiceSellerApi = {
  get: () => get<InvoiceSeller>('/admin/invoice-seller'),
  set: (b: InvoiceSeller) => put<InvoiceSeller>('/admin/invoice-seller', b),
};
export const emailAdminApi = {
  overview: (status?: string) => get<EmailOverview>('/admin/email', { status }),
  blocked: () => get<EmailBlocked[]>('/admin/email/suppressions'),
  unblock: (id: string) => del(`/admin/email/suppressions/${id}`),
  domain: (domain?: string) => get<EmailDomainCheck>('/admin/email/domain-check', { domain }),
};
export const unsubscribeApi = {
  info: (token: string) => get<UnsubscribeInfo>('/email/unsubscribe', { token }, { auth: false }),
  confirm: (token: string) => post<UnsubscribeInfo>(`/email/unsubscribe?token=${encodeURIComponent(token)}`, {}, { auth: false }),
};

export const documentApi = {
  types: () => get<DocumentType[]>('/document-types'),
  list: (f: DocumentFilters = {}) => get<DocumentPage>('/documents', { ...f }),
  get: (id: string) => get<DocumentDetail>(`/documents/${id}`),
  create: (b: { title: string; typeId: string; projectId?: string | null; teamId?: string | null; visibility?: DocumentVisibility; tags?: string[]; sections?: { key: string; content: string }[] }) => post<DocumentDetail>('/documents', b),
  update: (id: string, b: { title: string; visibility: DocumentVisibility; tags: string[]; ownerId?: string | null; revision: number; teamId?: string | null }) => put<DocumentDetail>(`/documents/${id}`, b),
  saveSections: (id: string, b: { revision: number; sections: { key: string; content: string }[] }) => put<DocumentDetail>(`/documents/${id}/sections`, b),
  archive: (id: string) => post<DocumentDetail>(`/documents/${id}/archive`),
  reopen: (id: string) => post<DocumentDetail>(`/documents/${id}/reopen`),
  restore: (id: string) => post<DocumentDetail>(`/documents/${id}/restore`),
  remove: (id: string) => del(`/documents/${id}`),
  links: (id: string) => get<LinkedWork>(`/documents/${id}/links`),
  addLink: (id: string, b: { targetType: LinkTarget; targetId: string; relation: LinkRelation; requirementId?: string | null }) => post<LinkedWork>(`/documents/${id}/links`, b),
  removeLink: (id: string, linkId: string) => del(`/documents/${id}/links/${linkId}`),
  linkedTo: (targetType: LinkTarget, targetId: string) => get<LinkedDocuments>('/linked-documents', { targetType, targetId }),
  versions: (id: string) => get<DocVersions>(`/documents/${id}/versions`),
  version: (id: string, versionId: string) => get<DocVersionContent>(`/documents/${id}/versions/${versionId}`),
  compare: (id: string, from: string, to: string) => get<VersionDiff>(`/documents/${id}/compare`, { from, to }),
  publish: (id: string, b: { changeSummary: string; changeReason?: string; major: boolean; revision: number }) => post<DocVersions>(`/documents/${id}/publish`, b),
  restoreVersion: (id: string, versionId: string, b: { reason?: string; discardChanges: boolean; revision: number }) => post<DocVersions>(`/documents/${id}/versions/${versionId}/restore`, b),
  access: (id: string) => get<DocAccess>(`/documents/${id}/access`),
  grant: (id: string, b: { principalType: GrantPrincipal; principalId: string; level: DocAccessLevel; deny?: boolean; expiresAt?: string | null; note?: string }) => post<DocAccess>(`/documents/${id}/grants`, b),
  removeGrant: (id: string, grantId: string) => del<DocAccess>(`/documents/${id}/grants/${grantId}`),
  files: (id: string) => get<DocFile[]>(`/documents/${id}/files`),
  uploadFile: (id: string, file: File) => uploadFile<DocFile>(`/documents/${id}/files`, file),
  removeFile: (id: string, fileId: string) => del(`/documents/${id}/files/${fileId}`),
  // review and workflow
  workflows: () => get<DocWorkflows>('/document-workflows'),
  createWorkflow: (b: SaveWorkflow) => post<DocWorkflow>('/document-workflows', b),
  updateWorkflow: (id: string, b: SaveWorkflow) => put<DocWorkflow>(`/document-workflows/${id}`, b),
  removeWorkflow: (id: string) => del(`/document-workflows/${id}`),
  review: (id: string) => get<DocumentReview>(`/documents/${id}/review`),
  submit: (id: string, b: { changeSummary: string; changeReason?: string; major: boolean; revision: number }) => post<DocumentReview>(`/documents/${id}/submit`, b),
  approve: (id: string, comment?: string) => post<DocumentReview>(`/documents/${id}/approve`, { comment }),
  requestChanges: (id: string, comment: string) => post<DocumentReview>(`/documents/${id}/request-changes`, { comment }),
  withdraw: (id: string, comment?: string) => post<DocumentReview>(`/documents/${id}/withdraw`, { comment }),
  inbox: () => get<DocumentInbox>('/documents/inbox'),
  // asking for access
  gate: (id: string) => get<DocumentGate>(`/documents/${id}/gate`),
  requestAccess: (id: string, b: { level: DocAccessLevel; reason: string; durationDays: number | null }) => post<AccessRequest>(`/documents/${id}/access-requests`, b),
  accessRequests: (id: string) => get<AccessRequest[]>(`/documents/${id}/access-requests`),
  decideAccess: (requestId: string, b: { approve: boolean; level?: DocAccessLevel; durationDays?: number | null; note?: string }) => post<AccessRequest>(`/access-requests/${requestId}/decide`, b),
  cancelAccess: (requestId: string) => post<AccessRequest>(`/access-requests/${requestId}/cancel`),
  // diagrams, PDF and overview
  renderDiagram: (source: string) => post<{ svg: string; width: number; height: number; nodes: number; edges: number }>('/documents/diagrams/render', { source }),
  exportPdf: (id: string, versionId?: string | null) => post<ReportExport>(`/documents/${id}/export`, { versionId: versionId ?? null }),
  exportStatus: (id: string, exportId: string) => get<ReportExport>(`/documents/${id}/exports/${exportId}`),
  dashboard: () => get<DocumentDashboard>('/documents/dashboard'),
  // sensitive values
  secrets: (id: string) => get<SecretList>(`/documents/${id}/secrets`),
  saveSecret: (id: string, secretId: string | null, b: { label: string; value?: string; note?: string; class: SecretClass }) => secretId ? put<SecretList>(`/documents/${id}/secrets/${secretId}`, b) : post<SecretList>(`/documents/${id}/secrets`, b),
  removeSecret: (id: string, secretId: string) => del<SecretList>(`/documents/${id}/secrets/${secretId}`),
  reveal: (id: string, secretId: string, stepUp?: string) => post<SecretReveal>(`/documents/${id}/secrets/${secretId}/reveal`, { stepUp }),
  stepUp: (code: string) => post<StepUpToken>('/documents/step-up', { code }),
  security: () => get<DocSecurity>('/document-security'),
  setRevealSeconds: (seconds: number) => put<DocSecurity>('/document-security/reveal-duration', { seconds }),
  rotateKey: () => post<DocSecurity>('/document-security/rotate-key'),
  verifyAudit: () => post<ChainStatus>('/document-security/verify-audit'),
  // requirements and coverage
  requirements: (id: string) => get<Requirement[]>(`/documents/${id}/requirements`),
  addRequirements: (id: string, titles: string[]) => post<Requirement[]>(`/documents/${id}/requirements`, { titles }),
  updateRequirement: (id: string, rid: string, b: { title: string; detail?: string | null; priority?: Priority }) => put<Requirement[]>(`/documents/${id}/requirements/${rid}`, b),
  removeRequirement: (id: string, rid: string) => del<Requirement[]>(`/documents/${id}/requirements/${rid}`),
  coverage: (id: string) => get<Coverage>(`/documents/${id}/coverage`),
  // activity and audit
  activity: (id: string) => get<DocActivity[]>(`/documents/${id}/activity`),
  audit: (id: string, cursor?: string, action?: string) => get<DocAuditPage>(`/documents/${id}/audit`, { cursor, action }),
  exportAudit: (id: string) => download(`/documents/${id}/audit/export`, `document-audit.csv`),
};

export const apiDocApi = {
  overview: (id: string, versionId?: string | null) => get<ApiOverview>(`/documents/${id}/api`, { versionId: versionId ?? undefined }),
  addDefinition: (id: string, b: SaveDefinition) => post<ApiOverview>(`/documents/${id}/api/definitions`, b),
  updateDefinition: (id: string, defId: string, b: SaveDefinition) => put<ApiOverview>(`/documents/${id}/api/definitions/${defId}`, b),
  removeDefinition: (id: string, defId: string) => del<ApiOverview>(`/documents/${id}/api/definitions/${defId}`),
  endpoints: (id: string, f: { definitionId?: string; q?: string; method?: string; tag?: string; versionId?: string | null; cursor?: string; limit?: number }) => get<EndpointPage>(`/documents/${id}/api/endpoints`, { ...f, versionId: f.versionId ?? undefined }),
  endpoint: (id: string, endpointId: string, versionId?: string | null) => get<EndpointDetail>(`/documents/${id}/api/endpoints/${endpointId}`, { versionId: versionId ?? undefined }),
  addEndpoint: (id: string, b: SaveEndpoint) => post<EndpointDetail>(`/documents/${id}/api/endpoints`, b),
  updateEndpoint: (id: string, endpointId: string, b: SaveEndpoint) => put<EndpointDetail>(`/documents/${id}/api/endpoints/${endpointId}`, b),
  removeEndpoint: (id: string, endpointId: string) => del(`/documents/${id}/api/endpoints/${endpointId}`),
  import: (id: string, b: { content: string; fileName: string; definitionId?: string | null; newDefinitionName?: string | null; mode: 'merge' | 'replace'; dryRun: boolean }) => post<ApiImportResult>(`/documents/${id}/api/import`, b),
  export: (id: string, format: 'openapi' | 'postman', definitionId: string, versionId: string | null, fileName: string) =>
    download(`/documents/${id}/api/export?format=${format}&definitionId=${definitionId}${versionId ? `&versionId=${versionId}` : ''}`, fileName),
  changes: (id: string, from: string, to: string) => get<ApiChanges>(`/documents/${id}/api/changes`, { from, to }),
  search: (q: string, projectId?: string) => get<EndpointHit[]>('/api-search', { q, projectId }),
};
