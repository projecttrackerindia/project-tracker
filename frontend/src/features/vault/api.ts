import { del, downloadPost, get, post, postBytes, postForm, put, uploadFile } from '../../api/client';
import type { PasskeyChallenge } from '../../api/types';

export type VaultCollectionKind = 'Personal' | 'Shared' | 'Project' | 'Team';
export type VaultItemKind = 'Login' | 'ApiKey' | 'Server' | 'Database' | 'Card' | 'Note' | 'Other';
export type VaultAccess = 'None' | 'UseOnly' | 'View' | 'Manage';
export type VaultPrincipal = 'User' | 'Team' | 'Role' | 'Project';
export type VaultClass = 'Secret' | 'Confidential';
export type VaultHealthFlag = 'weak' | 'reused' | 'breached' | 'expired' | 'old' | 'rotate';
export type FieldType = 'text' | 'password' | 'totp' | 'note' | 'key' | 'url';
interface UserRef { id: string; name: string }

export interface VaultField { key: string; label: string; type: FieldType; secret: boolean; value: string | null }
export interface VaultLink { kind: 'task' | 'document' | 'project' | 'work'; id: string; label: string }
export interface VaultItemSummary {
  id: string; collectionId: string; collectionName: string; kind: VaultItemKind; title: string; url: string | null; usernameHint: string | null;
  tags: string[]; class: VaultClass; useOnly: boolean; owner: UserRef | null; hasTotp: boolean; strength: number | null; breached: boolean; reused: boolean;
  expiresAt: string | null; expired: boolean; rotationReason: string | null; valueChangedAt: string | null; lastUsedAt: string | null; myAccess: VaultAccess;
  health: VaultHealthFlag[];
}
export interface VaultVersion { id: string; at: string; by: UserRef | null; reason: string | null }
export interface VaultAttachment { id: string; fileName: string; contentType: string; sizeBytes: number; at: string }
export interface VaultItem {
  item: VaultItemSummary; fields: VaultField[]; links: VaultLink[]; versions: VaultVersion[]; attachments: VaultAttachment[];
  canReveal: boolean; canCopy: boolean; canManage: boolean; needsStepUp: boolean; rotateEveryDays: number | null; createdAt: string; createdBy: UserRef | null;
}
export interface VaultShare { id: string; principalType: VaultPrincipal; principalId: string | null; role: string | null; name: string; access: VaultAccess; expiresAt: string | null }
export interface VaultCollection {
  id: string; name: string; description: string | null; kind: VaultCollectionKind; projectId: string | null; projectName: string | null; teamId: string | null; teamName: string | null;
  myAccess: VaultAccess; items: number; atRisk: number; requireStepUp: boolean; rotateEveryDays: number | null; locked: boolean; shares: VaultShare[] | null;
  sealed: boolean; rekeyNeeded: boolean; keyVersion: number; requireApproval: boolean; requestable: boolean;
}
export interface VaultPolicy { stepUpAlways: boolean; clipboardSeconds: number; revealSeconds: number; sharedAdminsOnly: boolean }
export interface VaultHealth { total: number; weak: number; reused: number; breached: number; expired: number; old: number; toRotate: number; score: number }
export interface VaultIdentity { userId: string; x25519Public: string; mlKemPublic: string; ed25519Public: string; selfSignature: string; fingerprint: string; generation: number }
export interface VaultOverview { collections: VaultCollection[]; policy: VaultPolicy; canAdmin: boolean; canCreateShared: boolean; health: VaultHealth; mfaEnabled: boolean; identity: VaultIdentity | null; hasPasskeys: boolean }
export type UnlockKind = 'Passkey' | 'RecoveryKey';
export interface VaultUnlock { id: string; kind: UnlockKind; label: string; credentialId: string | null; salt: string; params: string; wrappedSeed: string; createdAt: string; lastUsedAt: string | null }
export interface VaultKeysMe { identity: VaultIdentity | null; unlocks: VaultUnlock[] }
export interface UnlockInput { kind: UnlockKind; label?: string; credentialId?: string | null; salt: string; params: string; wrappedSeed: string }
export interface VaultEnvelope { keyVersion: number; envelope: string; signature: string; senderUserId: string; senderEd25519Public: string | null; recipientGeneration: number }
export interface VaultRecipient { userId: string; name: string; access: VaultAccess; identity: VaultIdentity | null }
export interface CollectionKeys { collectionId: string; sealed: boolean; keyVersion: number; rekeyNeeded: boolean; myAccess: VaultAccess; mine: VaultEnvelope[]; pending: VaultRecipient[] | null }
export interface EnvelopeInput { recipientUserId: string; keyVersion: number; recipientGeneration: number; envelope: string; signature: string }
export interface SealedFile { id: string; keyVersion: number; wrapped: string; sizeBytes: number; at: string }
export interface SealedItemRow {
  id: string; collectionId: string; kind: VaultItemKind; keyVersion: number; blob: string; expiresAt: string | null; rotateEveryDays: number | null; rotationReason: string | null;
  createdAt: string; updatedAt: string | null; valueChangedAt: string | null; deletedAt: string | null; myAccess: VaultAccess; files: SealedFile[]; versions: number;
}
export interface SealedVersionRow { id: string; keyVersion: number; blob: string; at: string; by: UserRef | null; reason: string | null }
export interface ExportItem { id: string; kind: VaultItemKind; title: string; url: string | null; tags: string[]; class: VaultClass; fields: VaultField[]; expiresAt: string | null; rotateEveryDays: number | null; files: { id: string; fileName: string; contentType: string; data: string }[] }
export interface DeviceLink { id: string; label: string; x25519Public: string; mlKemPublic: string; createdAt: string; expiresAt: string; ipAddress: string | null; userAgent: string | null; approved: boolean; denied: boolean; envelope: string | null; signature: string | null }
export interface VaultCircle { threshold: number; members: { person: UserRef; stale: boolean }[]; createdAt: string; usable: boolean }
export interface VaultRecoveryRelease { trustee: UserRef; trusteeEd25519Public: string | null; envelope: string | null; signature: string | null; refused: boolean; at: string }
export interface VaultRecoveryStatus { id: string; threshold: number; helpers: number; createdAt: string; expiresAt: string; completed: boolean; cancelled: boolean; releases: VaultRecoveryRelease[] }
export interface VaultRecoveryToHelp {
  requestId: string; person: UserRef; x25519Public: string; mlKemPublic: string; createdAt: string; expiresAt: string; ipAddress: string | null; userAgent: string | null;
  shareEnvelope: string; shareSignature: string; ownerEd25519Public: string; ownerGeneration: number; threshold: number;
}
export interface SecretLink { id: string; note: string | null; itemId: string | null; itemTitle: string | null; createdAt: string; expiresAt: string; views: number; maxViews: number; hasPassphrase: boolean; state: 'open' | 'used' | 'expired' | 'revoked'; lastOpenedAt: string | null }
export interface SecretLinkInfo { state: 'ready' | 'gone'; note: string | null; from: string | null; workspace: string | null; hasPassphrase: boolean; salt: string | null; params: string | null; expiresAt: string | null; viewsLeft: number }
export const LINK_HOURS = [1, 24, 72, 168] as const;
export interface VaultReveal { value: string; revealSeconds: number; clipboardSeconds: number }
export interface VaultTotp { code: string; secondsLeft: number; period: number; digits: number }
export interface VaultActivity { at: string; action: string; by: UserRef | null; field: string | null; ipAddress: string | null }
export interface VaultAccessReview {
  person: UserRef; collections: { id: string; name: string; access: VaultAccess; items: number }[];
  used: { itemId: string; title: string; collection: string; times: number; last: string }[];
}

