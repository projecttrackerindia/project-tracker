using ProjectManagement.Domain.Common;
namespace ProjectManagement.Domain.Entities;

/// <summary>The workspace's support voice agent: who it is, the languages it speaks, how it checks callers and where calls are archived.</summary>
public class VoiceAgentSettings : TenantEntity, ITenantScoped
{
    public bool Enabled { get; set; }
    public string AgentName { get; set; } = "Asha";
    public string CompanyName { get; set; } = "";
    /// <summary>Comma-separated language codes, first is the default (en, hi, te, ta).</summary>
    public string Languages { get; set; } = "en,hi,te,ta";
    /// <summary>What the agent should know: products, policies, branch hours, common answers.</summary>
    public string? Knowledge { get; set; }
    public bool RequireVerification { get; set; } = true;
    /// <summary>What the caller must confirm before account details are shared (for example: date of birth and last 4 digits of the loan number).</summary>
    public string VerificationRule { get; set; } = "date of birth and the last 4 digits of the loan number";
    public string? TransferNumber { get; set; }
    public Guid? WorkTypeId { get; set; }
    /// <summary>Archive key for recordings and transcripts: {yyyy} {MM} {dd} {HH} {callId} {channel} {language} {ticket}.</summary>
    public string StorageKeyPattern { get; set; } = "{yyyy}/{MM}/{dd}/{callId}";
}

/// <summary>One of the company's own APIs (for example MuleSoft loan details) the agent may read, with a read-only key stored encrypted.</summary>
public class VoiceConnector : TenantEntity, ITenantScoped
{
    public string Name { get; set; } = "";
    /// <summary>For the agent: what it returns and when to use it.</summary>
    public string Description { get; set; } = "";
    public string Method { get; set; } = "GET";
    /// <summary>https address with {placeholders} filled from what the caller said (for example https://api.example.com/loans/{loanNumber}).</summary>
    public string UrlTemplate { get; set; } = "";
    public string? HeaderName { get; set; }
    public string? SecretProtected { get; set; }
    public bool Enabled { get; set; } = true;
}

/// <summary>A conversation with the voice agent (a phone call, or a typed test), its transcript and outcome.</summary>
public class VoiceCall : TenantEntity, ITenantScoped
{
    public string Channel { get; set; } = "test";
    public string Direction { get; set; } = "inbound";
    public string? CallerNumber { get; set; }
    public string Language { get; set; } = "en";
    public string Status { get; set; } = "active";
    public DateTime StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
    public string TranscriptProtected { get; set; } = "";
    public string? Summary { get; set; }
    public Guid? WorkTaskId { get; set; }
    public bool Verified { get; set; }
    public bool Transferred { get; set; }
    public string? ArchiveKey { get; set; }
    public Guid? StartedBy { get; set; }
}
