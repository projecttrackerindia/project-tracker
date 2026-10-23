using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Domain.Entities;

/// <summary>Whose a collection is: one person's own (nobody else, not even an admin, can open it), or shared through its access list.</summary>
public enum VaultCollectionKind { Personal = 0, Shared = 1, Project = 2, Team = 3 }
public enum VaultItemKind { Login = 0, ApiKey = 1, Server = 2, Database = 3, Card = 4, Note = 5, Other = 6 }
/// <summary>
/// What a share allows. <see cref="UseOnly"/>: copy the value into a sign-in form, never see it. <see cref="View"/>: see and copy.
/// <see cref="Manage"/>: also change, share, delete and read the history.
/// </summary>
public enum VaultAccess { None = 0, UseOnly = 1, View = 2, Manage = 3 }
/// <summary>Who a share is for: one person, everyone in a team, everyone at or above a role, or everyone in a project.</summary>
public enum VaultPrincipal { User = 0, Team = 1, Role = 2, Project = 3 }

/// <summary>A group of credentials with one access list (a project's servers, the finance team's bank portals, my own logins).</summary>
public class VaultCollection : TenantEntity, ITenantScoped
{
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    public VaultCollectionKind Kind { get; set; }
    /// <summary>Personal collections: the only person who can open it.</summary>
    public Guid? OwnerUserId { get; set; }
    public Guid? ProjectId { get; set; }
    public Guid? TeamId { get; set; }
    /// <summary>Every reveal or copy here needs a two-step check made in the last few minutes, whatever the item's class.</summary>
    public bool RequireStepUp { get; set; }
    /// <summary>New items here must be changed every this many days (null: no rule).</summary>
    public int? RotateEveryDays { get; set; }
    /// <summary>A personal collection whose owner left: locked for everyone, destroyed after the grace period.</summary>
    public DateTime? LockedAt { get; set; }
    public DateTime? ArchivedAt { get; set; }
    /// <summary>
    /// Zero-knowledge: items are encrypted in the members' browsers with the collection key, which reaches each member only wrapped to their
    /// own public keys (<see cref="VaultKeyEnvelope"/>). The server stores ciphertext it cannot open.
    /// </summary>
    public bool Sealed { get; set; }
    /// <summary>Sealed: which collection key the items are encrypted with now (it changes when someone loses access).</summary>
    public int SealedKeyVersion { get; set; }
    /// <summary>Sealed: someone who had the key lost access; the next manager to open it makes a new key and re-encrypts everything.</summary>
    public bool RekeyNeeded { get; set; }
    /// <summary>Two-person rule (guarded only): every reveal, copy, code or file needs someone else's approval first, for a limited time.</summary>
    public bool RequireApproval { get; set; }
    /// <summary>Members who are not on the list can see its name and ask for time-boxed access (just-in-time access).</summary>
    public bool Requestable { get; set; }
}

/// <summary>One entry of a collection's access list. A share can end by itself (<see cref="ExpiresAt"/>) for time-boxed access.</summary>
public class VaultShare : TenantEntity, ITenantScoped
{
    public Guid CollectionId { get; set; }
    public VaultPrincipal PrincipalType { get; set; }
    /// <summary>The person, team or project (null for a role share).</summary>
    public Guid? PrincipalId { get; set; }
    /// <summary>Role shares: everyone at this role or above.</summary>
    public TenantRole? Role { get; set; }
    public VaultAccess Access { get; set; } = VaultAccess.View;
    public DateTime? ExpiresAt { get; set; }
}

