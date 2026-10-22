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

/// <summary>The company's own mail system, set once by an administrator so each person connects their mailbox with just their password.</summary>
public class CompanyMailSettings : TenantEntity, ITenantScoped
{
    /// <summary>A Mailbox preset (rediffpro, rediff, zoho, gmail, ...).</summary>
    public string Provider { get; set; } = "rediffpro";
    /// <summary>The company's mail domains, comma separated (fivestargroup.in).</summary>
    public string Domains { get; set; } = "";
    /// <summary>"imap" or "pop" when an administrator set the servers themselves; null uses the preset's IMAP server.</summary>
    public string? IncomingProtocol { get; set; }
    public string? IncomingHost { get; set; }
    public int? IncomingPort { get; set; }
    public string? SmtpHost { get; set; }
    public int? SmtpPort { get; set; }
}