export type VaultRequestKind = 'Reveal' | 'Collection';
export type VaultRequestStatus = 'Pending' | 'Approved' | 'Denied' | 'Cancelled' | 'Expired';
export interface VaultRequest {
  id: string; kind: VaultRequestKind; collectionId: string; collectionName: string; itemId: string | null; itemTitle: string | null; requester: UserRef; reason: string;
  access: VaultAccess; minutes: number; status: VaultRequestStatus; decidedBy: UserRef | null; decidedAt: string | null; decisionNote: string | null; grantedUntil: string | null;
  createdAt: string; canDecide: boolean;
}
export interface VaultRequests { mine: VaultRequest[]; toDecide: VaultRequest[] }
export interface VaultRequestable { id: string; name: string; description: string | null; kind: VaultCollectionKind; sealed: boolean }
export interface VaultDecoy { itemId: string; title: string; collectionName: string; triggered: number; lastTriggeredAt: string | null }
export const REVEAL_MINUTES = [15, 30, 60, 240] as const;
export const COLLECTION_MINUTES = [60, 240, 1440, 10080] as const;
export const durationLabel = (m: number) => (m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : m < 1440 ? `${m / 60} hours` : m === 1440 ? '1 day' : m === 10080 ? '1 week' : `${m / 1440} days`);
/** A request that is approved and still running: the window it gives. */
export const activeGrant = (r: VaultRequest) => r.status === 'Approved' && !!r.grantedUntil && Date.parse(r.grantedUntil) > Date.now();