/// <summary>
/// A credential. Everything secret (passwords, keys, card numbers, the one-time-code seed, secure notes, custom secret fields) lives in
/// <see cref="Cipher"/>: one JSON document encrypted with the item's own key (AES-256-GCM), which is itself encrypted with the workspace's data
/// key (<see cref="WrappedItemKey"/>), which the platform's master key (or Cloud KMS) wraps. A new item key is made every time the secret
/// changes, so an old value lives only in its history row and is destroyed with it. What is shown in lists (title, address, a hint of the user
/// name, tags) is kept plain so it can be searched without decrypting anything.
/// </summary>
public class VaultItem : TenantEntity, ITenantScoped
{
    public Guid CollectionId { get; set; }
    public VaultItemKind Kind { get; set; }
    public string Title { get; set; } = "";
    public string? Url { get; set; }
    /// <summary>"r****@fivestar.in": enough to tell accounts apart, never the whole name.</summary>
    public string? UsernameHint { get; set; }
    public string? Tags { get; set; }
    public SensitivityClass Class { get; set; } = SensitivityClass.Secret;
    /// <summary>Nobody sees the value; it can only be copied into a form (and replaced by a manager).</summary>
    public bool UseOnly { get; set; }
    /// <summary>Who answers for it: told before it expires and when it should be changed.</summary>
    public Guid? OwnerUserId { get; set; }
    /// <summary>The fields (key, label, type, secret or not) without their values, so a screen can lay the item out before anything is revealed.</summary>
    public string FieldsJson { get; set; } = "[]";
    public string Cipher { get; set; } = "";
    public string WrappedItemKey { get; set; } = "";
    /// <summary>Which of the workspace's data keys wraps <see cref="WrappedItemKey"/>.</summary>
    public int KeyVersion { get; set; }
    public bool HasTotp { get; set; }
    /// <summary>A keyed hash (HMAC with the workspace key) of the password, to find the same password used twice without keeping it in the clear.</summary>
    public string? PasswordFingerprint { get; set; }
    /// <summary>0 (very weak) to 4 (strong), measured when it was saved.</summary>
    public int? Strength { get; set; }
    /// <summary>How often the password was seen in public breaches (0: not found), checked by k-anonymity.</summary>
    public int? BreachCount { get; set; }
    public DateTime? BreachCheckedAt { get; set; }
    public int? RotateEveryDays { get; set; }
    public DateTime? ExpiresAt { get; set; }
    public DateTime? ExpiryNotifiedAt { get; set; }
    public DateTime? ValueChangedAt { get; set; }
    public DateTime? LastUsedAt { get; set; }
    public Guid? LastUsedBy { get; set; }
    /// <summary>Someone who could read it left, or it was found in a breach: it should be changed (with the reason).</summary>
    public string? RotationReason { get; set; }
    /// <summary>Tasks, pages and projects that use it: [{ "kind": "task", "id": "…", "label": "PAY-12" }].</summary>
    public string LinksJson { get; set; } = "[]";
    /// <summary>In the bin: restorable for 30 days, then destroyed with its history and attachments.</summary>
    public DateTime? DeletedAt { get; set; }
    public Guid? DeletedBy { get; set; }
    /// <summary>Encrypted in the browser with the collection key (<see cref="Cipher"/> is that ciphertext; title and fields are inside it).</summary>
    public bool Sealed { get; set; }
    /// <summary>A decoy (honeytoken): it looks real, and any reveal, copy, code or download of it alerts the vault admins at once.</summary>
    public bool Decoy { get; set; }
}

/// <summary>An earlier value of an item, kept encrypted with the key it had then. The last ten are kept.</summary>
public class VaultItemVersion : TenantEntity, ITenantScoped
{
    public Guid ItemId { get; set; }
    public string Cipher { get; set; } = "";
    public string WrappedItemKey { get; set; } = "";
    public int KeyVersion { get; set; }
    public string? Reason { get; set; }
    public bool Sealed { get; set; }
}

/// <summary>A small file kept with an item (a key file, a certificate, a recovery sheet), encrypted with the item's key.</summary>
public class VaultAttachment : TenantEntity, ITenantScoped
{
    public Guid ItemId { get; set; }
    public string FileName { get; set; } = "";
    public string ContentType { get; set; } = "application/octet-stream";
    public long SizeBytes { get; set; }
    public byte[] Cipher { get; set; } = [];
    /// <summary>The item key that encrypted it (wrapped), so it survives the item's value changing. Sealed: the file's own key, wrapped by the collection key.</summary>
    public string WrappedItemKey { get; set; } = "";
    public int KeyVersion { get; set; }
    public bool Sealed { get; set; }
}

