using ProjectManagement.Domain.Common;
namespace ProjectManagement.Domain.Entities;

// Personal account records, not organization documents. Read access is always owner-only.
public class PersonalResume : AuditableEntity
{
    public Guid UserId { get; set; }
    public string Title { get; set; } = "My resume";
    public int Version { get; set; } = 1;
}
public class ResumeVersion : AuditableEntity
{
    public Guid ResumeId { get; set; }
    public Guid UserId { get; set; }
    public int Number { get; set; }
    public string ContentJson { get; set; } = "{}";
    public string EvidenceJson { get; set; } = "[]";
    public DateTime? ApprovedAt { get; set; }
    public string? OriginalStorageKey { get; set; }
    public string? OriginalFileName { get; set; }
    public string? OriginalContentType { get; set; }
}
public class EmployeeCertification : AuditableEntity
{
    public Guid UserId { get; set; }
    public string Name { get; set; } = "";
    public string Issuer { get; set; } = "";
    public DateOnly IssuedOn { get; set; }
    public DateOnly? ExpiresOn { get; set; }
    public string? CredentialId { get; set; }
    public string? VerificationUrl { get; set; }
    public bool ExpiryReminders { get; set; } = true;
    public DateOnly? ReminderExpiry { get; set; }
    public int? ReminderStage { get; set; }
    public string? AttachmentStorageKey { get; set; }
    public string? AttachmentFileName { get; set; }
    public string? AttachmentContentType { get; set; }
    public bool ShowBadge { get; set; }
    public bool Archived { get; set; }
    // Self supplied until a separate authorized verification process exists.
    public string VerificationStatus { get; set; } = "self-reported";
    public int Version { get; set; } = 1;
}
