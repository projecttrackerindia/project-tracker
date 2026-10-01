using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// Records that a user accepted a specific version of a platform legal document (see ConsentTypes). When an
/// administrator publishes a newer version, a row for the old version no longer counts as up to date, and the
/// person is asked to accept again before they can keep changing things.
/// </summary>
public class UserConsent : AuditableEntity
{
    public Guid UserId { get; set; }
    public string DocumentType { get; set; } = "";
    public int Version { get; set; }
    public DateTime ConsentedAt { get; set; }
    public string? IpAddress { get; set; }
}
