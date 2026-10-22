using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// A team's own WhatsApp Business number, connected by pasting its Cloud API details. Messages to it reach the team's AI support employee,
/// which answers from the team's knowledge, raises tickets and hands over to people. Token and app secret are stored encrypted.
/// </summary>
public class SupportChannel : TenantEntity, ITenantScoped
{
    public string Kind { get; set; } = "whatsapp";
    public string Name { get; set; } = "";
    public Guid? TeamId { get; set; }
    public string PhoneNumberId { get; set; } = "";
    public string BusinessAccountId { get; set; } = "";
    public string? DisplayPhone { get; set; }
    public string? VerifiedName { get; set; }
    public string AccessTokenProtected { get; set; } = "";
    public string AppSecretProtected { get; set; } = "";
    /// <summary>Random value the team pastes into Meta's webhook settings; Meta sends it back to prove the webhook is theirs.</summary>
    public string VerifyToken { get; set; } = "";
    public bool Enabled { get; set; } = true;
    /// <summary>The AI employee answers new messages by itself; when off, people reply from the inbox.</summary>
    public bool AutoReply { get; set; } = true;
    public string AgentName { get; set; } = "Asha";
    public Guid? WorkTypeId { get; set; }
    /// <summary>Who connected it: tickets the AI raises from this number are reported in their name.</summary>
    public Guid ConnectedBy { get; set; }
    public DateTime? LastInboundAt { get; set; }
    public DateTime? CheckedAt { get; set; }
    public string? LastError { get; set; }
    /// <summary>How soon a new message should get its first answer (AI or person), in minutes: the chat shows late after that.</summary>
    public int FirstReplyMinutes { get; set; } = 15;
    /// <summary>Tell the customer on WhatsApp when their ticket is picked up, put on hold or resolved.</summary>
    public bool TellCustomer { get; set; } = true;
    /// <summary>Ask for a 1-5 rating when a chat or its ticket is closed.</summary>
    public bool AskRating { get; set; } = true;
    /// <summary>
    /// An approved Meta message template used for ticket updates more than 24 hours after the customer last wrote (WhatsApp allows only
    /// templates then). Its body takes two values: the ticket key and what happened. Empty: such updates wait until they write again.
    /// </summary>
    public string? UpdateTemplate { get; set; }
    public string UpdateTemplateLanguage { get; set; } = "en";
    /// <summary>Saved replies the team inserts with "/" (JSON list of title and text).</summary>
    public string? SavedReplies { get; set; }
}

/// <summary>One person's WhatsApp chat with a support number. The number and the messages are stored encrypted.</summary>
public class SupportConversation : TenantEntity, ITenantScoped
{
    public Guid ChannelId { get; set; }
    /// <summary>Keyed hash of the sender's number, to find their chat without storing the number in clear.</summary>
    public string ContactKey { get; set; } = "";
    public string ContactProtected { get; set; } = "";
    public string? ContactName { get; set; }
    public string Language { get; set; } = "en";
    /// <summary>open, waiting (on a person), closed.</summary>
    public string Status { get; set; } = "open";
    /// <summary>ai while the AI employee handles it; human once a person takes over.</summary>
    public string Mode { get; set; } = "ai";
    public DateTime LastMessageAt { get; set; }
    /// <summary>WhatsApp lets a business reply freely only within 24 hours of the person's last message.</summary>
    public DateTime? LastInboundAt { get; set; }
    public bool NeedsReply { get; set; }
    public int ReplyAttempts { get; set; }
    public int Unread { get; set; }
    public Guid? WorkTaskId { get; set; }
    public string MessagesProtected { get; set; } = "";
    /// <summary>The person on the team who owns this chat; empty while it waits in the queue.</summary>
    public Guid? AssigneeId { get; set; }
    /// <summary>Since when the customer has been waiting for an answer (the oldest unanswered message); empty once someone replied.</summary>
    public DateTime? WaitingSince { get; set; }
    /// <summary>A voice note or file arrived that still has to be fetched (voice notes are transcribed before the AI answers).</summary>
    public bool MediaPending { get; set; }
    /// <summary>What the customer was last told about the ticket ("status|assignee"), so each change is told once.</summary>
    public string? TicketState { get; set; }
    public DateTime? RatingAskedAt { get; set; }
    /// <summary>1 (poor) to 5 (great), the customer's answer to the question after closing.</summary>
    public int? Rating { get; set; }
}