export interface FieldInput { key: string; label?: string | null; type?: FieldType | null; secret: boolean; value?: string | null; keep?: boolean }
export interface SaveItem {
  collectionId: string; kind: VaultItemKind; title: string; url?: string | null; tags?: string[]; class: VaultClass; useOnly: boolean;
  ownerUserId?: string | null; rotateEveryDays?: number | null; expiresAt?: string | null; fields: FieldInput[]; links?: VaultLink[]; reason?: string | null;
}
export interface SaveCollection {
  name: string; description?: string | null; kind: VaultCollectionKind; projectId?: string | null; teamId?: string | null; requireStepUp?: boolean;
  rotateEveryDays?: number | null; shareWithMembers?: VaultAccess | null; sealed?: boolean; requireApproval?: boolean; requestable?: boolean;
}
export interface ShareInput { principalType: VaultPrincipal; principalId?: string | null; role?: string | null; access: VaultAccess; expiresAt?: string | null }
export interface ImportRow { title?: string | null; url?: string | null; username?: string | null; password?: string | null; totp?: string | null; notes?: string | null }

/** Every call that can carry a secret goes straight to the server: nothing here is cached by the query layer except lists of names. */
export const vaultApi = {
  overview: () => get<VaultOverview>('/vault/overview'),
  stepUp: (code: string) => post<{ token: string; expiresAt: string }>('/vault/step-up', { code }),
  stepUpPasskeyOptions: () => post<PasskeyChallenge>('/vault/step-up/passkey/options', {}),
  stepUpPasskey: (challengeId: string, response: Record<string, unknown>) => post<{ token: string; expiresAt: string }>('/vault/step-up/passkey', { challengeId, response }),
  requestReveal: (itemId: string, reason: string, minutes: number) => post<VaultRequest>(`/vault/items/${itemId}/requests`, { reason, minutes }),
  requestable: () => get<VaultRequestable[]>('/vault/requestable'),
  requestCollection: (id: string, reason: string, minutes: number, access: VaultAccess) => post<VaultRequest>(`/vault/collections/${id}/requests`, { reason, minutes, access }),
  requests: () => get<VaultRequests>('/vault/requests'),
  approve: (id: string, note: string | null) => post<VaultRequest>(`/vault/requests/${id}/approve`, { note }),
  deny: (id: string, note: string | null) => post<VaultRequest>(`/vault/requests/${id}/deny`, { note }),
  cancelRequest: (id: string) => post(`/vault/requests/${id}/cancel`, {}),
  setDecoy: (itemId: string, decoy: boolean) => put<VaultDecoy>(`/vault/items/${itemId}/decoy`, { decoy }),
  decoys: () => get<VaultDecoy[]>('/vault/decoys'),
  createCollection: (b: SaveCollection) => post<VaultCollection>('/vault/collections', b),
  collection: (id: string) => get<VaultCollection>(`/vault/collections/${id}`),
  updateCollection: (id: string, b: SaveCollection) => put<VaultCollection>(`/vault/collections/${id}`, b),
  deleteCollection: (id: string) => del(`/vault/collections/${id}`),
  saveShares: (id: string, shares: ShareInput[]) => put<VaultCollection>(`/vault/collections/${id}/shares`, { shares }),
  adminAccess: (id: string, reason: string, stepUp: string) => post<VaultCollection>(`/vault/collections/${id}/admin-access`, { reason, stepUp }),
  items: (q: { collectionId?: string | null; q?: string; kind?: VaultItemKind | null; health?: string | null; bin?: boolean }) =>
    get<VaultItemSummary[]>('/vault/items', { collectionId: q.collectionId ?? undefined, q: q.q || undefined, kind: q.kind ?? undefined, health: q.health ?? undefined, bin: q.bin || undefined }),
  item: (id: string) => get<VaultItem>(`/vault/items/${id}`),
  create: (b: SaveItem) => post<VaultItem>('/vault/items', b),
  update: (id: string, b: SaveItem) => put<VaultItem>(`/vault/items/${id}`, b),
  remove: (id: string) => del(`/vault/items/${id}`),
  restore: (id: string) => post<VaultItem>(`/vault/items/${id}/restore`, {}),
  reveal: (id: string, field: string, copy: boolean, stepUp?: string, forEdit = false) => post<VaultReveal>(`/vault/items/${id}/reveal`, { field, copy, stepUp, forEdit }),
  totp: (id: string, stepUp?: string) => post<VaultTotp>(`/vault/items/${id}/totp`, { stepUp }),
  revealVersion: (id: string, versionId: string, field: string, stepUp?: string, copy = false) => post<VaultReveal>(`/vault/items/${id}/versions/${versionId}/reveal`, { field, stepUp, copy }),
  activity: (id: string) => get<VaultActivity[]>(`/vault/items/${id}/activity`),
  upload: (id: string, file: File) => uploadFile<VaultAttachment>(`/vault/items/${id}/attachments`, file),
  download: (attachmentId: string, fileName: string, stepUp?: string) => downloadPost(`/vault/attachments/${attachmentId}/download`, { stepUp }, fileName),
  removeAttachment: (attachmentId: string) => del(`/vault/attachments/${attachmentId}`),
  importRows: (collectionId: string, rows: ImportRow[]) => post<{ imported: number; skipped: number; weak: number }>('/vault/import', { collectionId, rows }),
  check: (password: string) => post<{ strength: number; breachCount: number }>('/vault/check', { password }),
  savePolicy: (b: { stepUpAlways: boolean; clipboardSeconds: number; sharedAdminsOnly: boolean }) => put<VaultPolicy>('/vault/policy', b),
  accessReview: (userId: string) => get<VaultAccessReview>(`/vault/access-review/${userId}`),

  // ---- sealed (zero-knowledge): the server only ever sees public keys, wrapped keys and ciphertext
  keysMe: () => get<VaultKeysMe>('/vault/keys/me'),
  setupKeys: (b: { x25519Public: string; mlKemPublic: string; ed25519Public: string; selfSignature: string; fingerprint: string; unlocks: UnlockInput[]; reset?: boolean; stepUp?: string }) => post<VaultKeysMe>('/vault/keys/setup', b),
  addUnlock: (b: UnlockInput) => post<VaultKeysMe>('/vault/keys/unlocks', b),
  removeUnlock: (id: string) => del<VaultKeysMe>(`/vault/keys/unlocks/${id}`),
  unlocked: (id: string) => post(`/vault/keys/unlocks/${id}/used`, {}),
  directory: (userIds: string[]) => post<VaultRecipient[]>('/vault/keys/directory', { userIds }),
  collectionKeys: (id: string) => get<CollectionKeys>(`/vault/collections/${id}/keys`),
  saveEnvelopes: (id: string, envelopes: EnvelopeInput[]) => post<CollectionKeys>(`/vault/collections/${id}/keys`, { envelopes }),
  rekey: (id: string, b: { newVersion: number; envelopes: EnvelopeInput[]; items: { id: string; blob: string }[]; versions: { id: string; blob: string }[]; files: { id: string; blob: string }[] }) => post<CollectionKeys>(`/vault/collections/${id}/rekey`, b),
  exportForSealing: (id: string, stepUp?: string) => post<ExportItem[]>(`/vault/collections/${id}/export-for-sealing`, { stepUp }),
  seal: (id: string, b: { stepUp?: string; envelope: EnvelopeInput; items: { id: string; blob: string }[]; files: { id: string; wrapped: string; cipher: string }[] }) => post<CollectionKeys>(`/vault/collections/${id}/seal`, b),
  sealedItems: (id: string, bin = false) => get<SealedItemRow[]>(`/vault/collections/${id}/sealed-items`, { bin: bin || undefined }),
  createSealed: (b: { id: string; collectionId: string; kind: VaultItemKind; keyVersion: number; blob: string; expiresAt?: string | null; rotateEveryDays?: number | null }) => post<SealedItemRow>('/vault/sealed-items', b),
  updateSealed: (id: string, b: { collectionId: string; kind: VaultItemKind; keyVersion: number; blob: string; expiresAt?: string | null; rotateEveryDays?: number | null; valueChanged: boolean; reason?: string | null }) => put<SealedItemRow>(`/vault/sealed-items/${id}`, b),
  sealedVersions: (id: string) => get<SealedVersionRow[]>(`/vault/sealed-items/${id}/versions`),
  sealedEvent: (id: string, action: 'revealed' | 'copied' | 'totp_used', field?: string) => post(`/vault/sealed-items/${id}/events`, { action, field }),
  addSealedFile: (id: string, cipher: Blob, wrapped: string) => postForm<SealedFile>(`/vault/sealed-items/${id}/files`, (() => { const f = new FormData(); f.append('file', cipher, 'sealed.bin'); f.append('wrapped', wrapped); return f; })()),
  sealedFile: (id: string) => postBytes(`/vault/sealed-files/${id}`),
  breachRange: (prefix: string) => get<{ body: string }>(`/vault/breach-range/${prefix}`),
  requestDevice: (b: { label: string; x25519Public: string; mlKemPublic: string }) => post<DeviceLink>('/vault/devices', b),
  pendingDevices: () => get<DeviceLink[]>('/vault/devices/pending'),
  approveDevice: (id: string, envelope: string, signature: string) => post(`/vault/devices/${id}/approve`, { envelope, signature }),
  refuseDevice: (id: string) => post(`/vault/devices/${id}/refuse`, {}),
  deviceStatus: (id: string) => get<DeviceLink>(`/vault/devices/${id}`),
  createLink: (b: { tokenHash: string; itemId: string | null; note: string | null; cipher: string; maxViews: number; hours: number; hasPassphrase: boolean; salt: string | null; params: string | null; stepUp?: string }) =>
    post<SecretLink>('/vault/links', b),
  links: () => get<SecretLink[]>('/vault/links'),
  revokeLink: (id: string) => del(`/vault/links/${id}`),
  linkInfo: (token: string) => get<SecretLinkInfo>(`/secret-links/${encodeURIComponent(token)}`, undefined, { auth: false }),
  openSecretLink: (token: string) => post<{ cipher: string; viewsLeft: number }>(`/secret-links/${encodeURIComponent(token)}/open`, {}, { auth: false, retry: false }),
  circle: () => get<{ circle: VaultCircle | null }>('/vault/keys/circle'),
  setCircle: (b: { threshold: number; shares: { trusteeUserId: string; trusteeGeneration: number; envelope: string; signature: string }[]; stepUp?: string }) => put<VaultCircle>('/vault/keys/circle', b),
  clearCircle: () => del('/vault/keys/circle'),
  startRecovery: (b: { label: string; x25519Public: string; mlKemPublic: string }) => post<VaultRecoveryStatus>('/vault/recovery', b),
  recoveryStatus: (id: string) => get<VaultRecoveryStatus>(`/vault/recovery/${id}`),
  finishRecovery: (id: string, recovered: boolean) => post(`/vault/recovery/${id}/finish?recovered=${recovered}`, {}),
  recoveryToHelp: () => get<VaultRecoveryToHelp[]>('/vault/recovery/to-help'),
  helpRecovery: (id: string, envelope: string, signature: string) => post(`/vault/recovery/${id}/help`, { envelope, signature }),
  refuseRecovery: (id: string) => post(`/vault/recovery/${id}/refuse`, {}),
};