public enum VaultUnlockKind { Passkey = 0, RecoveryKey = 1 }

/// <summary>
/// A person's vault identity in a workspace: the public halves of an X25519 key, an ML-KEM-768 key (post-quantum) and an Ed25519 signing key.
/// All three come from one secret made in their browser; the server never sees it.
/// </summary>
public class VaultIdentity : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    public string X25519Public { get; set; } = "";
    public string MlKemPublic { get; set; } = "";
    public string Ed25519Public { get; set; } = "";
    /// <summary>The bundle signed with its own Ed25519 key (proof the browser holds the secret).</summary>
    public string SelfSignature { get; set; } = "";
    /// <summary>The safety code people compare to be sure the server did not swap a key.</summary>
    public string Fingerprint { get; set; } = "";
    /// <summary>Goes up when the person resets their keys; envelopes for an older generation no longer open.</summary>
    public int Generation { get; set; } = 1;
}

/// <summary>One way to unlock the identity secret: a passkey (its PRF output) or the printed recovery key. Only the wrapped secret is kept.</summary>
public class VaultUnlock : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    public VaultUnlockKind Kind { get; set; }
    public string Label { get; set; } = "";
    /// <summary>Passkey: its credential id (base64url), so the browser can ask for that one.</summary>
    public string? CredentialId { get; set; }
    public string Salt { get; set; } = "";
    /// <summary>How the unlock key is derived (for a recovery key: the Argon2id cost).</summary>
    public string Params { get; set; } = "";
    public string WrappedSeed { get; set; } = "";
    public DateTime? LastUsedAt { get; set; }
}

/// <summary>A sealed collection's key, encrypted to one member's public keys (hybrid X25519 + ML-KEM-768) and signed by whoever shared it.</summary>
public class VaultKeyEnvelope : TenantEntity, ITenantScoped
{
    public Guid CollectionId { get; set; }
    public int KeyVersion { get; set; }
    public Guid RecipientUserId { get; set; }
    public int RecipientGeneration { get; set; }
    public Guid SenderUserId { get; set; }
    public string Envelope { get; set; } = "";
    public string Signature { get; set; } = "";
}

/// <summary>
/// Linking a new device: it shows a code made from its one-time public keys; a device that is already unlocked shows the same code, and when
/// they match the person approves there, which sends the identity secret encrypted to the new device's one-time keys.
/// </summary>
public class VaultDeviceLink : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    public string Label { get; set; } = "";
    public string X25519Public { get; set; } = "";
    public string MlKemPublic { get; set; } = "";
    public string? Envelope { get; set; }
    public string? Signature { get; set; }
    public DateTime ExpiresAt { get; set; }
    public DateTime? ApprovedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public bool Denied { get; set; }
    public string? IpAddress { get; set; }
    public string? UserAgent { get; set; }
}

public enum VaultRequestKind { Reveal = 0, Collection = 1 }
public enum VaultRequestStatus { Pending = 0, Approved = 1, Denied = 2, Cancelled = 3, Expired = 4 }

/// <summary>
/// Just-in-time access. <see cref="VaultRequestKind.Reveal"/>: one use window for an item in a collection under the two-person rule.
/// <see cref="VaultRequestKind.Collection"/>: time-boxed access to a collection the person is not on. Someone else decides; it ends by itself.
/// </summary>
public class VaultAccessRequest : TenantEntity, ITenantScoped
{
    public VaultRequestKind Kind { get; set; }
    public Guid CollectionId { get; set; }
    public Guid? ItemId { get; set; }
    public Guid RequesterId { get; set; }
    public string Reason { get; set; } = "";
    public VaultAccess Access { get; set; } = VaultAccess.View;
    public int Minutes { get; set; }
    public VaultRequestStatus Status { get; set; }
    public Guid? DecidedBy { get; set; }
    public DateTime? DecidedAt { get; set; }
    public string? DecisionNote { get; set; }
    public DateTime? GrantedUntil { get; set; }
}
