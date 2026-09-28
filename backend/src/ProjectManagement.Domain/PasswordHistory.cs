using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// A password a person used before (its hash only), kept so the password policy can refuse re-using a recent one.
/// Belongs to the account, not to a workspace: the same password works in every workspace the person is in.
/// </summary>
public class PasswordHistory : Entity
{
    public Guid UserId { get; set; }
    public string Hash { get; set; } = "";
    /// <summary>When this password stopped being the current one.</summary>
    public DateTime ReplacedAt { get; set; }
}
