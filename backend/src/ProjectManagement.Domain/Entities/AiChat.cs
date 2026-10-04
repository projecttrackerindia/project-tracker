using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities
{
    /// <summary>
    /// One person's conversation with the AI assistant. Private to that person: the workspace's administrators cannot read it, and the
    /// assistant only ever sees what its owner may already see. Deleting a conversation clears what was said but keeps the usage figures,
    /// so a workspace's monthly credits stay honest.
    /// </summary>
    public class AiConversation : TenantEntity, ITenantScoped, ISoftDelete
    {
        public Guid UserId { get; set; }
        public string Title { get; set; } = "New conversation";
        public DateTime LastMessageAt { get; set; }
        public bool IsPinned { get; set; }
        /// <summary>A rolling summary of the older part of the conversation, so long chats keep their context without re-sending every message.</summary>
        public string? Summary { get; set; }
        /// <summary>Messages created at or before this moment are folded into <see cref="Summary"/>.</summary>
        public DateTime? SummarizedThroughAt { get; set; }

        public bool IsDeleted { get; set; }
        public DateTime? DeletedAt { get; set; }
        public Guid? DeletedBy { get; set; }
    }

    /// <summary>
    /// One turn: a question from the person ("user") or the assistant's answer ("assistant"). An answer records which level and model
    /// produced it, what it cost, which tools it used and what it proposed to do (the person confirms each proposal separately).
    /// </summary>
    public class AiMessage : TenantEntity, ITenantScoped
    {
        public Guid ConversationId { get; set; }
        /// <summary>The person the conversation belongs to (and whose credits an answer is charged to).</summary>
        public Guid UserId { get; set; }
        /// <summary>"user" or "assistant".</summary>
        public string Role { get; set; } = "user";
        public string Content { get; set; } = "";
        /// <summary>The model's own summary of its reasoning, when it showed one.</summary>
        public string? Reasoning { get; set; }
        /// <summary>"quick", "standard" or "deep" on an answer.</summary>
        public string? Tier { get; set; }
        public string? Model { get; set; }
        /// <summary>Why this level was chosen ("A quick lookup", "You chose Deep thinking").</summary>
        public string? RouteReason { get; set; }
        public int InputTokens { get; set; }
        public int OutputTokens { get; set; }
        /// <summary>Input tokens read from the provider's prompt cache (billed at a fraction) and written to it (billed at a premium). InputTokens is only the uncached part.</summary>
        public int CacheReadTokens { get; set; }
        public int CacheWriteTokens { get; set; }
        /// <summary>JSON: short next-step questions the assistant suggested after its answer.</summary>
        public string? FollowUpsJson { get; set; }
        /// <summary>JSON: work item keys the answer mentions that were nowhere in the data it looked at (so the person knows to check them).</summary>
        public string? UnverifiedJson { get; set; }
        /// <summary>The person's verdict on an answer: "up" or "down", with an optional reason ("too_long", "too_short", "wrong", "off_topic").</summary>
        public string? Feedback { get; set; }
        public string? FeedbackReason { get; set; }
        /// <summary>Credits this answer cost. Counts towards the workspace's month.</summary>
        public int Credits { get; set; }
        /// <summary>"complete", "stopped" (the person pressed Stop) or "failed".</summary>
        public string Status { get; set; } = "complete";
        /// <summary>JSON: what the assistant looked at to answer ([{"name","label","count"}]).</summary>
        public string? ToolsJson { get; set; }
        /// <summary>JSON: changes the assistant proposed ([{"id","kind","title","summary","payload","status"}]).</summary>
        public string? ActionsJson { get; set; }
        /// <summary>JSON: files that came with a question ([{"id","name","contentType","sizeBytes"}]).</summary>
        public string? AttachmentsJson { get; set; }
    }

    /// <summary>
    /// A file attached to a question. The bytes live in file storage; for documents the text the assistant reads is kept here too, so a
    /// follow-up question does not re-read the file.
    /// </summary>
    public class AiAttachment : TenantEntity, ITenantScoped
    {
        public Guid UserId { get; set; }
        /// <summary>Set once the file is sent with a question.</summary>
        public Guid? MessageId { get; set; }
        public Guid? ConversationId { get; set; }
        public string FileName { get; set; } = "";
        public string ContentType { get; set; } = "";
        public long SizeBytes { get; set; }
        public string StorageKey { get; set; } = "";
        /// <summary>The text of a document (docx, xlsx, csv, txt ...), cut to a sensible length. Images and PDFs are read from the file itself.</summary>
        public string? ExtractedText { get; set; }
    }

    /// <summary>
    /// What the assistant has learned about how one person likes to work, kept deterministic and visible: their own notes, the answer length
    /// they prefer (from their feedback) and which kinds of suggestions they keep turning down. Private to the person; they can read, edit and
    /// erase it at any time.
    /// </summary>
    public class AiUserProfile : TenantEntity, ITenantScoped
    {
        public Guid UserId { get; set; }
        /// <summary>-2 (very brief) to +2 (very detailed); 0 is the assistant's normal style.</summary>
        public int DetailLevel { get; set; }
        /// <summary>Anything the person asked the assistant to keep in mind ("answer in Hindi", "always include risks").</summary>
        public string? Notes { get; set; }
        /// <summary>JSON: counts per kind of suggestion ({"reminder":{"done":0,"dismissed":3}}) and thumbs given.</summary>
        public string? CountersJson { get; set; }
        public DateTime? LearnedAt { get; set; }
    }
}
