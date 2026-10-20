using ProjectManagement.Domain.Common;
namespace ProjectManagement.Domain.Entities;
/// <summary>A personal mailbox reached over IMAP/SMTP (Rediffmail and similar). The password is stored only encrypted and never returned.</summary>
public class MailAccount : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    public string Provider { get; set; } = "rediff";
    public string Email { get; set; } = "";
    public string ImapHost { get; set; } = "";
    public int ImapPort { get; set; } = 993;
    public string SmtpHost { get; set; } = "";
    public int SmtpPort { get; set; } = 465;
    public string SecretProtected { get; set; } = "";
    public DateTime? LastSyncedAt { get; set; }
    public string? LastError { get; set; }
}
