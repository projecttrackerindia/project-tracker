using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// A workspace's own AI account: an owner or admin adds their organization's Claude (Anthropic) or ChatGPT (OpenAI) API key, and the
/// assistant answers the people who agreed to it on that account - billed by the provider to the organization, not in AI credits.
/// The key is stored encrypted and never leaves the server; people see only its last four characters.
/// </summary>
public class AiWorkspaceProvider : TenantEntity, ITenantScoped
{
    /// <summary>anthropic or openai.</summary>
    public string Provider { get; set; } = "anthropic";
    public string KeyProtected { get; set; } = "";
    /// <summary>The key's last four characters, to recognise it by.</summary>
    public string KeyHint { get; set; } = "";
    /// <summary>The models for quick answers, most questions, and deep analysis, chosen from the ones the key may use.</summary>
    public string QuickModel { get; set; } = "";
    public string StandardModel { get; set; } = "";
    public string DeepModel { get; set; } = "";
    public bool Enabled { get; set; }
    /// <summary>When the key cannot answer (no credit left, revoked, provider down), answer with Project Tracker's own AI instead (charged in credits).</summary>
    public bool FallbackToPlatform { get; set; } = true;
    /// <summary>Goes up whenever the provider or the key changes: people are asked again, since their words would go somewhere new.</summary>
    public int Version { get; set; } = 1;
    public DateTime? LastCheckedAt { get; set; }
    public string? LastError { get; set; }
}

/// <summary>A person's agreement to have their questions answered on the workspace's own AI account (once per provider and key version).</summary>
public class AiProviderConsent : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    public string Provider { get; set; } = "";
    public int Version { get; set; }
    public DateTime AgreedAt { get; set; }
    public DateTime? WithdrawnAt { get; set; }
}
