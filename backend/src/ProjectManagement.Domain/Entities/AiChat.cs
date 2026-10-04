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
}
