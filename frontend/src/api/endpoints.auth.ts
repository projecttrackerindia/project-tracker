import { del, get, post, put, uploadFile, fetchBlobUrl } from './client';
import type { AppContext,AuthResponse,MfaChallenge,MfaSetup,MfaStatus,PasswordPolicy,NotificationPreference,TestEmailResult,Invitation,InvitationLookup,Member,MemberProfile,PermissionMatrix,OrgSecurity,ProjectVisibility,Session,Team,TeamDetail,User,Workspace,ExternalProvider,SsoDiscovery,UserLogin,SsoSettings,SsoConnectionInput,ScimToken,WorkspaceLogo,GroupMappings } from './types';

export const authApi = {
  passwordPolicy: () => get<PasswordPolicy>('/auth/password-policy', undefined, { auth: false }),
  register: (b: { email: string; password: string; displayName: string; acceptedTerms: boolean }) => post<{ userId: string; requiresEmailVerification: boolean }>('/auth/register', b, { auth: false }),
  login: (b: { email: string; password: string }) => post<AuthResponse | MfaChallenge>('/auth/login', b, { auth: false }),
  loginMfa: (b: { challenge: string; code: string }) => post<AuthResponse>('/auth/login/mfa', b, { auth: false }),
  logout: () => post('/auth/logout', {}, { auth: true, retry: false }),
  logoutAll: () => post('/auth/logout-all'),
  verifyEmail: (token: string) => post('/auth/verify-email', { token }, { auth: false }),
  resendVerification: (email: string) => post('/auth/resend-verification', { email }, { auth: false }),
  forgotPassword: (email: string) => post('/auth/forgot-password', { email }, { auth: false }),
  resetPassword: (b: { token: string; password: string }) => post('/auth/reset-password', b, { auth: false }),
  /** Google / Microsoft / GitHub / Apple sign-in options this installation has set up. */
  providers: () => get<{ providers: ExternalProvider[] }>('/auth/providers', undefined, { auth: false }),
  /** Whether an email address signs in through its organization's single sign-on. */
  ssoDiscover: (email: string) => post<SsoDiscovery>('/auth/sso/discover', { email }, { auth: false }),
};

export const meApi = {
  context: () => get<AppContext>('/me'),
  fingerprint: () => get<{ fingerprint: string }>('/me/fingerprint'),
  updateProfile: (b: { displayName: string; timeZone?: string }) => put<User>('/me', b),
  changePassword: (b: { currentPassword: string; newPassword: string }) => post('/me/password', b),
  mfaStatus: () => get<MfaStatus>('/me/mfa'),
  mfaSetup: (password: string) => post<MfaSetup>('/me/mfa/setup', { password }),
  mfaEnable: (code: string) => post<{ codes: string[] }>('/me/mfa/enable', { code }),
  mfaDisable: (password: string, code: string) => post('/me/mfa/disable', { password, code }),
  mfaRecoveryCodes: (password: string, code: string) => post<{ codes: string[] }>('/me/mfa/recovery-codes', { password, code }),
  sessions: () => get<Session[]>('/me/sessions'),
  revokeSession: (id: string) => del(`/me/sessions/${id}`),
  notificationPrefs: () => get<NotificationPreference[]>('/me/notification-preferences'),
  setNotificationPrefs: (items: { type: string; inApp: boolean; email: boolean; browser: boolean }[]) => put<NotificationPreference[]>('/me/notification-preferences', { items }),
  testEmail: () => post<TestEmailResult>('/me/notification-preferences/test-email'),
  /** Outside accounts connected to mine. */
  logins: () => get<UserLogin[]>('/me/logins'),
  unlinkLogin: (id: string) => del(`/me/logins/${id}`),
  /** Starts connecting Google / Microsoft / GitHub / Apple: returns where to send the browser. */
  linkLogin: (provider: string) => post<{ url: string }>(`/auth/external/${provider}/link`),
  setAvatar: (file: File) => uploadFile<void>('/me/avatar', file),
  removeAvatar: () => del('/me/avatar'),
};