/** The fields each kind starts with (the server applies the same list). */
export const TEMPLATES: Record<VaultItemKind, { key: string; label: string; type: FieldType; secret: boolean }[]> = {
  Login: [{ key: 'username', label: 'User name', type: 'text', secret: false }, { key: 'password', label: 'Password', type: 'password', secret: true }, { key: 'totp', label: 'One-time code (2FA)', type: 'totp', secret: true }, { key: 'note', label: 'Notes', type: 'note', secret: true }],
  ApiKey: [{ key: 'key', label: 'API key', type: 'password', secret: true }, { key: 'secret', label: 'Secret', type: 'password', secret: true }, { key: 'note', label: 'Notes', type: 'note', secret: true }],
  Server: [{ key: 'host', label: 'Host', type: 'text', secret: false }, { key: 'port', label: 'Port', type: 'text', secret: false }, { key: 'username', label: 'User name', type: 'text', secret: false }, { key: 'password', label: 'Password', type: 'password', secret: true }, { key: 'privateKey', label: 'Private key', type: 'key', secret: true }, { key: 'note', label: 'Notes', type: 'note', secret: true }],
  Database: [{ key: 'host', label: 'Host', type: 'text', secret: false }, { key: 'port', label: 'Port', type: 'text', secret: false }, { key: 'database', label: 'Database', type: 'text', secret: false }, { key: 'username', label: 'User name', type: 'text', secret: false }, { key: 'password', label: 'Password', type: 'password', secret: true }, { key: 'connectionString', label: 'Connection string', type: 'password', secret: true }, { key: 'note', label: 'Notes', type: 'note', secret: true }],
  Card: [{ key: 'holder', label: 'Name on card', type: 'text', secret: false }, { key: 'number', label: 'Card number', type: 'password', secret: true }, { key: 'expiry', label: 'Expiry (MM/YY)', type: 'text', secret: false }, { key: 'cvv', label: 'CVV', type: 'password', secret: true }, { key: 'pin', label: 'PIN', type: 'password', secret: true }, { key: 'note', label: 'Notes', type: 'note', secret: true }],
  Note: [{ key: 'note', label: 'Secure note', type: 'note', secret: true }],
  Other: [],
};

