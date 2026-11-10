using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// A piece of a page, a work item, a chat message, meeting notes or project mail, with its meaning as a vector, for meaning-based search ("what's our refund rule" finds "Returns
/// policy"). The vector is stored compactly (one signed byte per dimension). Who may see a result is never decided here: every hit is checked
/// against the reader's own access before it is shown. Confidential and restricted pages, private (end-to-end encrypted) chats and
/// personal inboxes are not indexed at all. Text that is kept encrypted at its source (minutes, transcripts, project mail) is embedded but its
/// words are not copied here: <see cref="Text"/> stays empty and the excerpt is cut from the live source when it is shown.
/// </summary>
public class AiSearchChunk : TenantEntity, ITenantScoped
{
    /// <summary>"document", "task", "work" (operational), "actionitem", "chat" (one message), "minutes" and "transcript" (a notetaker session) or "mail" (project mailbox).</summary>
    public string SourceKind { get; set; } = "document";
    public Guid SourceId { get; set; }
    public Guid? ProjectId { get; set; }
    /// <summary>Chat messages only: the conversation, so membership can be checked without opening the message first.</summary>
    public Guid? ConversationId { get; set; }
    public int Part { get; set; }
    public string Title { get; set; } = "";
    /// <summary>The text that was embedded (masked for personal data), shown as the excerpt.</summary>
    public string Text { get; set; } = "";
    public byte[] Vector { get; set; } = [];
    public float Scale { get; set; }
    public string Model { get; set; } = "";
    /// <summary>A hash of the source text, so unchanged work is not embedded again.</summary>
    public string ContentHash { get; set; } = "";
    public DateTime IndexedAt { get; set; }
}
