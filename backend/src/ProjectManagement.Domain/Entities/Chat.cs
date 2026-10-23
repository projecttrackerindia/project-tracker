using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Enums
{
    /// <summary>Direct: two people. Group: a named group with its own members. Project: the team chat of one project (who is in it follows the project).</summary>
    public enum ConversationType { Direct, Group, Project }
    public enum ConversationRole { Member, Admin }
    /// <summary>A person's message, a line the system adds to the thread ("Priya joined"), or a Google Meet card (Body is JSON, not text -
    /// see ChatService.PostMeetingCardAsync and frontend Thread.tsx's rendering of it).</summary>
    /// <summary>Poll: Body is the question; its options and votes are a <see cref="Entities.ChatPoll"/>.</summary>
    public enum ChatMessageKind { User, System, Meeting, Poll }
    public enum ChatScheduleStatus { Scheduled, Sent, Cancelled, Failed }
}

namespace ProjectManagement.Domain.Entities
{
    using ProjectManagement.Domain.Enums;

    /// <summary>A private chat between two people, or a named group. Belongs to one workspace, like everything else.</summary>
    public class Conversation : TenantEntity, ITenantScoped
    {
        public ConversationType Type { get; set; }
        /// <summary>Groups only. A direct chat is named after the other person when it is shown.</summary>
        public string? Name { get; set; }
        /// <summary>Direct chats only: the two people's ids in a fixed order, so two people can never end up with two chats.</summary>
        public string? DirectKey { get; set; }
        /// <summary>Project chats only: the project this chat belongs to. Who may read and write it is decided by the project, not by a member list.</summary>
        public Guid? ProjectId { get; set; }

        // The last message is kept on the conversation so the list can be drawn without reading every thread.
        public DateTime LastMessageAt { get; set; }
        public Guid? LastMessageId { get; set; }
        public Guid? LastMessageSenderId { get; set; }
        public string? LastMessageSnippet { get; set; }
    }

    public class ConversationMember : TenantEntity, ITenantScoped
    {
        public Guid ConversationId { get; set; }
        public Guid UserId { get; set; }
        public ConversationRole Role { get; set; }
        /// <summary>Everything up to this moment counts as read for this person.</summary>
        public DateTime LastReadAt { get; set; }
        public bool IsMuted { get; set; }
        public User? User { get; set; }
    }

    public class ChatMessage : TenantEntity, ITenantScoped
    {
        public Guid ConversationId { get; set; }
        /// <summary>Null for system lines.</summary>
        public Guid? SenderId { get; set; }
        public ChatMessageKind Kind { get; set; }
        public string Body { get; set; } = "";
        public Guid? ReplyToId { get; set; }
        public DateTime? EditedAt { get; set; }
        /// <summary>A deleted message stays in the thread as "message deleted"; its text is erased.</summary>
        public DateTime? DeletedAt { get; set; }
        /// <summary>A reply inside a thread: shown under its first message in the side panel, not in the conversation itself.</summary>
        public Guid? ThreadRootId { get; set; }
        /// <summary>On a thread's first message: how many replies it has and when the last one came.</summary>
        public int ThreadReplies { get; set; }
        public DateTime? ThreadLastAt { get; set; }
        /// <summary>Pinned to the top of the conversation, and by whom.</summary>
        public DateTime? PinnedAt { get; set; }
        public Guid? PinnedBy { get; set; }
        /// <summary>What was made from this message (tasks, tickets, reminders, pages): a short JSON list of {kind, id, key, title}.</summary>
        public string? LinkedJson { get; set; }
    }

    /// <summary>Someone @mentioned in a project chat message. Kept so "you were mentioned" can be shown until the chat is read.</summary>
    public class ChatMention : TenantEntity, ITenantScoped
    {
        public Guid MessageId { get; set; }
        public Guid ConversationId { get; set; }
        public Guid UserId { get; set; }
    }

    /// <summary>
    /// A file sent in a conversation. It is uploaded first (MessageId empty) and attached when the message is sent; whoever is in the conversation may open it.
    /// The bytes live in file storage (S3 or local); the type was decided by the server from the extension and checked against the content.
    /// </summary>
    public class ChatAttachment : TenantEntity, ITenantScoped
    {
        public Guid ConversationId { get; set; }
        public Guid? MessageId { get; set; }
        public Guid UploaderId { get; set; }
        public string FileName { get; set; } = "";
        public string ContentType { get; set; } = "";
        public long SizeBytes { get; set; }
        public string StorageKey { get; set; } = "";
        public string Sha256 { get; set; } = "";
        /// <summary>A voice note: what was said (transcribed when it was recorded), the language heard and how long it is.</summary>
        public bool IsVoice { get; set; }
        public string? Transcript { get; set; }
        public string? TranscriptLanguage { get; set; }
        public int? DurationSeconds { get; set; }
    }

    /// <summary>One person's emoji reaction to a message. A person can give each emoji once.</summary>
    public class ChatReaction : TenantEntity, ITenantScoped
    {
        public Guid MessageId { get; set; }
        public Guid ConversationId { get; set; }
        public Guid UserId { get; set; }
        public string Emoji { get; set; } = "";
    }

    /// <summary>A message a person kept for later (only they see it in their saved list).</summary>
    public class ChatSavedMessage : TenantEntity, ITenantScoped
    {
        public Guid UserId { get; set; }
        public Guid MessageId { get; set; }
        public Guid ConversationId { get; set; }
    }

    /// <summary>A message written now and sent later (by the sender, at <see cref="SendAt"/>); they can change or cancel it until then.</summary>
    public class ChatScheduledMessage : TenantEntity, ITenantScoped
    {
        public Guid ConversationId { get; set; }
        public Guid SenderId { get; set; }
        public string Body { get; set; } = "";
        public Guid? ReplyToId { get; set; }
        public Guid? ThreadRootId { get; set; }
        public DateTime SendAt { get; set; }
        public ChatScheduleStatus Status { get; set; }
        public Guid? SentMessageId { get; set; }
        public string? Error { get; set; }
    }

    /// <summary>A quick poll in a conversation. Closing it can record a decision, which is posted (and pinned) in the conversation.</summary>
    public class ChatPoll : TenantEntity, ITenantScoped
    {
        public Guid MessageId { get; set; }
        public Guid ConversationId { get; set; }
        public string Question { get; set; } = "";
        /// <summary>JSON array of the option texts (2 to 10).</summary>
        public string OptionsJson { get; set; } = "[]";
        public bool Multiple { get; set; }
        public DateTime? ClosesAt { get; set; }
        public DateTime? ClosedAt { get; set; }
        public Guid? ClosedBy { get; set; }
        public string? Decision { get; set; }
        public Guid? DecisionMessageId { get; set; }
    }

    public class ChatPollVote : TenantEntity, ITenantScoped
    {
        public Guid PollId { get; set; }
        public Guid UserId { get; set; }
        public int Option { get; set; }
    }

    /// <summary>A person's chat status in a workspace: an emoji and a line ("On leave till Monday"), and do-not-disturb until a moment.</summary>
    public class ChatUserStatus : TenantEntity, ITenantScoped
    {
        public Guid UserId { get; set; }
        public string? Emoji { get; set; }
        public string? Text { get; set; }
        public DateTime? ClearAt { get; set; }
        public DateTime? DndUntil { get; set; }
    }
}