export const KIND_LABEL: Record<VaultItemKind, string> = { Login: 'Login', ApiKey: 'API key', Server: 'Server', Database: 'Database', Card: 'Card', Note: 'Secure note', Other: 'Other' };
export const KIND_ICON: Record<VaultItemKind, 'user' | 'key' | 'monitor' | 'database' | 'card' | 'note' | 'lock'> = { Login: 'user', ApiKey: 'key', Server: 'monitor', Database: 'database', Card: 'card', Note: 'note', Other: 'lock' };
export const ACCESS_LABEL: Record<VaultAccess, string> = { None: 'No access', UseOnly: 'Use only', View: 'View', Manage: 'Manage' };
export const ACCESS_HINT: Record<VaultAccess, string> = {
  None: '', UseOnly: 'Can copy values into a sign-in form, never see them', View: 'Can see and copy values', Manage: 'Can also change, share and delete, and read the history',
};
export const HEALTH_LABEL: Record<VaultHealthFlag, string> = {
  weak: 'Weak password', reused: 'Used on another item', breached: 'In a public breach', expired: 'Past its change date', old: 'Not changed in a year', rotate: 'Should be changed',
};
export const ACTION_LABEL: Record<string, string> = {
  'vault.revealed': 'Revealed', 'vault.copied': 'Copied', 'vault.totp_used': 'Took a one-time code', 'vault.version_revealed': 'Revealed an earlier value', 'vault.version_copied': 'Copied an earlier value', 'vault.decoy_triggered': 'Touched a decoy', 'vault.access_requested': 'Asked for access', 'vault.access_approved': 'Approved access', 'vault.access_denied': 'Refused access', 'vault.access_returned': 'Gave access back', 'vault.decoy_set': 'Made it a decoy', 'vault.decoy_cleared': 'Stopped it being a decoy', 'vault.recovery_share_released': 'Helped unlock a vault', 'vault.link_created': 'Sent a one-time link', 'vault.link_opened': 'One-time link opened',
  'vault.reveal_denied': 'Refused', 'vault.unusual_activity': 'Paused for unusual use', 'vault.item_created': 'Created', 'vault.item_changed': 'Changed',
  'vault.item_moved': 'Moved', 'vault.item_deleted': 'Moved to the bin', 'vault.item_restored': 'Restored', 'vault.file_added': 'Added a file', 'vault.file_removed': 'Removed a file',
  'vault.unreadable': 'Could not be read',
};
