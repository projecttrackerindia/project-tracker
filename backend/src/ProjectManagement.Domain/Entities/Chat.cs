using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Enums
{
    /// <summary>Direct: two people. Group: a named group with its own members. Project: the team chat of one project (who is in it follows the project).</summary>
    public enum ConversationType { Direct, Group, Project }
    public enum ConversationRole { Member, Admin }
    /// <summary>A person's message, or a line the system adds to the thread ("Priya joined").</summary>
    public enum ChatMessageKind { User, System }
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
    }

    /// <summary>One person's emoji reaction to a message. A person can give each emoji once.</summary>
    public class ChatReaction : TenantEntity, ITenantScoped
    {
        public Guid MessageId { get; set; }
        public Guid ConversationId { get; set; }
        public Guid UserId { get; set; }
        public string Emoji { get; set; } = "";
    }
}
