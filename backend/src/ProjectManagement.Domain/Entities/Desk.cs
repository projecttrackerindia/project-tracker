using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// The Desk's omnichannel settings for one workspace: WhatsApp intake, AI routing, the Sarvam voice layer and the recording policy. Every
/// feature is off until an admin turns it on. Keys are stored encrypted and are never sent back to the browser (only whether one is set).
/// </summary>
public class DeskSettings : TenantEntity, ITenantScoped
{
    /// <summary>WhatsApp messages to the workspace's support numbers go through the Desk pipeline (queue, ticket, routing).</summary>
    public bool IntakeEnabled { get; set; }
    /// <summary>Every new WhatsApp request gets an acknowledgement at once (with the ticket key once there is one).</summary>
    public bool AutoAcknowledge { get; set; } = true;
    /// <summary>A WhatsApp request becomes a ticket by itself; off: people raise it from the chat.</summary>
    public bool AutoCreateTicket { get; set; } = true;
    public string AckMessage { get; set; } = "";
    /// <summary>New tickets are categorised, prioritised and offered to the best available engineer.</summary>
    public bool RoutingEnabled { get; set; }
    /// <summary>Below this confidence (0-100) an AI decision waits for a person instead of being applied.</summary>
    public int ConfidenceThreshold { get; set; } = 70;
    /// <summary>Minutes an engineer has to accept a ticket before it moves on.</summary>
    public int AcceptMinutes { get; set; } = 10;
    /// <summary>How many times a ticket moves to another engineer before the supervisor is asked.</summary>
    public int MaxReassignments { get; set; } = 2;
    public Guid? SupervisorId { get; set; }
    /// <summary>Engineers are also told on WhatsApp (when their number is linked and the workspace's WhatsApp can send).</summary>
    public bool NotifyOnWhatsApp { get; set; }
    public bool VoiceEnabled { get; set; }
    public string? SarvamApiKeyProtected { get; set; }
    /// <summary>Comma-separated language codes the voice agent offers, first is the default.</summary>
    public string VoiceLanguages { get; set; } = "en,hi,te,ta";
    /// <summary>What the voice agent says before anything else; it must say it is automated and ask before recording.</summary>
    public string ConsentPrompt { get; set; } = "";
    /// <summary>Keep the call audio when the caller agrees (never without their yes).</summary>
    public bool RecordCalls { get; set; } = true;
    public int RetentionDays { get; set; } = 90;
    /// <summary>none until a provider (exotel, plivo, twilio) is set up; calls are not placed without one.</summary>
    public string TelephonyProvider { get; set; } = "none";
    public string? TelephonyKeyProtected { get; set; }
}

/// <summary>
/// One inbound provider message waiting for the Desk pipeline. The unique provider message id makes Meta's repeated deliveries harmless; a
/// worker claims rows with a lease, retries failures with back-off and parks them as dead after the last try. No message text or numbers here.
/// </summary>
public class DeskInboundEvent : TenantEntity, ITenantScoped
{
    public string Provider { get; set; } = "whatsapp";
    public string ProviderMessageId { get; set; } = "";
    public Guid ChannelId { get; set; }
    public Guid? ConversationId { get; set; }
    public string MessageType { get; set; } = "text";
    /// <summary>pending, processing, done or dead.</summary>
    public string Status { get; set; } = "pending";
    public int Attempts { get; set; }
    public DateTime NextAttemptAt { get; set; }
    public DateTime? LeaseUntil { get; set; }
    public string? LastError { get; set; }
    public DateTime? ProcessedAt { get; set; }
    public Guid? WorkTaskId { get; set; }
}

/// <summary>A support engineer's availability, skills and capacity, used by the routing engine.</summary>
public class DeskEngineer : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    /// <summary>available, busy, away or offline.</summary>
    public string Status { get; set; } = "offline";
    public DateTime? StatusChangedAt { get; set; }
    /// <summary>Comma-separated skills (for example: login, payments, network).</summary>
    public string Skills { get; set; } = "";
    public string Department { get; set; } = "";
    public int MaxActive { get; set; } = 8;
    /// <summary>Shift in minutes from midnight in the workspace's zone; both empty means any time.</summary>
    public int? ShiftStartMinutes { get; set; }
    public int? ShiftEndMinutes { get; set; }
    /// <summary>On a call right now (no new tickets offered).</summary>
    public bool OnCall { get; set; }
}

/// <summary>Who a ticket was offered to, how, and whether they accepted; one active row per ticket, older rows are its routing history.</summary>
public class DeskAssignment : TenantEntity, ITenantScoped
{
    public Guid WorkTaskId { get; set; }
    public Guid? AssigneeId { get; set; }
    /// <summary>auto, manual, override, escalated or review (waiting for a person to decide).</summary>
    public string Method { get; set; } = "auto";
    public string Reason { get; set; } = "";
    public int Score { get; set; }
    public DateTime AssignedAt { get; set; }
    public DateTime? AcceptDueAt { get; set; }
    public DateTime? AcceptedAt { get; set; }
    public int Reassignments { get; set; }
    public DateTime? EscalatedAt { get; set; }
    public bool Active { get; set; } = true;
    public Guid? AssignedBy { get; set; }
}

/// <summary>What the Desk understood about a ticket: category, priority, a short summary and how sure it is; uncertain ones wait for review.</summary>
public class DeskTicketInsight : TenantEntity, ITenantScoped
{
    public Guid WorkTaskId { get; set; }
    /// <summary>whatsapp, voice or app.</summary>
    public string Channel { get; set; } = "app";
    public string Category { get; set; } = "";
    public string Priority { get; set; } = "Medium";
    public string Department { get; set; } = "";
    public string Skills { get; set; } = "";
    public int Confidence { get; set; }
    public string Summary { get; set; } = "";
    /// <summary>ai (a language model) or rules (keywords and history).</summary>
    public string Source { get; set; } = "rules";
    public bool NeedsReview { get; set; }
    public Guid? ReviewedBy { get; set; }
    public DateTime? ReviewedAt { get; set; }
    /// <summary>The workspace member the requester was matched to (by their linked WhatsApp number), if any.</summary>
    public Guid? ContactUserId { get; set; }
    public string? Organization { get; set; }
}

/// <summary>
/// A voice intake conversation (browser microphone now, phone calls once a telephony provider is connected). The assistant says it is
/// automated and asks before recording; audio is kept only after a yes, until <see cref="RetainUntil"/>. The transcript is stored encrypted.
/// </summary>
public class DeskVoiceSession : TenantEntity, ITenantScoped
{
    public Guid? WorkTaskId { get; set; }
    /// <summary>web (browser microphone) or phone.</summary>
    public string Channel { get; set; } = "web";
    public string Direction { get; set; } = "inbound";
    public string Language { get; set; } = "en";
    /// <summary>consent (waiting for the yes/no), active, completed, declined or failed.</summary>
    public string Status { get; set; } = "consent";
    public bool? ConsentGiven { get; set; }
    public DateTime? ConsentAt { get; set; }
    public string TranscriptProtected { get; set; } = "";
    public string? Summary { get; set; }
    public string? RecordingKey { get; set; }
    public string? RecordingContentType { get; set; }
    public long RecordingBytes { get; set; }
    public DateTime? RetainUntil { get; set; }
    public string Provider { get; set; } = "sarvam";
    public string? ProviderCallId { get; set; }
    public Guid? StartedBy { get; set; }
    public DateTime StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
}