/** Workspace settings → Single sign-on (owners and admins of an organization). */
export const ssoApi = {
  get: () => get<SsoSettings>('/workspace/sso'),
  save: (b: SsoConnectionInput) => put<SsoSettings>('/workspace/sso/connection', b),
  check: () => post<{ ok: boolean; message: string; issuer: string | null }>('/workspace/sso/check'),
  addDomain: (domain: string) => post<SsoSettings>('/workspace/sso/domains', { domain }),
  verifyDomain: (id: string) => post<SsoSettings>(`/workspace/sso/domains/${id}/verify`),
  removeDomain: (id: string) => del<SsoSettings>(`/workspace/sso/domains/${id}`),
  createScimToken: (name: string) => post<{ token: ScimToken; secret: string }>('/workspace/sso/scim-tokens', { name }),
  revokeScimToken: (id: string) => del<SsoSettings>(`/workspace/sso/scim-tokens/${id}`),
  groupMappings: () => get<GroupMappings>('/workspace/sso/group-mappings'),
  addGroupMapping: (group: string, teamId: string) => post<GroupMappings>('/workspace/sso/group-mappings', { group, teamId }),
  removeGroupMapping: (id: string) => del<GroupMappings>(`/workspace/sso/group-mappings/${id}`),
};

export const workspaceApi = {
  list: () => get<Workspace[]>('/workspaces'),
  create: (b: { name: string; description?: string }) => post<Workspace>('/workspaces', b),
  switch: (id: string) => post<{ accessToken: string; expiresAt: string }>(`/workspaces/${id}/switch`),
  update: (b: { name: string; description?: string }) => put<Workspace>('/workspace', b),
  logo: () => get<WorkspaceLogo>('/workspace/logo'),
  uploadLogo: (file: File) => uploadFile<WorkspaceLogo>('/workspace/logo', file),
  removeLogo: () => del<WorkspaceLogo>('/workspace/logo'),
  members: () => get<Member[]>('/workspace/members'),
  setRole: (userId: string, role: string) => put<Member>(`/workspace/members/${userId}`, { role }),
  removeMember: (userId: string) => del(`/workspace/members/${userId}`),
  invitations: () => get<Invitation[]>('/workspace/invitations'),
  invite: (b: { email: string; role: string; orgRoleId?: string | null; reportsToUserId?: string | null }) => post<Invitation>('/workspace/invitations', b),
  /** Creates the account directly (instead of inviting): the first password is chosen by the administrator and must be replaced at first sign-in. */
  createMember: (b: { email: string; displayName: string; role: string; password: string; orgRoleId?: string | null; reportsToUserId?: string | null }) => post<Member>('/workspace/members', b),
  revokeInvitation: (id: string) => del(`/workspace/invitations/${id}`),
  permissions: () => get<PermissionMatrix>('/workspace/permissions'),
  setPermission: (b: { role: string; permission: string; allowed: boolean }) => put<PermissionMatrix>('/workspace/permissions', b),
  lookupInvitation: (token: string) => get<InvitationLookup>('/invitations/lookup', { token }, { auth: false }),
  acceptInvitation: (token: string) => post<Workspace>('/invitations/accept', { token }),
  security: () => get<OrgSecurity>('/workspace/security'),
  setSecurity: (b: { requireMfa: boolean; ipAllowlistEnabled: boolean; ipRanges: string[] }) => put<OrgSecurity>('/workspace/security', b),
  projectVisibility: () => get<ProjectVisibility>('/workspace/project-visibility'),
  setProjectVisibility: (mode: 'organization' | 'teams') => put<ProjectVisibility>('/workspace/project-visibility', { mode }),
  memberProfile: (userId: string) => get<MemberProfile>(`/workspace/members/${userId}/profile`),
  /** An authenticated object URL for a member's photo; caller must revoke it when done. */
  memberAvatarUrl: (userId: string, signal?: AbortSignal) => fetchBlobUrl(`/workspace/members/${userId}/avatar`, signal),
};

export const teamApi = {
  list: () => get<Team[]>('/teams'),
  get: (id: string) => get<TeamDetail>(`/teams/${id}`),
  create: (b: { name: string; description?: string; parentTeamId?: string | null }) => post<TeamDetail>('/teams', b),
  update: (id: string, b: { name: string; description?: string; parentTeamId?: string | null }) => put<TeamDetail>(`/teams/${id}`, b),
  remove: (id: string) => del(`/teams/${id}`),
  addMember: (id: string, b: { userId: string; isLead: boolean }) => post<TeamDetail>(`/teams/${id}/members`, b),
  removeMember: (id: string, userId: string) => del<TeamDetail>(`/teams/${id}/members/${userId}`),
};
